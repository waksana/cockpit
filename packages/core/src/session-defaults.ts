import { INITIAL_SESSION_MODEL, NewSessionDefaults, type NewSessionDefaultsView } from '@cockpit/protocol';
import type { SessionKernel } from './kernel.ts';
import { CockpitError, invalid } from './errors.ts';
import { messageOf } from './async.ts';

export interface SessionDefaultsStore {
  read(): Promise<NewSessionDefaults>;
  write(value: NewSessionDefaults): Promise<void>;
}

// Embedders without host storage can create sessions, but cannot claim a durable save.
const initialDefaults: SessionDefaultsStore = {
  read: async () => ({ modelId: INITIAL_SESSION_MODEL }),
  write: async () => { throw new CockpitError('UNSUPPORTED', 'Cockpit session defaults storage is not configured'); },
};

export class SessionDefaults {
  constructor(private readonly k: SessionKernel, private readonly store: SessionDefaultsStore = initialDefaults) {}

  async read(): Promise<NewSessionDefaultsView> {
    this.k.assertReadable();
    const value = NewSessionDefaults.parse(await this.store.read());
    try {
      const models = await this.k.untilFatal(() => this.k.runtime.models());
      return { ...value, models, modelError: models.some(model => model.modelId === value.modelId)
        ? null : this.unavailable(value.modelId) };
    } catch (error) {
      return { ...value, models: null, modelError: `Could not read the native model catalog: ${messageOf(error)}` };
    }
  }

  private unavailable(modelId: string): string {
    return `Default new-session model "${modelId}" is unavailable or disabled. Choose an available model in Cockpit's default new-session model settings; no substitute will be used.`;
  }

  private async validate(modelId: string): Promise<void> {
    const models = await this.k.untilFatal(() => this.k.runtime.models());
    if (!models.some(model => model.modelId === modelId)) throw invalid(this.unavailable(modelId));
  }

  async capture(): Promise<string> {
    const { modelId } = NewSessionDefaults.parse(await this.store.read());
    await this.validate(modelId);
    return modelId;
  }

  async set(modelId: string): Promise<NewSessionDefaults> {
    this.k.assertReadable();
    const value = NewSessionDefaults.parse({ modelId });
    await this.validate(value.modelId);
    await this.store.write(value);
    return value;
  }
}
