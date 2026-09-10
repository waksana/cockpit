// Mode switcher popover — a compact horizontal segmented control of the three
// agent modes (icon-only, no text/checkmark). Anchored to the topbar mode button.
// Domain UI (tweb has no mode concept), built in the same visual language as the
// other menus: pinned to the trigger's live rect, dismiss on outside-click/Esc.

import { useLayoutEffect, useState, type RefObject } from 'react';
import { Icon, type IconName } from './Icon';
import { useMenuDismiss } from '../lib/useMenuDismiss';

export type SessionMode = 'interactive' | 'plan' | 'autopilot';

const MODES: SessionMode[] = ['interactive', 'plan', 'autopilot'];
const ICONS: Record<SessionMode, IconName> = {
  interactive: 'mode_interactive', plan: 'mode_plan', autopilot: 'mode_autopilot',
};
const LABELS: Record<SessionMode, string> = { interactive: '交互', plan: '计划', autopilot: '自动' };

export function ModeMenu({ triggerRef, current, running, onPick, onClose }: {
  triggerRef: RefObject<HTMLElement | null>;
  current: SessionMode | null;
  running: boolean;
  onPick: (mode: SessionMode) => void;
  onClose: () => void;
}) {
  // Pin the popover's right edge to the trigger (grows leftward — can't spill off
  // the right edge), just below it. Live rect read so it's always correctly placed.
  const [style, setStyle] = useState<{ right: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const t = triggerRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    setStyle({ right: Math.max(8, window.innerWidth - r.right), top: r.bottom + 4 });
  }, [triggerRef]);

  useMenuDismiss(onClose);

  return (
    <div
      className="btn-menu mode-menu active"
      role="menu"
      style={{
        right: style?.right ?? 8, top: style?.top ?? 0,
        visibility: style ? 'visible' : 'hidden',
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {running && <div className="mode-menu-note">切换将在下一轮生效</div>}
      <div className="mode-menu-row">
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="menuitemradio"
            aria-checked={m === current}
            aria-label={LABELS[m]}
            title={LABELS[m]}
            className="mode-menu-item rp"
            data-mode={m}
            data-active={m === current ? 'true' : 'false'}
            onClick={() => { onPick(m); onClose(); }}
          >
            <Icon name={ICONS[m]} size={24} />
          </button>
        ))}
      </div>
    </div>
  );
}
