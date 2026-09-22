import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServerStatus } from '@cockpit/protocol';
import { mockHttp } from '../test-support/mock-http.ts';
mockHttp(() => { throw new Error('Unexpected request in pure helper tests'); });
const {
  cappedJson, capped, shrinkList, ok, fail, intentJson,
  McpToggleOperation, McpServerSession, McpSessionResult, McpToggleResult,
} = await import('./shared.ts');
const { CHARACTER_LIMIT } = await import('./config.ts');

test('MCP result helpers return one unchanged text representation', () => {
  const text = '{"message":"line\\nnext","ok":false}';
  assert.deepEqual(ok(text), { content: [{ type: 'text', text }] });
  assert.deepEqual(fail(text), { content: [{ type: 'text', text: `Error: ${text}` }], isError: true });
});

test('native session controls preserve partial outcomes and mark failure or uncertainty', () => {
  for (const state of ['accepted', 'unchanged', 'failed', 'unconfirmed'] as const) {
    const value = { ok: state === 'accepted' || state === 'unchanged', outcomes: [
      { operation: 'task-cancel', targetId: 'first', state: 'accepted', result: { cancelled: true } },
      { operation: 'task-cancel', targetId: 'second', state, error: 'Native outcome detail' },
    ] };
    const rendered = intentJson('session/control', value);
    assert.deepEqual(JSON.parse(rendered.content[0].text), value);
    assert.equal(rendered.isError === true, !value.ok);
  }
});

for (const status of ['connected', 'failed', 'needs-auth', 'pending', 'disabled', 'stopped', 'not_configured', 'unloaded']) {
  for (const state of ['running', 'cancelling', 'settling', 'succeeded', 'failed']) {
    test(`canonical MCP adapters preserve nested unknown fields and failure: ${status}/${state}`, () => {
      const operation = {
        id: 'operation', desiredEnabled: true, state, startedAt: 1, completedAt: 2,
        status, error: 'native operation detail', futureOperation: { nested: ['keep'] },
      };
      const server = {
        name: 'server', detail: 'native detail', status, enabled: false, operation,
        error: 'native server detail', futureServer: { nested: true },
      };
      const session = { loaded: false, servers: [server], futureEnvelope: [1, 2] };
      const toggle = {
        ok: false, applied: false, sessionId: 'session', name: 'server', enabled: false,
        status, error: 'native failure', operation, futureToggle: { keep: null },
      };
      assert.equal(McpServerStatus.parse(status), status);
      assert.deepEqual(McpToggleOperation.parse(operation), operation);
      assert.deepEqual(McpServerSession.parse(server), server);
      assert.deepEqual(McpSessionResult.parse(session), session);
      assert.deepEqual(McpToggleResult.parse(toggle), toggle);
    });
  }
}

test('canonical MCP adapters still reject invalid fields at every validated boundary', () => {
  const operation = { id: 'operation', desiredEnabled: true, state: 'settling', startedAt: 1, status: 'pending' };
  const server = { name: 'server', detail: 'detail', status: 'pending', enabled: true, operation };
  const toggle = { ok: true, applied: false, sessionId: 'session', name: 'server', enabled: true, status: 'pending', operation };
  assert.equal(McpServerStatus.safeParse('future-status').success, false);
  for (const patch of [{ id: null }, { desiredEnabled: 'true' }, { state: 'unknown' }, { startedAt: '1' }, { completedAt: '2' }, { status: 'unknown' }, { error: false }]) {
    const invalid = { ...operation, ...patch };
    assert.equal(McpToggleOperation.safeParse(invalid).success, false);
    assert.equal(McpServerSession.safeParse({ ...server, operation: invalid }).success, false);
    assert.equal(McpSessionResult.safeParse({ loaded: true, servers: [{ ...server, operation: invalid }] }).success, false);
    assert.equal(McpToggleResult.safeParse({ ...toggle, operation: invalid }).success, false);
  }
  for (const patch of [{ name: null }, { detail: 1 }, { enabled: 'true' }, { status: 'unknown' }, { error: false }]) {
    assert.equal(McpServerSession.safeParse({ ...server, ...patch }).success, false);
  }
  for (const patch of [{ loaded: 'false' }, { servers: {} }]) {
    assert.equal(McpSessionResult.safeParse({ loaded: false, servers: [], ...patch }).success, false);
  }
  for (const patch of [{ ok: 'true' }, { applied: null }, { sessionId: 1 }, { operation: undefined }]) {
    assert.equal(McpToggleResult.safeParse({ ...toggle, ...patch }).success, false);
  }
  const { operation: omitted, ...withoutOperation } = server;
  assert.ok(omitted);
  assert.deepEqual(McpServerSession.parse(withoutOperation), withoutOperation);
});

