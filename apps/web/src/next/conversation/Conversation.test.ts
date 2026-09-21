import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import * as React from 'react';
import { createElement as h, Fragment, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComposerInputProps, DraftSchemaHandle, ModuleFrontendContext } from '@cockpit/module-api';
import type { ChatMessage, ChatSession } from '../../net/types';
import { useCockpit } from '../../net/store';
import { ModuleRuntime } from '../../lib/moduleRuntime';
import { SessionDraft } from '../../lib/textDraft';
import { DisclosureContext } from '../../lib/disclosureChoice';
import { fixtureSchema, fixtureItem, appendFixture, type FixtureData } from '../../test/draftFixture';
import { ModuleRuntimeProvider } from '../modules';
import { Composer, ComposerInputBase, DraftNotices } from './Composer';
import { ConversationView, type ConversationViewProps } from './ConversationView';
import { Markdown, MessageContent } from './Markdown';
import { Transcript } from './Transcript';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalReact = Object.getOwnPropertyDescriptor(globalThis, 'React');
const initial = useCockpit.getInitialState();
const originalConnection = initial.connState;
const originalReady = initial.snapshotReady;
before(() => {
  // tsx uses its classic dependency transform for linked workspace TSX.
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { matchMedia: () => ({ matches: true }) } });
  initial.connState = 'open';
  initial.snapshotReady = true;
});
after(() => {
  initial.connState = originalConnection;
  initial.snapshotReady = originalReady;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  if (originalReact) Object.defineProperty(globalThis, 'React', originalReact);
  else Reflect.deleteProperty(globalThis, 'React');
});
const session = (patch: Partial<ChatSession> = {}): ChatSession => ({
  sessionId: 'next-fixture', title: 'Synthetic conversation', cwd: '/synthetic', lastActivity: 0,
  status: 'idle', loaded: true, error: null, queue: [], ask: null,
  messages: [], materialized: true, historyStale: false, hasMore: false, loadingHistory: false, ...patch,
});
const message = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role: 'assistant', content: 'Complete native text', timestamp: 1000, ...extra });
function render(patch: Partial<ChatSession> = {}, extra: Partial<ConversationViewProps> = {}) {
  return renderToStaticMarkup(h(ConversationView, {
    session: session(patch), moduleBootstrap: 'settled', onLoadMore: () => assert.fail('Rendering cannot load history'),
    onCancel: async () => assert.fail('Rendering cannot stop'),
    onInterrupt: async () => assert.fail('Rendering cannot interrupt'),
    ...extra,
  }));
}

test('module bootstrap does not hide native reading and exposes disabled input preparation', () => {
  const html = render({ messages: [message('visible')] }, { moduleBootstrap: 'loading' });
  assert.match(html, /Complete native text/);
  assert.match(html, /正在准备模块输入/);
  assert.match(html, /<textarea[^>]*disabled=""/);
  assert.equal((html.match(/class="next-messages chat-messages"/g) ?? []).length, 1);
  assert.match(html, /data-message-frame="visible"/);
  assert.match(html, /data-message-id="visible"/);
});

test('history failures retain readable messages, full errors and explicit recovery', () => {
  const html = render({ messages: [message('retained')], historyStale: true, historyError: 'Synthetic cursor expired',
    partialHistory: true, incompleteBoundary: true }, { onRetryHistory() {} });
  assert.match(html, /Complete native text/);
  assert.match(html, /Synthetic cursor expired/);
  assert.match(html, /重新读取历史/);
  assert.match(html, /临时片段可能不完整/);
  assert.match(html, /现有历史无法补齐/);
  assert.doesNotMatch(html, /opacity:0|visibility:hidden/);
});

test('queue text is complete and stop/interrupt retain distinct native semantics', () => {
  const text = `First line\n${'Long queued text '.repeat(100)}\nLast line`;
  const html = render({ status: 'running', queue: [{ id: 'q', text }] });
  assert.ok(html.includes(text));
  assert.match(html, /复制排队消息/);
  assert.match(html, /停止并清空队列/);
  assert.match(html, /打断并处理队列/);
  assert.doesNotMatch(render({ status: 'idle', queue: [{ id: 'q', text }] }), /停止并清空队列|打断并处理队列/);
  assert.doesNotMatch(render({ status: 'running', nativeProcessing: false, queue: [{ id: 'q', text }] }), /打断并处理队列/);
});

