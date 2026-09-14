import assert from 'node:assert/strict';
import { after, beforeEach, test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NativeChatPage, NativeChatRead } from '@cockpit/protocol';
import { z } from 'zod';
import { readNativeChat } from '../../../../packages/core/src/native-chat.ts';
import { mockHttp } from '../../test-support/mock-http.ts';

type Readers = Parameters<typeof readNativeChat>[1];
type Event = Awaited<ReturnType<Readers['persisted']>>['events'][number];
type ReadParams = Parameters<NonNullable<Readers['live']>['read']>[0];
const event = (id: string, content = id): Event => ({
  id, parentId: null, timestamp: '2026-09-10T00:00:00.000Z',
  type: 'assistant.message', data: { messageId: id, content },
});
let events: Event[] = [];
let tailCursor = 'tail-before-page';
let override: Partial<NativeChatPage> = {};
let unloaded = false;
const nativeCalls: { method: 'persisted' | 'read' | 'tail'; params?: unknown }[] = [];
const requests: NativeChatRead[] = [];
const deliveredPages: NativeChatPage[] = [];
const unused = async (): Promise<never> => { throw new Error('Unexpected native method'); };

function nativePage(params: ReadParams) {
  const selected = events.filter(item =>
    (!params.types || params.types.includes('*') || params.types.includes(item.type))
    && (!params.agentIds || params.agentIds.includes(item.agentId ?? 'primary'))
    && (params.agentIds || params.agentScope !== 'primary' || !item.agentId));
  const boundary = params.cursor ? Number(params.cursor.slice('index/'.length))
    : params.direction === 'backward' ? selected.length : 0;
  assert.ok(Number.isInteger(boundary));
  const start = params.direction === 'backward' ? Math.max(0, boundary - params.max!) : boundary;
  const end = params.direction === 'backward' ? boundary : Math.min(selected.length, start + params.max!);
  return {
    events: selected.slice(start, end), cursor: `index/${params.direction === 'backward' ? start : end}`,
    hasMore: params.direction === 'backward' ? start > 0 : end < selected.length, cursorStatus: 'ok' as const,
  };
}

const readers: Readers = {
  persisted: async params => {
    nativeCalls.push({ method: 'persisted', params });
    return nativePage(params);
  },
  live: {
    read: async params => { nativeCalls.push({ method: 'read', params }); return nativePage(params); },
    tail: async () => { nativeCalls.push({ method: 'tail' }); return { cursor: tailCursor }; },
    registerInterest: unused, releaseInterest: unused,
  },
};

mockHttp(async (response, request) => {
  assert.equal(request.url, '/intent/session/chat');
  try {
    const query = NativeChatRead.parse(JSON.parse(request.body.toString()));
    requests.push(query);
    const page = {
      ...await readNativeChat(query, unloaded ? { persisted: readers.persisted } : readers), ...override,
    };
    deliveredPages.push(page);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(page));
  } catch (error) {
    response.writeHead(400, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});
const { registerTranscriptTools } = await import('./transcript.ts');
const { CHARACTER_LIMIT } = await import('../config.ts');
const server = new McpServer({ name: 'isolated-history-pages', version: '1' });
registerTranscriptTools(server);
const client = new Client({ name: 'history-pages-test', version: '1' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
after(async () => { await client.close(); await server.close(); });
beforeEach(() => {
  events = [event('one')];
  tailCursor = 'tail-before-page';
  override = {};
  unloaded = false;
  nativeCalls.length = requests.length = deliveredPages.length = 0;
});

const Reply = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })).nonempty(),
  isError: z.boolean().optional(),
});
const Fragment = z.object({
  format: z.literal('json-fragment'), pageVersion: z.string().regex(/^[a-f0-9]{64}$/),
  pageOffset: z.number(), nextPageOffset: z.number().nullable(), pageCharacters: z.number(),
  read: z.object({ rpc: z.number(), events: z.number() }), json: z.string(),
});
async function call(args: Record<string, unknown> = {}) {
  const result = Reply.parse(await client.callTool({
    name: 'cockpit_read_session', arguments: { session_id: 'fixture', response_format: 'json', ...args },
  }));
  return { text: result.content[0].text, isError: result.isError ?? false };
}
async function json(args: Record<string, unknown> = {}): Promise<unknown> {
  const reply = await call(args);
  assert.equal(reply.isError, false, reply.text);
  return JSON.parse(reply.text);
}
function countPageSerializations(t: TestContext): number[] {
  const lengths: number[] = [];
  const stringify = JSON.stringify;
  t.mock.method(JSON, 'stringify', (...args: Parameters<typeof JSON.stringify>) => {
    const result = stringify(...args);
    const [value, , space] = args;
    if (space === 2 && value && typeof value === 'object' && 'events' in value && 'cursorStatus' in value) {
      lengths.push(result.length);
    }
    return result;
  });
  return lengths;
}
const giant = 'x'.repeat(50_600);