// Build a value whose JSON.stringify is comfortably over the character budget and,
// critically, contains literal control characters (newlines/tabs) and embedded
// double quotes inside string values — the exact shape that made a raw slice of the
// serialized JSON invalid (the cockpit_read_session bug: a cut landing inside a
// string + an appended suffix => "Bad control character in string literal").
function bigTurns(n: number) {
  const chunk = 'line one\nline two\twith a "quoted" bit and a JSON fragment {"k": "v\\nx"}\n';
  return {
    sessionId: 's',
    totalTurns: n,
    returned: n,
    offset: 0,
    turns: Array.from({ length: n }, (_, i) => ({
      index: i,
      user: `user ${i} ${chunk.repeat(20)}`,
      assistant: `assistant ${i} ${chunk.repeat(40)}`,
      at: null,
    })),
  };
}

test('cappedJson returns the value verbatim when it fits', () => {
  const small = { a: 1, b: 'hi\nthere', c: ['x', 'y'] };
  const out = cappedJson(small);
  assert.deepEqual(JSON.parse(out), small);
});

test('cappedJson never emits invalid JSON when over budget (no shrink)', () => {
  const big = bigTurns(80);
  const raw = JSON.stringify(big, null, 2);
  assert.ok(raw.length > CHARACTER_LIMIT, 'fixture must exceed the budget');
  const out = cappedJson(big);
  // Must parse — this is the whole bug. A raw slice here threw "Bad control
  // character in string literal".
  const parsed = JSON.parse(out);
  assert.ok(out.length <= CHARACTER_LIMIT + 200, 'within budget (small envelope)');
  assert.equal(parsed._truncated, true, 'signals truncation as data');
});

test('cappedJson shrinks an array payload to as many items as fit, staying valid', () => {
  const big = bigTurns(80);
  const allTurns = big.turns;
  const out = cappedJson(big, (attempt) => {
    const keep = Math.floor(allTurns.length / (attempt + 1));
    if (keep < 1) return null;
    return { ...big, returned: keep, truncated: true, turns: allTurns.slice(0, keep) };
  });
  const parsed = JSON.parse(out); // must be valid JSON
  assert.ok(out.length <= CHARACTER_LIMIT, 'fits the budget');
  assert.ok(Array.isArray(parsed.turns) && parsed.turns.length >= 1, 'kept at least one turn');
  assert.ok(parsed.turns.length < allTurns.length, 'dropped some turns');
  assert.equal(parsed.truncated, true);
  // The kept turns must be byte-identical (no mid-string corruption).
  for (let i = 0; i < parsed.turns.length; i++) {
    assert.equal(parsed.turns[i].assistant, allTurns[i].assistant);
  }
});

test('cappedJson preserves embedded control chars + quotes as proper escapes', () => {
  const v = { s: 'a\nb\tc "q" \\ d', nested: { frag: '{"x": "y\\nz"}' } };
  const out = cappedJson(v);
  assert.deepEqual(JSON.parse(out), v);
});

