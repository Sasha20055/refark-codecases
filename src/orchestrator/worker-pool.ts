import { logger } from '../utils/logger';
import { emitOfficeEvent } from '../web/event-bus';
import { runTaskPipeline } from './pipeline';
import { claimNextTaskForWorker, refreshTaskLock, releaseTaskLock, requeueDueTransientTasks, setTaskDeferred, getTaskUserId, type TaskRecord, type WorkerType } from './task-manager';
import { isFreeTierUser } from '../billing/free-tier-status';
import { ensureFreeTierKey, checkFreeTierBudget, reconcileUsage, freeTierDenialMessage } from '../billing/free-tier';

const WORKER_IDLE_WAIT_MS = 5_000;
const RECONCILE_INTERVAL_MS = 5_000;
const TRANSIENT_REQUEUE_SCAN_INTERVAL_MS = 15_000;
const WORKER_LOCK_HEARTBEAT_MS = 30_000;
export const MAX_WORKER_POOL_SIZE = 2;

export type WorkerState = 'idle' | 'busy' | 'stopping';

export interface WorkerInstance {
  id: string;
  type: WorkerType;
  state: WorkerState;
  currentTaskId: string | null;
  currentTaskTitle: string | null;
  startedAt: number;
}

export interface WorkerInfo {
  id: string;
  type: WorkerType;
  state: WorkerState;
  currentTaskId: string | null;
  currentTaskTitle: string | null;
  uptimeMs: number;
}

export interface WorkerPoolStatus {
  pools: Record<WorkerType, { targetSize: number; workers: WorkerInfo[] }>;
}

export interface ScopedWorkerPoolStatus {
  scopeId: string;
  pools: Record<WorkerType, { targetSize: number; workers: WorkerInfo[] }>;
}

interface WorkerPool {
  targetSize: number;
  workers: Map<string, WorkerInstance>;
}

