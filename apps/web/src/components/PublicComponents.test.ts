import { act, fireEvent, render, screen, userEvent } from '../test/dom';
import assert from '../test/identityAssert';
import { test } from 'node:test';
import { createElement as h, Fragment, useLayoutEffect } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type {
  ActivateFrontend, ActivateLegacyFrontend, DraftOwner, DraftSchemaHandle, LegacyModuleFrontendContext,
  ModuleFrontendContext, ModuleComponentMiddleware, MessageProps, DraftPurpose, ComposerProps,
} from '@cockpit/module-api/frontend';
import { ModuleRuntime } from '../lib/moduleRuntime';
import { SessionDraft, resolveDraft, type DraftStorage } from '../lib/textDraft';
import { fixtureSchema, memoryDraftStorage, type FixtureData } from '../test/draftFixture';
import { ModuleRuntimeProvider } from './ModuleComponents';
import { MessageContent } from './MessageContent';
import { Composer } from './Composer';
import { ComposerCard, ComposerSurface } from './ComposerSurface';
import { PendingDecisionCard } from './PendingDecision';
import { ManagementShell } from './ManagementShell';

const digest = 'c'.repeat(64);
type Definition = { frontendApiVersion: 3; activate: ActivateFrontend }
  | { frontendApiVersion?: undefined; activate: ActivateLegacyFrontend };
function fixture(definitions: Record<string, Definition>, options: { draftStorage?: DraftStorage } = {}) {
  const errors: unknown[] = [];
  let requests = 0;
  const runtime = new ModuleRuntime({
    ...options,
    pageUrl: 'https://fixture.invalid/',
    fetch: async () => {
      requests++;
      return Response.json({ errors: [], modules: Object.keys(definitions).map(id => ({
        id, name: id, version: '1.0.0', digest, styles: [], config: {},
        apiBase: `/_modules/${id}/${digest}/api`, entry: `/_modules/assets/${id}/${digest}/entry.js`,
      })) });
    },
    load: async url => definitions[new URL(url).pathname.split('/')[3]],
    report: error => errors.push(error),
  });
  return { runtime, errors, requests: () => requests };
}
function owner(context: ModuleFrontendContext, key = 'synthetic', purpose: DraftPurpose = { kind: 'prompt' }): DraftOwner {
  const text = (value: unknown) => {
    if (typeof value !== 'string') throw new Error('Expected text');
    return value;
  };
  return context.state.createDraft({
    key, purpose,
    facts: { editable: true, submittable: true, actionRevision: 0, capabilities: { attachments: false } },
    prepare: snapshot => snapshot.text, validateRequest: text, validateReceipt: text,
    send: async request => ({ status: 'accepted', receipt: request }),
    inspect: async request => ({ status: 'accepted', receipt: request }),
  });
}

test('runtime owner keys reuse compatible purposes, prepare staged scopes and suspend without retiring durable identity', async () => {
  const memory = memoryDraftStorage();
  let context!: ModuleFrontendContext, created!: DraftOwner, schema!: DraftSchemaHandle<FixtureData>;
  let factories = 0;
  const f = fixture({
    owner: { frontendApiVersion: 3, activate: (ctx: ModuleFrontendContext) => {
      context = ctx;
      schema = ctx.state.registerDraft(fixtureSchema({ create: () => { factories++; return { items: [] }; } }));
      const service = ctx.state.register({ id: 'owner-service', create: () => owner(ctx, 'durable'), dispose: () => {} });
      created = service.get();
      assert.ok(schema.forDraft(created.reference), 'staged scope exists before createDraft returns');
      return { apiVersion: 3 };
    } },
  }, { draftStorage: memory.storage });
  await f.runtime.start();
  assert.deepEqual(f.errors, []);
  assert.equal(resolveDraft(created.reference).supportsOwner(), true);
  assert.equal(owner(context, 'durable'), created);
  assert.throws(() => owner(context, 'durable', { kind: 'ask', requestId: 'one' }), /cannot change purpose/);
  const decision = owner(context, 'decision', { kind: 'ask', requestId: 'one' });
  assert.equal(owner(context, 'decision', { kind: 'ask', requestId: 'one' }), decision);
  assert.throws(() => owner(context, 'decision', { kind: 'ask', requestId: 'two' }), /cannot change purpose/);
  created.editText('retain on reload');
  const key = `cockpit:module-draft:${JSON.stringify(['owner', 'durable'])}`;
  const saved = memory.values.get(key)!;
  const old = created;
  f.runtime.stop();
  assert.equal(resolveDraft(old.reference).isRetired(), false);
  assert.throws(() => old.editText('revoked'), /stopped|retired/);
  assert.equal(memory.values.get(key), saved);
  await f.runtime.start();
  assert.notEqual(created, old);
  assert.equal(created.reference.getSnapshot().text, 'retain on reload');
  assert.equal(factories, 1, 'persistent schema restores instead of recreating on module reload');
  f.runtime.stop();
  assert.deepEqual(f.errors, []);
});

