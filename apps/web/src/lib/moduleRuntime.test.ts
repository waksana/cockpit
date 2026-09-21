import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { ServerEvent, type ModuleEventPayload } from '@cockpit/protocol';
import type { ActivateFrontend, ComposerEditorProps, DraftSchemaHandle, ModuleAsset, ModuleFrontend, ModuleFrontendContext, MarkdownNode, ModuleMenuRegistration, ModuleMenuState, ModuleMenuTarget } from '@cockpit/module-api';
import { ModuleRuntime, validateModuleAsset } from './moduleRuntime';
import { createSessionDrafts } from './textDraft';
import { appendFixture, fixtureItem, fixtureSchema, memoryDraftStorage, type FixtureData } from '../test/draftFixture';
import { nextUi } from '../next/ui';

const digest = 'a'.repeat(64);
const asset = (id = 'fixture'): ModuleAsset => ({
  id, name: id, version: '1.0.0', digest, apiBase: `/_modules/${id}/${digest}/api`,
  entry: `/_modules/assets/${id}/${digest}/entry.js`, styles: [`/_modules/assets/${id}/${digest}/style.css`], config: { max: 20 },
});
const menuSource = () => {
  let current = true;
  const listeners = new Set<() => void>();
  return {
    isCurrent: () => current,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    invalidate: () => { current = false; for (const listener of [...listeners]) listener(); },
    listeners,
  };
};
function fixture(modules: unknown[] = [asset()], frontend: ModuleFrontend | ActivateFrontend = { apiVersion: 2 }) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const imports: string[] = [], styles: string[] = [], reports: unknown[] = [];
  const contexts: ModuleFrontendContext[] = [];
  let removed = 0;
  const runtime = new ModuleRuntime({
    pageUrl: 'https://ui.invalid/chat', baseUrl: 'https://backend.invalid/prefix',
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      return url.endsWith('/_modules') ? Response.json({ modules, errors: [] }) : Response.json({ ok: true });
    },
    load: async url => { imports.push(url); return { activate: (context: ModuleFrontendContext) => {
      contexts.push(context); return typeof frontend === 'function' ? frontend(context) : frontend;
    } }; },
    style: url => { styles.push(url); return () => { removed++; }; },
    report: error => { reports.push(error); },
  });
  return { runtime, requests, imports, styles, reports, contexts, removed: () => removed };
}

test('constructing/rendering the module store has no bootstrap or backend access', () => {
  const f = fixture();
  const initial = f.runtime.getSnapshot();
  assert.deepEqual(initial, []);
  assert.equal(f.runtime.getSnapshot(), initial);
  const unsubscribe = f.runtime.subscribe(() => assert.fail('Not started'));
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.imports, []);
  unsubscribe();
});

test('new UI loads only explicit new entries and never advertises classic CSS', async () => {
  const next = { entry: `/_modules/assets/fixture/${digest}/next.js`, styles: [`/_modules/assets/fixture/${digest}/next.css`] };
  const contexts: Record<string, unknown>[] = [];
  const loaded: string[] = [];
  const styles: string[] = [];
  const removed: string[] = [];
  const runtime = new ModuleRuntime({
    pageUrl: 'https://ui.invalid/next/',
    fetch: async () => Response.json({ modules: [{ ...asset(), next }, asset('classic-only')], errors: [] }),
    load: async url => {
      loaded.push(url);
      return { activate(context: Record<string, unknown>) { contexts.push(context); return { apiVersion: 2 }; } };
    },
    style: url => { styles.push(url); return () => { removed.push(url); }; },
    report: error => assert.fail(String(error)),
  });
  await runtime.start('', nextUi);
  assert.deepEqual(loaded, [`https://ui.invalid${next.entry}`]);
  assert.deepEqual(styles, [`https://ui.invalid${next.styles[0]}`]);
  assert.equal(contexts[0].ui, nextUi);
  assert.equal(contexts[0].react, React);
  assert.equal('uiVersion' in contexts[0], false);
  assert.equal('uiSurfaceVersion' in contexts[0], false);
  assert.deepEqual(runtime.getUnavailablePresentations(), [{ id: 'classic-only', name: 'classic-only' }]);
  await assert.rejects(runtime.start(), /new document/);
  runtime.stop();
  assert.deepEqual(removed, styles);
  assert.deepEqual(runtime.getUnavailablePresentations(), []);
});

test('classic UI ignores the optional new presentation without loading its styles', async () => {
  const f = fixture([{ ...asset(), next: {
    entry: `/_modules/assets/fixture/${digest}/next.js`, styles: [`/_modules/assets/fixture/${digest}/next.css`],
  } }]);
  await f.runtime.start();
  assert.ok(f.imports.every(url => url.endsWith('/entry.js')));
  assert.ok(f.styles.every(url => url.endsWith('/style.css')));
  assert.equal('ui' in f.contexts[0], false);
  assert.equal(f.contexts[0].uiVersion, 1);
  f.runtime.stop();
});

test('a stopped bootstrap body cannot replace current availability or report stale errors', async () => {
  let finishBody: () => void = () => assert.fail('Bootstrap body was not created');
  const first = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      finishBody = () => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({
          modules: [asset('stale')], errors: ['stale bootstrap error'],
        })));
        controller.close();
      };
    },
  }));
  let requests = 0;
  const reports: unknown[] = [];
  const runtime = new ModuleRuntime({
    pageUrl: 'https://ui.invalid/next/',
    fetch: async () => ++requests === 1 ? first : Response.json({ modules: [asset('current')], errors: [] }),
    report: error => reports.push(error),
  });
  const stale = runtime.start('', nextUi);
  await new Promise(resolve => setTimeout(resolve, 0));
  runtime.stop();
  await runtime.start('', nextUi);
  const current = runtime.getUnavailablePresentations();
  assert.deepEqual(current, [{ id: 'current', name: 'current' }]);
  let notifications = 0;
  const unsubscribe = runtime.subscribe(() => { notifications++; });
  finishBody();
  await stale;
  assert.equal(runtime.getUnavailablePresentations(), current);
  assert.deepEqual(reports, []);
  assert.equal(notifications, 0);
  unsubscribe();
  runtime.stop();
});

test('new presentation URLs retain immutable module and backend scope validation', () => {
  const backend = new URL('https://backend.invalid/prefix/');
  for (const next of [
    { entry: 'https://evil.invalid/next.js', styles: [] },
    { entry: `/_modules/assets/other/${digest}/next.js`, styles: [] },
    { entry: `/_modules/assets/fixture/${digest}/next.js`, styles: ['https://evil.invalid/next.css'] },
    { entry: `/_modules/assets/fixture/${digest}/next.js`, styles: [], worker: 'unexpected.js' },
    { entry: `/_modules/assets/fixture/${digest}/next.js`, styles: 'not-an-array' },
  ]) assert.throws(() => validateModuleAsset({ ...asset(), next }, backend), /module|Module|backend/i);
});

