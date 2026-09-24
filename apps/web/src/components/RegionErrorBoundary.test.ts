import { act, render, screen, userEvent, waitFor, within, type RenderResult } from '../test/dom';
import assert from '../test/identityAssert';
import { beforeEach, test, type TestContext } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { dismissUxError, getUxErrors } from '../lib/errorReporter';
import { useCockpit } from '../net/store';
import type { ChatMessage, ChatSession } from '../net/types';
import { fixtureSession } from '../dev/chat-fixtures';
import { RegionErrorBoundary } from './ErrorBoundary';
import { Sidebar } from './Sidebar';
import { Thread } from './Thread';
import { SessionDetails } from './SessionDetails';

let diagnostics: string[] = [];
beforeEach(context => {
  const t = context as TestContext;
  diagnostics = [];
  // React's own caught-error log and our local record both go to console.error.
  t.mock.method(console, 'error', (...args: unknown[]) => {
    if (args[0] === '[cockpit] local error (shown in place):') diagnostics.push(String(args[1]));
  });
  for (const error of getUxErrors()) dismissUxError(error.id);
});

function mount(t: TestContext) {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Region boundary fixtures must not access a backend'));
  const state = useCockpit.getState();
  useCockpit.setState({ connState: 'open', snapshotReady: true });
  t.after(() => { useCockpit.setState(state, true); });
  const user = userEvent.setup();
  let view: RenderResult | undefined;
  return {
    get container() { return view!.container; },
    render: async (children: ReactNode) => {
      if (view) view.rerender(children);
      else view = render(children);
      await act(async () => {});
    },
    click: (node: Element) => user.click(node),
  };
}

const fallbacks = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>('[data-region-error]'));
const retry = (fallback: HTMLElement) => within(fallback).getByRole('button', { name: '重试' });

test('a crashing region shows its own failed result while siblings stay usable', async t => {
  const h = mount(t);
  let broken = true;
  let clicks = 0;
  function Fragile(): ReactNode {
    if (broken) throw new Error('Synthetic region failure');
    return createElement('p', { className: 'fragile' }, 'recovered');
  }
  await h.render(createElement('div', null,
    createElement(RegionErrorBoundary, { label: '这块内容', children: createElement(Fragile) }),
    createElement('button', { type: 'button', className: 'sibling', onClick: () => { clicks++; } }, 'sibling')));
  const [fallback] = fallbacks(h.container);
  assert.equal(fallback.getAttribute('data-region-error'), '这块内容');
  assert.equal(within(fallback).getByRole('alert').textContent, '显示这块内容失败，其余界面不受影响。');
  assert.ok(within(fallback).getByText('详情'));
  await h.click(screen.getByRole('button', { name: 'sibling' }));
  assert.equal(clicks, 1);
  // Owned in place: a local console record, no global notice.
  assert.equal(getUxErrors().length, 0);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /^这块内容渲染失败：Synthetic region failure/);

  await h.click(retry(fallback));
  assert.equal(fallbacks(h.container).length, 1, 'a persisting cause stays local after retry');
  assert.equal(diagnostics.length, 1, 'an identical repeated failure is recorded once');
  broken = false;
  await h.click(retry(fallbacks(h.container)[0]));
  assert.equal(fallbacks(h.container).length, 0);
  assert.ok(screen.getByText('recovered'));
  assert.equal(getUxErrors().length, 0);
});

test('new region input retries automatically; an unchanged key keeps the fallback', async t => {
  const h = mount(t);
  const Value = ({ value }: { value: string }): ReactNode => {
    if (value === 'bad') throw new Error('Bad value');
    return createElement('span', { className: 'value' }, value);
  };
  const render = (value: string) => h.render(createElement(RegionErrorBoundary, {
    label: '值', resetKey: value, children: createElement(Value, { value }),
  }));
  await render('bad');
  assert.equal(fallbacks(h.container).length, 1);
  await render('bad');
  assert.equal(fallbacks(h.container).length, 1);
  await render('good');
  assert.equal(fallbacks(h.container).length, 0);
  assert.ok(screen.getByText('good'));
});

const brokenMessage = (id: string): ChatMessage => ({
  id, role: 'user', content: 'malformed attachment', timestamp: Date.now(),
  attachments: [null] as unknown as ChatMessage['attachments'],
});