test('read-only views retain transcript but expose no editor, queue mutations or decisions', () => {
  const html = render({ status: 'running', messages: [message('readonly')], queue: [{ id: 'q', text: 'Queued' }],
    ask: { requestId: 'ask', question: 'Question', choices: ['Exact choice'] } }, { readOnly: true });
  assert.match(html, /Complete native text/);
  assert.match(html, /只读会话/);
  assert.doesNotMatch(html, /textarea|停止并清空队列|打断并处理队列|Exact choice|移除排队消息/);
});

test('native decisions display exact ask choices and only offered plan actions', () => {
  const ask = render({ ask: { requestId: 'ask', question: 'Literal question?', choices: ['A < B', 'Other exact choice'], allowFreeform: false } });
  assert.match(ask, /Literal question\?/);
  assert.match(ask, /A &lt; B/);
  assert.match(ask, /Other exact choice/);
  assert.match(ask, /请选择上方选项/);
  const plan = render({ planRequest: { requestId: 'plan', summary: 'Plan summary', planContent: 'Complete plan',
    actions: ['exit_only'] } });
  assert.match(plan, /Complete plan/);
  assert.match(plan, /仅退出计划/);
  assert.doesNotMatch(plan, /开始执行（交互）|并行执行（fleet）|自动执行/);
  assert.match(render({ planRequest: { requestId: 'plan', summary: 'No actions', actions: [] } }), /原生未提供可用的计划操作/);
});

test('production transcript preserves process grouping and manually opened full tool payloads', () => {
  const m = message('tool-row', { content: '', toolCalls: [{ toolCallId: 't', name: 'native_tool', title: 'Native tool',
    status: 'failed', args: '{"input":"full native arguments"}', output: 'Complete native failure output' }] });
  const values = new Map([[JSON.stringify(['scope', 'tool', 't']), true]]);
  const html = renderToStaticMarkup(h(DisclosureContext.Provider, { value: { values, set() {} } },
    h(Transcript, { scope: 'scope', messages: [m] })));
  assert.match(html, /1 次工具调用/);
  assert.match(html, /1 项失败/);
  assert.match(html, /full native arguments/);
  assert.match(html, /Complete native failure output/);
  assert.match(html, /复制工具输入/);
  assert.match(html, /复制工具输出/);
});

test('latest reasoning opens automatically but manual closure wins', () => {
  const thought = message('reason', { content: '', thought: '**Entire reasoning**\n\nNo truncation.', thoughtKey: 'reasoning-event' });
  const open = renderToStaticMarkup(h(Transcript, { scope: 'scope', messages: [thought] }));
  assert.match(open, /<strong>Entire reasoning<\/strong>/);
  const values = new Map([[JSON.stringify(['scope', 'thought', 'reasoning-event']), false]]);
  const closed = renderToStaticMarkup(h(DisclosureContext.Provider, { value: { values, set() {} } },
    h(Transcript, { scope: 'scope', messages: [thought] })));
  assert.doesNotMatch(closed, /Entire reasoning/);
});

test('subagents render shared nested messages with scoped anchors and evidence-only status', () => {
  const child = message('same-message', { content: 'Shared child body' });
  const parent = message('agent-row', { subtype: 'subagent', subagent: {
    toolCallId: 'invocation', name: 'child', displayName: 'Synthetic child', description: 'Child description', status: 'completed',
  }, subMessages: [child] });
  const values = new Map([[JSON.stringify(['scope', 'agent', 'invocation']), true]]);
  const html = renderToStaticMarkup(h(DisclosureContext.Provider, { value: { values, set() {} } },
    h(Transcript, { scope: 'scope', messages: [message('same-message'), parent] })));
  assert.match(html, /记录：本次执行已结束/);
  assert.match(html, /不代表当前仍在运行或任务目标已完成/);
  assert.match(html, /Shared child body/);
  assert.match(html, /data-child-history/);
  assert.match(html, /data-child-message-frame="same-message"/);
  assert.equal((html.match(/data-message-id="same-message"/g) ?? []).length, 1);
});

