// Stable machine codes carried by failed HTTP responses as `{ error, code }`.
// Clients branch on `code` (and the HTTP status), never on `error` text, which
// stays human-readable and may change. Failures without a code are unexpected
// or native-uncertain outcomes (HTTP 500); inspect state rather than retry.
export const ErrorCodes = {
  // 400: the request itself is invalid; nothing was attempted.
  INVALID_REQUEST: 400,
  INVALID_INTENT_BODY: 400,
  INVALID_DIRECTORY_PATH: 400,
  // 404: the addressed resource does not exist (or is no longer addressable).
  UNKNOWN_INTENT: 404,
  SESSION_NOT_FOUND: 404,
  SKILL_NOT_FOUND: 404,
  MODULE_SKILL_NOT_FOUND: 404,
  MCP_NOT_FOUND: 404,
  ROLE_NOT_FOUND: 404,
  QUEUE_ITEM_NOT_FOUND: 404,
  // 409: the current state rejects the request; retry only after it changes.
  SESSION_BUSY: 409,
  SESSION_TRANSITION: 409,
  SESSION_UNLOADED: 409,
  REQUEST_NOT_PENDING: 409,
  STALE_SESSION_CONTROLS: 409,
  STATE_CONFLICT: 409,
  SESSION_CREATION_INCOMPLETE: 409,
  SESSION_CREATION_UNCERTAIN: 409,
  // 499: the client disconnected before the read completed.
  REQUEST_ABORTED: 499,
  // 500: Cockpit produced a result that failed its own contract.
  INVALID_INTENT_RESULT: 500,
  // 501: the native SDK adapter does not support the operation; nothing changed.
  UNSUPPORTED: 501,
  // 503: the engine, roles or service cannot accept the request right now.
  ENGINE_STOPPED: 503,
  UNAVAILABLE: 503,
  SERVICE_CLOSING: 503,
  SERVICE_SHUTTING_DOWN: 503,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ErrorCodes;

export const isErrorCode = (value: unknown): value is ErrorCode =>
  typeof value === 'string' && Object.hasOwn(ErrorCodes, value);

// Structured code of any thrown value or response body, if it carries a known one.
export function errorCode(error: unknown): ErrorCode | undefined {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return isErrorCode(code) ? code : undefined;
}
