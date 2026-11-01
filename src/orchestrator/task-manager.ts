import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, ne } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../db/client';
import { agentRuns, projects, reviews, tasks } from '../db/schema';
import { emitOfficeEvent } from '../web/event-bus';
import { getUserHomeDir } from '../auth/user-home';
import { getRuntimeSetting } from '../settings/runtime-settings';
import { MAX_TRANSIENT_RETRIES, getTransientRetryBackoffMs } from './retry-policy';

export type WorkerType = 'dev' | 'review' | 'qa' | 'explainer';

export type TaskRecord = typeof tasks.$inferSelect;

const CLAIM_SCAN_LIMIT = 100;
const STALE_LOCK_RECOVERY_COOLDOWN_MS = 30_000;
const ORPHANED_RUN_RECOVERY_COOLDOWN_MS = 30_000;

let lastStaleLockRecoveryAt = 0;
let lastOrphanedRunRecoveryAt = 0;

export interface TaskBlockingInfo {
  blockedByTaskId: string | null;
  blockedByTaskTitle: string | null;
  blockedByTaskStatus: string | null;
  waitingReason: string | null;
}

function parseDependencyTaskIds(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function isTaskApprovalBlocked(task: Pick<TaskRecord, 'taskKind' | 'planningStatus'>): boolean {
  return task.taskKind === 'execution' && !['none', 'ready', 'approved'].includes(task.planningStatus);
}

async function getLeadApprovalBlocker(task: Pick<TaskRecord, 'parentTaskId' | 'taskKind' | 'planningStatus'>): Promise<TaskRecord | null> {
  if (!task.parentTaskId || task.taskKind !== 'execution') {
    return null;
  }

  const [parentTask] = await db.select().from(tasks).where(eq(tasks.id, task.parentTaskId)).limit(1);
  if (!parentTask) {
    return null;
  }

  return ['approved', 'ready'].includes(parentTask.planningStatus) ? null : parentTask;
}

async function getDependencyBlocker(task: Pick<TaskRecord, 'dependencyTaskIds'>): Promise<TaskRecord | null> {
  const dependencyTaskIds = parseDependencyTaskIds(task.dependencyTaskIds).filter((taskId) => !taskId.startsWith('index:'));
  if (dependencyTaskIds.length === 0) {
    return null;
  }

  const [blocker] = await db
    .select()
    .from(tasks)
    .where(and(inArray(tasks.id, dependencyTaskIds), ne(tasks.status, 'done')))
    .orderBy(asc(tasks.updatedAt))
    .limit(1);

  return blocker ?? null;
}

function isGroupedTask(task: Pick<TaskRecord, 'executionMode' | 'groupId' | 'groupOrder'>): boolean {
  return task.executionMode === 'grouped';
}

function getPreferredWorkerId(task: Pick<TaskRecord, 'preferredDevWorkerId' | 'preferredReviewWorkerId' | 'preferredQaWorkerId' | 'preferredExplainerWorkerId'>, workerType: WorkerType): string | null {
  switch (workerType) {
    case 'dev':
      return task.preferredDevWorkerId;
    case 'review':
      return task.preferredReviewWorkerId;
    case 'qa':
      return task.preferredQaWorkerId;
    case 'explainer':
      return task.preferredExplainerWorkerId;
  }
}

function buildGroupedWaitingReason(blocker: Pick<TaskRecord, 'title' | 'groupOrder' | 'status'>): string {
  const sequence = blocker.groupOrder ?? '?';
  return `Waiting for grouped task #${sequence} \"${blocker.title}\" to reach done (current status: ${blocker.status})`;
}

export async function getGroupedTaskBlocker(task: Pick<TaskRecord, 'executionMode' | 'groupId' | 'groupOrder'>): Promise<TaskRecord | null> {
  if (!isGroupedTask(task) || !task.groupId || task.groupOrder === null) {
    return null;
  }

  const [blocker] = await db
    .select()
    .from(tasks)
    .where(and(
      eq(tasks.executionMode, 'grouped'),
      eq(tasks.groupId, task.groupId),
      lt(tasks.groupOrder, task.groupOrder),
      ne(tasks.status, 'done'),
    ))
    .orderBy(desc(tasks.groupOrder), desc(tasks.createdAt))
    .limit(1);

  return blocker ?? null;
}

export async function getTaskBlockingInfo(task: Pick<TaskRecord, 'status' | 'executionMode' | 'groupId' | 'groupOrder' | 'parentTaskId' | 'taskKind' | 'planningStatus' | 'dependencyTaskIds'>): Promise<TaskBlockingInfo> {
  if (task.status !== 'pending') {
    return {
      blockedByTaskId: null,
      blockedByTaskTitle: null,
      blockedByTaskStatus: null,
      waitingReason: null,
    };
  }

  const approvalBlocker = await getLeadApprovalBlocker(task);
  if (approvalBlocker) {
    return {
      blockedByTaskId: approvalBlocker.id,
      blockedByTaskTitle: approvalBlocker.title,
      blockedByTaskStatus: approvalBlocker.status,
      waitingReason: `Waiting for lead approval on intake "${approvalBlocker.title}".`,
    };
  }

  if (isTaskApprovalBlocked(task)) {
    return {
      blockedByTaskId: null,
      blockedByTaskTitle: null,
      blockedByTaskStatus: null,
      waitingReason: 'Waiting for lead planning to finish.',
    };
  }

  const dependencyBlocker = await getDependencyBlocker(task);
  if (dependencyBlocker) {
    return {
      blockedByTaskId: dependencyBlocker.id,
      blockedByTaskTitle: dependencyBlocker.title,
      blockedByTaskStatus: dependencyBlocker.status,
      waitingReason: `Waiting for dependency "${dependencyBlocker.title}" to reach done (current status: ${dependencyBlocker.status})`,
    };
  }

  if (!isGroupedTask(task)) {
    return {
      blockedByTaskId: null,
      blockedByTaskTitle: null,
      blockedByTaskStatus: null,
      waitingReason: null,
    };
  }

  if (!task.groupId || task.groupOrder === null) {
    return {
      blockedByTaskId: null,
      blockedByTaskTitle: null,
      blockedByTaskStatus: null,
      waitingReason: 'Grouped task metadata is incomplete.',
    };
  }

  const blocker = await getGroupedTaskBlocker(task);
  if (!blocker) {
    return {
      blockedByTaskId: null,
      blockedByTaskTitle: null,
      blockedByTaskStatus: null,
      waitingReason: null,
    };
  }

  return {
    blockedByTaskId: blocker.id,
    blockedByTaskTitle: blocker.title,
    blockedByTaskStatus: blocker.status,
    waitingReason: buildGroupedWaitingReason(blocker),
  };
}

export async function getNextRunnableTask() {
  const [explainerTask] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.status, 'explainer'))
    .orderBy(asc(tasks.updatedAt))
    .limit(1);

  if (explainerTask) {
    return explainerTask;
  }

  const [qaTask] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.status, 'qa'))
    .orderBy(asc(tasks.updatedAt))
    .limit(1);

  if (qaTask) {
    return qaTask;
  }

  const [reviewTask] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.status, 'review'))
    .orderBy(asc(tasks.updatedAt))
    .limit(1);

  if (reviewTask) {
    return reviewTask;
  }

  const [devTask] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.status, 'dev'))
    .orderBy(asc(tasks.updatedAt))
    .limit(1);

  if (devTask) {
    return devTask;
  }

  const pendingTasks = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, 'pending'), inArray(tasks.taskKind, ['execution', 'explainer'])))
    .orderBy(asc(tasks.createdAt))
    .limit(100);

  for (const task of pendingTasks) {
    if (task.taskKind === 'execution' && isTaskApprovalBlocked(task)) {
      continue;
    }

    if (task.taskKind === 'execution') {
      const approvalBlocker = await getLeadApprovalBlocker(task);
      if (approvalBlocker) {
        continue;
      }
    }

    const dependencyBlocker = await getDependencyBlocker(task);
    if (dependencyBlocker) {
      continue;
    }

    if (!isGroupedTask(task)) {
      return task;
    }

    const blocker = await getGroupedTaskBlocker(task);
    if (!blocker) {
      return task;
    }
  }

  return null;
}

