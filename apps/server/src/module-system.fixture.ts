import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Engine, ModuleManager, ModuleRunnerClient, OfficialRuntime } from '@cockpit/core';
import { PushManager } from './push.ts';
import { createModuleIntents } from './module-intents.ts';
import { registerModuleProxy } from './module-proxy.ts';

if (process.env.COCKPIT_MODULE_FIXTURE !== '1' || !process.env.COCKPIT_HOME?.startsWith('/tmp/')
  || !process.env.COCKPIT_USER_ROOT?.startsWith('/tmp/') || !process.env.HOME?.startsWith('/tmp/')) {
  throw new Error('Module UI fixture requires explicitly isolated temporary native/user/home directories');
}
process.env.COCKPIT_NO_BOOT = '1';
const { app, onEngineEvent, maybeGracefulExit, registerStaticWeb, setTestDependencies } = await import('./index.ts');
interface FixtureCompletion {
  model: string;
  messages: { role: string; content?: unknown; tool_calls?: { function: { name: string } }[] }[];
  tools?: { function: { name: string } }[];
}
function nativeTaskResult<T>(value: unknown, accept: (value: object) => T | undefined, depth = 0): T | undefined {
  if (depth > 6) return undefined;
  if (typeof value === 'string') {
    try { return nativeTaskResult(JSON.parse(value), accept, depth + 1); }
    catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
  }
  if (Array.isArray(value)) return value.map(item => nativeTaskResult(item, accept, depth + 1)).find(result => result !== undefined);
  if (!value || typeof value !== 'object') return undefined;
  if ('error' in value || ('isError' in value && value.isError === true)) return undefined;
  const accepted = accept(value);
  if (accepted !== undefined) return accepted;
  if ('text' in value) return nativeTaskResult(value.text, accept, depth + 1);
  if ('content' in value) return nativeTaskResult(value.content, accept, depth + 1);
  return undefined;
}
let providerRequests = 0;
const provider = createServer(async (request, response) => {
  if (request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
  try {
    let text = '';
    for await (const chunk of request) {
      text += chunk;
      assert.ok(text.length <= 4 * 1024 * 1024, 'Fixture request limit exceeded');
    }
    const input = JSON.parse(text) as FixtureCompletion;
    if (process.env.COCKPIT_PARITY_PROBE_LOG) {
      assert.ok(process.env.COCKPIT_PARITY_PROBE_LOG.startsWith('/tmp/'), 'Parity evidence must stay in an isolated temporary root');
      appendFileSync(process.env.COCKPIT_PARITY_PROBE_LOG, `${JSON.stringify({
        nativeProviderRequest: true, assistantRolePresent: JSON.stringify(input.messages).includes('cockpit-assistant'),
      })}\n`, { mode: 0o600 });
    }
    let call: { name: string; arguments: string } | undefined;
    let content = 'Synthetic module UI response.';
    if (process.env.COCKPIT_TASK_PROBE === '1') {
      assert.ok(++providerRequests <= 100, 'Synthetic provider exceeded its finite sequence');
      const index = input.messages.findLastIndex(message => message.role === 'user'
        && !JSON.stringify(message.content).includes('<skill-context'));
      const prompt = JSON.stringify(input.messages[index]?.content);
      const after = input.messages.slice(index + 1);
      const called = after.flatMap(message => message.tool_calls?.map(value => value.function.name) ?? []);
      if (prompt.includes('TASK_MODULE_NATIVE_RESET')) {
        const handoff = process.env.COCKPIT_TASK_PROBE_HANDOFF;
        assert.ok(handoff?.startsWith('/tmp/'), 'Only synthetic handoff files are allowed');
        if (!called.includes('view')) call = { name: 'view', arguments: JSON.stringify({ path: handoff }) };
        else {
          assert.ok(!called.includes('self_clear_context'), 'Never replay a terminal reset');
          call = { name: 'self_clear_context', arguments: JSON.stringify({
            prompt: 'TASK_MODULE_NATIVE_PROBE after reset; read the same scoped Task data without modifying it.',
            handoffFiles: [handoff],
          }) };
        }
      } else if (prompt.includes('TASK_MODULE_NATIVE_OWNER_PROBE') || prompt.includes('TASK_MODULE_OWNER_DELIVERY_FIX')) {
        const completingAcceptedOwner = prompt.includes('TASK_MODULE_OWNER_DELIVERY_FIX');
        const ownerId = /owner_session_id=([A-Za-z0-9_-]+)/.exec(prompt)?.[1];
        assert.ok(ownerId, 'A synthetic dispatch must identify its exact owner');
        const owner = modules.catalog.getBinding(ownerId);
        assert.ok(owner);
        assert.equal(owner.phase, 'applied');
        assert.equal(owner.selections.length, 1, 'Dispatched owner must not inherit Assistant or Commander');
        assert.equal(owner.selections[0]?.moduleId, 'task');
        assert.equal(owner.selections[0]?.roleId, 'owner');
        assert.equal(owner.configRefs?.task?.accessFile, undefined, 'Owner must not receive caller access');
        assert.ok(prompt.includes(`owner_session_id=${owner.sessionId}`));
        const taskId = /taskId=([A-Za-z0-9_-]+)/.exec(prompt)?.[1];
        const goalVersion = Number(/goalVersion=([0-9]+)/.exec(prompt)?.[1]);
        const credential = /credential=(\/tmp\/[A-Za-z0-9_./-]+\.json)/.exec(prompt)?.[1];
        assert.ok(taskId && goalVersion === 1 && credential, 'Only the synthetic dispatched owner goal is allowed');
        const report = input.tools?.find(tool => tool.function.name.endsWith('work_report'))?.function.name;
        const deliver = input.tools?.find(tool => tool.function.name.endsWith('work_deliver'))?.function.name;
        assert.ok(report && deliver);
        const outcome = nativeTaskResult(after.findLast(message => message.role === 'tool')?.content, value => {
          if ('task' in value && value.task && typeof value.task === 'object'
            && 'taskId' in value.task && value.task.taskId === taskId
            && 'status' in value.task && typeof value.task.status === 'string') return value.task.status;
          return undefined;
        });
        if (!called.includes('skill')) call = { name: 'skill', arguments: JSON.stringify({ skill: 'cockpit-task-owner' }) };
        else if (!completingAcceptedOwner && !called.includes(report)) call = { name: report, arguments: JSON.stringify({
          credential, taskId, goalVersion, idempotencyKey: 'native-owner-probe-accepted',
          kind: 'accepted', summary: 'Synthetic isolated owner accepted its fixture goal.',
        }) };
        else if (!called.includes(deliver)) {
          if (!completingAcceptedOwner) assert.equal(outcome, 'active', 'Actual owner authorization must accept this bound goal');
          call = { name: deliver, arguments: JSON.stringify({
            credential, taskId, goalVersion, idempotencyKey: 'native-owner-probe-delivered', outcome: 'delivered',
            summary: 'Synthetic owner role and real scoped MCP completed; no product or production changes.',
            artifacts: [`http://127.0.0.1:${process.env.COCKPIT_PORT ?? 18771}/session/${owner.sessionId}`],
          }) };
        } else {
          assert.equal(outcome, 'delivered');
          content = 'TASK_MODULE_NATIVE_OWNER_DONE';
        }
        appendFileSync(join(process.env.COCKPIT_HOME!, 'owner-probe.jsonl'), `${JSON.stringify({
          sessionId: owner.sessionId, taskId, selections: owner.selections,
          noCallerAccess: true, called, nextTool: call?.name, outcome, completed: !call,
        })}\n`, { mode: 0o600 });
      } else if (prompt.includes('TASK_MODULE_NATIVE_PROBE')) {
        const bindings = modules.catalog.listBindings().filter(record =>
          record.selections.some(selection => selection.moduleId === 'task' && selection.roleId === 'commander'));
        assert.equal(bindings.length, 1, 'Fixture requires exactly one synthetic Task commander');
        const binding = bindings[0]!;
        assert.equal(binding.phase, 'applied', 'Module initialization must finish before model input');
        const accessFile = binding.configRefs?.task?.accessFile;
        assert.ok(accessFile && accessFile.startsWith('/tmp/'), 'Only a synthetic access reference may be read');
        const access = JSON.parse(readFileSync(accessFile, 'utf8')) as { sessionId: string; credentialFile: string };
        assert.equal(access.sessionId, binding.sessionId);
        assert.ok(access.credentialFile.startsWith('/tmp/'), 'No production credential may enter the probe');
        const mcp = input.tools?.find(tool => tool.function.name.endsWith('work_read'))?.function.name;
        assert.ok(mcp, 'Actual Task MCP read tool must be available');
        if (!called.includes('skill')) call = { name: 'skill', arguments: JSON.stringify({ skill: 'cockpit-task-commander' }) };
        else if (!called.includes('view')) call = { name: 'view', arguments: JSON.stringify({ path: accessFile }) };
        else if (!called.includes(mcp)) call = { name: mcp, arguments: JSON.stringify({ credential: access.credentialFile, limit: 1 }) };
        else {
          const result = nativeTaskResult(after.findLast(message => message.role === 'tool')?.content, value => {
            if ('items' in value && Array.isArray(value.items) && 'nextBefore' in value
              && (value.nextBefore === null || typeof value.nextBefore === 'number')) return true;
            return undefined;
          });
          assert.ok(result, 'Native Task MCP must return the actual structured read result, not a tool error');
          content = 'TASK_MODULE_NATIVE_DONE';
        }
        appendFileSync(join(process.env.COCKPIT_HOME!, 'task-probe.jsonl'), `${JSON.stringify({
          sessionId: binding.sessionId, phase: binding.phase, taskVersion: binding.selections.find(value => value.moduleId === 'task')!.version,
          credentialFile: access.credentialFile, called, nextTool: call?.name, completed: !call,
          projectInstructionsPresent: JSON.stringify(input.messages).includes('PROJECT_MODULE_INTEGRATION_SENTINEL'),
        })}\n`, { mode: 0o600 });
      }
      if (call) assert.ok(input.tools?.some(tool => tool.function.name === call!.name), `Required native tool is absent: ${call.name}`);
    }
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: 'module-ui-fixture', object: 'chat.completion.chunk', created: 1,
        model: input.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(chunk({ role: 'assistant', ...(call ? {
      tool_calls: [{ index: 0, id: `fixture-call-${providerRequests}`, type: 'function', function: call }],
    } : { content }) }) + chunk({}, call ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
  } catch (error) {
    console.error('Synthetic provider rejected its finite scenario', error);
    response.writeHead(400).end('{"error":{"message":"Synthetic module scenario failed"}}');
  }
});
await new Promise<void>(done => provider.listen(0, '127.0.0.1', done));
const address = provider.address();
if (!address || typeof address === 'string') throw new Error('Synthetic provider did not bind');
const native = new OfficialRuntime({
  clientOptions: { mode: 'empty',
    baseDirectory: process.env.COCKPIT_HOME, workingDirectory: process.cwd(), useLoggedInUser: false,
    builtinPluginDirectories: [], enableRemoteSessions: false, onListModels: () => [], logLevel: 'error' },
  sessionConfig: { model: 'gpt-4.1', provider: { type: 'openai', wireApi: 'completions',
    baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'gpt-4.1' },
    configDirectory: process.env.COCKPIT_HOME, enableConfigDiscovery: true, skipCustomInstructions: false,
    enableFileHooks: false, enableHostGitOperations: false, enableSessionStore: true, enableSkills: true,
    pluginDirectories: [], customAgents: [], enableManagedSettings: false, skipEmbeddingRetrieval: true,
    embeddingCacheStorage: 'in-memory', enableSessionTelemetry: false, remoteSession: 'off',
    availableTools: ['builtin:view', 'builtin:skill', 'custom:self_clear_context', 'mcp:*'] },
});
const modules: ModuleManager = new ModuleManager({ runtime: native, services: new ModuleRunnerClient(),
  sources: {
    ...(process.env.COCKPIT_WECHAT_MODULE_SOURCE ? { wechat: resolve(process.env.COCKPIT_WECHAT_MODULE_SOURCE) } : {}),
    ...(process.env.COCKPIT_TASK_MODULE_SOURCE ? { task: resolve(process.env.COCKPIT_TASK_MODULE_SOURCE) } : {}),
  },
  sessionDirectory: async id => (await engine.getResources(id, ['identity']))?.cwd,
});
const engine: Engine = new Engine({ runtime: native, modules, prefsFile: resolve(process.env.COCKPIT_HOME, 'fixture-prefs.json') });
const push = new PushManager();
registerModuleProxy(app, () => modules.taskGateway());
setTestDependencies({ engine, push, modules: createModuleIntents(modules) });
engine.onEvent(onEngineEvent);
engine.onActivitySettled(maybeGracefulExit);
await engine.start();
await registerStaticWeb();
const origin = await app.listen({ host: '127.0.0.1', port: Number(process.env.COCKPIT_PORT ?? 18771) });
process.stdout.write(`${JSON.stringify({ type: 'module-fixture-ready', origin })}\n`);
process.on('SIGTERM', () => {
  void engine.stop().then(() => app.close()).then(() => provider.close()).catch(error => {
    console.error(error); process.exitCode = 1;
  });
});
