import type { IntentResult, SessionControlAction, SessionControlResult, SessionMeta } from '@cockpit/protocol';
import type { RuntimeAttachment } from './sdk-types.ts';
import { CockpitError, SessionUnloadedError, busy, invalid } from './errors.ts';
import { messageOf, settled } from './async.ts';
import type { SessionKernel } from './kernel.ts';
import type { DecisionBroker } from './decisions.ts';
import type { ResourceReader } from './resource-reader.ts';

/**
 * Turn input and Stop/Interrupt controls. Prompt acceptance and controls share
 * controlGate; read leases never block these paths.
 */
export class SessionControlService {
  private readonly k: SessionKernel;
  private readonly decisions: DecisionBroker;
  private readonly reader: ResourceReader;

  constructor(k: SessionKernel, decisions: DecisionBroker, reader: ResourceReader) {
    this.k = k;
    this.decisions = decisions;
    this.reader = reader;
  }

  async prompt(id: string, text: string, mode: 'enqueue' | 'immediate' = 'enqueue', attachments?: RuntimeAttachment[]): Promise<{ ok: boolean; queued?: boolean }> {
    if (!text.trim() && !attachments?.length) throw invalid('Prompt must not be empty');
    return this.k.operation(id, (sdk, st) => st.serialize('controlGate', async () => {
      const before = await this.k.readControl(st, sdk);
      const queued = before.busy && mode === 'enqueue';
      st.sends++;
      this.k.patch(st, { status: 'running', error: null });
      try {
        const accepted = await this.k.withSession(st, sdk, () => sdk.send({
          prompt: text, mode,
          attachments,
        }));
        if (typeof accepted !== 'string' || !accepted) throw new Error('Native message acceptance receipt is missing; delivery is unconfirmed');
        if (st.sdk !== sdk) throw new Error('Native session closed during send; delivery is uncertain');
        if (!st.sendReceipts.has(accepted)) {
          st.accepted.add(accepted);
          if (mode === 'immediate' && before.processing.processing) st.steeringAccepted.add(accepted);
        }
        return { ok: true, ...(queued ? { queued: true } : {}) };
      } catch (error) {
        this.k.patch(st, { status: 'error', error: messageOf(error) });
        throw error;
      } finally {
        st.sends--;
        if (!st.sends) st.sendReceipts.clear();
        this.k.scheduleSync(st);
      }
    }));
  }

  async cancel(id: string): Promise<void> {
    const st = await this.k.state(id);
    this.k.assertAdmission(st);
    if (st.cancelling) return st.cancelling;
    if (st.load || st.activeOperations()) return Promise.reject(busy('Session operation is still in progress'));
    this.k.patch(st, { cancelling: true, error: null });
    st.cancelling = this.k.untilFatal(async () => {
      const sdk = await this.k.liveSession(st);
      if (!sdk) return;
      await this.k.withSession(st, sdk, () => sdk.rpc.queue.clear());
      await this.k.withSession(st, sdk, () => sdk.abort());
      for (const decision of st.decisions.values()) decision.reject(new Error('Native request cancelled'));
      st.decisions.clear();
      st.accepted.clear();
      st.steeringAccepted.clear();
      this.k.projectDecisions(st);
      await this.k.syncNative(st);
      // Abort acknowledges cancellation, but native work can take another event
      // cycle to settle. Keep projecting that activity instead of reporting a
      // successful cancellation as an HTTP failure.
    }).catch(error => {
      this.k.patch(st, { error: messageOf(error) });
      throw error;
    }).finally(() => {
      st.cancelling = undefined;
      this.k.patch(st, { cancelling: false });
      this.k.invalidate(st, ['control', 'queue']);
      this.k.release(st);
    });
    return st.cancelling;
  }

  async interrupt(id: string): Promise<IntentResult<'session/interrupt'>> {
    const st = await this.k.state(id);
    if (st.interrupting) return st.interrupting;
    if (st.load || st.activeOperations() || st.cancelling) return Promise.reject(busy('Session operation is still in progress'));
    const pending = this.k.operation(id, async (sdk) => {
      const target = { epoch: st.turnEpoch, interactionId: st.interactionId, decisions: new Map(st.decisions) };
      st.interruptTurn = target;
      const result = await sdk.rpc.interruptMainTurn({ flushQueued: true });
      if (st.sdk !== sdk || this.k.failure) throw new Error('Native session closed during interrupt; outcome is uncertain');
      if (result.interrupted) this.decisions.clearInterruptedTurn(st, target);
      if (st.interruptTurn === target) st.interruptTurn = undefined;
      await this.k.syncNative(st);
      return { ok: true as const, interrupted: result.interrupted };
    }, 'read', st, ['control', 'queue']).finally(() => {
      if (st.interrupting === pending) st.interrupting = undefined;
    });
    st.interrupting = pending;
    return pending;
  }

