import { expect, test, type Page, type TestInfo } from '@playwright/test';

// Chat Lab browser smoke: every page loads the production components on
// synthetic fixtures only. Screenshots are saved as the CI visual baseline
// (artifact `chat-lab-screenshots`); they are reviewed, not pixel-compared.

type Guard = { problems: string[] };

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