test('new UI waits for actual stylesheet load before importing or publishing a module', async t => {
  class Link {
    rel = '';
    href = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    removed = false;
    remove() { this.removed = true; }
  }
  const links: Link[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => new Link(), head: { appendChild(link: Link) { links.push(link); } },
  } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  const modules = [{ ...asset(), next: {
    entry: `/_modules/assets/fixture/${digest}/next.js`, styles: [`/_modules/assets/fixture/${digest}/next.css`],
  } }];
  const imports: string[] = [];
  const reports: unknown[] = [];
  const runtime = new ModuleRuntime({
    pageUrl: 'https://ui.invalid/next/', fetch: async () => Response.json({ modules, errors: [] }),
    load: async url => { imports.push(url); return { activate: () => ({ apiVersion: 2 }) }; },
    report: error => reports.push(error),
  });
  const start = runtime.start('', nextUi);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(links.length, 1);
  assert.deepEqual(imports, []);
  assert.deepEqual(runtime.getSnapshot(), []);
  links[0].onload?.();
  await start;
  assert.equal(imports.length, 1);
  assert.equal(runtime.getSnapshot().length, 1);
  runtime.stop();
  assert.equal(links[0].removed, true);

  const failed = runtime.start('', nextUi);
  await new Promise(resolve => setTimeout(resolve, 0));
  links[1].onerror?.();
  await failed;
  assert.equal(imports.length, 1, 'failed styles do not activate an unstyled module');
  assert.equal(runtime.getSnapshot().length, 0);
  assert.equal(links[1].removed, true);
  assert.match(String(reports[0]), /stylesheet failed/);
  runtime.stop();
});

test('chat-window capability is read-only, scoped, and revoked with its module', async () => {
  const f = fixture();
  await f.runtime.start();
  const context = f.contexts[0];
  assert.equal(context.chatWindowVersion, 1);
  assert.equal(context.composerInputVersion, 1);
  const state = context.state.chatWindow;
  assert.ok(Object.isFrozen(state));
  assert.equal(state.getSnapshot().status, 'unavailable');
  const reads = f.requests.length;
  let notified = 0;
  const unsubscribe = state.subscribe(() => { notified++; });
  const next = Object.freeze({ sessionId: 'A', status: 'ready' as const,
    hasMore: true, partial: false, messages: Object.freeze([]) });
  f.runtime.updateChatWindow(() => next);
  assert.equal(notified, 1);
  assert.equal(state.getSnapshot(), next);
  assert.equal(f.requests.length, reads, 'reading a loaded view cannot request history');
  f.runtime.unregister(f.runtime.getSnapshot()[0]);
  f.runtime.updateChatWindow(() => next);
  assert.equal(notified, 1);
  assert.throws(() => state.getSnapshot(), /abort/i);
  unsubscribe();
  f.runtime.stop();
});

test('draft lifecycle capability completes captured inactive prompts and revokes writes on module disposal', async () => {
  const f = fixture([asset()], { apiVersion: 2, writes: ['text'] });
  await f.runtime.start();
  const context = f.contexts[0];
  assert.equal(context.draftLifecycleVersion, 1);
  const source = createSessionDrafts()('A');
  const draft = context.state.bindDraft(source.reference);
  const release = draft.block('Background capture');
  f.runtime.updateView({ sessionId: 'B', visible: false, connected: false });
  release();
  assert.equal(draft.editTextIfRevision('Captured A result', 0), true);
  assert.equal(source.getSnapshot().text, 'Captured A result');
  let retirement = false;
  draft.subscribe(() => { retirement = draft.getSnapshot().retired; });
  source.retire();
  assert.equal(retirement, true);
  assert.throws(() => draft.editTextIfRevision('Late', 1), /retired/);
  f.runtime.unregister(f.runtime.getSnapshot()[0]);
  assert.throws(() => draft.editTextIfRevision('Revoked', 1), /cannot write/);
  f.runtime.stop();
});

test('menus share registration IDs and rollback, reject retired wrappers and malformed declarations', async () => {
  const entry: ModuleMenuRegistration = { id: 'action', menu: 'global',
    getState: () => ({ label: 'Action' }), onSelect() {} };
  for (const patch of [
    { sends: 'draft' }, { sends: ['prompt'] }, { sends: [null] },
    { menus: {} }, { menus: [null] }, { menus: [{ ...entry, id: '' }] },
    { menus: [entry, entry] }, { menus: [{ ...entry, menu: 'page' }] },
    { menus: [{ ...entry, menu: { toString: () => 'global' } }] },
    { menus: [{ ...entry, order: Infinity }] }, { menus: [{ ...entry, extra: true }] },
    { menus: [{ ...entry, getState: null }] }, { menus: [{ ...entry, subscribe: true }] },
    { menus: [{ ...entry, onSelect: null }] },
    { menus: [{ ...entry, subscribe: () => undefined }] },
    { components: [{ id: 'old', boundary: 'globalNavigation', wrap: (Base: unknown) => Base }] },
    { menus: [{ ...entry, id: 'state' }] },
    { menus: [entry], components: [{ id: 'action', boundary: 'message', wrap: (Base: unknown) => Base }] },
    { menus: [entry], markdown: [{ id: 'action', matches: () => false, component: () => null }] },
  ]) {
    let disposed = 0;
    const f = fixture([asset()], context => {
      context.state.register({ id: 'state', create: () => ({}), dispose: () => { disposed++; } });
      return { apiVersion: 2, ...patch } as unknown as ModuleFrontend;
    });
    await f.runtime.start();
    assert.deepEqual(f.runtime.getSnapshot(), [], JSON.stringify(patch));
    assert.equal(disposed, 1);
    assert.ok(f.reports.length);
    f.runtime.stop();
  }
});

