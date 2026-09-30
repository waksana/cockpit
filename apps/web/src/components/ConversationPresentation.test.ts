import { act, fireEvent, render, screen } from '../test/dom';
import assert from '../test/identityAssert';
import { test } from 'node:test';
import { createElement as h, Fragment, type ComponentType } from 'react';
import type { ChatMessage } from '@cockpit/protocol';
import type {
  ChatMessageProps, ModuleFrontend, ModuleFrontendContext, ModuleComponentMiddleware, ModuleComponentProps, MessageProps,
} from '@cockpit/module-api/frontend';
import { compile } from 'sass';
import { ModuleRuntime } from '../lib/moduleRuntime';
import { ModuleRuntimeProvider, MessageList } from './ModuleComponents';
import { TranscriptMessages } from './Transcript';
import { Thread } from './Thread';
import { ChatHeader } from './ChatHeader';
import { fixtureSession } from '../dev/chat-fixtures';
import { SessionDraft } from '../lib/textDraft';

const today = new Date(2026, 8, 29).getTime();
const body = '# Conversation\n\nA **bold** reply with [a link](https://example.invalid).\n\n- first\n- second\n\n| A | B |\n| - | - |\n| one | two |\n\n```ts\nconst value = 1;\n```';
function fixture(frontend: ModuleFrontend | ((context: ModuleFrontendContext) => ModuleFrontend) = { apiVersion: 3 }) {
  const errors: unknown[] = [];
  const digest = 'a'.repeat(64);
  const runtime = new ModuleRuntime({
    pageUrl: 'https://fixture.invalid/',
    fetch: async () => Response.json({ errors: [], modules: [{
      id: 'fixture', name: 'Fixture', version: '1.0.0', digest, config: {}, styles: [],
      apiBase: `/_modules/fixture/${digest}/api`, entry: `/_modules/assets/fixture/${digest}/index.js`,
    }] }),
    load: async () => ({ frontendApiVersion: 3, activate: (context: ModuleFrontendContext) =>
      typeof frontend === 'function' ? frontend(context) : frontend }),
    report: error => errors.push(error),
  });
  return { runtime, errors };
}

function props(message: ChatMessage, previous?: ChatMessage): ChatMessageProps {
  return {
    identity: { owner: 'example', id: message.id, kind: 'message', role: message.role },
    role: message.role === 'user' ? 'user' : 'assistant', timestamp: message.timestamp, today,
    body: message.content, attachments: message.attachments, complete: !message.streaming,
    ...(previous ? { previous: { role: previous.role === 'user' ? 'user' : 'assistant', timestamp: previous.timestamp } } : {}),
  };
}

test('native and public messages use the same full row, Markdown, attachments, timestamp and gaps without double shells', async t => {
  const bodies: MessageProps[] = [];
  const rows: ChatMessageProps[] = [];
  const f = fixture(context => {
    assert.equal(context.messagePresentationVersion, 1);
    return { apiVersion: 3, components: [
      { id: 'body', boundary: 'message', wrap: Base => value => { bodies.push(value); return h(Base, value); } },
      { id: 'row', boundary: 'chatMessage', wrap: Base => value => { rows.push(value); return h(Base, value); } },
    ] };
  });
  t.after(() => f.runtime.stop());
  await f.runtime.start();
  const messages: ChatMessage[] = [
    { id: 'user', role: 'user', timestamp: today + 1000, content: 'A **question**',
      attachments: [{ type: 'file', path: '/fixture/report.txt', displayName: 'Report' }] },
    { id: 'assistant', role: 'assistant', timestamp: today + 2000, content: body },
    { id: 'continuation', role: 'assistant', timestamp: today + 3000, content: 'Another paragraph.' },
    { id: 'only-file', role: 'user', timestamp: today + 4000, content: '',
      attachments: [{ type: 'file', path: '/fixture/image.png' }] },
  ];
  const List = f.runtime.components.get('messageList'), Row = f.runtime.components.get('chatMessage');
  const view = render(h(ModuleRuntimeProvider, { runtime: f.runtime, children: h(Fragment, null,
    h('div', { 'data-side': 'native' }, h(MessageList, { children: h(TranscriptMessages, { messages, sessionId: 'synthetic', today }) })),
    h('div', { 'data-side': 'public' }, h(List, { children: messages.map((message, index) =>
      h(Row, { key: message.id, ...props(message, messages[index - 1]) })) })),
  ) }));
  const native = view.container.querySelector('[data-side="native"]')!;
  const standalone = view.container.querySelector('[data-side="public"]')!;
  assert.equal(standalone.querySelector('.chat'), null, 'no consumer-owned private Chat ancestor');
  for (const side of [native, standalone]) {
    assert.equal(side.querySelectorAll('.msg-group').length, messages.length);
    assert.equal(side.querySelectorAll('.user-message').length, 2);
    assert.equal(side.querySelectorAll('article.message.is-doc').length, 2);
    assert.equal(side.querySelectorAll('.message-body').length, 3);
    assert.equal(side.querySelectorAll('.doc-byline').length, 1, 'assistant continuation does not repeat a byline');
  }
  const normal = (element: Element) => element.innerHTML.replace(/ data-message-id="[^"]*"/g, '');
  const nativeRows = native.querySelectorAll('.msg-group');
  const publicRows = standalone.querySelectorAll('.msg-group');
  for (let index = 0; index < messages.length; index++) {
    assert.equal(normal(publicRows[index]), normal(nativeRows[index]));
    assert.equal(publicRows[index].getAttribute('data-gap'), nativeRows[index].getAttribute('data-gap'));
  }
  assert.equal(rows.length, messages.length * 2, 'native and modules both use the new public row entry');
  assert.equal(bodies.length, messages.length * 2, 'old body middleware runs exactly once per visible message');
  assert.deepEqual(bodies.slice(messages.length).map(value => value.identity.owner), messages.map(() => 'example'));
  assert.ok(standalone.querySelector('.chat-code-head'));
  assert.ok(standalone.querySelector('.chat-table-scroll table'));
  assert.deepEqual(f.errors, []);
});

