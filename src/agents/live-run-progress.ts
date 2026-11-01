import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { agentRuns } from '../db/schema';
import { emitOfficeEvent } from '../web/event-bus';
import { detectProgress } from './progress-detector';

const MAX_STORED_OUTPUT_LENGTH = 40_000;
const MAX_BROADCAST_OUTPUT_TAIL = 1_500;
const MIN_PERSIST_INTERVAL_MS = 1_200;
const MIN_LENGTH_DELTA = 120;
const IDLE_DRIFT_PER_SEC = 0.3;
const MAX_IDLE_DRIFT_PER_TICK = 2;
const MAX_PROGRESS_BEFORE_DONE = 97;

export function createRunProgressUpdater(params: {
  runId: string;
  taskId: string;
  agentType: 'dev' | 'review' | 'qa' | 'lead' | 'explainer';
  workerId?: string;
  userId?: string | null;
}): (output: string, done: boolean) => Promise<void> {
  let lastPersistedOutput = '';
  let lastPersistedAt = 0;
  let queue: Promise<void> = Promise.resolve();
  let smoothedProgress = 0;
  let lastProgressTimestamp = Date.now();

  const persist = async (output: string, done: boolean): Promise<void> => {
    const normalizedOutput = output.length > MAX_STORED_OUTPUT_LENGTH
      ? output.slice(-MAX_STORED_OUTPUT_LENGTH)
      : output;

    const now = Date.now();
    const outputDelta = Math.abs(normalizedOutput.length - lastPersistedOutput.length);
    const isFrequentUpdate = now - lastPersistedAt < MIN_PERSIST_INTERVAL_MS;

    if (!done && normalizedOutput === lastPersistedOutput) {
      return;
    }

    if (!done && isFrequentUpdate && outputDelta < MIN_LENGTH_DELTA) {
      return;
    }

    lastPersistedOutput = normalizedOutput;
    lastPersistedAt = now;

    let progress = 0;
    let phaseName: string | null = null;

    if (params.agentType === 'dev' || params.agentType === 'review' || params.agentType === 'lead' || params.agentType === 'explainer') {
      const detected = detectProgress(params.agentType, normalizedOutput);
      const rawProgress = done ? 100 : detected.percent;
      phaseName = detected.phaseName;

      const elapsedSec = (now - lastProgressTimestamp) / 1000;
      const idleAdvance = Math.min(elapsedSec * IDLE_DRIFT_PER_SEC, MAX_IDLE_DRIFT_PER_TICK);
      lastProgressTimestamp = now;

      smoothedProgress = Math.max(smoothedProgress, rawProgress, smoothedProgress + idleAdvance);
      smoothedProgress = Math.min(smoothedProgress, done ? 100 : MAX_PROGRESS_BEFORE_DONE);

      progress = Math.round(smoothedProgress);
    } else if (done) {
      progress = 100;
    }

    await db.update(agentRuns)
      .set({ output: normalizedOutput })
      .where(eq(agentRuns.id, params.runId));

    emitOfficeEvent('run:progress', {
      runId: params.runId,
      taskId: params.taskId,
      agentType: params.agentType,
      workerId: params.workerId ?? null,
      outputTail: normalizedOutput.slice(-MAX_BROADCAST_OUTPUT_TAIL),
      progress,
      phaseName,
      done,
    }, params.userId);
  };

  return async (output: string, done: boolean): Promise<void> => {
    queue = queue.then(() => persist(output, done)).catch(() => undefined);
    await queue;
  };
}
