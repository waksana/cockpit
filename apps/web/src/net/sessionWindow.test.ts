import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyHistoryPage, applyResumedHistory, invalidateWindow, metaToSession, retainLatestWindow } from './sessionWindow';
import type { ChatMessage, ChatSession, HistoryPage, SessionMeta } from './types';

const meta: SessionMeta = {
  sessionId: 'session',
  title: 'Session',
  cwd: '.',
  lastActivity: 1,
  status: 'idle',
  error: null,
  loaded: true,
  queue: [],
  ask: null,
};

function message(id: string, content = id): ChatMessage {
  return { id, role: 'assistant', content, timestamp: 1 };
}

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    ...meta,
    messages: [],
    materialized: true,
    historyStale: false,
    resumeAfter: undefined,
    hasMore: false,
    loadingHistory: false,
    liveMessageIds: [],
    ...overrides,
  };
}

test('departure alone keeps one latest page and discards the current-entry checkpoint', () => {
  const messages = Array.from({ length: 150 }, (_, i) => message(`m${i}`));
  const original = session({
    messages, hasMore: false, resumeAfter: 'm149', liveMessageIds: ['m1', 'm149'],
    resumeToken: 'checkpoint',
  });
  const retained = retainLatestWindow(original);
  assert.equal(original.messages.length, 150);
  assert.deepEqual(retained.messages, messages.slice(-30));
  assert.equal(retained.resumeToken, undefined);
  assert.equal(retained.resumeAfter, undefined);
  assert.equal(retained.hasMore, true);
  assert.deepEqual(retained.liveMessageIds, ['m149']);
  assert.equal(retainLatestWindow({
    ...original, messages: [...messages, message('m150')],
  }).messages[0].id, 'm121');
});

test('short and empty accepted windows remain hot, but incomplete cold loading cannot become a cached page', () => {
  for (const messages of [[], [message('one')]]) {
    const retained = retainLatestWindow(session({ messages }));
    assert.deepEqual(retained.messages, messages);
    assert.equal(retained.materialized, true);
    assert.equal(retained.hasMore, false);
  }
  const pending = retainLatestWindow(session({ messages: [message('delta')], materialized: false, loadingHistory: true }));
  assert.deepEqual(pending.messages, []);
  assert.equal(pending.materialized, false);
});

test('same-entry reconnect keeps the reading prefix and rejects real missing durable boundaries', () => {
  const before = session({
    messages: ['m30', 'm31', 'm32', 'm33'].map(id => message(id)), historyStale: true,
    resumeAfter: 'm33',
  });
  const page: HistoryPage = {
    sessionId: 'session', messages: ['m32', 'm33', 'm34', 'm35'].map(id => message(id)), hasMore: true,
    append: true, resume: { status: 'ready', token: 'next' },
  };
  const next = applyResumedHistory(before, page, new Map());
  assert.deepEqual(next.messages.map(m => m.id), ['m30', 'm31', 'm32', 'm33', 'm34', 'm35']);
  assert.equal(next.historyStale, false);
  assert.equal(next.resumeToken, 'next');
  const trimmed = applyResumedHistory({ ...before, messages: before.messages.slice(3) }, page, new Map());
  assert.deepEqual(trimmed.messages.map(m => m.id), ['m33', 'm34', 'm35']);
  assert.throws(() => applyResumedHistory({ ...before, resumeAfter: 'missing-durable' }, page, new Map()), /历史同步/);
  assert.throws(() => applyResumedHistory(before, {
    ...page, messages: [message('m32'), message('m33'), message('m30', 'late old message update')],
  }, new Map()), /历史同步/);
});

test('metaToSession creates an unmaterialized stale window with independent empty messages', () => {
  const before = structuredClone(meta);
  const result = metaToSession(meta);

  assert.deepEqual(result, {
    ...meta,
    messages: [],
    materialized: false,
    historyStale: true,
    resumeAfter: undefined,
    hasMore: false,
    loadingHistory: false,
  });
  assert.notStrictEqual(result.messages, metaToSession(meta).messages);
  assert.deepEqual(meta, before);
});

