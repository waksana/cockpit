// Replies require a real native turn end, not a polling/status edge. Unloading
// does not consume a reply; only seeing it or starting new work does.

import type { Attention } from '@cockpit/protocol';

export interface AttentionInputs {
  status: string;
  choicePending: boolean;
  // A user-initiated transition (e.g. the user cancelled the turn). Such a
  // running→idle is NOT a fresh "ready" — the user is right there and asked for
  // it — so it must never raise attention or fire a notification.
  silent?: boolean;
  replyReady?: boolean;
}

export function nextAttention(
  prev: AttentionInputs & { attention: Attention | null },
  next: AttentionInputs,
): Attention | null {
  if (next.choicePending) return 'choice';
  if (next.status === 'running') return null;
  if (next.status === 'idle' && next.replyReady && !next.silent) return 'ready';
  return prev.attention === 'ready' ? 'ready' : null;
}

// Seeing completes a reply, not a decision. Late acknowledgements only advance
// their observed waterline; they cannot consume a newer reply.
export function applySeen(
  cur: { attention: Attention | null; attnId: number; seenId: number },
  observedId = cur.attnId,
): { attention: Attention | null; seenId: number } {
  const seenId = Math.max(cur.seenId, Math.min(observedId, cur.attnId));
  return {
    seenId,
    attention: cur.attention === 'ready' && seenId >= cur.attnId ? null : cur.attention,
  };
}

export function notificationSummary(text: string, fallback: string): string {
  const plain = text
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/<cockpit-attachment\b[^>]*\/?>/gi, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/[^\s<>]+/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, entity =>
      ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity] ?? '')
    .replace(/[`*]/g, '')
    .replace(/\b(?:Bearer\s+\S+|(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+)/gi, '［已隐藏］')
    .replace(/(?:\b(?:api[_-]?key|access[_-]?token|token|password|secret|authorization)|密码|密钥|口令)["']?\s*[:：=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '［已隐藏］')
    .replace(/[`*_#~>|]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\s]+/g, ' ')
    .trim();
  return [...(plain || fallback)].slice(0, 100).join('');
}
