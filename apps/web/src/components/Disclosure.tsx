// The two disclosure primitives (docs/frontend-guidelines.md#disclosure):
// `Disclosure` is a row that shows or hides one region; `TextClamp` clips long
// text to a line budget and offers 展开全文 only when the text is really clipped.
import { useId, useState, type ReactNode } from 'react';
import { useClippedText } from '../lib/useClippedText';
import { Button } from './Button';
import { Icon } from './Icon';

// › collapsed, ⌄ expanded.
export function DisclosureChevron({ open }: { open: boolean }) {
  return <Icon name={open ? 'down' : 'chevron_right'} className="ui-disclosure-chevron" size={16} />;
}

// A controlled row: leading chevron (or an owner icon), label, optional right
// meta. `name` completes the accessible 展开/收起 name when the label is not text.
export function Disclosure({ open, onToggle, controls, label, name, meta, leading, className = '', title, children }: {
  open: boolean; onToggle: () => void; controls?: string;
  label?: ReactNode; name: string; meta?: ReactNode; leading?: ReactNode;
  className?: string; title?: string; children?: ReactNode;
}) {
  return <Button className={`${className} ui-disclosure`.trim()} aria-expanded={open} aria-controls={controls}
    aria-label={`${open ? '收起' : '展开'}${name}`} title={title} onClick={onToggle}>
    {leading ?? <DisclosureChevron open={open} />}
    {children ?? <span className="ui-disclosure-label">{label}</span>}
    {meta && <span className="ui-disclosure-meta">{meta}</span>}
  </Button>;
}

// An uncontrolled row plus its region; replaces native <details>/<summary>.
export function DisclosureSection({ label, name = typeof label === 'string' ? label : '详情', meta, defaultOpen = false,
  className = '', children }: {
  label: ReactNode; name?: string; meta?: ReactNode; defaultOpen?: boolean; className?: string; children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  return <div className={`ui-disclosure-section ${className}`.trim()} data-open={open || undefined}>
    <Disclosure open={open} onToggle={() => setOpen(!open)} controls={id} label={label} name={name} meta={meta} />
    <div id={id} className="ui-disclosure-region" hidden={!open}>{children}</div>
  </div>;
}

// Text clipped to `lines`. The toggle appears only when the text overflows.
// Inside a link (`expandable={false}`) the full text stays in the title instead.
export function TextClamp({ text, label, lines = 2, expandable = true, className = '' }: {
  text: string; label: string; lines?: 1 | 2 | 3; expandable?: boolean; className?: string;
}) {
  const id = useId();
  const { ref, clipped } = useClippedText(text, lines);
  const [expandedText, setExpandedText] = useState<string | null>(null);
  const expanded = expandable && expandedText === text;
  return <span className={`ui-text-clamp ${className}`.trim()} data-lines={lines} data-expanded={expanded || undefined}>
    <span ref={ref} id={id} className="ui-text-clamp-text" data-lines={lines}
      title={expandable ? undefined : text}>{text}</span>
    {expandable && clipped && <Button className="ui-text-clamp-toggle"
      aria-label={`${expanded ? '收起' : '展开'}${label}`} aria-expanded={expanded} aria-controls={id}
      onClick={() => setExpandedText(expanded ? null : text)}>{expanded ? '收起' : '展开全文'}</Button>}
  </span>;
}
