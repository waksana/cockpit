import { useId } from 'react';
import { loadModuleInventory, loadServiceIdentity } from '../net/api';
import { useKeyedResource } from '../lib/useKeyedResource';
import { RefreshButton } from './Button';
import { ResourceStatus, StateNotice } from './StateNotice';

export function AboutSettings() {
  const titleId = useId();
  const resource = useKeyedResource('service-identity', loadServiceIdentity);
  const modules = useKeyedResource('module-inventory', loadModuleInventory);
  const identity = resource.usable ? resource.data : undefined;
  const inventory = modules.usable ? modules.data : undefined;
  const pending = resource.pending || modules.pending;
  return <section className="settings-section settings-about" aria-labelledby={titleId}>
    <div className="settings-section-header">
      <h3 id={titleId} className="ck-heading">关于 Cockpit</h3>
      <RefreshButton label="刷新关于信息" disabled={!resource.connected || pending} pending={pending}
        onClick={() => { void resource.refresh(); void modules.refresh(); }} />
    </div>
    <ResourceStatus status={resource.status} failed={resource.failed} pending={resource.pending} />
    {identity && <dl className="runtime-identity">
      <dt>版本</dt><dd>{identity.version}</dd>
      <dt>源提交</dt><dd><code>{identity.sourceSha ?? '不可用'}</code></dd>
    </dl>}
    <section className="settings-section" aria-labelledby={`${titleId}-modules`}>
      <h4 id={`${titleId}-modules`} className="ck-heading">已加载模块</h4>
      <p className="settings-description">当前宿主进程的模块版本，不含未启用或未加载的安装。</p>
      <ResourceStatus status={modules.status} failed={modules.failed} pending={modules.pending} />
      {inventory && <>
        {inventory.active.length ? <dl className="runtime-identity settings-modules">
          {inventory.active.map(module => <div className="settings-module" key={module.id}>
            <dt>{module.name ?? module.id}{module.name && module.name !== module.id && <code>{module.id}</code>}</dt>
            <dd>{module.version ?? '版本未知'}</dd>
          </div>)}
        </dl> : <StateNotice kind="empty">当前宿主未加载模块。</StateNotice>}
        {inventory.errors.map((error, index) => <StateNotice kind="error" key={`${error.id}:${error.stage}:${index}`}>
          {error.id} · {error.stage === 'activation' ? '加载失败' : '运行错误'}：{error.error}
        </StateNotice>)}
      </>}
    </section>
  </section>;
}
