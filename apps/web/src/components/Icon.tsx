import type { HTMLAttributes } from 'react';
import {
  ArrowLeft, ArrowUp, BookOpen, Check, ChevronDown, ChevronRight, ChevronUp, Circle,
  Bot, CircleAlert, CircleCheck, CircleDashed, CircleHelp, ClipboardList, Clock, Copy, File,
  Folder, Lightbulb, Link, LoaderCircle, Menu, MessageSquare, MoreVertical, Play, RotateCw,
  ListOrdered, Search, Square, SquarePen, Terminal, Trash2, Wrench, X,
} from 'lucide-react';

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
  | 'thought'
  | 'mcp'
  | 'file'
  | 'folder'
  | 'mode_plan'
  | 'radiooff'
  | 'copy'
  | 'stop'
  | 'clock'
  | 'unknown'
  | 'chevron_right'
  | 'play'
  | 'success'
  | 'loading'
  | 'shell' | 'tool' | 'agent' | 'decision' | 'queue';

const icons = {
  search: Search, compose: SquarePen, newchat: MessageSquare, delete: Trash2,
  back: ArrowLeft, close: X, check: Check, arrow_up: ArrowUp, more: MoreVertical,
  down: ChevronDown, up: ChevronUp, reload: RotateCw, sending: Clock,
  error: CircleAlert, menu: Menu, skills: BookOpen, thought: Lightbulb, mcp: Link, file: File,
  folder: Folder, mode_plan: ClipboardList, radiooff: Circle, copy: Copy,
  stop: Square, clock: Clock, unknown: CircleDashed, chevron_right: ChevronRight,
  play: Play, success: CircleCheck, loading: LoaderCircle,
  shell: Terminal, tool: Wrench, agent: Bot, decision: CircleHelp, queue: ListOrdered,
} satisfies Record<IconName, typeof Search>;

interface IconProps extends HTMLAttributes<HTMLSpanElement> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 24, className = '', style, ...rest }: IconProps) {
  const Glyph = icons[name];
  return (
    <span {...rest} className={`ck-icon ${className}`.trim()} data-icon={name}
      aria-hidden="true" style={{ width: size, height: size, ...style }}>
      <Glyph width="100%" height="100%" aria-hidden="true" focusable="false" />
    </span>
  );
}
