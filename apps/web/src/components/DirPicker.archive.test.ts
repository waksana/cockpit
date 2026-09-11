import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ArchivedStart } from '../lib/sessionStart';

const styles = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.scss') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context);
  },
});
const { ArchivedSessionStarts } = await import('./DirPicker');
styles.deregister();

test('archived first-message receipts retain planned identities and expose only explicit read/inspection controls', () => {
  const archives: ArchivedStart[] = [{ operationId: 'archived-preflight-operation', archivedAt: 1,
    operation: { operationId: 'archived-preflight-operation', sessionId: 'planned-not-proven-native',
      state: 'unknown', error: 'skill frontmatter preflight rejected' },
    error: '服务器未找到原操作记录；这不证明原生会话未创建或消息未提交。' }];
  const render = (reading = false) => renderToStaticMarkup(createElement(ArchivedSessionStarts, { archives, reading,
    onRead: () => { assert.fail('render must not read'); }, onInspect: () => { assert.fail('render must not navigate'); } }));
  const html = render();
  assert.match(html, /archived-preflight-operation/);
  assert.match(html, /planned-not-proven-native/);
  assert.match(html, /可能尚未创建原生会话/);
  assert.match(html, /不取消后台请求、不删除服务器回执/);
  assert.match(html, /只读核对归档原操作/);
  assert.match(html, /检查可能存在的原会话/);
  assert.doesNotMatch(html, /已接受消息的原生会话|重试|重新发送|disabled=""/);
  assert.match(render(true), /disabled=""/);
});
