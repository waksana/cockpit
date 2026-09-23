import assert from 'node:assert/strict';
import { ErrorCodes, type ErrorCode } from '@cockpit/protocol';

// assert.rejects/throws validator: the error carries one of these protocol
// codes and the HTTP status the protocol assigns to it. Never match message text.
export const errorWithCode = (...codes: ErrorCode[]) => (error: unknown): true => {
  const value = error as { code?: unknown; statusCode?: unknown };
  assert.ok(codes.includes(value.code as ErrorCode), `expected code ${codes.join('|')}, got ${String(value.code)}: ${String(error)}`);
  assert.equal(value.statusCode, ErrorCodes[value.code as ErrorCode]);
  return true;
};
