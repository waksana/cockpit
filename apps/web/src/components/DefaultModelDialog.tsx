import { useState } from 'react';
import { cockpitApi, loadSessionDefaults } from '../net/api';
import { useKeyedResource } from '../lib/useKeyedResource';
import { Dialog } from './Dialog';
import { SelectField } from './UI';
import { RefreshButton } from './Button';
import { ResourceStatus, StateNotice } from './StateNotice';

export function DefaultModelDialog({ onClose }: { onClose: () => void }) {
  const resource = useKeyedResource('session-defaults', loadSessionDefaults);
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const value = resource.data;
  const selected = draft ?? value?.modelId ?? '';
  const models = value?.models ?? [];
  const available = models.some(model => model.modelId === selected);
  return <Dialog title="默认新会话模型"
    message="仅影响之后新建的会话（包括 Web、MCP 和 Task）；不会更改已有会话、恢复、重载或分叉的模型。"
    actionKey="session-defaults" confirmLabel="保存" pending={saving}
    confirmDisabled={!resource.valid || !available || selected === value?.modelId}
    onCancel={onClose} onConfirm={async () => {
      setSaving(true);
      try { await cockpitApi.setSessionDefaults(selected); }
      finally { setSaving(false); }
    }}>
    <ResourceStatus status={resource.status} failed={resource.failed} pending={resource.pending} />
    {value && <p className="dialog-message">当前默认值：{value.modelId}</p>}
    {value?.modelError && <StateNotice kind="error">{value.modelError}</StateNotice>}
    <SelectField label="新会话模型" value={selected}
      disabled={!resource.valid || value?.models === null || saving}
      onChange={event => setDraft(event.target.value)}>
      {!available && <option value={selected} disabled>{selected || '加载模型…'}{selected ? '（列表未提供）' : ''}</option>}
      {models.map(model => <option key={model.modelId} value={model.modelId}>{model.name}</option>)}
    </SelectField>
    <RefreshButton disabled={!resource.connected || saving || resource.pending}
      pending={resource.pending} onClick={() => { void resource.refresh(); }} />
  </Dialog>;
}