export async function updateTaskStatus(taskId: string, status: string, errorLog?: string): Promise<void> {
  const now = new Date();

  await db.update(tasks)
    .set({
      status,
      errorLog,
      lockedByWorker: null,
      lockedAt: null,
      forceAdvanceTo: null,
      updatedAt: now,
      completedAt: status === 'done' || status === 'failed' || status === 'deferred' ? now : null,
    })
    .where(eq(tasks.id, taskId));

  const userId = await getTaskUserId(taskId);
  emitOfficeEvent('task:updated', { taskId, status, errorLog }, userId);
}

export async function lockTaskForDev(taskId: string): Promise<boolean> {
  const now = new Date();

  const result = await db.update(tasks)
    .set({ status: 'dev', lockedByWorker: 'legacy-dev', lockedAt: now, forceAdvanceTo: null, updatedAt: now })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, 'pending'), isNull(tasks.lockedByWorker)));

  const locked = (result.changes ?? 0) > 0;
  if (locked) {
    const userId = await getTaskUserId(taskId);
    emitOfficeEvent('task:updated', { taskId, status: 'dev' }, userId);
  }
  return locked;
}

export async function saveTaskPr(taskId: string, branchName: string, prNumber: number | null, prUrl: string | null, statusOverride?: string): Promise<void> {
  const status = statusOverride ?? 'review';
  await db.update(tasks)
    .set({
      branchName,
      prNumber,
      prUrl,
      status,
      lockedByWorker: null,
      lockedAt: null,
      forceAdvanceTo: null,
      updatedAt: new Date(),
      completedAt: status === 'done' ? new Date() : undefined,
    })
    .where(eq(tasks.id, taskId));

  const userId = await getTaskUserId(taskId);
  emitOfficeEvent('task:updated', { taskId, status, ...(prNumber ? { prNumber } : {}), ...(prUrl ? { prUrl } : {}) }, userId);
}

