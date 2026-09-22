import type { NextLabControls } from './next-lab';

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Next workspace regression: ${message}`);
}
const frames = async () => {
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
};
async function until<T>(read: () => T, label: string): Promise<NonNullable<T>> {
  const end = performance.now() + 4000;
  while (performance.now() < end) {
    const value = read();
    if (value) return value;
    await frames();
  }
  throw new Error(`Next workspace timed out: ${label}`);
}

export async function runNextWorkspaceChecks(lab: NextLabControls = window.nextLab) {
  check(import.meta.env.DEV && import.meta.env.COCKPIT_CHAT_LAB === true && lab, 'isolated App lab required');
  lab.connected(true);
  lab.operations.hold(false);
  lab.operations.outcome('success');
  lab.navigate('/session/fixture-next-missing/info');
  const missing = await until(() => {
    const heading = document.querySelector<HTMLElement>('.next-page-empty h1');
    return heading?.textContent?.includes('会话不存在') ? heading : null;
  }, 'missing-session settings deep link');
  check(missing.getBoundingClientRect().height > 0, 'missing phone settings must not hide its recovery page');
  lab.navigate('/');
  const nav = await until(() => {
    const element = document.querySelector<HTMLElement>('.next-session-workspace[data-conversation="false"] .next-session-nav');
    return element && element.getBoundingClientRect().height > 0 ? element : null;
  }, 'session list navigation');
  check(nav.getBoundingClientRect().top === document.querySelector('.next-app')!.getBoundingClientRect().top,
    'navigation must not have stacked global headers');
  check(nav.querySelector('header')!.getBoundingClientRect().height <= 57, 'list header must remain compact');
  for (const row of Array.from(nav.querySelectorAll<HTMLElement>('.next-session-row'))) {
    check(row.getBoundingClientRect().height <= 92, 'long directory and role names must not inflate rows');
  }

  const id = 'fixture-next-workspace-0';
  lab.draft(id, 'Retained synthetic workspace draft');
  nav.querySelector<HTMLAnchorElement>('a')!.click();
  const opener = await until(() => document.querySelector<HTMLButtonElement>('.next-conversation-identity'), 'chat header');
  const messages = document.querySelector<HTMLElement>('.next-messages');
  check(messages, 'conversation mounted');
  const phone = matchMedia('(max-width: 599px)').matches;
  const docked = matchMedia('(min-width: 1200px)').matches;
  const sidebar = matchMedia('(min-width: 925px)').matches;
  check(nav.inert === !sidebar, 'hidden mobile list must be inert');
  check(document.querySelector('.next-conversation-header')!.getBoundingClientRect().height <= 57,
    'conversation header height must not grow with title length');
  opener.focus();
  opener.click();
  const panel = await until(() => document.querySelector<HTMLDialogElement>('.next-inspector[open]'), 'inspector');
  check(panel.matches(':modal') === !docked, 'only non-docked settings are modal');
  check(phone ? !document.querySelector('.next-messages') : document.querySelector('.next-messages') === messages,
    'phone releases hidden transcript; larger screens preserve mounted chat');
  const model = await until(() => {
    const select = panel.querySelector<HTMLButtonElement>('[aria-label="模型"]');
    return select && !select.disabled ? select : null;
  }, 'model selector');
  model.focus();
  model.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const listbox = await until(() => panel.querySelector<HTMLElement>('[role="listbox"]'), 'select inside top layer');
  const option = listbox.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ?? listbox.querySelector<HTMLElement>('[role="option"]');
  check(option, 'native model options');
  option.click();
  await until(() => !panel.querySelector('[role="listbox"]'), 'select close');
  check(panel.open, 'select interaction must not dismiss inspector');
  panel.querySelector<HTMLButtonElement>('[aria-label="关闭会话设置"]')!.click();
  await until(() => !document.querySelector('.next-inspector'), 'inspector close');
  await until(() => document.activeElement === opener, 'inspector close restores title trigger');
  const editor = await until(() => document.querySelector<HTMLTextAreaElement>('.next-textarea'), 'restored input');
  check(editor.value === 'Retained synthetic workspace draft', 'settings must retain draft');
  check(document.documentElement.scrollWidth <= innerWidth, 'no page-wide overflow');
  return { viewport: [innerWidth, innerHeight], phone, docked, sidebar,
    header: document.querySelector('.next-conversation-header')!.getBoundingClientRect().height,
    inputHeight: document.querySelector('.next-input-area')!.getBoundingClientRect().height,
    results: ['compact list and headers', 'responsive inspector and transcript ownership',
      'portaled model options stay inside modal', 'title focus and draft restored', 'no horizontal overflow'] };
}

// Capture before resizing with the browser driver; invoke the returned check at
// each width. A breakpoint must not discard an unapplied settings selection.
export async function prepareNextWorkspaceResizeCheck(lab: NextLabControls = window.nextLab) {
  check(import.meta.env.DEV && import.meta.env.COCKPIT_CHAT_LAB === true && lab, 'isolated App lab required');
  lab.navigate('/session/fixture-next-workspace-0/info');
  const trigger = await until(() => {
    const element = document.querySelector<HTMLButtonElement>('.next-inspector [aria-label="思考力度"]');
    return element && !element.disabled ? element : null;
  }, 'effort select');
  trigger.focus();
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const option = await until(() => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
    .find(element => element.textContent === '低'), 'low effort option');
  option.click();
  await until(() => trigger.textContent === '低' && !document.querySelector('[role="listbox"]'), 'local effort selection');
  const form = document.querySelector('.next-settings');
  return () => {
    check(form === document.querySelector('.next-settings'), 'resize remounted settings form');
    check(trigger.isConnected && trigger.textContent === '低', 'resize discarded unapplied model selection');
    check(document.querySelector('.next-inspector')?.matches(':modal') === !matchMedia('(min-width: 1200px)').matches,
      'inspector modality must follow width');
    check(!!document.querySelector('.next-messages') === !matchMedia('(max-width: 599px)').matches,
      'only phone settings release the hidden transcript');
    check(document.documentElement.scrollWidth <= innerWidth, 'resize caused horizontal overflow');
    return { viewport: [innerWidth, innerHeight], retainedSelection: trigger.textContent };
  };
}
