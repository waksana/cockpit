// Shared browser-fold regression on explicit bounded, flat synthetic JSONL
// fixtures.
// Run from packages/core:
//   node --import tsx test-support/regress.mts --synthetic-fixture-root /absolute/fixtures
import { diagnosticOptions, readSyntheticLogs } from '../../../scripts/diagnostic-safety.mjs';

const { root } = diagnosticOptions('regress');
const logs = readSyntheticLogs(root);
const { newFoldState, foldEvent } = await import('@cockpit/protocol/chat');
const { ChatMessage } = await import('@cockpit/protocol/validation');

let totalMsgs = 0, totalErrors = 0, totalInvalid = 0, totalCards = 0, totalFixtures = 0;

function countCards(msgs: { subMessages?: unknown[]; subagent?: unknown }[]): number {
  let n = 0;
  for (const m of msgs) {
    if (m.subagent) n++;
    if (m.subMessages) n += countCards(m.subMessages as never);
  }
  return n;
}

for (const { name: id, events } of logs) {
  const st = newFoldState();
  let errs = 0;
  for (const ev of events) {
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
  totalFixtures++; totalMsgs += st.messages.length; totalErrors += errs; totalInvalid += invalid; totalCards += cards;
  console.log(`  ${id.slice(0, 8)}  msgs=${String(st.messages.length).padStart(4)}  errs=${errs}  invalid=${invalid}  cards=${cards}`);
}

console.log(`\n=== ${totalFixtures} fixtures | ${totalMsgs} msgs | ${totalErrors} fold errors | ${totalInvalid} invalid | ${totalCards} subagent cards ===`);
process.exit(totalErrors + totalInvalid > 0 ? 1 : 0);
