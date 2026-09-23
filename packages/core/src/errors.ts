import { ErrorCodes, type ErrorCode } from '@cockpit/protocol';

// The one typed business error thrown by Engine. The HTTP status derives from
// the protocol code table, so server responses and clients agree on both.
export class CockpitError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly sessionId?: string;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown; sessionId?: string }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CockpitError';
    this.code = code;
    this.statusCode = ErrorCodes[code];
    if (options?.sessionId !== undefined) this.sessionId = options.sessionId;
  }
}

export const invalid = (message: string) => new CockpitError('INVALID_REQUEST', message);
export const busy = (message: string) => new CockpitError('SESSION_BUSY', message);
export const transition = (message: string) => new CockpitError('SESSION_TRANSITION', message);
export const conflict = (message: string) => new CockpitError('STATE_CONFLICT', message);
export const notPending = (message: string) => new CockpitError('REQUEST_NOT_PENDING', message);
export const unavailable = (message: string) => new CockpitError('UNAVAILABLE', message);