test('explicit v3 negotiation occurs before one activation; absent export remains isolated v2', async () => {
  let current!: ModuleFrontendContext, legacy!: LegacyModuleFrontendContext;
  let activations = 0;
  const f = fixture({
    modern: { frontendApiVersion: 3, activate: (context: ModuleFrontendContext) => {
      activations++; current = context; return { apiVersion: 3 };
    } },
    legacy: { activate: (context: LegacyModuleFrontendContext) => {
      activations++; legacy = context; return { apiVersion: 2 };
    } },
  });
  const before = f.runtime.components.get('message');
  assert.equal(f.requests(), 0);
  await f.runtime.start();
  assert.equal(activations, 2);
  assert.equal(current.apiVersion, 3);
  assert.equal(current.publicComponentsVersion, 1);
  assert.equal(current.draftOwnerVersion, 1);
  assert.equal(current.draftSubmissionVersion, 2);
  assert.equal(legacy.apiVersion, 2);
  assert.equal(legacy.draftSubmissionVersion, 1);
  assert.equal('components' in legacy, false);
  assert.equal('createDraft' in legacy.state, false);
  assert.equal(before, current.components.get('message'));
  assert.equal(before, current.components.get('message'));
  assert.notEqual(before, new ModuleRuntime().components.get('message'));
  f.runtime.stop();
  assert.equal(before, f.runtime.components.get('message'));
  assert.deepEqual(f.errors, []);
  for (const definition of [
    { frontendApiVersion: 3, activate: (() => ({ apiVersion: 2 })) as ActivateLegacyFrontend },
    { activate: (() => ({ apiVersion: 3 })) as ActivateFrontend },
  ]) {
    const mismatch = fixture({ mismatch: definition as unknown as Definition });
    await mismatch.runtime.start();
    assert.equal(mismatch.runtime.getSnapshot().length, 0);
    assert.match(String(mismatch.errors[0]), /API v[23] is required/);
    mismatch.runtime.stop();
  }
});

test('standalone public Composer owns the same single surface/card used by the native dock', async t => {
  let context!: ModuleFrontendContext, draft!: DraftOwner;
  const f = fixture({ modern: { frontendApiVersion: 3, activate: ctx => {
    context = ctx; draft = owner(ctx); return { apiVersion: 3 };
  } } });
  t.after(() => f.runtime.stop());
  await f.runtime.start();
  const PublicComposer = context.components.get('composer');
  const element = () => h(PublicComposer, {
    draft: draft.reference, operation: 'prompt', busy: false, disabled: false, sendBlocked: false,
    onTextChange: text => { draft.editText(text); }, onSubmit: () => {},
  });
  const mounted = render(element());
  const assertSurface = () => {
    assert.equal(document.querySelectorAll('.chat-input-area').length, 1);
    assert.equal(document.querySelectorAll('.chat-input-card').length, 1);
    assert.equal(document.querySelectorAll('.chat-input-card-body').length, 1);
    assert.ok(document.querySelector('.chat-input-area > .chat-input-card > .chat-input-card-body .chat-composer textarea'));
    assert.equal(document.querySelector('.chat'), null, 'public use requires no private Chat ancestor');
  };
  assertSurface();
  const standalone = mounted.container.innerHTML;
  mounted.rerender(h(ComposerSurface, null, h(ComposerCard, null, element())));
  assertSurface();
  assert.equal(mounted.container.innerHTML, standalone, 'host embedding and standalone consumption share the exact presentation');
});

