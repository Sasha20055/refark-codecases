import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { eventBus, type OfficeEvent } from '../event-bus';
import { optionalAuthMiddleware } from '../../auth/middleware';
import { getSessionUser } from '../../auth/access';
import { getGitHubOAuthConfig } from '../../auth/github-oauth';

export const eventsRouter = new Hono();

eventsRouter.use('*', optionalAuthMiddleware);

eventsRouter.get('/', async (c) => {
  const sessionUser = getSessionUser(c);
  const oauthEnabled = !!getGitHubOAuthConfig();

  if (oauthEnabled && !sessionUser) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  return streamSSE(c, async (stream) => {
    const handler = (event: OfficeEvent) => {
      if (oauthEnabled) {
        if (!sessionUser || !event.userId || event.userId !== sessionUser.id) {
          return;
        }
      }

      void stream.writeSSE({
        data: JSON.stringify(event),
        event: event.type,
      });
    };

    eventBus.on('office-event', handler);

    stream.onAbort(() => {
      eventBus.off('office-event', handler);
    });

    while (true) {
      await stream.writeSSE({ data: '', event: 'ping' });
      await stream.sleep(30000);
    }
  });
});
