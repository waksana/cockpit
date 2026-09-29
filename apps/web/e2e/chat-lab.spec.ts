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

test('global settings combine preferences and About while preserving saves and keyboard focus', async ({ page }, testInfo) => {
  const guard = await open(page, 'scene=sidebar');
  const trigger = page.getByRole('button', { name: '全局导航' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: '设置', exact: true }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '设置', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: '关闭设置' })).toBeFocused();
  await expect(dialog.getByText(/仅影响之后新建的会话/)).toBeVisible();
  await expect(dialog.getByRole('combobox')).toHaveValue('gpt-6-astra');
  await expect(dialog.getByRole('heading', { name: '关于 Cockpit' })).toBeVisible();
  await expect(dialog.getByText('dev+fixture')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(dialog.getByRole('heading')).toHaveText(['设置', '默认模型', '示例模块设置', '关于 Cockpit', '已加载模块']);
  await expect(dialog.getByText('synthetic-backend', { exact: true })).toBeVisible();
  const selectBox = await dialog.getByRole('combobox').boundingBox();
  const saveBox = await dialog.getByRole('button', { name: '保存', exact: true }).boundingBox();
  expect(Math.abs(selectBox!.y + selectBox!.height - saveBox!.y - saveBox!.height)).toBeLessThanOrEqual(1);
  const preference = dialog.getByRole('switch', { name: '示例开关' });
  await expect(preference).toHaveAttribute('aria-checked', 'false');
  await preference.click();
  await expect(preference).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('combobox').selectOption('gpt-5.4-mini');
  await snapshot(page, testInfo, 'global-settings');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.getByText('已保存默认模型。')).toBeVisible();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '关闭设置' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await expect(dialog.getByRole('combobox')).toHaveValue('gpt-5.4-mini');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expectHealthy(page, guard);
});

test('inline module cards fit user bubbles without asymmetric surplus padding', async ({ page }, testInfo) => {
  const guard = await open(page, 'scene=card-messages');
  await expect(page.locator('.lab-inline-card')).toHaveCount(4);
  await settle(page);
  const geometry = await page.locator('.user-message').evaluateAll(messages => messages.map(message => {
    const bubble = message.querySelector('.message')!;
    const rect = bubble.getBoundingClientRect();
    const card = message.querySelector('.lab-inline-card')?.getBoundingClientRect();
    return {
      surplus: card ? Math.abs((card.left - rect.left) - (rect.right - card.right)) : 0,
      overflow: bubble.scrollWidth - bubble.clientWidth,
    };
  }));
  expect(geometry[0].surplus).toBeLessThanOrEqual(1);
  expect(geometry[2].surplus).toBeLessThanOrEqual(1);
  expect(geometry.every(row => row.overflow <= 1)).toBe(true);
  await page.getByText('Before', { exact: false }).scrollIntoViewIfNeeded();
  await expect(page.getByText('Before', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Card action' }).last().scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Card action' }).last()).toBeInViewport({ ratio: 1 });
  await page.getByRole('button', { name: '复制代码' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: '复制代码' })).toBeVisible();
  await snapshot(page, testInfo, 'card-messages');
  await expectHealthy(page, guard);
});

