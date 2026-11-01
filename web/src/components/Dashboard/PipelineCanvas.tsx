import { Fragment, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_WORKER_POOL_SIZE } from '../../types';
import type { InspectorSelection, PipelineAgentType, Project, Task, TaskStatus, WorkerInfo, WorkerPoolStatus } from '../../types';
import { useAgentProgress } from '../../hooks/useAgentProgress';
import { AgentProgressBar } from '../UI/AgentProgressBar';

interface PipelineCanvasProps {
  tasks: Task[];
  projects: Project[];
  runningAgentCounts: Record<PipelineAgentType, number>;
  selectedProjectId: string;
  selection: InspectorSelection;
  workerStatus: WorkerPoolStatus;
  onTaskSelect: (taskId: string) => void;
  onProjectSelect: (projectId: string) => void;
  onAgentSelect: (agentType: PipelineAgentType) => void;
  onOpenAgentMonitor: (agentType: PipelineAgentType) => void;
  onSetPoolSize: (type: PipelineAgentType, size: number) => void;
}

type StageKey = 'source' | TaskStatus;

type FocusStage = TaskStatus;

interface StageDefinition {
  x: number;
  y: number;
  label: string;
  tone: string;
  detail: string;
}

interface CanvasViewport {
  width: number;
  height: number;
}

interface CanvasTransform {
  x: number;
  y: number;
  scale: number;
}

type PersistedCanvasTransform = CanvasTransform;

type NodeLayout = Record<StageKey, StageDefinition>;

interface PersistedNodeLayout {
  positions: Partial<Record<StageKey, { x: number; y: number }>>;
  workerPositions?: Record<string, { x: number; y: number }>;
}

type DragTarget =
  | { kind: 'stage'; stage: StageKey }
  | { kind: 'worker'; workerId: string; workerType: PipelineAgentType };

interface NodeDragState {
  target: DragTarget;
  pointerId: number;
  offsetX: number;
  offsetY: number;
  moved: boolean;
}

type WorkerPositionMap = Record<string, { x: number; y: number }>;

interface WorkerCanvasNode {
  key: string;
  type: PipelineAgentType;
  worker: WorkerInfo;
  x: number;
  y: number;
  tone: string;
}

interface WorkerHubNode {
  key: string;
  type: PipelineAgentType;
  x: number;
  y: number;
  tone: string;
  visible: boolean;
}

interface GraphLink {
  id: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  tone: string;
  active: boolean;
}

interface WorkerGraph {
  workerNodes: Record<PipelineAgentType, WorkerCanvasNode[]>;
  hubs: Record<PipelineAgentType, WorkerHubNode>;
  links: GraphLink[];
}

const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1280;
const MIN_SCALE = 0.42;
const MAX_SCALE = 1.45;
const PAN_PADDING = 120;
const MINIMAP_WIDTH = 160;
const MINIMAP_HEIGHT = Math.round((CANVAS_HEIGHT / CANVAS_WIDTH) * MINIMAP_WIDTH);
const PIPELINE_VIEWPORT_STORAGE_KEY = 'ai-office:pipeline-viewport-v2';
const PIPELINE_VIEWPORT_STORAGE_PREFIX = 'ai-office:pipeline-viewport-v2:';
const PIPELINE_NODE_LAYOUT_STORAGE_KEY = 'ai-office:pipeline-layout-v2';
const PIPELINE_NODE_LAYOUT_STORAGE_PREFIX = 'ai-office:pipeline-layout-v2:';

const focusStages: FocusStage[] = ['draft', 'pending', 'dev', 'review', 'qa', 'explainer', 'done', 'failed', 'deferred', 'awaiting_merge'];
const agentStages: PipelineAgentType[] = ['dev', 'review', 'qa', 'explainer'];

const simpleFlowStages: FocusStage[] = ['pending', 'dev', 'review', 'qa', 'done'];
const simpleBranchStages: FocusStage[] = ['draft', 'explainer', 'deferred', 'awaiting_merge', 'failed'];

const stagePositions: Record<StageKey, StageDefinition> = {
  source: { x: 120, y: 500, label: 'Project Source', tone: 'var(--color-nx-accent)', detail: 'Project entry point and combined task stream.' },
  draft: { x: 420, y: 220, label: 'Draft', tone: 'var(--color-status-draft)', detail: 'Tasks are being prepared and are not in execution yet.' },
  pending: { x: 420, y: 500, label: 'Backlog', tone: 'var(--color-status-pending)', detail: 'Ready queue waiting to be picked up by the dev stage.' },
  dev: { x: 760, y: 380, label: 'Dev', tone: 'var(--color-status-dev)', detail: 'Implementation lane handled by the Dev Agent.' },
  review: { x: 1080, y: 380, label: 'Review', tone: 'var(--color-status-review)', detail: 'Code review lane handled by the Review Agent.' },
  qa: { x: 1400, y: 380, label: 'QA', tone: 'var(--color-status-qa)', detail: 'Verification lane handled by the QA Agent.' },
  explainer: { x: 760, y: 800, label: 'Explainer', tone: 'var(--color-nx-warning)', detail: 'Read-only analysis lane handled by the Explainer Agent.' },
  done: { x: 1400, y: 800, label: 'Done', tone: 'var(--color-status-done)', detail: 'Completed tasks with a successful pipeline outcome.' },
  failed: { x: 1720, y: 600, label: 'Failed', tone: 'var(--color-status-failed)', detail: 'Terminal failures that require intervention before retry.' },
  deferred: { x: 1080, y: 800, label: 'Deferred', tone: 'var(--color-status-deferred)', detail: 'Paused or escalated tasks waiting for a later pass.' },
  awaiting_merge: { x: 1080, y: 160, label: 'Awaiting Merge', tone: 'var(--color-status-pending)', detail: 'Approved tasks waiting for manual merge.' },
};

const pipelineLinks: Array<{ id: string; from: StageKey; to: StageKey; tone: string }> = [
  { id: 'source-draft', from: 'source', to: 'draft', tone: 'var(--color-status-draft)' },
  { id: 'source-pending', from: 'source', to: 'pending', tone: 'var(--color-status-pending)' },
  { id: 'draft-pending', from: 'draft', to: 'pending', tone: 'var(--color-status-pending)' },
  { id: 'pending-dev', from: 'pending', to: 'dev', tone: 'var(--color-status-dev)' },
  { id: 'pending-explainer', from: 'pending', to: 'explainer', tone: 'var(--color-nx-warning)' },
  { id: 'dev-review', from: 'dev', to: 'review', tone: 'var(--color-status-review)' },
  { id: 'review-qa', from: 'review', to: 'qa', tone: 'var(--color-status-qa)' },
  { id: 'qa-done', from: 'qa', to: 'done', tone: 'var(--color-status-done)' },
  { id: 'explainer-done', from: 'explainer', to: 'done', tone: 'var(--color-status-done)' },
  { id: 'review-dev', from: 'review', to: 'dev', tone: 'var(--color-status-dev)' },
  { id: 'review-deferred', from: 'review', to: 'deferred', tone: 'var(--color-status-deferred)' },
  { id: 'qa-failed', from: 'qa', to: 'failed', tone: 'var(--color-status-failed)' },
  { id: 'explainer-failed', from: 'explainer', to: 'failed', tone: 'var(--color-status-failed)' },
  { id: 'review-awaiting_merge', from: 'review', to: 'awaiting_merge', tone: 'var(--color-status-pending)' },
];

function getAgentTone(type: PipelineAgentType): string {
  return type === 'dev'
    ? 'var(--color-status-dev)'
    : type === 'review'
      ? 'var(--color-status-review)'
      : type === 'qa'
        ? 'var(--color-status-qa)'
        : 'var(--color-nx-warning)';
}

function clampWorkerPosition(x: number, y: number): { x: number; y: number } {
  return {
    x: clamp(x, 72, CANVAS_WIDTH - 72),
    y: clamp(y, 72, CANVAS_HEIGHT - 72),
  };
}

