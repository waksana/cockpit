import { useLayoutEffect, useRef, useState } from 'react';
import { copyText } from '../lib/copyText';
import { Icon } from './Icon';

export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [feedback, setFeedback] = useState<{ text: string; state: 'pending' | 'copied' | 'failed' } | null>(null);
  const owner = useRef<object | null>(null);
  const pending = useRef(false);
  useLayoutEffect(() => {
    owner.current = {};
    return () => { owner.current = null; };
  }, []);
  const state = feedback?.text === text ? feedback.state : null;
  async function copy() {
    if (pending.current) return;
    const scope = owner.current;
    pending.current = true;
    setFeedback({ text, state: 'pending' });
    try {
      await copyText(text);
      if (owner.current === scope) setFeedback({ text, state: 'copied' });
    } catch {
      if (owner.current === scope) setFeedback({ text, state: 'failed' });
    } finally {
      pending.current = false;
    }
  }
  const result = state === 'copied' ? '已复制' : state === 'failed' ? '复制失败，请选择文字后复制' : '';
  return <span className="chat-copy">
    <button type="button" className="chat-copy-button" aria-label={label} title={label}
      aria-disabled={state === 'pending' || undefined} onClick={() => void copy()}>
      <Icon name={state === 'copied' ? 'check' : 'file'} size={14} />
      <span>{state === 'pending' ? '复制中…' : state === 'copied' ? '已复制' : '复制'}</span>
    </button>
    <span className={state === 'failed' ? 'chat-copy-error' : 'chat-sr-only'} role="status">{result}</span>
  </span>;
}
