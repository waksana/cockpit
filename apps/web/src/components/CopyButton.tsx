import { useLayoutEffect, useRef, useState } from 'react';
import { copyText } from '../lib/copyText';
import { Icon } from './Icon';
import { Button, IconButton } from './Button';

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
  const shared = { title: label, 'aria-disabled': pending || undefined, 'aria-busy': pending || undefined,
    onClick: () => void copy() };
  return <span className={variant === 'value' ? 'chat-copy copy-value' : 'chat-copy'}>
    {variant === 'icon'
      ? <IconButton className="chat-copy-icon" icon={state === 'copied' ? 'check' : 'copy'} iconSize={16}
        label={label} {...shared} />
      : <Button className={variant === 'value' ? 'copy-value-button' : 'chat-copy-button'}
        aria-label={label} {...shared}>
        {variant === 'value' ? <>
          <span className="copy-value-text" aria-hidden={!!valueFeedback || undefined}>{text}</span>
          {valueFeedback && <span className="copy-value-feedback">{valueFeedback}</span>}
        </> : <>
          <Icon name={state === 'copied' ? 'check' : 'copy'} size={16} />
          <span className="chat-copy-label">
            <span className="chat-copy-label-size" aria-hidden="true">已复制</span>
            <span className="chat-copy-label-text">{state === 'copied' ? '已复制' : '复制'}</span>
          </span>
        </>}
      </Button>}
    <span className={state === 'failed' ? 'chat-copy-error' : 'chat-sr-only'} role="status">{result}</span>
  </span>;
}