test('schema advertises a native default of 16 and local-only giant fragments', async () => {
  const tool = (await client.listTools()).tools[0]!;
  const limit = z.object({ default: z.number(), minimum: z.number(), maximum: z.number() })
    .parse(tool.inputSchema.properties?.limit);
  assert.deepEqual(limit, { default: 16, minimum: 1, maximum: 256 });
  assert.match(tool.description!, /no automatic retry or bisection/i);
  assert.match(tool.description!, /No native body offset, cache, or saved copy/);
  assert.equal(requests.length, 0);
});

test('only current transcript inputs are published and unknown fields never dispatch', async () => {
  const tool = (await client.listTools()).tools[0]!;
  const fields = {
    operation: 'history', tool_call_id: 'child', details: 'summary',
    before_message_id: 'before', after_message_id: 'after', unexpected: 'value',
  };
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.doesNotMatch(tool.description!, /CHAT_PROTOCOL_CHANGED|retired/i);
  for (const [key, value] of Object.entries(fields)) {
    assert.equal(key in tool.inputSchema.properties!, false);
    for (const field of [value, null, false]) {
      const reply = await call({ [key]: field });
      assert.equal(reply.isError, true, key);
      assert.match(reply.text, /unrecognized/i);
    }
  }
  assert.equal(requests.length, 0);
  assert.equal(nativeCalls.length, 0);
});

test('ordinary default pages are genuinely narrower native reads with complete events and boundaries', async t => {
  events = Array.from({ length: 40 }, (_, index) => event(`${index}`, 'a'.repeat(1000)));
  const serializations = countPageSerializations(t);
  const page = NativeChatPage.parse(await json());
  assert.deepEqual(page.events.map(item => item.id), events.slice(-16).map(item => item.id));
  assert.equal(page.hasMore, true);
  assert.equal(page.cursor, 'index/24');
  assert.deepEqual(page.read, { rpc: 1, events: 16 });
  assert.deepEqual(nativeCalls, [{
    method: 'persisted', params: { sessionId: 'fixture', max: 16, direction: 'backward', cursor: undefined },
  }]);
  assert.equal(serializations.length, 1);
  assert.ok(serializations[0]! <= CHARACTER_LIMIT);
  const older = NativeChatPage.parse(await json({ cursor: page.cursor }));
  assert.deepEqual(older.events.map(item => item.id), events.slice(8, 24).map(item => item.id));
  assert.equal(nativeCalls.length, 2);
});

