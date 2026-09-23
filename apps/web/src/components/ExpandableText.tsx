// Two-line clamped text with an explicit full-text disclosure when it overflows.
import { useId, useState } from 'react';
import { useClippedText } from '../lib/useClippedText';
import { Button } from './Button';

export function ExpandableText({ text, label, className = '' }: {
  text: string; label: string; className?: string;
}) {
  const id = useId();
  const { ref, clipped } = useClippedText(text, 2);
  const [expandedText, setExpandedText] = useState<string | null>(null);
  const expanded = expandedText === text;
  return <div className={`panel-expandable ${className}`.trim()}>
    <span ref={ref} id={id} className="panel-expandable-text" data-expanded={expanded || undefined}>{text}</span>
    {clipped && <Button className="panel-expandable-toggle"
      aria-label={`${expanded ? '收起' : '展开'}${label}`} aria-expanded={expanded} aria-controls={id}
      onClick={() => setExpandedText(expanded ? null : text)}>{expanded ? '收起' : '展开全文'}</Button>}
  </div>;
}