test('generic composer recursively uses the public directory, preserving DOM refs, input and IME', async () => {
  let context!: ModuleFrontendContext, draft!: DraftOwner;
  let wraps = 0, legacyCalls = 0, legacyCreates = 0, legacy!: LegacyModuleFrontendContext;
  let legacySchema!: DraftSchemaHandle<FixtureData>;
  const seen = new Set<string>();
  const components: ModuleComponentMiddleware[] = [
    { id: 'composer', boundary: 'composer', wrap: Base => { wraps++; return props => {
      seen.add('composer'); return h(Base, { ...props, children: h('span', null, 'outer') });
    }; } },
    { id: 'editor', boundary: 'composerEditor', wrap: Base => { wraps++; return props => {
      seen.add('composerEditor'); return h(Base, { ...props, children: h('span', null, 'row') });
    }; } },
    { id: 'input', boundary: 'composerInput', wrap: Base => { wraps++; return props => {
      seen.add('composerInput'); return h(Base, props);
    }; } },
    { id: 'button', boundary: 'button', wrap: Base => { wraps++; return props => {
      seen.add('button'); return h(Base, props);
    }; } },
  ];
  const f = fixture({
    legacy: { activate: (ctx: LegacyModuleFrontendContext) => {
      legacy = ctx;
      legacySchema = ctx.state.registerDraft(fixtureSchema({ create: () => { legacyCreates++; return { items: [] }; } }));
      return { apiVersion: 2, components: [{ id: 'legacy', boundary: 'composer', wrap: Base => props => {
        legacyCalls++; return h(Base, props);
      } }] };
    } },
    modern: { frontendApiVersion: 3, activate: (ctx: ModuleFrontendContext) => {
      context = ctx; draft = owner(ctx); return { apiVersion: 3, writes: ['text'], sends: ['draft'], components };
    } },
  });
  await f.runtime.start();
  assert.deepEqual(f.errors, []);
  assert.equal(draft.reference.sessionId, undefined);
  assert.equal(legacyCreates, 0);
  assert.equal(legacySchema.forDraft(draft.reference), undefined);
  assert.throws(() => legacy.state.bindDraft(draft.reference), /native session draft/);
  draft.editText('ready');
  let submits = 0, refCalls = 0, cleanups = 0;
  const PublicComposer = context.components.get('composer');
  const editorRef = (node: HTMLTextAreaElement | null) => {
    if (node) refCalls++;
    return () => { cleanups++; };
  };
  const props = { draft: draft.reference, operation: 'prompt' as const, disabled: false, busy: false, sendBlocked: false,
    editorRef, onTextChange: draft.editText, onSubmit: () => { submits++; } };
  const beforeRender = wraps;
  const view = render(h(PublicComposer, props));
  const textarea = view.container.querySelector('textarea')!;
  const button = view.container.querySelector('button')!;
  assert.deepEqual([...seen], ['composer', 'composerEditor', 'composerInput', 'button']);
  assert.equal(legacyCalls, 0);
  assert.equal(refCalls, 1);
  assert.equal(textarea.value, 'ready');
  assert.equal(button.type, 'button');
  fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
  fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 });
  fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
  assert.equal(submits, 0);
  fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
  assert.equal(submits, 1);
  fireEvent.change(textarea, { target: { value: 'edited' } });
  assert.equal(draft.reference.getSnapshot().text, 'edited');
  view.rerender(h(PublicComposer, { ...props, busy: true }));
  assert.equal(view.container.querySelector('textarea'), textarea);
  assert.equal(refCalls, 1);
  assert.equal(wraps, beforeRender, 'render never creates middleware');
  const facts = { actionRevision: 0, capabilities: { attachments: false } };
  await act(() => draft.update({ ...facts, editable: false, submittable: false }));
  assert.equal(textarea.disabled, true);
  assert.equal(button.disabled, true);
  fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
  assert.equal(submits, 1);
  await act(() => draft.update({ ...facts, editable: true, submittable: false }));
  assert.equal(textarea.disabled, false, 'non-submittable owner can retain editable input');
  assert.equal(button.disabled, true);
  await act(() => draft.update({ ...facts, editable: true, submittable: true }));
  assert.equal(view.container.querySelector('textarea'), textarea);
  assert.equal(button.disabled, false);
  view.unmount();
  assert.equal(cleanups, 1, 'React 19 callback cleanup passes through');
  const native = new SessionDraft('legacy-native');
  const nativeProps = { ...props, draft: native.reference, editorRef: undefined };
  renderToStaticMarkup(h(PublicComposer, nativeProps));
  assert.equal(legacyCalls, 0);
  assert.equal(legacyCreates, 0, 'unprepared render does not invoke a schema factory');
  f.runtime.prepareDraft(native);
  assert.equal(legacyCreates, 1);
  renderToStaticMarkup(h(PublicComposer, nativeProps));
  assert.equal(legacyCalls, 1);
  const bound = context.state.bindDraft(draft.reference);
  const send = bound.captureSend();
  assert.deepEqual(await send.send(bound.getSnapshot().revision), { status: 'acknowledged' });
  assert.equal(draft.reference.getSnapshot().text, '');
  assert.equal(f.requests(), 1, 'generic module sends use the owner adapter, not native HTTP');
  f.runtime.stop();
  assert.throws(() => draft.editText('after stop'), /stopped|retired/);
  assert.deepEqual(f.errors, []);
});

