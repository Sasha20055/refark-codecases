import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { OfficeUiEvent } from '../types';

function dispatchOfficeEvent(rawData: string | null) {
  if (!rawData) {
    return;
  }

  try {
    const parsed = JSON.parse(rawData) as Omit<OfficeUiEvent, 'id'>;
    window.dispatchEvent(new CustomEvent<Omit<OfficeUiEvent, 'id'>>('office-event', {
      detail: parsed,
    }));
  } catch {

  }
}

export function useOfficeEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const es = new EventSource('/api/events');

    const bindEvent = (eventName: OfficeUiEvent['type'], onMessage: () => void) => {
      es.addEventListener(eventName, (event) => {
        dispatchOfficeEvent((event as MessageEvent).data);
        onMessage();
      });
    };

    bindEvent('task:created', () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    });

    bindEvent('task:updated', () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['task'] });
    });

    bindEvent('run:started', () => {
      queryClient.invalidateQueries({ queryKey: ['runs'] });
      queryClient.invalidateQueries({ queryKey: ['active-runs'] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    });

    bindEvent('run:progress', () => {
      queryClient.invalidateQueries({ queryKey: ['active-runs'] });
      queryClient.invalidateQueries({ queryKey: ['runs'] });
    });

    bindEvent('run:finished', () => {
      queryClient.invalidateQueries({ queryKey: ['runs'] });
      queryClient.invalidateQueries({ queryKey: ['active-runs'] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    });

    bindEvent('review:created', () => {
      queryClient.invalidateQueries({ queryKey: ['reviews'] });
    });

    const invalidateLead = () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['task'] });
      queryClient.invalidateQueries({ queryKey: ['lead-task'] });
      queryClient.invalidateQueries({ queryKey: ['lead-report-summary'] });
    };

    bindEvent('lead:plan-updated', invalidateLead);
    bindEvent('lead:clarification-requested', invalidateLead);
    bindEvent('lead:approval-requested', invalidateLead);
    bindEvent('lead:approval-resolved', invalidateLead);
    bindEvent('lead:chat-message', () => {
      queryClient.invalidateQueries({ queryKey: ['lead-chat-thread'] });
      queryClient.invalidateQueries({ queryKey: ['lead-chat-snapshot'] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['task'] });
    });

    const invalidateWorkers = () => {
      queryClient.invalidateQueries({ queryKey: ['workers'] });
    };

    bindEvent('worker:busy', invalidateWorkers);
    bindEvent('worker:idle', invalidateWorkers);
    bindEvent('worker:added', invalidateWorkers);
    bindEvent('worker:removed', invalidateWorkers);
    bindEvent('worker:pool-resized', invalidateWorkers);

    return () => es.close();
  }, [queryClient]);
}
