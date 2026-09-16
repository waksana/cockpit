import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as React from 'react';
import type { ComposerContext, ModuleAsset, ModuleFrontend, ModuleFrontendContext, RenderNode } from '@cockpit/module-api';
import { ModuleRuntime, validateModuleAsset } from './moduleRuntime';
import { createSessionDrafts } from './textDraft';

const digest = 'a'.repeat(64);
const asset = (id = 'fixture'): ModuleAsset => ({
  id, name: id, version: '1.0.0', digest, apiBase: `/_modules/${id}/${digest}/api`,
  entry: `/_modules/assets/${id}/${digest}/entry.js`, styles: [`/_modules/assets/${id}/${digest}/style.css`], config: { max: 20 },
});
function fixture(modules: unknown[] = [asset()], frontend: ModuleFrontend = {}) {
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
    load: async url => { imports.push(url); return { activate: (context: ModuleFrontendContext) => { contexts.push(context); return frontend; } }; },
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

test('bootstrap injects the actual React namespace and binds all requests to backend prefix, digest and credentials', async () => {
  const f = fixture();
  await f.runtime.start();
  assert.equal(f.runtime.getSnapshot().length, 1);
  assert.equal(f.contexts[0].react, React);
  assert.equal(f.contexts[0].apiVersion, 1);
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

test('scoped file contexts survive session switching and unmount; competing handlers choose one deterministically', async () => {
  const received: ComposerContext[] = [];
  const f = fixture([asset('z-last'), asset('a-first')], {
    writes: ['attachments'],
    fileInput: [{ id: 'files', accepts: files => files.length > 0, receive: (_files, context) => { received.push(context); } }],
  });
  await f.runtime.start();
  const drafts = createSessionDrafts();
  const a = drafts('A'), b = drafts('B');
  assert.equal(f.runtime.receive([new File(['fixture'], 'one.txt')], a, 'prompt', false), true);
  assert.equal(received.length, 1);
  const captured = received[0];
  f.runtime.context(f.runtime.getSnapshot()[0], b, 'prompt', false);
  captured.draft.appendAttachments([{ id: 'ready', value: { type: 'file', path: '/fixture/A' } }]);
  assert.equal(a.getSnapshot().attachments.length, 1);
  assert.equal(b.getSnapshot().attachments.length, 0);
  assert.ok(f.reports.some(error => String(error).includes('多个模块')));
  assert.equal(f.runtime.context(f.runtime.getSnapshot()[0], a, 'prompt', false).draft, captured.draft);
  captured.draft.block('Unfinished file');
  f.runtime.stop();
  assert.equal(a.getSnapshot().attachments.length, 1, 'ready native attachments survive teardown');
  assert.equal(a.getSnapshot().blocks[0].orphaned, true, 'unfinished choices require explicit removal');
  assert.throws(() => captured.draft.editText('stale'), /cannot write/);
});

test('unhandled or failed selected files leave a visible removable block, not a silent send', async () => {
  for (const frontend of [{}, {
    writes: ['attachments'],
    fileInput: [{ id: 'fail', accepts: () => true, receive: () => { throw new Error('Fixture failure'); } }],
  }] as ModuleFrontend[]) {
    const f = fixture([asset()], frontend);
    await f.runtime.start();
    const draft = createSessionDrafts()('failed-file');
    draft.edit('Keep text');
    assert.equal(f.runtime.receive([new File(['x'], 'selected.txt')], draft, 'prompt', false), false);
    assert.equal(draft.getSnapshot().blocks.length, 1);
    assert.match(draft.getSnapshot().blocks[0].reason, /selected.txt/);
    assert.equal(await draft.send(async () => assert.fail('blocked')), false);
    draft.dismissOrphanedBlock(draft.getSnapshot().blocks[0].id);
    assert.equal(await draft.send(async () => true), true);
    f.runtime.stop();
  }
});

test('renderer selection never fetches and a throwing matcher falls back to the next local renderer', async () => {
  const Component = () => null;
  const f = fixture([asset()], { chatRenderers: [
    { id: 'broken', matches: () => { throw new Error('Bad matcher'); }, component: Component },
    { id: 'file', matches: node => node.target?.startsWith('/fixture/') ?? false, component: Component },
  ] });
  await f.runtime.start();
  const node: RenderNode = { kind: 'link', origin: { sessionId: 'root', messageId: 'native' }, target: '/fixture/file', label: 'File' };
  assert.equal(f.runtime.renderer(node)?.renderer.id, 'file');
  assert.equal(f.runtime.renderer({ ...node, target: 'https://example.invalid' }), undefined);
  assert.equal(f.requests.length, 1);
  assert.equal(f.reports.length, 1, 'repeat render errors are deduplicated');
  f.runtime.stop();
});

test('file-input exceptions revoke original blocks and leave only explicitly dismissible module notices', async () => {
  for (const asynchronous of [false, true]) {
    let captured: ComposerContext | undefined;
    const f = fixture([asset()], {
      writes: ['attachments'],
      fileInput: [{
        id: 'fail-after-block', accepts: () => true,
        receive: (_files, context) => {
          captured = context;
          context.draft.block('Original upload');
          context.draft.appendAttachments([{ id: 'ready', value: { type: 'file', path: '/fixture/ready' } }]);
          if (asynchronous) return Promise.reject(new Error('Async upload handler failed'));
          throw new Error('Sync upload handler failed');
        },
      }],
    });
    await f.runtime.start();
    const draft = createSessionDrafts()('failed-file');
    const releaseOther = draft.bindModule('other', ['attachments']).draft.block('Other module');
    assert.equal(f.runtime.receive([new File(['x'], 'selected.txt')], draft, 'prompt', false), asynchronous);
    await Promise.resolve();
    assert.equal(f.runtime.getSnapshot().length, 0);
    assert.equal(f.contexts[0].signal.aborted, true);
    assert.equal(draft.getSnapshot().blocks.filter(block => block.orphaned).length, 2);
    for (const block of draft.getSnapshot().blocks) draft.dismissOrphanedBlock(block.id);
    assert.equal(draft.getSnapshot().blocks.length, 1, 'unrelated module retains its block');
    assert.throws(() => captured!.draft.appendAttachments([]), /cannot write/);
    assert.equal(draft.getSnapshot().attachments.length, 1);
    releaseOther();
    assert.equal(await draft.send(async () => true), true);
    f.runtime.stop();
  }
});

test('late file-input rejection after revocation cannot recreate dismissed blockers', async () => {
  let reject!: (error: Error) => void;
  const f = fixture([asset()], {
    writes: ['attachments'],
    fileInput: [{
      id: 'late', accepts: () => true, receive: (_files, context) => {
        context.draft.block('Uploading');
        return new Promise<void>((_resolve, failure) => { reject = failure; });
      },
    }],
  });
  await f.runtime.start();
  const draft = createSessionDrafts()('late');
  f.runtime.receive([new File(['x'], 'file')], draft, 'prompt', false);
  f.runtime.stop();
  for (const block of draft.getSnapshot().blocks) draft.dismissOrphanedBlock(block.id);
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
  const f = fixture([asset()], { globalPages: [], dispose: () => { disposed++; } } as unknown as ModuleFrontend);
  await f.runtime.start();
  assert.deepEqual(f.runtime.getSnapshot(), []);
  assert.match(String(f.reports[0]), /Unsupported module contribution/);
  assert.equal(disposed, 1);
  f.runtime.stop();
  assert.equal(disposed, 1);
});

test('draft attachment rendering is an explicit declaration backed by a component', async () => {
  for (const frontend of [
    { rendersDraftAttachments: 'yes' },
    { rendersDraftAttachments: true },
    { rendersDraftAttachments: true, composerAbove: [] },
  ]) {
    const f = fixture([asset()], frontend as unknown as ModuleFrontend);
    await f.runtime.start();
    assert.equal(f.runtime.getSnapshot().length, 0);
    assert.equal(f.reports.length, 1);
    f.runtime.stop();
  }
  const f = fixture([asset()], {
    rendersDraftAttachments: true, composerAbove: [{ id: 'attachments', component: () => null }],
  });
  await f.runtime.start();
  assert.equal(f.runtime.getSnapshot()[0].frontend.rendersDraftAttachments, true);
  f.runtime.stop();
});

test('a pending submission rejects stale paste and drop handlers without invoking the file module', async () => {
  let received = 0;
  const f = fixture([asset()], {
    fileInput: [{ id: 'files', accepts: () => true, receive: () => { received++; } }],
  });
  await f.runtime.start();
  const draft = createSessionDrafts()('pending-input');
  draft.edit('Sending');
  let finish!: (sent: boolean) => void;
  const sending = draft.send(() => new Promise<boolean>(resolve => { finish = resolve; }));
  assert.equal(f.runtime.receive([new File(['x'], 'late.txt')], draft, 'prompt', false), false);
  assert.equal(received, 0);
  assert.equal(draft.getSnapshot().blocks.length, 0);
  finish(false);
  await sending;
  assert.equal(f.runtime.receive([new File(['x'], 'next.txt')], draft, 'prompt', false), true);
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
      ? new Promise<ModuleFrontend>(resolve => { finish = resolve; }) : {} }),
    style: () => () => {}, report: error => { reports.push(error); },
  });
  await runtime.start();
  assert.deepEqual(runtime.getSnapshot().map(module => module.asset.id), ['good']);
  assert.match(String(reports[0]), /activation timed out/);
  finish({ dispose: () => { disposed++; } });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(disposed, 1);
  assert.deepEqual(runtime.getSnapshot().map(module => module.asset.id), ['good']);
  runtime.stop();
});

test('conflicting renderers report their conflict and preserve default content', async () => {
  const f = fixture([asset('first'), asset('second')], {
    chatRenderers: [{ id: 'same-node', matches: () => true, component: () => null }],
  });
  await f.runtime.start();
  assert.equal(f.runtime.renderer({ kind: 'image', label: 'image', target: './a.png',
    origin: { sessionId: 'session', messageId: 'message' } }), undefined);
  assert.match(String(f.reports[0]), /多个模块渲染规则/);
  f.runtime.stop();
});
