import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compile } from 'sass';
import { SessionControlBar } from './SessionControlBar';
import { CopyButton } from './CopyButton';
import { controlDesignState, controlSession } from '../dev/control-design-state';
import { sessionActivityIndicators } from '../lib/sessionActivity';
import { controlIndicators } from '../lib/sessionControls';

function render(expanded: boolean) {
  const state = controlDesignState('mixed');
  return renderToStaticMarkup(createElement(SessionControlBar, {
    session: controlSession(state), controls: state, connected: true, expanded, disabled: false,
    onToggle() {}, onAction: async () => {}, onView() {}, controlRef() {},
  }));
}

test('expansion relocates activity icons and counts from status to group headings without an arrow', () => {
  const open = render(true);
  const closed = render(false);
  for (const html of [open, closed]) {
    const header = html.slice(0, html.indexOf('class="chat-controls-list"'));
    assert.match(header, /data-activity="overall"/);
    assert.match(header, /class="ck-icon spinner"/);
    assert.doesNotMatch(header, /data-icon="down"|data-icon="chevron_right"|<summary/);
  }
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

test('all actions are named icon buttons, including queue and task copying', () => {
  const html = render(true);
  assert.match(html, /aria-label="复制排队消息：先不要提交"/);
  assert.match(html, /aria-label="复制任务名称：构建项目"/);
  assert.match(html, /aria-label="立即发送：先不要提交"/);
  assert.match(html, /aria-label="清空队列"/);
  assert.match(html, /aria-label="停止任务：构建项目"/);
  assert.match(html, /aria-label="查看任务记录：独立代码审查"/);
  assert.doesNotMatch(html, />停止<\/button>|>移除<\/button>|>立即发送<\/button>|chat-copy-label/);
  const copy = renderToStaticMarkup(createElement(CopyButton, { text: 'Exact queued text', label: '复制排队消息', variant: 'icon' }));
  assert.match(copy, /class="chat-copy-icon ck-icon-button"/);
  assert.match(copy, /data-icon="copy"/);
  assert.match(copy, /role="status"/);
});

test('sidebar and control bar derive their busy indicators from the same native activity projection', () => {
  for (const scene of ['mixed', 'background', 'ask', 'plan', 'manual', 'tool-loading'] as const) {
    const model = controlDesignState(scene), session = controlSession(model);
    assert.deepEqual(controlIndicators(session, model, true), sessionActivityIndicators({
      ...session, needsDecision: !!(session.ask || session.planRequest || session.elicitation),
    }, true));
    assert.equal(controlIndicators(session, model, true)[0].icon, 'loading');
  }
});

test('sticky control surfaces use the same existing input-card color, not a preview-specific fill', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.match(css, /\.chat-input-card \{[^}]*--chat-input-surface: color-mix/);
  assert.match(css, /\.chat-controls-header \{[^}]*background: var\(--chat-input-surface\)/);
  assert.match(css, /\.chat-input-card\[data-controls\] \.chat-input \{[^}]*background: var\(--chat-input-surface\)/);
  const activityCss = compile(new URL('../styles/components/session-activity.scss', import.meta.url).pathname).css;
  assert.match(activityCss, /\.session-activity-item\[data-activity=overall\] > \.spinner \{[^}]*color: var\(--primary-color\)/);
});
