import { Intents, type IntentBody, type ScheduleEntry } from '@cockpit/protocol';

export type ScheduleInput = Omit<IntentBody<'schedule/add'>, 'sessionId'>;
export type ScheduleTiming = 'interval' | 'cron' | 'at';
export interface ScheduleForm {
  prompt: string;
  timing: ScheduleTiming;
  value: string;
  tz: string;
  recurring: boolean;
}

export function scheduleInput(form: ScheduleForm, now = Date.now()): ScheduleInput {
  const prompt = form.prompt.trim();
  const value = form.value.trim();
  if (!prompt) throw new Error('请输入要发送给本会话的消息。');
  if (!value) throw new Error('请填写执行时间。');
  let input: ScheduleInput;
  if (form.timing === 'at') {
    const at = new Date(value).getTime();
    if (!Number.isFinite(at) || at <= now) throw new Error('请选择未来的执行时间。');
    if (at - now > 86400000) throw new Error('请选择未来 24 小时内的执行时间。');
    input = { prompt, at, recurring: false };
  } else if (form.timing === 'cron') {
    throw new Error('当前原生接口不支持创建 cron 定时，请使用间隔或指定时间。');
  } else {
    input = { prompt, interval: value, recurring: form.recurring };
  }
  // Validate the original prompt on both paths so trimming cannot erase a forbidden newline.
  const parsed = Intents['schedule/add'].body.safeParse({ sessionId: 'form', ...input, prompt: form.prompt });
  if (!parsed.success) {
    const messages = parsed.error.issues.map((issue) => {
      if (issue.path.length !== 1) return null;
      if (issue.path[0] === 'prompt' && issue.code === 'custom'
        && issue.message === 'use single-line plain text without command flags or a leading slash')
        return '请输入单行消息，不使用命令参数或以 / 开头。';
      if (issue.path[0] === 'interval'
        && (issue.code === 'invalid_string' && issue.validation === 'regex'
          || issue.code === 'custom' && issue.message === 'interval must be between 1 second and 24 hours'))
        return '间隔须为 1 秒至 24 小时，如 30s、5m 或 1d。';
      return null;
    });
    if (messages.some((message) => message === null)) throw parsed.error;
    throw new Error([...new Set(messages)].join('\n'));
  }
  return input;
}

export function scheduleCadence(entry: ScheduleEntry): string {
  if (entry.selfPaced) return '自主节奏（由模型安排下次执行）';
  if (entry.intervalMs != null) {
    const ms = entry.intervalMs;
    const duration = ms >= 86400000 && ms % 86400000 === 0 ? `${ms / 86400000} 天`
      : ms >= 3600000 && ms % 3600000 === 0 ? `${ms / 3600000} 小时`
        : ms >= 60000 && ms % 60000 === 0 ? `${ms / 60000} 分钟`
          : `${ms / 1000} 秒`;
    return entry.recurring ? `每 ${duration}` : `${duration} 后 · 一次性`;
  }
  if (entry.cron) {
    return `cron ${entry.cron}${entry.tz ? `（${entry.tz}）` : ''}${entry.recurring ? '' : ' · 一次性'}`;
  }
  return entry.recurring ? '循环' : '一次性';
}
