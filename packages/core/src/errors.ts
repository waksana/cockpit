import { ErrorCodes, SKILL_NOT_FOUND, type ErrorCode } from '@cockpit/protocol';

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
export const sessionNotFound = (message = 'Unknown session') => new CockpitError('SESSION_NOT_FOUND', message);
export const engineStopped = (message: string) => new CockpitError('ENGINE_STOPPED', message);
export const unsupported = (what: string): never => { throw new CockpitError('UNSUPPORTED', `${what} is unsupported by this public SDK adapter; nothing was changed`); };

export class SkillNotFoundError extends CockpitError {
  constructor() {
    super(SKILL_NOT_FOUND, 'Unknown skill in this working directory');
  }
}

export class SessionUnloadedError extends CockpitError {
  constructor() {
    super('SESSION_UNLOADED', 'Native session data is unavailable while unloaded; explicitly resume the session first');
  }
}
