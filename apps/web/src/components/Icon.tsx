// Shared icon vocabulary; refresh uses a plain circular arrow.

import type { HTMLAttributes } from 'react';

export type IconName =
  | 'search'
  | 'compose'
  | 'newchat'
  | 'delete'
  | 'back'
  | 'close'
  | 'check'
  | 'arrow_up'
  | 'more'
  | 'down'
  | 'up'
  | 'reload'
  | 'sending'
  | 'error'
  | 'menu'
  | 'skills'
  | 'mcp'
  | 'file'
  | 'folder'
  | 'mode_plan'
  | 'radiooff';

interface IconProps extends HTMLAttributes<HTMLSpanElement> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 24, style, ...rest }: IconProps) {
  if (name === 'reload') return <span className="refresh-icon" data-icon={name} aria-hidden="true"
    style={{ width: size, height: size, ...style }} {...rest}>
    <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" focusable="false">
      <path d="M20 10a8 8 0 1 0-2.35 7.65M20 4v6h-6"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </span>;
  return (
    <span
      className="tgico"
      data-icon={name}
      aria-hidden="true"
      style={{ fontSize: size, ...style }}
      {...rest}
    />
  );
}
