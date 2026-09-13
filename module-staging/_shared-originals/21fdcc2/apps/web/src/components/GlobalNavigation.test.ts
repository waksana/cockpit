import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parentOf } from '../lib/nav';

test('global lists and item deep links have strict hierarchical parents', () => {
  for (const section of ['mcp', 'skills']) {
    assert.equal(parentOf(`/${section}`), '/');
    assert.equal(parentOf(`/${section}/name%2Fpart`), `/${section}`);
    assert.equal(parentOf(`/${section}/name%2Fpart/`), `/${section}`);
  }
  assert.equal(parentOf('/session/A/info'), '/session/A');
  assert.equal(parentOf('/session/A'), '/');
  assert.equal(parentOf('/files'), '/');
});

test('only the main workspace owns a global menu and section navigation pushes down', () => {
  const source = readFileSync(new URL('./GlobalNavigation.tsx', import.meta.url), 'utf8');
  const management = readFileSync(new URL('./ManageWorkspace.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(management, /GlobalNavigation/);
  assert.doesNotMatch(source, /showSessionListEntry|label: '会话列表'|replace:/);
  assert.match(source, /navigate\(`\/\$\{section\}`\)/);
  assert.match(source, /pathname === '\/'.*triggerRef.current\?\.focus/);
  for (const label of ['文件', '全局 MCP', '全局 Skills', '通知设置']) assert.ok(source.includes(label));
  assert.doesNotMatch(source, /垃圾桶|trash/);
});
