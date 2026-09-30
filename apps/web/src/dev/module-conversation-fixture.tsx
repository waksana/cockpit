import type { ModuleFrontendContext } from '@cockpit/module-api/frontend';
import { ModuleRuntime } from '../lib/moduleRuntime';

function page(context: ModuleFrontendContext) {
  const { createElement: h, useLayoutEffect, useRef, useState } = context.react;
  const Frame = context.components.get('conversationFrame'), Header = context.components.get('conversationHeader');
  const Transcript = context.components.get('conversationTranscript'), Message = context.components.get('chatMessage');
  const Composer = context.components.get('composer'), Button = context.components.get('button');
  const text = (value: unknown) => {
    if (typeof value !== 'string') throw new Error('Expected synthetic text');
    return value;
  };
  const draft = context.state.createDraft({
    key: 'lab-conversation', purpose: { kind: 'prompt' },
    facts: { editable: true, submittable: true, actionRevision: 0, capabilities: { attachments: false } },
    prepare: snapshot => snapshot.text, validateRequest: text, validateReceipt: text,
    send: async request => ({ status: 'accepted', receipt: request }),
    inspect: async request => ({ status: 'accepted', receipt: request }),
  });
  return function ConversationExample() {
    const [rows, setRows] = useState(() => Array.from({ length: 24 }, (_, index) => index + 1));
    const [topic, setTopic] = useState(false);
    const [notice, setNotice] = useState(false);
    const scroll = context.conversation.useScroll({ key: 'lab-conversation', items: rows, itemKey: String });
    const { changed, viewport, content } = scroll;
    const last = rows.at(-1);
    const previous = useRef(last);
    useLayoutEffect(() => {
      changed({ contentReady: true, newContent: previous.current !== last });
      previous.current = last;
    }, [rows, scroll.items, last, topic, changed, viewport, content]);
    return h(Frame, {
      header: h(Header, { title: h('h1', { className: 'ck-heading' }, 'Public conversation'),
        actions: h('div', { className: 'ck-actions' },
          h(Button, { onClick: () => setRows(current => [...current, current.at(-1)! + 1]) }, 'Append reply'),
          h(Button, { onClick: () => setTopic(current => !current) }, 'Toggle topic'),
          h(Button, { onClick: () => setNotice(current => !current) }, 'Toggle notice')) }),
      notices: notice ? h('p', { role: 'alert' }, 'Synthetic unknown send: preserved, never resent.') : null,
      composer: h(Composer, { draft: draft.reference, operation: 'prompt', disabled: false, busy: false,
        sendBlocked: false, onTextChange: draft.editText, onSubmit: () => { void draft.submit(); } }),
      children: h(Transcript, {
        viewportRef: scroll.viewportRef, contentRef: scroll.contentRef,
        awayFromBottom: scroll.awayFromBottom, hasNewContent: scroll.hasNewContent, onFollow: scroll.follow,
        before: h(Button, { onClick: () => setRows(current => [current[0] - 1, ...current]) }, 'Earlier messages'),
        children: scroll.items.map((id, index) => h(Message, {
          key: id, identity: { owner: 'conversation-example', kind: 'message', role: 'assistant', id: String(id) },
          role: 'assistant', complete: true, timestamp: 1_750_000_000_000 + id * 1000,
          previous: index ? { role: 'assistant', timestamp: 1_750_000_000_000 + scroll.items[index - 1] * 1000 } : undefined,
          header: topic ? h('h3', { className: 'ck-heading' }, 'Synthetic topic') : undefined,
          body: `Reply ${id}\n\nComplete **Markdown** remains visible.\n\n- Train\n- Plane\n\nAnswer using the same composer.`,
        })),
      }),
    });
  };
}

export function createConversationFixture() {
  const digest = 'd'.repeat(64);
  return new ModuleRuntime({
    pageUrl: 'https://fixture.invalid/',
    fetch: async () => Response.json({ errors: [], modules: [{
      id: 'conversation-example', name: 'Conversation example', version: '1.0.0', digest, config: {}, styles: [],
      apiBase: `/_modules/conversation-example/${digest}/api`,
      entry: `/_modules/assets/conversation-example/${digest}/entry.js`,
    }] }),
    load: async () => ({ frontendApiVersion: 3, activate: (context: ModuleFrontendContext) => ({
      apiVersion: 3, pages: [{ id: 'main', component: page(context) }],
    }) }),
  });
}
