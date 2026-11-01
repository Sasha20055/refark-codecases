import { nanoid } from 'nanoid';
import { promises as fs } from 'fs';
import { join } from 'path';
import { runCommand, type ProcessResult } from '../utils/process';
import { logger } from '../utils/logger';
import { config } from '../config';

export interface DockerAgentInput {
    repoUrl: string;
    branch: string;
    baseBranch: string;
    localWorkspaceDir?: string;
    githubToken?: string;
    prompt: string;
    model: string;
    mode: 'dev' | 'review' | 'lead' | 'explainer';
    homeDir?: string;
    systemPrompt?: string;
    commitMessage?: string;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
    onStdoutChunk?: (chunk: string) => void;
    onStderrChunk?: (chunk: string) => void;
}

export interface DockerAgentResult {
    success: boolean;
    output: string;
    exitCode: number;
    hasChanges: boolean;
    modelUsed: string;
}

interface ParsedContainerResult {
    hasChanges: boolean;
    hasTerminalMarker: boolean;
    hasGitFailure: boolean;
}

interface DeadlineInfo {
    deadlineAt: number;
    remainingMs: number;
}

interface LocalWorkspaceRuntime {
    containerHomeDir: string;
    homeMountDir: string | null;
    authJsonMountPath: string | null;
    dockerArgs: string[];
    runtimeEnv: Record<string, string>;
}

const AGENT_IMAGE = process.env.AGENT_DOCKER_IMAGE || 'ai-office-agent:latest';
const DOCKER_NETWORK = process.env.AGENT_DOCKER_NETWORK || 'agent-net';
const DOCKER_MEMORY_LIMIT = process.env.AGENT_DOCKER_MEMORY || '8g';
const DOCKER_CPU_LIMIT = process.env.AGENT_DOCKER_CPUS || '4';
const DEFAULT_DOCKER_AGENT_TIMEOUT_MS = config.OPENCODE_TIMEOUT_MS;
const PREMATURE_CLOSE_MAX_ATTEMPTS = 3;
const PREMATURE_CLOSE_RETRY_DELAY_MS = 2_000;
const DIAGNOSTIC_OUTPUT_TAIL_LENGTH = 2_000;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDeadline(timeoutMs: number): DeadlineInfo {
    return {
        deadlineAt: Date.now() + timeoutMs,
        remainingMs: timeoutMs,
    };
}

function getRemainingDeadline(deadlineAt: number): DeadlineInfo {
    return {
        deadlineAt,
        remainingMs: Math.max(0, deadlineAt - Date.now()),
    };
}

async function delayWithDeadline(ms: number, deadlineAt: number, signal?: AbortSignal): Promise<void> {
    const remaining = getRemainingDeadline(deadlineAt).remainingMs;
    if (remaining <= 0) {
        throw new Error('Docker agent timed out before retry could start');
    }

    const actualDelay = Math.min(ms, remaining);
    if (signal?.aborted) {
        throw new Error(String(signal.reason ?? 'Docker agent aborted'));
    }

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, actualDelay);

        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            reject(new Error(String(signal?.reason ?? 'Docker agent aborted')));
        };

        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function normalizeOutput(text: string): string {
    return text
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
        .toLowerCase();
}

function isPrematureCloseFailure(output: string, message?: string): boolean {
    const normalized = normalizeOutput(`${output}\n${message ?? ''}`);

    return normalized.includes('err_stream_premature_close')
        || normalized.includes('premature close')
        || normalized.includes('glob failed');
}

function buildRunnerRetryNotice(attempt: number): string {
    return `\n::runner_retry::Premature close detected, retrying container run (${attempt}/${PREMATURE_CLOSE_MAX_ATTEMPTS})\n`;
}

function tailOutput(text: string, maxLength = DIAGNOSTIC_OUTPUT_TAIL_LENGTH): string {
    if (!text) {
        return '';
    }

    return text.length > maxLength ? text.slice(-maxLength) : text;
}

function summarizeProcessResult(result: ProcessResult): Record<string, unknown> {
    return {
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
        stdoutTail: tailOutput(result.stdout),
        stderrTail: tailOutput(result.stderr),
    };
}

async function inspectContainerState(containerName: string): Promise<string | null> {
    try {
        const result = await runCommand(
            'docker',
            ['inspect', containerName, '--format', '{{json .State}}'],
            { timeoutMs: 5_000 },
        );

        if (result.exitCode !== 0) {
            return null;
        }

        return tailOutput(result.stdout.trim());
    } catch {
        return null;
    }
}