function layoutWorkerNodes(
  type: PipelineAgentType,
  workers: WorkerInfo[],
  base: StageDefinition,
  workerPositions: WorkerPositionMap,
): WorkerCanvasNode[] {
  const tone = getAgentTone(type);

  return workers.map((worker, index) => {
    let xOffset = 0;
    let yOffset = 0;

    if (workers.length > 1) {
      const columns = 2;
      const row = Math.floor(index / columns);
      const col = index % columns;
      const itemsInRow = row === Math.ceil(workers.length / columns) - 1
        ? workers.length % columns === 0 ? columns : workers.length % columns
        : columns;

      xOffset = (col - (itemsInRow - 1) / 2) * 260;
      yOffset = 180 + row * 160;
    }

    const storedPosition = workerPositions[worker.id];
    const fallbackPosition = clampWorkerPosition(base.x + xOffset, base.y + yOffset);
    const position = storedPosition ? clampWorkerPosition(storedPosition.x, storedPosition.y) : fallbackPosition;

    return {
      key: worker.id,
      type,
      worker,
      x: position.x,
      y: position.y,
      tone,
    };
  });
}

function buildWorkerGraphLinks(
  nodeLayout: NodeLayout,
  workerPositions: WorkerPositionMap,
  workerStatus: WorkerPoolStatus,
  runningAgentCounts: Record<PipelineAgentType, number>,
): WorkerGraph {
  const workerNodes = {
    dev: layoutWorkerNodes('dev', workerStatus.pools.dev.workers, nodeLayout.dev, workerPositions),
    review: layoutWorkerNodes('review', workerStatus.pools.review.workers, nodeLayout.review, workerPositions),
    qa: layoutWorkerNodes('qa', workerStatus.pools.qa.workers, nodeLayout.qa, workerPositions),
    explainer: layoutWorkerNodes('explainer', workerStatus.pools.explainer.workers, nodeLayout.explainer, workerPositions),
  } satisfies Record<PipelineAgentType, WorkerCanvasNode[]>;

  const hubs = {
    dev: {
      key: 'hub-dev',
      type: 'dev',
      x: nodeLayout.dev.x,
      y: nodeLayout.dev.y,
      tone: getAgentTone('dev'),
      visible: workerNodes.dev.length > 1,
    },
    review: {
      key: 'hub-review',
      type: 'review',
      x: nodeLayout.review.x,
      y: nodeLayout.review.y,
      tone: getAgentTone('review'),
      visible: workerNodes.review.length > 1,
    },
    qa: {
      key: 'hub-qa',
      type: 'qa',
      x: nodeLayout.qa.x,
      y: nodeLayout.qa.y,
      tone: getAgentTone('qa'),
      visible: workerNodes.qa.length > 1,
    },
    explainer: {
      key: 'hub-explainer',
      type: 'explainer',
      x: nodeLayout.explainer.x,
      y: nodeLayout.explainer.y,
      tone: getAgentTone('explainer'),
      visible: workerNodes.explainer.length > 1,
    },
  } satisfies Record<PipelineAgentType, WorkerHubNode>;

  const links: GraphLink[] = [
    {
      id: 'source-draft',
      fromX: nodeLayout.source.x,
      fromY: nodeLayout.source.y,
      toX: nodeLayout.draft.x,
      toY: nodeLayout.draft.y,
      tone: 'var(--color-status-draft)',
      active: false,
    },
    {
      id: 'source-pending',
      fromX: nodeLayout.source.x,
      fromY: nodeLayout.source.y,
      toX: nodeLayout.pending.x,
      toY: nodeLayout.pending.y,
      tone: 'var(--color-status-pending)',
      active: false,
    },
    {
      id: 'draft-pending',
      fromX: nodeLayout.draft.x,
      fromY: nodeLayout.draft.y,
      toX: nodeLayout.pending.x,
      toY: nodeLayout.pending.y,
      tone: 'var(--color-status-pending)',
      active: false,
    },
  ];

  const pushLink = (id: string, fromX: number, fromY: number, toX: number, toY: number, tone: string, active: boolean) => {
    links.push({ id, fromX, fromY, toX, toY, tone, active });
  };

  const connectHubToWorkers = (type: PipelineAgentType, active: boolean) => {
    if (!hubs[type].visible) {
      return;
    }

    for (const workerNode of workerNodes[type]) {
      pushLink(`${hubs[type].key}-to-${workerNode.key}`, hubs[type].x, hubs[type].y, workerNode.x, workerNode.y, workerNode.tone, active);
    }
  };

  const connectWorkersToHub = (type: PipelineAgentType, tone: string, active: boolean) => {
    if (!hubs[type].visible) {
      return;
    }

    for (const workerNode of workerNodes[type]) {
      pushLink(`${workerNode.key}-to-${hubs[type].key}`, workerNode.x, workerNode.y, hubs[type].x, hubs[type].y, tone, active);
    }
  };

  const getStageExitPoint = (type: PipelineAgentType): { x: number; y: number } | null => {
    if (hubs[type].visible) {
      return { x: hubs[type].x, y: hubs[type].y };
    }

    const [workerNode] = workerNodes[type];
    return workerNode ? { x: workerNode.x, y: workerNode.y } : null;
  };

  const getStageEntryPoint = (type: PipelineAgentType): { x: number; y: number } | null => {
    if (hubs[type].visible) {
      return { x: hubs[type].x, y: hubs[type].y };
    }

    const [workerNode] = workerNodes[type];
    return workerNode ? { x: workerNode.x, y: workerNode.y } : null;
  };

  if (hubs.dev.visible) {
    pushLink('pending-dev-hub', nodeLayout.pending.x, nodeLayout.pending.y, hubs.dev.x, hubs.dev.y, hubs.dev.tone, runningAgentCounts.dev > 0);
    connectHubToWorkers('dev', runningAgentCounts.dev > 0);
  } else {
    for (const devNode of workerNodes.dev) {
      pushLink(`pending-${devNode.key}`, nodeLayout.pending.x, nodeLayout.pending.y, devNode.x, devNode.y, devNode.tone, runningAgentCounts.dev > 0);
    }
  }

  connectWorkersToHub('dev', 'var(--color-status-review)', runningAgentCounts.review > 0);
  connectHubToWorkers('review', runningAgentCounts.review > 0);

  const devExitPoint = getStageExitPoint('dev');
  const reviewEntryPoint = getStageEntryPoint('review');
  if (devExitPoint && reviewEntryPoint) {
    pushLink('dev-to-review', devExitPoint.x, devExitPoint.y, reviewEntryPoint.x, reviewEntryPoint.y, 'var(--color-status-review)', runningAgentCounts.review > 0);
  }

  connectWorkersToHub('review', 'var(--color-status-qa)', runningAgentCounts.qa > 0);
  connectHubToWorkers('qa', runningAgentCounts.qa > 0);

  const reviewExitPoint = getStageExitPoint('review');
  const qaEntryPoint = getStageEntryPoint('qa');
  if (reviewExitPoint && qaEntryPoint) {
    pushLink('review-to-qa', reviewExitPoint.x, reviewExitPoint.y, qaEntryPoint.x, qaEntryPoint.y, 'var(--color-status-qa)', runningAgentCounts.qa > 0);
  }

  if (reviewExitPoint && devExitPoint) {
    pushLink('review-to-dev-loop', reviewExitPoint.x, reviewExitPoint.y, devExitPoint.x, devExitPoint.y, 'var(--color-status-dev)', runningAgentCounts.review > 0);
  }

  if (reviewExitPoint) {
    pushLink('review-to-deferred', reviewExitPoint.x, reviewExitPoint.y, nodeLayout.deferred.x, nodeLayout.deferred.y, 'var(--color-status-deferred)', false);
    pushLink('review-to-awaiting-merge', reviewExitPoint.x, reviewExitPoint.y, nodeLayout.awaiting_merge.x, nodeLayout.awaiting_merge.y, 'var(--color-status-pending)', false);
  }

  if (hubs.explainer.visible) {
    pushLink('pending-explainer-hub', nodeLayout.pending.x, nodeLayout.pending.y, hubs.explainer.x, hubs.explainer.y, hubs.explainer.tone, runningAgentCounts.explainer > 0);
    connectHubToWorkers('explainer', runningAgentCounts.explainer > 0);
  } else {
    for (const explainerNode of workerNodes.explainer) {
      pushLink(`pending-${explainerNode.key}`, nodeLayout.pending.x, nodeLayout.pending.y, explainerNode.x, explainerNode.y, explainerNode.tone, runningAgentCounts.explainer > 0);
    }
  }

  const qaExitPoint = getStageExitPoint('qa');
  if (qaExitPoint) {
    pushLink('qa-to-done', qaExitPoint.x, qaExitPoint.y, nodeLayout.done.x, nodeLayout.done.y, 'var(--color-status-done)', false);
    pushLink('qa-to-failed', qaExitPoint.x, qaExitPoint.y, nodeLayout.failed.x, nodeLayout.failed.y, 'var(--color-status-failed)', false);
  }

  const explainerExitPoint = getStageExitPoint('explainer');
  if (explainerExitPoint) {
    pushLink('explainer-to-done', explainerExitPoint.x, explainerExitPoint.y, nodeLayout.done.x, nodeLayout.done.y, 'var(--color-status-done)', false);
    pushLink('explainer-to-failed', explainerExitPoint.x, explainerExitPoint.y, nodeLayout.failed.x, nodeLayout.failed.y, 'var(--color-status-failed)', false);
  }

  return { workerNodes, hubs, links };
}

