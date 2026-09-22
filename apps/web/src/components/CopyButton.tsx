import { useLayoutEffect, useRef, useState } from 'react';
import { copyText } from '../lib/copyText';
import { Icon } from './Icon';

export function CopyButton({ text, label = '复制', variant = 'button' }: {
  text: string; label?: string; variant?: 'button' | 'value' | 'icon';
}) {
  const [feedback, setFeedback] = useState<{ text: string; state: 'copied' | 'failed' } | null>(null);
  const [pending, setPending] = useState(false);
  const owner = useRef<object | null>(null);
  const inFlight = useRef(false);
  useLayoutEffect(() => {
    owner.current = {};
    return () => { owner.current = null; };
  }, []);
  const state = feedback?.text === text ? feedback.state : null;
  async function copy() {
    if (inFlight.current) return;
    const scope = owner.current;
    inFlight.current = true;
    setPending(true);
    if (state === 'failed') setFeedback(null);
    try {
      await copyText(text);
      if (owner.current === scope) setFeedback({ text, state: 'copied' });
    } catch {
      if (owner.current === scope) setFeedback({ text, state: 'failed' });
    } finally {
      inFlight.current = false;
      if (owner.current === scope) setPending(false);
    }
  }
  const result = pending ? '正在复制…' : state === 'copied' ? '已复制' : state === 'failed' ? '复制失败，请选择文字后复制' : '';
  const valueFeedback = state === 'copied' ? '已复制' : null;
  return <span className={variant === 'value' ? 'chat-copy copy-value' : 'chat-copy'}>
    <button type="button" className={variant === 'value' ? 'copy-value-button ck-button'
      : variant === 'icon' ? 'chat-copy-icon ck-icon-button' : 'chat-copy-button ck-button'} aria-label={label} title={label}
      aria-disabled={pending || undefined} aria-busy={pending || undefined} onClick={() => void copy()}>
      {variant === 'value' ? <>
        <span className="copy-value-text" aria-hidden={!!valueFeedback || undefined}>{text}</span>
        {valueFeedback && <span className="copy-value-feedback">{valueFeedback}</span>}
      </> : <>
        <Icon name={state === 'copied' ? 'check' : 'copy'} size={16} />
        {variant !== 'icon' && <span className="chat-copy-label">
          <span className="chat-copy-label-size" aria-hidden="true">已复制</span>
          <span className="chat-copy-label-text">{state === 'copied' ? '已复制' : '复制'}</span>
        </span>}
      </>}
    </button>
    <span className={state === 'failed' ? 'chat-copy-error' : 'chat-sr-only'} role="status">{result}</span>
  </span>;
}