test('metaToSession replaces authoritative metadata but preserves every window field', () => {
  const previous = session({
    title: 'Old title',
    cwd: '/old',
    lastActivity: 0,
    error: 'Old error',
    loaded: false,
    currentModelId: 'old-model',
    messages: [message('known')],
    materialized: true,
    historyStale: true,
    resumeAfter: 'known',
    hasMore: true,
    loadingHistory: true,
    liveMessageIds: [],
  });
  const before = structuredClone({ meta, previous });
  const result = metaToSession(meta, previous);

  assert.deepEqual(result, {
    ...meta,
    messages: [message('known')],
    materialized: true,
    historyStale: true,
    resumeAfter: 'known',
    hasMore: true,
    loadingHistory: true,
    liveMessageIds: [],
  });
  assert.notStrictEqual(result, previous);
  assert.strictEqual(result.messages, previous.messages);
  assert.deepEqual({ meta, previous }, before);
});

test('metaToSession preserves explicit false window flags and an undefined cursor', () => {
  const previous = session({ materialized: false });

  assert.deepEqual(metaToSession({ ...meta, title: 'Updated' }, previous), {
    ...previous,
    title: 'Updated',
    materialized: false,
    historyStale: false,
    resumeAfter: undefined,
    hasMore: false,
    loadingHistory: false,
  });
});

test('invalidateWindow freezes the last contiguous id without changing the loaded window', () => {
  const previous = session({
    messages: [message('older'), message('known')],
    resumeAfter: 'known',
    hasMore: true,
    loadingHistory: true,
    error: 'Disconnected',
  });
  const before = structuredClone(previous);
  const result = invalidateWindow(previous);

  assert.deepEqual(result, {
    ...before,
    historyStale: true,
    loadingHistory: false,
    resumeAfter: 'known',
  });
  assert.notStrictEqual(result, previous);
  assert.strictEqual(result.messages, previous.messages);
  assert.deepEqual(previous, before);
});

test('repeated invalidations never advance the frozen cursor past messages received across a gap', () => {
  const first = invalidateWindow(session({ messages: [message('known')], resumeAfter: 'known', hasMore: true }));
  let current = first;

  for (const id of ['live-after-reconnect', 'live-after-next-reconnect']) {
    const streaming: ChatSession = {
      ...current,
      messages: [...current.messages, message(id)],
      loadingHistory: true,
    };
    const before = structuredClone(streaming);
    current = invalidateWindow(streaming);

    assert.deepEqual(current, {
      ...before,
      historyStale: true,
      loadingHistory: false,
      resumeAfter: 'known',
    });
    assert.deepEqual(streaming, before);
  }

  assert.deepEqual(first.messages, [message('known')]);
});

test('empty windows keep an undefined resume cursor even after reconnect messages arrive', () => {
  for (const historyStale of [false, true]) {
    const previous = session({ materialized: false, historyStale, loadingHistory: true });
    const invalidated = invalidateWindow(previous);
    assert.deepEqual(invalidated, {
      ...previous,
      historyStale: true,
      loadingHistory: false,
        resumeAfter: undefined,
    });

    const streaming: ChatSession = {
      ...invalidated,
      messages: [message('live-without-history')],
      loadingHistory: true,
    };
    assert.deepEqual(invalidateWindow(streaming), {
      ...streaming,
      historyStale: true,
      loadingHistory: false,
      resumeAfter: undefined,
    });
  }
});

test('append keeps scrollback and pagination while replacing overlapping messages in page order', () => {
  const previous = session({
    messages: [message('scrollback'), message('known', 'Partial'), message('live', 'Partial')],
    historyStale: true,
    resumeAfter: 'known',
    hasMore: true,
    loadingHistory: true,
    error: 'Disconnected',
  });
  const page: HistoryPage = {
    sessionId: meta.sessionId,
    append: true,
    messages: [message('known', 'Complete'), message('missed'), message('live', 'Complete')],
    hasMore: false,
  };
  const before = structuredClone({ previous, page });
  const result = applyHistoryPage(previous, page);

  assert.deepEqual(result, {
    ...before.previous,
    messages: [message('scrollback'), ...page.messages],
    materialized: true,
    historyStale: false,
    resumeAfter: 'live',
    hasMore: true,
    loadingHistory: false,
    error: null,
  });
  assert.notStrictEqual(result, previous);
  assert.deepEqual({ previous, page }, before);
});

