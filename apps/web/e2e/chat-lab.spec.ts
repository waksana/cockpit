import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { SessionMeta } from '@cockpit/protocol';
import { askMarkdownChoices } from '../src/dev/ask-markdown-fixture';

// Chat Lab browser smoke: every page loads the production components on
// synthetic fixtures only. Screenshots are saved as the CI visual baseline
// (artifact `chat-lab-screenshots`); they are reviewed, not pixel-compared.

type Guard = { problems: string[] };
type SyntheticState = { activeId: string | null; sessions: SessionMeta[]; sendDraft: () => Promise<boolean> };
type SyntheticStoreModule = {
  useCockpit: { setState(update: Partial<SyntheticState> | ((state: SyntheticState) => Partial<SyntheticState>)): void };
};

async function open(page: Page, query: string): Promise<Guard> {
  const guard: Guard = { problems: [] };
  const labOrigin = test.info().project.use.baseURL!;
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(labOrigin) || url.startsWith('data:') || url.startsWith('blob:')) return route.fallback();
    guard.problems.push(`external request blocked: ${url}`);
    return route.abort('blockedbyclient');
  });
  page.on('pageerror', error => guard.problems.push(`page error: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') guard.problems.push(`console error: ${message.text()}`);
  });
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/intent/') || ['/events', '/chat/stream', '/status', '/version'].includes(path)) {
      guard.problems.push(`backend request attempted: ${path}`);
    }
  });
  await page.goto(`/chat-lab.html?${query}`);
  await expect(page.locator('#root > *').first()).toBeVisible();
  return guard;
}

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
}

async function expectHealthy(page: Page, guard: Guard) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no horizontal page overflow').toBeLessThanOrEqual(1);
  expect(guard.problems).toEqual([]);
}

async function snapshot(page: Page, testInfo: TestInfo, name: string) {
  await settle(page);
  await page.screenshot({
    path: `chat-lab-screenshots/${testInfo.project.name}/${name}.png`,
    animations: 'disabled', caret: 'hide',
  });
}

const componentScenes: [scene: string, ready: string][] = [
  ['all', '.chat-input-card'],
  ['reading', '[data-message-frame]'],
  ['streaming', '.chat-input-card'],
  ['process-summary', '[data-message-frame]'],
  ['ordered-events', '[data-message-frame]'],
  ['input-states', '.chat-input-card'],
  ['ask', '.chat-decision-card[data-state="pending"]'],
  ['decision-stack', '.chat-decision-tabs'],
  ['decision-history', '.chat-decision-card[data-state="done"]'],
];

for (const [scene, ready] of componentScenes) {
  test(`component scene ${scene} renders on synthetic input`, async ({ page }, testInfo) => {
    const guard = await open(page, `scene=${scene}`);
    await expect(page.locator(ready).first()).toBeVisible();
    await snapshot(page, testInfo, `scene-${scene}`);
    await expectHealthy(page, guard);
  });
}

const appPages: [name: string, query: string, ready: string][] = [
  ['workspace', 'scene=workspace', '.pane-title'],
  ['sidebar', 'scene=sidebar', '.chatlist-chat'],
  ['resources-settings', 'scene=resources', '.pane-title'],
  ['resources-mcp', 'scene=resources&page=mcp', '[role="switch"]'],
  ['resources-skills', 'scene=resources&page=skills', '[role="switch"]'],
  ['full-web', 'scene=full-web', '.chat-input-card'],
];

test('global default-model menu saves a future-session choice and restores keyboard focus', async ({ page }, testInfo) => {
  const guard = await open(page, 'scene=sidebar');
  const trigger = page.getByRole('button', { name: '全局导航' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: '默认新会话模型' }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '默认新会话模型' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/仅影响之后新建的会话/)).toBeVisible();
  await expect(dialog.getByRole('combobox')).toHaveValue('gpt-6-astra');
  await dialog.getByRole('combobox').selectOption('gpt-5.4-mini');
  await snapshot(page, testInfo, 'default-new-session-model');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole('menuitem', { name: '默认新会话模型' }).click();
  await expect(dialog.getByRole('combobox')).toHaveValue('gpt-5.4-mini');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expectHealthy(page, guard);
});

for (const [name, query, ready] of appPages) {
  test(`app page ${name} renders the complete App on a synthetic store`, async ({ page }, testInfo) => {
    const guard = await open(page, query);
    await expect(page.locator(ready).first()).toBeVisible();
    // Lazy panels must finish loading before the baseline is taken.
    await expect(page.getByText('加载中…', { exact: true })).toHaveCount(0);
    await snapshot(page, testInfo, `app-${name}`);
    await expectHealthy(page, guard);
  });
}

for (const section of ['mcp', 'skills'] as const) {
  test(`global module ${section} rows share native list styling without substitute controls`, async ({ page }, testInfo) => {
    const guard = await open(page, `scene=resources&page=${section}`);
    const native = page.getByRole('region', { name: '全局配置', exact: true });
    const modules = page.getByRole('region', { name: '模块提供', exact: true });
    await expect(modules.locator('.manage-row').first()).toBeVisible();
    await settle(page);
    const profiles = await page.locator('.manage-list .manage-row').evaluateAll(rows => rows.map(row => {
      const identity = row.querySelector<HTMLElement>('.manage-resource-identity')!;
      const name = row.querySelector<HTMLElement>('.manage-row-name')!;
      const style = getComputedStyle(row);
      const text = getComputedStyle(identity);
      return {
        rowPadding: style.padding, gap: style.gap, border: style.border, radius: style.borderRadius,
        background: style.backgroundColor, align: style.alignItems,
        identityPadding: text.padding, minHeight: text.minHeight, font: text.font, color: text.color,
        nameFont: getComputedStyle(name).font,
        inset: identity.getBoundingClientRect().left - row.getBoundingClientRect().left,
      };
    }));
    expect(profiles.length).toBeGreaterThan(1);
    for (const profile of profiles) expect(profile).toEqual(profiles[0]);
    await expect(native.getByRole('switch').first()).toBeVisible();
    await expect(modules.getByRole('switch')).toHaveCount(0);
    await expect(modules.locator('.manage-resource-controls')).toHaveCount(0);
    await expect(modules).not.toContainText(/随角色启用|只读|不能全局关闭|由模块管理/);
    await expect(modules.locator('a button')).toHaveCount(0);
    await snapshot(page, testInfo, `global-module-${section}-rows`);
    if (section === 'skills') {
      await modules.getByRole('link').first().click();
      await expect(page.locator('.manage-detail-body')).toBeVisible();
    }
    await expectHealthy(page, guard);
  });
}

test('dark theme keeps the workspace and transcript readable', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one dark baseline is enough');
  await page.emulateMedia({ colorScheme: 'dark' });
  for (const [name, query] of [['dark-workspace', 'scene=workspace'], ['dark-scene-all', 'scene=all']]) {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    page.removeAllListeners('pageerror').removeAllListeners('console').removeAllListeners('request');
    const guard = await open(page, query);
    await expect(page.locator('.chat-input-card').first()).toBeVisible();
    await snapshot(page, testInfo, name);
    await expectHealthy(page, guard);
  }
});

test('sidebar geometry checks pass at this width', async ({ page }) => {
  const guard = await open(page, 'scene=sidebar');
  await expect(page.locator('.chatlist-chat').first()).toBeVisible();
  await settle(page);
  await page.evaluate(async path => {
    const checks = await import(path) as { runSidebarChecks(): unknown };
    checks.runSidebarChecks();
  }, '/src/dev/sidebar-checks.ts');
  await expectHealthy(page, guard);
});

test('composer accepts real typing without sending anything', async ({ page }) => {
  const guard = await open(page, 'scene=all');
  const editor = page.locator('.chat-input-card').getByRole('textbox');
  await editor.click();
  await page.keyboard.type('合成输入 smoke');
  await expect(editor).toHaveValue(/合成输入 smoke/);
  await expectHealthy(page, guard);
});

test('ask_user Markdown keeps links and code actions independent from exact-value selection', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const copied: string[] = [];
    Object.assign(window, { askMarkdownCopies: copied });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { copied.push(text); },
    } });
  });
  const guard = await open(page, 'scene=ask-markdown&compact=1');
  const card = page.locator('.chat-decision-card[data-state="pending"]');
  const question = card.locator('.chat-ask-q');
  await expect(question.getByRole('heading', { name: '选择实现方案' })).toBeVisible();
  await expect(question.locator('strong')).toHaveText('原始选项');
  await expect(question.locator('ul')).toBeVisible();
  await expect(question.locator('ol')).toBeVisible();
  await expect(question.locator('pre code')).toBeVisible();
  const table = question.getByRole('region', { name: '表格（可横向滚动）' });
  await expect(table).toBeVisible();
  await table.scrollIntoViewIfNeeded();
  await table.focus();
  await page.keyboard.press('ArrowRight');
  const tableSize = await table.locator('table').evaluate(element => ({
    width: element.clientWidth, scrollWidth: element.scrollWidth, scrollLeft: element.scrollLeft,
  }));
  if (tableSize.scrollWidth > tableSize.width) expect(tableSize.scrollLeft).toBeGreaterThan(0);
  else expect(tableSize.scrollLeft).toBe(0);
  const codeSize = await question.locator('pre').evaluate(element => ({
    width: element.clientWidth, scrollWidth: element.scrollWidth,
  }));
  expect(codeSize.scrollWidth).toBeGreaterThan(codeSize.width);
  await question.getByRole('heading').scrollIntoViewIfNeeded();
  await snapshot(page, testInfo, 'ask-markdown-question');
  const option = card.locator('.chat-ask-option').nth(1);
  await expect(option.locator('strong').first()).toHaveText('查看细节');
  await option.getByRole('button', { name: '复制代码', exact: true }).click();
  expect(await page.evaluate(() => (window as typeof window & { askMarkdownCopies: string[] }).askMarkdownCopies))
    .toEqual(['pnpm --filter @cockpit/web test\n']);
  await expect(card).toBeVisible();

  await page.context().route('**/synthetic/ask-guide', route => route.fulfill({ status: 200, contentType: 'text/plain', body: 'Synthetic guide' }));
  const opened = page.waitForEvent('popup');
  await option.getByRole('link', { name: '参考说明' }).click();
  const guide = await opened;
  await expect(guide.locator('body')).toHaveText('Synthetic guide');
  await guide.close();
  await expect(option.getByRole('link', { name: '参考说明' })).toBeFocused();
  await expect(card).toBeVisible();
  await expect(card.locator('button a, button button, button input, button [tabindex], p div')).toHaveCount(0);
  await snapshot(page, testInfo, 'ask-markdown-choice');
  const select = option.getByRole('button', { name: /^选择 查看细节/ });
  await select.focus();
  await page.keyboard.press('Enter');
  await expect(card).toHaveCount(0);
  const answered = page.getByRole('group', { name: '已回答的问题', exact: true });
  await expect(answered.getByRole('heading', { name: '选择实现方案' })).toBeVisible();
  await expect(answered.locator('.chat-decision-answer strong').first()).toHaveText('查看细节');
  await expect(page.locator('.lab-receipt')).toContainText(askMarkdownChoices[1]);
  await expect(page.locator('.lab-receipt')).toContainText('freeform=false');
  await expectHealthy(page, guard);
});

test('restored ask_user Markdown history remains formatted after reload', async ({ page }, testInfo) => {
  const guard = await open(page, 'scene=ask-markdown-history&compact=1');
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    const card = page.getByRole('group', { name: '已回答的问题', exact: true });
    await expect(card.getByRole('heading', { name: '选择实现方案' })).toBeVisible();
    await expect(card.locator('.chat-ask-q strong')).toHaveText('原始选项');
    await expect(card.locator('.chat-decision-answer strong').first()).toHaveText('查看细节');
    await expect(card.locator('button.chat-ask-choice')).toHaveCount(0);
    await expect(card.locator('.chat-ask-q pre code')).toBeVisible();
    await card.getByRole('heading').scrollIntoViewIfNeeded();
    await expectHealthy(page, guard);
  }
  await snapshot(page, testInfo, 'ask-markdown-history');
});

test('ask_user multiline submission restores empty shared-composer geometry', async ({ page }, testInfo) => {
  const guard = await open(page, 'scene=full-web&case=ask');
  const editor = page.getByRole('textbox', { name: '消息输入', exact: true });
  await expect(editor).toBeVisible();
  await settle(page);
  const measure = () => editor.evaluate(element => {
    const { width, height } = element.getBoundingClientRect();
    return { width, height, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
  });
  const empty = await measure();
  await editor.fill('多行自由回复。\n第二行中文内容。\n' + 'LongUnbrokenAnswer'.repeat(30));
  await settle(page);
  const expanded = await measure();
  expect(expanded.height).toBeGreaterThan(empty.height);
  expect(expanded.width).toBeCloseTo(empty.width, 0);
  expect(expanded.scrollWidth - expanded.clientWidth).toBeLessThanOrEqual(1);
  await snapshot(page, testInfo, 'ask-multiline-before-send');
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  await expect(editor).toHaveValue('');
  await snapshot(page, testInfo, 'ask-multiline-after-send');
  const cleared = await measure();
  testInfo.annotations.push({ type: 'geometry', description: JSON.stringify({ empty, expanded, cleared }) });
  expect(cleared.width).toBeCloseTo(empty.width, 0);
  expect(cleared.height).toBeLessThanOrEqual(empty.height + 1);
  await expectHealthy(page, guard);
});

test('ask_user drafts retain text on rejection and size themselves independently when switching questions', async ({ page }) => {
  const guard = await open(page, 'scene=full-web&case=ask');
  const editor = page.getByRole('textbox', { name: '消息输入', exact: true });
  await expect(editor).toBeVisible();
  await settle(page);
  const emptyHeight = await editor.evaluate(element => element.getBoundingClientRect().height);
  const text = '未接受的多行回答。\n第二行应保留。\n' + '中文换行'.repeat(100);
  await page.evaluate(async path => {
    const { useCockpit } = await import(path) as SyntheticStoreModule;
    useCockpit.setState({ sendDraft: async () => false });
  }, '/src/net/store.ts');
  await editor.fill(text);
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  await expect(editor).toHaveValue(text);
  await expect(page.getByRole('button', { name: '提交回答', exact: true })).toBeEnabled();
  expect(await editor.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(emptyHeight);

  await page.evaluate(async path => {
    const { useCockpit } = await import(path) as SyntheticStoreModule;
    useCockpit.setState(state => ({ sessions: state.sessions.map(session => {
      if (session.sessionId !== state.activeId || !session.ask) return session;
      return { ...session, decisions: [
        { kind: 'ask', request: session.ask },
        { kind: 'ask', request: { requestId: 'second-question', question: '第二个合成问题', allowFreeform: true } },
      ] };
    }) }));
  }, '/src/net/store.ts');
  await page.getByRole('tab', { name: '问题 2', exact: true }).click();
  await expect(editor).toHaveValue('');
  expect(await editor.evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(emptyHeight + 1);
  await page.getByRole('tab', { name: '问题 1', exact: true }).click();
  await expect(editor).toHaveValue(text);
  expect(await editor.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(emptyHeight);
  await editor.fill('');
  expect(await editor.evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(emptyHeight + 1);

  await editor.fill(text);
  await page.evaluate(async path => {
    const { useCockpit } = await import(path) as SyntheticStoreModule;
    useCockpit.setState(state => ({ sessions: state.sessions.map(session => session.sessionId !== state.activeId ? session
      : { ...session, decisions: [{ kind: 'ask', request: {
        requestId: 'replacement-question', question: '新的合成问题', allowFreeform: true,
      } }] }) }));
  }, '/src/net/store.ts');
  await expect(editor).toHaveValue('');
  expect(await editor.evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(emptyHeight + 1);
  await expectHealthy(page, guard);
});

test('region failures stay in place and recover after repair', async ({ page }, testInfo) => {
  const guard = await open(page, 'scene=workspace&failures=1');
  const failures = page.locator('[data-region-error]');
  // Narrow layouts show the settings dialog over the transcript and sidebar.
  await expect(page.locator('[data-region-error]:visible').first()).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: '显示会话设置失败' })).toBeVisible();
  await snapshot(page, testInfo, 'app-workspace-failures');
  await page.evaluate(() => (window as unknown as { renderFailureLab: { repair(): void } }).renderFailureLab.repair());
  await expect(failures).toHaveCount(0);
  // Region boundaries intentionally log each caught render failure.
  guard.problems = guard.problems.filter(problem => !problem.startsWith('console error: '));
  await expectHealthy(page, guard);
});

test('dialog focus follows pointer and keyboard modality and returns to its trigger', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'pointer/keyboard modality is checked on desktop input');
  const guard = await open(page, 'scene=dialog-focus');
  const trigger = page.locator('[data-focus-trigger="confirm"]');
  await trigger.click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toBeVisible();
  await snapshot(page, testInfo, 'dialog-confirm');
  const check = (mode: 'pointer' | 'keyboard') => page.evaluate(async ([path, value]) => {
    const checks = await import(path) as { checkDialogFocus(value: string): unknown };
    checks.checkDialogFocus(value);
  }, ['/src/dev/dialog-focus-checks.ts', mode] as const);
  await check('pointer');
  await page.keyboard.press('Tab');
  await check('keyboard');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expectHealthy(page, guard);
});