test('global module dialog opens on empty home and keeps its lifetime through menus and navigation', async ({ page }, testInfo) => {
  const guard = await open(page, 'scene=module-global');
  const trigger = page.getByRole('button', { name: '全局导航' });
  const item = page.getByRole('menuitem', { name: 'Global module example', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Global module example' });
  const input = dialog.getByRole('textbox', { name: 'Module note' });
  const close = dialog.getByRole('button', { name: 'Close example' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await item.focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(input).toBeFocused();
  await input.fill('Retained across routes');
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(input).toBeFocused();
  await expect(dialog).toHaveJSProperty('open', true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.press('Space');
  await item.focus();
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('Retained across routes');
  await expect(input).toBeFocused();
  await snapshot(page, testInfo, 'module-global-dialog');
  if (testInfo.project.use.isMobile) await close.tap();
  else await close.click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.evaluate(async () => {
    const fixture = (window as unknown as { globalModuleLab: { restoreSessions(): void } }).globalModuleLab;
    fixture.restoreSessions();
  });
  await page.getByText('聊天界面与交互细节', { exact: true }).click();
  if (testInfo.project.use.isMobile) await page.getByRole('button', { name: '返回' }).click();
  await page.getByText('API 参数与错误反馈', { exact: true }).click();
  if (testInfo.project.use.isMobile) await page.getByRole('button', { name: '返回' }).click();
  await trigger.click();
  await page.getByRole('menuitem', { name: '全局 Skills', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '全局 Skills' })).toBeVisible();
  await expect(page.locator('dialog.example-global-dialog')).toHaveCount(1);
  await page.getByRole('button', { name: '返回会话列表' }).click();
  if (testInfo.project.use.isMobile) await trigger.tap();
  else await trigger.click();
  if (testInfo.project.use.isMobile) await item.tap();
  else await item.click();
  await expect(input).toHaveValue('Retained across routes');
  await expect(input).toBeFocused();
  await page.evaluate(() => (window as unknown as { globalModuleLab: { stop(): void } }).globalModuleLab.stop());
  await expect(page.locator('dialog.example-global-dialog')).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { globalModuleLab: { restart(): Promise<void> } }).globalModuleLab.restart());
  await trigger.click();
  await item.click();
  await expect(input).toHaveValue('');
  await close.click();
  await expectHealthy(page, guard);
});

test('global settings preserve one scroll area and a reachable close control with long content', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: testInfo.project.name === 'narrow' ? 390 : 1024, height: 480 });
  const guard = await open(page, 'scene=sidebar');
  const trigger = page.getByRole('button', { name: '全局导航' });
  await trigger.click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await expect(dialog.getByText('dev+fixture')).toBeVisible();
  const savedModelId = `synthetic-${'m'.repeat(160)}`;
  await page.evaluate(async modelId => {
    const modulePath = '/src/net/api.ts';
    const { cockpitApi } = await import(/* @vite-ignore */ modulePath);
    cockpitApi.sessionDefaults = async () => ({
      modelId,
      models: [{ modelId: 'synthetic-long-model', name: 'SyntheticLongModelNameWithoutSpaces'.repeat(12) }],
      modelError: null,
    });
    cockpitApi.moduleInventory = async () => ({
      active: [{ id: 'long-module-identifier'.repeat(5), name: 'LongModuleNameWithoutSpaces'.repeat(10),
        version: '1.0.0-synthetic-long-version'.repeat(5) }, { id: 'unknown', version: null }],
      errors: [{ id: 'failed-module', stage: 'activation', error: 'Synthetic failure details '.repeat(10) }],
    });
  }, savedModelId);
  await dialog.getByRole('button', { name: '刷新关于信息' }).click();
  await expect(dialog.getByText('版本未知')).toBeVisible();
  await dialog.getByRole('button', { name: '刷新默认模型' }).click();
  await expect(dialog.getByRole('combobox')).toHaveValue(savedModelId);
  await dialog.getByRole('combobox').selectOption('synthetic-long-model');
  await expect(dialog.getByRole('combobox')).toHaveValue('synthetic-long-model');
  await expect(dialog.getByText(`当前默认值：${savedModelId}`)).toBeVisible();
  await dialog.getByRole('button', { name: '保存', exact: true }).scrollIntoViewIfNeeded();
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeInViewport({ ratio: 1 });
  const dimensions = await dialog.evaluate(element => {
    const header = element.querySelector('.settings-header')!;
    const body = element.querySelector('.settings-body')!;
    return {
      overflow: element.scrollWidth - element.clientWidth,
      contentOverflow: body.scrollWidth - body.clientWidth,
      scrollOwners: Array.from(element.querySelectorAll('*')).filter(node => {
        const style = getComputedStyle(node);
        return /auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
      }).length,
      headerTop: header.getBoundingClientRect().top,
      bodyScrollable: body.scrollHeight > body.clientHeight,
    };
  });
  expect(dimensions.overflow).toBeLessThanOrEqual(1);
  expect(dimensions.contentOverflow).toBeLessThanOrEqual(1);
  expect(dimensions.scrollOwners).toBe(1);
  expect(dimensions.bodyScrollable).toBe(true);
  await dialog.getByRole('button', { name: '刷新关于信息' }).focus();
  await expect(dialog.getByRole('button', { name: '刷新关于信息' })).toBeInViewport();
  expect(await dialog.locator('.settings-header').evaluate(node => node.getBoundingClientRect().top))
    .toBe(dimensions.headerTop);
  await expect(dialog.getByRole('button', { name: '关闭设置' })).toBeInViewport();
  await snapshot(page, testInfo, 'global-settings-short-dark');
  await page.keyboard.press('Tab');
  // Native dialog navigation may visit browser chrome before wrapping.
  const focus = await page.evaluate(() => ({
    chrome: document.activeElement === document.body,
    modal: document.querySelector('dialog')!.contains(document.activeElement),
  }));
  expect(focus.chrome || focus.modal, 'Tab cannot reach background controls').toBe(true);
  if (focus.chrome) await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: '关闭设置' })).toBeFocused();
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