  async removeQueued(id: string, itemId: string): Promise<void> {
    await this.k.operation(id, async (sdk, st) => {
      const { items } = await this.k.withSession(st, sdk, () => sdk.rpc.queue.pendingItems());
      const removedIds = items.filter(item => item.id === itemId).flatMap(item => item.messageId ? [item.messageId] : []);
      const result = await this.k.withSession(st, sdk, () => sdk.rpc.queue.removeAt({ id: itemId }));
      if (!result.removed) throw new CockpitError('QUEUE_ITEM_NOT_FOUND', 'Queued item is no longer addressable');
      for (const messageId of removedIds) st.accepted.delete(messageId);
      await this.k.syncNative(st);
    }, ['control', 'queue']);
  }

  async control(id: string, token: string, action: SessionControlAction): Promise<SessionControlResult> {
    if (action.type === 'clear-tasks') {
      if (!action.ids.length || new Set(action.ids).size !== action.ids.length) {
        throw invalid('Clear tasks requires nonempty unique native task IDs');
      }
      action = { ...action, ids: [...action.ids] };
    }
    const st = this.k.sessions.get(id);
    this.k.assertAvailable();
    if (!st?.sdk) throw new SessionUnloadedError();
    const sdk = st.sdk;
    const assertOwner = () => {
      this.k.assertAdmission(st);
      if (st.sdk !== sdk || st.controlToken !== token) throw new CockpitError('STALE_SESSION_CONTROLS', 'Session controls belong to a different native handle; refresh before retrying');
      if (st.load || st.cancelling || st.interrupting) throw busy('Session operation is still in progress');
    };
    assertOwner();
    const admittedTurn = { epoch: st.turnEpoch, interactionId: st.interactionId, decisions: new Map(st.decisions) };
    st.operations++;
    this.k.patch(st, { activeOperations: st.activeOperations() });
    try {
      return await st.serialize('controlGate', async () => {
        assertOwner();
        if (!await this.k.liveSession(st)) throw new SessionUnloadedError();
        assertOwner();
        const outcomes: SessionControlResult['outcomes'] = [];
        const acceptedAtDispatch = new Set(st.accepted);
        const forgetReceipt = (receipt: string) => {
          st.accepted.delete(receipt);
          st.steeringAccepted.delete(receipt);
        };
        const assertOriginalTurn = () => {
          if (st.turnEpoch !== admittedTurn.epoch || st.interactionId !== admittedTurn.interactionId) {
            throw new Error('Main turn changed during Stop; the newer turn was not interrupted');
          }
        };
        type Outcome = SessionControlResult['outcomes'][number];
        // Unlike a read race, this lease lasts until the actual RPC settles.
        // Closing a native handle must not release an outstanding control write.
        const native = async <T>(work: () => Promise<T>): Promise<T> => {
          assertOwner();
          return await work();
        };
        const attempt = async (
          operation: string, targetId: string | undefined,
          work: (outcome: Outcome, mutate: <T extends object | void>(work: () => Promise<T>) => Promise<T>) => Promise<void>,
        ) => {
          const outcome: Outcome = { operation, ...(targetId ? { targetId } : {}), state: 'failed' };
          outcomes.push(outcome);
          let dispatched = false;
          try {
            await work(outcome, async work => {
              assertOwner();
              dispatched = true;
              const result = await work();
              if (result && typeof result === 'object') outcome.result = { ...result };
              if (st.sdk !== sdk || this.k.failure) throw new Error('Native handle closed during control; outcome is uncertain');
              return result;
            });
          } catch (error) {
            outcome.state = dispatched ? 'unconfirmed' : 'failed';
            outcome.error = messageOf(error);
          }
        };
        const taskById = async (taskId: string, kind?: 'agent' | 'shell', allowMissing = false) => {
          const rows = (await native(() => sdk.rpc.tasks.list())).tasks.filter(task => task.id === taskId);
          if (!rows.length && allowMissing) return undefined;
          const task = rows.length === 1 ? rows[0] : undefined;
          if (!task || (task.type !== 'agent' && task.type !== 'shell') || (kind && task.type !== kind)) {
            throw new Error('Task is not an addressable agent/shell in this session');
          }
          if (!['running', 'idle', 'completed', 'failed', 'cancelled'].includes(task.status)) {
            throw new Error('Native task status is unknown');
          }
          return task;
        };
        const terminal = (status: string) => ['completed', 'failed', 'cancelled'].includes(status);
        const cancelTask = async (taskId: string, kind?: 'agent' | 'shell', allowMissing = false) => {
          await attempt('tasks.cancel', taskId, async (outcome, mutate) => {
            const task = await taskById(taskId, kind, allowMissing);
            if (!task || terminal(task.status)) { outcome.state = 'unchanged'; return; }
            if (task.status !== 'running') throw new Error('Task is not running; idle records are not cancelled');
            const result = await mutate(() => sdk.rpc.tasks.cancel({ id: taskId }));
            if (result.cancelled === true) { outcome.state = 'accepted'; return; }
            if (result.cancelled !== false) throw new Error('Native task cancellation result is incomplete');
            const after = await taskById(taskId, kind, true);
            outcome.state = !after || terminal(after.status) ? 'unchanged' : 'failed';
            if (outcome.state === 'failed') outcome.error = 'Native task cancellation returned false and the task is not terminal';
          });
        };
        const clearQueue = async () => {
          await attempt('queue.clear', undefined, async (outcome, mutate) => {
            const before = await native(() => sdk.rpc.queue.pendingItems());
            const steering = new Set(st.steeringAccepted);
            await mutate(() => sdk.rpc.queue.clear());
            outcome.state = 'accepted';
            // Prompt acceptance shares controlGate, so these receipts belong to
            // the cleared lanes, never to a concurrently accepted newer prompt.
            for (const item of before.items) if (item.messageId) forgetReceipt(item.messageId);
            for (const receipt of steering) forgetReceipt(receipt);
          });
        };
        switch (action.type) {
          case 'stop-task':
            await cancelTask(action.id);
            break;
          case 'clear-tasks':
            for (const taskId of action.ids) {
              await cancelTask(taskId, action.kind);
              await attempt('tasks.remove', taskId, async (outcome, mutate) => {
                const task = await taskById(taskId, action.kind, true);
                if (!task) { outcome.state = 'unchanged'; return; }
                if (!terminal(task.status)) {
                  outcome.state = 'unchanged';
                  outcome.error = 'Task is still non-terminal; its native record was retained';
                  return;
                }
                const result = await mutate(() => sdk.rpc.tasks.remove({ id: taskId }));
                outcome.state = result.removed === true ? 'accepted' : result.removed === false ? 'failed' : 'unconfirmed';
                if (outcome.state !== 'accepted') outcome.error = 'Native task removal was not confirmed';
              });
            }
            break;
          case 'clear-queue':
            await clearQueue();
            break;
          case 'remove':
          case 'steer':
            await attempt(action.type === 'remove' ? 'queue.removeAt' : 'queue.sendNow', action.id, async (outcome, mutate) => {
              const queue = await native(() => sdk.rpc.queue.pendingItems());
              const rows = queue.items.filter(item => item.id === action.id);
              if (!rows.length) throw new Error('Queue item is no longer pending in this session');
              if (action.type === 'steer') {
                if (!this.reader.queueProjection(queue).find(item => item.id === action.id)?.canSteer) {
                  throw new Error('Queue item is not an eligible native message');
                }
                const result = await mutate(() => sdk.rpc.queue.sendNow({ id: action.id }));
                outcome.state = result.steered === true ? 'accepted' : result.steered === false ? 'unchanged' : 'unconfirmed';
                if (result.steered === true) for (const row of rows) {
                  if (row.messageId && st.accepted.has(row.messageId)) st.steeringAccepted.add(row.messageId);
                }
              } else {
                const result = await mutate(() => sdk.rpc.queue.removeAt({ id: action.id }));
                outcome.state = result.removed === true ? 'accepted' : result.removed === false ? 'failed' : 'unconfirmed';
                if (result.removed === true) for (const row of rows) {
                  if (row.messageId) forgetReceipt(row.messageId);
                }
              }
            });
            break;
          case 'cancel-decision':
            await attempt(`decision.${action.kind}`, action.requestId, async (outcome, mutate) => {
              const kind = action.kind === 'plan' ? 'planRequest' : action.kind;
              const decision = st.decisions.get(action.requestId);
              if (!decision || decision.kind !== kind) throw new Error('Request is no longer pending');
              if (kind === 'planRequest') {
                const request = decision.value as NonNullable<SessionMeta['planRequest']>;
                if (!request.actions?.includes('exit_only')) throw new Error('Native plan request does not offer exit_only');
                this.decisions.answer(st, action.requestId, kind, { approved: true, selectedAction: 'exit_only' });
                outcome.state = 'accepted';
              } else if (kind === 'elicitation') {
                this.decisions.answer(st, action.requestId, kind, { action: 'cancel' });
                outcome.state = 'accepted';
              } else {
                if (decision.epoch !== st.turnEpoch || decision.interactionId !== st.interactionId) {
                  throw new Error('Request no longer belongs to the current main turn');
                }
                const target = { epoch: decision.epoch, interactionId: decision.interactionId,
                  decisions: new Map(st.decisions) };
                st.interruptTurn = target;
                try {
                  const result = await mutate(() => sdk.rpc.interruptMainTurn({ flushQueued: true }));
                  if (result.interrupted === true) {
                    this.decisions.clearInterruptedTurn(st, target);
                    outcome.state = 'accepted';
                  } else {
                    outcome.state = result.interrupted === false ? 'unchanged' : 'unconfirmed';
                  }
                } finally {
                  if (st.interruptTurn === target) st.interruptTurn = undefined;
                }
              }
            });
            break;
          case 'stop-all': {
            let taskIds: string[] = [];
            await attempt('tasks.snapshot', undefined, async outcome => {
              assertOriginalTurn();
              taskIds = (await native(() => sdk.rpc.tasks.list())).tasks.filter(task =>
                (task.type === 'agent' || task.type === 'shell') && task.status === 'running').map(task => task.id);
              assertOriginalTurn();
              outcome.state = 'unchanged';
            });
            if (st.turnEpoch !== admittedTurn.epoch || st.interactionId !== admittedTurn.interactionId
              || st.sdk !== sdk || st.controlToken !== token) break;
            const target = admittedTurn;
            await clearQueue();
            await settled([
              attempt('session.abort', undefined, async (outcome, mutate) => {
                assertOriginalTurn();
                st.interruptTurn = target;
                try {
                  const result = await mutate(() => sdk.rpc.abort({}));
                  outcome.state = result.success === true ? 'accepted' : result.success === false ? 'failed' : 'unconfirmed';
                  if (result.success === true) {
                    this.decisions.clearInterruptedTurn(st, target);
                    for (const receipt of acceptedAtDispatch) forgetReceipt(receipt);
                  }
                  else outcome.error = result.error || 'Native turn abortion was not confirmed';
                } finally {
                  if (st.interruptTurn === target) st.interruptTurn = undefined;
                }
              }),
              (async () => { for (const taskId of new Set(taskIds)) await cancelTask(taskId, undefined, true); })(),
              attempt('history.abortManualCompaction', undefined, async (outcome, mutate) => {
                assertOriginalTurn();
                const result = await mutate(() => sdk.rpc.history.abortManualCompaction());
                outcome.state = result.aborted === true ? 'accepted' : result.aborted === false ? 'unchanged' : 'unconfirmed';
              }),
              attempt('history.cancelBackgroundCompaction', undefined, async (outcome, mutate) => {
                assertOriginalTurn();
                const result = await mutate(() => sdk.rpc.history.cancelBackgroundCompaction());
                outcome.state = result.cancelled === true ? 'accepted' : result.cancelled === false ? 'unchanged' : 'unconfirmed';
              }),
            ]);
            break;
          }
        }
        return { ok: outcomes.every(outcome => outcome.state === 'accepted' || outcome.state === 'unchanged'), outcomes };
      });
    } finally {
      st.operations--;
      this.k.patch(st, { activeOperations: st.activeOperations() });
      this.k.invalidate(st, ['control', 'queue', 'tasks']);
      this.k.release(st);
    }
  }
}
