import { NativeCompactResult, NativeModeSetResult, NativeModelSwitchResult } from '@cockpit/protocol';
import { sessionModelOptions } from './runtime.ts';
import { invalid } from './errors.ts';
import { settled } from './async.ts';
import type { SessionKernel } from './kernel.ts';

/** Native model, mode, name and manual compaction mutations on a loaded session. */
export class SessionSettings {
  private readonly k: SessionKernel;

  constructor(k: SessionKernel) {
    this.k = k;
  }

  async setModel(id: string, modelId: string, reasoningEffort?: string, contextTier?: 'default' | 'long_context') {
    return this.k.operation(id, (sdk, st) => st.serialize('modelGate', async () => {
      const options = {
        modelId,
        deferIfModelChangeQueued: true,
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        ...(contextTier !== undefined ? { contextTier } : {}),
      };
      if (reasoningEffort !== undefined || contextTier === 'long_context') {
        const [models, catalog] = await this.k.withSession(st, sdk, () => settled([
          sdk.rpc.model.list(), this.k.runtime.models(),
        ] as const));
        const option = sessionModelOptions(models.list, catalog).find(model => model.modelId === modelId);
        if (reasoningEffort !== undefined && !option?.supportedReasoningEfforts?.includes(reasoningEffort)) {
          throw invalid(`Native model ${modelId} does not list reasoning effort ${reasoningEffort}`);
        }
        if (contextTier === 'long_context' && option?.supportsLongContext !== true) {
          throw invalid(`Native model ${modelId} does not list long-context support`);
        }
      }
      const result = await this.k.withSession(st, sdk, () => sdk.rpc.model.switchTo(options));
      if (result.deferred) this.k.scheduleSync(st);
      return NativeModelSwitchResult.parse(result);
    }), ['model', 'models', 'usage', 'control', 'queue']);
  }

  async setMode(id: string, mode: 'interactive' | 'plan' | 'autopilot') {
    return this.k.operation(id, async (sdk, st) => {
      const result = await this.k.withSession(st, sdk, () => sdk.rpc.mode.set({ mode }));
      return NativeModeSetResult.parse(result);
    }, ['mode', 'model', 'models', 'usage']);
  }

  async rename(id: string, name: string): Promise<string> {
    if (!name.trim()) throw invalid('Session name must not be empty');
    return this.k.operation(id, async (sdk, st) => {
      await this.k.withSession(st, sdk, () => sdk.rpc.name.set({ name: name.trim() }));
      const title = (await this.k.withSession(st, sdk, () => sdk.rpc.name.get())).name;
      if (!title) throw new Error('Native rename was not confirmed');
      this.k.patch(st, { title });
      return title;
    }, ['identity']);
  }

  async compact(id: string, customInstructions?: string) {
    return this.k.operation(id, async (sdk, st) => {
      const token = st.controlToken;
      st.manualCompactions++;
      this.k.patch(st, { compacting: true });
      this.k.invalidate(st, ['controls']);
      try {
        return NativeCompactResult.parse(await this.k.withSession(st, sdk, () => sdk.rpc.history.compact({ customInstructions })));
      }
      finally {
        if (st.sdk === sdk && st.controlToken === token) {
          st.manualCompactions = Math.max(0, st.manualCompactions - 1);
          this.k.patch(st, { compacting: st.manualCompactions > 0 || st.observedCompaction });
        }
      }
    }, ['usage', 'controls']);
  }
}
