import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SESSION_STATE_DIR } from './config.ts';
import { readEventTurns, readZeroTurnDiagnostic, stripSkillContext, type AssistantView } from './store.ts';

async function foldEvents(events: unknown[], assistantView: AssistantView = 'default') {
  const sessionId = `store-test-${randomUUID()}`;
  const dir = join(SESSION_STATE_DIR, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
  try {
    return await readEventTurns(sessionId, { assistantView });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withSessionState(
  build: (sessionId: string, dir: string) => Promise<void>,
  read: (sessionId: string) => Promise<void> | void,
) {
  const sessionId = `store-test-${randomUUID()}`;
  const dir = join(SESSION_STATE_DIR, sessionId);
  await mkdir(dir, { recursive: true });
  try {
    await build(sessionId, dir);
    await read(sessionId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The SDK injects each loaded skill as a synthetic user.message of the shape
// <skill-context name="X">…full SKILL.md…</skill-context>. A heavy-skill worker
// (e.g. a build worker with skill-maintainer + skill-creator + session-distillation)
// then has 20–35 KB of this boilerplate per block, burying the real exchange. These
// tests pin the stripping that powers cockpit_read_session's exclude_skill_context.

test('a message that is PURELY one skill-context block strips to empty', () => {
  const block =
    '<skill-context name="skill-creator">\nBase directory: /x\n\n# Skill Creator\n' +
    'lots and lots of guidance...\n'.repeat(50) +
    '</skill-context>';
  assert.equal(stripSkillContext(block), '');
});

test('real user text around/after skill-context blocks is preserved', () => {
  const text =
    '<skill-context name="a">aaa\n# A\nbody a</skill-context>\n' +
    '<skill-context name="b">bbb\n# B\nbody b</skill-context>\n' +
    '请处理队列里的第一个 candidate，并在完成后提交。';
  assert.equal(stripSkillContext(text), '请处理队列里的第一个 candidate，并在完成后提交。');
});

test('multiple blocks (the build-worker case) are all removed; inner </> and newlines survive collapse', () => {
  const text =
    'PREFIX TASK\n' +
    '<skill-context name="skill-maintainer">\n# Skill Maintainer\nrule 1\nrule 2\n</skill-context>\n\n' +
    '<skill-context name="skill-creator">\n# Skill Creator\nstep 1\nstep 2\n</skill-context>\n\n' +
    'SUFFIX NOTE';
  const out = stripSkillContext(text);
  assert.equal(out, 'PREFIX TASK\n\nSUFFIX NOTE');
  assert.ok(!out.includes('<skill-context'));
  assert.ok(!out.includes('Skill Maintainer'));
});

test('content WITHOUT any skill-context is returned unchanged (fast path)', () => {
  const text = 'just a normal prompt with <em>angle brackets</em> and a `<tag>` mention.';
  assert.equal(stripSkillContext(text), text);
});

test('a defensive dangling/unclosed skill-context (truncated log) is cut to end', () => {
  const text = 'real instruction here\n<skill-context name="x">\n# X\n这一段没有闭合标签（被截断了）';
  assert.equal(stripSkillContext(text), 'real instruction here');
});

test('empty / non-context input is safe', () => {
  assert.equal(stripSkillContext(''), '');
  assert.equal(stripSkillContext('hello'), 'hello');
});

test('skill-context with attributes and multiline body is matched (non-greedy across blocks)', () => {
  // Two adjacent blocks must NOT be swallowed as one greedy match that eats the
  // real text between them.
  const text =
    '<skill-context name="a" version="1">A\nA</skill-context>MIDDLE KEEP<skill-context name="b">B\nB</skill-context>';
  assert.equal(stripSkillContext(text), 'MIDDLE KEEP');
});

test('local event-store transcript reads remain independent of loopback fetch failures', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error('loopback unavailable');
  }) as typeof fetch;
  try {
    const turns = await foldEvents([
      { type: 'user.message', data: { content: 'local-only' }, timestamp: '2026-09-01T00:00:00.000Z' },
      { type: 'assistant.message', data: { content: 'still-readable' }, timestamp: '2026-09-01T00:00:01.000Z' },
    ]);
    assert.equal(turns[0]?.user_message, 'local-only');
    assert.equal(turns[0]?.assistant_response, 'still-readable');
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('task_complete summary is appended to the current assistant turn', async () => {
  const turns = await foldEvents([
    { type: 'user.message', data: { content: 'run the worker' }, timestamp: '2026-07-17T00:00:00.000Z' },
    { type: 'assistant.message', data: { content: 'working...' }, timestamp: '2026-07-17T00:00:01.000Z' },
    { type: 'tool.execution_start', data: { toolName: 'task' }, timestamp: '2026-07-17T00:00:02.000Z' },
    { type: 'tool.execution_complete', data: { success: true }, timestamp: '2026-07-17T00:00:03.000Z' },
    {
      type: 'session.task_complete',
      data: { summary: 'FINAL-WORKER-SUMMARY', success: true },
      timestamp: '2026-07-17T00:00:04.000Z',
    },
    { type: 'assistant.turn_end', data: {}, timestamp: '2026-07-17T00:00:05.000Z' },
  ]);

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.user_message, 'run the worker');
  assert.match(turns[0]?.assistant_response ?? '', /working\.\.\./);
  assert.match(turns[0]?.assistant_response ?? '', /【task_complete summary】\nFINAL-WORKER-SUMMARY/);
});

test('task_complete before any user message opens turn zero and preserves failure', async () => {
  const turns = await foldEvents([
    {
      type: 'session.task_complete',
      data: { summary: 'ORPHAN-TASK-COMPLETE', success: false },
      timestamp: '2026-07-17T00:00:00.000Z',
    },
    { type: 'assistant.turn_end', data: {}, timestamp: '2026-07-17T00:00:01.000Z' },
  ]);

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.turn_index, 0);
  assert.equal(turns[0]?.user_message, null);
  assert.match(
    turns[0]?.assistant_response ?? '',
    /【task_complete summary · FAILED】\nORPHAN-TASK-COMPLETE/,
  );
});

test('tool-only autopilot messages survive replay and retain the task_complete summary', async () => {
  const turns = await foldEvents([
    { type: 'user.message', data: { content: 'run the worker' }, timestamp: '2026-08-03T00:00:00.000Z' },
    {
      type: 'assistant.message',
      data: {
        content: '',
        encryptedContent: 'opaque-reasoning-that-is-not-the-visible-answer',
        toolRequests: [
          {
            toolCallId: 'tool-1',
            name: 'apply_patch',
            arguments: { patch: 'SECRET-RAW-ARGS-MUST-NOT-LEAK' },
            intentionSummary: 'Apply the verified backend repair',
          },
        ],
      },
      timestamp: '2026-08-03T00:00:01.000Z',
    },
    { type: 'tool.execution_complete', data: { toolCallId: 'tool-1', success: true }, timestamp: '2026-08-03T00:00:02.000Z' },
    {
      type: 'session.task_complete',
      data: { summary: 'FINAL-AUTOPILOT-SUMMARY', success: true },
      timestamp: '2026-08-03T00:00:03.000Z',
    },
  ]);

  const assistant = turns[0]?.assistant_response ?? '';
  assert.match(assistant, /【tool】 Apply the verified backend repair/);
  assert.match(assistant, /【task_complete summary】\nFINAL-AUTOPILOT-SUMMARY/);
  assert.doesNotMatch(assistant, /SECRET-RAW-ARGS-MUST-NOT-LEAK/);
});

test('tool-only assistant falls back to the tool name when no intention is available', async () => {
  const turns = await foldEvents([
    { type: 'user.message', data: { content: 'inspect' }, timestamp: '2026-08-03T00:00:00.000Z' },
    {
      type: 'assistant.message',
      data: { content: '', toolRequests: [{ toolCallId: 'tool-1', name: 'view' }] },
      timestamp: '2026-08-03T00:00:01.000Z',
    },
  ]);

  assert.equal(turns[0]?.assistant_response, '【tool】 view');
});

test('authoritative_text drops synthesized tool summaries and starts a silent worker at task_complete', async () => {
  const turns = await foldEvents([
    { type: 'user.message', data: { content: 'run review worker' }, timestamp: '2026-08-13T00:00:00.000Z' },
    {
      type: 'assistant.message',
      data: { content: '', toolRequests: [{ toolCallId: 'tool-1', intentionSummary: 'Fetch candidate PRs', name: 'cockpit-butler' }] },
      timestamp: '2026-08-13T00:00:01.000Z',
    },
    {
      type: 'assistant.message',
      data: { content: '', toolRequests: [{ toolCallId: 'tool-2', description: 'Run the policy review pass', name: 'task' }] },
      timestamp: '2026-08-13T00:00:02.000Z',
    },
    {
      type: 'session.task_complete',
      data: { summary: 'FINAL-REVIEW-SUMMARY', success: true },
      timestamp: '2026-08-13T00:00:03.000Z',
    },
  ], 'authoritative_text');

  assert.equal(turns.length, 1);
  assert.equal(
    turns[0]?.assistant_response,
    '【task_complete summary】\nFINAL-REVIEW-SUMMARY',
  );
});

test('authoritative_text keeps real assistant content and task_complete while dropping tool summaries', async () => {
  const turns = await foldEvents([
    { type: 'user.message', data: { content: 'summarize the fix' }, timestamp: '2026-08-13T00:00:00.000Z' },
    {
      type: 'assistant.message',
      data: { content: 'Investigating the transcript bug.', toolRequests: [{ toolCallId: 'tool-1', intentionSummary: 'Inspect the event log' }] },
      timestamp: '2026-08-13T00:00:01.000Z',
    },
    {
      type: 'assistant.message',
      data: { content: '', toolRequests: [{ toolCallId: 'tool-2', intentionSummary: 'Run the targeted repair' }] },
      timestamp: '2026-08-13T00:00:02.000Z',
    },
    {
      type: 'session.task_complete',
      data: { summary: 'FIX-SUMMARY', success: true },
      timestamp: '2026-08-13T00:00:03.000Z',
    },
  ], 'authoritative_text');

  const assistant = turns[0]?.assistant_response ?? '';
  assert.match(assistant, /^Investigating the transcript bug\./);
  assert.match(assistant, /【task_complete summary】\nFIX-SUMMARY/);
  assert.doesNotMatch(assistant, /【tool】/);
});

test('authoritative_text leaves tool-only incomplete turns empty instead of fabricating assistant text', async () => {
  const turns = await foldEvents([
    { type: 'user.message', data: { content: 'inspect' }, timestamp: '2026-08-13T00:00:00.000Z' },
    {
      type: 'assistant.message',
      data: { content: '', toolRequests: [{ toolCallId: 'tool-1', name: 'view' }] },
      timestamp: '2026-08-13T00:00:01.000Z',
    },
  ], 'authoritative_text');

  assert.equal(turns[0]?.assistant_response, null);
});

test('authoritative_text filters child-sourced completion echoes by agentId regardless of content', async () => {
  const turns = await foldEvents([
    { type: 'user.message', data: { content: 'run parent worker' }, timestamp: '2026-08-19T00:00:00.000Z' },
    { type: 'assistant.message', agentId: 'child-a', data: { content: 'RECORDED', toolRequests: [] }, timestamp: '2026-08-19T00:00:01.000Z' },
    {
      type: 'session.task_complete',
      agentId: 'child-b',
      data: { summary: 'ARBITRARY-CHILD-SUMMARY', success: true },
      timestamp: '2026-08-19T00:00:02.000Z',
    },
    { type: 'assistant.message', agentId: 'child-c', data: { content: 'DIFFERENT-CHILD-TEXT', toolRequests: [] }, timestamp: '2026-08-19T00:00:03.000Z' },
    {
      type: 'session.task_complete',
      data: { summary: 'FINAL', success: true },
      timestamp: '2026-08-19T00:00:04.000Z',
    },
  ], 'authoritative_text');

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.assistant_response, '【task_complete summary】\nFINAL');
});

test('authoritative_text keeps parent assistant text and final summary while dropping concurrent child echoes', async () => {
  const turns = await foldEvents([
    { type: 'user.message', data: { content: 'summarize' }, timestamp: '2026-08-19T00:00:00.000Z' },
    { type: 'assistant.message', data: { content: 'Parent is aggregating results.', toolRequests: [] }, timestamp: '2026-08-19T00:00:01.000Z' },
    { type: 'assistant.message', agentId: 'child-c', data: { content: 'THIRD-CHILD', toolRequests: [] }, timestamp: '2026-08-19T00:00:02.000Z' },
    { type: 'assistant.message', agentId: 'child-a', data: { content: 'FIRST-CHILD', toolRequests: [] }, timestamp: '2026-08-19T00:00:03.000Z' },
    { type: 'assistant.message', agentId: 'child-b', data: { content: 'SECOND-CHILD', toolRequests: [] }, timestamp: '2026-08-19T00:00:04.000Z' },
    {
      type: 'session.task_complete',
      data: { summary: 'FINAL', success: true },
      timestamp: '2026-08-19T00:00:05.000Z',
    },
  ], 'authoritative_text');

  const assistant = turns[0]?.assistant_response ?? '';
  assert.match(assistant, /^Parent is aggregating results\./);
  assert.match(assistant, /【task_complete summary】\nFINAL/);
  assert.doesNotMatch(assistant, /FIRST-CHILD|SECOND-CHILD|THIRD-CHILD/);
});

test('authoritative_text keeps the parent task_complete even when its summary matches the child echo text', async () => {
  const turns = await foldEvents([
    { type: 'user.message', data: { content: 'finish' }, timestamp: '2026-08-19T00:00:00.000Z' },
    { type: 'assistant.message', agentId: 'child-a', data: { content: 'RECORDED', toolRequests: [] }, timestamp: '2026-08-19T00:00:01.000Z' },
    {
      type: 'session.task_complete',
      data: { summary: 'RECORDED', success: true },
      timestamp: '2026-08-19T00:00:02.000Z',
    },
  ], 'authoritative_text');

  assert.equal(turns[0]?.assistant_response, '【task_complete summary】\nRECORDED');
});

test('default still keeps tool fallback but drops child-sourced echoes', async () => {
  const turns = await foldEvents([
    { type: 'user.message', data: { content: 'repair' }, timestamp: '2026-08-19T00:00:00.000Z' },
    {
      type: 'assistant.message',
      data: { content: '', toolRequests: [{ toolCallId: 'tool-1', intentionSummary: 'Apply the repair', name: 'apply_patch' }] },
      timestamp: '2026-08-19T00:00:01.000Z',
    },
    { type: 'assistant.message', agentId: 'child-a', data: { content: 'RECORDED', toolRequests: [] }, timestamp: '2026-08-19T00:00:02.000Z' },
    {
      type: 'session.task_complete',
      data: { summary: 'FINAL', success: true },
      timestamp: '2026-08-19T00:00:03.000Z',
    },
  ]);

  const assistant = turns[0]?.assistant_response ?? '';
  assert.match(assistant, /【tool】 Apply the repair/);
  assert.match(assistant, /【task_complete summary】\nFINAL/);
  assert.doesNotMatch(assistant, /^RECORDED$/m);
});

test('zero-turn diagnostics surface persisted launch failure without fabricating a turn', async () => {
  await withSessionState(
    async (_sessionId, dir) => {
      await writeFile(
        join(dir, 'cockpit-launch.json'),
        JSON.stringify({ version: 1, flowId: 'flow-review', state: 'launch_failed', updatedAt: Date.now(), error: 'prompt rejected' }),
        'utf8',
      );
    },
    async (sessionId) => {
      const diag = readZeroTurnDiagnostic(sessionId);
      assert.deepEqual(diag, {
        source: 'empty',
        zeroTurnReason: 'launch_failed_before_first_turn',
        eventLogExists: false,
        sessionDbExists: false,
        launchState: 'launch_failed',
        error: 'prompt rejected',
      });
    },
  );
});

test('zero-turn diagnostics stay neutral for a legitimate cold empty session', async () => {
  await withSessionState(
    async () => {},
    async (sessionId) => {
      const diag = readZeroTurnDiagnostic(sessionId);
      assert.deepEqual(diag, {
        source: 'empty',
        zeroTurnReason: 'no_event_log_and_no_turns',
        eventLogExists: false,
        sessionDbExists: false,
        launchState: null,
        error: null,
      });
    },
  );
});