test('one malformed message is isolated in the transcript; others and the composer keep working', async t => {
  const h = mount(t);
  const base = fixtureSession('reading');
  const session: ChatSession = { ...base, messages: [...base.messages.slice(0, 2), brokenMessage('broken'), ...base.messages.slice(2)] };
  useCockpit.setState({ sessions: [session] });
  await h.render(createElement(MemoryRouter, null, createElement(Thread, { session, onLoadMore: () => {} })));
  const failed = fallbacks(h.container);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].getAttribute('data-region-error'), '这条消息');
  assert.ok(failed[0].closest('[data-message-frame="broken"]'), 'the fallback keeps the message frame for scroll anchoring');
  const others = Array.from(h.container.querySelectorAll('[data-message-frame]')).filter(frame => !frame.querySelector('[data-region-error]'));
  assert.ok(others.length >= 2 && others.every(frame => frame.textContent?.trim()), 'other messages still render');
  assert.ok(h.container.querySelector('.chat-input-card'), 'the composer is still mounted');
  assert.equal(getUxErrors().length, 0);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /^这条消息渲染失败：Cannot use 'in' operator/);

  // A repaired native message is new input for that row and recovers without a reload.
  const repaired = { ...session, messages: session.messages.map(m => m.id === 'broken' ? { ...m, attachments: [] } : m) };
  await h.render(createElement(MemoryRouter, null, createElement(Thread, { session: repaired, onLoadMore: () => {} })));
  assert.equal(fallbacks(h.container).length, 0);
  assert.match(h.container.querySelector('[data-message-frame="broken"]')?.textContent ?? '', /malformed attachment/);
});

test('one malformed session row is isolated; other rows remain selectable', async t => {
  const h = mount(t);
  const base = fixtureSession('reading');
  const good: ChatSession = { ...base, sessionId: 'good', title: 'Good session', messages: [] };
  const bad = { ...base, sessionId: 'bad', title: 'Bad session', messages: [], roles: [null] } as unknown as ChatSession;
  const selected: string[] = [];
  await h.render(createElement(MemoryRouter, null, createElement(Sidebar, {
    sessions: [bad, good], activeId: null, query: '', snapshotReady: true, connected: true,
    onSelect: id => { selected.push(id); }, getMenuItems: () => [],
  })));
  const failed = fallbacks(h.container);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].getAttribute('data-region-error'), '这条会话');
  assert.equal(failed[0].parentElement?.tagName, 'LI');
  const row = h.container.querySelector('[data-session-id="good"]');
  assert.ok(row);
  await h.click(row);
  assert.deepEqual(selected, ['good']);
  assert.equal(getUxErrors().length, 0);
  assert.match(diagnostics[0], /^这条会话渲染失败：Cannot read properties of null/);
});

test('a crashing session panel keeps its header and close control inside the inspector', async t => {
  const h = mount(t);
  const base = fixtureSession('reading');
  const session = { ...base, sessionId: 'panel', loaded: true, roles: [null] } as unknown as ChatSession;
  useCockpit.setState({ sessions: [session], sessionReloadResults: {} });
  await h.render(createElement(MemoryRouter, { initialEntries: ['/session/panel/info'] },
    createElement(SessionDetails, { sessionId: 'panel', panel: 'info' })));
  // Let the lazy panel chunk resolve and render.
  await screen.findByText('会话设置', { selector: '.pane-title' });
  await waitFor(() => assert.equal(fallbacks(h.container).length, 1));
  const failed = fallbacks(h.container);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].getAttribute('data-region-error'), '会话设置');
  const inspector = failed[0].closest('.inspector-surface');
  assert.ok(inspector, 'the fallback stays inside the inspector frame');
  assert.equal(inspector.querySelector('.pane-title')?.textContent, '会话设置');
  assert.ok(within(inspector as HTMLElement).getByRole('button', { name: '关闭' }), 'close stays available');
  assert.equal(getUxErrors().length, 0);
  assert.match(diagnostics.join('\n'), /会话设置渲染失败：Cannot read properties of null/);
});

test('a failed lazy module load offers a page reload, because retrying cannot recover it', async t => {
  const h = mount(t);
  let reloads = 0;
  t.mock.method(window.location, 'reload', () => { reloads++; });
  function Chunk(): ReactNode {
    throw new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1/assets/SessionInfoPanel-abc.js');
  }
  await h.render(createElement(RegionErrorBoundary, { label: '会话设置', children: createElement(Chunk) }));
  const [fallback] = fallbacks(h.container);
  assert.equal(within(fallback).queryByRole('button', { name: '重试' }), null);
  await h.click(within(fallback).getByRole('button', { name: '重新加载页面' }));
  assert.equal(reloads, 1);
  assert.equal(getUxErrors().length, 0);
});
