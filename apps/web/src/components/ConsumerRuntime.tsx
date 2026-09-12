import { useCallback, useState, type ReactNode } from 'react';
import { ConsumerOperationId } from '@cockpit/protocol';
import { useCockpit } from '../net/store';
import { useKeyedAction, useKeyedResource } from '../lib/useKeyedResource';

const key = 'cockpit-consumer-restart-operation';
function savedOperation(): { id?: string; error?: string } {
  if (typeof localStorage === 'undefined') return {};
  try {
    const value = localStorage.getItem(key);
    if (!value) return {};
    const parsed = ConsumerOperationId.safeParse(value);
    return parsed.success ? { id: parsed.data } : { error: '本地操作 ID 无效；请先清除此本地引用，不会发送重启。' };
  } catch { return { error: '无法读取本地操作 ID；不会在无法保留原操作时重启。' }; }
}

export function ConsumerRuntime({ children }: { children?: ReactNode }) {
  const intent = useCockpit(state => state.consumerIntent);
  const [saved, setSaved] = useState(savedOperation);
  const read = useCallback((signal: AbortSignal) => intent('system/consumer/status',
    { ...(saved.id ? { operationId: saved.id } : {}) }, signal), [intent, saved.id]);
  const resource = useKeyedResource('consumer-runtime', read, 0, !saved.error);
  const action = useKeyedAction('consumer-runtime-restart');
  const status = resource.valid && resource.data?.available ? resource.data : undefined;
  const operation = status?.operation;
  const terminal = operation && ['succeeded', 'failed', 'stopped', 'recovered', 'abandoned'].includes(operation.state);
  const blocked = Boolean(status?.activeOperationId || (saved.id && (!operation || !terminal)));
  const restart = () => {
    if (!status || blocked || action.busy || !status.mainLifecycleReady) return;
    if (!window.confirm('通过当前安装的独立启动器安全重启本体？忙碌工作会继续等待，不强停、不重发消息。')) return;
    void action.run(async () => {
      const operationId = crypto.randomUUID();
      localStorage.setItem(key, operationId);
      setSaved({ id: operationId });
      await intent('system/consumer/restart', { operationId, confirm: true });
      await resource.refresh(signal => intent('system/consumer/status', { operationId }, signal));
    });
  };
  if (resource.valid && resource.data?.available === false) return <>{children}</>;
  return <section aria-label="Consumer 本体运行与安全重启">
    {saved.error && <p role="alert">{saved.error}</p>}
    {resource.status && <p role={resource.failed ? 'alert' : 'status'}>{resource.status}</p>}
    {status && <>
      <p>本体实际状态：{status.health}</p>
      {status.runtime ? <p>当前版本：<code>{status.runtime.version} · {status.runtime.sha}</code>
        <br />实例：<code>{status.runtime.instanceId}</code></p>
        : <p>当前运行版本尚未确认，不使用安装目录或旧回执替代。</p>}
      {status.error && <p role="alert">{status.error}</p>}
    </>}
    {saved.id && <p>原重启操作：<code>{saved.id}</code></p>}
    {operation && <p>操作状态：{operation.state}{operation.error && ` · ${operation.error}`}。受理不代表重启完成。</p>}
    {action.error && <p role="alert">重启未获确认：{action.error}；只读取原操作，不自动重发。</p>}
    <button type="button" className="dialog-btn" disabled={!resource.connected || resource.pending || Boolean(saved.error)}
      onClick={() => { void resource.refresh(); }}>读取实际运行 / 原操作</button>
    <button type="button" className="dialog-btn" disabled={!status || blocked || action.busy || !status.mainLifecycleReady}
      onClick={restart}>安全重启本体</button>
    {(saved.id || saved.error) && <button type="button" className="dialog-btn" disabled={action.busy} onClick={() => {
      try { localStorage.removeItem(key); setSaved({}); }
      catch { setSaved({ ...saved, error: '本地操作引用无法清除，未发送任何请求。' }); }
    }}>只显示当前状态（不取消后台操作）</button>}
  </section>;
}
