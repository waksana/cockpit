type Geometry = { top: number; height: number; viewport: number; width: number };
type Anchor = { id: string; offset: number };
export const READING_ACTIVITY_EVENT = 'cockpit:thread-reading-activity';
type ReadingPosition = { following: boolean; anchor: Anchor | null };

export interface ThreadScrollView {
  measure(): Geometry;
  firstVisible(): Anchor | null;
  offset(id: string): number | null;
  write(top: number): void;
}

const EPSILON = 1;
const atBottom = (g: Geometry) => Math.abs(Math.max(0, g.height - g.viewport) - g.top) <= 2;
const resized = (a: Geometry, b: Geometry) => (
  Math.abs(a.height - b.height) >= EPSILON
  || Math.abs(a.viewport - b.viewport) >= EPSILON
  || Math.abs(a.width - b.width) >= EPSILON
);

interface MessageFrame {
  getBoundingClientRect(): { top: number; bottom: number };
  querySelector(selector: string): {
    getBoundingClientRect(): { top: number; bottom: number };
    getAttribute(name: string): string | null;
    querySelectorAll?(selector: string): ArrayLike<MessageFrame>;
  } | null;
}

export function firstVisibleMessage(rows: ArrayLike<MessageFrame>, start: number, viewport: number): Anchor | null {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid].getBoundingClientRect().bottom <= start + EPSILON) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < rows.length; i++) {
    if (rows[i].getBoundingClientRect().top >= start + viewport) break;
    const nested = rows[i].querySelector('[data-child-history]');
    if (nested && nested.getBoundingClientRect().top <= start + EPSILON) {
      const children = nested.querySelectorAll?.(':scope > [data-child-message-frame]');
      const child = children && firstVisibleMessage(children, start, viewport);
      if (child) return child;
    }
    const row = rows[i].querySelector('[data-message-id]');
    if (!row) continue;
    const rect = row.getBoundingClientRect();
    const id = row.getAttribute('data-message-id');
    if (id !== null && rect.bottom > start + EPSILON && rect.top < start + viewport) {
      return { id, offset: rect.top - start };
    }
  }
  return null;
}

// The only scroll-position writer. Geometry may maintain follow, never enable it.
export class ThreadScroll {
  following = true;
  revision = 0;
  private geometry: Geometry;
  private anchor: Anchor | null;
  private frame: number | null = null;
  private disposed = false;
  private touching = false;
  private moving = false;
  private towardBottom = false;
  private reachedBottom = false;
  private forced = false;
  private reportedActive = false;
  private onActivity: (active: boolean) => void;
  private view: ThreadScrollView;
  private frames: { request(callback: () => void): number; cancel(id: number): void };
  private onFollow: () => void;

  constructor(
    view: ThreadScrollView,
    frames: { request(callback: () => void): number; cancel(id: number): void },
    onFollow: () => void,
    onActivity: (active: boolean) => void = () => {},
  ) {
    this.view = view;
    this.frames = frames;
    this.onFollow = onFollow;
    this.onActivity = onActivity;
    this.geometry = view.measure();
    this.anchor = view.firstVisible();
  }

  private cancelFrame() {
    if (this.frame !== null) this.frames.cancel(this.frame);
    this.frame = null;
  }

  private remember() {
    this.geometry = this.view.measure();
    this.anchor = this.view.firstVisible();
  }

  private reportActivity() {
    const active = this.touching || this.moving;
    if (active === this.reportedActive) return;
    this.reportedActive = active;
    this.onActivity(active);
  }

  private read() {
    this.following = false;
    this.forced = false;
    this.reachedBottom = false;
    this.revision++;
    this.cancelFrame();
  }

  hold(touching: boolean) {
    this.touching = touching;
    if (touching) this.cancelFrame();
    this.reportActivity();
  }

  intent(towardBottom: boolean) {
    this.read();
    this.moving = true;
    this.towardBottom = towardBottom;
    this.reachedBottom = towardBottom && atBottom(this.view.measure());
    this.reportActivity();
  }

  // Expanding an in-view row should open in place, not chase its new bottom.
  interact() {
    this.read();
    this.remember();
  }

  navigate() {
    this.read();
    this.moving = true;
    this.towardBottom = false;
    this.remember();
    this.reportActivity();
  }

  scroll() {
    const next = this.view.measure();
    if (Math.abs(next.top - this.geometry.top) < EPSILON) return;
    if (this.moving || !resized(next, this.geometry)) {
      const reachedBottom = this.moving && this.towardBottom
        && !resized(next, this.geometry) && atBottom(next);
      this.read();
      this.reachedBottom = reachedBottom;
      this.moving = true;
      this.remember();
      this.reportActivity();
    }
    // A clamp after reflow is geometry, not evidence of user intent.
  }

  settle() {
    if (this.touching || this.disposed) return;
    if (this.moving && this.reachedBottom && atBottom(this.view.measure())) {
      this.following = true;
      this.onFollow();
    }
    this.moving = false;
    this.towardBottom = false;
    this.reachedBottom = false;
    this.reportActivity();
    this.changed();
  }

  follow() {
    if (this.disposed) return;
    this.following = true;
    this.forced = true;
    this.moving = false;
    this.towardBottom = false;
    this.onFollow();
    this.reportActivity();
    this.changed();
  }

  position(): ReadingPosition {
    return { following: this.following, anchor: this.view.firstVisible() };
  }

