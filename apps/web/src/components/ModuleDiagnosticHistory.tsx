import type { ModuleDiagnosticHistory as History } from '@cockpit/protocol';
import { DisclosureSection } from './Disclosure';

function ObservedTime({ value }: { value?: string }) {
  return value ? <time dateTime={value}>{new Date(value).toLocaleString()}</time> : <>未知（旧后端未提供）</>;
}

export function ModuleDiagnosticHistory({ history }: { history: History }) {
  return <DisclosureSection label={`模块诊断历史（${history.errors.length} 条）`} name="模块诊断历史"
    className="module-diagnostic-history">
    <p>这些是已观测的历史错误，不代表当前服务故障；当前健康未知。关闭提示不代表恢复。</p>
    <p>仅含读取时的宿主进程记录；重启会丢失记录，不代表恢复。可在设置 → 关于 Cockpit 刷新查看。</p>
    {history.errorHistory
      ? <p>最多保留 {history.errorHistory.limit} 条，按模块、阶段和错误码聚合，最近观测优先。
        已淘汰 {history.errorHistory.evicted} 条聚合记录；次数仅覆盖每条记录的保留期间。</p>
      : <p>旧后端未提供保留范围、完整次数或观测时间；不能推断历史总数。</p>}
    {history.errors.length ? <ol>
      {history.errors.map((error, index) => <li key={`${error.id}:${error.stage}:${error.code}:${index}`}>
        <strong>{error.id} · {error.stage === 'activation' ? '加载阶段' : '运行阶段'}</strong>
        <p>错误码：<code>{error.code ?? '未知'}</code> · 观测次数：{error.count ?? '未知'}</p>
        <p>首次：<ObservedTime value={error.firstObservedAt} /><br />
          最近：<ObservedTime value={error.lastObservedAt} /></p>
        <p className="user-select-text">{error.error}</p>
      </li>)}
    </ol> : <p>没有保留的错误记录；这不是健康检查结果。</p>}
  </DisclosureSection>;
}
