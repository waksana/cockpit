import { render, screen, userEvent, waitFor } from '../test/dom';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { SessionMcp, SessionSkills } from '../components/Manage';
import { SessionResume } from '../components/SessionResume';
import { useCockpit } from '../net/store';
import type { ChatSession } from '../net/types';

const session: ChatSession = {
  sessionId: 'resource-test', title: 'Resource test', cwd: '/work/project', messages: [], queue: [],
  status: 'unloaded', error: null, loaded: false, ask: null, lastActivity: 0,
  materialized: true, historyStale: false, hasMore: false, loadingHistory: false,
};

function withStore(t: TestContext, patch: Partial<ReturnType<typeof useCockpit.getState>>) {
  const previous = useCockpit.getState();
  useCockpit.setState({ ...previous, ...patch }, true);
  t.after(() => { useCockpit.setState(previous, true); });
}

test('session resume issues only the load-session action and reports success after it resolves', async t => {
  const calls: string[] = [];
  let resolveLoad!: () => void;
  const successes: string[] = [];
  withStore(t, {
    connState: 'open',
    sessions: [session],
    sessionSettingsOperations: {},
    reloadingSessionIds: [],
    loadSession: async sessionId => {
      calls.push(`load:${sessionId}`);
      await new Promise<void>(resolve => { resolveLoad = resolve; });
    },
    reloadSession: async sessionId => { calls.push(`reload:${sessionId}`); },
  });

  render(createElement(SessionResume, {
    sessionId: session.sessionId, required: true,
    onResumed: () => { successes.push('resumed'); },
  }));
  assert.ok(screen.getByRole('group', { name: '会话未加载' }));
  await userEvent.setup().click(screen.getByRole('button', { name: '恢复会话' }));
  assert.deepEqual(calls, ['load:resource-test']);
  assert.deepEqual(successes, []);
  assert.equal(screen.getByRole('button', { name: '恢复中…' }).getAttribute('aria-busy'), 'true');

  resolveLoad();
  await waitFor(() => assert.deepEqual(successes, ['resumed']));
  assert.deepEqual(calls, ['load:resource-test']);
});

for (const [label, Component, loader] of [
  ['MCP', SessionMcp, 'mcpSession'],
  ['Skills', SessionSkills, 'skillsSession'],
] as const) {
  test(`${label} settings omit removed persistence-scope copy`, async t => {
    const loaded = { ...session, loaded: true, status: 'idle' as const };
    withStore(t, {
      connState: 'open',
      connectionGeneration: 1,
      sessions: [loaded],
      [loader]: async () => [],
    });
    render(createElement(Component, { session: loaded, onClose() {} }));
    await screen.findByText(label === 'MCP' ? '本会话没有可用的 MCP 服务器' : '未发现技能');
    assert.equal(document.body.textContent?.includes('仅本会话有效'), false);
    assert.equal(document.body.textContent?.includes('Cockpit 不保存或重放选择'), false);
    assert.equal(document.body.textContent?.includes('重载技能'), false);
    assert.equal(document.body.textContent?.includes('刷新技能定义后'), false);
  });
}
