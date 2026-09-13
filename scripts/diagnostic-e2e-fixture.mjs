// Test-only preload: all "backend" state is in memory, with no server or SDK.
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { Intents } from '../packages/protocol/src/index.ts';

const root = process.argv[process.argv.indexOf('--synthetic-fixture-root') + 1];
const json = (value, status = 200) => Response.json(value, { status });
const sessionId = 'synthetic-e2e-session';
let session = null, skillEnabled = true, mcpEnabled = true;
const schedules = new Map();
const validated = new Set();
let invalidBodies = 0, deleted = false;

globalThis.fetch = async (url, init = {}) => {
  assert.equal(init.redirect, 'error');
  const target = new URL(url);
  assert.equal(target.origin, 'http://127.0.0.1:45678');
  const path = target.pathname;
  if (path === '/health') return json({ ok: true, login: 'synthetic' });
  if (path === '/status') return json({ sessions: session ? [session] : [], running: 0, restartPending: false });
  if (path === '/capabilities') {
    if (target.searchParams.has('name')) return json({
      name: 'session/chat', inputSchema: { type: 'object' }, resultSchema: { type: 'object' },
    });
    return json({
      intents: Object.keys(Intents).map(name => ({ name })),
      transports: [{ method: 'POST', path: '/chat/stream' }],
    });
  }
  assert.ok(path.startsWith('/intent/'), `unexpected fixture route ${path}`);
  assert.equal(init.method, 'POST');
  const name = path.slice('/intent/'.length);
  const contract = Intents[name];
  if (!contract) return json({ error: 'unknown intent' }, 404);
  const raw = JSON.parse(init.body);
  const parsed = contract.body.safeParse(raw);
  if (!parsed.success) {
    invalidBodies++;
    return json({ error: 'invalid body' }, 400);
  }
  const body = parsed.data;
  // Defaults may be added, but no caller-sent field may silently disappear.
  for (const key of Object.keys(raw)) assert.ok(Object.hasOwn(body, key), `${name} silently stripped ${key}`);
  validated.add(name);
  if (body.sessionId) assert.equal(body.sessionId, sessionId);
  const result = value => json(contract.result.parse(value));
  if (session && !session.loaded && ['session/plan', 'session/panels', 'skills/session', 'schedule/list'].includes(name)) {
    return json({ code: 'SESSION_UNLOADED' }, 409);
  }
  switch (name) {
    case 'mcp/global':
      return result({ servers: [{ name: 'fixture-mcp', detail: 'in-memory only', defaultOn: true }] });
    case 'skills/global':
      assert.equal(body.cwd, root);
      return result({ skills: [{ name: 'fixture-skill' }] });
    case 'fs/listDir':
      if (body.path === '') return json({ error: 'empty path' }, 400);
      assert.equal(body.path, root, 'never list home or filesystem root');
      return result({ path: root, parent: dirname(root), entries: [{ name: 'synthetic.txt', isDir: false }] });
    case 'session/list':
      return result({ sessions: session ? [session] : [] });
    case 'session/new':
      assert.equal(body.cwd, root);
      assert.equal(session, null);
      session = { sessionId, cwd: root, title: 'synthetic', status: 'idle', lastActivity: 0, loaded: true, ask: null };
      return result({ sessionId });
    case 'session/get':
      assert.ok(session);
      assert.equal(Object.hasOwn(session, 'error'), false, 'exercise omitted unloaded error');
      return result({ meta: session });
    case 'session/rename':
      session.title = body.name;
      return result({ ok: true, title: session.title });
    case 'session/unload':
    case 'session/reload':
      session.loaded = name === 'session/reload';
      return result({ ok: true });
    case 'session/chat':
      assert.equal(session.loaded, false, 'persisted read must remain passive');
      return result({
        sessionId, source: 'persisted', direction: 'backward', events: [], cursor: 'synthetic-cursor',
        cursorStatus: 'ok', hasMore: false, read: { rpc: 1, events: 0 },
      });
    case 'session/plan':
      return result({ planMarkdown: null, todos: [] });
    case 'skills/session':
      return result({ skills: [{ name: 'fixture-skill', enabled: skillEnabled }] });
    case 'skills/session-toggle':
      assert.equal(body.name, 'fixture-skill');
      skillEnabled = body.enabled;
      return result({ ok: true });
    case 'mcp/session':
      return result({ loaded: session.loaded, servers: [{ name: 'fixture-mcp', detail: 'in-memory only', enabled: mcpEnabled, status: mcpEnabled ? 'connected' : 'disabled' }] });
    case 'mcp/session-toggle':
      assert.equal(body.name, 'fixture-mcp');
      assert.equal(body.on, false, 'shared HTTP Intents currently uses on, not MCP tool enabled');
      mcpEnabled = body.on;
      return result({
        ok: true, applied: true, sessionId, name: body.name, enabled: false, status: 'disabled',
        operation: { id: 'synthetic-op', desiredEnabled: false, state: 'succeeded', startedAt: 0, status: 'disabled' },
      });
    case 'schedule/add': {
      const entry = {
        id: schedules.size + 1, prompt: body.prompt, recurring: body.interval !== undefined,
        nextRunAt: body.at ?? Date.now() + 3600_000,
        ...(body.interval ? { intervalMs: 3600_000 } : { at: body.at }),
      };
      schedules.set(entry.id, entry);
      return result({ ok: true, entry });
    }
    case 'schedule/list':
      return result({ entries: [...schedules.values()] });
    case 'schedule/stop':
      return result({ ok: schedules.delete(body.id) });
    case 'session/delete':
      assert.equal(body.confirm, true);
      assert.equal(schedules.size, 0);
      assert.equal(skillEnabled, true);
      assert.equal(mcpEnabled, false);
      session = null;
      deleted = true;
      return result({ ok: true });
    default:
      throw new Error(`unhandled valid fixture intent ${name}`);
  }
};

process.on('exit', () => {
  assert.ok(deleted, 'happy path reaches confirmed synthetic deletion');
  assert.equal(invalidBodies, 4, 'schema rejects malformed MCP, zero interval and both unconfirmed deletes');
  for (const name of ['mcp/session-toggle', 'session/chat', 'schedule/add', 'session/delete']) assert.ok(validated.has(name));
  console.log(`SYNTHETIC_E2E ${validated.size} intent contracts validated, no real backend`);
});