function hasTerminalProgress(output: string): boolean {
    return output.includes('::done::')
        || output.includes('::result::');
}

function formatDockerLaunchError(exitCode: number, output: string): string {
    const normalized = normalizeOutput(output);

    if (normalized.includes('cannot connect to the docker daemon')) {
        return 'Docker daemon is unavailable. Start Docker Desktop or the Docker Engine and retry.';
    }

    if (normalized.includes('bind source path does not exist') || normalized.includes('invalid mount config')) {
        return 'Docker failed to start because a bind-mounted file or directory does not exist.';
    }

    if (normalized.includes('pull access denied') || normalized.includes('unable to find image')) {
        return `Docker image ${AGENT_IMAGE} is unavailable. Build or pull the agent image and retry.`;
    }

    if (exitCode === 137) {
        return 'Agent container ran out of memory and was killed (exit code 137). '
            + 'Task deferred for automatic retry; raise AGENT_DOCKER_MEMORY if it recurs.';
    }

    if (exitCode === 139) {
        return 'Agent container crashed (exit code 139). Task deferred for automatic retry.';
    }

    return `Agent container exited with code ${exitCode}`;
}

export function getDockerAgentErrorMessage(result: Pick<DockerAgentResult, 'exitCode' | 'output'>): string {
    return formatDockerLaunchError(result.exitCode, result.output);
}

export function buildDockerFailureOutput(errorMessage: string | undefined, output: string): string {
    const normalizedError = errorMessage?.trim() ?? '';
    const normalizedOutput = output.trim();

    if (!normalizedOutput) {
        return normalizedError;
    }

    if (!normalizedError || normalizedError === normalizedOutput) {
        return normalizedOutput;
    }

    return `${normalizedError}\n\n--- container output ---\n${normalizedOutput}`;
}

function hasSubstantialProgress(output: string): boolean {
    const normalized = normalizeOutput(output);

    const patchCount = (normalized.match(/apply_patch success/g) || []).length;
    if (patchCount >= 2) {
        return true;
    }

    const completedTodos = (normalized.match(/\[x\]/g) || []).length;
    if (completedTodos >= 2) {
        return true;
    }

    if (normalized.includes('create mode') || normalized.includes('files changed')) {
        return true;
    }

    return false;
}

function isTransientContainerKill(exitCode: number): boolean {
    return exitCode === 137 || exitCode === 139;
}

function hasNonRetryableGitFailure(output: string): boolean {
    const normalized = normalizeOutput(output);

    return normalized.includes('failed to push some refs')
        || normalized.includes('non-fast-forward')
        || normalized.includes('updates were rejected because the tip of your current branch is behind');
}

function shouldRetryPrematureClose(output: string, attempt: number, parsed?: ParsedContainerResult): boolean {
    if (attempt >= PREMATURE_CLOSE_MAX_ATTEMPTS) {
        return false;
    }

    if (!isPrematureCloseFailure(output)) {
        return false;
    }

    if (parsed?.hasTerminalMarker || parsed?.hasGitFailure) {
        return false;
    }

    if (hasSubstantialProgress(output)) {
        return false;
    }

    return !hasTerminalProgress(output) && !hasNonRetryableGitFailure(output);
}

export async function isDockerAvailable(): Promise<boolean> {
    try {
        const result = await runCommand('docker', ['info'], { timeoutMs: 5_000 });
        return result.exitCode === 0;
    } catch {
        return false;
    }
}

async function ensureDockerNetwork(): Promise<void> {
    try {
        await runCommand('docker', ['network', 'inspect', DOCKER_NETWORK], { timeoutMs: 5_000 });
        return;
    } catch {

    }

    try {
        await runCommand('docker', ['network', 'create', '--driver', 'bridge', DOCKER_NETWORK], {
            timeoutMs: 10_000,
        });
        logger.info({ network: DOCKER_NETWORK }, 'Created Docker agent network');
    } catch (err) {

        try {
            await runCommand('docker', ['network', 'inspect', DOCKER_NETWORK], { timeoutMs: 5_000 });
        } catch {

            logger.error({ err, network: DOCKER_NETWORK }, 'Failed to create Docker agent network');
            throw new Error(`Failed to create Docker network "${DOCKER_NETWORK}": ${err instanceof Error ? err.message : err}`);
        }
    }
}

async function mkdirWorldWritable(path: string): Promise<void> {
    await fs.mkdir(path, { recursive: true, mode: 0o777 });
    await fs.chmod(path, 0o777);
}

