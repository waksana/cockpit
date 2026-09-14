import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Intents, classifyNativeModelSwitchResult, classifyNativeModeSetResult, classifyNativeCompactResult,
  classifyNativeRewindResult, type NativeModelSwitchResult, type NativeOperationClassification,
} from './index.ts';

test('native mutation results preserve absent, unknown, queued, refused and partially applied outcomes', () => {
  for (const result of [
    {}, { modelId: 'native' }, { status: 'future-native-status', futureField: { detail: true } },
    { status: 'queued', deferred: true }, { status: 'rejected', message: 'Native refusal' },
    { status: 'applied', persistenceError: 'Native setting write failed', warning: 'Native warning',
      deprecationWarnings: ['Native deprecation'], modelState: {
        modelId: 'native', reasoningEffort: 'high', contextTier: 'future-tier',
        autoTier: 'future-auto', pendingAutoTier: null, activatingAutoTier: 'future-auto', nativeExtension: 1,
      } },
    { status: 'confirmation_required', confirmation: {
      targetModelDisplayName: 'Native model', currentTokens: 20, targetLimit: 10, nativeExtension: 1,
    } },
  ]) {
    assert.deepEqual(Intents.setModel.result.parse({ ok: true, result }), { ok: true, result });
  }
  const mode = {
    status: 'applied', modelChanged: true, message: 'Native follow-up needed', warning: 'Native warning',
    deferImplementation: true, armInteractiveContinuation: true, nativeExtension: 1,
    deprecationWarnings: ['Native deprecation'],
    confirmation: { targetModelDisplayName: 'Native model', currentTokens: 20, targetLimit: 10 },
  };
  assert.deepEqual(Intents.setMode.result.parse({ ok: true, result: mode }), { ok: true, result: mode });
  const compact = {
    success: false, tokensRemoved: 100, messagesRemoved: 2, summaryContent: 'Native partial summary',
    contextWindow: { tokenLimit: 1000, currentTokens: 500, messagesLength: 2,
      systemTokens: 100, conversationTokens: 300, toolDefinitionsTokens: 100, nativeExtension: 1 },
  };
  assert.deepEqual(Intents['session/compact'].result.parse({ ok: true, result: compact }), { ok: true, result: compact });
  const rewind = {
    outcome: 'snapshot-prune-failed', eventsRemoved: 3, restoredFiles: ['/fixture/restored'],
    skippedFiles: [{ path: '/fixture/kept', reason: 'future-native-reason', nativeExtension: true }],
    error: 'Native cleanup failed', nativeExtension: 1,
  };
  assert.deepEqual(Intents['session/rewind'].result.parse({ ok: true, result: rewind }), { ok: true, result: rewind });
  for (const name of ['setModel', 'setMode', 'session/compact', 'session/rewind'] as const) {
    assert.equal(Intents[name].result.safeParse({ ok: true }).success, false, name);
  }
});

test('schedule input retains original whitespace for validation and uncertain results retain possible creation', () => {
  const body = { sessionId: 'fixture', prompt: '  check build  ', interval: '1m' };
  assert.deepEqual(Intents['schedule/add'].body.parse(body), body);
  for (const prompt of ['\ncheck build', 'check build\r', ' \ncheck build\n ']) {
    assert.equal(Intents['schedule/add'].body.safeParse({ ...body, prompt }).success, false);
  }
  const uncertain = { ok: false, error: 'Acknowledgement unknown; a schedule may have been created', possiblyCreated: true };
  assert.deepEqual(Intents['schedule/add'].result.parse(uncertain), uncertain);
});

