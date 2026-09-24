import { sidebarSessions } from './sidebar-fixtures';

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Sidebar regression: ${message}`);
}

// Fixture titles that exceed two lines at every supported width.
const clampedTitles = new Set(['demo-extreme', 'demo-api']);

function titleLineRects(title: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(title);
  return range.getClientRects();
}

const allStatus = ['overall', 'decision', 'compaction', 'agent', 'shell', 'queue', 'mcp'];

export function runSidebarChecks() {
  check(import.meta.env.DEV && import.meta.env.COCKPIT_CHAT_LAB === true
    && new URLSearchParams(location.search).get('scene') === 'sidebar', 'isolated sidebar fixture required');
  const rows = Array.from(document.querySelectorAll<HTMLButtonElement>('.chatlist-chat'));
  const sessions = sidebarSessions();
  check(rows.length === sessions.length, 'all synthetic rows visible');
  check(!document.querySelector('.dialog-avatar'), 'no avatar or reserved avatar column');
  const oneLineHeights = new Set<number>();
  const twoLineHeights = new Set<number>();
  const measurements = rows.map(row => {
    const session = sessions.find(value => value.sessionId === row.dataset.sessionId)!;
    const title = row.querySelector<HTMLElement>('.session-row-title')!;
    const time = row.querySelector<HTMLElement>('.dialog-time')!;
    const details = row.querySelector<HTMLElement>('.session-row-details')!;
    const directory = details.querySelector<HTMLElement>('.dialog-subtitle')!;
    const meta = details.querySelector<HTMLElement>('.dialog-meta')!;
    const roles = details.querySelector<HTMLElement>('.dialog-roles');
    const box = row.getBoundingClientRect();
    const contentRight = box.right - parseFloat(getComputedStyle(row).paddingRight);
    const titleBox = title.getBoundingClientRect();
    const timeBox = time.getBoundingClientRect();
    const detailsBox = details.getBoundingClientRect();
    const directoryBox = directory.getBoundingClientRect();
    const metaBox = meta.getBoundingClientRect();
    const titleStyle = getComputedStyle(title);
    const lineHeight = parseFloat(titleStyle.lineHeight);

    check(Array.from(row.children).map(child => child.className).join('|')
      === 'session-row-title|dialog-time|session-row-details', 'two-line reading order matches visual order');
    check(title.textContent === session.title && title.title === session.title, 'full title text and hover retained');
    // Title lines as laid out; clamped text below the second line is hidden.
    const lineRects = Array.from(titleLineRects(title)).filter(rect => rect.width > 0 && rect.top < titleBox.bottom - 1);
    const lineTops = [...new Set(lineRects.map(rect => Math.round(rect.top)))].sort((a, b) => a - b);
    const lines = Math.round(titleBox.height / lineHeight);
    check(titleStyle.webkitLineClamp === '2' && titleStyle.overflow === 'hidden', 'title clamps at two lines');
    check(lines >= 1 && lines <= 2 && Math.abs(titleBox.height - lines * lineHeight) <= 1, 'title takes one or two whole lines');
    check(lineTops.length === lines, 'height follows the rendered title lines');
    check(title.scrollHeight <= title.clientHeight + 1 || lines === 2, 'only a two-line title truncates');
    if (session.title.length <= 20) check(lines === 1, 'short title keeps one line');
    if (clampedTitles.has(session.sessionId)) {
      check(lines === 2 && title.scrollHeight > title.clientHeight + 1, 'long title stops at two lines with an ellipsis');
    }
    check(titleBox.left - box.left < 16, 'no empty avatar column');
    check(titleBox.right <= timeBox.left + 0.5 && lineRects.every(rect => rect.right <= timeBox.left + 0.5),
      'every title line stays left of the time');
    check(time.scrollWidth <= time.clientWidth + 0.5 && timeBox.right <= contentRight + 0.5, 'time fully visible');
    check(Math.abs(timeBox.top + timeBox.height / 2 - (titleBox.top + lineHeight / 2)) < 3, 'time on the first title line');
    check(detailsBox.top >= titleBox.bottom - 1, 'details line below title');
    check(detailsBox.height <= 24 && detailsBox.right <= contentRight + 0.5, 'details stay on one line inside the row');
    check(box.bottom - detailsBox.bottom < 12, 'no third line');
    check(directory.textContent === session.cwd.split('/').filter(Boolean).at(-1), 'actual cwd basename');
    check(directory.title === session.cwd, 'full directory on hover');
    check(parseFloat(getComputedStyle(directory).fontSize) < parseFloat(titleStyle.fontSize), 'secondary directory size');
    check(directoryBox.right <= metaBox.left + 0.5, 'directory does not overlap status');
    check(meta.scrollWidth <= meta.clientWidth + 0.5 && metaBox.right <= contentRight + 0.5, 'status never clipped');
    for (const indicator of Array.from(meta.querySelectorAll<HTMLElement>('.session-activity-item, [data-sidebar-unread]'))) {
      const indicatorBox = indicator.getBoundingClientRect();
      check(indicatorBox.left >= metaBox.left - 0.5 && indicatorBox.right <= metaBox.right + 0.5,
        'all activity and unread indicators fit');
    }
    check(meta.querySelector('[data-sidebar-unread]'), 'module unread retained');
    check(box.height >= 44, 'touch target retained');
    if (roles) {
      const rolesBox = roles.getBoundingClientRect();
      const badges = Array.from(roles.querySelectorAll<HTMLElement>('.role-badge'));
      check(badges.length === session.roles.length, 'all roles retained');
      check(rolesBox.right <= directoryBox.left + 0.5, 'roles precede the directory without overlap');
      // Below a 320px viewport the last stubs may clip at the end; status still wins.
      if (innerWidth >= 320) check(roles.scrollWidth <= roles.clientWidth + 0.5, 'every role badge remains visible');
      const truncated = Array.from(roles.querySelectorAll<HTMLElement>('.module-label-name, .role-badge-name'))
        .some(part => part.scrollWidth > part.clientWidth);
      check(!truncated || directoryBox.width < 0.5, 'directory yields entirely before roles ellipsize');
      for (const badge of badges) {
        const badgeBox = badge.getBoundingClientRect();
        check(badgeBox.width >= 11.5 - 0.5 && badgeBox.top >= rolesBox.top - 0.5 && badgeBox.bottom <= rolesBox.bottom + 0.5,
          'role badges shrink to stubs without wrapping');
        check(badge.title.includes(badge.querySelector('.role-badge-name')!.textContent!), 'full role on hover');
      }
    }
    if (!session.loaded) {
      check(titleStyle.opacity === '0.45' && getComputedStyle(directory).opacity === '0.45'
        && getComputedStyle(time).opacity === '0.45', 'unloaded identity remains dimmed');
      check(getComputedStyle(meta).opacity === '1', 'unloaded attention is not dimmed');
    }
    (lines === 1 ? oneLineHeights : twoLineHeights).add(Math.round(box.height));
    return { id: session.sessionId, titleLines: lines, rowHeight: box.height, directoryWidth: directoryBox.width,
      rolesWidth: roles?.getBoundingClientRect().width ?? 0, statusWidth: metaBox.width };
  });
  check(oneLineHeights.size === 1, `one-line titles share the current row height (${[...oneLineHeights].join(', ')})`);
  const [oneLine] = oneLineHeights;
  const titleLine = parseFloat(getComputedStyle(rows[0].querySelector('.session-row-title')!).lineHeight);
  check(twoLineHeights.size >= 1 && [...twoLineHeights].every(height => Math.abs(height - oneLine - titleLine) <= 1),
    `a two-line title adds exactly one title line (${[...twoLineHeights].join(', ')})`);
  for (const key of ['decision', 'shell', 'agent']) {
    check(rows[1].querySelector(`[data-activity="${key}"]`), `mixed ${key} indicator retained`);
  }
  const extreme = rows.find(row => row.dataset.sessionId === 'demo-extreme')!;
  for (const key of allStatus) check(extreme.querySelector(`[data-activity="${key}"]`), `extreme ${key} indicator retained`);
  check(document.documentElement.scrollWidth <= innerWidth, 'no page-wide overflow');
  return { viewport: [innerWidth, innerHeight], listWidth: rows[0].getBoundingClientRect().width, measurements };
}