export async function saveReviewResult(taskId: string, verdict: 'approved' | 'changes_requested', attempt: number, approvedStatusOverride?: string): Promise<void> {
  const nextStatus = verdict === 'approved' ? (approvedStatusOverride ?? 'qa') : 'dev';

  await db.update(tasks)
    .set({
      reviewAttempts: attempt,
      status: nextStatus,
      lockedByWorker: null,
      lockedAt: null,
      forceAdvanceTo: null,
      updatedAt: new Date(),
      errorLog: verdict === 'changes_requested' ? 'Review requested changes' : null,
    })
    .where(eq(tasks.id, taskId));

  const userId = await getTaskUserId(taskId);
  emitOfficeEvent('task:updated', { taskId, status: nextStatus, verdict, attempt }, userId);
}

export async function forwardTaskWithoutReviewApproval(
  taskId: string,
  attempt: number,
  nextStatus: string,
  note: string,
): Promise<void> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);

  await db.insert(reviews).values({
    id: nanoid(),
    taskId,
    prNumber: task?.prNumber ?? null,
    attempt,
    verdict: 'approved',
    comments: note,
    createdAt: new Date(),
  });

  await db.update(tasks)
    .set({
      reviewAttempts: attempt,
      status: nextStatus,
      lockedByWorker: null,
      lockedAt: null,
      forceAdvanceTo: null,
      updatedAt: new Date(),
      errorLog: note,
    })
    .where(eq(tasks.id, taskId));

  const userId = await getTaskUserId(taskId);
  emitOfficeEvent('task:updated', { taskId, status: nextStatus, verdict: 'approved', attempt, reviewOverride: true }, userId);
}

export async function setTaskDeferred(taskId: string, reason: string): Promise<void> {
  const now = new Date();

  await db.update(tasks)
    .set({
      status: 'deferred',
      errorLog: reason,
      lockedByWorker: null,
      lockedAt: null,
      forceAdvanceTo: null,
      updatedAt: now,
      completedAt: now,
    })
    .where(eq(tasks.id, taskId));

  const userId = await getTaskUserId(taskId);
  emitOfficeEvent('task:updated', { taskId, status: 'deferred', reason }, userId);
}

export interface TransientDeferResult {
  outcome: 'requeue' | 'failed';

  attempt: number;
  retryAt: Date | null;
}

export async function deferTaskForTransientRetry(taskId: string, reason: string): Promise<TransientDeferResult> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  const spent = task?.transientRetries ?? 0;
  const now = new Date();
  const userId = await getTaskUserId(taskId);

  if (spent >= MAX_TRANSIENT_RETRIES) {
    await db.update(tasks)
      .set({
        status: 'failed',
        errorLog: reason,
        retryAt: null,
        lockedByWorker: null,
        lockedAt: null,
        forceAdvanceTo: null,
        updatedAt: now,
        completedAt: now,
      })
      .where(eq(tasks.id, taskId));

    emitOfficeEvent('task:updated', { taskId, status: 'failed', reason }, userId);
    return { outcome: 'failed', attempt: spent, retryAt: null };
  }

  const retryAt = new Date(now.getTime() + getTransientRetryBackoffMs(spent));

  await db.update(tasks)
    .set({
      status: 'deferred',
      errorLog: reason,
      transientRetries: spent + 1,
      retryAt,
      lockedByWorker: null,
      lockedAt: null,
      forceAdvanceTo: null,
      updatedAt: now,
      completedAt: now,
    })
    .where(eq(tasks.id, taskId));

  emitOfficeEvent(
    'task:updated',
    { taskId, status: 'deferred', reason, retryAt: retryAt.getTime(), transientRetries: spent + 1 },
    userId,
  );
  return { outcome: 'requeue', attempt: spent + 1, retryAt };
}

