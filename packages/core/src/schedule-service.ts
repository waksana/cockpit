import type { CopilotSession } from '@github/copilot-sdk';
import type { ScheduleEntry } from '@cockpit/protocol';
import { invalid, unsupported } from './errors.ts';
import { messageOf } from './async.ts';
import type { SessionKernel } from './kernel.ts';

/** Native session schedules: validated creation with readback, listing and stop. */
export class ScheduleService {
  private readonly k: SessionKernel;

  constructor(k: SessionKernel) {
    this.k = k;
  }

  async addSchedule(id: string, options: {
    prompt: string; interval?: string; at?: number; recurring?: boolean;
  }): Promise<{ entry?: ScheduleEntry; error?: string; possiblyCreated?: boolean }> {
    const unknown = Object.keys(options).filter(key => !['prompt', 'interval', 'at', 'recurring'].includes(key));
    if (unknown.length) throw invalid(`Unknown schedule options: ${unknown.join(', ')}`);
    if ((options.interval !== undefined) === (options.at !== undefined)) throw invalid('Exactly one of interval or at is required');
    if (!options.prompt.trim() || /[\r\n]/.test(options.prompt) || /(^|\s)--/.test(options.prompt) || options.prompt.trimStart().startsWith('/')) {
      throw invalid('Schedule prompt must be plain single-line text without command flags');
    }
    const prompt = options.prompt.trim();
    let seconds: number;
    if (options.at !== undefined) {
      if (options.recurring) return unsupported('Recurring absolute schedules');
      seconds = Math.ceil((options.at - Date.now()) / 1000);
    } else {
      const interval = /^([1-9]\d*)(s|m|h|d)$/.exec(options.interval!);
      if (!interval) return unsupported('Non-deterministic schedule interval');
      seconds = Number(interval[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[interval[2]!] ?? 0);
    }
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86400) throw invalid('Schedule delay must be between 1 second and 24 hours');
    const recurring = options.at === undefined && (options.recurring ?? true);
    let dispatched = false;
    return this.k.operation(id, (sdk, st) => st.serialize('scheduleGate', async () => {
      if (options.at !== undefined) {
        seconds = Math.ceil((options.at - Date.now()) / 1000);
        if (seconds < 1) throw invalid('Absolute schedule time passed while waiting for the runtime');
      }
      const before = new Set((await this.k.withSession(st, sdk, () => sdk.rpc.schedule.list())).entries.map(entry => entry.id));
      let result: Awaited<ReturnType<CopilotSession['rpc']['commands']['invoke']>>;
      try {
        dispatched = true;
        result = await this.k.withSession(st, sdk, () => sdk.rpc.commands.invoke({ name: recurring ? 'every' : 'after', input: `${seconds}s ${prompt}` }));
      } catch (error) {
        return { possiblyCreated: true, error: `Native schedule command acknowledgement is unknown; a schedule may have been created: ${messageOf(error)}. Do not retry automatically` };
      }
      let entries: Awaited<ReturnType<CopilotSession['rpc']['schedule']['list']>>['entries'];
      try {
        entries = (await this.k.readResource(st, sdk, 'schedule')).entries;
      } catch (error) {
        return { possiblyCreated: true, error: `Native schedule readback failed after command acknowledgement (${result.kind}); a schedule may have been created: ${messageOf(error)}. Do not retry automatically` };
      }
      const created = entries.find(entry => !before.has(entry.id) && entry.prompt === prompt
        && entry.recurring === recurring && entry.intervalMs === seconds * 1000);
      if (!created) return { possiblyCreated: true, error: `Native schedule was not confirmed (${result.kind}); a schedule may have been created. No model fallback or automatic retry was sent` };
      const entry = this.scheduleEntry(created);
      if (result.kind !== 'text' && result.kind !== 'completed') return { entry, error: `Native schedule created with unexpected command outcome: ${result.kind}` };
      return { entry };
    }), ['schedule']).catch(error => {
      if (!dispatched) throw error;
      // A fatal/closed-session race can win the enclosing operation before the
      // RPC catch runs. It cannot establish that a dispatched command did nothing.
      return { possiblyCreated: true, error: `Native schedule operation ended after dispatch; a schedule may have been created: ${messageOf(error)}. Do not retry automatically` };
    });
  }

  private scheduleEntry(raw: Awaited<ReturnType<CopilotSession['rpc']['schedule']['list']>>['entries'][number]): ScheduleEntry {
    const nextRunAt = Date.parse(raw.nextRunAt);
    if (!Number.isFinite(nextRunAt)) throw new Error('Native schedule contains an invalid nextRunAt');
    return { id: raw.id, prompt: raw.prompt, recurring: raw.recurring, nextRunAt,
      selfPaced: raw.selfPaced, intervalMs: raw.intervalMs, cron: raw.cron, tz: raw.tz, at: raw.at, displayPrompt: raw.displayPrompt };
  }

  async listSchedules(id: string): Promise<ScheduleEntry[]> {
    return this.k.operation(id, async (sdk, st) => {
      const entries = (await this.k.readResource(st, sdk, 'schedule')).entries;
      return entries.map(entry => this.scheduleEntry(entry));
    }, 'read');
  }

  async stopSchedule(id: string, scheduleId: number): Promise<boolean> {
    return this.k.operation(id, (sdk, st) => st.serialize('scheduleGate', async () => {
      const result = await this.k.withSession(st, sdk, () => sdk.rpc.schedule.stop({ id: scheduleId }));
      return !!result.entry;
    }), ['schedule']);
  }
}
