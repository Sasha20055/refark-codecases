import { spawn } from 'child_process';

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    onStdoutChunk?: (chunk: string) => void;
    onStderrChunk?: (chunk: string) => void;
    abortSignal?: AbortSignal;
  } = {},
): Promise<ProcessResult> {
  const {
    cwd,
    timeoutMs = 10 * 60 * 1000,
    idleTimeoutMs,
    env,
    onStdoutChunk,
    onStderrChunk,
    abortSignal,
  } = options;

  return new Promise<ProcessResult>((resolve, reject) => {
    const startedAt = Date.now();

    if (abortSignal?.aborted) {
      const reason = abortSignal.reason instanceof Error
        ? abortSignal.reason.message
        : String(abortSignal.reason ?? `Process aborted before start: ${command} ${args.join(' ')}`);
      reject(new Error(reason));
      return;
    }

    let settled = false;
    const shouldUseProcessGroup = process.platform !== 'win32';
    let idleTimeout: NodeJS.Timeout | null = null;

    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: shouldUseProcessGroup,
    });

    let stdout = '';
    let stderr = '';

    const clearIdleTimeout = () => {
      if (idleTimeout) {
        clearTimeout(idleTimeout);
        idleTimeout = null;
      }
    };

    const armIdleTimeout = () => {
      if (!idleTimeoutMs || idleTimeoutMs <= 0 || settled) {
        return;
      }

      clearIdleTimeout();
      idleTimeout = setTimeout(() => {
        if (settled) {
          return;
        }

        terminateChild('SIGTERM');

        setTimeout(() => {
          if (!settled) {
            terminateChild('SIGKILL');
          }
        }, 5_000);

        settled = true;
        clearTimeout(timeout);
        cleanupAbortListener();
        clearIdleTimeout();
        reject(new Error(`Process idle timeout (${idleTimeoutMs}ms): ${command} ${args.join(' ')}`));
      }, idleTimeoutMs);
    };

    armIdleTimeout();

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      armIdleTimeout();
      onStdoutChunk?.(text);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      armIdleTimeout();
      onStderrChunk?.(text);
    });

    let abortHandler: (() => void) | null = null;

    const terminateChild = (signal: NodeJS.Signals) => {
      if (child.killed) {
        return;
      }

      if (shouldUseProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {

        }
      }

      try {
        child.kill(signal);
      } catch {

      }
    };

    const cleanupAbortListener = () => {
      if (abortSignal && abortHandler) {
        abortSignal.removeEventListener('abort', abortHandler);
      }
    };

    child.on('error', (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      clearIdleTimeout();
      cleanupAbortListener();
      reject(error);
    });

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      terminateChild('SIGTERM');

      setTimeout(() => {
        if (!settled) {
          terminateChild('SIGKILL');
        }
      }, 5_000);

      settled = true;
      clearIdleTimeout();
      cleanupAbortListener();
      reject(new Error(`Process timeout (${timeoutMs}ms): ${command} ${args.join(' ')}`));
    }, timeoutMs);

    abortHandler = () => {
      if (settled) {
        return;
      }

      terminateChild('SIGTERM');

      setTimeout(() => {
        if (!settled) {
          terminateChild('SIGKILL');
        }
      }, 5_000);

      settled = true;
      clearTimeout(timeout);
      clearIdleTimeout();
      cleanupAbortListener();

      const reason = abortSignal?.reason instanceof Error
        ? abortSignal.reason.message
        : String(abortSignal?.reason ?? `Process aborted: ${command} ${args.join(' ')}`);
      reject(new Error(reason));
    };

    if (abortSignal) {
      abortSignal.addEventListener('abort', abortHandler, { once: true });
    }

    child.on('close', (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      clearIdleTimeout();
      cleanupAbortListener();
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        signal: child.signalCode,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