test('public message viewport exposes the actual scroll/content refs and row/body refs release on unmount', async t => {
  const f = fixture();
  t.after(() => f.runtime.stop());
  await f.runtime.start();
  const List = f.runtime.components.get('messageList'), Row = f.runtime.components.get('chatMessage');
  const refs: Record<string, HTMLElement | null> = {};
  let scrolls = 0, choices = 0;
  const value: ChatMessage = { id: 'one', role: 'assistant', timestamp: today, content: 'A question?' };
  const view = render(h(List, {
    viewportRef: node => { refs.viewport = node; }, contentRef: node => { refs.content = node; },
    onScroll: () => { scrolls++; }, before: h('button', null, 'Earlier'),
    children: h(Row, { ...props(value), 'data-example-id': 'one',
      rowRef: node => { refs.row = node; }, bodyRef: node => { refs.body = node; },
      children: h('button', { onClick: () => { choices++; } }, 'Yes') }),
  }));
  assert.ok(refs.viewport?.classList.contains('chat-messages'));
  assert.ok(refs.content?.classList.contains('chat-message-content'));
  assert.ok(refs.row?.classList.contains('msg-group'));
  assert.ok(refs.body?.classList.contains('message-body'));
  assert.equal(refs.row?.dataset.exampleId, 'one');
  fireEvent.scroll(refs.viewport!);
  fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
  assert.equal(scrolls, 1);
  assert.equal(choices, 1);
  view.unmount();
  assert.deepEqual(refs, { viewport: null, content: null, row: null, body: null });
});

test('full message preserves real origin for Markdown/attachment enhancement without inventing native provenance', async t => {
  const observed: unknown[] = [];
  const f = fixture({ apiVersion: 3, components: [{
    id: 'attachments', boundary: 'attachment', wrap: Base => value => {
      observed.push(value.origin); return h(Base, value);
    },
  }], markdown: [{ id: 'links', matches: node => node.target === '/fixture/native.txt',
    component: () => h('span', null, 'Module link') }] });
  t.after(() => f.runtime.stop());
  await f.runtime.start();
  const Row = f.runtime.components.get('chatMessage');
  const message: ChatMessage = { id: 'one', role: 'user', timestamp: today,
    content: '[Attachment](/fixture/native.txt)', attachments: [{ type: 'file', path: '/fixture/native.txt' }] };
  const view = render(h(Row, props(message)));
  assert.equal(screen.queryByText('Module link'), null);
  assert.deepEqual(observed, [undefined]);
  const origin = { sessionId: 'native-session', messageId: 'native-message' };
  view.rerender(h(Row, { ...props(message), origin }));
  assert.ok(screen.getByText('Module link'));
  assert.deepEqual(observed, [undefined, origin]);
});