function clamp(value: number, min: number, max: number): number {
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  return Math.min(Math.max(value, lower), upper);
}

function fitCanvas(viewport: CanvasViewport): CanvasTransform {
  const scale = clamp(
    Math.min(
      (viewport.width - PAN_PADDING * 2) / CANVAS_WIDTH,
      (viewport.height - PAN_PADDING * 2) / CANVAS_HEIGHT,
    ),
    MIN_SCALE,
    1,
  );

  return clampTransform({
    scale,
    x: (viewport.width - CANVAS_WIDTH * scale) / 2,
    y: (viewport.height - CANVAS_HEIGHT * scale) / 2,
  }, viewport);
}

function clampTransform(transform: CanvasTransform, viewport: CanvasViewport): CanvasTransform {
  const scaledWidth = CANVAS_WIDTH * transform.scale;
  const scaledHeight = CANVAS_HEIGHT * transform.scale;

  const x = scaledWidth <= viewport.width - PAN_PADDING * 2
    ? (viewport.width - scaledWidth) / 2
    : clamp(transform.x, viewport.width - scaledWidth - PAN_PADDING, PAN_PADDING);

  const y = scaledHeight <= viewport.height - PAN_PADDING * 2
    ? (viewport.height - scaledHeight) / 2
    : clamp(transform.y, viewport.height - scaledHeight - PAN_PADDING, PAN_PADDING);

  return { ...transform, x, y };
}

function isAgentStage(stage: StageKey): stage is PipelineAgentType {
  return agentStages.includes(stage as PipelineAgentType);
}

function getTaskStage(task: Task): FocusStage {
  return task.status;
}

function storageKey(): string {
  return PIPELINE_VIEWPORT_STORAGE_KEY;
}

function layoutStorageKey(): string {
  return PIPELINE_NODE_LAYOUT_STORAGE_KEY;
}

function readLegacyStorageValue(prefix: string, preferredProjectId?: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  if (preferredProjectId) {
    const preferredValue = window.localStorage.getItem(`${prefix}${preferredProjectId}`);
    if (preferredValue) {
      return preferredValue;
    }
  }

  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(prefix)) {
      const value = window.localStorage.getItem(key);
      if (value) {
        return value;
      }
    }
  }

  return null;
}

function readStoredTransform(preferredProjectId?: string): PersistedCanvasTransform | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(storageKey())
      ?? readLegacyStorageValue(PIPELINE_VIEWPORT_STORAGE_PREFIX, preferredProjectId);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<PersistedCanvasTransform>;
    if (
      typeof parsed.x !== 'number'
      || typeof parsed.y !== 'number'
      || typeof parsed.scale !== 'number'
    ) {
      return null;
    }

    return parsed as PersistedCanvasTransform;
  } catch {
    return null;
  }
}

function writeStoredTransform(transform: CanvasTransform) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(storageKey(), JSON.stringify(transform satisfies PersistedCanvasTransform));
  } catch {

  }
}

function clearStoredTransforms() {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const keysToRemove: string[] = [];
    keysToRemove.push(PIPELINE_VIEWPORT_STORAGE_KEY);
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(PIPELINE_VIEWPORT_STORAGE_PREFIX)) {
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      window.localStorage.removeItem(key);
    }
  } catch {

  }
}

function readStoredNodeLayout(preferredProjectId?: string): PersistedNodeLayout | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(layoutStorageKey())
      ?? readLegacyStorageValue(PIPELINE_NODE_LAYOUT_STORAGE_PREFIX, preferredProjectId);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<PersistedNodeLayout>;
    if (typeof parsed.positions !== 'object' || !parsed.positions) {
      return null;
    }

    return parsed as PersistedNodeLayout;
  } catch {
    return null;
  }
}

function writeStoredNodeLayout(
  positions: PersistedNodeLayout['positions'],
  workerPositions: PersistedNodeLayout['workerPositions'],
) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(layoutStorageKey(), JSON.stringify({
      positions,
      workerPositions,
    } satisfies PersistedNodeLayout));
  } catch {

  }
}

function clearStoredNodeLayouts() {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const keysToRemove: string[] = [];
    keysToRemove.push(PIPELINE_NODE_LAYOUT_STORAGE_KEY);
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(PIPELINE_NODE_LAYOUT_STORAGE_PREFIX)) {
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      window.localStorage.removeItem(key);
    }
  } catch {

  }
}

function clampNodePosition(stage: StageKey, x: number, y: number): { x: number; y: number } {
  const horizontalPadding = stage === 'source' ? 110 : 72;
  const verticalPadding = 72;

  return {
    x: clamp(x, horizontalPadding, CANVAS_WIDTH - horizontalPadding),
    y: clamp(y, verticalPadding, CANVAS_HEIGHT - verticalPadding),
  };
}

function mergeNodeLayout(overrides: Partial<Record<StageKey, { x: number; y: number }>> | null): NodeLayout {
  return (Object.keys(stagePositions) as StageKey[]).reduce<NodeLayout>((acc, stage) => {
    const override = overrides?.[stage];
    const base = stagePositions[stage];
    if (!override) {
      acc[stage] = base;
      return acc;
    }

    const clamped = clampNodePosition(stage, override.x, override.y);
    acc[stage] = {
      ...base,
      x: clamped.x,
      y: clamped.y,
    };
    return acc;
  }, {} as NodeLayout);
}

function describeStage(stage: FocusStage, taskCount: number, runningCount: number, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (isAgentStage(stage)) {
    if (runningCount > 0) {
      return t('pipeline.activeRuns', { count: runningCount });
    }

    return taskCount > 0 ? `${taskCount} ${t('common.tasks').toLowerCase()}` : t('pipeline.agentIdle');
  }

  if (stage === 'done' || stage === 'failed' || stage === 'deferred' || stage === 'awaiting_merge') {
    return taskCount > 0 ? `${taskCount} ${t('common.tasks').toLowerCase()}` : t('pipeline.noTasksInLane');
  }

  return taskCount > 0 ? `${taskCount} ${t('common.tasks').toLowerCase()}` : t('pipeline.noTasksInLane');
}

function stageLabel(status: StageKey, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (status === 'source') return t('pipeline.source');
  if (status === 'dev') return 'Dev';
  if (status === 'review') return 'Review';
  if (status === 'qa') return 'QA';
  if (status === 'explainer') return 'Explainer';
  return t(`taskStatus.${status}`);
}