  changed() {
    if (this.disposed || this.touching || this.moving || this.frame !== null) return;
    const g = this.view.measure();
    const offset = this.anchor && this.view.offset(this.anchor.id);
    const shifted = offset != null && this.anchor && Math.abs(offset - this.anchor.offset) >= EPSILON;
    if (!this.forced && !resized(g, this.geometry) && !shifted) return;
    const revision = this.revision;
    const frame = this.frames.request(() => {
      if (this.disposed || this.frame !== frame || revision !== this.revision) return;
      this.frame = null;
      const now = this.view.measure();
      const currentOffset = this.anchor && this.view.offset(this.anchor.id);
      const target = this.following
        ? Math.max(0, now.height - now.viewport)
        : now.top + (currentOffset != null && this.anchor ? currentOffset - this.anchor.offset : 0);
      const clamped = Math.max(0, Math.min(target, Math.max(0, now.height - now.viewport)));
      // scrollHeight/clientHeight round to integers, including subpixel reflow.
      if (Math.abs(clamped - now.top) > EPSILON) this.view.write(clamped);
      this.forced = false;
      this.remember();
    });
    this.frame = frame;
  }

  dispose() {
    this.disposed = true;
    this.cancelFrame();
  }
}

export function observeThreadScroll(el: HTMLDivElement, content: HTMLDivElement, onFollow: () => void,
  onActivity?: (active: boolean) => void, onAwayChange?: (away: boolean) => void) {
  const top = () => el.getBoundingClientRect().top + el.clientTop;
  let away = false;
  const reportDistance = () => {
    const viewport = el.clientHeight;
    const next = viewport > 0 && el.scrollHeight - viewport - el.scrollTop >= viewport;
    if (away !== next) { away = next; onAwayChange?.(next); }
  };
  const scroll = new ThreadScroll({
    measure: () => ({ top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight, width: el.clientWidth }),
    firstVisible: () => {
      // Search outer boxes without forcing layout inside skipped history.
      const rows = content.querySelectorAll<HTMLElement>('[data-message-frame]');
      return firstVisibleMessage(rows, top(), el.clientHeight);
    },
    offset: (id) => {
      const row = content.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
      return row && !row.closest('[hidden]') ? row.getBoundingClientRect().top - top() : null;
    },
    write: (value) => { el.scrollTop = value; reportDistance(); },
  }, {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (id) => cancelAnimationFrame(id),
  }, onFollow, active => {
    onActivity?.(active);
    el.dispatchEvent(new CustomEvent(READING_ACTIVITY_EVENT, { detail: active }));
  });

  // scrollend where supported; a trailing event timer otherwise (never polling).
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const settle = () => { clearTimeout(settleTimer); scroll.settle(); };
  const later = () => { clearTimeout(settleTimer); settleTimer = setTimeout(settle, 180); };
  let mouseTop: number | null = null;
  const onScroll = () => {
    if (mouseTop !== null && Math.abs(el.scrollTop - mouseTop) >= EPSILON) {
      scroll.intent(el.scrollTop > mouseTop);
      mouseTop = el.scrollTop;
    }
    scroll.scroll();
    reportDistance();
    later();
  };
  let touchY = 0;
  const onTouchStart = (event: TouchEvent) => {
    touchY = event.touches[0]?.clientY ?? 0;
    scroll.hold(true);
  };
  const onTouchMove = (event: TouchEvent) => {
    const y = event.touches[0]?.clientY ?? touchY;
    if (Math.abs(y - touchY) < EPSILON) return;
    scroll.intent(y < touchY);
    touchY = y;
    const active = document.activeElement;
    if (active instanceof HTMLElement && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) active.blur();
  };
  const onTouchEnd = () => { scroll.hold(false); later(); };
  const onWheel = (event: WheelEvent) => {
    if (event.deltaY === 0 || event.ctrlKey) return;
    scroll.intent(event.deltaY > 0);
    later();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.target !== el) return;
    if (event.key === 'End' && !event.shiftKey) {
      event.preventDefault();
      scroll.follow();
      return;
    }
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      scroll.intent(['ArrowDown', 'PageDown', 'End'].includes(event.key) || (event.key === ' ' && !event.shiftKey));
      later();
    }
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.target === el) {
      mouseTop = el.scrollTop;
      scroll.hold(true);
    }
  };
  const onPointerUp = () => {
    if (mouseTop === null) return;
    mouseTop = null;
    scroll.hold(false);
    later();
  };
  const onClick = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest('button[aria-expanded], summary')) scroll.interact();
  };
  const navigate = () => { scroll.navigate(); later(); };
  const onSelection = () => {
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed
      && (content.contains(selection.anchorNode) || content.contains(selection.focusNode))) navigate();
  };
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { scroll.changed(); reportDistance(); });
  ro?.observe(el);
  ro?.observe(content);
  el.addEventListener('scroll', onScroll, { passive: true });
  el.addEventListener('scrollend', settle);
  el.addEventListener('touchstart', onTouchStart, { passive: true });
  el.addEventListener('touchmove', onTouchMove, { passive: true });
  el.addEventListener('touchend', onTouchEnd, { passive: true });
  el.addEventListener('touchcancel', onTouchEnd, { passive: true });
  el.addEventListener('wheel', onWheel, { passive: true });
  el.addEventListener('keydown', onKey);
  el.addEventListener('pointerdown', onPointerDown, { passive: true });
  document.addEventListener('pointerup', onPointerUp, { passive: true });
  document.addEventListener('pointercancel', onPointerUp, { passive: true });
  content.addEventListener('click', onClick, true);
  content.addEventListener('focusin', navigate);
  document.addEventListener('selectionchange', onSelection);
  scroll.follow();
  return {
    scroll,
    dispose() {
      scroll.dispose();
      ro?.disconnect();
      clearTimeout(settleTimer);
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('scrollend', settle);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);
      content.removeEventListener('click', onClick, true);
      content.removeEventListener('focusin', navigate);
      document.removeEventListener('selectionchange', onSelection);
    },
  };
}
