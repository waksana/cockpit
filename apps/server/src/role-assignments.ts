import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { RoleSelection, RoleAdditionResult, RoleAssignmentMutationResult, RoleAssignmentFailureDetails,
  RoleAvailabilityReason, roleAvailability,
  type RoleAssignmentNotificationResult } from '@cockpit/protocol';
import type { ModuleBackend, RoleAssignment, RoleAssignmentNotification, RoleAvailabilityCheck } from '@cockpit/module-api/backend';

export interface AssignmentHandler {
  moduleId: string;
  hooks: NonNullable<ModuleBackend['roleAssignments']>;
  signal: AbortSignal;
}

const receiptSchema = z.object({
  notificationId: z.string().regex(/^[a-f0-9]{64}$/),
  operation: z.enum(['create', 'add']),
  sessionId: z.string().min(1),
  roles: z.array(RoleSelection).max(64),
  previousRoles: z.array(RoleSelection).max(64),
  phase: z.enum(['pending', 'saved', 'complete', 'not-saved']),
  modules: z.array(z.string()),
  delivered: z.array(z.string()),
  creationUnconfirmed: z.boolean().optional(),
  mutationResult: RoleAssignmentMutationResult.optional(),
}).strict();
type Receipt = z.infer<typeof receiptSchema>;
const identities = (roles: RoleAssignment['roles']) =>
  [...new Set(roles.map(role => `${role.moduleId}/${role.roleId}`))].sort();
const same = (a: RoleAssignment['roles'], b: RoleAssignment['roles']) =>
  JSON.stringify(identities(a)) === JSON.stringify(identities(b));
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const availabilitySchema = z.object({
  reasons: z.array(RoleAvailabilityReason.omit({ source: true })).max(128),
}).strict();

/** Durable notification receipts, not a native session registry or readiness cache. */
export class RoleAssignments {
  private readonly callbacks = new AsyncLocalStorage<boolean>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly stopping = new AbortController();

  constructor(
    private readonly root: string,
    private readonly handlers: () => AssignmentHandler[],
    private readonly readRoles: (id: string) => Promise<RoleAssignment['roles']>,
    private readonly sessionExists?: (id: string) => Promise<boolean>,
  ) {}

  stop(): void { this.stopping.abort(new Error('Host is shutting down; role callbacks are aborted')); }

  assertAllowed(): void {
    this.stopping.signal.throwIfAborted();
    if (this.callbacks.getStore()) throw Object.assign(new Error('Role assignment callbacks cannot recursively mutate roles; use read-only host calls'), {
      code: 'ROLE_ASSIGNMENT_REENTRANT', statusCode: 409,
    });
  }

  assertHostCallAllowed(name: string): void {
    if (this.callbacks.getStore() && !['session/get', 'session/directory', 'roles/readiness', 'session/chat', 'session/tool-scope'].includes(name)) {
      throw Object.assign(new Error('Role assignment callbacks may only make read-only host calls'), {
        code: 'ROLE_ASSIGNMENT_REENTRANT', statusCode: 409,
      });
    }
  }

