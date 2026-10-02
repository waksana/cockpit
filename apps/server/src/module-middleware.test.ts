import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { ModuleIntentMiddlewares, ModuleIntentMiddleware } from '@cockpit/module-api/backend';
import { ModuleMiddleware, isModuleHostIntent } from './module-middleware.ts';
import { ModuleLifetime } from './module-shutdown.ts';

const body = { sessionId: 's', text: 'original', mode: 'enqueue' as const };
const receipt = { ok: true, messageId: 'native-receipt', queued: true };
function layer(registry: ModuleMiddleware, id: string, middleware: ModuleIntentMiddlewares) {
  const lifetime = new ModuleLifetime(id);
  lifetime.backend = { routes: [], middleware, onStop() {} };
  const errors: unknown[] = [];
  registry.register({ id, middleware, lifetime, report: error => errors.push(error) });
  return { lifetime, errors };
}

test('public allowlist excludes private intents; empty composition preserves results/errors', async () => {
  const registry = new ModuleMiddleware();
  assert.equal(isModuleHostIntent('prompt'), true);
  assert.equal(isModuleHostIntent('system/shutdown'), false);
  assert.equal(isModuleHostIntent('toString'), false);
  assert.deepEqual(await registry.run('prompt', body, async () => receipt, 'api'), receipt);
  const error = new Error('native delivery unknown');
  await assert.rejects(registry.run('prompt', body, async () => { throw error; }, 'api'), actual => actual === error);
});

test('deterministic onion composition changes input but never result or invocation identity', async () => {
  const registry = new ModuleMiddleware();
  const steps: string[] = [];
  const ids: string[] = [];
  layer(registry, 'z-inner', { prompt: async (invocation, next) => {
    steps.push('inner-before'); ids.push(invocation.invocationId);
    assert.equal(invocation.body.text, 'enhanced');
    assert.equal(invocation.origin, 'user');
    const result = await next();
    result.messageId = 'forged';
    steps.push('inner-after');
  } });
  layer(registry, 'a-outer', { prompt: async (invocation, next) => {
    steps.push('outer-before'); ids.push(invocation.invocationId);
    const attachments = [{ type: 'file' as const, path: '/managed/synthetic' }];
    const pending = next({ text: 'enhanced', attachments });
    attachments[0]!.path = '/late-mutation';
    await pending;
    steps.push('outer-after');
  } });
  let sent: unknown;
  const result = await registry.run('prompt', body, async input => {
    steps.push('native'); sent = input; return receipt;
  }, 'user');
  assert.deepEqual(steps, ['outer-before', 'inner-before', 'native', 'inner-after', 'outer-after']);
  assert.equal(ids[0], ids[1]);
  assert.deepEqual(result, receipt);
  assert.deepEqual(sent, { ...body, text: 'enhanced', attachments: [{ type: 'file', path: '/managed/synthetic' }] });
  assert.equal(body.text, 'original');
});

test('normal return cannot short circuit; thrown errors never invoke native', async () => {
  for (const callback of [
    async () => {},
    async () => { throw new Error('business rejection'); },
    // JavaScript modules may return anything; it is never a successful interface result.
    async () => receipt,
  ]) {
    const registry = new ModuleMiddleware();
    // @ts-expect-error Include a JavaScript wrapper that returns a forged receipt.
    layer(registry, 'fixture', { prompt: callback });
    let sends = 0;
    await assert.rejects(registry.run('prompt', body, async () => { sends++; return receipt; }, 'api'));
    assert.equal(sends, 0);
  }
});

test('identity, mode, unknown fields and invalid replacements fail before native', async () => {
  for (const changes of [
    { sessionId: 'other' }, { requestId: 'other' }, { notificationId: 'other' }, { mode: 'immediate' },
    { origin: 'user' }, { text: 1 }, { attachments: [{ type: 'file', path: '' }] },
  ]) {
    const registry = new ModuleMiddleware();
    layer(registry, 'fixture', { prompt: async (_invocation, next) => {
      // Exercise untyped JavaScript modules too, not only the public compile-time boundary.
      await Reflect.apply(next, undefined, [changes]);
    } });
    let sends = 0;
    await assert.rejects(registry.run('prompt', body, async () => { sends++; return receipt; }, 'api'));
    assert.equal(sends, 0);
  }
});

