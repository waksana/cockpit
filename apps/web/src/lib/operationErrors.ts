// Error ownership (docs/frontend-guidelines.md#error-ownership): the UI that
// starts an operation shows its result. Only failures without a visible owner
// reach the global notice. These helpers carry that decision with the error.
import { describeReason, reportUxError } from './errorReporter';

// A definite, negative outcome: the operation was not applied.
export class OperationRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationRejected';
  }
}

// A sent operation without a definite answer; its effect must be checked.
export class OperationUnconfirmed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationUnconfirmed';
  }
}

// An operation that was never sent, for example while offline.
export class OperationNotSent extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationNotSent';
  }
}

interface FailureRecord {
  // Complete global wording, used only when no owner remains to show it.
  readonly message: string;
  // The request may have changed state; an orphaned failure must not vanish.
  readonly mutation: boolean;
  // A sent mutation without a definite answer.
  readonly uncertain: boolean;
}

const failures = new WeakMap<object, FailureRecord>();

export function recordOperationFailure(error: unknown, record: FailureRecord): void {
  if (error && typeof error === 'object' && !failures.has(error)) failures.set(error, record);
}

export function operationFailure(error: unknown): FailureRecord | undefined {
  return error && typeof error === 'object' ? failures.get(error) : undefined;
}

// Rejections and requests that were never sent failed. A sent mutation without
// an answer, or an error of unknown origin, is unknown: never claim it failed.
export function operationErrorState(error: unknown): 'failed' | 'unknown' {
  if (error instanceof OperationRejected || error instanceof OperationNotSent) return 'failed';
  if (error instanceof OperationUnconfirmed) return 'unknown';
  const failure = operationFailure(error);
  return failure && !failure.uncertain ? 'failed' : 'unknown';
}

export function operationErrorReason(error: unknown): string {
  return describeReason(error, false);
}

// The owner left before the operation settled. Reads are simply dropped;
// mutation outcomes are reported once so they are never silently lost.
export function reportOrphanedOperation(error: unknown): void {
  const failure = operationFailure(error);
  if (failure?.mutation) reportUxError(failure.message);
}