test('shared model classification preserves queued priority and distinguishes explicit failures from unknown outcomes', () => {
  const cases: [NativeModelSwitchResult, NativeOperationClassification['state']][] = [
    [{}, 'unknown'], [{ modelId: 'native', modelState: { modelId: 'native' } }, 'unknown'],
    [{ status: 'future-native-status', message: 'Model changed' }, 'unknown'],
    [{ status: 'applied' }, 'applied'], [{ status: 'unchanged' }, 'unchanged'],
    [{ status: 'queued' }, 'queued'], [{ status: 'deferred' }, 'queued'],
    [{ status: 'applied', deferred: true, modelState: { reasoningEffort: 'low' } }, 'queued'],
    [{ status: 'rejected', deferred: true }, 'queued'],
    [{ status: 'rejected' }, 'failed'], [{ status: 'cancelled' }, 'failed'], [{ status: 'failed' }, 'failed'],
    [{ status: 'confirmation_required' }, 'needs-action'],
    [{ status: 'applied', confirmation: { targetModelDisplayName: 'Native', currentTokens: 20, targetLimit: 10 } }, 'needs-action'],
  ];
  for (const [result, state] of cases) {
    const before = structuredClone(result);
    assert.deepEqual(classifyNativeModelSwitchResult(result), {
      state, isError: state === 'failed', persistenceFailed: false,
    });
    assert.deepEqual(result, before, 'classification never normalizes or rewrites native results');
  }
});

test('shared model classification reports persistence failure without erasing application or queued state', () => {
  for (const [status, deferred, state] of [
    ['applied', false, 'applied'], ['unchanged', false, 'unchanged'],
    ['applied', true, 'queued'], ['future-native-status', false, 'unknown'],
  ] as const) {
    const result = { status, deferred, persistenceError: 'Native write failed', warning: 'Native warning' };
    assert.deepEqual(classifyNativeModelSwitchResult(result), { state, isError: true, persistenceFailed: true });
    assert.equal(result.warning, 'Native warning');
  }
});

test('shared mode classification reports required follow-up without inventing application or suppressing refusal', () => {
  for (const flags of [
    { deferImplementation: true }, { armInteractiveContinuation: true },
    { confirmation: { targetModelDisplayName: 'Native', currentTokens: 20, targetLimit: 10 } },
  ]) {
    assert.deepEqual(classifyNativeModeSetResult({ status: 'applied', modelChanged: true, ...flags }), {
      state: 'needs-action', isError: false, persistenceFailed: false,
    });
  }
  assert.deepEqual(classifyNativeModeSetResult({ status: 'cancelled', modelChanged: false, deferImplementation: true }), {
    state: 'failed', isError: true, persistenceFailed: false,
  });
  assert.deepEqual(classifyNativeModeSetResult({ status: 'future-native-status', modelChanged: true }), {
    state: 'unknown', isError: false, persistenceFailed: false,
  });
});

test('shared compact classification retains unsuccessful partial effects and explicit success', () => {
  for (const success of [true, false]) {
    const result = { success, tokensRemoved: 100, messagesRemoved: 2, summaryContent: 'Native partial summary' };
    const before = structuredClone(result);
    assert.deepEqual(classifyNativeCompactResult(result), {
      state: success ? 'applied' : 'failed', isError: !success, persistenceFailed: false,
    });
    assert.deepEqual(result, before);
  }
});

test('shared rewind classification marks documented failures and preserves partial effects and unknown outcomes', () => {
  for (const outcome of [
    'session-busy', 'file-change-tracking-disabled', 'unsupported-remote-session', 'files-rolled-back',
    'rollback-incomplete', 'truncation-failed', 'checkpoint-cleanup-failed', 'snapshot-prune-failed',
  ]) {
    const result = { outcome, eventsRemoved: 3, restoredFiles: ['/fixture/restored'],
      skippedFiles: [{ path: '/fixture/skipped', reason: 'native conflict' }] };
    const before = structuredClone(result);
    assert.deepEqual(classifyNativeRewindResult(result), { state: 'failed', isError: true, persistenceFailed: false });
    assert.deepEqual(result, before);
  }
  const result = { outcome: 'future-native-status', restoredFiles: [], skippedFiles: [] };
  assert.deepEqual(classifyNativeRewindResult(result), { state: 'unknown', isError: false, persistenceFailed: false });
  assert.deepEqual(classifyNativeRewindResult({ ...result, error: 'Native error' }), {
    state: 'unknown', isError: true, persistenceFailed: false,
  });
  assert.deepEqual(classifyNativeRewindResult({ ...result, outcome: 'success' }), {
    state: 'applied', isError: false, persistenceFailed: false,
  });
});
