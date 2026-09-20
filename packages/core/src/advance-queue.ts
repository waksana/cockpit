import { randomUUID } from 'node:crypto';
import type { IntentBody, QueueAdvanceOperation } from '@cockpit/protocol';

export interface QueueAdvancePort {
  pending(): Promise<number>;
  interrupt(isCurrent: () => boolean, signal: AbortSignal): Promise<{ interrupted: boolean }>;
  observe(listener: (event: 'admitted' | 'started' | 'changed' | Error) => void): () => void;
}
interface Operation {
  value: QueueAdvanceOperation;
  cancelled: boolean;
  controller: AbortController;
  wake?: () => void;
}

/** Event-driven control only: native owns queue storage, admission and continuation. */
export class QueueAdvancer {
  private readonly recent = new Map<string, Operation>();

  active(sessionId: string): boolean {
    return [...this.recent.values()].some(operation => operation.value.sessionId === sessionId
      && ['running', 'cancelling'].includes(operation.value.state));
  }

  call(body: IntentBody<'session/advance-queue'>, port: () => Promise<QueueAdvancePort>) {
    const found = body.operationId ? this.recent.get(body.operationId)
      : [...this.recent.values()].reverse().find(operation => operation.value.sessionId === body.sessionId);
    if (found && found.value.sessionId !== body.sessionId) throw new Error('Queue operation belongs to another session');
    if (body.action !== 'start') {
      if (body.operationId && !found) throw new Error('Unknown queue operation; host restart does not recover operations');
      if (body.action === 'cancel' && found && ['running', 'cancelling'].includes(found.value.state)) {
        found.cancelled = true;
        found.value.state = 'cancelling';
        found.controller.abort();
        found.wake?.();
      }
      return { operation: found ? { ...found.value } : null };
    }
    if (body.operationId) throw new Error('start does not accept an operation ID; query an uncertain start instead');
    if (this.active(body.sessionId)) return { operation: { ...found!.value } };
    const operation: Operation = { cancelled: false, controller: new AbortController(), value: {
      operationId: randomUUID(), sessionId: body.sessionId, state: 'running', startedAt: Date.now(), interrupts: 0,
    } };
    this.recent.set(operation.value.operationId, operation);
    // Bound completed receipts, never evict an active operation.
    for (const [id, entry] of this.recent) {
      if (this.recent.size <= 500) break;
      if (!['running', 'cancelling'].includes(entry.value.state)) this.recent.delete(id);
    }
    void this.run(operation, port);
    return { operation: { ...operation.value } };
  }

  private async run(operation: Operation, createPort: () => Promise<QueueAdvancePort>) {
    let unsubscribe = () => {};
    try {
      const port = await createPort();
      let revision = 0;
      let admission = 0;
      let started = 0;
      let interrupted: number | undefined;
      let failure: Error | undefined;
      unsubscribe = port.observe(event => {
        revision++;
        if (event instanceof Error) failure = event;
        if (event === 'admitted') admission++;
        if (event === 'started') started = admission;
        operation.wake?.();
      });
      while (!operation.cancelled) {
        if (failure) throw failure;
        const before = revision;
        const pending = await port.pending();
        if (failure) throw failure;
        if (operation.cancelled) break;
        if (!pending) { operation.value.state = 'completed'; return; }
        if (interrupted === undefined || started > interrupted) {
          // Mark before sending. No event or failed/uncertain response retries this turn.
          interrupted = admission;
          const target = interrupted;
          const result = await port.interrupt(() => admission === target && !operation.cancelled && !failure, operation.controller.signal);
          if (result.interrupted) operation.value.interrupts++;
          if (failure) throw failure;
          continue;
        }
        if (revision !== before) continue;
        await new Promise<void>(resolve => {
          operation.wake = resolve;
          if (operation.cancelled || failure || revision !== before) resolve();
        });
        operation.wake = undefined;
      }
      operation.value.state = 'cancelled';
    } catch (error) {
      operation.value.state = 'failed';
      operation.value.error = error instanceof Error ? error.message : String(error);
    } finally {
      unsubscribe();
      operation.wake = undefined;
      operation.value.completedAt = Date.now();
    }
  }
}