test('duplicate next poisons success even when caught; late next cannot send', async () => {
  const registry = new ModuleMiddleware();
  let saved: Parameters<ModuleIntentMiddleware<'prompt'>>[1] | undefined;
  layer(registry, 'fixture', { prompt: async (_invocation, next) => {
    saved = next;
    await next();
    await assert.rejects(next(), /more than once/);
  } });
  let sends = 0;
  await assert.rejects(registry.run('prompt', body, async () => { sends++; return receipt; }, 'api'), /more than once/);
  await assert.rejects(saved!(), /after completion/);
  assert.equal(sends, 1);
});

test('detached microtask next after wrapper settlement never starts native work', async () => {
  for (const throwing of [false, true]) {
    const registry = new ModuleMiddleware();
    layer(registry, 'fixture', { prompt: async (_invocation, next) => {
      void Promise.resolve().then(() => next()).catch(() => {});
      if (throwing) throw new Error('reject before dispatch');
    } });
    let sends = 0;
    await assert.rejects(registry.run('prompt', body, async () => { sends++; return receipt; }, 'api'));
    assert.equal(sends, 0);
  }
});

test('started downstream is joined after early return or wrapper failure, including shutdown drain', async () => {
  for (const throwing of [false, true]) {
    const registry = new ModuleMiddleware();
    const native = Promise.withResolvers<typeof receipt>();
    const entered = Promise.withResolvers<void>();
    const { lifetime } = layer(registry, 'fixture', { prompt: async (_invocation, next) => {
      void next();
      entered.resolve();
      if (throwing) throw new Error('persistence failure');
    } });
    const running = registry.run('prompt', body, () => native.promise, 'module');
    const outcome = running.then(value => ({ value }), error => ({ error }));
    await entered.promise;
    lifetime.signalStop();
    let drained = false;
    const draining = lifetime.drain().then(() => { drained = true; });
    await nextTurn();
    assert.equal(drained, false);
    native.resolve(receipt);
    const result = await outcome;
    if (throwing) assert.match(String('error' in result && result.error), /persistence failure/);
    else assert.deepEqual('value' in result && result.value, receipt);
    await draining;
  }
});

test('a swallowed downstream error cannot turn unknown native delivery into success', async () => {
  const registry = new ModuleMiddleware();
  layer(registry, 'fixture', { prompt: async (_invocation, next) => {
    try { await next(); } catch { /* Deliberately broken module. */ }
  } });
  let sends = 0;
  await assert.rejects(registry.run('prompt', body, async () => {
    sends++; throw new Error('native unknown');
  }, 'api'), /native unknown/);
  assert.equal(sends, 1);
});

test('shutdown and Stop fence delayed next without revoking post-send persistence', async () => {
  for (const stopping of ['module', 'session', 'request']) {
    const registry = new ModuleMiddleware();
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const request = new AbortController();
    const { lifetime } = layer(registry, 'fixture', { prompt: async (invocation, next) => {
      ready.resolve(); await release.promise;
      assert.equal(invocation.signal.aborted, true);
      await next();
    } });
    let sends = 0;
    const outcome = assert.rejects(registry.run('prompt', body, async () => { sends++; return receipt; }, 'api', request.signal));
    await ready.promise;
    if (stopping === 'module') lifetime.signalStop();
    else if (stopping === 'session') registry.cancelPrompts('s');
    else request.abort();
    release.resolve();
    await outcome;
    assert.equal(sends, 0);
  }
});

test('reentrant host calls are rejected, including cycles through another public intent', async () => {
  const registry = new ModuleMiddleware();
  layer(registry, 'fixture', {
    prompt: async () => { await registry.run('session/rename', { sessionId: 's', name: 'x' }, async () => ({ ok: true, title: 'x' }), 'module'); },
    'session/rename': async () => { await registry.run('prompt', body, async () => receipt, 'module'); },
  });
  await assert.rejects(registry.run('prompt', body, async () => receipt, 'api'), /Recursive host.call/);
});

test('other public intents use the same typed composition', async () => {
  const registry = new ModuleMiddleware();
  layer(registry, 'fixture', { 'session/rename': async (invocation, next) => {
    assert.equal(invocation.body.sessionId, 's');
    await next({ name: 'enhanced title' });
  } });
  const result = await registry.run('session/rename', { sessionId: 's', name: 'title' },
    async input => ({ ok: true, title: input.name }), 'module');
  assert.deepEqual(result, { ok: true, title: 'enhanced title' });
});
