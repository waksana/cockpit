#!/usr/bin/env node
// Performance benchmark for cockpit. Measures the hot paths:
//   1. Fold throughput — replaying real persisted sessions (the single most
//      intricate + frequently-run code; runs on every session load).
//   2. /status + /health latency (the ops/poll endpoints).
//   3. Upload + serve throughput (MB/s) over the real HTTP stack.
//   4. Concurrent SSE connect + snapshot fan-out.
//
// Run from packages/core (has tsx):  node --import tsx ../../scripts/perf.mjs
// or via repo root:  pnpm perf
// Env: COCKPIT_PORT (default 8771). The HTTP sections need the backend running.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { newFoldState, foldEvent } from '../packages/core/src/fold.ts';

const PORT = process.env.COCKPIT_PORT ?? '8771';
const BASE = `http://127.0.0.1:${PORT}`;
const ms = (n) => `${n.toFixed(1)}ms`;
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

console.log('cockpit perf bench\n==================\n');

// ── 1. Fold throughput on real persisted sessions ─────────────────────────────
{
  const root = join(homedir(), '.copilot', 'session-state');
  const dirs = existsSync(root) ? readdirSync(root).filter((d) => existsSync(join(root, d, 'events.jsonl'))) : [];
  let totalEvents = 0; let totalMsgs = 0; let totalMs = 0; let biggest = { id: '', events: 0, ms: 0 };
  for (const id of dirs) {
    const lines = readFileSync(join(root, id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean);
    const evs = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const t0 = performance.now();
    const st = newFoldState();
    for (const ev of evs) { try { foldEvent(st, ev); } catch { /* count anyway */ } }
    const dt = performance.now() - t0;
    totalEvents += evs.length; totalMsgs += st.messages.length; totalMs += dt;
    if (evs.length > biggest.events) biggest = { id: id.slice(0, 8), events: evs.length, ms: dt };
  }
  console.log('1. FOLD THROUGHPUT (real session replay)');
  console.log(`   sessions:        ${dirs.length}`);
  console.log(`   total events:    ${totalEvents}`);
  console.log(`   total messages:  ${totalMsgs}`);
  console.log(`   total fold time: ${ms(totalMs)}`);
  console.log(`   throughput:      ${Math.round(totalEvents / (totalMs / 1000)).toLocaleString()} events/sec`);
  if (biggest.events) {
    console.log(`   largest session: ${biggest.id} — ${biggest.events} events in ${ms(biggest.ms)} (${Math.round(biggest.events / (biggest.ms / 1000)).toLocaleString()} ev/s)`);
  }
  console.log('');
}

// ── HTTP sections (need the backend) ──────────────────────────────────────────
async function reachable() { try { const r = await fetch(`${BASE}/health`); return r.ok; } catch { return false; } }

if (!(await reachable())) {
  console.log('(backend not reachable — skipping HTTP sections)');
  process.exit(0);
}

// ── 2. Endpoint latency ───────────────────────────────────────────────────────
async function latency(path, n = 200) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fetch(`${BASE}${path}`);
    samples.push(performance.now() - t0);
  }
  return { p50: pct(samples, 0.5), p95: pct(samples, 0.95), p99: pct(samples, 0.99) };
}
{
  console.log('2. ENDPOINT LATENCY (200 sequential reqs)');
  for (const p of ['/health', '/status']) {
    const r = await latency(p);
    console.log(`   ${p.padEnd(9)} p50 ${ms(r.p50)}  p95 ${ms(r.p95)}  p99 ${ms(r.p99)}`);
  }
  console.log('');
}

// ── 3. Upload + serve throughput ──────────────────────────────────────────────
{
  console.log('3. UPLOAD + SERVE THROUGHPUT');
  for (const sizeMB of [1, 5]) {
    const buf = Buffer.alloc(sizeMB * 1024 * 1024, 0x61);
    const tu = performance.now();
    const res = await fetch(`${BASE}/upload?name=perf-${sizeMB}mb.bin&mime=application/octet-stream`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buf,
    });
    const up = performance.now() - tu;
    const meta = await res.json();
    const td = performance.now();
    const got = await fetch(`${BASE}${meta.url}`);
    await got.arrayBuffer();
    const dl = performance.now() - td;
    console.log(`   ${sizeMB}MB  upload ${ms(up)} (${(sizeMB / (up / 1000)).toFixed(0)} MB/s)  serve ${ms(dl)} (${(sizeMB / (dl / 1000)).toFixed(0)} MB/s)`);
  }
  console.log('   (note: leaves perf-*.bin in the upload folder; safe to delete)');
  console.log('');
}

// ── 4. Concurrent SSE connect + snapshot ──────────────────────────────────────
{
  console.log('4. CONCURRENT SSE (connect + first snapshot)');
  for (const conc of [10, 50]) {
    const t0 = performance.now();
    const ctrls = [];
    const firsts = await Promise.all(Array.from({ length: conc }, async () => {
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      const r = await fetch(`${BASE}/events`, { signal: ctrl.signal });
      const reader = r.body.getReader();
      const { value } = await reader.read(); // first chunk = retry + snapshot frame
      return value?.length ?? 0;
    }));
    const dt = performance.now() - t0;
    ctrls.forEach((c) => c.abort());
    const ok = firsts.filter((n) => n > 0).length;
    console.log(`   ${String(conc).padStart(2)} clients  all-connected+snapshot in ${ms(dt)}  (${ok}/${conc} got a frame)`);
  }
  console.log('');
}

console.log('done.');
process.exit(0);
