export class PipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineError';
  }
}

export type OperationalErrorKind =
  | 'rate_limit'
  | 'timeout'
  | 'merge_conflict'
  | 'no_changes'
  | 'container_killed'
  | 'unknown';

export interface OperationalErrorInfo {
  kind: OperationalErrorKind;
  message: string;
  status: 'failed' | 'deferred';

  retryable?: boolean;
}

export function classifyOperationalError(input: unknown): OperationalErrorInfo {
  const rawMessage = input instanceof Error ? input.message : String(input);
  const message = rawMessage.toLowerCase();

  if (message.includes('rate limit') || message.includes('too many requests')) {
    return {
      kind: 'rate_limit',
      message: 'Rate limit reached. Task deferred for retry.',
      status: 'deferred',
      retryable: true,
    };
  }

  if (message.includes('timeout') || message.includes('timed out')) {
    return {
      kind: 'timeout',
      message: 'Operation timeout exceeded. Task marked as failed.',
      status: 'failed',
    };
  }

  if (message.includes('merge conflict') || message.includes('conflict')) {
    return {
      kind: 'merge_conflict',
      message: 'Merge conflict detected. Task deferred for manual follow-up.',
      status: 'deferred',
    };
  }

  if (
    message.includes('exit code 137')
    || message.includes('exit code 139')
    || message.includes('ran out of memory')
  ) {
    return {
      kind: 'container_killed',
      message: 'Agent container was killed (out of memory or crash). Task deferred for retry.',
      status: 'deferred',
      retryable: true,
    };
  }

  if (
    message.includes('no commits between')
    || message.includes('cannot create pr: no commits between')
    || message.includes('no changes produced by dev agent')
  ) {
    return {
      kind: 'no_changes',
      message: 'No effective code changes were produced for this task. Task deferred for manual retry after clarifying scope.',
      status: 'deferred',
      retryable: true,
    };
  }

  return {
    kind: 'unknown',
    message: rawMessage,
    status: 'failed',
  };
}
