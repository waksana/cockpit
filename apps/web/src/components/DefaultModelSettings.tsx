import { useId } from 'react';
import type { useDefaultModelSettings } from '../features/settings/useDefaultModelSettings';
import { SelectField } from './UI';
import { Button, RefreshButton } from './Button';
import { ResourceStatus, StateNotice } from './StateNotice';
import { OperationErrorResult, OperationResult } from './OperationResult';
import { SettingsContent } from './ModuleComponents';

export function DefaultModelSettings({ settings }: { settings: ReturnType<typeof useDefaultModelSettings> }) {
  const titleId = useId();
  const { resource, action, selected, models, available, canSave, saved, select, save, refresh } = settings;
  const value = resource.data;
  return <SettingsContent className="settings-section" aria-labelledby={titleId} aria-busy={action.busy}>
    <div className="settings-section-header">
      <h3 id={titleId} className="ck-heading">默认模型</h3>
      <RefreshButton label="刷新默认模型" disabled={!resource.connected || action.busy || resource.pending}
        pending={resource.pending} onClick={() => { void refresh(); }} />
    </div>
    <p className="settings-description">仅影响之后新建的会话，不会更改已有会话、恢复、重载或分叉的模型。</p>
    <ResourceStatus status={resource.status} failed={resource.failed} pending={resource.pending} />
    {resource.usable && value?.modelError && <StateNotice kind="error">{value.modelError}</StateNotice>}
    <SelectField label="新会话模型" value={selected}
      disabled={!resource.valid || value?.models === null || action.busy}
      onChange={event => select(event.target.value)}>
      {!available && <option value={selected} disabled>{selected || '加载模型…'}{selected ? '（列表未提供）' : ''}</option>}
      {models.map(model => <option key={model.modelId} value={model.modelId}>{model.name}</option>)}
    </SelectField>
    {resource.valid && value && (!available || selected !== value.modelId) &&
      <p className="settings-description">当前默认值：{value.modelId}</p>}
    {action.error
      ? <OperationErrorResult label="保存默认模型" error={action.error} cause={action.errorCause} />
      : saved && !action.busy && <OperationResult state="done">已保存默认模型。</OperationResult>}
    <div className="ck-actions">
      <Button variant="primary" disabled={!canSave} onClick={() => { void save(); }}>
        {action.busy ? '保存中…' : '保存'}
      </Button>
    </div>
  </SettingsContent>;
}
