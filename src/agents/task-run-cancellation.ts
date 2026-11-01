import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { tasks } from '../db/schema';
import { logger } from '../utils/logger';

export interface TaskRunCancellationHandle {
  signal: AbortSignal;
  stop: () => void;
}

interface StartTaskStatusWatcherInput {
  taskId: string;
  agentType: 'dev' | 'review' | 'qa' | 'explainer';
  activeStatuses: string[];
  pollMs?: number;
}

export function startTaskStatusWatcher(input: StartTaskStatusWatcherInput): TaskRunCancellationHandle {
  const { taskId, agentType, activeStatuses, pollMs = 1_500 } = input;
  const controller = new AbortController();
  let stopped = false;
  let checking = false;

  const checkStatus = async () => {
    if (stopped || controller.signal.aborted || checking) {
      return;
    }

    checking = true;

    try {
      const [task] = await db
        .select({ status: tasks.status, forceAdvanceTo: tasks.forceAdvanceTo })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1);

      if (!task) {
        controller.abort(new Error(`Task ${taskId} not found during ${agentType} run. Stopping agent process.`));
        return;
      }

      if (task.forceAdvanceTo) {
        controller.abort(
          new Error(
            `Task ${taskId} force-advanced to ${task.forceAdvanceTo} during ${agentType} run. Stopping agent to hand off.`,
          ),
        );
        return;
      }

      if (!activeStatuses.includes(task.status)) {
        controller.abort(
          new Error(
            `Task ${taskId} status changed to ${task.status} during ${agentType} run. Stopping agent process.`,
          ),
        );
      }
    } catch (error) {
      logger.warn({ taskId, agentType, error }, 'Task status watcher check failed');
    } finally {
      checking = false;
    }
  };

  void checkStatus();
  const timer = setInterval(() => {
    void checkStatus();
  }, pollMs);

  const stop = () => {
    if (stopped) {
      return;
    }

    stopped = true;
    clearInterval(timer);
  };

  return {
    signal: controller.signal,
    stop,
  };
}
