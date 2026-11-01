import { EventEmitter } from 'events';

export interface OfficeEvent {
  type: 'task:updated' | 'task:created' | 'run:started' | 'run:progress' | 'run:finished' | 'review:created' | 'worker:busy' | 'worker:idle' | 'worker:added' | 'worker:removed' | 'worker:pool-resized' | 'lead:plan-updated' | 'lead:clarification-requested' | 'lead:approval-requested' | 'lead:approval-resolved' | 'lead:chat-message';
  payload: Record<string, unknown>;
  userId?: string | null;
  timestamp: number;
}

class OfficeEventBus extends EventEmitter {}

export const eventBus = new OfficeEventBus();

export function emitOfficeEvent(type: OfficeEvent['type'], payload: Record<string, unknown>, userId?: string | null): void {
  const event: OfficeEvent = { type, payload, userId: userId ?? null, timestamp: Date.now() };
  eventBus.emit('office-event', event);
}
