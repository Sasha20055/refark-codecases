import { eq } from 'drizzle-orm';
import { runDevAgent } from '../agents/dev-agent';
import { runExplainerAgent } from '../agents/explainer-agent';
import { runQaDeployAgent } from '../agents/qa-deploy-agent';
import { runReviewAgent } from '../agents/review-agent';
import { tasks } from '../db/schema';
import { sendLocalProjectArchive, sendTaskNotification } from '../telegram/notifications';
import { classifyOperationalError } from '../utils/errors';
import { logger } from '../utils/logger';
import { incrementMetric } from '../utils/metrics';
import { emitOfficeEvent } from '../web/event-bus';
import { getMaxReviewAttempts, shouldDeferTask } from './retry-policy';
import { upsertProviderConnection } from '../auth/session';
import { getGitHubOAuthConfig } from '../auth/github-oauth';
import { SUPPORTED_PROVIDERS } from '../auth/provider-connect';
import { hasAuthJson } from '../auth/user-home';
import {
  deferTaskForTransientRetry,
  forwardTaskWithoutReviewApproval,
  getTaskUserId,
  getUserHomeDirForTask,
  lockTaskForDev,
  saveReviewResult,
  saveTaskPr,
  setTaskDeferred,
  updateTaskStatus,
} from './task-manager';
import { db } from '../db/client';
import { projects } from '../db/schema';
import { createPullRequest, isNoCommitsBetweenBranchesError } from '../github/pulls';

const AUTH_ERROR_PATTERNS = [
  'unauthorized',
  'authentication failed',
  'authentication required',
  'invalid token',
  'token expired',
  'access denied',
  '401',
  'not authenticated',
  'auth error',
  'please log in',
  'please authenticate',
];

function isAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return AUTH_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

async function markProvidersExpiredIfAuthError(taskId: string, errorMessage: string): Promise<void> {
  if (!isAuthError(errorMessage)) {
    return;
  }

  const userId = await getTaskUserId(taskId);
  if (!userId) {
    return;
  }

  try {
    for (const provider of SUPPORTED_PROVIDERS) {
      await upsertProviderConnection(userId, provider, 'expired');
    }
    logger.warn({ taskId, userId }, 'Marked providers as expired due to auth error');
  } catch (err) {
    logger.error({ err, taskId, userId }, 'Failed to mark providers as expired');
  }
}

function assertProviderConnected(homeDir: string | undefined): void {
  if (!homeDir) {
    if (getGitHubOAuthConfig()) {
      throw new Error('Task is not linked to an authenticated user. Recreate the project while logged in and reconnect providers.');
    }
    return;
  }

  const segments = homeDir.replace(/\/+$/, '').split('/');
  const userId = segments[segments.length - 1];
  if (!userId || !hasAuthJson(userId)) {
    throw new Error('No AI provider connected. Please connect Anthropic, GitHub Copilot, OpenAI, Google, OpenCode Zen, or OpenRouter in Settings → AI Providers.');
  }
}

async function cleanupTaskResources(_taskId: string): Promise<void> {

}

function getPostDevStatus(deployStrategy: string): string {
  switch (deployStrategy) {
    case 'direct_push': return 'done';
    case 'pr_auto_merge': return 'qa';
    default: return 'review';
  }
}

function isExplainerTask(task: typeof tasks.$inferSelect): boolean {
  return task.taskKind === 'explainer';
}

export interface PipelineStepOptions {
  workerId?: string | null;
  claimPendingTask?: boolean;
}

function getForceAdvanceTarget(status: string, deployStrategy: string): string | null {
  if (status === 'dev') {
    const next = getPostDevStatus(deployStrategy);
    return next === 'done' ? null : next;
  }
  if (status === 'review') {
    return deployStrategy === 'pr_manual_merge' ? 'awaiting_merge' : 'qa';
  }
  return null;
}

