// Real-log fold regression: fold every persisted session's events.jsonl and
// validate each resulting ChatMessage against the protocol schema. Reports
// per-session message/error counts + total sub-agent cards. Run from packages/core:
//   node --import tsx src/regress-reallog.mts
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { newFoldState, foldEvent, type FoldState } from './fold.ts';
import { ChatMessage } from '@cockpit/protocol';

const root = join(homedir(), '.copilot', 'session-state');
const dirs = readdirSync(root).filter((d) => existsSync(join(root, d, 'events.jsonl')));

let totalMsgs = 0, totalErrors = 0, totalInvalid = 0, totalCards = 0, totalSessions = 0;

function countCards(msgs: { subMessages?: unknown[]; subagent?: unknown }[]): number {
  let n = 0;
  for (const m of msgs) {
    if (m.subagent) n++;
    if (m.subMessages) n += countCards(m.subMessages as never);
  }
  return n;
}

for (const id of dirs) {
  const file = join(root, id, 'events.jsonl');
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const st: FoldState = newFoldState();
  let errs = 0;
  for (const line of lines) {
    let ev: unknown;
    try { ev = JSON.parse(line); } catch { continue; }
    try { foldEvent(st, ev as never); } catch (e) {
      errs++; console.error(`  [${id.slice(0, 8)}] fold error:`, (e as Error).message);
    }
  }
  let invalid = 0;
  for (const m of st.messages) {
    const r = ChatMessage.safeParse(m);
    if (!r.success) { invalid++; console.error(`  [${id.slice(0, 8)}] invalid msg:`, JSON.stringify(r.error.issues[0])); }
  }
  const cards = countCards(st.messages as never);
  totalSessions++; totalMsgs += st.messages.length; totalErrors += errs; totalInvalid += invalid; totalCards += cards;
  console.log(`  ${id.slice(0, 8)}  msgs=${String(st.messages.length).padStart(4)}  errs=${errs}  invalid=${invalid}  cards=${cards}`);
}

console.log(`\n=== ${totalSessions} sessions | ${totalMsgs} msgs | ${totalErrors} fold errors | ${totalInvalid} invalid | ${totalCards} subagent cards ===`);
process.exit(totalErrors + totalInvalid > 0 ? 1 : 0);
