import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

interface ProgressEntry {
  progress: number;
  phaseName: string | null;
  agentType: string;
  taskId: string;
  runId: string;
}

type Listener = () => void;

const progressMap = new Map<string, ProgressEntry>();
const listeners = new Set<Listener>();

function notifyListeners() {
  for (const listener of listeners) {
    listener();
  }
}

function handleOfficeEvent(event: Event) {
  const detail = (event as CustomEvent).detail as {
    type: string;
    payload: Record<string, unknown>;
  } | undefined;

  if (!detail) return;

  if (detail.type === 'run:progress') {
    const { taskId, runId, agentType, progress, phaseName, done } = detail.payload;
    if (typeof taskId !== 'string' || typeof progress !== 'number') return;

    progressMap.set(taskId, {
      progress: done ? 100 : progress,
      phaseName: typeof phaseName === 'string' ? phaseName : null,
      agentType: typeof agentType === 'string' ? agentType : 'dev',
      taskId,
      runId: typeof runId === 'string' ? runId : '',
    });
    notifyListeners();
  }

  if (detail.type === 'run:finished') {
    const { taskId } = detail.payload;
    if (typeof taskId !== 'string') return;

    const existing = progressMap.get(taskId);
    if (existing) {
      progressMap.set(taskId, { ...existing, progress: 100, phaseName: 'done' });
      notifyListeners();

      setTimeout(() => {
        progressMap.delete(taskId);
        notifyListeners();
      }, 3000);
    }
  }
}

let isListening = false;

function ensureListening() {
  if (isListening) return;
  isListening = true;
  window.addEventListener('office-event', handleOfficeEvent);
}

function subscribe(listener: Listener): () => void {
  ensureListening();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Map<string, ProgressEntry> {
  return progressMap;
}

export function useAgentProgress() {
  const map = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const getTaskProgress = useCallback(
    (taskId: string): ProgressEntry | null => {
      return map.get(taskId) ?? null;
    },
    [map],
  );

  const getAgentTypeProgress = useCallback(
    (agentType: string): ProgressEntry | null => {
      for (const entry of map.values()) {
        if (entry.agentType === agentType && entry.progress < 100) {
          return entry;
        }
      }
      return null;
    },
    [map],
  );

  return { getTaskProgress, getAgentTypeProgress };
}
