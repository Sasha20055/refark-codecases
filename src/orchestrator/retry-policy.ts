const MAX_REVIEW_ATTEMPTS = 2;

export function shouldDeferTask(attempt: number): boolean {
  return attempt >= MAX_REVIEW_ATTEMPTS;
}

export function getMaxReviewAttempts(): number {
  return MAX_REVIEW_ATTEMPTS;
}

export const MAX_TRANSIENT_RETRIES = 2;

const TRANSIENT_RETRY_BACKOFF_MS = [60_000, 300_000];

export function getTransientRetryBackoffMs(spentRetries: number): number {
  const index = Math.min(Math.max(spentRetries, 0), TRANSIENT_RETRY_BACKOFF_MS.length - 1);
  return TRANSIENT_RETRY_BACKOFF_MS[index];
}