test('Markdown safely preserves native text, code and media without fetching inline resources', () => {
  const html = renderToStaticMarkup(h(Markdown, {
    body: '[Unsafe](javascript:alert%281%29)\n\n![remote](https://fixture.invalid/image.png)\n\n```txt\nfull code\n```',
  }));
  assert.doesNotMatch(html, /href="javascript:|<img|<script/);
  assert.match(html, /!\[remote\]\(https:\/\/fixture.invalid\/image.png\)/);
  assert.match(html, /full code/);
  assert.match(html, /复制代码/);
});

test('native input preserves ref/paste/drop and IME, desktop, mobile and modifier keyboard semantics', () => {
  let submitted = 0, pasted = 0, dropped = 0, cleaned = 0;
  const draft = new SessionDraft('keyboard');
  const ref = () => () => { cleaned++; };
  const base = ComposerInputBase({ draft: draft.reference, operation: 'prompt', editorRef: ref,
    value: '', onChange() {}, sendBlocked: false, disabled: false,
    onSubmit: () => { submitted++; }, onPaste: () => { pasted++; }, onDrop: () => { dropped++; },
  }) as ReactElement<ComposerInputProps & { ref: typeof ref }>;
  assert.equal(base.props.ref, ref);
  base.props.ref()();
  base.props.onPaste?.({} as never); base.props.onDrop?.({} as never);
  const key = (values: object) => {
    let prevented = false;
    base.props.onKeyDown?.({ key: 'Enter', nativeEvent: {}, preventDefault: () => { prevented = true; }, ...values } as never);
    return prevented;
  };
  assert.equal(key({ nativeEvent: { isComposing: true } }), false);
  assert.equal(key({ keyCode: 229 }), false);
  assert.equal(key({ shiftKey: true }), false);
  assert.equal(key({}), true);
  assert.equal(key({ ctrlKey: true }), true);
  Object.assign(window, { matchMedia: () => ({ matches: false }) });
  assert.equal(key({}), false);
  assert.equal(key({ metaKey: true }), true);
  Object.assign(window, { matchMedia: () => ({ matches: true }) });
  assert.equal(submitted, 3);
  assert.equal(pasted, 1); assert.equal(dropped, 1); assert.equal(cleaned, 1);
});

test('bare and middleware-wrapped inputs own a full row without private module selectors or a second autosizer', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.next-editor\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/);
  assert.match(css, /\.next-editor\s*>\s*\.next-textarea,\s*\.next-editor\s*>\s*:has\(\.next-textarea\)\s*\{[^}]*flex:\s*0 0 100%;[^}]*min-width:\s*0;[^}]*width:\s*100%;/);
  assert.match(css, /\.next-textarea\s*\{[^}]*min-width:\s*0;[^}]*max-height:\s*35dvh;/);
  assert.doesNotMatch(css, /\.csp-|\.cfn-|\border\s*:|flex-direction:\s*(?:row|column)-reverse/);
});