  private async locked<T>(keys: string[], action: () => Promise<T>): Promise<T> {
    this.assertAllowed();
    const unique = [...new Set(keys)].sort();
    const previous = Promise.all(unique.map(key => this.locks.get(key)));
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    for (const key of unique) this.locks.set(key, tail);
    await previous;
    try { return await action(); }
    finally {
      release();
      for (const key of unique) if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  private path(id: string, complete = false): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid role notification identity');
    return join(this.root, 'role-notifications', complete ? 'complete' : 'pending', `${id}.json`);
  }

  private write(receipt: Receipt): void {
    const complete = receipt.phase === 'complete' || receipt.phase === 'not-saved';
    const directory = join(this.root, 'role-notifications', complete ? 'complete' : 'pending');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = this.path(receipt.notificationId, complete);
    const pending = `${file}.${randomUUID()}.pending`;
    try {
      const fd = openSync(pending, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(receiptSchema.parse(receipt))); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(pending, file);
      for (const path of [directory, join(this.root, 'role-notifications'), this.root]) {
        const fd = openSync(path, 'r');
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
    } finally { rmSync(pending, { force: true }); }
    if (complete) this.removePending(receipt.notificationId);
  }

  private removePending(id: string): void {
    rmSync(this.path(id), { force: true });
    const fd = openSync(join(this.root, 'role-notifications', 'pending'), 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }

  private partial(receipt: Receipt, cause: unknown, nativeError?: unknown): Error {
    const recovery = `Inspect session ${receipt.sessionId}; explicitly call roles/notify with notificationId ${receipt.notificationId}. Never repeat native creation or role mutation automatically.`;
    return Object.assign(new Error(`Role assignment ${receipt.phase === 'saved' ? 'was saved but notification failed' : 'outcome is unconfirmed'}: ${errorText(cause)}. ${recovery}`, { cause }), {
      code: 'ROLE_ASSIGNMENT_INCOMPLETE', statusCode: 409, sessionId: receipt.sessionId,
      roleAssignment: RoleAssignmentFailureDetails.parse({
        notificationId: receipt.notificationId, saved: receipt.phase === 'saved' ? true : null,
        roles: receipt.roles, recovery,
        notificationStatus: receipt.phase === 'pending' ? 'pending'
          : receipt.creationUnconfirmed ? 'deferred'
            : receipt.modules.every(id => receipt.delivered.includes(id)) ? 'notified' : 'failed',
        nativeCreation: receipt.operation !== 'create' ? 'not-applicable'
          : receipt.mutationResult?.operation === 'create' ? 'confirmed' : 'unconfirmed',
        ...(receipt.mutationResult ? { mutationResult: receipt.mutationResult } : {}),
        ...(nativeError ? { nativeError: errorText(nativeError) } : {}),
      }),
    });
  }

  private async pendingConflicts(modules: string[], except?: string): Promise<void> {
    let files: string[];
    try { files = await readdir(join(this.root, 'role-notifications', 'pending')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (files.length > 1024) throw new Error('Too many pending role notifications; resolve pending assignments before continuing');
    for (const file of files.filter(file => file.endsWith('.json'))) {
      let source: string;
      try { source = await readFile(join(this.root, 'role-notifications', 'pending', file), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const receipt = receiptSchema.parse(JSON.parse(source));
      if (receipt.notificationId === except) continue;
      if (receipt.modules.some(id => modules.includes(id))) throw this.partial(receipt, 'An earlier assignment still requires notification recovery');
    }
  }

  private async callback<T>(handler: AssignmentHandler, action: (signal: AbortSignal) => T | Promise<T>): Promise<T> {
    const deadline = new AbortController();
    const signal = AbortSignal.any([handler.signal, this.stopping.signal, deadline.signal]);
    signal.throwIfAborted();
    const timer = setTimeout(() => deadline.abort(Object.assign(new Error('Role assignment callback exceeded 30 seconds'), {
      code: 'ROLE_ASSIGNMENT_TIMEOUT', statusCode: 504,
    })), 30_000);
    timer.unref();
    let abort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason ?? new Error('Module stopped'));
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const value = await Promise.race([this.callbacks.run(true, async () => action(signal)), aborted]);
      signal.throwIfAborted();
      return value;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }

  async availability(input: RoleAvailabilityCheck, initial: RoleAvailabilityReason[] = []) {
    this.assertAllowed();
    const selections = (roles: RoleSelection[]) => roles.map(({ moduleId, roleId }) => ({ moduleId, roleId }));
    input = { ...input, roles: selections(input.roles), previousRoles: selections(input.previousRoles) };
    const reasons = [...initial];
    for (const handler of this.handlers().filter(handler => input.roles.some(role => role.moduleId === handler.moduleId))) {
      if (!handler.hooks.availability) continue;
      try {
        const result = availabilitySchema.parse(await this.callback(handler,
          signal => handler.hooks.availability!(structuredClone(input), signal)));
        reasons.push(...result.reasons.map(reason => ({
          ...reason, source: { kind: 'module' as const, moduleId: handler.moduleId },
        })));
      } catch (error) {
        reasons.push(this.unknown(handler, input, error));
      }
    }
    return roleAvailability(input.roles, reasons, input.sessionId);
  }

  private unknown(handler: AssignmentHandler, input: RoleAvailabilityCheck, error: unknown): RoleAvailabilityReason {
    const timeout = error instanceof Error && 'code' in error && error.code === 'ROLE_ASSIGNMENT_TIMEOUT';
    return { code: timeout ? 'ROLE_ASSIGNMENT_TIMEOUT' : 'ROLE_CHECK_ERROR',
      message: `Module ${handler.moduleId} role check ${timeout ? 'timed out' : 'failed or was aborted'}; availability is unconfirmed`,
      status: 'unknown', source: { kind: 'module', moduleId: handler.moduleId },
      roles: input.roles.filter(role => role.moduleId === handler.moduleId), capabilities: [] };
  }

  async run<T>(input: RoleAssignment, action: () => Promise<T>, notified?: (result: RoleAssignmentNotificationResult) => void,
    initial: RoleAvailabilityReason[] = []): Promise<T> {
    this.assertAllowed();
    const selections = (roles: RoleAssignment['roles']) => [...new Map(roles.map(({ moduleId, roleId }) =>
      [`${moduleId}/${roleId}`, { moduleId, roleId }])).values()];
    input = { ...input, roles: selections(input.roles), previousRoles: selections(input.previousRoles) };
    const modules = [...new Set(input.roles.map(role => role.moduleId))].sort();
    return this.locked([...modules, `session:${input.sessionId}`], async () => {
      this.stopping.signal.throwIfAborted();
      const handlers = this.handlers().filter(handler => modules.includes(handler.moduleId));
      const checked = await this.availability(input, initial);
      const reasons = checked.reasons;
      const notificationId = createHash('sha256')
        .update(JSON.stringify([input.sessionId, identities(input.roles)])).digest('hex');
      const notificationModules = handlers.filter(handler => handler.hooks.saved).map(handler => handler.moduleId);
      const unchanged = same(input.roles, input.previousRoles);
      const previous = unchanged ? await this.readReceipt(notificationId) : undefined;
      if (!reasons.length && previous && previous.phase !== 'not-saved'
        && notificationModules.every(moduleId => previous.modules.includes(moduleId))) {
        const receipt = await this.recover(notificationId);
        notified?.({ notificationId, status: receipt.status });
        return action();
      }
      const assignment = structuredClone(input);
      for (const handler of handlers) {
        if (!handler.hooks.permit) continue;
        try {
          const result = await this.callback(handler, signal => handler.hooks.permit!(structuredClone(assignment), signal));
          if (result?.allowed !== true) {
            if (result?.allowed !== false || typeof result.reason !== 'string' || !result.reason.trim()) {
              throw new Error('Invalid permission result');
            }
            reasons.push({ code: 'ROLE_ASSIGNMENT_DENIED', message: result.reason.slice(0, 2000), status: 'denied',
              source: { kind: 'module', moduleId: handler.moduleId },
              roles: input.roles.filter(role => role.moduleId === handler.moduleId), capabilities: [] });
          }
        } catch (error) {
          reasons.push(this.unknown(handler, input, error));
        }
      }
      if (reasons.length) throw Object.assign(new Error(reasons.map(reason => reason.message).join('; ')), {
        code: reasons.length === 1 ? reasons[0]!.code : 'ROLE_SELECTION_UNAVAILABLE',
        statusCode: 409, roleAvailability: roleAvailability(input.roles, reasons, input.sessionId),
      });
      if (!handlers.length) return action();
      await this.pendingConflicts(modules, previous?.notificationId);
      for (const handler of handlers) handler.signal.throwIfAborted();
      this.stopping.signal.throwIfAborted();
      if (!notificationModules.length) return action();
      const retained = previous && previous.phase !== 'not-saved' ? previous : undefined;
      const receipt: Receipt = { ...(retained ?? assignment),
        notificationId, phase: 'pending',
        modules: [...new Set([...retained?.modules ?? [], ...notificationModules])],
        delivered: retained?.delivered ?? [],
        ...(input.operation === 'create' ? { creationUnconfirmed: true } : {}) };
      try { this.write(receipt); }
      catch (error) { throw this.partial(receipt, error); }
      let result: T | undefined;
      let nativeError: unknown;
      let failed = false;
      try { result = await action(); }
      catch (error) { failed = true; nativeError = error; }
      if (!failed && !retained) {
        if (input.operation === 'create' && result === input.sessionId) {
          receipt.mutationResult = { operation: 'create', result: { sessionId: input.sessionId } };
        } else if (input.operation === 'add') {
          const parsed = RoleAdditionResult.safeParse(result);
          if (parsed.success) receipt.mutationResult = { operation: 'add', result: parsed.data };
        }
      }
      try {
        const saved = await this.readRoles(input.sessionId);
        if (!same(saved, input.roles)) {
          if (same(saved, input.previousRoles)) {
            this.removePending(notificationId);
            if (failed) throw nativeError;
            return result!;
          }
          throw new Error('Saved role selection differs from both the previous and requested selections');
        }
        receipt.phase = 'saved';
        if (!failed && !retained) delete receipt.creationUnconfirmed;
        this.write(receipt);
        if (receipt.creationUnconfirmed) throw new Error('Native creation is unconfirmed; saved-role notification is deferred until explicit recovery confirms this exact native session exists');
        await this.deliver(receipt);
      } catch (error) {
        if (failed && error === nativeError) throw error;
        throw this.partial(receipt, error, nativeError);
      }
      if (failed) throw this.partial(receipt, 'Saved selection notification completed, but the native operation did not confirm success', nativeError);
      notified?.({ notificationId, status: 'notified' });
      return result!;
    });
  }

  private async deliver(receipt: Receipt): Promise<void> {
    for (const moduleId of receipt.modules) {
      if (receipt.delivered.includes(moduleId)) continue;
      const handler = this.handlers().find(handler => handler.moduleId === moduleId);
      if (!handler?.hooks.saved) throw new Error(`Role notification handler is unavailable: ${moduleId}`);
      const { notificationId, operation, sessionId, roles, previousRoles } = receipt;
      const notification: RoleAssignmentNotification = { notificationId, operation, sessionId, roles, previousRoles };
      await this.callback(handler, signal => handler.hooks.saved!(structuredClone(notification), signal));
      receipt.delivered.push(moduleId);
      this.write(receipt);
    }
    this.write({ ...receipt, phase: 'complete' });
  }

  async replay(notificationId: string): Promise<{ notificationId: string; sessionId: string; status: 'notified' | 'unchanged' | 'not-saved' }> {
    this.assertAllowed();
    const receipt = await this.readReceipt(notificationId);
    if (!receipt) throw new Error('Unknown role notification identity');
    return this.locked([...receipt.modules, `session:${receipt.sessionId}`], () => this.recover(notificationId));
  }

  private async readReceipt(notificationId: string): Promise<Receipt | undefined> {
    for (const complete of [false, true]) {
      try {
        const receipt = receiptSchema.parse(JSON.parse(await readFile(this.path(notificationId, complete), 'utf8')));
        if (receipt.notificationId !== notificationId) throw new Error('Role notification receipt identity does not match');
        return receipt;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }

  private async recover(notificationId: string): Promise<{ notificationId: string; sessionId: string; status: 'notified' | 'unchanged' | 'not-saved' }> {
    const receipt = await this.readReceipt(notificationId);
    if (!receipt) throw new Error('Unknown role notification identity');
    if (receipt.phase === 'complete' || receipt.phase === 'not-saved') {
      return { notificationId, sessionId: receipt.sessionId, status: receipt.phase === 'not-saved' ? 'not-saved' : 'unchanged' };
    }
    try {
      const roles = await this.readRoles(receipt.sessionId);
      if (receipt.phase === 'pending' && !same(roles, receipt.roles) && same(roles, receipt.previousRoles)) {
        this.write({ ...receipt, phase: 'not-saved' });
        return { notificationId, sessionId: receipt.sessionId, status: 'not-saved' };
      }
      if (!same(roles, receipt.roles)) throw new Error('Saved roles no longer match the notification; no callback was replayed');
      if (receipt.creationUnconfirmed && (!this.sessionExists || !await this.sessionExists(receipt.sessionId))) {
        throw new Error('Native creation remains unconfirmed; no notification, replacement, or native retry was performed');
      }
      delete receipt.creationUnconfirmed;
      receipt.phase = 'saved';
      this.write(receipt);
      await this.deliver(receipt);
      return { notificationId, sessionId: receipt.sessionId, status: 'notified' };
    } catch (error) { throw this.partial(receipt, error); }
  }
}
