import { useCallback, useEffect, useState } from 'react';
import type { OfficeUiEvent } from '../types';

const MAX_EVENTS = 40;

function createEventId(type: OfficeUiEvent['type'], timestamp: number): string {
  return `${type}:${timestamp}:${Math.random().toString(36).slice(2, 8)}`;
}

export function useLiveOfficeEvents() {
  const [events, setEvents] = useState<OfficeUiEvent[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    const handleOfficeEvent = (event: Event) => {
      const detail = (event as CustomEvent<Omit<OfficeUiEvent, 'id'>>).detail;
      if (!detail) {
        return;
      }

      setEvents((current) => [
        {
          id: createEventId(detail.type, detail.timestamp),
          ...detail,
        },
        ...current,
      ].slice(0, MAX_EVENTS));
      setUnreadCount((current) => current + 1);
    };

    window.addEventListener('office-event', handleOfficeEvent);
    return () => window.removeEventListener('office-event', handleOfficeEvent);
  }, []);

  const markAllRead = useCallback(() => {
    setUnreadCount(0);
  }, []);

  return {
    events,
    unreadCount,
    markAllRead,
  };
}