test('large multi-event pages fail once, then explicit native smaller pages cover every event without fragments', async t => {
  events = Array.from({ length: 64 }, (_, index) => event(`${index}`, 'a'.repeat(1500)));
  const serializations = countPageSerializations(t);
  const large = await call({ limit: 64, cursor: 'index/64' });
  assert.equal(large.isError, true);
  assert.match(large.text, /NATIVE_PAGE_TOO_LARGE/);
  assert.match(large.text, /original input cursor/);
  assert.doesNotMatch(large.text, /pageVersion|nextPageOffset|index\/0/);
  assert.equal(nativeCalls.length, 1, 'no automatic limit bisection or retry');
  assert.equal(serializations.length, 1);
  assert.ok(serializations[0]! > CHARACTER_LIMIT);

  const invalid = await call({ limit: 64, page_offset: 8000, page_version: '0'.repeat(64) });
  assert.equal(invalid.isError, true);
  assert.match(invalid.text, /requires limit:1/);
  assert.equal(nativeCalls.length, 1, 'cannot continue large ordinary pages as text fragments');
  let cursor = 'index/64';
  const ids: string[] = [];
  for (let index = 0; index < 16; index++) {
    const page = NativeChatPage.parse(await json({ limit: 4, cursor }));
    ids.unshift(...page.events.map(item => item.id));
    cursor = page.cursor;
    assert.equal(page.hasMore, index < 15);
    assert.equal(nativeCalls.length, index + 2);
  }
  assert.deepEqual(ids, events.map(item => item.id));
  assert.equal(serializations.length, 17);
  assert.ok(serializations.slice(1).every(length => length <= CHARACTER_LIMIT));
  assert.deepEqual(requests.map(query => query.max), [64, ...Array<number>(16).fill(4)]);
});

test('even one giant returned under a wider limit requires explicit limit:1 before fragment delivery', async () => {
  events = [event('one', giant)];
  const result = await call();
  assert.equal(result.isError, true);
  assert.match(result.text, /1 events.*limit:1/);
  assert.equal(nativeCalls.length, 1);
  const fragment = Fragment.parse(await json({ limit: 1 }));
  assert.equal(fragment.pageOffset, 0);
  assert.equal(nativeCalls.length, 2);
});

test('the 25000-character boundary returns a complete page and overflow requires limit:1', async () => {
  const emptyPage = await readNativeChat(NativeChatRead.parse({
    sessionId: 'fixture', max: 1, includeEphemeral: false,
  }), readers);
  const overhead = JSON.stringify(emptyPage, null, 2).length - 'one'.length;
  nativeCalls.length = 0;
  events = [event('one', 'x'.repeat(CHARACTER_LIMIT - overhead))];
  const exact = await call({ limit: 1 });
  assert.equal(exact.isError, false);
  assert.equal(exact.text.length, CHARACTER_LIMIT);
  assert.equal(NativeChatPage.parse(JSON.parse(exact.text)).events.length, 1);
  events = [event('one', 'x'.repeat(CHARACTER_LIMIT - overhead + 1))];
  assert.match((await call()).text, /NATIVE_PAGE_TOO_LARGE/);
  const fragment = Fragment.parse(await json({ limit: 1 }));
  assert.equal(fragment.pageCharacters, CHARACTER_LIMIT + 1);
  assert.equal(fragment.json.length, 8000);
  assert.equal(nativeCalls.length, 3);
});

for (const query of [
  { source: 'persisted' },
  { source: 'live', direction: 'backward' },
  { source: 'live', direction: 'backward', bootstrap: true },
  { source: 'live', direction: 'forward', include_ephemeral: true, wait_ms: 1000 },
]) {
  test(`giant fragments are lossless with measured rereads and serializations: ${JSON.stringify(query)}`, async t => {
    events = [event('one', giant)];
    const serializations = countPageSerializations(t);
    const chunks: string[] = [];
    let offset: number | null = 0;
    let version: string | undefined;
    let pageCharacters = 0;
    while (offset !== null) {
      const reply = await call({ ...query, limit: 1, page_offset: offset, page_version: version });
      assert.equal(reply.isError, false, reply.text);
      assert.ok(reply.text.length <= CHARACTER_LIMIT);
      const part = Fragment.parse(JSON.parse(reply.text));
      assert.equal(part.pageOffset, offset);
      if (version) assert.equal(part.pageVersion, version);
      assert.deepEqual(part.read, { rpc: query.bootstrap ? 2 : 1, events: 1 });
      chunks.push(part.json);
      version = part.pageVersion;
      pageCharacters = part.pageCharacters;
      offset = part.nextPageOffset;
    }
    const serialized = chunks.join('');
    assert.equal(serialized.length, pageCharacters);
    assert.equal(chunks.length, Math.ceil(pageCharacters / 8000));
    assert.equal(chunks.length, 7);
    assert.deepEqual(NativeChatPage.parse(JSON.parse(serialized)), deliveredPages[0]);
    assert.deepEqual(serializations, Array<number>(7).fill(pageCharacters));
    assert.equal(serializations.reduce((sum, value) => sum + value, 0), pageCharacters * 7);
    assert.equal(nativeCalls.filter(call => call.method !== 'tail').length, 7);
    assert.equal(nativeCalls.filter(call => call.method === 'tail').length, query.bootstrap ? 7 : 0);
    assert.deepEqual(requests, Array(7).fill(requests[0]));
    t.diagnostic(`page=${pageCharacters} JS code units; 7 native page reads; `
      + `${query.bootstrap ? 7 : 0} native tails; ${pageCharacters * 7} local page-serialization code units`);
  });
}

