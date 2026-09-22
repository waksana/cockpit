// Private semantic compositions; native controls consume the public UI baseline.
import type { ComponentProps, ReactNode } from 'react';
import { Icon } from './Icon';

export function SectionHeading({ children, actions, className = '', level = 3 }: {
  children: ReactNode; actions?: ReactNode; className?: string; level?: 2 | 3;
}) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return <div className={`ui-section-heading ${className}`.trim()}>
    <Heading className="ck-heading">{children}</Heading>
    {actions}
  </div>;
}

export function SelectField({ label, children, className = '', ...props }: ComponentProps<'select'> & {
  label: string;
}) {
  return <label className="ui-field">
    <span className="ui-field-label">{label}</span>
    <span className="ui-select-wrap">
      <select {...props} className={`ck-input ui-select ${className}`.trim()}>{children}</select>
      <Icon name="down" size={16} />
    </span>
  </label>;
}

export function CheckboxCard({ children, className = '', ...props }: Omit<ComponentProps<'input'>, 'type' | 'children'> & {
  children: ReactNode; checked: boolean;
}) {
  return <label className={`ui-choice-card ${className}`.trim()} data-selected={props.checked || undefined}>
    <input {...props} className="ui-visually-hidden" type="checkbox" />
    <Icon name="check" size={18} className="ui-choice-check" />
    <span className="ui-choice-content">{children}</span>
  </label>;
}

export function Toggle({ on, onChange, disabled, label, busy }: {
  on: boolean; onChange: (value: boolean) => void; disabled?: boolean; label: string; busy?: boolean;
}) {
  return <button type="button" role="switch" aria-label={label} aria-checked={on}
    aria-busy={busy || undefined} disabled={disabled} className={`switch ck-button${on ? ' is-on' : ''}`}
    onClick={() => onChange(!on)}><span className="switch-knob" /></button>;
}

export function Badge({ children, tone = 'neutral', appearance = 'subtle', className = '', ...props }: ComponentProps<'span'> & {
  tone?: 'neutral' | 'ok' | 'err' | 'warn' | 'pending' | 'off';
  appearance?: 'subtle' | 'text';
}) {
  return <span {...props} className={`ck-badge ui-badge ${className}`.trim()} data-tone={tone} data-appearance={appearance}>{children}</span>;
}
