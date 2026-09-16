import type { ChatMessage } from '@cockpit/protocol';

export function hasMessageContent(message: ChatMessage): boolean {
  return !!message.content.trim() || !!message.attachments?.length;
}

export const ORIGINAL_MARKDOWN_TARGET = 'data-module-markdown-target';

interface MarkdownTargetNode {
  type: string;
  url?: string;
  identifier?: string;
  children?: MarkdownTargetNode[];
  data?: { hProperties?: Record<string, unknown> };
}

// Preserve Markdown-decoded targets before mdast→hast normalizes spaces/Unicode.
export function remarkOriginalMarkdownTargets() {
  return (tree: MarkdownTargetNode): void => {
    const nodes: MarkdownTargetNode[] = [];
    const pending = [tree];
    const definitions = new Map<string, string>();
    while (pending.length) {
      const node = pending.pop()!;
      nodes.push(node);
      for (let index = (node.children?.length ?? 0) - 1; index >= 0; index--) pending.push(node.children![index]);
      if (node.type === 'definition' && node.identifier && typeof node.url === 'string') {
        const id = node.identifier.toUpperCase();
        if (!definitions.has(id)) definitions.set(id, node.url);
      }
    }
    for (const node of nodes) {
      const target = node.type === 'link' || node.type === 'image' ? node.url
        : (node.type === 'linkReference' || node.type === 'imageReference') && node.identifier
          ? definitions.get(node.identifier.toUpperCase()) : undefined;
      if (typeof target !== 'string') continue;
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties, [ORIGINAL_MARKDOWN_TARGET]: target } };
    }
  };
}

export function originalMarkdownTarget(node: { properties?: Record<string, unknown> } | undefined, fallback?: string): string | undefined {
  const target = node?.properties?.[ORIGINAL_MARKDOWN_TARGET];
  return typeof target === 'string' ? target : fallback;
}
