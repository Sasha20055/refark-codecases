import { nanoid } from 'nanoid';
import { sqlite } from '../db/client';
import { logger } from '../utils/logger';

const LEASE_NAME = 'orchestrator';
const HEARTBEAT_INTERVAL_MS = 5_000;
const STALE_AFTER_MS = 20_000;

export interface LeaderLeaseHandle {
  acquired: boolean;
  ownerId: string;
  release: () => Promise<void>;
}

function ensureLeaseTable(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS process_leases (
      lease_name TEXT PRIMARY KEY NOT NULL,
      owner_id TEXT NOT NULL,
      heartbeat_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
}

function tryAcquireLease(ownerId: string): boolean {
  ensureLeaseTable();

  const now = Date.now();
  const staleCutoff = now - STALE_AFTER_MS;
  const tx = sqlite.transaction(() => {
    const existing = sqlite
      .prepare('SELECT owner_id as ownerId, heartbeat_at as heartbeatAt FROM process_leases WHERE lease_name = ? LIMIT 1')
      .get(LEASE_NAME) as { ownerId: string; heartbeatAt: number } | undefined;

    if (!existing) {
      const inserted = sqlite
        .prepare('INSERT INTO process_leases (lease_name, owner_id, heartbeat_at, created_at) VALUES (?, ?, ?, ?)')
        .run(LEASE_NAME, ownerId, now, now);
      return inserted.changes > 0;
    }

    if (existing.ownerId === ownerId || existing.heartbeatAt < staleCutoff) {
      const updated = sqlite
        .prepare('UPDATE process_leases SET owner_id = ?, heartbeat_at = ? WHERE lease_name = ?')
        .run(ownerId, now, LEASE_NAME);
      return updated.changes > 0;
    }

    return false;
  });

  return tx();
}

function renewLease(ownerId: string): boolean {
  const renewed = sqlite
    .prepare('UPDATE process_leases SET heartbeat_at = ? WHERE lease_name = ? AND owner_id = ?')
    .run(Date.now(), LEASE_NAME, ownerId);
  return renewed.changes > 0;
}

async function releaseLease(ownerId: string): Promise<void> {
  sqlite
    .prepare('DELETE FROM process_leases WHERE lease_name = ? AND owner_id = ?')
    .run(LEASE_NAME, ownerId);
}

export async function acquireLeaderLease(): Promise<LeaderLeaseHandle> {
  const ownerId = `${process.pid}:${nanoid(6)}`;
  const acquired = tryAcquireLease(ownerId);

  if (!acquired) {
    logger.warn({ ownerId, leaseName: LEASE_NAME }, 'Leader lease already held by another process; orchestrator features will stay passive');
    return {
      acquired: false,
      ownerId,
      release: async () => undefined,
    };
  }

  const heartbeat = setInterval(() => {
    try {
      const renewed = renewLease(ownerId);
      if (!renewed) {
        logger.warn({ ownerId, leaseName: LEASE_NAME }, 'Leader lease heartbeat lost ownership');
      }
    } catch (error) {
      logger.warn({ error, ownerId, leaseName: LEASE_NAME }, 'Leader lease heartbeat failed');
    }
  }, HEARTBEAT_INTERVAL_MS);

  return {
    acquired: true,
    ownerId,
    release: async () => {
      clearInterval(heartbeat);
      await releaseLease(ownerId);
    },
  };
}