test('global/session menus sort across modules, derive dynamic state and revoke subscriptions with their scope', async () => {
  const listeners = new Set<() => void>();
  let late = () => {};
  let disabled = false;
  let visible = true;
  const calls: ModuleMenuTarget[] = [];
  const f = fixture([asset('z'), asset('a')], () => ({
    apiVersion: 2, menus: [
      { id: 'same', menu: 'global', getState: () => ({ label: disabled ? 'Busy' : 'Ready', disabled, visible }),
        subscribe: listener => { late = listener; listeners.add(listener); return () => { listeners.delete(listener); }; },
        onSelect: target => { calls.push(target); } },
      { id: 'before', menu: 'global', order: -1, getState: () => ({ label: 'Before' }), onSelect() {} },
      { id: 'session', menu: 'session', getState: target => ({ label: JSON.stringify(target) }), onSelect() {} },
    ],
  }));
  const source = menuSource();
  assert.deepEqual(f.runtime.menuItems({ menu: 'global' }, source, () => true), []);
  await f.runtime.start();
  const items = () => f.runtime.menuItems({ menu: 'global' }, source, () => true);
  assert.deepEqual(items().map(item => JSON.parse(item.id)), [
    ['module', 'a', 'before'], ['module', 'z', 'before'], ['module', 'a', 'same'], ['module', 'z', 'same'],
  ]);
  assert.equal(f.runtime.menuItems({ menu: 'session', sessionId: 'A' }, source, () => true).length, 2);
  const old = items()[2];
  disabled = true;
  const revision = f.runtime.getMenuRevision();
  for (const notify of listeners) notify();
  assert.ok(f.runtime.getMenuRevision() > revision);
  assert.equal(items()[2].label, 'Busy');
  assert.equal(items()[2].disabled, true);
  old.onClick();
  assert.equal(calls.length, 0, 'stale enabled presentation never authorizes an action');
  disabled = false;
  visible = false;
  assert.equal(items().length, 2);
  old.onClick();
  assert.equal(calls.length, 0, 'hidden commands are guarded too');
  visible = true;
  f.runtime.unregister(f.runtime.getSnapshot()[0]);
  assert.equal(listeners.size, 1);
  assert.equal(items().length, 2);
  old.onClick();
  assert.equal(calls.length, 0);
  f.runtime.stop();
  assert.equal(listeners.size, 0);
  const stoppedRevision = f.runtime.getMenuRevision();
  late();
  assert.equal(f.runtime.getMenuRevision(), stoppedRevision);
});

test('menu subscription failures rollback staged services and late notifications cannot survive cleanup errors', async () => {
  for (const setupFails of [false, true]) {
    const cleanup: string[] = [];
    let late = () => {};
    const f = fixture([asset('bad'), asset('peer')], context => {
      if (context.moduleId === 'peer') return { apiVersion: 2 };
      context.state.register({ id: 'service', create: () => ({}), dispose: () => { cleanup.push('service'); } });
      const command = { menu: 'global' as const, getState: () => ({ label: 'Action' }), onSelect() {} };
      return { apiVersion: 2, menus: [
        { ...command, id: 'one', subscribe: listener => {
          late = listener;
          return () => { cleanup.push('one'); throw new Error('Unsubscribe failed'); };
        } },
        { ...command, id: 'two', subscribe: () => {
          if (setupFails) throw new Error('Subscribe failed');
          return () => { cleanup.push('two'); };
        } },
      ] };
    });
    await f.runtime.start();
    assert.equal(f.runtime.getSnapshot().some(module => module.asset.id === 'bad'), !setupFails);
    if (!setupFails) f.runtime.unregister(f.runtime.getSnapshot().find(module => module.asset.id === 'bad')!);
    assert.deepEqual(cleanup, setupFails ? ['one', 'service'] : ['one', 'two', 'service']);
    assert.deepEqual(f.runtime.getSnapshot().map(module => module.asset.id), ['peer']);
    assert.ok(f.reports.length);
    const revision = f.runtime.getMenuRevision();
    late();
    assert.equal(f.runtime.getMenuRevision(), revision);
    f.runtime.stop();
  }
});

test('menu actions preserve exact targets, abort on target/module loss, isolate late results and never retry', async () => {
  for (const loss of ['target', 'module', 'none'] as const) {
    const source = menuSource();
    let opened = true;
    let finish!: () => void;
    let signal!: AbortSignal;
    let received!: ModuleMenuTarget;
    let calls = 0;
    const f = fixture([asset()], {
      apiVersion: 2, menus: [{ id: 'action', menu: 'session', getState: () => ({ label: 'Action' }),
        onSelect: (target, context) => {
          calls++; received = target; signal = context.signal;
          return new Promise<void>(resolve => { finish = resolve; });
        } }],
    });
    await f.runtime.start();
    const target: ModuleMenuTarget = { menu: 'session', sessionId: 'A' };
    const items = () => f.runtime.menuItems(target, source, () => opened);
    const captured = items()[0];
    captured.onClick();
    assert.equal(calls, 1, 'onSelect runs in the initiating gesture');
    assert.equal(Object.isFrozen(received), true);
    assert.equal(items()[0].disabled, true, 'one in-flight action per registration/target');
    captured.onClick();
    assert.equal(calls, 1);
    f.runtime.updateView({ sessionId: 'B', visible: true, connected: true });
    opened = false;
    assert.deepEqual(received, { menu: 'session', sessionId: 'A' });
    assert.equal(signal.aborted, false, 'closing/navigating does not redirect or cancel accepted work');
    if (loss === 'target') source.invalidate();
    if (loss === 'module') f.runtime.unregister(f.runtime.getSnapshot()[0]);
    assert.equal(signal.aborted, loss !== 'none');
    if (loss !== 'none') assert.equal(source.listeners.size, 0, 'cancellation never waits for the action to settle');
    const revision = f.runtime.getMenuRevision();
    finish();
    await new Promise(resolve => setImmediate(resolve));
    if (loss !== 'none') assert.equal(f.runtime.getMenuRevision(), revision, 'late settlement cannot publish a revoked flight');
    assert.equal(source.listeners.size, 0);
    captured.onClick();
    assert.equal(calls, 1, 'closed/stopped callbacks never dispatch');
    f.runtime.stop();
  }
});

test('menu state and action errors are local, reported, and preserve peers without success-shaped fallback', async () => {
  let invalid = false;
  let calls = 0;
  const source = menuSource();
  const f = fixture([asset()], {
    apiVersion: 2, menus: [
      { id: 'broken', menu: 'global', getState: () => {
        if (invalid) return { label: 'Invalid', disabled: 'yes' } as unknown as ModuleMenuState;
        throw new Error('State unavailable');
      }, onSelect() {} },
      { id: 'good', menu: 'global', getState: () => ({ label: 'Good' }), onSelect: () => { calls++; } },
      { id: 'sync', menu: 'global', getState: () => ({ label: 'Sync' }), onSelect: () => { throw new Error('Sync failed'); } },
      { id: 'async', menu: 'global', getState: () => ({ label: 'Async' }), onSelect: () => Promise.reject(new Error('Async failed')) },
    ],
  });
  await f.runtime.start();
  const items = () => f.runtime.menuItems({ menu: 'global' }, source, () => true);
  assert.equal(items().length, 3);
  invalid = true;
  for (const item of items()) item.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(f.runtime.getSnapshot().length, 1);
  assert.equal(f.reports.length, 4);
  assert.equal(source.listeners.size, 0);
  source.invalidate();
  items().find(item => item.label === 'Good')!.onClick();
  assert.equal(calls, 1);
  f.runtime.stop();
});

