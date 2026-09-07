import { intent } from './cockpit.js';
import type { SessionBrief, TrashEntry } from './shared.js';

interface TitleEntry {
  sessionId: string;
  title?: string | null;
}

export interface SessionTitleSource {
  listLive(): Promise<readonly TitleEntry[]>;
  listTrash(): Promise<readonly TitleEntry[]>;
}

const cockpitTitleSource: SessionTitleSource = {
  async listLive() {
    const { sessions } = await intent<{ sessions: SessionBrief[] }>('session/list');
    return sessions;
  },
  async listTrash() {
    const { entries } = await intent<{ entries: TrashEntry[] }>('session/trash-list');
    return entries;
  },
};

function matchingTitle(entries: readonly TitleEntry[], sessionId: string): string | null {
  const title = entries.find((entry) => entry.sessionId === sessionId)?.title?.trim();
  return title || null;
}

export async function resolveAuthoritativeTitle(
  sessionId: string,
  source: SessionTitleSource = cockpitTitleSource,
): Promise<string | null> {
  try {
    const liveTitle = matchingTitle(await source.listLive(), sessionId);
    if (liveTitle) return liveTitle;
  } catch {
    // Title lookup is best-effort; a source failure must not break transcript reads.
  }

  try {
    return matchingTitle(await source.listTrash(), sessionId);
  } catch {
    return null;
  }
}

export function resolveSessionTitle(
  authoritativeTitle: string | null,
  summary: string | null | undefined,
): string {
  return authoritativeTitle ?? (summary?.trim() || '(untitled)');
}