for (const loadingHistory of [false, true]) {
  test(`append without the frozen anchor merges messages but preserves stale state while ${loadingHistory ? 'refreshing' : 'inactive'}`, () => {
    const previous = session({
      messages: [message('scrollback'), message('known'), message('live', 'Partial')],
      historyStale: true,
      resumeAfter: 'known',
      hasMore: true,
      loadingHistory,
      error: 'Disconnected',
    });
    const page: HistoryPage = {
      sessionId: meta.sessionId,
      append: true,
      messages: [message('live', 'Complete'), message('newer')],
      hasMore: false,
    };
    const before = structuredClone({ previous, page });
    const result = applyHistoryPage(previous, page);

    assert.deepEqual(result, {
      ...before.previous,
      messages: [message('scrollback'), message('known'), ...page.messages],
    });
    assert.notStrictEqual(result, previous);
    assert.deepEqual({ previous, page }, before);
  });
}

test('an empty stale append preserves refresh state, loaded messages and hasMore', () => {
  const previous = session({
    messages: [message('known')],
    historyStale: true,
    resumeAfter: 'known',
    loadingHistory: true,
    error: 'Disconnected',
  });
  const page: HistoryPage = {
    sessionId: meta.sessionId,
    append: true,
    messages: [],
    hasMore: true,
  };

  assert.deepEqual(applyHistoryPage(previous, page), {
    ...previous,
    messages: [message('known')],
    materialized: true,
    historyStale: true,
    resumeAfter: 'known',
    hasMore: false,
    loadingHistory: true,
    error: 'Disconnected',
  });
});

test('an empty materialized stale window without a cursor waits for full latest despite append broadcasts', () => {
  const previous = session({
    historyStale: true,
    loadingHistory: true,
    error: 'History unavailable',
  });
  let current = previous;

  for (const messages of [
    [message('live', 'Partial')],
    [message('live', 'Complete'), message('newer')],
  ]) {
    const page: HistoryPage = {
      sessionId: meta.sessionId,
      append: true,
      messages,
      hasMore: true,
    };
    const before = structuredClone({ current, page });
    const result = applyHistoryPage(current, page);

    assert.deepEqual(result, { ...previous, messages });
    assert.deepEqual({ current, page }, before);
    current = result;
  }

  const latest: HistoryPage = {
    sessionId: meta.sessionId,
    latest: true,
    messages: [message('missed'), message('live', 'Complete'), message('newer')],
    hasMore: true,
  };
  const before = structuredClone({ current, latest });

  assert.deepEqual(applyHistoryPage(current, latest), {
    ...previous,
    messages: latest.messages,
    resumeToken: undefined,
    historyStale: false,
    resumeAfter: 'newer',
    hasMore: true,
    loadingHistory: false,
    error: null,
  });
  assert.deepEqual({ current, latest }, before);
});

test('cold windows ignore append pages including pending loading and error until full latest', () => {
  for (const loadingHistory of [false, true]) {
    const previous = session({
      materialized: false,
      historyStale: true,
      loadingHistory,
      error: 'History unavailable',
    });

    for (const messages of [[], [message('live')]]) {
      const page: HistoryPage = {
        sessionId: meta.sessionId,
        append: true,
        messages,
        hasMore: true,
      };
      const before = structuredClone({ previous, page });

      assert.strictEqual(applyHistoryPage(previous, page), previous);
      assert.deepEqual({ previous, page }, before);
    }

    const latest: HistoryPage = {
      sessionId: meta.sessionId,
      latest: true,
      messages: [message('missed'), message('live')],
      hasMore: true,
    };
    const before = structuredClone({ previous, latest });

    assert.deepEqual(applyHistoryPage(previous, latest), {
      ...previous,
      messages: latest.messages,
      resumeToken: undefined,
      materialized: true,
      historyStale: false,
      resumeAfter: 'live',
      hasMore: true,
      loadingHistory: false,
      error: null,
    });
    assert.deepEqual({ previous, latest }, before);
  }
});