export async function requeueDueTransientTasks(): Promise<number> {
  const now = new Date();
  const due = await db.select().from(tasks)
    .where(and(
      eq(tasks.status, 'deferred'),
      isNotNull(tasks.retryAt),
      lte(tasks.retryAt, now),
    ));

  if (due.length === 0) {
    return 0;
  }

  let requeued = 0;
  for (const task of due) {

    const result = await db.update(tasks)
      .set({
        status: 'pending',
        errorLog: null,
        retryAt: null,
        lockedByWorker: null,
        lockedAt: null,
        forceAdvanceTo: null,
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, task.id), eq(tasks.status, 'deferred')));

    if ((result.changes ?? 0) === 0) {
      continue;
    }

    requeued += 1;
    const userId = await getTaskUserId(task.id);
    emitOfficeEvent(
      'task:updated',
      { taskId: task.id, status: 'pending', autoRequeued: true, transientRetries: task.transientRetries },
      userId,
    );
  }

  return requeued;
}

export async function resetTaskForRetry(taskId: string): Promise<boolean> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) {
    return false;
  }

  if (task.status !== 'failed' && task.status !== 'deferred' && task.status !== 'awaiting_merge') {
    return false;
  }

  await db.update(tasks)
    .set({
      status: 'pending',
      errorLog: null,
      lockedByWorker: null,
      lockedAt: null,
      forceAdvanceTo: null,
      completedAt: null,

      transientRetries: 0,
      retryAt: null,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId));

  return true;
}

export async function cancelTask(taskId: string): Promise<boolean> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) {
    return false;
  }

  if (['done', 'failed', 'deferred', 'awaiting_merge'].includes(task.status)) {
    return false;
  }

  await setTaskDeferred(taskId, 'Cancelled by user command');
  return true;
}

export async function getUnfinishedTaskCount(): Promise<number> {
  const unfinished = await db
    .select()
    .from(tasks)
    .where(and(
      isNull(tasks.completedAt),
    ));

  return unfinished.length;
}

export async function getTaskProjectContext(taskId: string): Promise<{ projectName: string; branchName: string } | null> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task || !task.branchName) {
    return null;
  }

  const [project] = await db.select().from(projects).where(eq(projects.id, task.projectId)).limit(1);
  if (!project) {
    return null;
  }

  return {
    projectName: project.name,
    branchName: task.branchName,
  };
}

function getClaimStatuses(workerType: WorkerType): string[] {
  switch (workerType) {
    case 'dev':
      return ['dev', 'pending'];
    case 'review':
      return ['review'];
    case 'qa':
      return ['qa'];
    case 'explainer':
      return ['explainer', 'pending'];
  }
}

function getActiveStatusesForAgentRun(agentType: WorkerType): string[] {
  switch (agentType) {
    case 'dev':
      return ['dev'];
    case 'review':
      return ['review'];
    case 'qa':
      return ['qa'];
    case 'explainer':
      return ['explainer'];
  }
}

function getClaimedStatus(workerType: WorkerType, currentStatus: string): string {
  if (workerType === 'dev' && currentStatus === 'pending') {
    return 'dev';
  }

  if (workerType === 'explainer' && currentStatus === 'pending') {
    return 'explainer';
  }

  return currentStatus;
}

async function maybeRecoverStaleTaskLocks(): Promise<void> {
  const now = Date.now();
  if (now - lastStaleLockRecoveryAt < STALE_LOCK_RECOVERY_COOLDOWN_MS) {
    return;
  }

  lastStaleLockRecoveryAt = now;
  await recoverStaleTaskLocks();
}

async function maybeRecoverOrphanedRunningAgentRuns(): Promise<void> {
  const now = Date.now();
  if (now - lastOrphanedRunRecoveryAt < ORPHANED_RUN_RECOVERY_COOLDOWN_MS) {
    return;
  }

  lastOrphanedRunRecoveryAt = now;
  await recoverOrphanedRunningAgentRuns();
}