async function completeForceAdvance(task: typeof tasks.$inferSelect): Promise<void> {
  const target = task.forceAdvanceTo;
  if (!target) {
    return;
  }

  const [project] = await db.select().from(projects).where(eq(projects.id, task.projectId)).limit(1);
  const userId = project?.userId ?? null;

  if (task.status === 'review') {
    const note = 'Отправлено дальше вручную: ревью пропущено пользователем.';
    await forwardTaskWithoutReviewApproval(task.id, task.reviewAttempts, target, note);
    if (target === 'awaiting_merge') {
      await sendTaskNotification(task.id, 'awaiting_merge', note);
    }
    logger.warn({ taskId: task.id, target }, 'Task force-advanced from review without verdict');
    return;
  }

  const branchName = task.branchName ?? `feature/task-${task.id}`;
  let prNumber = task.prNumber;
  let prUrl = task.prUrl;

  if (project && !project.isLocal && !prNumber) {
    try {
      const pr = await createPullRequest({
        owner: project.repoOwner,
        repo: project.repoName,
        baseBranch: project.defaultBranch,
        headBranch: branchName,
        title: `Task ${task.id}: ${task.title}`,
        body: `Отправлено на ревью вручную (work-in-progress кодера).`,
        userId,
      });
      prNumber = pr.number;
      prUrl = pr.url;
      logger.info({ taskId: task.id, prNumber }, 'Opened PR for force-advanced task');
    } catch (error) {
      if (isNoCommitsBetweenBranchesError(error)) {

        await db.update(tasks)
          .set({
            forceAdvanceTo: null,
            errorLog: 'Не удалось отправить дальше: кодер ещё ничего не закоммитил. Подождите чекпоинт или повторите.',
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, task.id));
        emitOfficeEvent('task:updated', { taskId: task.id, status: task.status }, userId);
        logger.warn({ taskId: task.id }, 'Force-advance aborted: nothing committed on the branch yet');
        return;
      }
      throw error;
    }
  }

  await saveTaskPr(task.id, branchName, prNumber, prUrl, target);
  await sendTaskNotification(
    task.id,
    prUrl ? 'pr_created' : 'review_ready',
    target === 'qa' ? 'Отправлено на QA вручную' : 'Отправлено на ревью вручную',
  );
  logger.info({ taskId: task.id, target, prNumber: prNumber ?? undefined }, 'Task force-advanced from dev');
}

export async function forceAdvanceTask(taskId: string): Promise<{ ok: boolean; status?: string; reason?: string }> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) {
    return { ok: false, reason: 'not_found' };
  }

  const [project] = await db.select().from(projects).where(eq(projects.id, task.projectId)).limit(1);
  const target = getForceAdvanceTarget(task.status, project?.deployStrategy ?? 'pr_review_merge');
  if (!target) {
    return { ok: false, reason: 'not_advanceable' };
  }

  if (task.lockedByWorker) {
    await db.update(tasks)
      .set({ forceAdvanceTo: target, updatedAt: new Date() })
      .where(eq(tasks.id, taskId));
    emitOfficeEvent('task:updated', { taskId, forceAdvanceTo: target }, project?.userId ?? null);
    logger.info({ taskId, target }, 'Force-advance requested for a running task; awaiting agent hand-off');
    return { ok: true, status: 'advancing' };
  }

  await completeForceAdvance({ ...task, forceAdvanceTo: target });
  return { ok: true, status: target };
}