test('escaped text and Unicode survive arbitrary fragment boundaries in markdown mode', async () => {
  const content = 'line\n"quoted"\\\t\u0000😀中'.repeat(2200);
  events = [event('unicode', content)];
  let offset: number | null = 0;
  let version: string | undefined;
  let serialized = '';
  while (offset !== null) {
    const reply = await call({ limit: 1, response_format: 'markdown', page_offset: offset, page_version: version });
    assert.equal(reply.isError, false, reply.text);
    assert.ok(reply.text.length <= CHARACTER_LIMIT);
    const fragment = Fragment.parse(JSON.parse(reply.text));
    serialized += fragment.json;
    offset = fragment.nextPageOffset;
    version = fragment.pageVersion;
  }
  assert.equal(NativeChatPage.parse(JSON.parse(serialized)).events[0]!.data.content, content);
});

for (const change of ['content', 'boundary', 'tail', 'expired'] as const) {
  test(`fragment continuation rejects ${change} changes without mixed content or hidden retry`, async () => {
    events = [event('one', giant)];
    const query = { source: 'live', bootstrap: true, limit: 1 };
    const first = Fragment.parse(await json(query));
    if (change === 'content') events = [event('one', 'y'.repeat(giant.length))];
    if (change === 'boundary') override = { cursor: 'another-native-boundary' };
    if (change === 'tail') tailCursor = 'tail-after-append';
    if (change === 'expired') override = { cursorStatus: 'expired' };
    const reply = await call({ ...query, page_offset: first.nextPageOffset, page_version: first.pageVersion });
    assert.equal(reply.isError, true);
    assert.match(reply.text, change === 'expired' ? /NATIVE_CURSOR_EXPIRED/ : /native page changed/);
    assert.deepEqual(nativeCalls.map(call => call.method), ['tail', 'read', 'tail', 'read']);
    assert.equal(requests.length, 2);
  });
}

for (const changed of [
  { types: ['*'] }, { agent_scope: 'primary' }, { agent_ids: ['primary'] },
  { cursor: 'index/0' }, { include_ephemeral: true }, { wait_ms: 1 },
  { source: 'persisted' }, { direction: 'backward' }, { session_id: 'other' },
]) {
  test(`version binds the native query, not just matching content: ${JSON.stringify(changed)}`, async () => {
    events = [event('one', giant)];
    const query = { source: 'live', direction: 'forward', limit: 1 };
    const first = Fragment.parse(await json(query));
    const reply = await call({
      ...query, ...changed, page_offset: first.nextPageOffset, page_version: first.pageVersion,
    });
    assert.equal(reply.isError, true);
    assert.match(reply.text, /native page changed or the query differs/);
    assert.equal(nativeCalls.length, 2);
    assert.equal(requests.length, 2);
  });
}

test('all-agent and explicit child filters reach the native reader unchanged', async () => {
  events = [event('parent'), { ...event('child'), agentId: 'child-agent', parentToolCallId: 'parent-tool' }];
  const page = NativeChatPage.parse(await json({ source: 'live' }));
  assert.equal(page.events.length, 2);
  assert.equal(page.events[1]!.agentId, 'child-agent');
  assert.equal(page.events[1]!.parentToolCallId, 'parent-tool');
  const child = NativeChatPage.parse(await json({
    source: 'live', direction: 'forward', cursor: 'index/0', agent_scope: 'all',
    agent_ids: ['child-agent'], types: ['assistant.message'], limit: 2,
  }));
  assert.deepEqual(child.events.map(item => item.id), ['child']);
  assert.deepEqual(nativeCalls[1], { method: 'read', params: {
    cursor: 'index/0', max: 2, direction: 'forward', waitMs: 0, includeEphemeral: false,
    types: ['assistant.message'], agentScope: 'all', agentIds: ['child-agent'],
  } });
});

