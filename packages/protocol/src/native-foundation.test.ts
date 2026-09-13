import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Intents, NativeAttachment, SessionMeta, Snapshot, ServerEvent } from './index.ts';

test('native attachment input exposes SDK shapes without a managed-file protocol', () => {
  const attachments = [
    { type: 'file', path: '/fixture/report.txt', displayName: 'Report' },
    { type: 'directory', path: '/fixture/project' },
    { type: 'selection', filePath: '/fixture/code.ts', displayName: 'Selected code', text: 'const value = 1;',
      selection: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } },
    { type: 'blob', data: 'Zml4dHVyZQ==', mimeType: 'text/plain', displayName: 'Fixture' },
  ];
  for (const attachment of attachments) assert.deepEqual(NativeAttachment.parse(attachment), attachment);
  const body = { sessionId: 'original', text: '', attachments };
  assert.deepEqual(Intents.prompt.body.parse(body), body);
  for (const change of [
    { attachment: { kind: 'file', name: 'Old', url: '/uploads/old.txt' } },
    { parts: [{ type: 'text', text: 'Old ordered wire format' }] },
    { attachments: [{ kind: 'file', name: 'Old', url: '/uploads/old.txt' }] },
    { attachments: [{ type: 'file', path: '/fixture/file', url: '/uploads/untrusted' }] },
    { attachments: [{ type: 'file', path: '' }] },
    { attachments: Array.from({ length: 21 }, () => attachments[0]) },
  ]) assert.equal(Intents.prompt.body.safeParse({ ...body, ...change }).success, false);
});

test('parked enhancement endpoints are absent while native controls remain', () => {
  for (const name of [
    'files/list', 'files/get', 'files/associate', 'push/status', 'push/subscribe', 'push/unsubscribe',
    'push/test', 'inbox/seen', 'speech/token', 'session/pin', 'session/auto-name',
    'system/consumer/status', 'system/consumer/restart',
  ]) assert.equal(Object.hasOwn(Intents, name), false, name);
  for (const name of ['session/rename', 'session/compact', 'session/rewind', 'session/reload',
    'session/delete', 'session/chat', 'mcp/session', 'skills/session', 'schedule/list']) {
    assert.equal(Object.hasOwn(Intents, name), true, name);
  }
});

test('native metadata and control streams have no enhancement-owned fields or notifications', () => {
  const native = { sessionId: 's', title: 'Native', cwd: '/fixture', lastActivity: 1, status: 'idle', loaded: true, ask: null };
  const retired = { pinned: true, attention: 'ready', attnId: 2, seenId: 1, autoNaming: true, autoNameError: 'Old' };
  assert.deepEqual(SessionMeta.parse({ ...native, ...retired }), native);
  const snapshot = { type: 'snapshot', agentStatus: 'up', models: [], sessions: [native], permissionPolicy: 'allow-all' };
  assert.deepEqual(Snapshot.parse({ ...snapshot, vapidPublicKey: 'old', inboxRevision: 2, unreadCount: 1 }), snapshot);
  assert.equal(ServerEvent.safeParse({ type: 'session/notify', sessionId: 's', title: 'Old', body: 'Old', attention: 'ready' }).success, false);
});
