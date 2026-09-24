import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionConfig, SessionEvent } from '@github/copilot-sdk';
import { MCP_INVOCATION_META_KEY } from '@cockpit/protocol';
import { moduleMcpInvocationHook, SubagentNames } from './mcp-invocation.ts';
import type { RoleProvider } from './roles.ts';
import { harness, event } from '../test-support/engine-harness.ts';

type Hook = NonNullable<NonNullable<SessionConfig['hooks']>['onPreMcpToolCall']>;
const input = (serverName: string, sessionId: string, meta?: Record<string, unknown>): Parameters<Hook>[0] => ({
  serverName, toolName: 'probe', arguments: { actor_session_id: 'model-claimed' }, sessionId,
  timestamp: new Date(0), workingDirectory: '/fixture', ...(meta ? { _meta: meta } : {}),
});
const subagentEvent = (type: 'subagent.started' | 'subagent.completed' | 'subagent.failed', agentId: string, agentName = 'general-purpose') => ({
  ...event(type, { toolCallId: 'spawn', agentName, agentDisplayName: 'model label', agentDescription: '' } as never), agentId,
}) as SessionEvent;

test('module MCP calls from the main agent carry host-observed origin', async () => {
  const hook = moduleMcpInvocationHook(new Set(['module_tools']));
  assert.deepEqual(await hook(input('module_tools', 'main'), { sessionId: 'main' }), {
    metaToUse: { [MCP_INVOCATION_META_KEY]: { sessionId: 'main', runtimeSessionId: 'main', subagent: false } },
  });
});

test('existing request _meta is preserved and a forged namespace value is replaced', async () => {
  const hook = moduleMcpInvocationHook(new Set(['module_tools']));
  const result = await hook(input('module_tools', 'main', {
    progressToken: 3, 'other/key': { kept: true }, [MCP_INVOCATION_META_KEY]: { sessionId: 'forged', subagent: false },
  }), { sessionId: 'main' });
  assert.deepEqual(result, { metaToUse: {
    progressToken: 3, 'other/key': { kept: true },
    [MCP_INVOCATION_META_KEY]: { sessionId: 'main', runtimeSessionId: 'main', subagent: false },
  } });
});

test('servers not registered by modules keep their request _meta untouched', async () => {
  const hook = moduleMcpInvocationHook(new Set(['module_tools']));
  assert.equal(await hook(input('third_party', 'main', { progressToken: 1 }), { sessionId: 'main' }), undefined);
  assert.equal(await hook(input('third_party', 'sub-1'), { sessionId: 'main' }), undefined);
});

test('subagent calls are distinguished and named from observed native subagent events', async () => {
  const names = new SubagentNames();
  const hook = moduleMcpInvocationHook(new Set(['module_tools']), names);
  assert.deepEqual(await hook(input('module_tools', 'sub-1'), { sessionId: 'main' }), {
    metaToUse: { [MCP_INVOCATION_META_KEY]: { sessionId: 'main', runtimeSessionId: 'sub-1', subagent: true } },
  }, 'an unobserved subagent is still labelled without a name');
  names.observe(subagentEvent('subagent.started', 'sub-1', 'explore'));
  names.observe(event('subagent.started', { agentName: 'root-level' } as never));
  assert.deepEqual(await hook(input('module_tools', 'sub-1'), { sessionId: 'main' }), {
    metaToUse: { [MCP_INVOCATION_META_KEY]: { sessionId: 'main', runtimeSessionId: 'sub-1', subagent: true, agentName: 'explore' } },
  });
  assert.deepEqual(await hook(input('module_tools', 'main'), { sessionId: 'main' }), {
    metaToUse: { [MCP_INVOCATION_META_KEY]: { sessionId: 'main', runtimeSessionId: 'main', subagent: false } },
  }, 'the main agent never inherits a subagent name');
  names.observe(subagentEvent('subagent.completed', 'sub-1'));
  assert.equal(names.get('sub-1'), undefined);
  names.observe(subagentEvent('subagent.started', 'sub-2'));
  names.observe(subagentEvent('subagent.failed', 'sub-2'));
  assert.equal(names.get('sub-2'), undefined);
});

test('sessions register the hook only for module role MCP servers, including cold resume', async t => {
  const h = harness(t);
  const role = { moduleId: 'fixture', roleId: 'executor', name: 'Executor', moduleName: 'Fixture' };
  const saved = new Map<string, typeof role[]>();
  const provider: RoleProvider = {
    list: () => [role], read: id => saved.get(id) ?? [], save: (id, roles) => { saved.set(id, roles); },
    assemble: async (id, roles) => ({
      roles: roles.map(() => role), fingerprint: 'fixture', skills: [],
      config: {
        systemMessage: { mode: 'append', content: `Native session ID: ${id}` },
        mcpServers: { module_tools: { type: 'http', url: 'http://127.0.0.1/mcp', tools: ['*'] } },
      },
    }),
  };
  h.engine.setRoleProvider(provider);
  const plain = await h.engine.newSession(h.cwd);
  assert.equal(h.configs.get(plain)!.hooks, undefined, 'sessions without module MCP servers are unchanged');
  const id = await h.engine.newSession(h.cwd, [role]);
  const verify = async () => {
    const config = h.configs.get(id)!;
    const hook = config.hooks!.onPreMcpToolCall!;
    assert.equal(await hook(input('third_party', id), { sessionId: id }), undefined);
    config.onEvent!(subagentEvent('subagent.started', 'sub-agent', 'general-purpose'));
    assert.deepEqual(await hook(input('module_tools', 'sub-agent', { progressToken: 2 }), { sessionId: id }), { metaToUse: {
      progressToken: 2,
      [MCP_INVOCATION_META_KEY]: { sessionId: id, runtimeSessionId: 'sub-agent', subagent: true, agentName: 'general-purpose' },
    } });
    assert.deepEqual(await hook(input('module_tools', id), { sessionId: id }), {
      metaToUse: { [MCP_INVOCATION_META_KEY]: { sessionId: id, runtimeSessionId: id, subagent: false } },
    });
  };
  await verify();
  const before = h.configs.get(id);
  await h.engine.reload(id);
  assert.notEqual(h.configs.get(id), before);
  const fresh = await h.configs.get(id)!.hooks!.onPreMcpToolCall!(input('module_tools', 'sub-agent'), { sessionId: id });
  assert.deepEqual(fresh, { metaToUse: { [MCP_INVOCATION_META_KEY]: { sessionId: id, runtimeSessionId: 'sub-agent', subagent: true } } },
    'a resumed load starts with no stale subagent names');
  await verify();
});