test('bootstrap injects the actual React namespace and binds all requests to backend prefix, digest and credentials', async () => {
  const f = fixture();
  await f.runtime.start();
  assert.equal(f.runtime.getSnapshot().length, 1);
  assert.equal(f.contexts[0].react, React);
  assert.equal(f.contexts[0].apiVersion, 2);
  assert.equal(f.contexts[0].uiVersion, 1);
  assert.equal(f.contexts[0].uiSurfaceVersion, 1);
  assert.equal(f.contexts[0].menuVersion, 1);
  assert.equal(f.contexts[0].createPortal, createPortal);
  assert.deepEqual(f.imports, [`https://backend.invalid/prefix/_modules/assets/fixture/${digest}/entry.js`]);
  assert.equal(f.styles.length, 1);
  await f.contexts[0].request('/files?q=one', {
    method: 'POST', credentials: 'omit', redirect: 'follow', mode: 'no-cors', headers: { 'x-cockpit-module-digest': 'wrong' },
  });
  const request = f.requests[1];
  assert.equal(request.url, `https://backend.invalid/prefix/_modules/fixture/${digest}/api/files?q=one`);
  assert.equal(request.init?.credentials, 'include');
  assert.equal(request.init?.redirect, 'error');
  assert.equal(request.init?.mode, 'cors');
  assert.equal(new Headers(request.init?.headers).get('x-cockpit-module-digest'), digest);
  for (const path of ['//evil.invalid/x', 'https://evil.invalid/x', '../other', '%2e%2e/other', '\\other', '/outside/../../intent/prompt']) {
    await assert.rejects(f.contexts[0].request(path));
  }
  assert.equal(f.requests.length, 2, 'rejected paths never dispatch');
  await f.contexts[0].request('/resolve?ref=%2Ffixture%2Ffile%20name.txt');
  assert.match(f.requests[2].url, /ref=%2Ffixture%2Ffile%20name.txt/);
  f.runtime.stop();
  assert.equal(f.contexts[0].signal.aborted, true);
  assert.equal(f.removed(), 1);
  assert.equal(f.runtime.getSnapshot().length, 0);
  await assert.rejects(f.contexts[0].request('/files'));
  assert.equal(f.requests.length, 3, 'stopped modules cannot initiate new requests');
});

test('invalid manifests, duplicate IDs and unsupported bootstrap versions execute no module code', async () => {
  for (const patch of [
    { apiVersion: 2 }, { digest: 'latest' }, { config: null }, { version: '' },
    { apiBase: '/intent/prompt' }, { entry: 'https://evil.invalid/entry.js' },
    { apiBase: '/_modules/fixture/api' },
    { apiBase: `/_modules/fixture/${'b'.repeat(64)}/api` },
    { entry: `/_modules/assets/other/${digest}/entry.js` },
    { entry: '/_modules/assets/fixture/latest/entry.js' },
    { entry: `/_modules/fixture/${digest}/api/entry.js` },
    { styles: [`https://evil.invalid/${digest}/style.css`] },
  ]) {
    const f = fixture([{ ...asset(), ...patch }]);
    await f.runtime.start();
    assert.equal(f.imports.length, 0);
    assert.equal(f.reports.length, 1);
    f.runtime.stop();
  }
  const duplicates = fixture([asset(), asset()]);
  await duplicates.runtime.start();
  assert.equal(duplicates.imports.length, 0);
  const errors: unknown[] = [];
  let imports = 0;
  const runtime = new ModuleRuntime({ pageUrl: 'https://fixture.invalid',
    fetch: async () => Response.json({ apiVersion: 2, modules: [asset()], errors: [] }),
    load: async () => { imports++; return {}; }, report: error => { errors.push(error); },
  });
  await runtime.start();
  assert.equal(imports, 0);
  assert.equal(errors.length, 1);
});

test('one invalid plugin is local and bootstrap failures leave an empty usable native host', async () => {
  const f = fixture([{ ...asset('bad'), config: null }, asset('good')]);
  await f.runtime.start();
  assert.deepEqual(f.runtime.getSnapshot().map(module => module.asset.id), ['good']);
  const errors: unknown[] = [];
  const runtime = new ModuleRuntime({ pageUrl: 'https://fixture.invalid',
    fetch: async () => { throw new Error('Offline fixture'); }, report: error => { errors.push(error); },
  });
  await runtime.start();
  assert.deepEqual(runtime.getSnapshot(), []);
  assert.equal(errors.length, 1);
  f.runtime.stop();
});

test('registered schema scopes and bound drafts retain their exact identities across session switching', async () => {
  const handles = new Map<string, DraftSchemaHandle<FixtureData>>();
  const f = fixture([asset('z-last'), asset('a-first')], context => {
    handles.set(context.moduleId, context.state.registerDraft(fixtureSchema()));
    return { apiVersion: 2 };
  });
  await f.runtime.start();
  const drafts = createSessionDrafts();
  const a = drafts('A'), b = drafts('B');
  f.runtime.prepareDraft(a);
  const context = f.contexts.find(context => context.moduleId === 'z-last')!;
  const captured = context.state.bindDraft(a.reference);
  const field = handles.get('z-last')!.forDraft(a.reference)!;
  captured.block('Registered work');
  f.runtime.prepareDraft(b);
  f.runtime.updateView({ sessionId: 'B', visible: true, connected: true });
  appendFixture(field, fixtureItem('ready', 'A'));
  assert.equal(field.draft, a.reference);
  assert.equal(handles.get('z-last')!.forDraft(a.reference), field);
  assert.equal(handles.get('a-first')!.forDraft(a.reference)!.getSnapshot().items.length, 0);
  assert.equal(a.getSnapshot().hasContent, true);
  assert.equal(b.getSnapshot().hasContent, false);
  assert.deepEqual(f.reports, []);
  assert.equal(context.state.bindDraft(a.reference), captured);
  captured.block('Unfinished work');
  f.runtime.stop();
  assert.equal(field.getSnapshot().items.length, 1, 'the last immutable field snapshot remains readable');
  assert.equal(a.getSnapshot().hasContent, false, 'unregistered schema data contributes nothing');
  assert.equal(a.getSnapshot().blocks.length, 0, 'module loss releases its own blockers without fallback UI');
  assert.throws(() => field.update(value => value), /stopped/);
  assert.throws(() => captured.editText('stale'), /cannot write/);
});

