// Private semantic compositions; native controls consume the public UI baseline.
import { useId, type ComponentProps, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { Button } from './Button';

export function SectionHeading({ children, actions, className = '', level = 3 }: {
  children: ReactNode; actions?: ReactNode; className?: string; level?: 2 | 3;
}) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return <div className={`ui-section-heading ${className}`.trim()}>
    <Heading className="ck-heading">{children}</Heading>
    {actions && <div className="ui-section-actions">{actions}</div>}
  </div>;
}

// A compact text action placed beside a section heading's icon actions.
export function HeadingAction({ icon, children, className = '', ...props }: Omit<ComponentProps<'button'>, 'type'> & {
  icon?: IconName;
}) {
  return <Button {...props} className={`ui-heading-action ${className}`.trim()}>
    {icon && <Icon name={icon} size={16} />}
    {children}
  </Button>;
}

// A bordered group of full-row actions. Callers disable each row; the group
// only mutes the presentation and names the collection.
export function ActionList({ label, disabled, children }: {
  label: string; disabled?: boolean; children: ReactNode;
}) {
  return <div className="ui-action-list" role="group" aria-label={label} data-disabled={disabled || undefined}>
    {children}
  </div>;
}

export function ActionRow({ icon, name, description, busy, busyDescription = '处理中…', ...props }:
  Omit<ComponentProps<'button'>, 'type' | 'children' | 'name'> & {
    icon: IconName; name: string; description: string; busy?: boolean; busyDescription?: string;
  }) {
  const id = useId();
  return <Button {...props} className="ui-action-row"
    aria-labelledby={`${id}-name`} aria-describedby={`${id}-description`} aria-busy={busy || undefined}>
    <Icon name={icon} size={20} className="ui-action-icon" />
    <span className="ui-action-text">
      <span id={`${id}-name`} className="ui-action-name">{name}</span>
      <span id={`${id}-description`} className="ui-action-description">{busy ? busyDescription : description}</span>
    </span>
    {busy ? <Icon name="loading" size={16} className="ui-action-trailing spinner" />
      : <Icon name="chevron_right" size={16} className="ui-action-trailing" />}
  </Button>;
}

// Shown only while local edits or an unconfirmed submission exist; results stay
// with their owner outside this bar.
export function PendingChangesBar({ message, children }: { message: ReactNode; children: ReactNode }) {
  const id = useId();
  return <div className="ui-pending-bar" role="group" aria-labelledby={id}>
    <span id={id} className="ui-pending-message">{message}</span>
    <div className="ck-actions">{children}</div>
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
