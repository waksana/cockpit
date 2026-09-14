import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionDeleteDialog } from './SessionDeleteDialog';
import { useCockpit } from '../net/store';

test('native deletion uses the ordinary confirmation and retains module data without preflight', () => {
  useCockpit.setState({ connState: 'open' });
  const html = renderToStaticMarkup(createElement(SessionDeleteDialog, {
    sessionId: 'target-a', name: 'Target A',
    onCancel() { assert.fail('Rendering cannot cancel'); },
    onSuccess() { assert.fail('Rendering cannot delete'); },
  }));
  assert.match(html, /永久删除.*Target A/);
  assert.match(html, /不可恢复/);
  assert.match(html, /托管文件、工作目录和外部应用数据不会删除/);
  assert.match(html, /只执行原生删除，不调用外部业务流程/);
  assert.doesNotMatch(html, /解除关联并删除|预览|planId|operationId/);
  const source = readFileSync(new URL('./SessionDeleteDialog.tsx', import.meta.url), 'utf8');
  assert.match(source, /await deleteSession\(sessionId\)/);
  assert.match(source, /if \(submitted.current\) throw/);
  assert.doesNotMatch(source, /moduleIntent|previewDeleteSession|useKeyedResource|\.refresh\(/);
});