async function getClaimCandidates(workerType: WorkerType, targetUserId: string | null): Promise<TaskRecord[]> {
  const statuses = getClaimStatuses(workerType);
  const claimed: TaskRecord[] = [];

  for (const status of statuses) {
    let queryArgs = and(
      eq(tasks.status, status),
      eq(tasks.taskKind, workerType === 'explainer' ? 'explainer' : 'execution'),
      isNull(tasks.lockedByWorker)
    );

    const candidatesRows = await db
      .select({ task: tasks })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(
        targetUserId === null
          ? queryArgs
          : and(queryArgs, eq(projects.userId, targetUserId))
      )
      .orderBy(status === 'pending' ? asc(tasks.createdAt) : asc(tasks.updatedAt))
      .limit(CLAIM_SCAN_LIMIT);

    claimed.push(...candidatesRows.map((r) => r.task));
  }

  return claimed;
}

async function tryClaimTask(task: TaskRecord, workerType: WorkerType, workerId: string): Promise<TaskRecord | null> {
  const now = new Date();
  const nextStatus = getClaimedStatus(workerType, task.status);

  const result = await db.update(tasks)
    .set({
      status: nextStatus,
      lockedByWorker: workerId,
      lockedAt: now,

      forceAdvanceTo: null,
      updatedAt: now,
    })
    .where(and(
      eq(tasks.id, task.id),
      eq(tasks.status, task.status),
      isNull(tasks.lockedByWorker),
    ));

  if ((result.changes ?? 0) === 0) {
    return null;
  }

  const [claimedTask] = await db.select().from(tasks).where(eq(tasks.id, task.id)).limit(1);
  if (!claimedTask) {
    return null;
  }

  if (task.status !== nextStatus) {
    const userId = await getTaskUserId(task.id);
    emitOfficeEvent('task:updated', { taskId: task.id, status: nextStatus }, userId);
  }

  return claimedTask;
}

export async function claimNextTaskForWorker(workerType: WorkerType, workerId: string, targetUserId: string | null): Promise<TaskRecord | null> {
  await maybeRecoverOrphanedRunningAgentRuns();
  await maybeRecoverStaleTaskLocks();

  const candidates = await getClaimCandidates(workerType, targetUserId);
  for (const candidate of candidates) {
    const preferredWorkerId = getPreferredWorkerId(candidate, workerType);
    if (preferredWorkerId && preferredWorkerId !== workerId) {
      continue;
    }

    if ((workerType === 'dev' || workerType === 'explainer') && candidate.status === 'pending') {
      if (workerType === 'explainer' && candidate.taskKind !== 'explainer') {
        continue;
      }

      if (isTaskApprovalBlocked(candidate)) {
        continue;
      }

      if (candidate.taskKind === 'execution') {
        const approvalBlocker = await getLeadApprovalBlocker(candidate);
        if (approvalBlocker) {
          continue;
        }
      }

      const dependencyBlocker = await getDependencyBlocker(candidate);
      if (dependencyBlocker) {
        continue;
      }

      const blocker = await getGroupedTaskBlocker(candidate);
      if (blocker) {
        continue;
      }
    }

    const claimedTask = await tryClaimTask(candidate, workerType, workerId);
    if (claimedTask) {
      return claimedTask;
    }
  }

  return null;
}

export async function releaseTaskLock(taskId: string, workerId: string): Promise<void> {
  await db.update(tasks)
    .set({
      lockedByWorker: null,
      lockedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.lockedByWorker, workerId)));
}

export async function refreshTaskLock(taskId: string, workerId: string): Promise<void> {
  await db.update(tasks)
    .set({
      lockedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.lockedByWorker, workerId)));
}

export async function recoverStaleTaskLocks(staleMs = Math.max(getRuntimeSetting('opencodeTimeoutMs') * 2, 120_000)): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs);
  const staleTasks = await db
    .select()
    .from(tasks)
    .where(and(
      isNotNull(tasks.lockedByWorker),
      isNotNull(tasks.lockedAt),
      lt(tasks.lockedAt, cutoff),
      inArray(tasks.status, ['dev', 'review', 'qa', 'explainer']),
    ));

  let recovered = 0;
  for (const task of staleTasks) {
    await db.update(tasks)
      .set({
        lockedByWorker: null,
        lockedAt: null,
        errorLog: `Recovered stale worker lock from ${task.lockedByWorker}`,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id));
    recovered += 1;
  }

  return recovered;
}

