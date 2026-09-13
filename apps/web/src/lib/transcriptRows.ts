import type { ChatMessage } from '@cockpit/protocol';
import { hasMessageContent } from './messageContent';

export type TranscriptRow =
  | { kind: 'message'; key: string; message: ChatMessage }
  | { kind: 'process'; key: string; anchorId: string; items: ChatMessage[] };

export function isProcessItem(message: ChatMessage): boolean {
  return message.role === 'assistant' && message.subtype !== 'subagent'
    && !hasMessageContent(message) && !!(message.thought?.trim() || message.toolCalls?.length);
}

export function groupTranscript(messages: ChatMessage[], previous: TranscriptRow[] = []): TranscriptRow[] {
  const previousGroups = previous.filter(row => row.kind === 'process');
  const previousAnchors = new Map(previousGroups.map(row => [row.anchorId, row]));
  const previousItems = new Map(previousGroups.flatMap(row => row.items.map(item => [item.id, row] as const)));
  const used = new Set<string>();
  const rows: TranscriptRow[] = [];
  for (const message of messages) {
    if (!isProcessItem(message)) {
      // Empty stream starts have identities but are not speech boundaries.
      if (message.role === 'assistant' && message.subtype !== 'subagent' && !hasMessageContent(message)) continue;
      rows.push({ kind: 'message', key: message.id, message });
      continue;
    }
    const last = rows.at(-1);
    if (last?.kind === 'process') last.items.push(message);
    else rows.push({ kind: 'process', key: '', anchorId: message.id, items: [message] });
  }
  const processIds = new Set(rows.flatMap(row => row.kind === 'process' ? row.items.map(item => item.id) : []));
  for (const row of rows) {
    if (row.kind !== 'process') continue;
    // Keep an overview with its original item even if a later speech boundary splits a prepended group.
    const known = row.items.map(item => previousAnchors.get(item.id)).find(group => group && !used.has(group.key))
      ?? row.items.map(item => previousItems.get(item.id)).find(group =>
        group && !processIds.has(group.anchorId) && !used.has(group.key));
    row.key = known?.key ?? JSON.stringify(['process', row.items[0].id]);
    row.anchorId = known?.anchorId ?? row.items[0].id;
    let suffix = 0;
    while (used.has(row.key)) row.key = JSON.stringify(['process', row.items[0].id, ++suffix]);
    used.add(row.key);
  }
  return rows;
}