function stageDetail(stage: StageKey, t: (key: string, options?: Record<string, unknown>) => string): string {
  return t(`pipeline.stageDescription.${stage}`);
}

function getWorkerStateLabel(state: WorkerInfo['state'], t: (key: string, options?: Record<string, unknown>) => string): string {
  return t(`workers.${state}`);
}

function getWorkerTooltip(worker: WorkerInfo, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (worker.state === 'busy' && worker.currentTaskTitle) {
    return `${worker.id}: ${t('workers.workingOn')} ${worker.currentTaskTitle}`;
  }

  return `${worker.id}: ${getWorkerStateLabel(worker.state, t)}`;
}

function getWaitingReason(task: Pick<Task, 'blockedByTaskId' | 'blockedByTaskTitle' | 'blockedByTaskStatus' | 'waitingReason'>, t: (key: string, options?: Record<string, unknown>) => string): string | null {
  if (task.blockedByTaskId) {
    return t('taskExecution.waitingForTask', {
      title: task.blockedByTaskTitle ?? task.blockedByTaskId,
      status: task.blockedByTaskStatus ? t(`taskStatus.${task.blockedByTaskStatus}`) : t('taskExecution.blockerUnknown'),
    });
  }

  return task.waitingReason;
}

function getExecutionBadge(task: Pick<Task, 'executionMode'>, t: (key: string, options?: Record<string, unknown>) => string): string {
  return task.executionMode === 'grouped' ? t('taskExecution.grouped') : t('taskExecution.autonomous');
}