async function prepareLocalWorkspaceRuntime(tempDir: string, localWorkspaceDir?: string, homeDir?: string): Promise<LocalWorkspaceRuntime> {
    const containerHomeDir = '/home/agent';
    const authJsonMountPath = homeDir
        ? `${containerHomeDir}/.local/share/opencode/auth.json`
        : null;

    if (!localWorkspaceDir) {
        return {
            containerHomeDir,
            homeMountDir: null,
            authJsonMountPath,
            dockerArgs: [],
            runtimeEnv: {},
        };
    }

    const stats = await fs.stat(localWorkspaceDir);
    if (typeof stats.uid !== 'number' || typeof stats.gid !== 'number') {
        return {
            containerHomeDir,
            homeMountDir: null,
            authJsonMountPath,
            dockerArgs: [],
            runtimeEnv: {},
        };
    }

    const runtimeHomeDir = join(tempDir, 'agent-home');
    await mkdirWorldWritable(runtimeHomeDir);
    await mkdirWorldWritable(join(runtimeHomeDir, '.config'));
    await mkdirWorldWritable(join(runtimeHomeDir, '.local'));
    await mkdirWorldWritable(join(runtimeHomeDir, '.local', 'share'));
    await mkdirWorldWritable(join(runtimeHomeDir, '.local', 'share', 'opencode'));
    await mkdirWorldWritable(join(runtimeHomeDir, '.local', 'state'));

    return {
        containerHomeDir: runtimeHomeDir.replace(tempDir, '/tmp/agent-home'),
        homeMountDir: runtimeHomeDir,
        authJsonMountPath: homeDir
            ? '/tmp/agent-home/.local/share/opencode/auth.json'
            : null,
        dockerArgs: ['--user', `${stats.uid}:${stats.gid}`, '-v', `${runtimeHomeDir}:/tmp/agent-home:rw`],
        runtimeEnv: {
            HOME: '/tmp/agent-home',
            XDG_CONFIG_HOME: '/tmp/agent-home/.config',
            XDG_DATA_HOME: '/tmp/agent-home/.local/share',
            XDG_STATE_HOME: '/tmp/agent-home/.local/state',
        },
    };
}

function parseContainerResult(stdout: string): ParsedContainerResult {
    if (
        stdout.includes('::result::changes_pushed')
        || stdout.includes('::result::commits_pushed')
        || stdout.includes('::result::changes_committed')
        || stdout.includes('::result::commits_available')
    ) {
        return {
            hasChanges: true,
            hasTerminalMarker: hasTerminalProgress(stdout),
            hasGitFailure: hasNonRetryableGitFailure(stdout),
        };
    }

    return {
        hasChanges: false,
        hasTerminalMarker: hasTerminalProgress(stdout),
        hasGitFailure: hasNonRetryableGitFailure(stdout),
    };
}