test('ask_user keeps full question Markdown and whole-button noninteractive choice labels', async ({ page }, testInfo) => {
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
  const code = await question.locator('pre code').textContent();
  await question.getByRole('button', { name: '复制代码', exact: true }).click();
  expect(await page.evaluate(() => (window as typeof window & { askMarkdownCopies: string[] }).askMarkdownCopies))
    .toEqual([code]);
  await expect(card).toBeVisible();

  await page.context().route('**/synthetic/ask-guide', route => route.fulfill({ status: 200, contentType: 'text/plain', body: 'Synthetic guide' }));
  const opened = page.waitForEvent('popup');
  await question.getByRole('link', { name: '说明', exact: true }).click();
  const guide = await opened;
  await expect(guide.locator('body')).toHaveText('Synthetic guide');
  await guide.close();
  await expect(question.getByRole('link', { name: '说明', exact: true })).toBeFocused();
  await expect(card).toBeVisible();

  const choices = card.locator('.chat-ask-choices');
  const buttons = choices.getByRole('button');
  await expect(buttons).toHaveCount(askMarkdownChoices.length);
  await expect(choices.locator(':scope > button.chat-ask-choice')).toHaveCount(askMarkdownChoices.length);
  await expect(choices.getByRole('button', { name: '选择', exact: true })).toHaveCount(0);
  await expect(choices.locator('button a, button button, button input, button [tabindex], button [role], img, video, audio, iframe, pre, table')).toHaveCount(0);
  const profiles = await buttons.evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return { font: style.font, padding: style.padding, border: style.border, radius: style.borderRadius,
      align: style.textAlign, width: rect.width, parentWidth: element.parentElement!.getBoundingClientRect().width };
  }));
  for (const profile of profiles) {
    expect(profile, 'formatted choices use the same full-row button style as the ordinary label').toEqual(profiles[2]);
    expect(profile.width).toBeCloseTo(profile.parentWidth, 0);
  }
  const select = choices.getByRole('button', { name: /^查看细节/ });
  await expect(select).toContainText('参考说明');
  await expect(select).toContainText('[x]');
  await expect(select).toContainText('[ ]');
  await expect(select).toContainText('示意图');
  await choices.evaluate(element => element.scrollIntoView({ block: 'start' }));
  await snapshot(page, testInfo, 'ask-markdown-choice');
  await select.locator('strong').first().click();
  await expect(card).toHaveCount(0);
  const answered = page.getByRole('group', { name: '已回答的问题', exact: true });
  await expect(answered.getByRole('heading', { name: '选择实现方案' })).toBeVisible();
  await expect(answered.locator('.chat-decision-answer strong').first()).toHaveText('查看细节');
  await expect(page.locator('.lab-receipt')).toContainText(askMarkdownChoices[1]);
  await expect(page.locator('.lab-receipt')).toContainText('freeform=false');
  await expectHealthy(page, guard);
});

for (const activation of ['text', 'padding', 'Enter', 'Space'] as const) {
  test(`ask_user whole choice submits its original value through ${activation}`, async ({ page }) => {
    const guard = await open(page, 'scene=ask-markdown&compact=1');
    const card = page.locator('.chat-decision-card[data-state="pending"]');
    const select = card.getByRole('button', { name: /^保留现有实现/ });
    await expect(select).toBeVisible();
    await select.scrollIntoViewIfNeeded();
    if (activation === 'text') {
      await select.locator('em').click();
    } else if (activation === 'padding') {
      const hit = await select.evaluate(button => {
        const rect = button.getBoundingClientRect();
        const x = rect.width - 4;
        const y = 4;
        return { x, y, onButton: document.elementFromPoint(rect.left + x, rect.top + y) === button };
      });
      expect(hit.onButton, 'the blank padded area belongs to the option button itself').toBe(true);
      await select.click({ position: { x: hit.x, y: hit.y } });
    } else {
      await card.getByRole('button', { name: /^查看细节/ }).focus();
      await page.keyboard.press('Shift+Tab');
      await expect(select).toBeFocused();
      await page.keyboard.press(activation);
    }
    await expect(card).toHaveCount(0);
    await expect(page.locator('.lab-receipt')).toContainText(askMarkdownChoices[0]);
    await expect(page.locator('.lab-receipt')).toContainText('freeform=false');
    await expect(page.getByRole('group', { name: '已回答的问题' }).locator('.chat-decision-answer strong'))
      .toHaveText('保留现有实现');
    await expectHealthy(page, guard);
  });
}

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

test('ask_user drafts retain unconfirmed text and size themselves independently when switching questions', async ({ page }) => {
  const guard = await open(page, 'scene=full-web&case=ask');
  const editor = page.getByRole('textbox', { name: '消息输入', exact: true });
  await expect(editor).toBeVisible();
  await settle(page);
  const emptyHeight = await editor.evaluate(element => element.getBoundingClientRect().height);
  const text = '尚未确认的多行回答。\n第二行应保留。\n' + '中文换行'.repeat(100);
  await page.evaluate(async path => {
    const { useCockpit } = await import(path) as SyntheticStoreModule;
    useCockpit.setState({ sendDraft: async () => false });
  }, '/src/net/store.ts');
  await editor.fill(text);
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  await expect(editor).toHaveValue(text);
  await expect(page.getByRole('button', { name: '提交回答', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '关闭发送提示', exact: true }).click();
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