function buildWorkerProcessKey(scopeId: string, workerId: string): string {
  return `${scopeId}:${workerId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampPoolSize(size: number): number {
  if (!Number.isFinite(size)) {
    return 1;
  }

  return Math.max(0, Math.min(MAX_WORKER_POOL_SIZE, Math.trunc(size)));
}

export class WorkerPoolManager {
  private readonly userPools = new Map<string, Map<WorkerType, WorkerPool>>();
  private readonly workerPromises = new Map<string, Promise<void>>();
  private reconcileTimer: NodeJS.Timeout | null = null;
  private transientRequeueTimer: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.reconcile();
    this.reconcileTimer = setInterval(() => {
      this.reconcile();
    }, RECONCILE_INTERVAL_MS);

    this.transientRequeueTimer = setInterval(() => {
      void this.sweepTransientRequeues();
    }, TRANSIENT_REQUEUE_SCAN_INTERVAL_MS);

    logger.info({ status: this.getStatus() }, 'Worker pool manager started');
  }

  private async sweepTransientRequeues(): Promise<void> {
    if (!this.running) {
      return;
    }

    try {
      const requeued = await requeueDueTransientTasks();
      if (requeued > 0) {
        logger.info({ requeued }, 'Auto-requeued transiently-deferred tasks');
        this.reconcile();
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to sweep transiently-deferred tasks');
    }
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;

    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    if (this.transientRequeueTimer) {
      clearInterval(this.transientRequeueTimer);
      this.transientRequeueTimer = null;
    }

    for (const pools of this.userPools.values()) {
      for (const pool of pools.values()) {
        for (const worker of pool.workers.values()) {
          worker.state = 'stopping';
        }
      }
    }

    await Promise.all(this.workerPromises.values());
    logger.info('Worker pool manager stopped');
  }

  private getScopePools(scopeId: string): Map<WorkerType, WorkerPool> {
    let pools = this.userPools.get(scopeId);
    if (!pools) {
      pools = new Map<WorkerType, WorkerPool>([
        ['dev', { targetSize: 0, workers: new Map() }],
        ['review', { targetSize: 0, workers: new Map() }],
        ['qa', { targetSize: 0, workers: new Map() }],
        ['explainer', { targetSize: 0, workers: new Map() }],
      ]);
      this.userPools.set(scopeId, pools);
    }
    return pools;
  }

  setPoolSize(type: WorkerType, size: number, scopeId: string = 'global'): void {
    const pools = this.getScopePools(scopeId);
    const pool = pools.get(type);
    if (!pool) {
      return;
    }

    const nextSize = clampPoolSize(size);
    if (pool.targetSize === nextSize) {
      return;
    }

    pool.targetSize = nextSize;
    emitOfficeEvent('worker:pool-resized', { type, size: nextSize, scopeId });
    this.reconcile();
  }

  getStatus(scopeId: string = 'global'): WorkerPoolStatus {
    const now = Date.now();

    return {
      pools: {
        dev: this.serializePool('dev', now, scopeId),
        review: this.serializePool('review', now, scopeId),
        qa: this.serializePool('qa', now, scopeId),
        explainer: this.serializePool('explainer', now, scopeId),
      },
    };
  }

  private serializePool(type: WorkerType, now: number, scopeId: string): { targetSize: number; workers: WorkerInfo[] } {
    const pools = this.getScopePools(scopeId);
    const pool = pools.get(type);
    if (!pool) {
      return { targetSize: 0, workers: [] };
    }

    return {
      targetSize: pool.targetSize,
      workers: [...pool.workers.values()].map((worker) => ({
        id: worker.id,
        type: worker.type,
        state: worker.state,
        currentTaskId: worker.currentTaskId,
        currentTaskTitle: worker.currentTaskTitle,
        uptimeMs: now - worker.startedAt,
      })).sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true })),
    };
  }

  private getExpectedWorkerIds(type: WorkerType, targetSize: number, scopeId: string): string[] {
    return Array.from({ length: targetSize }, (_, index) => `${type}-${index + 1}`);
  }

  private reconcile(): void {
    if (!this.running) {
      return;
    }

    for (const [scopeId, pools] of this.userPools.entries()) {
      for (const type of pools.keys()) {
        const pool = pools.get(type);
        if (!pool) {
          continue;
        }

        const expectedIds = new Set(this.getExpectedWorkerIds(type, pool.targetSize, scopeId));

        for (const workerId of expectedIds) {
          if (!pool.workers.has(workerId)) {
            this.spawnWorker(type, workerId, scopeId);
          }
        }

        const extraWorkers = [...pool.workers.values()].filter((worker) => !expectedIds.has(worker.id));
        if (extraWorkers.length === 0) {
          continue;
        }

        const workersToStop = extraWorkers
          .sort((left, right) => {
            if (left.state === right.state) {
              return right.startedAt - left.startedAt;
            }

            if (left.state === 'idle') {
              return -1;
            }

            if (right.state === 'idle') {
              return 1;
            }

            if (left.state === 'stopping') {
              return -1;
            }

            if (right.state === 'stopping') {
              return 1;
            }

            return 0;
          });

        for (const worker of workersToStop) {
          worker.state = 'stopping';
        }
      }
    }
  }

  private spawnWorker(type: WorkerType, workerId: string, scopeId: string): void {
    const pools = this.getScopePools(scopeId);
    const pool = pools.get(type);
    if (!pool) {
      return;
    }

    const worker: WorkerInstance = {
      id: workerId,
      type,
      state: 'idle',
      currentTaskId: null,
      currentTaskTitle: null,
      startedAt: Date.now(),
    };

    pool.workers.set(worker.id, worker);
    emitOfficeEvent('worker:added', { workerId: worker.id, type });

    const processKey = buildWorkerProcessKey(scopeId, worker.id);

    const promise = this.runWorker(worker, scopeId)
      .catch((error) => {
        logger.error(
          {
            err: error,
            errorMessage: error instanceof Error ? error.message : String(error),
            workerId: worker.id,
            type,
          },
          'Worker crashed',
        );
      })
      .finally(() => {
        pool.workers.delete(worker.id);
        this.workerPromises.delete(processKey);
        emitOfficeEvent('worker:removed', { workerId: worker.id, type });
      });

    this.workerPromises.set(processKey, promise);
  }

  private async runWorker(worker: WorkerInstance, scopeId: string): Promise<void> {
    while (this.running && worker.state !== 'stopping') {
      const task = await claimNextTaskForWorker(worker.type, worker.id, scopeId === 'global' ? null : scopeId);
      if (!task) {
        await sleep(WORKER_IDLE_WAIT_MS);
        continue;
      }

      await this.runClaimedTask(worker, task);
    }
  }

  private async runClaimedTask(worker: WorkerInstance, task: TaskRecord): Promise<void> {

    const userId = await getTaskUserId(task.id);
    const freeTier = isFreeTierUser(userId);
    if (freeTier && userId) {
      try {
        await ensureFreeTierKey(userId);
      } catch (error) {
        await setTaskDeferred(task.id, `Free beta setup failed: ${(error as Error).message}`);
        await releaseTaskLock(task.id, worker.id);
        return;
      }
      const budget = checkFreeTierBudget(userId);
      if (!budget.allowed) {
        await setTaskDeferred(task.id, freeTierDenialMessage(budget.reason));
        await releaseTaskLock(task.id, worker.id);
        return;
      }
    }

    worker.state = 'busy';
    worker.currentTaskId = task.id;
    worker.currentTaskTitle = task.title;
    const heartbeat = setInterval(() => {
      void refreshTaskLock(task.id, worker.id).catch((error) => {
        logger.warn({ error, taskId: task.id, workerId: worker.id }, 'Failed to refresh task lock heartbeat');
      });
    }, WORKER_LOCK_HEARTBEAT_MS);
    emitOfficeEvent('worker:busy', {
      workerId: worker.id,
      type: worker.type,
    });

    try {
      await runTaskPipeline(task, { workerId: worker.id });
    } finally {
      clearInterval(heartbeat);
      if (freeTier && userId) {

        try {
          await reconcileUsage(userId, `${task.id}:${Date.now()}`);
        } catch (error) {
          logger.warn({ error, taskId: task.id }, 'Free-tier usage reconcile failed');
        }
      }
      await releaseTaskLock(task.id, worker.id);
      worker.currentTaskId = null;
      worker.currentTaskTitle = null;
      const shouldRemainStopping = (worker as WorkerInstance).state === 'stopping';
      worker.state = shouldRemainStopping ? 'stopping' : 'idle';
      emitOfficeEvent('worker:idle', {
        workerId: worker.id,
        type: worker.type,
      });
    }
  }
}