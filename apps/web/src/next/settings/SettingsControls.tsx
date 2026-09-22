import { useContext, useId, type ReactNode } from 'react';
import { Alert, AlertDescription, Button, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@cockpit/ui';
import { useKeyedAction } from '../../lib/useKeyedResource';
import { useCockpit } from '../../net/store';
import { readSelectValue, selectValue } from './selectValue';
import { SettingsOverlayContainer } from './overlayContainer';

export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <Alert variant={error ? 'destructive' : 'default'} role={error ? 'alert' : 'status'}>
    <AlertDescription>{children}</AlertDescription>
  </Alert>;
}

export function SettingSelect({ label, value, options, disabled, onChange, placeholder = '未指定' }: {
  label: string; value?: string; options: { value: string; label: string; disabled?: boolean }[];
  disabled?: boolean; onChange: (value: string | undefined) => void; placeholder?: string;
}) {
  const id = useId();
  const container = useContext(SettingsOverlayContainer);
  const missing = value && !options.some(option => option.value === value);
  return <div className="next-settings-field">
    <Label htmlFor={id}>{label}</Label>
    <Select value={selectValue(value)} disabled={disabled} onValueChange={next => onChange(readSelectValue(next))}>
      <SelectTrigger id={id} aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent container={container}>
        <SelectItem value="unspecified">{placeholder}</SelectItem>
        {missing && <SelectItem value={selectValue(value)} disabled>{value}（当前值，列表未提供）</SelectItem>}
        {options.filter(option => option.value !== '').map(option => <SelectItem key={option.value}
          value={selectValue(option.value)} disabled={option.disabled}>{option.label}</SelectItem>)}
      </SelectContent>
    </Select>
  </div>;
}

export function ResourceSwitch({ identity, label, enabled, disabled, onChange, nativeError }: {
  identity: string; label: string; enabled: boolean; disabled: boolean;
  onChange: (enabled: boolean) => Promise<void>; nativeError?: string;
}) {
  const id = useId();
  const action = useKeyedAction(identity);
  return <div className="next-settings-toggle">
    <div className="next-settings-actions">
      <Switch id={id} checked={enabled} disabled={disabled || action.busy || !action.connected} aria-busy={action.busy}
        onCheckedChange={next => {
          if (disabled || action.busy || !action.connected) return;
          void action.run(() => onChange(next));
        }} />
      <Label htmlFor={id}>{label}</Label>
    </div>
    {action.busy && <p role="status">正在提交，等待原生状态…</p>}
    {(action.error || nativeError) && <Notice error>{action.error || nativeError}</Notice>}
  </div>;
}

export function ResumeSession({ sessionId, onResumed }: { sessionId: string; onResumed: () => void }) {
  const session = useCockpit(s => s.sessions.find(row => row.sessionId === sessionId));
  const action = useKeyedAction(`resume:${sessionId}`);
  const blocked = !session || session.loading || session.closing || session.status === 'running' || session.compacting;
  return <div className="next-settings-section">
    <Notice>会话未加载。恢复后可读取设置；不会重新加载已加载的会话。</Notice>
    <Button variant="outline" disabled={!action.connected || blocked || action.busy}
      aria-busy={action.busy} onClick={() => {
        if (blocked || action.busy) return;
        void action.run(() => useCockpit.getState().loadSession(sessionId), onResumed);
      }}>{action.busy ? '恢复中…' : '恢复会话'}</Button>
    {action.error && <Notice error>{action.error}</Notice>}
  </div>;
}
