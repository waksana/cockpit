import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const styles = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.scss') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context);
  },
});
const { ConsumerLifecycleNotice } = await import('./SystemVersions');
styles.deregister();

test('consumer lifecycle notice separates shared safe restart from CLI-only installation updates', () => {
  const html = renderToStaticMarkup(createElement(ConsumerLifecycleNotice));
  assert.match(html, /MCP \/ API 使用同一独立启动器和原操作 ID/);
  assert.match(html, /独立启动器 CLI/);
  assert.match(html, /本体下载安装仍使用/);
  assert.match(html, /authority=consumer 与 installationId 仅说明安装归属/);
  assert.match(html, /模块服务的启动\/安全停止不是 Cockpit 主程序重启/);
  assert.doesNotMatch(html, /<button|<a /);
});

test('system and module version views both display the boundary and never post the old restart API', () => {
  for (const path of ['./SystemVersions.tsx', './Modules.tsx']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /<ConsumerLifecycleNotice \/>/);
    assert.doesNotMatch(source, /admin\/restart|service\/restart|willRestartWhenIdle/);
  }
});