test('a single oversized turn can be clipped to valid JSON (escapes preserved)', () => {
  // Mimics read_session's best===0 branch: one turn whose text alone blows the
  // budget, clipped so json stays valid and non-empty.
  const huge = 'x"y\nz\t'.repeat(8000); // > budget, with quotes + control chars
  const fieldBudget = Math.max(2000, Math.floor(CHARACTER_LIMIT / 3));
  const clip = (s: string): string =>
    s.length > fieldBudget ? s.slice(0, fieldBudget) + ` …[clipped ${s.length - fieldBudget} chars]` : s;
  const payload = {
    sessionId: 's',
    returned: 1,
    truncated: true,
    turnTextClipped: true,
    turns: [{ index: 2, user: 'q', assistant: clip(huge), at: null }],
  };
  const out = cappedJson(payload);
  const parsed = JSON.parse(out); // must be valid despite quotes/newlines in source
  assert.ok(out.length <= CHARACTER_LIMIT, 'fits the budget');
  assert.equal(parsed.turnTextClipped, true);
  assert.equal(parsed.turns.length, 1);
  assert.match(parsed.turns[0].assistant, /clipped/);
});

test('capped (human text) still truncates with a notice', () => {
  const long = 'x'.repeat(CHARACTER_LIMIT + 100);
  const out = capped(long);
  assert.ok(out.length < long.length);
  assert.match(out, /truncated/);
});

// ── shrinkList: the fix for the list-tool overflow-stub DX bug ────────────────
// A skills-like list payload { skills: [...], count } whose json blows the budget
// must, with shrinkList, come back as a VALID, in-budget COMPACT PROJECTION —
// never the useless overflow stub that (falsely) told the caller to paginate.
function bigSkills(n: number, descLen: number) {
  const skills = Array.from({ length: n }, (_, i) => ({
    name: `skill-number-${i}`,
    source: i % 2 ? 'user' : 'builtin',
    description: `Skill ${i}: ` + 'lorem ipsum dolor sit amet '.repeat(Math.ceil(descLen / 27)).slice(0, descLen),
  }));
  return { skills, count: skills.length };
}

test('shrinkList turns an over-budget skills list into a valid compact projection (not the stub)', () => {
  const structured = bigSkills(220, 320);
  assert.ok(
    JSON.stringify(structured, null, 2).length > CHARACTER_LIMIT,
    'fixture must exceed the budget so shrink actually runs',
  );
  const out = cappedJson(
    structured,
    shrinkList(structured.skills, 'skills', { keep: ['name', 'source'], clip: ['description'] }),
  );
  const parsed = JSON.parse(out); // must be valid JSON
  assert.ok(out.length <= CHARACTER_LIMIT, 'fits the machine-read budget');
  assert.notEqual(parsed._truncated, true, 'is a projection, NOT the overflow stub');
  assert.ok(Array.isArray(parsed.skills) && parsed.skills.length >= 1, 'kept an array of skills');
  assert.equal(parsed.count, structured.count, 'preserves the true total count');
  assert.ok(typeof parsed._compacted === 'string', 'marks that detail was elided');
  // Identifier fields survive verbatim on each returned item.
  for (const s of parsed.skills) assert.ok(typeof s.name === 'string' && s.name.length > 0);
});

test('shrinkList stage 1 keeps a clipped preview of the verbose field before dropping it', () => {
  // Sized so identifiers + a 120-char preview fit → stops at attempt 1 (preview).
  const structured = bigSkills(60, 600);
  assert.ok(JSON.stringify(structured, null, 2).length > CHARACTER_LIMIT);
  const out = cappedJson(
    structured,
    shrinkList(structured.skills, 'skills', { keep: ['name', 'source'], clip: ['description'] }),
  );
  const parsed = JSON.parse(out);
  assert.ok(out.length <= CHARACTER_LIMIT);
  assert.equal(parsed._compacted, 'field-previews', 'preferred previews over dropping');
  const d = parsed.skills[0].description;
  assert.ok(typeof d === 'string' && d.endsWith('…'), 'verbose field kept as a clipped preview');
  assert.ok(d.length <= 122, 'preview honors the ~120-char budget');
});