test('middleware receives the real Base and preserves ordinary callbacks without a host callback policy', async () => {
  for (const asynchronous of [false, true]) {
    const failure = new Error('Module action failed');
    const callback = asynchronous ? () => Promise.reject(failure) : () => { throw failure; };
    let captured!: ComposerEditorProps;
    const Base = (props: ComposerEditorProps) => { captured = props; return null; };
    const f = fixture([asset()], {
      apiVersion: 2,
      components: [{ id: 'editor', boundary: 'composerEditor', wrap: PassedBase => {
        assert.equal(PassedBase, Base, 'middleware is given the original component, not an intercepting proxy');
        return props => React.createElement(PassedBase, { ...props, onClick: callback });
      } }],
    });
    await f.runtime.start();
    const draft = createSessionDrafts()('ordinary-action');
    draft.edit('Keep text');
    const onTextChange = () => {}, onSubmit = () => {}, onPaste = () => {};
    const child = React.createElement('span', null, 'Module content');
    const Component = f.runtime.compose('composerEditor', Base);
    renderToStaticMarkup(React.createElement(Component, {
      draft: draft.reference, operation: 'prompt', disabled: false, busy: false, sendBlocked: false,
      onTextChange, onSubmit, onPaste, children: child, className: 'ordinary-editor',
    }));
    assert.equal(captured.onTextChange, onTextChange);
    assert.equal(captured.onSubmit, onSubmit);
    assert.equal(captured.onPaste, onPaste);
    assert.equal(captured.onClick, callback);
    assert.equal(captured.children, child);
    assert.equal(captured.className, 'ordinary-editor');
    const invoke = () => captured.onClick!({} as React.MouseEvent<HTMLDivElement>);
    if (asynchronous) await assert.rejects(invoke as () => Promise<unknown>, error => error === failure);
    else assert.throws(invoke, error => error === failure);
    assert.equal(f.runtime.getSnapshot().length, 1, 'event failures do not imply render failure or module revocation');
    assert.equal(f.contexts[0].signal.aborted, false);
    assert.deepEqual(f.reports, []);
    assert.equal(draft.getSnapshot().blocks.length, 0);
    assert.equal(await draft.send(async request => {
      assert.deepEqual(request, { intent: 'prompt', body: { sessionId: 'ordinary-action', text: 'Keep text' } });
      return true;
    }), true);
    f.runtime.stop();
  }
});

test('renderer selection never fetches and a throwing matcher keeps the safe host fallback', async () => {
  const Component = () => null;
  const f = fixture([asset()], { apiVersion: 2, markdown: [
    { id: 'broken', matches: () => { throw new Error('Bad matcher'); }, component: Component },
    { id: 'file', matches: node => node.target?.startsWith('/fixture/') ?? false, component: Component },
  ] });
  await f.runtime.start();
  const node: MarkdownNode = { kind: 'link', origin: { sessionId: 'root', messageId: 'native' }, target: '/fixture/file', label: 'File' };
  assert.equal(f.runtime.renderer(node), undefined);
  assert.equal(f.runtime.renderer({ ...node, target: 'https://example.invalid' }), undefined);
  assert.equal(f.requests.length, 1);
  assert.equal(f.reports.length, 1, 'repeat render errors are deduplicated');
  f.runtime.stop();
});

test('explicit module failure releases only its blockers and retains opaque fields until their owner restores them', async t => {
  t.mock.method(console, 'error', () => {});
  let handle!: DraftSchemaHandle<FixtureData>;
  const f = fixture([asset()], context => {
    handle = context.state.registerDraft(fixtureSchema());
    return { apiVersion: 2 };
  });
  t.after(() => f.runtime.stop());
  await f.runtime.start();
  const { storage, values } = memoryDraftStorage();
  const draft = createSessionDrafts(storage)('failed-module');
  f.runtime.prepareDraft(draft);
  const captured = f.contexts[0].state.bindDraft(draft.reference);
  captured.block('Registered work');
  appendFixture(handle.forDraft(draft.reference)!, fixtureItem('ready'));
  draft.edit('Retained text');
  const stored = values.get('cockpit:chat-draft:failed-module');
  assert.ok(stored);
  const releaseOther = draft.bindModule('other', ['text']).draft.block('Other module');
  f.runtime.fail(f.runtime.getSnapshot()[0], new Error('Module failed'));
  assert.equal(f.runtime.getSnapshot().length, 0);
  assert.equal(f.contexts[0].signal.aborted, true);
  assert.equal(draft.getSnapshot().blocks.length, 1, 'unrelated module retains its block');
  assert.equal(draft.getSnapshot().blocks[0].reason, 'Other module');
  assert.throws(() => captured.block('stale'), /cannot block/);
  assert.throws(() => handle.forDraft(draft.reference), /stopped/);
  releaseOther();
  assert.equal(draft.getSnapshot().blocks.length, 0);
  assert.equal(draft.hasUnclaimedStoredData(), true);
  let dispatched = 0;
  const incompleteSend = async () => { dispatched++; return true; };
  assert.equal(await draft.send(incompleteSend), false);
  assert.equal(await draft.runAction(incompleteSend), false);
  assert.equal(dispatched, 0, 'neither text nor decision actions may omit opaque data');
  assert.equal(draft.getSnapshot().text, 'Retained text');
  assert.equal(values.get('cockpit:chat-draft:failed-module'), stored, 'blocked sends preserve the complete stored record');
  f.runtime.stop();
  await f.runtime.start();
  f.runtime.prepareDraft(draft);
  assert.equal(draft.hasUnclaimedStoredData(), false);
  assert.deepEqual(handle.forDraft(draft.reference)!.getSnapshot().items, [fixtureItem('ready')]);
  assert.equal(await draft.send(async request => {
    assert.deepEqual(request.body, {
      sessionId: 'failed-module', text: 'Retained text', attachments: [fixtureItem('ready').value],
    });
    return true;
  }), true);
  assert.deepEqual(handle.forDraft(draft.reference)!.getSnapshot().items, []);
  assert.equal(draft.getSnapshot().text, '');
  f.runtime.stop();
});

test('absolute advertised URLs must remain within the configured backend origin and prefix', () => {
  const backend = new URL('https://backend.invalid/prefix/');
  assert.throws(() => validateModuleAsset(asset('fixture_id'), backend), /Invalid module asset manifest/);
  assert.throws(() => validateModuleAsset({ ...asset(), apiBase: `https://backend.invalid/_modules/fixture/${digest}/api` }, backend));
  assert.equal(validateModuleAsset(asset(), backend).apiBase, `https://backend.invalid/prefix/_modules/fixture/${digest}/api`);
});

test('unknown frontend contributions fail explicitly and still dispose their initializer', async () => {
  let disposed = 0;
  const f = fixture([asset()], { apiVersion: 2, globalPages: [], dispose: () => { disposed++; } } as unknown as ModuleFrontend);
  await f.runtime.start();
  assert.deepEqual(f.runtime.getSnapshot(), []);
  assert.match(String(f.reports[0]), /Unsupported module frontend field/);
  assert.equal(disposed, 1);
  f.runtime.stop();
  assert.equal(disposed, 1);
});

