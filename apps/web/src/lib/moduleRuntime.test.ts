import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActivateFrontend, ComposerContext, ComposerFileSelection, ComposerProps, DraftSchemaScope, ModuleAsset, ModuleFrontend, ModuleFrontendContext, MarkdownNode } from '@cockpit/module-api';
import { ModuleRuntime, validateModuleAsset } from './moduleRuntime';
import { createSessionDrafts, type SessionDraft } from './textDraft';
import { appendFixture, fixtureItem, fixtureSchema, type FixtureData } from '../test/draftFixture';

const digest = 'a'.repeat(64);
const asset = (id = 'fixture'): ModuleAsset => ({
  id, name: id, version: '1.0.0', digest, apiBase: `/_modules/${id}/${digest}/api`,
  entry: `/_modules/assets/${id}/${digest}/entry.js`, styles: [`/_modules/assets/${id}/${digest}/style.css`], config: { max: 20 },
});
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
const target = (draft: SessionDraft) => ({ draft: draft.reference, operation: draft.reference.purpose.kind, disabled: false });
function captureComposer(runtime: ModuleRuntime, draft: SessionDraft): ComposerProps {
  runtime.prepareDraft(draft);
  let captured!: ComposerProps;
  const Component = runtime.compose('composer', (props: ComposerProps) => { captured = props; return null; });
  renderToStaticMarkup(React.createElement(Component, {
    ...target(draft), busy: false, sendBlocked: false, onTextChange() {}, onSubmit() {},
  }));
  return captured;
}
function withFiles(receive: (selection: ComposerFileSelection, context: ComposerContext, field: DraftSchemaScope<FixtureData>) => boolean): ActivateFrontend {
  return context => {
    const schema = context.state.registerDraft(fixtureSchema());
    return { apiVersion: 2,
      components: [{ id: 'files', boundary: 'composer', wrap: Base => props => React.createElement(Base, {
        ...props, onFiles: selection => {
          const field = schema.forDraft(selection.target.draft);
          return field ? receive(selection, { ...selection.target, draft: context.state.bindDraft(selection.target.draft) }, field)
            : props.onFiles?.(selection) ?? false;
        },
      }) }],
    };
  };
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

test('bootstrap injects the actual React namespace and binds all requests to backend prefix, digest and credentials', async () => {
  const f = fixture();
  await f.runtime.start();
  assert.equal(f.runtime.getSnapshot().length, 1);
  assert.equal(f.contexts[0].react, React);
  assert.equal(f.contexts[0].apiVersion, 2);
  assert.equal(f.contexts[0].uiVersion, 1);
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

test('scoped file contexts survive session switching and one callback owns each selection', async () => {
  const received: ComposerContext[] = [];
  let field!: DraftSchemaScope<FixtureData>;
  const f = fixture([asset('z-last'), asset('a-first')], withFiles((_selection, context, value) => {
    field = value;
    received.push(context); context.draft.block('Selected file'); return true;
  }));
  await f.runtime.start();
  const drafts = createSessionDrafts();
  const a = drafts('A'), b = drafts('B');
  const composer = captureComposer(f.runtime, a);
  assert.equal(f.runtime.receiveFiles([new File(['fixture'], 'one.txt')], target(a), 'picker', composer.onFiles), true);
  assert.equal(received.length, 1);
  const captured = received[0];
  captureComposer(f.runtime, b);
  appendFixture(field, fixtureItem('ready', 'A'));
  assert.equal(a.getSnapshot().hasContent, true);
  assert.equal(b.getSnapshot().hasContent, false);
  assert.deepEqual(f.reports, []);
  assert.equal(f.contexts.find(context => context.moduleId === 'z-last')!.state.bindDraft(a.reference), captured.draft);
  captured.draft.block('Unfinished file');
  f.runtime.stop();
  assert.equal(field.getSnapshot().items.length, 1, 'the last immutable field snapshot remains readable');
  assert.equal(a.getSnapshot().hasContent, false, 'unregistered schema data contributes nothing');
  assert.equal(a.getSnapshot().blocks.length, 0, 'module loss releases its own blockers without fallback UI');
  assert.throws(() => field.update(value => value), /stopped/);
  assert.throws(() => captured.draft.editText('stale'), /cannot write/);
});

test('unhandled or failed file callbacks do not manufacture host data, blockers or fallback payloads', async () => {
  for (const frontend of [{ apiVersion: 2 } as const, withFiles(() => { throw new Error('Fixture failure'); })]) {
    const f = fixture([asset()], frontend);
    await f.runtime.start();
    const draft = createSessionDrafts()('failed-file');
    draft.edit('Keep text');
    assert.equal(f.runtime.receiveFiles([new File(['x'], 'selected.txt')], target(draft), 'paste', captureComposer(f.runtime, draft).onFiles), false);
    assert.equal(draft.getSnapshot().blocks.length, 0);
    assert.equal(await draft.send(async request => {
      assert.deepEqual(request, { intent: 'prompt', body: { sessionId: 'failed-file', text: 'Keep text' } });
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

test('file callback faults release only their module blockers and omit revoked schema fields', async () => {
  for (const asynchronous of [false, true]) {
    let captured: ComposerContext | undefined;
    const f = fixture([asset()], withFiles((_selection, context, field) => {
          captured = context;
          context.draft.block('Original upload');
          appendFixture(field, fixtureItem('ready'));
          if (asynchronous) return Promise.reject(new Error('Async upload handler failed')) as unknown as boolean;
          throw new Error('Sync upload handler failed');
    }));
    await f.runtime.start();
    const draft = createSessionDrafts()('failed-file');
    draft.edit('Retained text');
    const releaseOther = draft.bindModule('other', ['text']).draft.block('Other module');
    assert.equal(f.runtime.receiveFiles([new File(['x'], 'selected.txt')], target(draft), 'drop', captureComposer(f.runtime, draft).onFiles), false);
    await Promise.resolve();
    assert.equal(f.runtime.getSnapshot().length, 0);
    assert.equal(f.contexts[0].signal.aborted, true);
    assert.equal(draft.getSnapshot().blocks.length, 1, 'unrelated module retains its block');
    assert.equal(draft.getSnapshot().blocks[0].reason, 'Other module');
    assert.throws(() => captured!.draft.block('stale'), /cannot block/);
    releaseOther();
    assert.equal(await draft.send(async () => true), true);
    f.runtime.stop();
  }
});

test('late file-input rejection after revocation cannot recreate blockers', async () => {
  let reject!: (error: Error) => void;
  const f = fixture([asset()], withFiles((_selection, context) => {
        context.draft.block('Uploading');
        return new Promise<void>((_resolve, failure) => { reject = failure; }) as unknown as boolean;
  }));
  await f.runtime.start();
  const draft = createSessionDrafts()('late');
  f.runtime.receiveFiles([new File(['x'], 'file')], target(draft), 'drop', captureComposer(f.runtime, draft).onFiles);
  f.runtime.stop();
  reject(new Error('Stopped operation'));
  await Promise.resolve();
  assert.equal(draft.getSnapshot().blocks.length, 0);
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
  ]) {
    const f = fixture([asset()], frontend as unknown as ModuleFrontend);
    await f.runtime.start();
    assert.equal(f.runtime.getSnapshot().length, 0);
    assert.equal(f.reports.length, 1);
    f.runtime.stop();
  }
});

test('a pending submission rejects stale paste and drop handlers without invoking the file module', async () => {
  let received = 0;
  const f = fixture([asset()], withFiles((_selection, context) => { received++; context.draft.block('Upload'); return true; }));
  await f.runtime.start();
  const draft = createSessionDrafts()('pending-input');
  draft.edit('Sending');
  let finish!: (sent: boolean) => void;
  const sending = draft.send(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const onFiles = captureComposer(f.runtime, draft).onFiles;
  assert.equal(f.runtime.receiveFiles([new File(['x'], 'late.txt')], target(draft), 'paste', onFiles), false);
  assert.equal(received, 0);
  assert.equal(draft.getSnapshot().blocks.length, 0, 'core never manufactures file recovery work');
  finish(false);
  await sending;
  assert.equal(f.runtime.receiveFiles([new File(['x'], 'next.txt')], target(draft), 'drop', onFiles), true);
  assert.equal(received, 1);
  f.runtime.stop();
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
  for (const boundary of ['message', 'sessionStatus', 'composer', 'attachment', 'globalActions'] as const) {
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
      id, order: id === 'last' ? 2 : 0, boundary: 'globalActions',
      wrap: Base => {
        wraps.push(`${context.moduleId}:${id}`);
        return props => React.createElement(Base, props);
      },
    })),
  }));
  await f.runtime.start();
  const Base = () => React.createElement('button', null, 'Core');
  const first = f.runtime.compose('globalActions', Base);
  assert.deepEqual(wraps, ['z:last', 'a:last', 'z:first', 'a:first']);
  assert.equal(f.runtime.compose('globalActions', Base), first);
  f.runtime.updateView({ sessionId: 'new', visible: true, connected: true });
  assert.equal(f.runtime.compose('globalActions', Base), first);
  assert.equal(renderToStaticMarkup(React.createElement(first)), '<button>Core</button>', 'the complete middleware stack adds no DOM');
  assert.equal(wraps.length, 4);
  f.runtime.stop();
  assert.equal(f.runtime.compose('globalActions', Base), Base);
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
    assert.equal(notified, 0);
    assert.equal(disposed, 1);
    runtime.stop();
  }
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
        apiVersion: 2, components: failure === 'duplicate' ? [{ id: 'owned', boundary: 'globalActions', wrap: Base => Base }] : [],
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

test('file handoff is an explicit module acknowledgment, never host attachment-retention proof', async () => {
  for (const result of [false, true, undefined]) {
    const f = fixture([asset()], withFiles(() => result as boolean));
    await f.runtime.start();
    const draft = createSessionDrafts()('selection');
    draft.edit('Keep text');
    const props = captureComposer(f.runtime, draft);
    assert.equal(f.runtime.receiveFiles([new File(['one'], 'one.txt')], target(draft), 'drop', props.onFiles), result === true);
    assert.equal(draft.getSnapshot().blocks.length, 0);
    assert.equal(await draft.send(async request => {
      assert.deepEqual(request.body, { sessionId: 'selection', text: 'Keep text' });
      return true;
    }), true);
    f.runtime.stop();
  }
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
