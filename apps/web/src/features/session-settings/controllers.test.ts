import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { IntentResult } from '@cockpit/protocol';
import { useCockpit } from '../../net/store';
import { cockpitApi } from '../../net/api';
import type { ChatSession } from '../../net/types';
import { useModelSettings } from './useModelSettings';
import { useSessionRoles } from './useSessionRoles';
import { hasHostLeaveRisk } from '../../lib/hostLeave';

// Headless production hooks need a mounted React owner, not a browser emulator.
function mount(t: TestContext) {
  const document = Object.assign(new EventTarget(), { nodeType: 9, activeElement: null });
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, nodeName: 'DIV', tagName: 'DIV', ownerDocument: document,
    namespaceURI: 'http://www.w3.org/1999/xhtml', textContent: '',
  });
  const globals = { document, window: { document, HTMLIFrameElement: class {} }, IS_REACT_ACT_ENVIRONMENT: true };
  const restores = Object.entries(globals).map(([key, value]) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    return () => previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key);
  });
  const previous = useCockpit.getState();
  useCockpit.setState({ connState: 'open', connectionGeneration: 1, snapshotReady: true, sessions: [session] });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Synthetic controller tests cannot use a backend'));
  const root = createRoot(container as unknown as HTMLElement);
  t.after(async () => {
    await act(async () => root.unmount());
    useCockpit.setState(previous, true);
    restores.forEach(restore => restore());
  });
  return (children: ReactNode) => act(async () => root.render(children));
}
const session: ChatSession = {
  sessionId: 'settings-controller', title: 'Synthetic controller', cwd: '/fixture', loaded: true,
  status: 'idle', error: null, queue: [], ask: null, lastActivity: 0, messages: [],
  materialized: true, historyStale: false, hasMore: false, loadingHistory: false, currentModelId: 'a',
  availableModels: [{ modelId: 'a', name: 'A' }, { modelId: 'b', name: 'B' }, { modelId: 'c', name: 'C' }],
};
test('production model controller stages revisions, guards duplicate apply and retains edits across queued results', async t => {
  const render = mount(t);
  let control!: ReturnType<typeof useModelSettings>;
  const calls: string[] = [];
  let resolve!: (result: IntentResult<'setModel'>) => void;
  const onSetModel = (modelId: string) => {
    calls.push(modelId);
    return new Promise<IntentResult<'setModel'>>(done => { resolve = done; });
  };
  function Harness({ native }: { native: ChatSession }) {
    control = useModelSettings(native, onSetModel, false);
    return null;
  }
  await render(createElement(Harness, { native: session }));
  assert.equal(control.dirty, false);
  await act(async () => control.edit({ modelId: 'b' }));
  assert.equal(control.dirty, true);
  assert.equal(hasHostLeaveRisk(), true);
  assert.deepEqual(calls, []);
  await act(async () => { control.apply(); control.apply(); });
  assert.deepEqual(calls, ['b']);
  await act(async () => control.edit({ modelId: 'c' }));
  await act(async () => resolve({ ok: true, result: { status: 'applied', deferred: true } }));
  assert.equal(control.selection.modelId, 'c');
  assert.equal(control.submission?.selection.modelId, 'b');
  assert.equal(control.outcome?.result.deferred, true);
  await render(createElement(Harness, { native: { ...session, currentModelId: 'b' } }));
  assert.equal(control.selection.modelId, 'c');
  assert.equal(control.dirty, true);
  await act(async () => control.reset());
  assert.equal(control.selection.modelId, 'b');
  assert.equal(control.dirty, false);
  assert.deepEqual(calls, ['b']);
});
test('production roles controller allows busy metadata additions but locks uncertain saves until a fresh inspection', async t => {
  const render = mount(t);
  const role = { moduleId: 'fixture', moduleName: 'Fixture', roleId: 'worker', name: 'Worker' };
  const target = { ...session, status: 'running' as const, roles: [], appliedRoles: [], rolesNeedReload: false };
  let catalogs = 0;
  let writes = 0;
  let inspected = false;
  t.mock.method(cockpitApi, 'listRoles', async () => { catalogs++; return [role]; });
  t.mock.method(cockpitApi, 'addRoles', async () => { writes++; return {
    sessionId: target.sessionId, status: 'uncertain' as const, loaded: true, roles: [], appliedRoles: [], rolesNeedReload: false,
    error: 'acknowledgement unknown',
  }; });
  useCockpit.setState({
    sessions: [target],
    refreshRoles: async () => { inspected = true; return {
      sessionId: target.sessionId, loaded: true, roles: [], appliedRoles: [], rolesNeedReload: false,
    }; },
  });

  let control!: ReturnType<typeof useSessionRoles>;
  function Harness() { control = useSessionRoles(target); return null; }
  await render(createElement(Harness));
  assert.equal(catalogs, 0);
  await act(async () => control.setOpened(true));
  assert.equal(catalogs, 1);
  await act(async () => control.setSelected([role]));
  assert.equal(control.blocked, false);
  await act(async () => control.submit());
  assert.equal(writes, 1);
  assert.equal(control.needsInspection, true);
  await act(async () => control.submit());
  assert.equal(writes, 1);
  await act(async () => control.refresh());
  assert.equal(inspected, true);
  assert.equal(control.needsInspection, false);
  assert.equal(control.additions.length, 1);
});

test('a model draft remains unsaved after dispatch rejection and unknown outcomes, but not a known queued result', async t => {
  const render = mount(t);
  let control!: ReturnType<typeof useModelSettings>;
  let outcome: 'rejected' | 'unknown' | 'queued' = 'rejected';
  const onSetModel = async (): Promise<IntentResult<'setModel'>> => {
    if (outcome === 'rejected') throw new Error('Synthetic pre-dispatch rejection');
    return { ok: true, result: outcome === 'queued' ? { status: 'applied', deferred: true } : {} };
  };
  function Harness() { control = useModelSettings(session, onSetModel, false); return null; }
  await render(createElement(Harness));
  for (const result of ['rejected', 'unknown', 'queued'] as const) {
    outcome = result;
    await act(async () => control.edit({ modelId: 'b' }));
    await act(async () => control.apply());
    assert.equal(control.dirty, result !== 'queued', result);
    assert.equal(hasHostLeaveRisk(), result !== 'queued', result);
  }
});
