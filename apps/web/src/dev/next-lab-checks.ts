import type { NextLabControls } from './next-lab';

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Next UI regression: ${message}`);
}
async function until<T>(read: () => T, message: string): Promise<NonNullable<T>> {
  const deadline = performance.now() + 4000;
  while (performance.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise(requestAnimationFrame);
  }
  throw new Error(`Next UI regression timed out: ${message}`);
}
const frames = async () => {
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
};
const editor = () => document.querySelector<HTMLTextAreaElement>('.next-textarea');
const visibleButton = (text: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(button =>
    button.textContent === text && button.getClientRects().length > 0);

// Run explicitly in the isolated App lab, at both desktop and touch widths.
// This exercises real Radix/React DOM lifecycles rather than a replica renderer.
export async function runNextLabChecks(lab: NextLabControls = window.nextLab) {
  check(import.meta.env.DEV && import.meta.env.COCKPIT_CHAT_LAB === true && lab, 'isolated lab required');
  check(!new URLSearchParams(location.search).has('view'), 'use the App scene, not the component-only scene');
  const results: string[] = [];
  lab.operations.hold(false);
  lab.operations.outcome('success');
  lab.connected(true);
  try {
    const id = lab.choose('ask');
    const choice = await until(() => document.querySelector<HTMLButtonElement>('[aria-label="需要你的选择"] button'), 'ask choice');
    lab.operations.hold(true);
    choice.focus();
    choice.click();
    await until(() => choice.getAttribute('aria-busy') === 'true', 'decision pending');
    check(document.activeElement === choice && !choice.disabled, 'pending decision must retain focus');
    choice.click();
    check(lab.operations.pending().length === 1, 'pending choice cannot dispatch twice');
    lab.operations.release('success');
    await until(() => !document.querySelector('[aria-label="需要你的选择"]'), 'decision resolution');
    check(document.activeElement === editor(), 'removed choice must restore editor focus');
    results.push('decision pending, duplicate guard and removal focus');

    lab.replaceRequest(id);
    const oldChoice = await until(() => document.querySelector<HTMLButtonElement>('[aria-label="需要你的选择"] button'), 'replacement choice');
    const oldEditor = await until(editor, 'replacement editor');
    oldChoice.click();
    await until(() => lab.operations.pending().length, 'old request dispatched');
    lab.replaceRequest(id);
    const nextEditor = await until(() => editor() !== oldEditor ? editor() : null, 'distinct request editor identity');
    lab.draft(id, 'Synthetic replacement answer');
    const requestId = lab.session(id).ask?.requestId;
    lab.operations.release('success');
    await frames();
    check(lab.session(id).ask?.requestId === requestId, 'late result cannot resolve replacement request');
    check(nextEditor.value === 'Synthetic replacement answer', 'late result cannot clear replacement text');
    results.push('request identity and late-result isolation');

    lab.operations.hold(false);
    lab.navigate('/');
    const opener = await until(() => visibleButton('新建会话'), 'new-session opener');
    opener.focus();
    opener.click();
    const dialog = await until(() => document.querySelector('[role="dialog"]'), 'new-session dialog');
    await until(() => document.activeElement?.textContent === '新建会话', 'dialog heading focus');
    const cancel = await until(() => visibleButton('取消', dialog), 'dialog cancel');
    cancel.click();
    await until(() => !document.querySelector('[role="dialog"]') && document.activeElement === opener, 'dialog opener focus restoration');
    results.push('dialog entry and return focus');

    opener.click();
    const creation = await until(() => document.querySelector('[role="dialog"]'), 'creation form');
    const create = await until(() => {
      const button = visibleButton('创建会话', creation);
      return button && !button.disabled ? button : null;
    }, 'canonical directory and role readiness');
    lab.operations.hold(true);
    lab.createUncertain(true);
    create.focus();
    create.click();
    await until(() => lab.operations.pending().some(item => item.label === 'create'), 'creation dispatch');
    check(document.activeElement === create && !create.disabled, 'pending creation keeps focus');
    create.click();
    check(lab.operations.pending().length === 1, 'creation cannot dispatch twice');
    lab.operations.release('success');
    const recover = await until(() => Array.from(creation.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.startsWith('打开已确认创建的会话')), 'known-created-ID recovery');
    check(create.getAttribute('aria-disabled') === 'true', 'partial creation cannot be retried blindly');
    lab.operations.hold(false);
    lab.createUncertain(false);
    recover.click();
    await until(() => document.querySelector('.next-conversation-title')?.textContent === 'Synthetic newly created session', 'created session navigation');
    const actions = await until(() => document.querySelector<HTMLButtonElement>('.next-conversation-header button[aria-haspopup="menu"]'), 'session menu trigger');
    const openDelete = async () => {
      actions.focus();
      actions.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const item = await until(() => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .find(element => element.textContent === '永久删除会话'
          && element.closest('[role="menu"]')?.getAttribute('data-state') === 'open'), 'delete menu item');
      item.focus();
      await frames();
      item.click();
      return until(() => document.querySelector('[role="alertdialog"]'), 'destructive confirmation');
    };
    const confirmation = await openDelete();
    visibleButton('取消', confirmation)?.click();
    await until(() => !document.querySelector('[role="alertdialog"]') && document.activeElement === actions, 'menu opener focus restoration');
    const deletion = await openDelete();
    const confirm = await until(() => visibleButton('永久删除', deletion), 'permanent delete action');
    lab.operations.hold(true);
    confirm.focus();
    confirm.click();
    await until(() => lab.operations.pending().some(item => item.label === 'delete'), 'delete dispatch');
    check(document.activeElement === confirm && !confirm.disabled, 'pending deletion keeps focus');
    lab.operations.release('success');
    await until(() => !document.querySelector('[role="alertdialog"]') && !document.querySelector('.next-conversation-header'), 'delete destination');
    lab.operations.hold(false);
    results.push('creation uncertainty recovery, keyboard menu, destructive confirmation and focus');

    const historyId = lab.choose('initial-history');
    await until(() => document.querySelector('.next-conversation-title')?.textContent?.includes('initial-history'), 'history view');
    const prior = lab.firstContent.length;
    lab.deliverHistory(true);
    const first = await until(() => lab.firstContent.slice(prior).find(item => item.sessionId === historyId), 'first visible history commit');
    check(first.bottomGap <= 1, `first content must enter at latest, gap=${first.bottomGap}`);
    const viewport = await until(() => document.querySelector<HTMLElement>('.next-messages'), 'transcript viewport');
    viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
    // The latest control appears one viewport away, not at an arbitrary midpoint.
    viewport.scrollTop = Math.max(0, viewport.scrollHeight - 2 * viewport.clientHeight - 50);
    viewport.dispatchEvent(new Event('scroll'));
    await until(() => document.querySelector('.next-latest'), 'reading mode');
    const before = viewport.scrollTop;
    lab.append(historyId, 'Synthetic appended text while reading.');
    await frames();
    check(Math.abs(viewport.scrollTop - before) <= 1, 'remote append must not displace the reader');
    check(document.documentElement.scrollWidth <= innerWidth, 'long content must not widen the page');
    results.push('late-frame first content, reader retention and narrow overflow');

    lab.mcpPending();
    lab.navigate(`/session/${historyId}/mcp`);
    await until(() => document.body.textContent?.includes('连接：pending'), 'native pending MCP row');
    const refresh = await until(() => visibleButton('刷新'), 'MCP passive refresh');
    check(!refresh.disabled, 'cached native pending must not prevent passive refresh');
    check(Array.from(document.querySelectorAll<HTMLButtonElement>('[role="switch"]')).every(control => control.disabled),
      'native pending must still serialize MCP mutations');
    lab.operations.outcome('fail');
    refresh.click();
    await until(() => document.body.textContent?.includes('Synthetic mcp.list failure'), 'failed MCP readback');
    check(!refresh.disabled, 'retained pending row must not remove refresh recovery after failure');
    lab.operations.outcome('success');
    lab.mcpPending(false);
    refresh.click();
    await until(() => document.body.textContent?.includes('连接：connected')
      && !document.body.textContent.includes('Synthetic mcp.list failure'), 'MCP refresh recovery');
    results.push('MCP pending-cache passive refresh and failed-read recovery');

    const runningId = lab.choose('streaming');
    lab.draft(runningId, 'Retain the draft when execution ends.');
    const collapse = await until(() => document.querySelector<HTMLButtonElement>('.chat-execution-head'), 'execution collapse control');
    const input = document.querySelector<HTMLTextAreaElement>('.next-textarea')!;
    collapse.focus();
    collapse.click();
    await until(() => document.querySelector('.next-input-content')?.hasAttribute('hidden'), 'collapsed execution input');
    const stop = await until(() => visibleButton('停止并清空队列'), 'stop outside collapsed input');
    stop.focus();
    stop.click();
    await until(() => !document.querySelector('.next-input-header') && document.activeElement === input, 'idle input and removed stop focus');
    check(!document.querySelector('.next-input-content')?.hasAttribute('hidden'), 'idle input must reopen without its collapse control');
    check(input === document.querySelector('.next-textarea') && input.value === 'Retain the draft when execution ends.',
      'execution-to-idle preserves the editor and draft');
    lab.operations.hold(true);
    const send = await until(() => document.querySelector<HTMLButtonElement>('.next-editor [aria-label="发送"]'), 'idle send');
    send.focus();
    send.click();
    await until(() => document.querySelector('.next-input-header')?.textContent?.includes('正在提交'), 'pending input status');
    check(!input.disabled, 'pending submission leaves the draft editable');
    input.focus();
    lab.draft(runningId, 'Edited while the native send is pending.');
    lab.operations.release('fail');
    await until(() => !document.querySelector('.next-input-header'), 'pending status removal');
    check(document.activeElement === input
      && document.querySelector<HTMLTextAreaElement>('.next-textarea')?.value === 'Edited while the native send is pending.',
      'failed submission retains ongoing editing and its draft');
    results.push('collapsed execution to idle, retained input/draft, removed-control focus and pending status');
    return results;
  } finally {
    lab.mcpPending(false);
    lab.operations.outcome('success');
    lab.operations.release('success');
    lab.operations.hold(false);
  }
}