test('real module middleware composes around next message, attachment, composer, editor and input boundaries', async t => {
  const digest = 'a'.repeat(64);
  let context!: ModuleFrontendContext;
  let schema!: DraftSchemaHandle<FixtureData>;
  const runtime = new ModuleRuntime({
    pageUrl: 'https://fixture.invalid',
    fetch: async () => Response.json({ modules: [{ id: 'fixture', name: 'Fixture', version: '1.0.0', digest, styles: [], config: {},
      apiBase: `/_modules/fixture/${digest}/api`, entry: `/_modules/assets/fixture/${digest}/entry.js` }], errors: [] }),
    load: async () => ({ activate(value: ModuleFrontendContext) {
      context = value;
      schema = context.state.registerDraft(fixtureSchema());
      return { apiVersion: 2, components: [
        { id: 'composer', boundary: 'composer', wrap: Base => props => h(Base, { ...props, children: h(Fragment, null,
          props.children, h('span', null, 'Module draft list')) }) },
        { id: 'editor', boundary: 'composerEditor', wrap: Base => props => h(Base, { ...props, children: h(Fragment, null,
          props.children, h('button', { type: 'button' }, 'Module attachment action')) }) },
        { id: 'input', boundary: 'composerInput', wrap: Base => props => h(Fragment, null,
          h('div', { className: 'fixture-input-container', style: { display: 'flex', flex: '1 1 auto', minWidth: 0 } }, h(Base, props)), h('button', {
          disabled: props.disabled || props.sendBlocked, type: 'button',
        }, 'Module microphone')) },
        { id: 'message', boundary: 'message', wrap: Base => props => h(Base, { ...props, adornment: h('span', null, 'Message speech action') }) },
        { id: 'attachment', boundary: 'attachment', wrap: Base => props => h(Base, { ...props, actions: h('span', null, 'Attachment preview action') }) },
      ] };
    } }),
    report: assert.fail,
  });
  t.after(() => runtime.stop());
  await runtime.start();
  assert.ok(context);
  assert.equal(runtime.getSnapshot().length, 1);
  const draft = new SessionDraft('module-editor');
  draft.edit('Native text');
  runtime.prepareDraft(draft);
  appendFixture(schema.forDraft(draft.reference)!, fixtureItem('Fixture attachment'));
  const view = (loading = false) => renderToStaticMarkup(h(ModuleRuntimeProvider, { runtime, children:
    h(Composer, { draft, moduleBootstrap: loading ? 'loading' : 'settled', onSend: async () => true }) }));
  const html = view();
  assert.match(html, /Module draft list/);
  assert.match(html, /Module attachment action/);
  assert.match(html, /Module microphone/);
  assert.ok(html.indexOf('Module attachment action') < html.indexOf('<textarea'));
  assert.ok(html.indexOf('</textarea>') < html.indexOf('Module microphone'));
  assert.equal((html.match(/<textarea/g) ?? []).length, 1);
  assert.doesNotMatch(view(true), /Module draft list|Module attachment action|Module microphone/);
  for (const text of [
    '',
    'A synthetic persisted draft with enough text to wrap on a narrow phone screen. Preserve this content and its original ownership while the optional modules finish starting.',
    'Line one\nLine two\nLine three\nLine four\nLine five\nLine six\nLine seven',
  ]) {
    draft.edit(text);
    const snapshot = draft.getSnapshot();
    for (const loading of [true, false]) {
      const output = view(loading);
      assert.equal((output.match(/<textarea\b/g) ?? []).length, 1);
      assert.ok(output.includes(`>${text}</textarea>`), 'ready draft text remains visible throughout bootstrap');
      const input = output.match(/<textarea\b[^>]*>/)?.[0] ?? '';
      assert.match(input, /field-sizing-content/);
      assert.doesNotMatch(input, /style=/, 'host does not compete with CSS autosizing through inline heights');
      const send = output.match(/<button\b[^>]*aria-label="发送"[^>]*>/)?.[0] ?? '';
      assert.match(send, /data-size="lg"/);
      assert.match(send, /\bmin-h-10\b/, 'primary action owns the stable desktop row height even without modules');
      assert.match(send, /pointer-coarse:min-h-11/, 'touch targets retain the shared 44px minimum');
      if (loading) assert.match(input, /disabled=""/);
      else {
        assert.doesNotMatch(input, /disabled=""/);
        assert.ok(output.indexOf('Module attachment action') < output.indexOf('<textarea'));
        assert.ok(output.indexOf('</textarea>') < output.indexOf('Module microphone'));
        assert.ok(output.indexOf('Module microphone') < output.indexOf('aria-label="发送"'));
      }
      assert.strictEqual(draft.getSnapshot(), snapshot, 'presentation readiness must not edit or replace the draft');
    }
  }
  const body = renderToStaticMarkup(h(ModuleRuntimeProvider, { runtime, children: h(MessageContent, {
    message: message('origin', { origin: { sessionId: 'native', messageId: 'origin' },
      attachments: [{ type: 'file', path: '/synthetic/file.txt' }] }),
  }) }));
  assert.match(body, /Message speech action/);
  assert.match(body, /Attachment preview action/);
});

test('unclaimed stored data blocks next text sends and keeps explicit classic recovery outside input', () => {
  const stored = JSON.stringify({ text: 'Preserved draft', unconfirmed: false, fileAttachments: [{ id: 'legacy' }] });
  const draft = new SessionDraft('unknown', { getItem: () => stored, setItem: assert.fail, removeItem: assert.fail });
  const runtime = new ModuleRuntime({ report: assert.fail });
  runtime.prepareDraft(draft);
  const html = renderToStaticMarkup(h(ModuleRuntimeProvider, { runtime, children: h(Fragment, null,
    h(DraftNotices, { draft, moduleBootstrap: 'settled' }),
    h(Composer, { draft, moduleBootstrap: 'settled', onSend: async () => assert.fail('Unknown data must not send') })) }));
  assert.match(html, /未接管的模块数据/);
  assert.match(html, /href="\/session\/unknown">经典界面/);
  assert.match(html, /Preserved draft/);
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-label="发送"/);
  assert.ok(html.indexOf('未接管的模块数据') < html.indexOf('next-composer'));
});
