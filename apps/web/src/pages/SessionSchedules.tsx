import { useCallback, useState, type FormEvent } from 'react';
import type { IntentResult } from '@cockpit/protocol';
import { useCockpit } from '../net/store';
import type { ChatSession } from '../net/types';
import { Icon } from '../components/Icon';
import { PanelPageShell, ResourceStatus, SessionResume } from '../components/SessionPanelKit';
import { useKeyedAction } from '../lib/useKeyedResource';
import { useSessionResource } from '../lib/useSessionResource';
import { scheduleCadence, scheduleInput, type ScheduleInput, type ScheduleTiming } from './schedules';

export interface SessionSchedulesProps {
  session: ChatSession;
  onClose: () => void;
  onAdd: (sessionId: string, input: ScheduleInput) => Promise<IntentResult<'schedule/add'>>;
  onStop: (sessionId: string, id: number) => Promise<IntentResult<'schedule/stop'>>;
}

function ScheduleDetails({ session, onClose, onAdd, onStop }: SessionSchedulesProps) {
  const scheduleList = useCockpit((s) => s.scheduleList);
  const [notice, setNotice] = useState('');
  const [kind, setKind] = useState<'add' | number>('add');
  const [prompt, setPrompt] = useState('');
  const [timing, setTiming] = useState<ScheduleTiming>('interval');
  const [values, setValues] = useState<Record<ScheduleTiming, string>>({ interval: '5m', cron: '0 9 * * *', at: '' });
  const [recurring, setRecurring] = useState(true);
  const sid = session.sessionId;
  const load = useCallback(() => scheduleList(sid), [scheduleList, sid]);
  const resource = useSessionResource(sid, `schedules:${sid}`, load, 0, ['schedule']);
  const action = useKeyedAction(`schedules:${sid}`);
  const busy = action.busy ? kind : null;
  const entries = resource.data;
  const connected = resource.connected;

  async function mutate(kind: 'add' | number, mutation: () => Promise<void>, success: () => void) {
    if (action.busy || !resource.valid) return;
    setKind(kind);
    setNotice('');
    await action.run(mutation, () => {
      success();
    });
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await mutate('add', async () => {
      const input = scheduleInput({ prompt, timing, value: values[timing], tz: '', recurring });
      await onAdd(sid, input);
    }, () => {
      setPrompt('');
      setNotice('定时任务已添加。');
    });
  }

  async function stop(id: number) {
    await mutate(id, async () => {
      await onStop(sid, id);
    }, () => setNotice(`定时任务 #${id} 已停止。`));
  }

  return (
    <PanelPageShell title={`定时任务 · ${session.title}`} onClose={onClose}
      action={<button type="button" className="btn-icon rp manage-action" aria-label="刷新列表"
        disabled={resource.requiresResume || !connected || resource.pending || busy !== null}
        onClick={() => { void resource.refresh(); }}><Icon name="reload" size={20} /></button>}>
      <section className="info-section">
        <div className="info-section-name">本会话的定时消息</div>
        <div className="info-section-content">
          <SessionResume sessionId={sid} required={resource.requiresResume} />
          <ResourceStatus status={resource.status} failed={resource.failed} />
          {resource.valid && entries?.length === 0 && <div className="info-empty">本会话还没有定时任务</div>}
          {entries?.map((entry) => (
            <div key={entry.id} className="info-sched-row">
              <div className="info-sched-head" style={{ flexWrap: 'wrap' }}>
                <span className="info-sched-cadence" style={{ overflowWrap: 'anywhere' }}>
                  <Icon name="schedule" size={14} /> {scheduleCadence(entry)}
                </span>
                <button type="button" className="dialog-btn" disabled={!resource.valid || busy !== null}
                  aria-label={`停止定时任务 #${entry.id}`} onClick={() => { void stop(entry.id); }}>
                  {busy === entry.id ? '停止中…' : '停止'}
                </button>
              </div>
              <div className="info-option-hint">
                #{entry.id} · 下次执行：<time dateTime={new Date(entry.nextRunAt).toISOString()}>
                  {new Date(entry.nextRunAt).toLocaleString()}
                </time>
              </div>
              {entry.displayPrompt && <div className="info-panel-row-label">{entry.displayPrompt}</div>}
              <div className="info-sched-prompt">{entry.prompt}</div>
            </div>
          ))}
        </div>
      </section>
      <p className="info-option-hint">任务会保留；卸载期间暂停，恢复后重新计算执行时间。定时任务不会让会话常驻。</p>

      <section className="info-section">
        <div className="info-section-name">添加定时任务</div>
        <form className="info-section-content info-controls" onSubmit={(event) => { void add(event); }}>
          <label>
            <span className="info-control-label">发送到本会话的消息</span>
            <textarea className="dialog-input" rows={4} required value={prompt} disabled={busy !== null}
              onChange={(event) => setPrompt(event.target.value)} placeholder="届时发送给当前会话的消息"
              style={{ resize: 'vertical', minHeight: '5rem' }} />
            <span className="info-option-hint">仅限单行消息，不使用命令参数或以 / 开头。</span>
          </label>
          <label className="info-control">
            <span className="info-control-label">执行方式</span>
            <select className="info-select" value={timing} disabled={busy !== null}
              onChange={(event) => setTiming(event.target.value as ScheduleTiming)}>
              <option value="interval">间隔</option>
              <option value="at">指定时间</option>
            </select>
          </label>
          <label>
            <span className="info-control-label">{timing === 'interval' ? '间隔（如 30s、5m、1h、1d）'
              : timing === 'cron' ? 'cron（分 时 日 月 星期）' : '执行时间（本机时区）'}</span>
            <input className="dialog-input" type={timing === 'at' ? 'datetime-local' : 'text'} required
              value={values[timing]} disabled={busy !== null} spellCheck={false}
              onChange={(event) => setValues((prev) => ({ ...prev, [timing]: event.target.value }))} />
            <span className="info-option-hint">{timing === 'interval' ? '1 秒–24 小时' : '未来 24 小时内'}</span>
          </label>
          {timing !== 'at' && (
            <label className="info-control">
              <span className="info-control-label">重复执行</span>
              <input type="checkbox" checked={recurring} disabled={busy !== null}
                onChange={(event) => setRecurring(event.target.checked)} />
            </label>
          )}
          {action.error && <div className="info-empty" role="alert">{action.error}</div>}
          {notice && <div className="info-option-hint" role="status">{notice}</div>}
          <button type="submit" className="btn-primary" disabled={!resource.valid || busy !== null || !prompt.trim()}>
            {busy === 'add' ? '添加中…' : '添加'}
          </button>
        </form>
      </section>
    </PanelPageShell>
  );
}

export function SessionSchedules(props: SessionSchedulesProps) {
  return <ScheduleDetails key={props.session.sessionId} {...props} />;
}