export async function handlePipelineTaskFailure(taskId: string, error: unknown): Promise<void> {

  const [currentTask] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (currentTask?.forceAdvanceTo) {
    await completeForceAdvance(currentTask);
    await cleanupTaskResources(taskId);
    logger.info({ taskId, target: currentTask.forceAdvanceTo }, 'Task force-advanced after stopping the running agent');
    return;
  }

  const classified = classifyOperationalError(error);

  await markProvidersExpiredIfAuthError(taskId, classified.message);

  if (classified.status === 'deferred' && classified.retryable) {

    const result = await deferTaskForTransientRetry(taskId, classified.message);

    if (result.outcome === 'requeue') {
      const retryInSec = result.retryAt ? Math.round((result.retryAt.getTime() - Date.now()) / 1000) : 0;
      await sendTaskNotification(
        taskId,
        'deferred',
        `${classified.message} Авто-повтор #${result.attempt} примерно через ${retryInSec}s.`,
      );
      incrementMetric('tasksDeferred');
      logger.warn({ taskId, kind: classified.kind, attempt: result.attempt, retryAt: result.retryAt }, 'Task transiently deferred; scheduled for automatic requeue');
    } else {
      await sendTaskNotification(taskId, 'failed', `${classified.message} Исчерпан лимит авто-повторов.`);
      incrementMetric('tasksFailed');
      logger.error({ taskId, kind: classified.kind }, 'Task failed after exhausting transient auto-retry budget');
    }
  } else if (classified.status === 'deferred') {
    await setTaskDeferred(taskId, classified.message);
    await sendTaskNotification(taskId, 'deferred', classified.message);
    incrementMetric('tasksDeferred');
  } else {
    await updateTaskStatus(taskId, 'failed', classified.message);
    await sendTaskNotification(taskId, 'failed', classified.message);
    incrementMetric('tasksFailed');
  }

  await cleanupTaskResources(taskId);
  logger.error({ taskId, error: classified.message, kind: classified.kind }, 'Pipeline failed for task');
}

export async function runDevStep(taskId: string, options: PipelineStepOptions = {}): Promise<void> {
  const locked = options.claimPendingTask ? await lockTaskForDev(taskId) : true;
  if (!locked) {
    return;
  }

  const homeDir = await getUserHomeDirForTask(taskId) ?? undefined;
  assertProviderConnected(homeDir);
  const userId = await getTaskUserId(taskId);

  emitOfficeEvent('run:started', { taskId, agentType: 'dev', workerId: options.workerId ?? null }, userId);
  const result = await runDevAgent(taskId, homeDir, options.workerId ?? undefined);
  emitOfficeEvent('run:finished', { taskId, agentType: 'dev', workerId: options.workerId ?? null }, userId);

  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  const [project] = task
    ? await db.select().from(projects).where(eq(projects.id, task.projectId)).limit(1)
    : [null];

  const postDevStatus = getPostDevStatus(project?.deployStrategy ?? 'pr_review_merge');
  await saveTaskPr(taskId, result.branchName, result.prNumber, result.prUrl, postDevStatus);

  if (postDevStatus === 'done') {
    await sendTaskNotification(taskId, 'done', 'Изменения запушены напрямую в целевую ветку');
    await sendLocalProjectArchive(taskId);
    incrementMetric('tasksProcessed');
  } else {
    await sendTaskNotification(
      taskId,
      result.prUrl ? 'pr_created' : 'review_ready',
      project?.isLocal
        ? 'Локальные изменения подготовлены и отправлены на ревью'
        : postDevStatus === 'qa'
          ? 'PR создан, ревью пропущен, отправлен на QA'
          : 'PR создан и отправлен на ревью',
    );
  }

  logger.info({ taskId, prNumber: result.prNumber ?? undefined, postDevStatus }, 'Task moved after dev step');
}

export async function runReviewStep(taskId: string, options: PipelineStepOptions = {}): Promise<void> {
  const homeDir = await getUserHomeDirForTask(taskId) ?? undefined;
  assertProviderConnected(homeDir);
  const userId = await getTaskUserId(taskId);

  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  const [project] = task
    ? await db.select().from(projects).where(eq(projects.id, task.projectId)).limit(1)
    : [null];
  const deployStrategy = project?.deployStrategy ?? 'pr_review_merge';

  emitOfficeEvent('run:started', { taskId, agentType: 'review', workerId: options.workerId ?? null }, userId);
  const result = await runReviewAgent(taskId, homeDir, options.workerId ?? undefined);
  emitOfficeEvent('run:finished', { taskId, agentType: 'review', workerId: options.workerId ?? null }, userId);

  if (result.verdict === 'approved') {
    const approvedStatus = deployStrategy === 'pr_manual_merge' ? 'awaiting_merge' : 'qa';
    await saveReviewResult(taskId, 'approved', result.attempt, approvedStatus);

    if (approvedStatus === 'awaiting_merge') {
      await sendTaskNotification(taskId, 'awaiting_merge', 'PR одобрен ревьювером, ожидает ручного merge');
      logger.info({ taskId, attempt: result.attempt }, 'Task approved, awaiting manual merge');
    } else {
      logger.info({ taskId, attempt: result.attempt }, 'Task approved and moved to QA');
    }
    return;
  }

  if (shouldDeferTask(result.attempt)) {

    const overrideStatus = deployStrategy === 'pr_manual_merge' ? 'awaiting_merge' : 'qa';
    const note = `Ревью не пройдено ${result.attempt} из ${getMaxReviewAttempts()} — задача отправлена дальше без одобрения ревьювера, чтобы не останавливать пайплайн.`;
    await forwardTaskWithoutReviewApproval(taskId, result.attempt, overrideStatus, note);

    if (overrideStatus === 'awaiting_merge') {
      await sendTaskNotification(taskId, 'awaiting_merge', note);
    }
    logger.warn({ taskId, attempt: result.attempt, overrideStatus }, 'Review not approved after max attempts; forwarding without approval to keep pipeline moving');
    return;
  }

  await saveReviewResult(taskId, 'changes_requested', result.attempt);
  logger.info({ taskId, attempt: result.attempt }, 'Task moved from review back to dev');
}

