import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compile } from 'sass';
import { SessionControlBar } from './SessionControlBar';
import { CopyButton } from './CopyButton';
import { applyControlAction, controlDesignState, controlSession, type ControlScene } from '../dev/control-design-state';
import { sessionActivityIndicators } from '../lib/sessionActivity';
import { controlIndicators } from '../lib/sessionControls';

function render(expanded: boolean, scene: ControlScene = 'mixed') {
  const state = controlDesignState(scene);
  return renderToStaticMarkup(createElement(SessionControlBar, {
    session: controlSession(state), controls: state, connected: true, expanded, disabled: false,
    onToggle() {}, onAction: async () => {}, controlRef() {},
  }));
}

test('expansion relocates activity icons and counts from status to group headings behind a leading chevron', () => {
  const open = render(true);
  const closed = render(false);
  for (const html of [open, closed]) {
    const header = html.slice(0, html.indexOf('class="chat-controls-list"'));
    assert.match(header, /data-activity="overall"/);
    assert.match(header, /class="ck-icon spinner"/);
    assert.doesNotMatch(header, /<summary/);
  }
  assert.match(open, /class="chat-controls-toggle ui-disclosure ck-button" aria-expanded="true" aria-controls="[^"]+" aria-label="收起会话状态列表：[^"]+"><span class="ck-icon ui-disclosure-chevron" data-icon="down"/);
  assert.match(closed, /class="chat-controls-toggle ui-disclosure ck-button" aria-expanded="false" aria-controls="[^"]+" aria-label="展开会话状态列表：[^"]+"><span class="ck-icon ui-disclosure-chevron" data-icon="chevron_right"/);
  const openHeader = open.slice(0, open.indexOf('class="chat-controls-list"'));
  const closedHeader = closed.slice(0, closed.indexOf('class="chat-controls-list"'));
  for (const key of ['agent', 'shell', 'queue']) {
    assert.doesNotMatch(openHeader, new RegExp(`data-activity="${key}"`));
    assert.match(closedHeader, new RegExp(`data-activity="${key}"`));
    assert.match(open, new RegExp(`<header class="chat-controls-title">[\\s\\S]*?data-activity="${key}"`));
  }
  assert.match(open, /aria-expanded="true"/);
  assert.match(closed, /aria-expanded="false"/);
});

test('tasks only expose cancellation, group headers clear, and queue retains copy and send', () => {
  const html = render(true);
  assert.match(html, /aria-label="复制排队消息：先不要提交"/);
  assert.doesNotMatch(html, /复制任务名称|查看 Agent 详情|data-icon="view"/);
  assert.match(html, /aria-label="立即发送：先不要提交"/);
  assert.match(html, /aria-label="清空队列"/);
  assert.match(html, /aria-label="取消任务：构建项目"/);
  assert.match(html, /aria-label="清空 Agent（取消该组任务）"/);
  assert.match(html, /aria-label="清空 Terminal（取消该组任务）"/);
  const cancel = html.match(/aria-label="取消任务：构建项目"[\s\S]*?<\/button>/)?.[0] ?? '';
  assert.match(cancel, /data-icon="close"/);
  assert.doesNotMatch(html, />停止<\/button>|>移除<\/button>|>立即发送<\/button>|chat-copy-label/);
  const copy = renderToStaticMarkup(createElement(CopyButton, { text: 'Exact queued text', label: '复制排队消息', variant: 'icon' }));
  assert.match(copy, /class="chat-copy-icon ck-icon-button"/);
  assert.match(copy, /data-icon="copy"/);
  assert.match(copy, /role="status"/);
});

test('stopped tasks vanish immediately without requiring collapse and no idle bar is rendered', () => {
  const state = applyControlAction(controlDesignState('mixed'), { type: 'stop-task', id: 'preview-agent' });
  const html = renderToStaticMarkup(createElement(SessionControlBar, {
    session: { ...controlSession(state), messages: [] }, controls: state, connected: true, expanded: true, disabled: false,
    onToggle() {}, onAction: async () => {}, controlRef() {},
  }));
  assert.doesNotMatch(html, /data-task-id="preview-agent"|aria-label="Agent 列表"/);
  assert.equal(render(true, 'idle'), '');
  assert.equal(render(false, 'idle'), '');
});

test('headings use icon then name then count without a separate waiting-for-answer heading', () => {
  const html = render(true, 'ask');
  const top = html.slice(0, html.indexOf('class="chat-controls-list"'));
  assert.doesNotMatch(top, /data-activity="decision"/);
  assert.match(render(false, 'ask').slice(0, render(false, 'ask').indexOf('class="chat-controls-list"')), /data-activity="overall"[^>]*><span[^>]*data-icon="decision"/);
  const headers: string[] = html.match(/<header[^>]*>[\s\S]*?<\/header>/g) ?? [];
  for (const [icon, label, count] of [['agent', 'Agent', '1'], ['shell', 'Terminal', '2'], ['queue', '队列', '2']]) {
    const header = headers.find(value => value.includes(`data-icon="${icon}"`));
    assert.ok(header, label);
    assert.ok(header.indexOf(`data-icon="${icon}"`) < header.indexOf(`>${label}<`));
    assert.ok(header.indexOf(`>${label}<`) < header.indexOf(`>${count}<`));
    assert.match(header, /data-icon="delete"/);
  }
  assert.doesNotMatch(html, /chat-controls-decisions|>待回答<|清空待回答/);
  const compact = render(true, 'manual');
  assert.match(compact.slice(0, compact.indexOf('class="chat-controls-list"')), /data-icon="compress"/);
  assert.doesNotMatch(compact, /手动压缩上下文|chat-queue-item/);
});

test('sidebar and control bar derive their busy indicators from the same native activity projection', () => {
  for (const scene of ['mixed', 'background', 'ask', 'plan', 'manual', 'tool-loading'] as const) {
    const model = controlDesignState(scene), session = controlSession(model);
    assert.deepEqual(controlIndicators(session, model, true), sessionActivityIndicators({
      ...session, needsDecision: !!(session.ask || session.planRequest || session.elicitation),
    }, true));
    assert.equal(controlIndicators(session, model, true)[0].icon, session.ask || session.planRequest ? 'decision' : 'loading', scene);
  }
});

test('sticky control surfaces use the same existing input-card color, not a preview-specific fill', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.match(css, /\.chat-input-card \{[^}]*--chat-input-surface: color-mix/);
  assert.match(css, /\.chat-controls-header \{[^}]*background: var\(--chat-input-surface\)/);
  // The pinned surface is the host editor container, so module content around the input row stays visible with it.
  assert.match(css, /\.chat-input-card\[data-controls\] \.chat-composer-editor \{[^}]*position: sticky;[^}]*background: var\(--chat-input-surface\)/);
  assert.doesNotMatch(css, /\.chat-input-card\[data-controls\] \.chat-input \{[^}]*sticky/);
  const activityCss = compile(new URL('../styles/components/session-activity.scss', import.meta.url).pathname).css;
  assert.match(activityCss, /\.session-activity-item\[data-activity=overall\] > \.spinner, \.session-activity-item\[data-activity=overall\]:has\(\[data-icon=decision\]\) \{[^}]*color: var\(--host-color-accent\)/);
});