export async function recoverOrphanedRunningAgentRuns(): Promise<number> {
  const runningRuns = await db
    .select({
      id: agentRuns.id,
      taskId: agentRuns.taskId,
      agentType: agentRuns.agentType,
      workerId: agentRuns.workerId,
      startedAt: agentRuns.startedAt,
    })
    .from(agentRuns)
    .where(and(
      eq(agentRuns.status, 'running'),
      inArray(agentRuns.agentType, ['dev', 'review', 'qa', 'explainer']),
    ));

  if (runningRuns.length === 0) {
    return 0;
  }

  const taskIds = [...new Set(runningRuns.map((run) => run.taskId))];
  const relatedTasks = await db
    .select({
      id: tasks.id,
      status: tasks.status,
      lockedByWorker: tasks.lockedByWorker,
    })
    .from(tasks)
    .where(inArray(tasks.id, taskIds));

  const taskById = new Map(relatedTasks.map((task) => [task.id, task]));
  const groupedRuns = new Map<string, typeof runningRuns>();

  for (const run of runningRuns) {
    const key = `${run.taskId}:${run.agentType}`;
    const existing = groupedRuns.get(key);
    if (existing) {
      existing.push(run);
    } else {
      groupedRuns.set(key, [run]);
    }
  }

  let recovered = 0;
  const finishedAt = new Date();

  for (const group of groupedRuns.values()) {
    group.sort((left, right) => {
      const startedAtDelta = right.startedAt.getTime() - left.startedAt.getTime();
      if (startedAtDelta !== 0) {
        return startedAtDelta;
      }

      return right.id.localeCompare(left.id);
    });

    for (const [index, run] of group.entries()) {
      const task = taskById.get(run.taskId);
      const expectedStatuses = getActiveStatusesForAgentRun(run.agentType as WorkerType);
      const hasExpectedTaskState = Boolean(
        task
        && expectedStatuses.includes(task.status)
        && (!run.workerId || task.lockedByWorker === run.workerId),
      );
      const isDuplicate = index > 0;

      if (!isDuplicate && hasExpectedTaskState) {
        continue;
      }

      const reason = isDuplicate
        ? `Recovered duplicate running ${run.agentType} run for task ${run.taskId}`
        : `Recovered orphaned ${run.agentType} run for task ${run.taskId}`;

      await db.update(agentRuns)
        .set({
          status: 'failure',
          output: reason,
          finishedAt,
          durationMs: Math.max(0, finishedAt.getTime() - run.startedAt.getTime()),
        })
        .where(eq(agentRuns.id, run.id));

      recovered += 1;
    }
  }

  return recovered;
}

export async function recoverInterruptedPipelineState(): Promise<{ runsRecovered: number; tasksRecovered: number }> {
  const now = new Date();

  const runsResult = await db
    .update(agentRuns)
    .set({
      status: 'failure',
      output: 'Recovered after process restart while run was still marked running',
      finishedAt: now,
    })
    .where(eq(agentRuns.status, 'running'));

  const inProgressTasks = await db
    .select()
    .from(tasks)
    .where(and(isNull(tasks.completedAt)));

  let recoveredTasks = 0;
  for (const task of inProgressTasks) {
    if (task.status === 'draft' || task.status === 'awaiting_merge' || task.taskKind === 'intake') {
      continue;
    }

    const nextStatus = task.status === 'dev' || task.status === 'review' || task.status === 'qa' || task.status === 'explainer'
      ? task.status
      : 'pending';

    const shouldReset = task.status !== nextStatus || task.lockedByWorker !== null || task.lockedAt !== null;
    if (!shouldReset) {
      continue;
    }

    await db.update(tasks)
      .set({
        status: nextStatus,
        errorLog: `Recovered after restart from status=${task.status}`,
        lockedByWorker: null,
        lockedAt: null,
        updatedAt: now,
      })
      .where(eq(tasks.id, task.id));

    recoveredTasks += 1;
  }

  return {
    runsRecovered: runsResult.changes ?? 0,
    tasksRecovered: recoveredTasks,
  };
}

export async function getTaskUserId(taskId: string): Promise<string | null> {
  const [task] = await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) {
    return null;
  }

  const [project] = await db.select({ userId: projects.userId }).from(projects).where(eq(projects.id, task.projectId)).limit(1);
  return project?.userId ?? null;
}

export async function getUserHomeDirForTask(taskId: string): Promise<string | null> {
  const userId = await getTaskUserId(taskId);
  if (!userId) {
    return null;
  }

  return getUserHomeDir(userId);
}
