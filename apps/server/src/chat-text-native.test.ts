import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Intents, type ChatTextMessage, type ChatTextPage, type ChatTextRead, type IntentBody, type IntentName, type IntentResult } from '@cockpit/protocol';
import { sessionMetaBusy } from '../../../packages/core/test-support/lifecycle.ts';

test('persisted text checkpoints and partial cursors survive a complete HTTP Host process restart', {
  skip: process.env.COCKPIT_NATIVE_CHAT_TEXT !== '1', timeout: 115_000,
}, async t => {
  const root = resolve(`.cockpit-chat-text-native-${randomUUID()}`);
  const dirs = Object.fromEntries(['home', 'copilot', 'cockpit', 'work', 'cache', 'config', 'run']
    .map(name => [name, join(root, name)]));
  await Promise.all(Object.values(dirs).map(path => mkdir(path, { recursive: true })));
  const fixture = join(root, 'consumer.json');
  const longText = '重启后逐字恢复中文🙂🧑‍💻，不要丢失片段。\n'.repeat(700);
  const expected = new Map<string, string>();
  const providerErrors: string[] = [];
  let requests = 0;
  const provider = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      assert.ok(!req.headers.authorization || req.headers.authorization.trim() === 'Bearer');
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      const prompt = JSON.stringify(body.messages.findLast((message: { role: string }) => message.role === 'user').content);
      const key = [...expected.keys()].find(key => prompt.includes(key));
      assert.ok(key, 'Only explicitly registered synthetic prompts reach the loopback provider');
      requests++;
      const chunk = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({
        id: 'text-fixture', object: 'chat.completion.chunk', created: 1, model: body.model,
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(chunk({ role: 'assistant', content: expected.get(key) }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
    } catch (error) {
      providerErrors.push(String(error));
      res.writeHead(500).end('Synthetic provider rejected request');
    }
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  assert.ok(address && typeof address !== 'string');
  const env = {
    HOME: dirs.home, COPILOT_HOME: dirs.copilot, COCKPIT_HOME: dirs.cockpit,
    XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.copilot,
    XDG_RUNTIME_DIR: dirs.run, TMPDIR: root, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
    COPILOT_DISABLE_KEYTAR: '1', COPILOT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dirs.config!, 'gitconfig'),
    GIT_CEILING_DIRECTORIES: root, COCKPIT_NO_BOOT: '1', COCKPIT_SERVE_WEB: '0',
    LOG_LEVEL: 'silent', COCKPIT_PORT: '0', FIXTURE_PROVIDER_URL: `http://127.0.0.1:${address.port}/v1`,
  };
  const children: ChildProcess[] = [];
  let hostUrl = '';
  const bounded = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      })]);
    } finally { clearTimeout(timer); }
  };
  const start = async () => {
    const child = fork(fileURLToPath(new URL('./test-support/chat-text-host.ts', import.meta.url)), [], {
      cwd: dirs.work, env,
      execArgv: ['--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url))],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child);
    let logs = '';
    child.stdout!.on('data', data => { logs = (logs + String(data)).slice(-12_000); });
    child.stderr!.on('data', data => { logs = (logs + String(data)).slice(-12_000); });
    const ready = await bounded(new Promise<{ pid: number; url: string }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`Host exited ${code}/${signal}: ${logs}`)));
      child.once('message', message => resolve(message as { pid: number; url: string }));
    }), 20_000, 'Host startup');
    assert.equal(ready.pid, child.pid);
    hostUrl = ready.url;
    return child;
  };
  const raw = async (name: string, body: object) => {
    const response = await fetch(`${hostUrl}/intent/${name}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    return { status: response.status, text, value: JSON.parse(text) };
  };
  const post = async <K extends IntentName>(name: K, body: IntentBody<K>): Promise<IntentResult<K>> => {
    const response = await raw(name, body);
    assert.equal(response.status, 200, response.text);
    return Intents[name].result.parse(response.value) as IntentResult<K>;
  };
  const stop = async (child: ChildProcess) => {
    const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    await post('system/shutdown', { confirm: true });
    assert.deepEqual(await bounded(exited, 15_000, 'Graceful Host exit'), { code: 0, signal: null });
    assert.equal(child.exitCode, 0);
  };
  const idle = async (sessionId: string) => {
    let stable = 0;
    const deadline = Date.now() + 12_000;
    while (stable < 2 && Date.now() < deadline) {
      const { meta } = await post('session/get', { sessionId });
      stable = meta?.loaded && meta.status === 'idle' && !sessionMetaBusy(meta) ? stable + 1 : 0;
      await sleep(25);
    }
    assert.equal(stable, 2, 'Synthetic native prompt must finish before unloading');
  };
  const send = async (sessionId: string, key: string, answer = `回答 ${key} 🙂`) => {
    expected.set(key, answer);
    const receipt = await post('prompt', { sessionId, text: key });
    assert.equal(receipt.ok, true);
    await idle(sessionId);
    return receipt.messageId;
  };
  const unloaded = async (sessionId: string) => {
    const { meta } = await post('session/get', { sessionId });
    assert.ok(meta);
    assert.equal(meta.loaded, false, 'Passive persisted reads must not implicitly resume the session');
  };
  const read = async (query: Partial<ChatTextRead> & { sessionId: string }): Promise<ChatTextPage> => {
    const response = await raw('session/chat/text', { source: 'persisted', direction: 'backward',
      max: 2, maxBytes: 8192, scanPages: 1, ...query });
    assert.equal(response.status, 200, response.text);
    assert.ok(Buffer.byteLength(response.text, 'utf8') <= (query.maxBytes ?? 8192));
    const page = Intents['session/chat/text'].result.parse(response.value);
    assert.ok(page.read.pages <= (query.scanPages ?? 1));
    assert.ok(page.read.events <= 16 * (query.scanPages ?? 1));
    if (query.since && (page.hasMore || page.scanLimited || page.messages.some(message => message.nextOffset !== null))) {
      assert.equal(page.checkpoint, undefined, 'Never advance the consumer checkpoint before all fragments are delivered');
    }
    return page;
  };
  const pieces = new Map<string, Map<number, ChatTextMessage>>();
  const collect = (page: Pick<ChatTextPage, 'messages'>) => {
    for (const message of page.messages) {
      const fragments = pieces.get(message.eventId) ?? new Map<number, ChatTextMessage>();
      const previous = fragments.get(message.offset);
      if (previous) assert.deepEqual(message, previous, 'Replayed fragments must agree exactly');
      fragments.set(message.offset, message);
      pieces.set(message.eventId, fragments);
      assert.ok(!/[\uD800-\uDBFF]$/.test(message.content), 'A UTF-16 fragment must not split an emoji surrogate pair');
    }
  };
  const complete = async (sessionId: string, since: string, cursor?: string) => {
    let pages = 0;
    while (pages++ < 100) {
      const page = await read({ sessionId, since, cursor });
      collect(page);
      if (page.checkpoint) return { checkpoint: page.checkpoint, pages };
      assert.ok(page.hasMore || page.scanLimited);
      cursor = page.cursor;
    }
    assert.fail('Incremental scan exceeded its bounded fixture page count');
  };
  const contents = () => [...pieces.values()].map(fragments => {
    let next = 0;
    let text = '';
    for (const fragment of [...fragments.values()].sort((a, b) => a.offset - b.offset)) {
      assert.equal(fragment.offset, next, 'No lost or overlapping UTF-16 fragments');
      text += fragment.content;
      next += fragment.content.length;
    }
    assert.equal(next, [...fragments.values()][0]!.totalCharacters);
    return text;
  }).sort();
  try {
    const first = await start();
    const { sessionId } = await post('session/new', { cwd: dirs.work! });
    await post('session/rename', { sessionId, name: 'Synthetic text restart fixture' });
    const baseline = await read({ sessionId, max: 64, scanPages: 16 });
    assert.deepEqual(baseline.messages, [], 'The native start/rename events carry no primary message bodies');
    assert.ok(baseline.checkpoint);
    assert.equal(requests, 0);
    for (let i = 0; i < 4; i++) await send(sessionId, `TEXT_FIXTURE_BEFORE_${i}`);
    await send(sessionId, 'TEXT_FIXTURE_LONG', longText);
    for (let i = 0; i < 4; i++) await send(sessionId, `TEXT_FIXTURE_LATER_${i}`);
    await post('session/unload', { sessionId });
    let partial = await read({ sessionId, since: baseline.checkpoint });
    let scanned = partial.read.events;
    collect(partial);
    for (let pages = 0; !partial.messages.some(message => message.nextOffset !== null) && pages < 30; pages++) {
      assert.equal(partial.checkpoint, undefined);
      partial = await read({ sessionId, since: baseline.checkpoint, cursor: partial.cursor });
      scanned += partial.read.events;
      collect(partial);
    }
    assert.ok(partial.messages.some(message => message.nextOffset !== null), 'Persist a real partial Chinese/emoji body');
    assert.ok(scanned > 16, 'Save a partial body after traversing native page boundaries');
    assert.equal(partial.checkpoint, undefined);
    await writeFile(fixture, JSON.stringify({
      sessionId, since: baseline.checkpoint, cursor: partial.cursor,
      fragments: [...pieces.values()].flatMap(fragments => [...fragments.values()]), expected: [...expected.entries()],
    }));
    await stop(first);
    const second = await start();
    assert.notEqual(second.pid, first.pid, 'Restart the entire Host OS process, not only its Engine or native child');
    t.diagnostic(`Host1 PID ${first.pid} exited with code 0 before Host2 PID ${second.pid} started`);
    const saved = JSON.parse(await readFile(fixture, 'utf8')) as {
      sessionId: string; since: string; cursor: string; fragments: ChatTextMessage[]; expected: [string, string][];
    };
    assert.equal(saved.since, baseline.checkpoint);
    assert.equal(saved.cursor, partial.cursor);
    pieces.clear();
    collect({ messages: saved.fragments });
    const listed = await post('session/list', {});
    assert.ok(listed.sessions.some(session => session.sessionId === sessionId));
    await unloaded(saved.sessionId);
    const resumed = await raw('session/chat/text', {
      sessionId: saved.sessionId, source: 'persisted', direction: 'backward',
      since: saved.since, cursor: saved.cursor, max: 2, maxBytes: 8192, scanPages: 1,
    });
    let cursor: string | undefined;
    if (resumed.status === 200) {
      assert.ok(Buffer.byteLength(resumed.text, 'utf8') <= 8192);
      const page = Intents['session/chat/text'].result.parse(resumed.value);
      assert.equal(page.checkpoint, undefined);
      assert.ok(page.read.pages <= 1);
      collect(page);
      cursor = page.cursor;
      t.diagnostic('Native partial-page cursor resumed across full Host restart');
    } else {
      assert.match(resumed.text, /cursor.*expired|CURSOR_EXPIRED|TEXT_PAGE_CHANGED/i);
      assert.doesNotMatch(resumed.text, /signature|HMAC|TEXT_POSITION_FORMAT/i);
      t.diagnostic(`Native cursor could not resume (${resumed.text}); explicitly restart from the unchanged persisted since and deduplicate eventId/offset`);
    }
    const delivered = await complete(sessionId, saved.since, cursor);
    assert.ok(delivered.pages > 1, 'The consumer must span bounded native pages and long-message fragments');
    assert.deepEqual(contents(), saved.expected.flatMap(([key, answer]) => [key, answer]).sort());
    assert.equal(JSON.parse(await readFile(fixture, 'utf8')).since, saved.since);
    await unloaded(sessionId);
    assert.equal(requests, saved.expected.length, 'History reads and process restart send no hidden prompts');

    await send(sessionId, 'TEXT_FIXTURE_POST_RESTART');
    await post('session/unload', { sessionId });
    pieces.clear();
    const originalBoundary = await complete(sessionId, saved.since);
    assert.ok(originalBoundary.pages > 1);
    assert.deepEqual(contents(), [...saved.expected, ['TEXT_FIXTURE_POST_RESTART', expected.get('TEXT_FIXTURE_POST_RESTART')!]]
      .flatMap(([key, answer]) => [key, answer]).sort(),
    'The original externally saved checkpoint also reads source appends made after the complete Host restart');
    delivered.checkpoint = originalBoundary.checkpoint;
    await writeFile(fixture, JSON.stringify({ ...saved, since: delivered.checkpoint, cursor: undefined, fragments: [] }));
    await unloaded(sessionId);

    pieces.clear();
    await send(sessionId, 'TEXT_FIXTURE_AFTER', longText + '追加');
    await post('session/unload', { sessionId });
    const next = await read({ sessionId, since: delivered.checkpoint });
    collect(next);
    await send(sessionId, 'TEXT_FIXTURE_CONCURRENT');
    await post('session/unload', { sessionId });
    // An append can invalidate the current head page. Public recovery retains the
    // previous completed checkpoint, discards the partial cursor, and deduplicates.
    const concurrent = await complete(sessionId, delivered.checkpoint);
    assert.deepEqual(contents(), ['TEXT_FIXTURE_AFTER', expected.get('TEXT_FIXTURE_AFTER')!,
      'TEXT_FIXTURE_CONCURRENT', expected.get('TEXT_FIXTURE_CONCURRENT')!].sort());
    await unloaded(sessionId);
    const noChange = await read({ sessionId, since: concurrent.checkpoint });
    assert.deepEqual(noChange.messages, []);
    assert.ok(noChange.checkpoint);

    const concurrentEvent = [...pieces.values()].flatMap(fragments => [...fragments.values()])
      .find(message => message.role === 'user' && message.content === 'TEXT_FIXTURE_CONCURRENT');
    assert.ok(concurrentEvent);
    await post('session/load', { sessionId });
    const rewind = await post('session/rewind', { sessionId, toMsgId: concurrentEvent.eventId, rollbackFiles: false });
    assert.equal(rewind.result.outcome, 'success');
    assert.ok((rewind.result.eventsRemoved ?? 0) > 0);
    await post('session/unload', { sessionId });
    let removed: Awaited<ReturnType<typeof raw>> | undefined;
    let removalCursor: string | undefined;
    for (let pages = 0; pages < 20; pages++) {
      removed = await raw('session/chat/text', {
        sessionId, since: concurrent.checkpoint, cursor: removalCursor, source: 'persisted', direction: 'backward',
        max: 64, maxBytes: 65536, scanPages: 16,
      });
      if (removed.status !== 200) break;
      assert.ok(Buffer.byteLength(removed.text, 'utf8') <= 65536);
      const page = Intents['session/chat/text'].result.parse(removed.value);
      assert.equal(page.checkpoint, undefined, 'Rewind removed the saved boundary, so no completed increment is valid');
      removalCursor = page.cursor;
    }
    assert.ok(removed);
    assert.notEqual(removed.status, 200, 'A removed checkpoint must not masquerade as an empty increment');
    assert.match(removed.text, /TEXT_CHECKPOINT_(MISSING|CHANGED)/);
    assert.deepEqual(providerErrors, []);
    assert.equal(requests, expected.size, 'Only the explicit fixture prompts invoked the provider');
    await stop(second);
  } finally {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      try { await bounded(exited, 10_000, 'Fixture cleanup'); }
      catch { child.kill('SIGKILL'); await bounded(exited, 5_000, 'Owned Host kill'); }
    }
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