export async function runDockerAgent(input: DockerAgentInput): Promise<DockerAgentResult> {
    const runId = nanoid(8);
    const containerNameBase = `agent-${input.mode}-${runId}`;
    const effectiveRepoUrl = input.localWorkspaceDir ? 'local' : input.repoUrl.trim();

    if (!effectiveRepoUrl) {
        throw new Error('runDockerAgent requires repoUrl for non-local projects');
    }

    await ensureDockerNetwork();

    const tempRoot = join(process.cwd(), 'data', '.docker-agent-tmp');
    await fs.mkdir(tempRoot, { recursive: true });
    const tempDir = await fs.mkdtemp(join(tempRoot, `${runId}-`));
    const usesDirectLocalWorkspaceMount = Boolean(
        input.localWorkspaceDir && input.mode !== 'lead' && input.mode !== 'explainer',
    );
    const localWorkspaceRuntime = usesDirectLocalWorkspaceMount
        ? await prepareLocalWorkspaceRuntime(tempDir, input.localWorkspaceDir, input.homeDir)
        : {
            containerHomeDir: '/home/agent',
            homeMountDir: null,
            authJsonMountPath: input.homeDir
                ? '/home/agent/.local/share/opencode/auth.json'
                : null,
            dockerArgs: [],
            runtimeEnv: {},
        };

    const promptFile = join(tempDir, 'prompt.txt');
    await fs.writeFile(promptFile, input.prompt, 'utf-8');

    const githubToken = input.githubToken?.trim();
    const githubTokenFile = effectiveRepoUrl !== 'local' && githubToken
        ? join(tempDir, 'github-push-token')
        : null;
    if (githubTokenFile) {
        await fs.writeFile(githubTokenFile, `${githubToken}\n`, { encoding: 'utf-8', mode: 0o644 });
    }

    let systemPromptFile: string | undefined;
    if (input.systemPrompt) {
        systemPromptFile = join(tempDir, 'system-prompt.txt');
        await fs.writeFile(systemPromptFile, input.systemPrompt, 'utf-8');
    }

    let authJsonPath: string | null = null;
    if (input.homeDir) {
        const sourceAuthJson = `${input.homeDir}/.local/share/opencode/auth.json`;
        try {
            const authContent = await fs.readFile(sourceAuthJson);
            authJsonPath = join(tempDir, 'opencode-auth.json');
            await fs.writeFile(authJsonPath, authContent, { mode: 0o644 });

            await fs.chmod(authJsonPath, 0o644);
        } catch (err) {
            logger.warn({ err, sourceAuthJson }, 'auth.json not readable; container will run without opencode credentials');
            authJsonPath = null;
        }
    }

    try {
        const runtimeEnv: Record<string, string> = { ...localWorkspaceRuntime.runtimeEnv };
        const effectiveTimeoutMs = input.timeoutMs || DEFAULT_DOCKER_AGENT_TIMEOUT_MS;
        const deadline = createDeadline(effectiveTimeoutMs);
        let lastResult: DockerAgentResult | null = null;
        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= PREMATURE_CLOSE_MAX_ATTEMPTS; attempt += 1) {
            const currentDeadline = getRemainingDeadline(deadline.deadlineAt);
            if (currentDeadline.remainingMs <= 0) {
                throw new Error(`Docker agent exceeded deadline (${effectiveTimeoutMs}ms)`);
            }

            const containerName = `${containerNameBase}-a${attempt}`;
            let combinedStdout = '';
            let combinedStderr = '';
            const dockerArgs: string[] = [
                'run', '--rm',
                '--name', containerName,

                '--memory', DOCKER_MEMORY_LIMIT,
                '--cpus', DOCKER_CPU_LIMIT,
                '--pids-limit', '4096',

                ...(input.localWorkspaceDir
                    ? input.mode === 'lead' || input.mode === 'explainer'
                        ? [
                            '-v', `${input.localWorkspaceDir}:/mnt/source-workspace:ro`,
                            '-e', 'LOCAL_SOURCE_WORKSPACE=/mnt/source-workspace',
                            '-e', 'LOCAL_SOURCE_MODE=copy',
                        ]
                        : ['-v', `${input.localWorkspaceDir}:/home/agent/workspace:rw`]
                    : []),
                ...localWorkspaceRuntime.dockerArgs,
                '--security-opt=no-new-privileges',
                '--cap-drop=ALL',

                '--network', DOCKER_NETWORK,

                ...(authJsonPath && localWorkspaceRuntime.authJsonMountPath
                    ? [
                        '-v', `${authJsonPath}:/run/secrets/opencode_auth.json:ro`,
                        '-e', `OPENCODE_AUTH_DEST=${localWorkspaceRuntime.authJsonMountPath}`,
                    ]
                    : []),

                ...(githubTokenFile
                    ? ['-v', `${githubTokenFile}:/run/secrets/github_push_token:ro`]
                    : []),

                '-v', `${promptFile}:/home/agent/prompt.txt:ro`,
                '-e', 'PROMPT_FILE=/home/agent/prompt.txt',

                ...(systemPromptFile
                    ? ['-v', `${systemPromptFile}:/home/agent/system-prompt.txt:ro`, '-e', 'SYSTEM_PROMPT_FILE=/home/agent/system-prompt.txt']
                    : []),

                '-e', 'GIT_CONFIG_GLOBAL=/tmp/.gitconfig',
                '-e', 'NODE_OPTIONS=--max-old-space-size=4096',

                '-e', `REPO_URL=${effectiveRepoUrl}`,
                '-e', `BRANCH=${input.branch}`,
                '-e', `BASE_BRANCH=${input.baseBranch}`,
                '-e', `MODEL=${input.model}`,
                '-e', `AGENT_MODE=${input.mode}`,
                '-e', `COMMIT_MESSAGE=${input.commitMessage || 'feat: automated changes'}`,

                '-e', `AGENT_CHECKPOINT_INTERVAL_MS=${config.AGENT_CHECKPOINT_INTERVAL_MS}`,
                ...Object.entries(runtimeEnv).flatMap(([name, value]) => ['-e', `${name}=${value}`]),

                AGENT_IMAGE,
            ];

            logger.info(
                {
                    attempt,
                    maxAttempts: PREMATURE_CLOSE_MAX_ATTEMPTS,
                    containerName,
                    timeoutMs: currentDeadline.remainingMs,
                    mode: input.mode,
                    branch: input.branch,
                    model: input.model,
                    repoMode: effectiveRepoUrl,
                },
                'Starting Docker agent container',
            );

            try {
                const result = await runCommand('docker', dockerArgs, {

                    timeoutMs: currentDeadline.remainingMs,

                    idleTimeoutMs: config.OPENCODE_IDLE_TIMEOUT_MS > 0 ? config.OPENCODE_IDLE_TIMEOUT_MS : undefined,
                    abortSignal: input.abortSignal,
                    onStdoutChunk: (chunk) => {
                        combinedStdout += chunk;
                        input.onStdoutChunk?.(chunk);
                    },
                    onStderrChunk: (chunk) => {
                        combinedStderr += chunk;
                        input.onStderrChunk?.(chunk);
                    },
                });

                const output = `${result.stdout}\n${result.stderr}`.trim();
                const parsed = parseContainerResult(output);
                const dockerResult: DockerAgentResult = {
                    success: result.exitCode === 0,
                    output,
                    exitCode: result.exitCode,
                    hasChanges: parsed.hasChanges,
                    modelUsed: input.model,
                };
                lastResult = dockerResult;

                const hasPremature = isPrematureCloseFailure(output);
                const hasProgress = hasSubstantialProgress(output);
                const prematureRetry = shouldRetryPrematureClose(output, attempt, parsed);

                const killRetry = !dockerResult.success
                    && isTransientContainerKill(result.exitCode)
                    && attempt < PREMATURE_CLOSE_MAX_ATTEMPTS
                    && !parsed.hasTerminalMarker
                    && !hasProgress;

                const shouldRetry = prematureRetry || killRetry;

                if (hasPremature && hasProgress) {
                    logger.info(
                        { attempt, containerName, mode: input.mode },
                        'Skipping retry: premature close detected but agent made substantial progress',
                    );
                }

                if (!shouldRetry) {
                    return dockerResult;
                }

                const containerState = await inspectContainerState(containerName);
                const retryNotice = buildRunnerRetryNotice(attempt + 1);
                input.onStdoutChunk?.(retryNotice);
                logger.warn(
                    {
                        attempt,
                        maxAttempts: PREMATURE_CLOSE_MAX_ATTEMPTS,
                        containerName,
                        mode: input.mode,
                        branch: input.branch,
                        exitCode: result.exitCode,
                        retryReason: killRetry ? `container killed (exit ${result.exitCode}, likely OOM)` : 'premature close output',
                        containerState,
                        process: summarizeProcessResult(result),
                    },
                    killRetry
                        ? 'Retrying Docker agent after transient container kill'
                        : 'Retrying Docker agent after premature close output',
                );
                await delayWithDeadline(PREMATURE_CLOSE_RETRY_DELAY_MS, deadline.deadlineAt, input.abortSignal);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const combinedOutput = `${combinedStdout}\n${combinedStderr}`.trim();
                lastError = error instanceof Error ? error : new Error(message);
                const parsed = parseContainerResult(combinedOutput);

                const shouldRetry = shouldRetryPrematureClose(`${combinedOutput}\n${message}`.trim(), attempt, parsed)
                    && !input.abortSignal?.aborted;

                if (!shouldRetry) {
                    throw error;
                }

                const containerState = await inspectContainerState(containerName);
                const retryNotice = buildRunnerRetryNotice(attempt + 1);
                input.onStdoutChunk?.(retryNotice);
                logger.warn(
                    {
                        attempt,
                        maxAttempts: PREMATURE_CLOSE_MAX_ATTEMPTS,
                        containerName,
                        mode: input.mode,
                        branch: input.branch,
                        error: message,
                        containerState,
                        stdoutTail: tailOutput(combinedStdout),
                        stderrTail: tailOutput(combinedStderr),
                    },
                    'Retrying Docker agent after premature close exception',
                );
                await delayWithDeadline(PREMATURE_CLOSE_RETRY_DELAY_MS, deadline.deadlineAt, input.abortSignal);
            } finally {
                await forceRemoveContainer(containerName);
            }
        }

        if (lastResult) {
            return lastResult;
        }

        throw lastError ?? new Error('Docker agent failed without a result');
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {              });
    }
}

export async function forceRemoveContainer(containerName: string): Promise<void> {
    try {
        await runCommand('docker', ['rm', '-f', containerName], { timeoutMs: 10_000 });
    } catch {

    }
}