test('old frontend versions and all specialized slots are rejected rather than adapted', async () => {
  for (const frontend of [
    {}, { apiVersion: 1 }, ...['rendersDraftAttachments', 'composerAbove', 'composerActions', 'fileInput',
      'chatRenderers', 'messageDecorations', 'sessionBadges', 'globalActions'].map(key => ({ apiVersion: 2, [key]: [] })),
    { apiVersion: 2, components: [{ id: 'retired-boundary', boundary: 'globalActions', wrap: (Base: unknown) => Base }] },
  ]) {
    const f = fixture([asset()], frontend as unknown as ModuleFrontend);
    await f.runtime.start();
    assert.equal(f.runtime.getSnapshot().length, 0);
    assert.equal(f.reports.length, 1);
    f.runtime.stop();
  }
});

test('a stalled initializer does not block another module and cannot publish its late result', async () => {
  let finish: (value: ModuleFrontend) => void = () => {};
  let disposed = 0;
  const reports: unknown[] = [];
  const runtime = new ModuleRuntime({
    pageUrl: 'https://fixture.invalid', activationTimeoutMs: 10,
    fetch: async () => Response.json({ modules: [asset('blocked'), asset('good')], errors: [] }),
    load: async url => ({ activate: () => url.includes('/blocked/')
      ? new Promise<ModuleFrontend>(resolve => { finish = resolve; }) : { apiVersion: 2 } }),
    style: () => () => {}, report: error => { reports.push(error); },
  });
  await runtime.start();
  assert.deepEqual(runtime.getSnapshot().map(module => module.asset.id), ['good']);
  assert.match(String(reports[0]), /activation timed out/);
  finish({ apiVersion: 2, dispose: () => { disposed++; } });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(disposed, 1);
  assert.deepEqual(runtime.getSnapshot().map(module => module.asset.id), ['good']);
  runtime.stop();
});

test('conflicting renderers report their conflict and preserve default content', async () => {
  let predicates = 0;
  const f = fixture([asset('first'), asset('second'), asset('third')], {
    apiVersion: 2, markdown: [{ id: 'same-node', matches: () => { predicates++; return true; }, component: () => null }],
  });
  await f.runtime.start();
  assert.equal(f.runtime.renderer({ kind: 'image', label: 'image', target: './a.png',
    origin: { sessionId: 'session', messageId: 'message' } }), undefined);
  assert.match(String(f.reports[0]), /多个模块渲染规则/);
  assert.equal(predicates, 3, 'overlap cannot hide a later predicate');
  f.runtime.stop();
});

test('stable worker URLs stay in the backend prefix and are exposed without registration', async () => {
  const worker = { entry: '/_modules/workers/fixture/worker.js', scope: '/_modules/workers/fixture/' };
  const f = fixture([{ ...asset(), worker }]);
  await f.runtime.start();
  assert.deepEqual(f.contexts[0].worker, {
    entry: 'https://backend.invalid/prefix/_modules/workers/fixture/worker.js',
    scope: 'https://backend.invalid/prefix/_modules/workers/fixture/',
  });
  assert.equal(f.requests.length, 1);
  assert.equal(f.imports.length, 1);
  assert.ok(Object.isFrozen(f.contexts[0].worker));
  f.runtime.stop();
  const old = fixture();
  await old.runtime.start();
  assert.equal(old.contexts[0].worker, undefined);
  old.runtime.stop();
  for (const malformed of [
    null, {}, { ...worker, extra: true },
    { ...worker, entry: 'https://evil.invalid/_modules/workers/fixture/worker.js' },
    { ...worker, entry: '/_modules/workers/other/worker.js' },
    { ...worker, entry: `/_modules/assets/fixture/${digest}/worker.js` },
    { ...worker, entry: '/_modules/workers/fixture/%2e/worker.js' },
    { ...worker, entry: '/_modules/workers/fixture/../fixture/worker.js' },
    { ...worker, entry: '/_modules/workers/fixture/worker.js?version=1' },
    { ...worker, entry: '/_modules/workers/fixture/worker.js#hash' },
    { ...worker, entry: 'https://backend.invalid/_modules/workers/fixture/worker.js' },
    { ...worker, scope: '/_modules/workers/' },
    { ...worker, scope: '/_modules/workers/fixture' },
    { ...worker, scope: '/_modules/workers/fixture/%2f' },
    { ...worker, scope: '/_modules/workers/fixture/?scope=wide' },
  ]) {
    const bad = fixture([{ ...asset(), worker: malformed }]);
    await bad.runtime.start();
    assert.equal(bad.imports.length, 0, JSON.stringify(malformed));
    assert.equal(bad.reports.length, 1);
    bad.runtime.stop();
  }
});

test('component middleware validates IDs, boundaries and order and composes stable types deterministically', async () => {
  for (const boundary of ['message', 'sessionStatus', 'composer', 'composerEditor', 'composerInput', 'attachment',
    'managementHeader', 'managementDetailHeader'] as const) {
    const supported = fixture([asset()], {
      apiVersion: 2, components: [{ id: 'supported', boundary, wrap: Base => Base }],
    } as ModuleFrontend);
    await supported.runtime.start();
    assert.equal(supported.runtime.getSnapshot().length, 1, boundary);
    assert.deepEqual(supported.reports, []);
    supported.runtime.stop();
    for (const entries of [
      {}, [{}], [{ id: 'one', boundary, wrap: 'span' }], [{ id: 'one', boundary: 'unknown', wrap: (Base: unknown) => Base }],
      [{ id: 'one', boundary, wrap: (Base: unknown) => Base, order: Infinity }],
      [{ id: 'one', boundary, wrap: (Base: unknown) => Base }, { id: 'one', boundary, wrap: (Base: unknown) => Base }],
    ]) {
      const f = fixture([asset()], { apiVersion: 2, components: entries } as unknown as ModuleFrontend);
      await f.runtime.start();
      assert.equal(f.runtime.getSnapshot().length, 0);
      assert.equal(f.reports.length, 1);
      f.runtime.stop();
    }
  }
  const wraps: string[] = [];
  const f = fixture([asset('z'), asset('a')], context => ({
    apiVersion: 2, components: ['last', 'first'].map(id => ({
      id, order: id === 'last' ? 2 : 0, boundary: 'managementDetailHeader',
      wrap: Base => {
        wraps.push(`${context.moduleId}:${id}`);
        return props => React.createElement(Base, props);
      },
    })),
  }));
  await f.runtime.start();
  const Base = () => React.createElement('button', null, 'Core');
  const first = f.runtime.compose('managementDetailHeader', Base);
  assert.deepEqual(wraps, ['z:last', 'a:last', 'z:first', 'a:first']);
  assert.equal(f.runtime.compose('managementDetailHeader', Base), first);
  f.runtime.updateView({ sessionId: 'new', visible: true, connected: true });
  assert.equal(f.runtime.compose('managementDetailHeader', Base), first);
  assert.equal(renderToStaticMarkup(React.createElement(first, { item: 'fixture' })), '<button>Core</button>', 'the complete middleware stack adds no DOM');
  assert.equal(wraps.length, 4);
  f.runtime.stop();
  assert.equal(f.runtime.compose('managementDetailHeader', Base), Base);
});

