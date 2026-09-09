import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Intents, type ScheduleEntry } from '@cockpit/protocol';
import { scheduleInput, scheduleCadence, type ScheduleForm } from './schedules';

const form: ScheduleForm = { prompt: ' Check progress ', timing: 'interval', value: ' 5m ', tz: 'Asia/Shanghai', recurring: true };
const now = new Date('2026-09-07T00:00:00Z').getTime();

test('interval sends exactly one native timing field without unrelated form values', () => {
  assert.deepEqual(scheduleInput(form, now), { prompt: 'Check progress', interval: '5m', recurring: true });
  assert.deepEqual(scheduleInput({ ...form, recurring: false }, now), {
    prompt: 'Check progress', interval: '5m', recurring: false,
  });
});

test('unsupported cron creation is explicit rather than a misleading form submission', () => {
  assert.throws(() => scheduleInput({ ...form, timing: 'cron', value: '0 9 * * *' }, now), /不支持/);
});

test('absolute time always sends a one-shot epoch even after selecting recurrence', () => {
  assert.deepEqual(scheduleInput({ ...form, timing: 'at', value: '2026-09-07T09:00:00Z' }, now), {
    prompt: 'Check progress', at: Date.parse('2026-09-07T09:00:00Z'), recurring: false,
  });
});

test('datetime-local input uses the browser timezone rather than treating it as UTC', () => {
  const value = '2026-09-08T09:30';
  assert.equal(scheduleInput({ ...form, timing: 'at', value }, new Date(value).getTime() - 60000).at, new Date(value).getTime());
});

test('invalid or past absolute times, empty prompts and missing timing are rejected', () => {
  assert.throws(() => scheduleInput({ ...form, prompt: ' \n ' }, now), /消息/);
  assert.throws(() => scheduleInput({ ...form, value: ' ' }, now), /执行时间/);
  for (const value of ['not-a-date', '2026-09-06T23:59:59Z', '2026-09-07T00:00:00Z']) {
    assert.throws(() => scheduleInput({ ...form, timing: 'at', value }, now), /未来/);
  }
});

test('native duration limits are checked before submission', () => {
  assert.throws(() => scheduleInput({ ...form, value: '2d' }, now), /1 秒至 24 小时/);
  assert.throws(() => scheduleInput({ ...form, timing: 'at', value: '2026-09-09T00:00:00Z' }, now), /24 小时/);
  assert.equal(scheduleInput({ ...form, tz: 'Not/AZone' }, now).interval, '5m');
});

test('known interval failures are concise Chinese and canonical valid limits are unchanged', () => {
  for (const value of ['25h', '0s', '1.5s', 'tomorrow']) {
    assert.throws(() => scheduleInput({ ...form, value }, now), {
      message: '间隔须为 1 秒至 24 小时，如 30s、5m 或 1d。',
    });
  }
  for (const value of ['1s', '1d']) {
    assert.deepEqual(scheduleInput({ ...form, value }, now), { prompt: 'Check progress', interval: value, recurring: true });
  }
});

test('both timing paths reject multiline and command prompts locally without rewriting the form', () => {
  for (const timing of ['interval', 'at'] as const) {
    for (const prompt of ['第一行\n第二行', '第一行\r第二行', '\n第一行', '第一行\n', '/help', '消息 --flag']) {
      const input = { ...form, prompt, timing, value: timing === 'at' ? '2026-09-07T09:00:00Z' : '1s' };
      const before = { ...input };
      assert.throws(() => scheduleInput(input, now), { message: '请输入单行消息，不使用命令参数或以 / 开头。' });
      assert.deepEqual(input, before);
    }
  }
});

test('known independent field problems both remain visible', () => {
  assert.throws(() => scheduleInput({ ...form, prompt: '第一行\n第二行', value: '25h' }, now), (error) =>
    error instanceof Error && error.message.includes('单行消息') && error.message.includes('1 秒至 24 小时'));
});

test('unknown schema issues and unexpected exceptions retain their diagnostic identity', (t) => {
  const invalid = Intents['schedule/add'].body.safeParse({ sessionId: 'form', prompt: 'x', interval: '1s', recurring: 'invalid' });
  assert.equal(invalid.success, false);
  if (invalid.success) return;
  const parse = t.mock.method(Intents['schedule/add'].body, 'safeParse', () => invalid);
  assert.throws(() => scheduleInput(form, now), (error) => error === invalid.error && invalid.error.message.includes('recurring'));
  const unexpected = new Error('validator unavailable: diagnostic-42');
  parse.mock.mockImplementation(() => { throw unexpected; });
  assert.throws(() => scheduleInput(form, now), (error) => error === unexpected);
});

const entry: ScheduleEntry = { id: 1, prompt: 'Check progress', recurring: true, nextRunAt: now };
test('cadence distinguishes recurring and one-shot relative schedules', () => {
  for (const [intervalMs, label] of [[86400000, '1 天'], [3600000, '1 小时'], [300000, '5 分钟'], [1500, '1.5 秒']] as const) {
    assert.equal(scheduleCadence({ ...entry, intervalMs }), `每 ${label}`);
    assert.equal(scheduleCadence({ ...entry, intervalMs, recurring: false }), `${label} 后 · 一次性`);
  }
});

test('cron and absolute cadence remain discoverable without other services', () => {
  assert.equal(scheduleCadence({ ...entry, cron: '0 9 * * *', tz: 'Asia/Shanghai' }), 'cron 0 9 * * *（Asia/Shanghai）');
  assert.equal(scheduleCadence({ ...entry, cron: '0 9 * * *', recurring: false }), 'cron 0 9 * * * · 一次性');
  assert.equal(scheduleCadence({ ...entry, at: now + 60000, recurring: false }), '一次性');
});