test('native Chat and public consumers share frame/header/transcript and exactly one composer dock/card', async t => {
  const seen = new Set<string>();
  const boundaries = ['conversationFrame', 'conversationHeader', 'conversationTranscript', 'composer', 'messageList'] as const;
  const f = fixture({ apiVersion: 3, components: boundaries.map(boundary => ({
    id: boundary, boundary, wrap: (Base: ComponentType<ModuleComponentProps[typeof boundary]>) =>
      (value: ModuleComponentProps[typeof boundary]) => { seen.add(boundary); return h(Base, value); },
  })) as ModuleComponentMiddleware[] });
  t.after(() => f.runtime.stop());
  await f.runtime.start();
  const session = { ...fixtureSession('reading'), messages: [], error: 'Synthetic error' };
  const native = render(h(ModuleRuntimeProvider, { runtime: f.runtime, children: h(Fragment, null,
    h(ChatHeader, { title: 'Native', modelLabel: '', moreRef: { current: null }, moreOpen: false,
      onBack: () => {}, onInfo: () => {}, onMore: () => {} }),
    h(Thread, { session, onLoadMore: () => {} }),
  ) }));
  for (const name of boundaries) assert.ok(seen.has(name), `Native Chat uses ${name}`);
  assert.equal(native.container.querySelectorAll('.chat-input-area').length, 1);
  assert.equal(native.container.querySelectorAll('.chat-input-card').length, 1);
  assert.equal(native.container.querySelectorAll('.chat-input-notices').length, 1);
  assert.ok(native.container.querySelector('.chat-input-notices [role="alert"]'));
  native.unmount();
  const Frame = f.runtime.components.get('conversationFrame'), Header = f.runtime.components.get('conversationHeader');
  const Transcript = f.runtime.components.get('conversationTranscript'), Composer = f.runtime.components.get('composer');
  const draft = new SessionDraft('public-frame');
  let follows = 0;
  const publicView = render(h(Frame, {
    header: h(Header, { title: h('h1', null, 'Module'), actions: h('button', null, 'Setup') }),
    notices: h('p', { role: 'alert' }, 'Unknown send, retained'),
    composer: h(Composer, { draft: draft.reference, operation: 'prompt', disabled: false, busy: false,
      sendBlocked: false, onTextChange: text => draft.edit(text), onSubmit: () => {} }),
    children: h(Transcript, { awayFromBottom: true, hasNewContent: true, onFollow: () => { follows++; },
      children: h('p', null, 'A normal question and ordinary options') }),
  }));
  assert.equal(publicView.container.querySelectorAll('.chat-input-area').length, 1);
  assert.equal(publicView.container.querySelectorAll('.chat-input-card').length, 1);
  assert.ok(publicView.container.querySelector('.chat-input-notices [role="alert"]'));
  assert.equal(publicView.container.querySelectorAll('.chat-decision-card').length, 0);
  fireEvent.click(screen.getByRole('button', { name: '有新内容 · 回到最新' }));
  assert.equal(follows, 1);
  assert.deepEqual(f.errors, []);
});

test('optional reply headings are inside the shared row after its date separator, not an extra message', async t => {
  const f = fixture();
  t.after(() => f.runtime.stop());
  await f.runtime.start();
  const Row = f.runtime.components.get('chatMessage');
  const view = render(h(Row, { ...props({ id: 'reply', role: 'assistant', timestamp: today, content: 'Original reply' }),
    header: h('h3', null, 'Stable topic') }));
  assert.equal(view.container.querySelectorAll('.msg-group').length, 1);
  assert.equal(view.container.querySelector('.message.is-doc')?.firstElementChild?.tagName, 'H3');
  assert.equal(view.container.querySelector('.msg-group')?.firstElementChild?.className, 'date-separator');
  assert.ok(view.container.querySelector('[data-message-frame] [data-message-id]'), 'public rows have shared reading anchors');
});

for (const boundary of ['chatMessage', 'messageList', 'conversationFrame', 'conversationHeader', 'conversationTranscript'] as const) {
  test(`${boundary} middleware failure preserves shared Base and revokes only its module`, async t => {
    t.mock.method(console, 'error', () => {});
    const registration = { id: 'fault', boundary, wrap: () => () => { throw new Error('Fixture failure'); } } as ModuleComponentMiddleware;
    const f = fixture({ apiVersion: 3, components: [registration] });
    t.after(() => f.runtime.stop());
    await f.runtime.start();
    const List = f.runtime.components.get('conversationTranscript'), Row = f.runtime.components.get('chatMessage');
    const Frame = f.runtime.components.get('conversationFrame'), Header = f.runtime.components.get('conversationHeader');
    render(h(Frame, { composer: null, header: h(Header, { title: 'Still a header' }),
      children: h(List, { awayFromBottom: false, hasNewContent: false, onFollow: () => {},
        children: h(Row, props({ id: 'one', role: 'user', timestamp: today, content: 'Still readable' })) }) }));
    await act(async () => {});
    assert.ok(screen.getByText('Still readable'));
    assert.equal(f.runtime.getSnapshot().length, 0);
    assert.equal(f.errors.length, 1);
    assert.equal(document.querySelectorAll('.user-message').length, 1);
  });
}

test('public message surfaces share native reading typography, palette, width and gaps without adding row spacing', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.match(css, /\.chat-messages, \.chat-conversation-message \{[^}]*--chat-text-body: var\(--messages-text-size\)/);
  assert.match(css, /\.chat-messages, \.chat-conversation-message \{[^}]*--chat-gutter: clamp\(1rem, 4vw, 1\.5rem\)/);
  assert.doesNotMatch(css, /\.chat-messages, \.chat-conversation-message \{[^}]*row-gap:/);
  assert.match(css, /\.chat-message-content \{[^}]*max-width: var\(--chat-reading-width\)/);
  assert.match(css, /\.msg-group\[data-gap=speaker\] \{[^}]*padding-block-start: var\(--chat-gap-speaker\)/);
});