test('already fresh windows reconcile append pages without an anchor, including empty pages', () => {
  for (const messages of [[], [message('newer')]]) {
    const previous = session({
      messages: [message('known')],
      hasMore: true,
      loadingHistory: true,
      error: 'History unavailable',
    });
    const page: HistoryPage = {
      sessionId: meta.sessionId,
      append: true,
      messages,
      hasMore: false,
    };
    const before = structuredClone({ previous, page });

    assert.deepEqual(applyHistoryPage(previous, page), {
      ...before.previous,
      messages: [...previous.messages, ...page.messages],
      historyStale: false,
      resumeAfter: messages.at(-1)?.id,
      loadingHistory: false,
      error: null,
    });
    assert.deepEqual({ previous, page }, before);
  }
});

test('latest replaces the window and pagination and clears refresh state without mutating inputs', () => {
  const previous = session({
    messages: [message('old-window')],
    historyStale: true,
    resumeAfter: 'old-window',
    hasMore: false,
    loadingHistory: true,
    error: 'Disconnected',
  });
  const page: HistoryPage = {
    sessionId: meta.sessionId,
    latest: true,
    messages: [message('recent'), message('newest')],
    hasMore: true,
  };
  const before = structuredClone({ previous, page });
  const result = applyHistoryPage(previous, page);

  assert.deepEqual(result, {
    ...before.previous,
    messages: page.messages,
    resumeToken: undefined,
    materialized: true,
    historyStale: false,
    resumeAfter: 'newest',
    hasMore: true,
    loadingHistory: false,
    error: null,
  });
  assert.notStrictEqual(result, previous);
  assert.deepEqual({ previous, page }, before);
});

test('empty latest pages materialize the session and reset stale window and pagination state', () => {
  for (const materialized of [false, true]) {
    const previous = session({
      messages: materialized ? [message('old-window')] : [],
      materialized,
      historyStale: true,
      resumeAfter: materialized ? 'old-window' : undefined,
      hasMore: materialized,
      loadingHistory: true,
      error: 'History unavailable',
    });
    const page: HistoryPage = {
      sessionId: meta.sessionId,
      latest: true,
      messages: [],
      hasMore: false,
    };

    assert.deepEqual(applyHistoryPage(previous, page), {
      ...previous,
      messages: [],
      resumeToken: undefined,
      materialized: true,
      historyStale: false,
      resumeAfter: undefined,
      hasMore: false,
      loadingHistory: false,
      error: null,
    });
  }
});

test('prepend keeps existing overlap and pending stale refresh state while updating hasMore', () => {
  for (const materialized of [false, true]) {
    const previous = session({
      messages: [message('boundary', 'Existing version'), message('known')],
      materialized,
      historyStale: true,
      resumeAfter: 'known',
      hasMore: true,
      loadingHistory: true,
      error: 'Disconnected',
    });
    const page: HistoryPage = {
      sessionId: meta.sessionId,
      messages: [message('oldest'), message('older'), message('boundary', 'Page version')],
      hasMore: false,
    };
    const before = structuredClone({ previous, page });
    const result = applyHistoryPage(previous, page);

    assert.deepEqual(result, {
      ...before.previous,
      messages: [message('oldest'), message('older'), ...before.previous.messages],
      hasMore: false,
      materialized,
      historyStale: true,
      resumeAfter: 'known',
      loadingHistory: true,
      error: 'Disconnected',
    });
    assert.notStrictEqual(result, previous);
    assert.deepEqual({ previous, page }, before);
  }
});

test('ordinary fresh prepends clear loading while preserving the rest of the window state', () => {
  const previous = session({
    messages: [message('boundary', 'Existing version'), message('newest')],
    hasMore: true,
    loadingHistory: true,
  });
  const page: HistoryPage = {
    sessionId: meta.sessionId,
    messages: [message('older'), message('boundary', 'Page version')],
    hasMore: false,
  };
  const before = structuredClone({ previous, page });

  assert.deepEqual(applyHistoryPage(previous, page), {
    ...before.previous,
    messages: [message('older'), ...before.previous.messages],
    hasMore: false,
    loadingHistory: false,
  });
  assert.deepEqual({ previous, page }, before);
});

