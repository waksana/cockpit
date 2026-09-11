import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync,
  unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Intents, SessionStartOperation, type IntentBody } from '@cockpit/protocol';
import type { Engine } from '../engine.ts';
import type { RuntimeAttachment } from '../sdk-types.ts';
import { resolveCockpitUserRoot } from './catalog.ts';
import { privateModuleDirectory, writeModuleRecord } from './private-files.ts';

export interface PreparedSessionStart {
  text: string;
  attachments?: RuntimeAttachment[];
  associate?: (sessionId: string) => void | Promise<void>;
}
export interface SessionStartOptions {
  userRoot?: string;
  engine: Pick<Engine, 'startSession'>;
  prepare: (input: IntentBody<'session/start'>) => PreparedSessionStart | Promise<PreparedSessionStart>;
}
interface Receipt {
  schemaVersion: 1;
  requestHash: string;
  operation: SessionStartOperation;
}
const active = new Set<string>();
const validId = (value: string) => Intents['session/start/get'].body.parse({ operationId: value }).operationId;
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
export class SessionStartFailure extends Error {
  readonly statusCode = 409;
  readonly code = 'SESSION_START_UNKNOWN';
  readonly sessionId: string;
  constructor(readonly operation: SessionStartOperation, options?: ErrorOptions) {
    super('First-message creation or acceptance is unconfirmed. Inspect this operation and planned session; do not recreate or resend.', options);
    this.sessionId = operation.sessionId;
  }
}
function conflict(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409, code: 'SESSION_START_CONFLICT' });
}

/** Durable request receipt only; no native session snapshot, message contents, or automatic recovery. */
export class SessionStartCoordinator {
  readonly userRoot: string;
  constructor(private readonly options: SessionStartOptions) {
    this.userRoot = resolveCockpitUserRoot(options.userRoot);
  }
  private directory(): string { return join(this.userRoot, 'session-starts'); }
  private file(operationId: string): string { return join(this.directory(), `${validId(operationId)}.json`); }
  private read(operationId: string): Receipt | undefined {
    const file = this.file(operationId);
    try { lstatSync(file); } catch (error) { if (hasCode(error, 'ENOENT')) return undefined; throw error; }
    if (realpathSync(dirname(file)) !== dirname(file)) throw new Error('Session start receipt directory must be canonical');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 16 * 1024) {
        throw new Error('Session start receipt must be a bounded private regular file');
      }
      const bytes = readFileSync(fd);
      if (bytes.length > 16 * 1024) throw new Error('Session start receipt exceeds limit');
      const raw: unknown = JSON.parse(bytes.toString('utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('schemaVersion' in raw) || raw.schemaVersion !== 1
        || !('requestHash' in raw) || typeof raw.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.requestHash)
        || !('operation' in raw) || Object.keys(raw).some(key => !['schemaVersion', 'requestHash', 'operation'].includes(key))) {
        throw new Error('Invalid session start receipt schema');
      }
      const operation = SessionStartOperation.parse(raw.operation);
      if (operation.operationId !== operationId) throw new Error('Session start receipt identity mismatch');
      return { schemaVersion: 1, requestHash: raw.requestHash, operation };
    } finally { closeSync(fd); }
  }
  private view(receipt: Receipt): SessionStartOperation {
    if (receipt.operation.state === 'creating' && !active.has(this.file(receipt.operation.operationId))) {
      return { ...receipt.operation, state: 'unknown', error: 'SESSION_START_INTERRUPTED_NO_AUTOMATIC_REPLAY' };
    }
    return { ...receipt.operation };
  }
  get(operationId: string): SessionStartOperation | null {
    const receipt = this.read(operationId);
    return receipt ? this.view(receipt) : null;
  }
  private existing(operationId: string, requestHash: string): SessionStartOperation | undefined {
    const receipt = this.read(operationId);
    if (!receipt) return undefined;
    if (receipt.requestHash !== requestHash) throw conflict('Operation ID is already bound to different first-message input');
    return this.view(receipt);
  }
  private claim(operationId: string, requestHash: string): { receipt: Receipt; owned: boolean } {
    privateModuleDirectory(this.userRoot);
    privateModuleDirectory(this.directory());
    const lock = join(this.directory(), `${validId(operationId)}.lock`);
    let fd: number;
    try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (hasCode(error, 'EEXIST')) throw conflict('Session start claim is locked; inspect the original operation, never steal an uncertain claim');
      throw error;
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid })); fsyncSync(fd);
      const previous = this.read(operationId);
      if (previous) {
        if (previous.requestHash !== requestHash) throw conflict('Operation ID is already bound to different first-message input');
        return { receipt: previous, owned: false };
      }
      const receipt: Receipt = { schemaVersion: 1, requestHash,
        operation: { operationId, sessionId: randomUUID(), state: 'creating' } };
      writeModuleRecord(this.file(operationId), receipt);
      return { receipt, owned: true };
    } finally { closeSync(fd); unlinkSync(lock); }
  }
  async start(raw: IntentBody<'session/start'>): Promise<SessionStartOperation> {
    const input = Intents['session/start'].body.parse(raw);
    const { operationId, ...content } = input;
    const requestHash = createHash('sha256').update(JSON.stringify(canonical(content))).digest('hex');
    const existing = this.existing(operationId, requestHash);
    if (existing) return existing;
    // Managed files must resolve before allocating even a planned native identity.
    const prepared = await this.options.prepare(input);
    if (!prepared.text.trim() && !prepared.attachments?.length) throw new Error('First-message content resolved to an empty prompt');
    const { receipt, owned } = this.claim(operationId, requestHash);
    if (!owned) return this.view(receipt);
    active.add(this.file(operationId));
    try {
      const result = await this.options.engine.startSession({
        sessionId: receipt.operation.sessionId, operationId, cwd: input.cwd, modules: input.modules,
        text: prepared.text, attachments: prepared.attachments, beforeCreate: prepared.associate,
      });
      if (result.ok !== true) throw new Error('Native message acceptance was not confirmed');
      receipt.operation = { ...receipt.operation, state: 'accepted' };
      writeModuleRecord(this.file(operationId), receipt);
      return { ...receipt.operation };
    } catch (cause) {
      receipt.operation = { ...receipt.operation, state: 'unknown', error: 'SESSION_START_OUTCOME_UNCONFIRMED_NO_REPLAY' };
      try { writeModuleRecord(this.file(operationId), receipt); } catch {
        // The original durable creating claim still fences every later request from replay.
        receipt.operation.error = 'SESSION_START_RECEIPT_WRITE_UNCONFIRMED';
      }
      throw new SessionStartFailure({ ...receipt.operation }, { cause });
    } finally { active.delete(this.file(operationId)); }
  }
}
