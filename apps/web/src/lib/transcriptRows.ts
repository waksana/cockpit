import type { ChatMessage, ToolCall } from '@cockpit/protocol';
import { hasMessageContent } from './messageContent';

export type ProcessItem =
  | { kind: 'thought'; key: string; message: ChatMessage }
  | { kind: 'tool'; key: string; message: ChatMessage; tool: ToolCall }
  | { kind: 'skill'; key: string; message: ChatMessage };

export type TranscriptRow =
  | { kind: 'message'; key: string; message: ChatMessage }
  | { kind: 'process'; key: string; anchorId: string; items: ProcessItem[] };

export function transcriptGap(previous: TranscriptRow | undefined, next: TranscriptRow): 'none' | 'related' | 'section' | 'speaker' {
  if (!previous) return 'none';
  const wasUser = previous.kind === 'message' && previous.message.role === 'user';
  const isUser = next.kind === 'message' && next.message.role === 'user';
  if (wasUser !== isUser) return 'speaker';
  if (previous.kind === 'process' || next.kind === 'process') return 'section';
  return 'related';
}

export function groupTranscript(messages: ChatMessage[], previous: TranscriptRow[] = []): TranscriptRow[] {
  const previousGroups = previous.filter(row => row.kind === 'process');
  const previousAnchors = new Map(previousGroups.map(row => [row.anchorId, row]));
  const previousItems = new Map(previousGroups.flatMap(row => row.items.map(item => [item.key, row] as const)));
  const used = new Set<string>();
  const rows: TranscriptRow[] = [];
  const process = (item: ProcessItem) => {
    const last = rows.at(-1);
    if (last?.kind === 'process') last.items.push(item);
    else rows.push({ kind: 'process', key: '', anchorId: item.key, items: [item] });
  };
  for (const message of messages) {
    if (message.subtype === 'skill') {
      process({ kind: 'skill', key: JSON.stringify(['skill', message.id]), message });
    } else if (message.role === 'assistant' && message.subtype !== 'subagent') {
      // One response has one reading layout, irrespective of which chunk arrived first.
      if (message.thought?.trim()) process({
        kind: 'thought', key: JSON.stringify(['thought', message.thoughtKey ?? message.id]), message,
      });
      if (hasMessageContent(message)) rows.push({ kind: 'message', key: message.id, message });
      for (const tool of message.toolCalls ?? []) {
        process({ kind: 'tool', key: JSON.stringify(['tool', tool.toolCallId]), message, tool });
      }
    } else {
      rows.push({ kind: 'message', key: message.id, message });
    }
  }
  const processIds = new Set(rows.flatMap(row => row.kind === 'process' ? row.items.map(item => item.key) : []));
  for (const row of rows) {
    if (row.kind !== 'process') continue;
    // Keep an overview with its original item even if a later speech boundary splits a prepended group.
    const known = row.items.map(item => previousAnchors.get(item.key)).find(group => group && !used.has(group.key))
      ?? row.items.map(item => previousItems.get(item.key)).find(group =>
        group && !processIds.has(group.anchorId) && !used.has(group.key));
    row.key = known?.key ?? JSON.stringify(['process', row.items[0].key]);
    row.anchorId = known?.anchorId ?? row.items[0].key;
    let suffix = 0;
    while (used.has(row.key)) row.key = JSON.stringify(['process', row.items[0].key, ++suffix]);
    used.add(row.key);
  }
  return rows;
}
