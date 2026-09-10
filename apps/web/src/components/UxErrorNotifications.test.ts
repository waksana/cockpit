import assert from 'node:assert/strict';
import { beforeEach, test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { dismissUxError, getUxErrors, reportUxError } from '../lib/errorReporter';
import { ErrorBoundary } from './ErrorBoundary';
import { UxErrorNotifications } from './UxErrorNotifications';

beforeEach((t: TestContext) => {
  t.mock.method(console, 'error', () => {});
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Notifications must not make requests');
  });
  t.after(() => assert.equal(fetch.mock.callCount(), 0));
  for (const error of getUxErrors()) dismissUxError(error.id);
});

test('renders nothing when there are no local errors', () => {
  assert.equal(renderToStaticMarkup(createElement(UxErrorNotifications)), '');
});

test('renders an API failure reported before mounting with an accessible dismissal', () => {
  reportUxError('接口 prompt 调用失败：Permission denied');
  const html = renderToStaticMarkup(createElement(UxErrorNotifications));
  assert.match(html, /role="alert"/);
  assert.match(html, /接口 prompt 调用失败：Permission denied/);
  assert.match(html, /aria-label="关闭错误通知"/);
  assert.match(html, /type="button"/);
  dismissUxError(getUxErrors()[0].id);
  assert.equal(renderToStaticMarkup(createElement(UxErrorNotifications)), '');
});

test('renders diagnostic text literally, not as HTML or executable links', () => {
  reportUxError('<script>alert(1)</script><img src="https://example.invalid/error">');
  const html = renderToStaticMarkup(createElement(UxErrorNotifications));
  assert.doesNotMatch(html, /<script|<img|<a\b/);
  assert.match(html, /&lt;script&gt;/);
});

test('render crashes are local and the fallback does not claim a report was sent', () => {
  const boundary = new ErrorBoundary({ children: 'app' });
  boundary.componentDidCatch(new Error('Render failed'), { componentStack: '\n at App' });
  assert.match(getUxErrors()[0].message, /界面渲染崩溃：Render failed/);
  assert.match(getUxErrors()[0].message, /位置：at App/);
  boundary.state = ErrorBoundary.getDerivedStateFromError();
  const html = renderToStaticMarkup(boundary.render());
  assert.match(html, /错误仅在本地记录/);
  assert.match(html, /不会自动执行代理/);
  assert.doesNotMatch(html, /已自动上报给当前会话/);
});
