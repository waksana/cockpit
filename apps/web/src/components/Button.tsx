// Typed host buttons. Public ck-* classes remain the only appearance source;
// these components only choose the matching class set and native semantics.
import type { ComponentProps } from 'react';
import { Icon, type IconName } from './Icon';

type NativeButtonProps = Omit<ComponentProps<'button'>, 'type'> & { type?: 'button' | 'submit' | 'reset' };

export type ButtonVariant = 'default' | 'primary';
export type IconSize = 16 | 20 | 24;

function classes(base: string, variant: ButtonVariant, danger: boolean | undefined, className: string | undefined) {
  return [className, base, variant === 'primary' && 'ck-primary', danger && 'ck-danger'].filter(Boolean).join(' ');
}

// `variant="primary"` fills with the accent; `danger` switches the ink, or the
// fill when combined with primary (a filled destructive confirmation).
export function Button({ variant = 'default', danger, className, type = 'button', ...props }: NativeButtonProps & {
  variant?: ButtonVariant; danger?: boolean;
}) {
  return <button type={type} className={classes('ck-button', variant, danger, className)} {...props} />;
}

// An icon-only action always carries an accessible name. `busy` swaps the glyph
// for the shared spinner (the glyph size unless `busyIconSize` is given) and
// announces actual pending work.
export function IconButton({ icon, label, iconSize = 24, busyIconSize = iconSize, busy, variant = 'default', danger, className, type = 'button', 'aria-busy': ariaBusy, ...props }:
  Omit<NativeButtonProps, 'children' | 'aria-label'> & {
    icon: IconName; label: string; iconSize?: IconSize; busyIconSize?: IconSize; busy?: boolean; variant?: ButtonVariant; danger?: boolean;
  }) {
  return <button type={type} className={classes('ck-icon-button', variant, danger, className)} {...props}
    aria-label={label} aria-busy={busy ?? ariaBusy}>
    {busy ? <Icon name="loading" className="spinner" size={busyIconSize} /> : <Icon name={icon} size={iconSize} />}
  </button>;
}

// The single refresh control: a 20px glyph, replaced by the compact 16px
// spinner while pending. Owners decide availability through `disabled`.
export function RefreshButton({ onClick, disabled, pending, label = '刷新', title }: {
  onClick: () => void; disabled?: boolean; pending: boolean; label?: string; title?: string;
}) {
  return <IconButton icon="reload" iconSize={20} busyIconSize={16} label={label} title={title} busy={pending}
    disabled={disabled} onClick={onClick} />;
}