test('legacy input enhancements retain the owner gate on empty drafts and while holding their own block', async () => {
  let inputBlocked: boolean | undefined;
  const f = fixture({
    speech: { activate: () => ({ apiVersion: 2, components: [
      { id: 'input', boundary: 'composerInput', wrap: Base => props => {
        inputBlocked = props.sendBlocked;
        return h(Base, props);
      } },
    ] }) },
  });
  await f.runtime.start();
  const draft = new SessionDraft('legacy-speech-gates');
  const view = render(h(Composer, { runtime: f.runtime, draft, onSend: async () => true }));
  assert.equal(inputBlocked, false, 'speech can start with no typed text');
  assert.equal(view.container.querySelector<HTMLButtonElement>('.send')!.disabled, true);
  act(() => draft.edit('start recording'));
  const binding = draft.bindModule('speech', ['text']);
  let release!: () => void;
  act(() => { release = binding.draft.block('Recording'); });
  assert.equal(inputBlocked, false, 'a recording lease does not interrupt its own enhancer');
  assert.equal(view.container.querySelector<HTMLButtonElement>('.send')!.disabled, true);
  act(() => release());
  assert.equal(view.container.querySelector<HTMLButtonElement>('.send')!.disabled, false);
  view.rerender(h(Composer, { runtime: f.runtime, draft, sendBlocked: true, onSend: async () => true }));
  assert.equal(inputBlocked, true, 'owner-level changes still reach input enhancements');
  view.unmount(); f.runtime.stop();
  assert.deepEqual(f.errors, []);
});

test('native controller rechecks owner facts without revoking inactive prompt service writes', async () => {
  let callbacks!: ComposerProps;
  const f = fixture({
    observer: { frontendApiVersion: 3, activate: () => ({ apiVersion: 3, components: [
      { id: 'composer', boundary: 'composer', wrap: Base => props => {
        callbacks = props;
        return h(Base, props);
      } },
    ] }) },
  });
  await f.runtime.start();
  const draft = new SessionDraft('native-facts');
  draft.edit('keep');
  let sent = 0;
  const view = render(h(Composer, { runtime: f.runtime, draft, onSend: async () => { sent++; return true; } }));
  const captured = callbacks;
  const facts = { actionRevision: 0, capabilities: { attachments: true } };
  act(() => draft.updateFacts({ ...facts, editable: false, submittable: false }));
  captured.onTextChange('blocked');
  captured.onSubmit();
  assert.equal(draft.getSnapshot().text, 'keep');
  assert.equal(sent, 0);
  assert.equal(callbacks.disabled, true);
  assert.equal(callbacks.sendBlocked, true);
  act(() => draft.updateFacts({ ...facts, editable: true, submittable: false }));
  assert.equal(view.container.querySelector('textarea')!.disabled, false);
  captured.onSubmit();
  assert.equal(sent, 0);
  act(() => draft.updateFacts({ ...facts, editable: true, submittable: true }));
  view.unmount();
  const service = draft.bindModule('inactive-native-service', ['text']);
  service.draft.editText('background edit');
  assert.equal(draft.getSnapshot().text, 'background edit');
  captured.onSubmit();
  assert.equal(sent, 0, 'captured presentation callback cannot submit after unmount');
  service.dispose();
  f.runtime.stop();
  assert.deepEqual(f.errors, []);
});