// ── O20-reopen regression: per-session `enabled` must survive shrink ──────────
// cockpit_list_session_skills is a PER-SESSION tool, so unlike the global skills
// list it must keep `enabled` — that boolean is the whole point of the tool. An
// over-budget 26-skill session read must come back as a valid array projection
// (never the stub) with `enabled` intact on EVERY item. This is the exact bug
// flow-review #39 reopened.
function sessionSkills(n, descLen) {
  const skills = Array.from({ length: n }, (_, i) => ({
    name: `session-skill-${i}`,
    enabled: i % 3 !== 0, // a mix of on/off states
    source: i % 2 ? 'user' : 'builtin',
    description: `Skill ${i}: ` + 'lorem ipsum dolor sit amet '.repeat(Math.ceil(descLen / 27)).slice(0, descLen),
  }));
  return { skills, count: skills.length };
}

test('shrinkList keeps the per-session `enabled` signal on every item (list_session_skills regression)', () => {
  const structured = sessionSkills(26, 1200);
  assert.ok(
    JSON.stringify(structured, null, 2).length > CHARACTER_LIMIT,
    'fixture must exceed the budget so shrink actually runs',
  );
  const out = cappedJson(
    structured,
    shrinkList(structured.skills, 'skills', { keep: ['name', 'enabled', 'source'], clip: ['description'] }),
  );
  const parsed = JSON.parse(out); // (a) valid JSON
  assert.ok(out.length <= CHARACTER_LIMIT, '(a) fits the machine-read budget');
  assert.notEqual(parsed._truncated, true, '(a) a projection, NOT the overflow stub');
  assert.ok(Array.isArray(parsed.skills) && parsed.skills.length >= 1, '(a) kept an array of skills');
  assert.equal(parsed.count, structured.count, '(a) preserves the true total count');
  assert.equal(parsed._compacted, 'field-previews', '(b) clipped previews, not dropped');
  assert.equal(parsed.skills.length, 26, 'kept all items at the preview stage (no shedding)');
  // (c) THE regression point: enabled survives verbatim on every returned item.
  for (const s of parsed.skills) {
    assert.equal(typeof s.enabled, 'boolean', '(c) enabled retained on every item');
    assert.ok(typeof s.name === 'string' && s.name.length > 0);
  }
  assert.ok(
    parsed.skills.some((s) => s.enabled === true) && parsed.skills.some((s) => s.enabled === false),
    '(c) both on and off states preserved, not coerced',
  );
});

test('shrinkList terminates and falls to a valid stub when even one identifier exceeds the budget', () => {
  // `keep` fields are copied verbatim, so an item whose identifier alone blows the
  // budget can never be made to fit; shrink must shed items down to < 1 and return
  // null, so cappedJson stops (no infinite loop) and emits the still-valid stub.
  const skills = Array.from({ length: 5 }, (_, i) => ({
    name: 'N'.repeat(CHARACTER_LIMIT + 100) + i,
    source: 'user',
    description: 'd'.repeat(400),
  }));
  const structured = { skills, count: skills.length };
  const out = cappedJson(structured, shrinkList(skills, 'skills', { keep: ['name', 'source'], clip: ['description'] }));
  const parsed = JSON.parse(out); // valid JSON, and the loop provably terminated
  assert.equal(parsed._truncated, true);
});

test('the overflow stub note is tool-agnostic — no longer suggests the nonexistent offset/limit', () => {
  const big = bigTurns(80); // over budget, no shrink → stub
  const out = cappedJson(big);
  const parsed = JSON.parse(out);
  assert.equal(parsed._truncated, true, 'is the stub');
  assert.ok(!out.includes('offset'), 'stub must not suggest paginating with offset');
  assert.ok(!/\boffset\b/.test(parsed._note) && !/paginate/.test(parsed._note), 'note stays capability-agnostic');
});

test('capped notice is tool-agnostic too (no limit/offset)', () => {
  const out = capped('y'.repeat(CHARACTER_LIMIT + 100));
  assert.ok(!out.includes('offset') && !out.includes('limit/offset'));
});
