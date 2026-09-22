import { sidebarSessions } from './sidebar-fixtures';

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Classic sidebar regression: ${message}`);
}

export function runSidebarChecks() {
  check(import.meta.env.DEV && import.meta.env.COCKPIT_CHAT_LAB === true
    && new URLSearchParams(location.search).get('scene') === 'sidebar', 'isolated sidebar fixture required');
  const rows = Array.from(document.querySelectorAll<HTMLButtonElement>('.chatlist-chat'));
  const sessions = sidebarSessions();
  check(rows.length === sessions.length, 'all synthetic rows visible');
  check(!document.querySelector('.dialog-avatar'), 'no avatar or reserved avatar column');
  const measurements = rows.map(row => {
    const session = sessions.find(value => value.sessionId === row.dataset.sessionId)!;
    const title = row.querySelector<HTMLElement>('.session-row-title')!;
    const directory = row.querySelector<HTMLElement>('.dialog-subtitle')!;
    const time = row.querySelector<HTMLElement>('.dialog-time')!;
    const meta = row.querySelector<HTMLElement>('.dialog-meta')!;
    const roles = row.querySelector<HTMLElement>('.dialog-roles');
    const box = row.getBoundingClientRect();
    const titleBox = title.getBoundingClientRect();
    const titleStyle = getComputedStyle(title);
    const lineHeight = parseFloat(titleStyle.lineHeight);
    check(title.textContent === session.title, 'full title text retained');
    check(titleStyle.webkitLineClamp === '2', 'two-line title clamp');
    check(titleBox.height <= 2 * lineHeight + 1, 'title takes at most two lines');
    check(titleBox.left - box.left < 16, 'no empty avatar column');
    check(titleBox.right <= time.getBoundingClientRect().left, 'title does not overlap time');
    check(directory.textContent === session.cwd.split('/').at(-1), 'actual cwd basename');
    check(parseFloat(getComputedStyle(directory).fontSize) < parseFloat(titleStyle.fontSize), 'secondary directory size');
    check(directory.getBoundingClientRect().top >= titleBox.bottom - 1, 'directory below title');
    check(directory.getBoundingClientRect().right <= meta.getBoundingClientRect().left, 'directory does not overlap status');
    check(box.height >= 44, 'touch target retained');
    check(meta.getBoundingClientRect().right <= box.right, 'status inside row');
    for (const indicator of Array.from(meta.querySelectorAll<HTMLElement>('.session-activity-item, [data-sidebar-unread]'))) {
      const indicatorBox = indicator.getBoundingClientRect();
      check(indicatorBox.left >= meta.getBoundingClientRect().left - 1
        && indicatorBox.right <= meta.getBoundingClientRect().right + 1, 'all activity and unread indicators fit');
    }
    check(meta.querySelector('[data-sidebar-unread]'), 'module unread retained');
    if (roles) {
      check(roles.getBoundingClientRect().bottom <= titleBox.top, 'roles occupy the first row above title');
      check(row.firstElementChild === roles, 'role reading order matches visual order');
      check(roles.querySelectorAll('.role-badge').length === session.roles.length, 'all roles retained');
    } else {
      check(titleBox.top - box.top < 20, 'no empty role row');
    }
    if (!session.loaded) {
      check(titleStyle.opacity === '0.45' && getComputedStyle(directory).opacity === '0.45'
        && getComputedStyle(time).opacity === '0.45', 'unloaded identity remains dimmed');
      check(getComputedStyle(meta).opacity === '1', 'unloaded attention is not dimmed');
    }
    if (session.title === 'Short') check(titleBox.height <= lineHeight + 1, 'short title uses one line');
    if (session.sessionId === 'demo-chat' || session.sessionId === 'demo-api') {
      check(Math.abs(titleBox.height - 2 * lineHeight) < 1, 'long Chinese and unbroken English use two lines');
    }
    return { id: session.sessionId, rowHeight: box.height, titleHeight: titleBox.height, lineHeight };
  });
  for (const key of ['decision', 'shell', 'agent']) {
    check(rows[1].querySelector(`[data-activity="${key}"]`), `mixed ${key} indicator retained`);
  }
  check(document.documentElement.scrollWidth <= innerWidth, 'no page-wide overflow');
  return { viewport: [innerWidth, innerHeight], listWidth: rows[0].getBoundingClientRect().width, measurements };
}
