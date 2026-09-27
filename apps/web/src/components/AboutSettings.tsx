import { useId } from 'react';
import { loadServiceIdentity } from '../net/api';
import { useKeyedResource } from '../lib/useKeyedResource';
import { RefreshButton } from './Button';
import { ResourceStatus } from './StateNotice';

export function AboutSettings() {
  const titleId = useId();
  const resource = useKeyedResource('service-identity', loadServiceIdentity);
  const identity = resource.usable ? resource.data : undefined;
  return <section className="settings-section settings-about" aria-labelledby={titleId}>
    <div className="settings-section-header">
      <h3 id={titleId} className="ck-heading">关于 Cockpit</h3>
      <RefreshButton label="刷新关于信息" disabled={!resource.connected || resource.pending} pending={resource.pending}
        onClick={() => { void resource.refresh(); }} />
    </div>
    <ResourceStatus status={resource.status} failed={resource.failed} pending={resource.pending} />
    {identity && <dl className="runtime-identity">
      <dt>版本</dt><dd>{identity.version}</dd>
      <dt>源提交</dt><dd><code>{identity.sourceSha ?? '不可用'}</code></dd>
    </dl>}
  </section>;
}
