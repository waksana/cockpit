import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Intents } from '@cockpit/protocol';
import type {
  ModuleHostIntent, ModuleHostIntentBody, ModuleHostIntentResult,
  ModuleIntentChanges, ModuleIntentMiddlewares, PromptAccepted,
} from '@cockpit/module-api/backend';
import type { ModuleLifetime } from './module-shutdown.ts';

// Exhaustive against the SDK projection; never derive this from all Host intents.
const publicIntents = {
  'session/new': true, 'session/get': true, 'session/rename': true,
  'roles/readiness': true, 'roles/availability': true, 'session/resources-prepare': true,
  prompt: true, respondAsk: true, 'session/chat': true, 'session/directory': true,
  'session/load': true, 'roles/notify': true, 'session/tool-scope': true,
} satisfies Record<ModuleHostIntent, true>;

export const isModuleHostIntent = (name: string): name is ModuleHostIntent => Object.hasOwn(publicIntents, name);
const protectedFields = new Set(['sessionId', 'requestId', 'notificationId', 'mode']);
const active = new AsyncLocalStorage<ReadonlySet<ModuleHostIntent>>();
const failure = (message: string) => Object.assign(new Error(message), { code: 'MODULE_MIDDLEWARE_INVALID', statusCode: 500 });

interface Layer {
  id: string;
  middleware: ModuleIntentMiddlewares;
  lifetime: ModuleLifetime;
  report(error: unknown): void;
}

/** Per-call composition only: no native state, receipts or business data are retained. */
export class ModuleMiddleware {
  private readonly layers: Layer[] = [];
  private readonly prompts = new Map<AbortController, string>();

  register(layer: Layer): void {
    this.layers.push(layer);
    this.layers.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  assertNotReentrant(name: ModuleHostIntent): void {
    if (active.getStore()?.has(name)) throw failure(`Recursive host.call(${name}) is forbidden; use next`);
  }

  cancelPrompts(sessionId: string): void {
    for (const [controller, target] of this.prompts) {
      if (target === sessionId) controller.abort(Object.assign(new Error('Prompt preparation was stopped'), {
        code: 'REQUEST_ABORTED', statusCode: 499,
      }));
    }
  }

  async run<Name extends ModuleHostIntent>(
    name: Name, body: ModuleHostIntentBody<Name>,
    terminal: (body: ModuleHostIntentBody<Name>) => Promise<unknown>,
    origin: PromptAccepted['origin'], signal?: AbortSignal,
  ): Promise<ModuleHostIntentResult<Name>> {
    this.assertNotReentrant(name);
    const layers = this.layers.filter(layer => layer.middleware[name]);
    const invoke = async (input: ModuleHostIntentBody<Name>) => {
      const result = Intents[name].result.safeParse(await terminal(input));
      if (!result.success) throw failure(`Invalid native result for ${name}: ${result.error.message}`);
      return result.data as ModuleHostIntentResult<Name>;
    };
    if (!layers.length) return invoke(body);
    const controller = new AbortController();
    const invocationId = randomUUID();
    const callSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : []),
      ...layers.flatMap(layer => [layer.lifetime.stopping.signal, layer.lifetime.controller.signal])]);
    if (name === 'prompt' && 'sessionId' in body && typeof body.sessionId === 'string') this.prompts.set(controller, body.sessionId);
    const walk = async (index: number, input: ModuleHostIntentBody<Name>): Promise<ModuleHostIntentResult<Name>> => {
      callSignal.throwIfAborted();
      const layer = layers[index];
      if (!layer) return invoke(input);
      return layer.lifetime.invoke(async () => {
        let closed = false;
        let called = false;
        let downstream: Promise<ModuleHostIntentResult<Name>> | undefined;
        let violation: Error | undefined;
        const next = (changes?: ModuleIntentChanges<Name>): Promise<ModuleHostIntentResult<Name>> => {
          if (closed || called) {
            const error = failure(closed ? 'Middleware next called after completion' : 'Middleware next called more than once');
            violation ??= error;
            layer.report(error);
            const rejected = Promise.reject<ModuleHostIntentResult<Name>>(error);
            void rejected.catch(() => {});
            return rejected;
          }
          called = true;
          downstream = (async () => {
            callSignal.throwIfAborted();
            if (changes !== undefined && (!changes || typeof changes !== 'object' || Array.isArray(changes))) {
              throw failure('Middleware changes must be an object');
            }
            if (changes && Object.keys(changes).some(key => protectedFields.has(key))) {
              throw failure('Middleware cannot replace target, operation identity or mode');
            }
            const schema = Intents[name].body;
            // Revalidate even detached replacements; never pass mutable module objects to native code.
            const parsed = schema.safeParse({ ...input, ...changes });
            if (!parsed.success) throw failure(`Invalid middleware input for ${name}: ${parsed.error.message}`);
            // Capture input now, but let an already-settled wrapper close before
            // admitting a detached microtask continuation.
            await Promise.resolve();
            if (closed) throw failure('Middleware next called after completion');
            callSignal.throwIfAborted();
            return walk(index + 1, parsed.data as ModuleHostIntentBody<Name>);
          })();
          // Observe immediately even if a broken wrapper neither awaits nor returns next.
          void downstream.catch(() => {});
          const snapshot = downstream.then(result => structuredClone(result));
          void snapshot.catch(() => {});
          return snapshot;
        };
        try {
          await layer.middleware[name]!({
            name, invocationId, origin, body: structuredClone(input), signal: callSignal,
          }, next);
        } catch (error) {
          layer.report(error);
          throw error;
        } finally {
          closed = true;
          // A wrapper cannot detach an already-started native send, even when it throws.
          if (downstream) await Promise.allSettled([downstream]);
        }
        if (violation) throw violation;
        if (!downstream) {
          const error = failure('Middleware completed without calling next');
          layer.report(error);
          throw error;
        }
        return downstream;
      });
    };
    try {
      return await active.run(new Set([...(active.getStore() ?? []), name]), () => walk(0, body));
    } finally {
      this.prompts.delete(controller);
    }
  }
}