test('view snapshots and invalidation subscriptions are scoped, stable and revoked with the module', async () => {
  const f = fixture([asset('a'), asset('b')]);
  await f.runtime.start();
  const [a, b] = f.contexts;
  assert.equal('surfaceVersion' in a, false);
  assert.equal('view' in a, false);
  assert.deepEqual(a.state.host.getSnapshot(), { sessionId: null, visible: false, connected: false });
  const original = a.state.host.getSnapshot();
  let views = 0, invalidations = 0, otherInvalidations = 0;
  const unsubscribe = a.state.host.subscribe(() => { views++; });
  a.onInvalidate!(() => { invalidations++; });
  b.onInvalidate!(() => { otherInvalidations++; });
  a.state.host.subscribe(() => { throw new Error('Listener failure'); });
  f.runtime.updateView({ ...original });
  assert.equal(a.state.host.getSnapshot(), original);
  assert.equal(views, 0);
  f.runtime.updateView({ sessionId: 'root', visible: true, connected: true });
  assert.equal(views, 1);
  assert.equal(f.reports.length, 1, 'listener failure remains local');
  assert.ok(Object.isFrozen(a.state.host.getSnapshot()));
  f.runtime.invalidate('a');
  f.runtime.invalidate('unknown');
  assert.equal(invalidations, 1);
  assert.equal(otherInvalidations, 0);
  unsubscribe();
  unsubscribe();
  f.runtime.unregister(f.runtime.getSnapshot().find(module => module.asset.id === 'a')!);
  a.state.host.subscribe(() => assert.fail('Stopped view subscription'));
  a.onInvalidate!(() => assert.fail('Stopped invalidation subscription'));
  f.runtime.updateView({ sessionId: null, visible: false, connected: false });
  f.runtime.invalidate('a');
  f.runtime.invalidate('b');
  assert.equal(views, 1);
  assert.equal(invalidations, 1);
  assert.equal(otherInvalidations, 1);
  f.runtime.stop();
  f.runtime.invalidate('b');
  assert.equal(otherInvalidations, 1);
});

test('failed activation removes subscriptions even when a module never returns contributions', async () => {
  for (const timeout of [false, true]) {
    let context!: ModuleFrontendContext;
    let notified = 0;
    let disposed = 0;
    const runtime = new ModuleRuntime({
      pageUrl: 'https://fixture.invalid', activationTimeoutMs: 10,
      fetch: async () => Response.json({ modules: [asset()], errors: [] }),
      load: async () => ({ activate: (value: ModuleFrontendContext) => {
        context = value;
        value.state.host.subscribe(() => { notified++; });
        value.onInvalidate!(() => { notified++; });
        value.onEvent(() => { notified++; });
        value.state.register({ id: 'owned', create: () => ({}), dispose: () => { disposed++; } });
        if (timeout) return new Promise(() => {});
        throw new Error('Initializer failed');
      } }),
      report: () => {},
    });

    await runtime.start();
    assert.equal(context.signal.aborted, true);
    runtime.updateView({ sessionId: 'new', visible: true, connected: true });
    runtime.invalidate('fixture');
    runtime.receiveEvent('fixture', null);
    assert.equal(notified, 0);
    assert.equal(disposed, 1);
    runtime.stop();
  }
});

test('module events route only to their owner, isolate listener errors and revoke every subscription', async () => {
  const received: ModuleEventPayload[] = [];
  const f = fixture([asset('a'), asset('b')], context => {
    context.onEvent(payload => {
      if (context.moduleId === 'b') assert.fail('Foreign module received payload');
      (payload as { items: unknown[] }).items.push('mutation');
    });
    context.onEvent(payload => { received.push(payload); });
    return { apiVersion: 2 };
  });
  await f.runtime.start();
  const [a, b] = f.contexts;
  let extra = 0;
  const unsubscribe = a.onEvent(() => { extra++; });
  const envelope = ServerEvent.parse({ type: 'module/event', moduleId: 'a', payload: { items: [1] } });
  if (envelope.type !== 'module/event') assert.fail();
  const view = f.runtime.getViewSnapshot(), modules = f.runtime.getSnapshot();
  f.runtime.receiveEvent('unknown', null);
  f.runtime.receiveEvent('a', envelope.payload);
  assert.deepEqual(received, [{ items: [1] }]);
  assert.equal(extra, 1);
  assert.equal(f.reports.length, 1);
  assert.equal(f.runtime.getViewSnapshot(), view);
  assert.equal(f.runtime.getSnapshot(), modules);
  unsubscribe();
  unsubscribe();
  f.runtime.receiveEvent('a', envelope.payload);
  assert.equal(extra, 1);
  f.runtime.unregister(modules.find(module => module.asset.id === 'a')!);
  a.onEvent(() => assert.fail('Stopped module subscription'));
  f.runtime.receiveEvent('a', null);
  assert.equal(received.length, 2);
  f.runtime.stop();
  b.onEvent(() => assert.fail('Stopped runtime subscription'));
  f.runtime.receiveEvent('b', null);
  assert.equal(received.length, 2);
});

test('module event subscriptions can precede the initial module GET during activation', async () => {
  const received: ModuleEventPayload[] = [];
  const runtime = new ModuleRuntime({
    pageUrl: 'https://fixture.invalid',
    fetch: async input => {
      if (String(input).endsWith('/_modules')) return Response.json({ modules: [asset()], errors: [] });
      runtime.receiveEvent('fixture', Object.freeze({ kind: 'during-fetch' }));
      return Response.json({});
    },
    load: async () => ({ activate: async (context: ModuleFrontendContext) => {
      context.onEvent(payload => { received.push(payload); });
      await context.request('/initial');
      return { apiVersion: 2 };
    } }),
  });
  await runtime.start();
  assert.deepEqual(received, [{ kind: 'during-fetch' }]);
  runtime.stop();
});