for (const kind of ['latest', 'append', 'prepend'] as const) {
  test(`${kind} overlays streamed same-id replacements and newly streamed messages without mutating inputs`, () => {
    const previous = session({
      messages: [message('anchor', 'before request'), message('live', 'newest live')],
      loadingHistory: true,
    });
    const page: HistoryPage = {
      sessionId: meta.sessionId, hasMore: true,
      ...(kind === 'latest' ? { latest: true } : kind === 'append' ? { append: true } : {}),
      messages: [message('anchor', 'HTTP fold'), message('from-page')],
    };
    const streamed = new Map([
      ['anchor', message('anchor', 'stream overwritten same id')],
      ['live', message('live', 'newest live')],
    ]);
    const before = structuredClone({ previous, page, streamed });
    const result = applyHistoryPage(previous, page, streamed);
    assert.equal(result.messages.find((m) => m.id === 'anchor')?.content, 'stream overwritten same id');
    assert.equal(result.messages.find((m) => m.id === 'live')?.content, 'newest live');
    assert.equal(result.messages.filter((m) => m.id === 'anchor').length, 1);
    assert.deepEqual({ previous, page, streamed }, before);
  });
}

test('append puts streamed tail messages absent from HTTP after the reconciled tail, not before the anchor', () => {
  const result = applyHistoryPage(session({
    messages: [message('older'), message('anchor'), message('live')],
    historyStale: true, resumeAfter: 'anchor',
  }), {
    sessionId: meta.sessionId, append: true, hasMore: false,
    messages: [message('anchor'), message('missed')],
  }, new Map([['live', message('live')]]));
  assert.deepEqual(result.messages.map((m) => m.id), ['older', 'anchor', 'missed', 'live']);
});

test('authoritative append removes a cached suffix absent from HTTP, preserving only current-request streaming', () => {
  const previous = session({
    messages: [message('older'), message('A'), message('B'), message('C'), message('during')],
    historyStale: true, resumeAfter: 'A', hasMore: true, loadingHistory: true,
  });
  const page: HistoryPage = {
    sessionId: meta.sessionId, append: true, hasMore: false, messages: [message('A', 'HTTP')],
  };
  const streamed = new Map([
    ['older', message('older', 'current prefix delta')],
    ['A', message('A', 'current cursor delta')],
    ['during', message('during')],
  ]);
  const before = structuredClone({ previous, page, streamed });
  const result = applyHistoryPage(previous, page, streamed);

  assert.deepEqual(result.messages, [...streamed.values()]);
  assert.equal(result.historyStale, false);
  assert.equal(result.resumeAfter, 'A');
  assert.equal(result.loadingHistory, false);
  assert.equal(result.hasMore, true);
  assert.deepEqual({ previous, page, streamed }, before);
  assert.deepEqual(applyHistoryPage(previous, page).messages, [message('older'), ...page.messages]);
});

test('replacement without an overlay discards all old messages, including previous streaming', () => {
  const previous = session({ messages: [message('removed'), message('old-stream')] });
  const result = applyHistoryPage(previous, {
    sessionId: meta.sessionId, messages: [message('reset')], latest: true, hasMore: false,
  });
  assert.deepEqual(result.messages, [message('reset')]);
});

test('history refuses pages for a different session', () => {
  assert.throws(() => applyHistoryPage(session(), {
    sessionId: 'another-viewer', messages: [], hasMore: false, latest: true,
  }), /sessionId mismatch/);
});

test('streamed messages before the latest HTTP boundary remain available through contiguous older pagination', () => {
  const messages = Array.from({ length: 31 }, (_, i) => message(String(i + 1)));
  const result = applyHistoryPage(session({ messages, materialized: false, historyStale: true }), {
    sessionId: meta.sessionId, latest: true, hasMore: true, messages: messages.slice(1),
  }, new Map(messages.map((m) => [m.id, m])));
  assert.deepEqual(result.messages, messages.slice(1));
  assert.equal(result.messages[0].id, '2');
  assert.equal(invalidateWindow(result).resumeAfter, '31');
  const paginated = applyHistoryPage(result, {
    sessionId: meta.sessionId, messages: [message('0'), message('1')], hasMore: false,
  });
  assert.deepEqual(paginated.messages, [message('0'), ...messages]);
});
