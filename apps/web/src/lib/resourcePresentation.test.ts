import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mcpConnectionLabel, moduleProvidedRows, resourceErrorSummary, skillSourceLabel } from './resourcePresentation';

test('resource metadata omits internal source noise instead of inventing provenance', () => {
  for (const source of ['native', 'builtin', 'custom', 'sdk', 'project-copilot', 'unknown', undefined]) {
    assert.equal(skillSourceLabel(source), undefined);
  }
  assert.equal(skillSourceLabel('personal-copilot'), '个人');
  assert.equal(skillSourceLabel('personal-agents'), '个人');
  assert.equal(skillSourceLabel('project'), '项目');
  assert.equal(skillSourceLabel('inherited'), '上级目录');
  assert.equal(skillSourceLabel('plugin'), '插件');
});

test('MCP summaries consume typed metadata without guessing missing transport', () => {
  assert.equal(mcpConnectionLabel(), '未知方式');
  assert.equal(mcpConnectionLabel({ method: 'unknown', target: 'not-a-known-transport' }), '未知方式');
  assert.equal(mcpConnectionLabel({ method: 'http', target: 'fixture.example' }), 'HTTP · fixture.example');
  assert.equal(mcpConnectionLabel({ method: 'sse', target: 'fixture.example' }), 'SSE · fixture.example');
  assert.equal(mcpConnectionLabel({ method: 'stdio', target: 'node' }), '本地进程 · node');
  assert.equal(mcpConnectionLabel({ method: 'http' }), 'HTTP');
});

test('error summaries retain actual first-line text without dumping stacks or inventing causes', () => {
  assert.equal(resourceErrorSummary('\n  Connection refused by fixture\n    at native.connect (fixture:4)\n'), 'Connection refused by fixture');
  assert.equal(resourceErrorSummary('Authentication required'), 'Authentication required');
  assert.equal(resourceErrorSummary('Exact ' + 'long '.repeat(80)).length, 161);
  assert.equal(resourceErrorSummary('\u{1F534}'.repeat(161)), '\u{1F534}'.repeat(160) + '…');
});

test('native attribution deduplicates only the exact opaque module Skill identity', () => {
  const module = {
    id: 'fixture', name: 'Fixture', roles: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    skills: [
      { id: 'first', name: 'shared', roles: ['a'] },
      { id: 'second', name: 'shared', roles: ['b'] },
      { id: 'unique', name: 'unique', roles: ['a'] },
    ],
    mcpServers: [],
  };
  const native = [
    { name: 'shared', modules: [{ id: 'fixture', name: 'Fixture', resourceId: 'first' }] },
    { name: 'unique', modules: [{ id: 'fixture', name: 'Fixture' }] },
  ];
  assert.deepEqual(moduleProvidedRows([module], 'skills', native).map(row => row.resourceId), ['second', 'unique'],
    'only exact native role-resource identity is deduplicated');
});