test('state registration creates concrete services once, stages publication and disposes in reverse order', async () => {
  const disposed: string[] = [];
  let creates = 0, handle!: ReturnType<ModuleFrontendContext['state']['register']>, observedEmpty = false;
  const f = fixture([asset()], context => {
    observedEmpty = f.runtime.getSnapshot().length === 0;
    const typed = context.state.register({
      id: 'uploads',
      create: () => { creates++; return { perDraft: new Map<string, number>(), increment(id: string) { this.perDraft.set(id, 1); } }; },
      dispose: service => { assert.equal(service.perDraft.get('A'), 1); disposed.push('uploads'); },
    });
    typed.get().increment('A');
    handle = typed;
    context.state.register({ id: 'probes', create: () => new Map(), dispose: () => { disposed.push('probes'); throw new Error('Disposer failed'); } });
    return { apiVersion: 2, dispose: () => { disposed.push('frontend'); } };
  });
  await f.runtime.start();
  assert.equal(observedEmpty, true);
  assert.equal(creates, 1);
  assert.equal(handle.get(), handle.get());
  assert.throws(() => f.contexts[0].state.register({ id: 'late', create: () => ({}), dispose() {} }), /activation-only/);
  f.runtime.stop();
  f.runtime.stop();
  assert.deepEqual(disposed, ['frontend', 'probes', 'uploads']);
  assert.throws(() => handle.get(), /stopped/);
  assert.equal(f.reports.length, 1);
});

test('teardown revokes schema state before cleanup but notifies canonical draft readers only afterward', async () => {
  for (const operation of ['stop', 'unregister'] as const) {
    const order: string[] = [];
    const draft = createSessionDrafts()(`cleanup-${operation}`);
    const f = fixture([asset()], context => {
      const schema = context.state.registerDraft(fixtureSchema());
      context.state.register({
        id: 'reader',
        create: () => draft.reference.subscribe(() => {
          order.push('service-read');
          schema.forDraft(draft.reference)!.getSnapshot();
        }),
        dispose: unsubscribe => {
          assert.throws(() => schema.forDraft(draft.reference), /stopped/);
          order.push('service-dispose');
          unsubscribe();
        },
      });
      return { apiVersion: 2 };
    });
    f.runtime.prepareDraft(draft);
    await f.runtime.start();
    f.contexts[0].state.bindDraft(draft.reference).block('Pending registered work');
    order.length = 0;
    const unsubscribe = draft.subscribe(() => {
      assert.equal(f.runtime.getSnapshot().length, 0);
      assert.equal(draft.getSnapshot().blocks.length, 0);
      order.push('host-read');
    });
    if (operation === 'stop') f.runtime.stop();
    else f.runtime.unregister(f.runtime.getSnapshot()[0]);
    assert.deepEqual(order, ['service-dispose', 'host-read']);
    assert.deepEqual(f.reports, []);
    unsubscribe();
    f.runtime.stop();
  }
});

test('state rollback covers cross-registry IDs, synchronous/async factories and invalid frontend results', async () => {
  for (const failure of ['duplicate', 'schema-duplicate', 'factory', 'async', 'frontend'] as const) {
    let disposed = 0;
    const f = fixture([asset()], context => {
      context.state.register({ id: 'owned', create: () => ({}), dispose: () => { disposed++; } });
      try {
        if (failure === 'schema-duplicate') context.state.registerDraft(fixtureSchema({ id: 'owned' }));
        if (failure === 'factory') context.state.register({ id: 'failed', create: () => { throw new Error('Factory failed'); }, dispose() {} });
        if (failure === 'async') context.state.register({ id: 'async', create: (() => Promise.resolve({})) as never, dispose() {} });
      } catch { /* A swallowed registration error still invalidates activation. */ }
      return failure === 'frontend' ? { apiVersion: 1 } as unknown as ModuleFrontend : {
        apiVersion: 2, components: failure === 'duplicate' ? [{ id: 'owned', boundary: 'managementHeader', wrap: Base => Base }] : [],
      };
    });
    await f.runtime.start();
    assert.equal(f.runtime.getSnapshot().length, 0, failure);
    assert.equal(disposed, 1, failure);
    assert.equal(f.contexts[0].signal.aborted, true);
    f.runtime.stop();
    assert.equal(disposed, 1);
  }
});

test('bound base drafts reject lookalike references and release only their own leases on stop', async () => {
  const f = fixture([asset()], { apiVersion: 2, writes: ['text'] });
  await f.runtime.start();
  const context = f.contexts[0];
  const a = createSessionDrafts()('A'), b = createSessionDrafts()('A');
  assert.notEqual(a.reference.id, b.reference.id);
  assert.throws(() => context.state.bindDraft({ ...a.reference }), /host draft reference/);
  const bound = context.state.bindDraft(a.reference);
  assert.equal(context.state.bindDraft(a.reference), bound);
  f.runtime.updateView({ sessionId: 'B', visible: true, connected: true });
  bound.editText('A only');
  assert.equal(b.getSnapshot().text, '');
  const release = bound.block('Outstanding module work');
  const other = a.bindModule('other', ['text']);
  other.draft.block('Other work');
  context.signal.addEventListener('abort', release);
  f.runtime.stop();
  assert.deepEqual(a.getSnapshot().blocks.map(block => block.reason), ['Other work']);
  assert.throws(() => context.state.bindDraft(a.reference), /not active/);
  other.dispose();
});

test('draft schemas stage initialization and prepare drafts discovered during asynchronous activation before publication', async () => {
  const a = createSessionDrafts()('A'), b = createSessionDrafts()('B');
  let created = 0, finish!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  let handle!: import('@cockpit/module-api').DraftSchemaHandle<FixtureData>;
  const f = fixture([asset()], async context => {
    handle = context.state.registerDraft(fixtureSchema({ create: () => {
      created++;
      return { items: [fixtureItem('initial')] };
    } }));
    assert.equal(a.getSnapshot().hasContent, false, 'staged state is not a live contribution');
    entered();
    await waiting;
    return { apiVersion: 2 };
  });
  f.runtime.prepareDraft(a);
  const starting = f.runtime.start();
  await ready;
  f.runtime.prepareDraft(b);
  assert.equal(f.runtime.getSnapshot().length, 0);
  finish();
  await starting;
  assert.equal(created, 2);
  assert.equal(f.runtime.isDraftPrepared(a), true);
  assert.equal(f.runtime.isDraftPrepared(b), true);
  assert.equal(handle.forDraft(a.reference), handle.forDraft(a.reference));
  assert.equal(created, 2, 'lookup never instantiates state');
  assert.equal(a.getSnapshot().hasContent, true);
  assert.equal(b.getSnapshot().hasContent, true);
  assert.throws(() => f.contexts[0].state.registerDraft(fixtureSchema({ id: 'late' })), /activation-only/);
  f.runtime.stop();
  assert.equal(a.getSnapshot().hasContent, false);
  assert.equal(b.getSnapshot().hasContent, false);
});