export async function runQaStep(taskId: string, options: PipelineStepOptions = {}): Promise<void> {
  const userId = await getTaskUserId(taskId);
  emitOfficeEvent('run:started', { taskId, agentType: 'qa', workerId: options.workerId ?? null }, userId);
  const result = await runQaDeployAgent(taskId, options.workerId ?? undefined);
  emitOfficeEvent('run:finished', { taskId, agentType: 'qa', workerId: options.workerId ?? null }, userId);

  if (result.outcome === 'pending') {
    return;
  }

  if (result.outcome === 'failed') {
    await updateTaskStatus(taskId, 'failed', result.details);
    await sendTaskNotification(taskId, 'failed', result.details);
    incrementMetric('tasksFailed');
    await cleanupTaskResources(taskId);
    return;
  }

  await updateTaskStatus(taskId, 'done', result.details);
  await sendTaskNotification(taskId, 'done', result.details);
  await sendLocalProjectArchive(taskId);
  incrementMetric('tasksProcessed');
  await cleanupTaskResources(taskId);
}

export async function runExplainerStep(taskId: string, options: PipelineStepOptions = {}): Promise<void> {
  const homeDir = await getUserHomeDirForTask(taskId) ?? undefined;
  assertProviderConnected(homeDir);
  const userId = await getTaskUserId(taskId);

  emitOfficeEvent('run:started', { taskId, agentType: 'explainer', workerId: options.workerId ?? null }, userId);
  const result = await runExplainerAgent(taskId, homeDir, options.workerId ?? undefined);
  emitOfficeEvent('run:finished', { taskId, agentType: 'explainer', workerId: options.workerId ?? null }, userId);

  await db.update(tasks)
    .set({ explainerResult: result.explanation })
    .where(eq(tasks.id, taskId));

  await updateTaskStatus(taskId, 'done');
  await sendTaskNotification(taskId, 'done', 'Explainer finished successfully');
  incrementMetric('tasksProcessed');
  await cleanupTaskResources(taskId);
}

export async function runTaskPipeline(task: typeof tasks.$inferSelect, options: PipelineStepOptions = {}): Promise<void> {
  try {
    if (task.status === 'pending') {
      if (isExplainerTask(task)) {
        await runExplainerStep(task.id, { workerId: options.workerId ?? null });
      } else {
        await runDevStep(task.id, { workerId: options.workerId ?? null, claimPendingTask: true });
      }
      return;
    }

    if (task.status === 'explainer') {
      await runExplainerStep(task.id, { workerId: options.workerId ?? null });
      return;
    }

    if (task.status === 'dev') {
      await runDevStep(task.id, { workerId: options.workerId ?? null });
      return;
    }

    if (task.status === 'review') {
      await runReviewStep(task.id, { workerId: options.workerId ?? null });
      return;
    }

    if (task.status === 'qa') {
      await runQaStep(task.id, { workerId: options.workerId ?? null });
    }
  } catch (error) {
    await handlePipelineTaskFailure(task.id, error);
  }
}