test('expired small pages remain explicit native envelopes; oversized expired pages cannot start fragments', async () => {
  override = { cursorStatus: 'expired' };
  assert.equal(NativeChatPage.parse(await json({ cursor: 'index/1' })).cursorStatus, 'expired');
  events = [event('one', giant)];
  const reply = await call({ limit: 1 });
  assert.equal(reply.isError, true);
  assert.match(reply.text, /NATIVE_CURSOR_EXPIRED/);
  assert.equal(nativeCalls.length, 2);
});

for (const args of [
  { types: ['assistant.message'] }, { agent_ids: ['child'] }, { agent_scope: 'primary' },
  { include_ephemeral: true }, { wait_ms: 1 },
  { source: 'live', wait_ms: 1 }, { source: 'live', include_ephemeral: true },
  { source: 'live', bootstrap: true, cursor: 'index/1' },
  { source: 'live', direction: 'forward', bootstrap: true },
  { source: 'invalid' }, { limit: 0 }, { limit: 257 },
  { page_offset: -1 }, { page_offset: Number.MAX_SAFE_INTEGER + 1 },
  { limit: 1, page_offset: 8000 }, { limit: 1, page_version: 'bad' },
  { limit: 2, page_offset: 1, page_version: '0'.repeat(64) },
]) {
  test(`invalid source/filter/offset request fails before HTTP or native reads: ${JSON.stringify(args)}`, async () => {
    assert.equal((await call(args)).isError, true);
    assert.equal(requests.length, 0);
    assert.equal(nativeCalls.length, 0);
  });
}

test('end and out-of-range offsets fail without empty success fragments', async () => {
  events = [event('one', giant)];
  const first = Fragment.parse(await json({ limit: 1 }));
  for (const offset of [first.pageCharacters, first.pageCharacters + 1, Number.MAX_SAFE_INTEGER]) {
    const reply = await call({ limit: 1, page_version: first.pageVersion, page_offset: offset });
    assert.equal(reply.isError, true);
    assert.match(reply.text, /page_offset is outside/);
  }
  assert.equal(nativeCalls.length, 4);
});

test('an old version cannot restart or continue after a giant event becomes small', async () => {
  events = [event('one', giant)];
  const first = Fragment.parse(await json({ limit: 1 }));
  events = [event('one', 'shorter')];
  for (const page_offset of [0, 1]) {
    const reply = await call({ limit: 1, page_offset, page_version: first.pageVersion });
    assert.equal(reply.isError, true);
    assert.match(reply.text, /native page changed/);
  }
  const restarted = NativeChatPage.parse(await json({ limit: 1 }));
  assert.equal(restarted.events[0]!.data.content, 'shorter');
  assert.equal(nativeCalls.length, 4);
});

test('unloaded live sources do not resume or fall back to persisted reads', async () => {
  unloaded = true;
  const reply = await call({ source: 'live' });
  assert.equal(reply.isError, true);
  assert.match(reply.text, /unloaded/);
  assert.equal(requests.length, 1);
  assert.equal(nativeCalls.length, 0);
});

for (const mismatch of [
  { sessionId: 'wrong' }, { source: 'live' as const }, { direction: 'forward' as const },
  { events: [event('a'), event('b')] },
]) {
  test(`mismatched backend page fails without retry: ${JSON.stringify(mismatch)}`, async () => {
    override = mismatch;
    const reply = await call({ limit: 1 });
    assert.equal(reply.isError, true);
    assert.match(reply.text, /different native event page|exceeded the requested/);
    assert.equal(nativeCalls.length, 1);
  });
}
