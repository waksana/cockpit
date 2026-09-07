// Targeted compatibility repair for an upstream Copilot SDK bug: compaction can
// write a negative optional `tokensRemoved`, then reject its own event on reload.
// The metric is not conversation state, so removing only the invalid field makes
// the append-only log readable without changing the actual compaction record.

import {
  copyFileSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface SessionEventRepairResult {
  repairedLines: number[];
  backupPath?: string;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function liveLockPids(eventsFile: string): number[] {
  const dir = dirname(eventsFile);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => /^inuse\.(\d+)\.lock$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && processIsAlive(pid));
}

function nextBackupPath(eventsFile: string): string {
  const base = `${eventsFile}.negative-tokensRemoved-${Date.now()}.bak`;
  let candidate = base;
  let suffix = 1;
  while (existsSync(candidate)) candidate = `${base}.${suffix++}`;
  return candidate;
}

export function repairNegativeCompactionTokens(eventsFile: string): SessionEventRepairResult {
  if (!existsSync(eventsFile)) return { repairedLines: [] };

  const raw = readFileSync(eventsFile, 'utf-8');
  const repairedLines: number[] = [];
  const output: string[] = [];
  const linePattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let lineNumber = 0;
  let match: RegExpExecArray | null;

  while ((match = linePattern.exec(raw)) !== null) {
    if (match[0] === '') break;
    lineNumber++;
    const line = match[1] ?? '';
    const ending = match[2] ?? '';
    if (!line.trim()) {
      output.push(line, ending);
      continue;
    }

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // This helper only repairs the known schema mismatch. Leave genuine torn or
      // malformed JSON untouched so the SDK reports the original corruption.
      return { repairedLines: [] };
    }

    const record = event as { type?: unknown; data?: Record<string, unknown> };
    if (
      record.type === 'session.compaction_complete'
      && typeof record.data?.tokensRemoved === 'number'
      && record.data.tokensRemoved < 0
    ) {
      const { tokensRemoved: _invalidMetric, ...data } = record.data;
      output.push(JSON.stringify({ ...record, data }), ending);
      repairedLines.push(lineNumber);
    } else {
      output.push(line, ending);
    }
  }

  if (repairedLines.length === 0) return { repairedLines };

  const locks = liveLockPids(eventsFile);
  if (locks.length > 0) {
    throw new Error(
      `session contains invalid compaction metrics but is active in process ${locks.join(', ')}; `
      + 'close that Copilot session before retrying so cockpit can repair it safely',
    );
  }

  const backupPath = nextBackupPath(eventsFile);
  const tmp = `${eventsFile}.repair.tmp`;
  copyFileSync(eventsFile, backupPath);
  try {
    writeFileSync(tmp, output.join(''), 'utf-8');
    renameSync(tmp, eventsFile);
  } catch (err) {
    try {
      if (existsSync(tmp)) renameSync(tmp, `${tmp}.failed-${Date.now()}`);
    } catch { /* preserve the original error */ }
    throw err;
  }
  return { repairedLines, backupPath };
}
