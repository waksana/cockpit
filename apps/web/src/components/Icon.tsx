// Icon — renders a real Telegram tgico glyph (font in styles/tgico.scss). The
// `name` maps to a tgico data-icon; size sets the font-size. This replaces the
// hand-drawn SVG set with Telegram's authentic icons.

import type { HTMLAttributes } from 'react';

export type IconName =
  | 'search'
  | 'compose'
  | 'newchat'
  | 'delete'
  | 'pin'
  | 'unpin'
  | 'send'
  | 'microphone'
  | 'back'
  | 'close'
  | 'check'
  | 'checks'
  | 'arrow_down'
  | 'arrow_up'
  | 'more'
  | 'down'
  | 'up'
  | 'reload'
  | 'unload'
  | 'sending'
  | 'error'
  | 'menu'
  | 'skills'
  | 'mcp'
  | 'attach'
  | 'file'
  | 'folder'
  | 'mode_plan'
  | 'radiooff';

export interface IconProps extends HTMLAttributes<HTMLSpanElement> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 24, style, ...rest }: IconProps) {
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
