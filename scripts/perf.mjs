#!/usr/bin/env node
// Opt-in performance benchmark for synthetic data and an isolated test backend:
//   1. Shared browser fold throughput — replaying bounded synthetic JSONL files.
//   2. /status + /health latency (the ops/poll endpoints).
//   3. Concurrent SSE connect + snapshot fan-out.
//
// Run from packages/core (has tsx):  node --import tsx ../../scripts/perf.mjs
// or via repo root:  pnpm perf
// Required: --synthetic-fixture-root /absolute/flat-jsonl-directory
//           --test-base-url http://127.0.0.1:<test-port> (never 8771).
// The operator must provision the backend with separate synthetic state/config,
// and workspace. These arguments do not isolate an existing service.

import { performance } from 'node:perf_hooks';
import { diagnosticOptions, readSyntheticLogs, diagnosticFetch } from './diagnostic-safety.mjs';

const { root, base: BASE } = diagnosticOptions('perf');
const logs = readSyntheticLogs(root);
const { newFoldState, foldEvent } = await import('../packages/core/src/fold.ts');
const fetch = diagnosticFetch(BASE);
const ms = (n) => `${n.toFixed(1)}ms`;
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

console.log('cockpit perf bench\n==================\n');

// ── 1. Shared browser fold throughput on synthetic fixtures ───────────────────
{
  let totalEvents = 0; let totalMsgs = 0; let totalMs = 0; let biggest = { id: '', events: 0, ms: 0 };
  for (const { name: id, events: evs } of logs) {
    const t0 = performance.now();
    const st = newFoldState();
    for (const ev of evs) foldEvent(st, ev);
    const dt = performance.now() - t0;
    totalEvents += evs.length; totalMsgs += st.messages.length; totalMs += dt;
    if (evs.length > biggest.events) biggest = { id: id.slice(0, 8), events: evs.length, ms: dt };
  }
  console.log('1. FOLD THROUGHPUT (synthetic browser-fold fixtures)');
  console.log(`   fixtures:        ${logs.length}`);
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
  throw new Error('Explicit test backend is not reachable; HTTP benchmark did not run');
}

// ── 2. Endpoint latency ───────────────────────────────────────────────────────
async function latency(path, n = 200) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const response = await fetch(`${BASE}${path}`);
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    await response.arrayBuffer();
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

// ── 3. Concurrent SSE connect + snapshot ──────────────────────────────────────
{
  console.log('3. CONCURRENT SSE (connect + first snapshot)');
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