export function PipelineCanvas({
  tasks,
  projects,
  runningAgentCounts,
  selectedProjectId,
  selection,
  workerStatus,
  onTaskSelect,
  onProjectSelect,
  onAgentSelect,
  onOpenAgentMonitor,
  onSetPoolSize,
}: PipelineCanvasProps) {
  const { t } = useTranslation();
  const { getAgentTypeProgress } = useAgentProgress();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ pointerId: number; startX: number; startY: number } | null>(null);
  const minimapDragPointerIdRef = useRef<number | null>(null);
  const nodeDragStateRef = useRef<NodeDragState | null>(null);
  const nodeLayoutRef = useRef<NodeLayout>(mergeNodeLayout(null));
  const workerPositionsRef = useRef<WorkerPositionMap>({});
  const selectedProject = selectedProjectId !== 'all'
    ? projects.find((project) => project.id === selectedProjectId) ?? null
    : null;
  const [focusedStage, setFocusedStage] = useState<FocusStage>('pending');
  const [transform, setTransform] = useState<CanvasTransform>(() => ({ scale: 0.8, x: 0, y: 0 }));
  const [viewportSize, setViewportSize] = useState<CanvasViewport>({ width: 0, height: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [nodeLayout, setNodeLayout] = useState<NodeLayout>(() => mergeNodeLayout(null));
  const [workerPositions, setWorkerPositions] = useState<WorkerPositionMap>({});
  const [isHydrated, setIsHydrated] = useState(false);
  const [hydratedProjectId, setHydratedProjectId] = useState<string | null>(null);
  const [draggedNodeKey, setDraggedNodeKey] = useState<string | null>(null);

  const tasksByStage = useMemo(() => {
    return tasks.reduce<Record<FocusStage, Task[]>>((acc, task) => {
      const stage = getTaskStage(task);
      acc[stage].push(task);
      return acc;
    }, {
      draft: [],
      pending: [],
      dev: [],
      review: [],
      qa: [],
      explainer: [],
      done: [],
      failed: [],
      deferred: [],
      awaiting_merge: [],
    });
  }, [tasks]);

  const workerGraph = useMemo(
    () => buildWorkerGraphLinks(nodeLayout, workerPositions, workerStatus, runningAgentCounts),
    [nodeLayout, workerPositions, workerStatus, runningAgentCounts],
  );

  const focusedTasks = tasksByStage[focusedStage];
  const blockedPendingCount = tasksByStage.pending.filter((task) => Boolean(task.blockedByTaskId || task.waitingReason)).length;
  const minimapViewport = useMemo(() => {
    if (viewportSize.width === 0 || viewportSize.height === 0) {
      return null;
    }

    const visibleWorldX = clamp(-transform.x / transform.scale, 0, CANVAS_WIDTH);
    const visibleWorldY = clamp(-transform.y / transform.scale, 0, CANVAS_HEIGHT);
    const visibleWorldWidth = Math.min(CANVAS_WIDTH, viewportSize.width / transform.scale);
    const visibleWorldHeight = Math.min(CANVAS_HEIGHT, viewportSize.height / transform.scale);

    return {
      x: (visibleWorldX / CANVAS_WIDTH) * MINIMAP_WIDTH,
      y: (visibleWorldY / CANVAS_HEIGHT) * MINIMAP_HEIGHT,
      width: Math.max(24, (visibleWorldWidth / CANVAS_WIDTH) * MINIMAP_WIDTH),
      height: Math.max(20, (visibleWorldHeight / CANVAS_HEIGHT) * MINIMAP_HEIGHT),
    };
  }, [transform, viewportSize.height, viewportSize.width]);

  useEffect(() => {
    nodeLayoutRef.current = nodeLayout;
  }, [nodeLayout]);

  useEffect(() => {
    workerPositionsRef.current = workerPositions;
  }, [workerPositions]);

  useEffect(() => {
    if (selection.type === 'task') {
      const selectedTask = tasks.find((task) => task.id === selection.taskId);
      if (selectedTask) {
        setFocusedStage(selectedTask.status);
      }
      return;
    }

    if (selection.type === 'agent') {
      setFocusedStage(selection.agentType);
    }
  }, [selection, tasks]);

  useEffect(() => {
    const firstStageWithTasks = focusStages.find((stage) => tasksByStage[stage].length > 0);
    if (firstStageWithTasks && tasksByStage[focusedStage].length === 0) {
      setFocusedStage(firstStageWithTasks);
    }
  }, [focusedStage, tasksByStage]);

  useEffect(() => {
    const centerCanvas = (options?: { clearSavedState?: boolean; forceDefault?: boolean }) => {
      if (!viewportRef.current) {
        return;
      }

      const rect = viewportRef.current.getBoundingClientRect();
      const viewport = { width: rect.width, height: rect.height };
      setViewportSize(viewport);

      const savedTransform = !options?.forceDefault ? readStoredTransform(selectedProjectId) : null;
      const savedLayout = !options?.forceDefault ? readStoredNodeLayout(selectedProjectId) : null;
      const nextTransform = savedTransform
        ? clampTransform(savedTransform, viewport)
        : fitCanvas(viewport);
      const nextLayout = mergeNodeLayout(savedLayout?.positions ?? null);
      const nextWorkerPositions = savedLayout?.workerPositions ?? {};

      if (options?.clearSavedState) {
        clearStoredTransforms();
        clearStoredNodeLayouts();
      }

      setNodeLayout(nextLayout);
      setWorkerPositions(nextWorkerPositions);
      setTransform(nextTransform);
      setHydratedProjectId(selectedProjectId);
      setIsHydrated(true);
    };

    centerCanvas();

    const handleResize = () => window.requestAnimationFrame(() => {
      if (!viewportRef.current) {
        return;
      }

      const rect = viewportRef.current.getBoundingClientRect();
      const viewport = { width: rect.width, height: rect.height };
      setViewportSize(viewport);
      setNodeLayout(mergeNodeLayout(
        (Object.keys(nodeLayoutRef.current) as StageKey[]).reduce<Partial<Record<StageKey, { x: number; y: number }>>>((acc, stage) => {
          acc[stage] = { x: nodeLayoutRef.current[stage].x, y: nodeLayoutRef.current[stage].y };
          return acc;
        }, {}),
      ));
      setWorkerPositions((current) => Object.fromEntries(
        Object.entries(current).map(([workerId, position]) => [workerId, clampWorkerPosition(position.x, position.y)]),
      ));
      setTransform((current) => clampTransform(current, viewport));
    });

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [selectedProjectId]);

  useEffect(() => {
    if (!isHydrated || hydratedProjectId !== selectedProjectId || viewportSize.width === 0 || viewportSize.height === 0) {
      return;
    }

    writeStoredTransform(transform);
  }, [hydratedProjectId, isHydrated, selectedProjectId, transform, viewportSize.height, viewportSize.width]);

  useEffect(() => {
    if (!isHydrated || hydratedProjectId !== selectedProjectId) {
      return;
    }

    const positions = (Object.keys(nodeLayout) as StageKey[]).reduce<Partial<Record<StageKey, { x: number; y: number }>>>((acc, stage) => {
      acc[stage] = { x: nodeLayout[stage].x, y: nodeLayout[stage].y };
      return acc;
    }, {});

    const visibleWorkerIds = new Set(
      agentStages
        .flatMap((type) => workerStatus.pools[type].workers)
        .map((worker) => worker.id),
    );

    const persistedWorkerPositions = Object.entries(workerPositions).reduce<WorkerPositionMap>((acc, [workerId, position]) => {
      if (visibleWorkerIds.has(workerId)) {
        acc[workerId] = position;
      }
      return acc;
    }, {});

    writeStoredNodeLayout(positions, persistedWorkerPositions);
  }, [hydratedProjectId, isHydrated, nodeLayout, selectedProjectId, workerPositions, workerStatus]);

  useEffect(() => {
    const visibleWorkerIds = new Set(
      agentStages
        .flatMap((type) => workerStatus.pools[type].workers)
        .map((worker) => worker.id),
    );

    setWorkerPositions((current) => {
      const filteredEntries = Object.entries(current).filter(([workerId]) => visibleWorkerIds.has(workerId));
      if (filteredEntries.length === Object.keys(current).length) {
        return current;
      }

      return Object.fromEntries(filteredEntries);
    });
  }, [workerStatus]);

  const handleResetViewport = () => {
    if (!viewportRef.current) {
      return;
    }

    const rect = viewportRef.current.getBoundingClientRect();
    const viewport = { width: rect.width, height: rect.height };
    clearStoredTransforms();
    clearStoredNodeLayouts();
    setViewportSize(viewport);
    setNodeLayout(mergeNodeLayout(null));
    setWorkerPositions({});
    setTransform(fitCanvas(viewport));
    setIsHydrated(true);
  };

  const centerViewportOnWorldPoint = (worldX: number, worldY: number) => {
    if (!viewportRef.current) {
      return;
    }

    const rect = viewportRef.current.getBoundingClientRect();
    const viewport = { width: rect.width, height: rect.height };
    setViewportSize(viewport);

    setTransform((current) => clampTransform({
      ...current,
      x: viewport.width / 2 - worldX * current.scale,
      y: viewport.height / 2 - worldY * current.scale,
    }, viewport));
  };

  const adjustZoom = (nextScale: number, anchorX?: number, anchorY?: number) => {
    if (!viewportRef.current) {
      return;
    }

    const rect = viewportRef.current.getBoundingClientRect();
    const viewport = { width: rect.width, height: rect.height };
    const clampedScale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    const localAnchorX = anchorX ?? viewport.width / 2;
    const localAnchorY = anchorY ?? viewport.height / 2;

    setTransform((current) => {
      const worldX = (localAnchorX - current.x) / current.scale;
      const worldY = (localAnchorY - current.y) / current.scale;

      return clampTransform({
        scale: clampedScale,
        x: localAnchorX - worldX * clampedScale,
        y: localAnchorY - worldY * clampedScale,
      }, viewport);
    });
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();

    const rect = event.currentTarget.getBoundingClientRect();
    const anchorX = event.clientX - rect.left;
    const anchorY = event.clientY - rect.top;
    const scaleDelta = event.deltaY < 0 ? 1.12 : 0.9;

    adjustZoom(transform.scale * scaleDelta, anchorX, anchorY);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[data-pipeline-interactive="true"]')) {
      return;
    }

    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };

    setIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const nodeDragState = nodeDragStateRef.current;
    if (nodeDragState && nodeDragState.pointerId === event.pointerId && viewportRef.current) {
      const rect = viewportRef.current.getBoundingClientRect();
      const worldX = (event.clientX - rect.left - transform.x) / transform.scale - nodeDragState.offsetX;
      const worldY = (event.clientY - rect.top - transform.y) / transform.scale - nodeDragState.offsetY;
      const target = nodeDragState.target;

      if (target.kind === 'worker') {
        const clamped = clampWorkerPosition(worldX, worldY);
        const currentNode = workerGraph.workerNodes[target.workerType].find((node) => node.key === target.workerId);
        if (!currentNode) {
          return;
        }

        if (!nodeDragState.moved) {
          const deltaX = Math.abs(currentNode.x - clamped.x);
          const deltaY = Math.abs(currentNode.y - clamped.y);
          if (deltaX > 1 || deltaY > 1) {
            nodeDragState.moved = true;
          }
        }

        setWorkerPositions((current) => ({
          ...current,
          [target.workerId]: clamped,
        }));
        return;
      }

      const clamped = clampNodePosition(target.stage, worldX, worldY);
      const currentNode = nodeLayout[target.stage];
      const deltaX = clamped.x - currentNode.x;
      const deltaY = clamped.y - currentNode.y;

      if (!nodeDragState.moved) {
        const dragDistanceX = Math.abs(deltaX);
        const dragDistanceY = Math.abs(deltaY);
        if (dragDistanceX > 1 || dragDistanceY > 1) {
          nodeDragState.moved = true;
        }
      }

      setNodeLayout((current) => ({
        ...current,
        [target.stage]: {
          ...current[target.stage],
          x: clamped.x,
          y: clamped.y,
        },
      }));

      if (isAgentStage(target.stage) && (deltaX !== 0 || deltaY !== 0)) {
        const workerType = target.stage;
        setWorkerPositions((current) => {
          const next = { ...current };
          for (const workerNode of workerGraph.workerNodes[workerType]) {
            next[workerNode.key] = clampWorkerPosition(workerNode.x + deltaX, workerNode.y + deltaY);
          }
          return next;
        });
      }
      return;
    }

    if (!dragStateRef.current || dragStateRef.current.pointerId !== event.pointerId || !viewportRef.current) {
      return;
    }

    const rect = viewportRef.current.getBoundingClientRect();
    const viewport = { width: rect.width, height: rect.height };
    const deltaX = event.clientX - dragStateRef.current.startX;
    const deltaY = event.clientY - dragStateRef.current.startY;

    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };

    setTransform((current) => clampTransform({
      ...current,
      x: current.x + deltaX,
      y: current.y + deltaY,
    }, viewport));
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (nodeDragStateRef.current?.pointerId === event.pointerId) {
      const dragState = nodeDragStateRef.current;
      nodeDragStateRef.current = null;
      setDraggedNodeKey(null);

      if (!dragState.moved && dragState.target.kind === 'stage' && dragState.target.stage !== 'source') {
        handleStageNodeClick(dragState.target.stage as FocusStage);
      }

      if (!dragState.moved && dragState.target.kind === 'worker') {
        handleStageNodeClick(dragState.target.workerType);
      }

      event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }

    if (dragStateRef.current?.pointerId === event.pointerId) {
      dragStateRef.current = null;
      setIsDragging(false);
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleMinimapClick = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const relativeX = clamp(event.clientX - rect.left, 0, rect.width);
    const relativeY = clamp(event.clientY - rect.top, 0, rect.height);
    const worldX = (relativeX / rect.width) * CANVAS_WIDTH;
    const worldY = (relativeY / rect.height) * CANVAS_HEIGHT;

    centerViewportOnWorldPoint(worldX, worldY);
  };

  const handleMinimapPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    minimapDragPointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    handleMinimapClick(event);
  };

  const handleMinimapPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (minimapDragPointerIdRef.current !== event.pointerId) {
      return;
    }

    handleMinimapClick(event);
  };

  const handleMinimapPointerEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (minimapDragPointerIdRef.current !== event.pointerId) {
      return;
    }

    minimapDragPointerIdRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleStageNodeClick = (stage: FocusStage) => {
    setFocusedStage(stage);

    if (isAgentStage(stage)) {
      onAgentSelect(stage);
      onOpenAgentMonitor(stage);
    }
  };

  const handleNodePointerDown = (stage: StageKey) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!viewportRef.current) {
      return;
    }

    event.stopPropagation();
    const rect = viewportRef.current.getBoundingClientRect();
    const currentNode = nodeLayout[stage];
    const pointerWorldX = (event.clientX - rect.left - transform.x) / transform.scale;
    const pointerWorldY = (event.clientY - rect.top - transform.y) / transform.scale;

    nodeDragStateRef.current = {
      target: { kind: 'stage', stage },
      pointerId: event.pointerId,
      offsetX: pointerWorldX - currentNode.x,
      offsetY: pointerWorldY - currentNode.y,
      moved: false,
    };
    setDraggedNodeKey(stage);
    viewportRef.current.setPointerCapture(event.pointerId);
  };

  const handleWorkerPointerDown = (workerNode: WorkerCanvasNode) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!viewportRef.current) {
      return;
    }

    event.stopPropagation();
    const rect = viewportRef.current.getBoundingClientRect();
    const pointerWorldX = (event.clientX - rect.left - transform.x) / transform.scale;
    const pointerWorldY = (event.clientY - rect.top - transform.y) / transform.scale;

    nodeDragStateRef.current = {
      target: { kind: 'worker', workerId: workerNode.key, workerType: workerNode.type },
      pointerId: event.pointerId,
      offsetX: pointerWorldX - workerNode.x,
      offsetY: pointerWorldY - workerNode.y,
      moved: false,
    };
    setDraggedNodeKey(workerNode.key);
    viewportRef.current.setPointerCapture(event.pointerId);
  };

  const renderFocusedLanePanel = () => (
    <div className="glass-panel p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-nx-text-muted">{t('pipeline.focusedLane')}</div>
          <div className="mt-1 flex items-center gap-2">
            <h3 className="text-base font-semibold text-nx-text">{stageLabel(focusedStage, t)}</h3>
            {isAgentStage(focusedStage) && (
              <span className={`status-pill ${runningAgentCounts[focusedStage] > 0 ? 'bg-nx-accent-dim text-nx-text' : 'bg-nx-bg-subtle text-nx-text-muted'}`}>
                {runningAgentCounts[focusedStage] > 0 ? t('pipeline.activeRuns', { count: runningAgentCounts[focusedStage] }) : t('pipeline.agentIdle')}
              </span>
            )}
            {isAgentStage(focusedStage) && (
              <span className="status-pill bg-nx-bg-subtle text-nx-text-muted">
                {t('workers.poolSize')}: {workerStatus.pools[focusedStage].targetSize}
              </span>
            )}
            {focusedStage === 'pending' && blockedPendingCount > 0 && (
              <span className="status-pill bg-status-pending/15 text-status-pending">
                {t('pipeline.blockedPendingCount', { count: blockedPendingCount })}
              </span>
            )}
          </div>
          <div className="mt-1 text-sm text-nx-text-muted max-w-3xl">{stageDetail(focusedStage, t)}</div>
        </div>

        {isAgentStage(focusedStage) && (
          <button type="button" onClick={() => onAgentSelect(focusedStage)} className="btn-ghost text-xs">
            {t('pipeline.inspectAgent', { agent: stageLabel(focusedStage, t) })}
          </button>
        )}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-2 2xl:grid-cols-3">
        {focusedTasks.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-nx-border px-4 py-6 text-sm text-nx-text-muted">
            {t('pipeline.noTasksInLane')}
          </div>
        ) : (
          focusedTasks.slice(0, 9).map((task) => {
            const project = projects.find((entry) => entry.id === task.projectId);
            const isSelected = selection.type === 'task' && selection.taskId === task.id;

            return (
              <button
                key={task.id}
                type="button"
                onClick={() => onTaskSelect(task.id)}
                className={`glass-card px-4 py-3 text-left cursor-pointer ${isSelected ? 'glow-accent border-nx-accent' : ''}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-nx-text">{task.title}</div>
                    <div className="mt-2 flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.14em] text-nx-text-muted">
                      <span className={`status-pill ${task.executionMode === 'grouped' ? 'bg-status-review/15 text-status-review' : 'bg-nx-bg-subtle text-nx-text-muted'}`}>
                        {getExecutionBadge(task, t)}
                      </span>
                      {task.groupOrder !== null && (
                        <span className="status-pill bg-nx-bg-subtle text-nx-text-muted">#{task.groupOrder}</span>
                      )}
                      {task.blockedByTaskId && (
                        <span className="status-pill bg-status-pending/15 text-status-pending">{t('taskExecution.blocked')}</span>
                      )}
                    </div>
                  </div>
                  <span className="status-pill bg-nx-bg-subtle text-nx-text-muted shrink-0">{stageLabel(task.status, t)}</span>
                </div>
                <div className="mt-2 flex items-center gap-2 text-[11px] text-nx-text-muted">
                  <span className="truncate">{project?.name ?? task.projectId}</span>
                  {task.prNumber && <span className="text-nx-accent">#{task.prNumber}</span>}
                </div>
                {task.groupId && (
                  <div className="mt-2 text-[11px] text-nx-text-muted truncate">{t('taskExecution.groupId')}: {task.groupId}</div>
                )}
                {getWaitingReason(task, t) && (
                  <div className="mt-2 text-[11px] text-status-pending line-clamp-2">{getWaitingReason(task, t)}</div>
                )}
              </button>
            );
          })
        )}
      </div>

      {focusedTasks.length > 9 && (
        <div className="mt-3 text-[11px] text-nx-text-muted">{t('pipeline.moreTasksInLane', { count: focusedTasks.length - 9, lane: stageLabel(focusedStage, t) })}</div>
      )}
    </div>
  );

  const renderSimpleStageChip = (stage: FocusStage, variant: 'flow' | 'branch') => {
    const count = tasksByStage[stage].length;
    const runningCount = isAgentStage(stage) ? runningAgentCounts[stage] : 0;
    const isActive = focusedStage === stage;
    const tone = stagePositions[stage].tone;

    return (
      <button
        key={stage}
        type="button"
        onClick={() => handleStageNodeClick(stage)}
        className={`flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors ${
          isActive ? 'bg-nx-accent-dim' : 'bg-nx-surface hover:bg-nx-surface-hover'
        } ${variant === 'branch' ? 'py-1.5' : ''}`}
        style={{ borderColor: isActive ? tone : 'var(--color-nx-border)' }}
      >
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: tone }} />
        <span className="flex flex-col leading-tight">
          <span className="text-xs font-medium text-nx-text">{stageLabel(stage, t)}</span>
          {runningCount > 0 && (
            <span className="text-[10px] text-nx-accent">{t('pipeline.activeRuns', { count: runningCount })}</span>
          )}
        </span>
        <span className="ml-1 text-base font-semibold tabular-nums" style={{ color: tone }}>{count}</span>
      </button>
    );
  };

  return (
    <div className="glass-panel relative overflow-hidden p-4 lg:p-6 nexus-grid min-[1441px]:min-h-[620px]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.08),transparent_45%)]" />

      <div className="relative z-10 flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-nx-text-muted">{t('pipeline.title')}</div>
          <h2 className="mt-1 text-lg font-semibold text-nx-text">
            {t('pipeline.flow', { project: selectedProject ? selectedProject.name : t('common.allProjects') })}
          </h2>
        </div>
        <button
          type="button"
          onClick={() => selectedProject && onProjectSelect(selectedProject.id)}
          className="btn-ghost text-xs"
        >
          {selectedProject ? t('dashboard.inspectProject') : t('pipeline.globalOverview')}
        </button>
      </div>

      {                                                                                  }
      <div className="relative z-10 flex flex-col gap-4 min-[1441px]:hidden">
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <div className="flex min-w-max items-center gap-1.5">
            {simpleFlowStages.map((stage, index) => (
              <Fragment key={stage}>
                {renderSimpleStageChip(stage, 'flow')}
                {index < simpleFlowStages.length - 1 && (
                  <span className="shrink-0 text-nx-text-muted" aria-hidden="true">→</span>
                )}
              </Fragment>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {simpleBranchStages.map((stage) => renderSimpleStageChip(stage, 'branch'))}
        </div>

        {renderFocusedLanePanel()}
      </div>

      <div className="hidden min-[1441px]:flex relative z-10 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {focusStages.map((stage) => {
              const count = tasksByStage[stage].length;
              const runningCount = isAgentStage(stage) ? runningAgentCounts[stage] : 0;
              const stageIsActive = focusedStage === stage;

              return (
                <button
                  key={stage}
                  type="button"
                  onClick={() => setFocusedStage(stage)}
                  className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${stageIsActive ? 'border-nx-accent bg-nx-accent-dim text-nx-text' : 'border-nx-border bg-nx-surface text-nx-text-muted hover:text-nx-text'}`}
                >
                  {stageLabel(stage, t)} · {count}
                  {runningCount > 0 ? ` · ${t('pipeline.activeRuns', { count: runningCount })}` : ''}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2 text-[11px] text-nx-text-muted">
            <span>{t('pipeline.dragToPan')}</span>
            <span>•</span>
            <span>{t('pipeline.wheelToZoom')}</span>
            <button type="button" onClick={() => adjustZoom(transform.scale * 1.12)} className="btn-ghost text-xs px-2 py-1">+</button>
            <button type="button" onClick={() => adjustZoom(transform.scale * 0.9)} className="btn-ghost text-xs px-2 py-1">-</button>
            <button type="button" onClick={handleResetViewport} className="btn-ghost text-xs px-2 py-1">{t('pipeline.reset')}</button>
          </div>
        </div>

        <div
          ref={viewportRef}
          className={`relative h-[620px] overflow-hidden rounded-[24px] border border-nx-border bg-[linear-gradient(180deg,rgba(10,16,32,0.94),rgba(7,12,24,0.98))] select-none touch-none ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onPointerLeave={handlePointerEnd}
        >
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(59,130,246,0.12),transparent_36%),radial-gradient(circle_at_80%_100%,rgba(20,184,166,0.1),transparent_30%)]" />

          <div className="absolute right-4 top-4 z-20 flex flex-col items-end gap-2">
            <div className="rounded-full border border-nx-border bg-[rgba(10,16,32,0.72)] px-3 py-1.5 text-[11px] text-nx-text-muted backdrop-blur-sm">
              {t('pipeline.clickAgentHint')}
            </div>
            <button
              type="button"
              data-pipeline-interactive="true"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={handleMinimapClick}
              onPointerDownCapture={handleMinimapPointerDown}
              onPointerMove={handleMinimapPointerMove}
              onPointerUp={handleMinimapPointerEnd}
              onPointerCancel={handleMinimapPointerEnd}
              className="relative overflow-hidden rounded-2xl border border-nx-border bg-[rgba(7,12,24,0.9)] p-2 shadow-[0_12px_24px_rgba(0,0,0,0.35)]"
              style={{ width: `${MINIMAP_WIDTH + 16}px` }}
            >
              <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-nx-text-muted">
                <span>{t('pipeline.minimap')}</span>
                <span>{Math.round(transform.scale * 100)}%</span>
              </div>
              <div
                className="relative overflow-hidden rounded-xl border border-nx-border-subtle bg-[linear-gradient(180deg,rgba(17,24,39,0.96),rgba(8,13,25,1))]"
                style={{ width: `${MINIMAP_WIDTH}px`, height: `${MINIMAP_HEIGHT}px` }}
              >
                <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`} aria-hidden="true">
                  {workerGraph.links.map((link) => {
                    const controlX = (link.fromX + link.toX) / 2;
                    const path = `M ${link.fromX} ${link.fromY} C ${controlX} ${link.fromY}, ${controlX} ${link.toY}, ${link.toX} ${link.toY}`;

                    return (
                      <path
                        key={`minimap-${link.id}`}
                        d={path}
                        fill="none"
                        stroke={link.tone}
                        strokeWidth={16}
                        opacity={link.active ? 0.8 : 0.28}
                      />
                    );
                  })}
                </svg>

                {(['source', 'draft', 'pending', 'done', 'failed', 'deferred', 'awaiting_merge'] as StageKey[]).map((stage) => {
                  const position = nodeLayout[stage];
                  const isFocused = stage !== 'source' && focusedStage === stage;
                  return (
                    <div
                      key={`minimap-node-${stage}`}
                      className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full border ${isFocused ? 'ring-2 ring-nx-accent/60' : ''}`}
                      style={{
                        left: `${(position.x / CANVAS_WIDTH) * 100}%`,
                        top: `${(position.y / CANVAS_HEIGHT) * 100}%`,
                        width: stage === 'source' ? '14px' : '12px',
                        height: stage === 'source' ? '14px' : '12px',
                        borderColor: position.tone,
                        background: stage === 'source' ? position.tone : 'rgba(10, 14, 26, 0.96)',
                      }}
                    />
                  );
                })}
                {agentStages.flatMap((type) => workerGraph.workerNodes[type]).map((node) => (
                  <div
                    key={`minimap-worker-${node.key}`}
                    className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full border ${focusedStage === node.type ? 'ring-2 ring-nx-accent/60' : ''}`}
                    style={{
                      left: `${(node.x / CANVAS_WIDTH) * 100}%`,
                      top: `${(node.y / CANVAS_HEIGHT) * 100}%`,
                      width: '12px',
                      height: '12px',
                      borderColor: node.tone,
                      background: 'rgba(10, 14, 26, 0.96)',
                    }}
                  />
                ))}
                {agentStages
                  .map((type) => workerGraph.hubs[type])
                  .filter((hub) => hub.visible)
                  .map((hub) => (
                    <div
                      key={`minimap-hub-${hub.key}`}
                      className="absolute -translate-x-1/2 -translate-y-1/2 rounded-md border"
                      style={{
                        left: `${(hub.x / CANVAS_WIDTH) * 100}%`,
                        top: `${(hub.y / CANVAS_HEIGHT) * 100}%`,
                        width: '10px',
                        height: '10px',
                        borderColor: hub.tone,
                        background: 'rgba(10, 14, 26, 0.96)',
                      }}
                    />
                  ))}

                {minimapViewport && (
                  <div
                    className="absolute rounded-lg border border-nx-accent bg-nx-accent/10 shadow-[0_0_18px_rgba(34,211,238,0.18)]"
                    style={{
                      left: `${minimapViewport.x}px`,
                      top: `${minimapViewport.y}px`,
                      width: `${Math.min(MINIMAP_WIDTH - minimapViewport.x, minimapViewport.width)}px`,
                      height: `${Math.min(MINIMAP_HEIGHT - minimapViewport.y, minimapViewport.height)}px`,
                    }}
                  />
                )}
              </div>
            </button>
          </div>

          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{
              width: `${CANVAS_WIDTH}px`,
              height: `${CANVAS_HEIGHT}px`,
              transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
            }}
          >
            <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`} aria-hidden="true">
              {workerGraph.links.map((link) => {
                const controlX = (link.fromX + link.toX) / 2;
                const path = `M ${link.fromX} ${link.fromY} C ${controlX} ${link.fromY}, ${controlX} ${link.toY}, ${link.toX} ${link.toY}`;

                return (
                  <path
                    key={link.id}
                    d={path}
                    fill="none"
                    stroke={link.tone}
                    strokeWidth={link.active ? 7 : 4}
                    opacity={link.active ? 0.88 : 0.26}
                    className={link.active ? 'flow-line-active' : ''}
                    style={link.active ? { color: link.tone } : undefined}
                  />
                );
              })}
            </svg>

            <button
              type="button"
              data-pipeline-interactive="true"
              onClick={() => selectedProject && onProjectSelect(selectedProject.id)}
              className={`pipeline-node absolute w-[240px] -translate-x-1/2 -translate-y-1/2 text-left ${selection.type === 'project' && selection.projectId === selectedProject?.id ? 'pipeline-node-active glow-accent' : ''}`}
              onPointerDown={handleNodePointerDown('source')}
              style={{ left: `${nodeLayout.source.x}px`, top: `${nodeLayout.source.y}px` }}
            >
              <div className="text-xs uppercase tracking-[0.18em] text-nx-text-muted">{t('pipeline.source')}</div>
              <div className="mt-2 text-base font-semibold text-nx-text">{selectedProject ? selectedProject.name : t('common.allProjects')}</div>
              <div className="mt-2 text-[11px] text-nx-text-muted">{t('pipeline.visibleTasks', { count: tasks.length })}</div>
            </button>

            {(focusStages.filter((stage) => !isAgentStage(stage)) as TaskStatus[]).map((stage) => {
              const position = nodeLayout[stage];
              const stageTasks = tasksByStage[stage];
              const isSelectionMatch = selection.type === 'task' && stageTasks.some((task) => task.id === selection.taskId);
              const isFocused = focusedStage === stage;

              return (
                <button
                  key={stage}
                  type="button"
                  data-pipeline-interactive="true"
                  onPointerDown={handleNodePointerDown(stage)}
                  className={`pipeline-node absolute w-[188px] -translate-x-1/2 -translate-y-1/2 text-left ${isSelectionMatch || isFocused ? 'pipeline-node-active' : ''}`}
                  style={{
                    left: `${position.x}px`,
                    top: `${position.y}px`,
                    borderColor: isFocused || isSelectionMatch ? position.tone : undefined,
                    boxShadow: draggedNodeKey === stage ? `0 0 32px ${position.tone}4d` : undefined,
                    transition: draggedNodeKey === stage ? 'none' : undefined,
                  }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-nx-text-muted">{stageLabel(stage, t)}</div>
                      <div className="mt-2 text-3xl font-semibold" style={{ color: position.tone }}>{stageTasks.length}</div>
                    </div>
                  </div>
                  <div className="mt-3 text-[11px] text-nx-text-muted">{describeStage(stage, stageTasks.length, 0, t)}</div>
                </button>
              );
            })}

            {agentStages.map((type) => {
              const basePosition = nodeLayout[type];
              const pool = workerStatus.pools[type];
              const workers = workerGraph.workerNodes[type];
              const hub = workerGraph.hubs[type];
              const isFocused = focusedStage === type;
              const isSelected = selection.type === 'agent' && selection.agentType === type;

              return (
                <div key={`cluster-${type}`}>
                  <button
                    type="button"
                    data-pipeline-interactive="true"
                    onPointerDown={handleNodePointerDown(type)}
                    className={`absolute -translate-x-1/2 rounded-full border px-3 py-1.5 text-[10px] uppercase tracking-[0.16em] shadow-[0_10px_24px_rgba(0,0,0,0.28)] ${isFocused || isSelected ? 'border-nx-accent bg-[rgba(24,37,72,0.92)] text-nx-text' : 'border-nx-border bg-[rgba(10,16,32,0.9)] text-nx-text-muted'}`}
                    style={{
                      left: `${basePosition.x}px`,
                      top: `${basePosition.y - 112}px`,
                      boxShadow: draggedNodeKey === type ? `0 0 26px ${hub.tone}40` : undefined,
                    }}
                  >
                    {stageLabel(type, t)} · {pool.targetSize}
                    {runningAgentCounts[type] > 0 ? ` · ${t('pipeline.activeRuns', { count: runningAgentCounts[type] })}` : ''}
                  </button>
                  <div className="pointer-events-none absolute flex gap-2" style={{ left: `${basePosition.x + 90}px`, top: `${basePosition.y - 112}px` }}>
                    <button
                      type="button"
                      data-pipeline-interactive="true"
                      title={t('workers.addWorker')}
                      disabled={pool.targetSize >= MAX_WORKER_POOL_SIZE}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSetPoolSize(type, pool.targetSize + 1);
                      }}
                      className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-nx-border bg-[rgba(10,16,32,0.92)] text-sm text-nx-text shadow-[0_10px_24px_rgba(0,0,0,0.3)] hover:border-nx-accent disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      +
                    </button>
                    <button
                      type="button"
                      data-pipeline-interactive="true"
                      title={t('workers.removeWorker')}
                      disabled={pool.targetSize === 0}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSetPoolSize(type, pool.targetSize - 1);
                      }}
                      className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-nx-border bg-[rgba(10,16,32,0.92)] text-sm text-nx-text shadow-[0_10px_24px_rgba(0,0,0,0.3)] hover:border-nx-accent disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      -
                    </button>
                  </div>
                  {hub.visible && (
                    <button
                      type="button"
                      data-pipeline-interactive="true"
                      onPointerDown={handleNodePointerDown(type)}
                      className={`absolute flex h-[58px] w-[58px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-2xl border bg-[rgba(9,14,28,0.94)] text-[9px] font-semibold uppercase tracking-[0.18em] ${isFocused || isSelected ? 'pipeline-node-active' : ''}`}
                      style={{
                        left: `${hub.x}px`,
                        top: `${hub.y}px`,
                        borderColor: hub.tone,
                        boxShadow: draggedNodeKey === type ? `0 0 28px ${hub.tone}40` : `0 0 22px ${hub.tone}24`,
                      }}
                      title={`${stageLabel(type, t)} router`}
                    >
                      HUB
                    </button>
                  )}
                  {workers.map((node) => {
                    const agentProgress = node.worker.state === 'busy' ? getAgentTypeProgress(type) : null;

                    return (
                      <button
                        key={node.key}
                        type="button"
                        data-pipeline-interactive="true"
                        onPointerDown={handleWorkerPointerDown(node)}
                        className={`pipeline-node absolute w-[196px] -translate-x-1/2 -translate-y-1/2 text-left ${isFocused || isSelected ? 'pipeline-node-active' : ''} ${node.worker.state === 'busy' ? 'glow-accent' : ''}`}
                        style={{
                          left: `${node.x}px`,
                          top: `${node.y}px`,
                          borderColor: isFocused || isSelected ? node.tone : undefined,
                          boxShadow: draggedNodeKey === node.key ? `0 0 28px ${node.tone}45` : undefined,
                          transition: draggedNodeKey === node.key ? 'none' : undefined,
                        }}
                        title={getWorkerTooltip(node.worker, t)}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-xs uppercase tracking-[0.16em] text-nx-text-muted">{node.worker.id}</div>
                            <div className="mt-1 text-sm font-semibold" style={{ color: node.tone }}>{node.worker.model ?? t('common.unknownModel')}</div>
                          </div>
                          <span className={`status-pill ${node.worker.state === 'busy' ? 'bg-status-done-dim text-status-done' : node.worker.state === 'stopping' ? 'bg-status-pending-dim text-status-pending' : 'bg-nx-bg-subtle text-nx-text-muted'}`}>
                            {t(`workers.${node.worker.state}`)}
                          </span>
                        </div>
                        <div className="mt-3 text-[11px] text-nx-text-muted">
                          {node.worker.currentTaskTitle ? `${t('workers.workingOn')} ${node.worker.currentTaskTitle}` : describeStage(type, tasksByStage[type].length, runningAgentCounts[type], t)}
                        </div>
                        {agentProgress ? (
                          <div className="mt-2">
                            <AgentProgressBar
                              progress={agentProgress.progress}
                              phaseName={agentProgress.phaseName}
                              agentType={type}
                              size="sm"
                            />
                          </div>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        {renderFocusedLanePanel()}
      </div>
    </div>
  );
}