test('legacy message middleware receives real native identity only; public middleware sees unattributed content', async () => {
  const publicIdentities: MessageProps['identity'][] = [], legacyIds: string[] = [];
  const f = fixture({
    modern: { frontendApiVersion: 3, activate: () => ({ apiVersion: 3, components: [
      { id: 'modern-message', boundary: 'message', wrap: Base => props => {
        publicIdentities.push(props.identity); return h(Base, props);
      } },
    ] }) },
    legacy: { activate: () => ({ apiVersion: 2, components: [
      { id: 'legacy-message', boundary: 'message', wrap: Base => props => {
        legacyIds.push(props.identity.sessionId + '/' + props.identity.id);
        assert.equal('owner' in props.identity, false);
        return h(Base, { ...props, className: props.className + ' legacy-change' });
      } },
    ] }) },
  });
  await f.runtime.start();
  const renderMessage = (origin?: { sessionId: string; messageId: string }) => renderToStaticMarkup(
    h(ModuleRuntimeProvider, { runtime: f.runtime, children: h(MessageContent, { message: {
      id: 'presentation-id', role: 'assistant', content: 'text', origin, timestamp: 1,
    } }) }));
  assert.match(renderMessage({ sessionId: 'native-session', messageId: 'native-message' }), /legacy-change/);
  assert.doesNotMatch(renderMessage(), /legacy-change/);
  assert.deepEqual(legacyIds, ['native-session/native-message']);
  assert.deepEqual(publicIdentities.map(identity => identity.owner), ['native', 'presentation']);
  assert.deepEqual(publicIdentities.map(identity => identity.id), ['presentation-id', 'presentation-id']);
  const decision = { kind: 'ask' as const, request: { requestId: 'question', question: '**Only one** enhancement', allowFreeform: true } };
  renderToStaticMarkup(h(ModuleRuntimeProvider, { runtime: f.runtime, children: h(PendingDecisionCard, {
    sessionId: 'native-session', decisions: [decision], selected: decision, onSelect() {}, pending: false,
    disabled: { ask: false, plan: false, elicitation: false }, onChoice() {}, onPlan() {}, onElicitation() {},
  }) }));
  assert.equal(publicIdentities.length, 3, 'the Markdown body does not add a nested message enhancement');
  assert.deepEqual(publicIdentities[2], { owner: 'native', id: 'question', kind: 'ask' });
  assert.deepEqual(legacyIds, ['native-session/native-message', 'native-session/question']);
  f.runtime.stop();
});

test('public headers and buttons are standalone presentation with native props and no business context', () => {
  const runtime = new ModuleRuntime();
  const Header = runtime.components.get('managementHeader');
  const Detail = runtime.components.get('managementDetailHeader');
  const Button = runtime.components.get('button');
  let backs = 0, refreshes = 0, clicks = 0, cleanups = 0;
  const view = render(h(Fragment, null,
    h(Header, { section: 'mcp', item: null, onBack: () => { backs++; }, onRefresh: () => { refreshes++; } }),
    h(Detail, { item: 'synthetic', onBack: () => { backs++; } }),
    h(Button, { type: 'submit', name: 'action', value: 'confirm', form: 'synthetic-form',
      'aria-label': 'Public submit', onClick: () => { clicks++; },
      ref: node => { assert.ok(node); return () => { cleanups++; }; } }, 'Submit')));
  fireEvent.click(view.getByLabelText('返回会话列表'));
  fireEvent.click(view.getByLabelText('返回'));
  fireEvent.click(view.getByLabelText('刷新 Copilot MCP 配置缓存'));
  fireEvent.click(view.getByLabelText('Public submit'));
  assert.equal(backs, 2);
  assert.equal(refreshes, 1);
  assert.equal(clicks, 1);
  const button = view.getByLabelText('Public submit') as HTMLButtonElement;
  assert.equal(button.type, 'submit');
  assert.equal(button.name, 'action');
  assert.equal(button.value, 'confirm');
  assert.equal(button.getAttribute('form'), 'synthetic-form');
  view.unmount();
  assert.equal(cleanups, 1);
});

