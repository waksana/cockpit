import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairNegativeCompactionTokens } from './session-event-repair.ts';

function fixture(lines: string[]): { dir: string; file: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-event-repair-'));
  const file = join(dir, 'events.jsonl');
  writeFileSync(file, `${lines.join('\n')}\n`);
  return { dir, file, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

test('removes only negative tokensRemoved fields and preserves a byte-exact backup', () => {
  const negative = JSON.stringify({
    type: 'session.compaction_complete',
    data: { success: true, preCompactionTokens: 10, postCompactionTokens: 15, tokensRemoved: -5 },
  });
  const valid = JSON.stringify({
    type: 'session.compaction_complete',
    data: { success: true, preCompactionTokens: 20, postCompactionTokens: 12, tokensRemoved: 8 },
  });
  const other = JSON.stringify({ type: 'assistant.message', data: { content: 'keep me' } });
  const f = fixture([negative, valid, other]);
  const original = readFileSync(f.file, 'utf-8');

  const result = repairNegativeCompactionTokens(f.file);

  assert.deepEqual(result.repairedLines, [1]);
  assert.ok(result.backupPath);
  assert.equal(readFileSync(result.backupPath, 'utf-8'), original);
  const repaired = readFileSync(f.file, 'utf-8').trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.equal('tokensRemoved' in repaired[0].data, false);
  assert.equal(repaired[0].data.preCompactionTokens, 10);
  assert.equal(repaired[0].data.postCompactionTokens, 15);
  assert.equal(repaired[1].data.tokensRemoved, 8);
  assert.equal(repaired[2].data.content, 'keep me');
  f.dispose();
});

test('is a no-op when every compaction metric is valid', () => {
  const line = JSON.stringify({
    type: 'session.compaction_complete',
    data: { success: true, tokensRemoved: 0 },
  });
  const f = fixture([line]);
  const original = readFileSync(f.file, 'utf-8');

  assert.deepEqual(repairNegativeCompactionTokens(f.file), { repairedLines: [] });
  assert.equal(readFileSync(f.file, 'utf-8'), original);
  f.dispose();
});

test('leaves malformed JSON untouched for the SDK to diagnose', () => {
  const f = fixture(['{"type":"assistant.message"', '{"type":"session.compaction_complete","data":{"tokensRemoved":-1}}']);
  const original = readFileSync(f.file, 'utf-8');

  assert.deepEqual(repairNegativeCompactionTokens(f.file), { repairedLines: [] });
  assert.equal(readFileSync(f.file, 'utf-8'), original);
  f.dispose();
});

test('refuses to rewrite a session held by a live process', () => {
  const line = JSON.stringify({
    type: 'session.compaction_complete',
    data: { success: true, tokensRemoved: -1 },
  });
  const f = fixture([line]);
  writeFileSync(join(f.dir, `inuse.${process.pid}.lock`), `${process.pid}\n`);
  const original = readFileSync(f.file, 'utf-8');

  assert.throws(
    () => repairNegativeCompactionTokens(f.file),
    new RegExp(`active in process ${process.pid}`),
  );
  assert.equal(readFileSync(f.file, 'utf-8'), original);
  assert.equal(existsSync(`${f.file}.repair.tmp`), false);
  f.dispose();
});