test('public management detail back navigates to its parent rather than the session list', async () => {
  render(h(MemoryRouter, { initialEntries: ['/skills/detail'], children: h(Routes, {
    children: [
      h(Route, { key: 'detail', path: '/skills/detail', element: h(ManagementShell, {
        section: 'skills', item: 'detail', master: null, detail: 'Detail',
      }) }),
      h(Route, { key: 'parent', path: '/skills', element: h('h1', null, 'Skill parent') }),
      h(Route, { key: 'root', path: '/', element: h('h1', null, 'Session list') }),
    ],
  }) }));
  await userEvent.setup().click(screen.getByRole('button', { name: '返回' }));
  assert.ok(screen.getByRole('heading', { name: 'Skill parent' }));
});

test('late registration on another boundary never reconstructs mounted input middleware', async () => {
  let release!: () => void, ready!: () => void, mounts = 0, wraps = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const activated = new Promise<void>(resolve => { ready = resolve; });
  const f = fixture({
    healthy: { frontendApiVersion: 3, activate: () => {
      ready();
      return { apiVersion: 3, components: [{ id: 'input', boundary: 'composerInput', wrap: Base => {
        wraps++;
        return function MountedInput(props) {
          useLayoutEffect(() => { mounts++; }, []);
          return h(Base, props);
        };
      } }] };
    } },
    late: { frontendApiVersion: 3, activate: async () => {
      await gate;
      return { apiVersion: 3, components: [{ id: 'message', boundary: 'message', wrap: Base => props => h(Base, props) }] };
    } },
  });
  const started = f.runtime.start();
  await activated;
  await act(async () => { await Promise.resolve(); });
  const draft = new SessionDraft('late-registration');
  const view = render(h(Composer, { runtime: f.runtime, draft, onSend: async () => true }));
  const textarea = view.container.querySelector('textarea');
  assert.equal(mounts, 1);
  assert.equal(wraps, 1);
  await act(async () => { release(); await started; });
  assert.equal(view.container.querySelector('textarea'), textarea);
  assert.equal(mounts, 1);
  assert.equal(wraps, 1);
  view.unmount();
  f.runtime.stop();
  assert.deepEqual(f.errors, []);
});

test('registration, unrelated removal and failure retain healthy component DOM and effects', async () => {
  let mounts = 0;
  const f = fixture({
    healthy: { frontendApiVersion: 3, activate: () => ({ apiVersion: 3, components: [
      { id: 'input', boundary: 'composerInput', wrap: Base => props => {
        useLayoutEffect(() => { mounts++; }, []);
        return h(Base, props);
      } },
    ] }) },
    other: { frontendApiVersion: 3, activate: () => ({ apiVersion: 3, components: [
      { id: 'message', boundary: 'message', wrap: Base => props => h(Base, props) },
    ] }) },
  });
  await f.runtime.start();
  const draft = new SessionDraft('stable');
  const view = render(h(ModuleRuntimeProvider, { runtime: f.runtime,
    children: h(Composer, { draft, onSend: async () => true }) }));
  const textarea = view.container.querySelector('textarea');
  assert.equal(mounts, 1);
  const other = f.runtime.getSnapshot().find(module => module.asset.id === 'other')!;
  act(() => f.runtime.fail(other, new Error('unrelated failure')));
  assert.equal(view.container.querySelector('textarea'), textarea);
  assert.equal(mounts, 1);
  const Message = f.runtime.components.get('message');
  view.rerender(h(Fragment, null, h(ModuleRuntimeProvider, { runtime: f.runtime,
    children: h(Composer, { draft, onSend: async () => true }) }),
  h(Message, { identity: { owner: 'synthetic', id: 'one', kind: 'message', role: 'assistant' }, complete: true }, 'plain')));
  assert.equal(view.container.querySelector('textarea'), textarea);
  view.unmount();
  f.runtime.stop();
});
