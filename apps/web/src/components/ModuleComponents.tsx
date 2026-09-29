import { createElement, Suspense, useCallback, useContext, useEffect, useState, useSyncExternalStore, type Attributes, type ReactNode } from 'react';
import type {
  AttachmentProps, MarkdownNode, MessageProps, ModuleComponentProps, ModulePage, SessionStatusProps, SettingsProps,
} from '@cockpit/module-api/frontend';
import { Link, useMatch } from 'react-router-dom';
import { ModuleErrorBoundary, moduleRuntime, type LoadedModule, type ModuleRuntime } from '../lib/moduleRuntime';
import { PublicComponentRuntime } from '../lib/publicComponentContext';

export function ModuleRuntimeProvider({ runtime, children }: { runtime: ModuleRuntime; children: ReactNode }) {
  return <PublicComponentRuntime.Provider value={runtime}>{children}</PublicComponentRuntime.Provider>;
}
// These hooks expose cached runtime-owned component types, not render-created HOCs.
// eslint-disable-next-line react-refresh/only-export-components
export function useModuleRuntime() { return useContext(PublicComponentRuntime) ?? moduleRuntime; }
// eslint-disable-next-line react-refresh/only-export-components
export function useModuleElement<Key extends keyof ModuleComponentProps>(
  boundary: Key, props: ModuleComponentProps[Key],
): ReactNode {
  const runtime = useModuleRuntime();
  return createElement(runtime.components.get(boundary), props as Attributes & ModuleComponentProps[Key]);
}
export function MessagePresentation(props: MessageProps) {
  return useModuleElement('message', props);
}

export function SessionStatus(props: SessionStatusProps) {
  return useModuleElement('sessionStatus', props);
}

export function Attachment(props: AttachmentProps) {
  return useModuleElement('attachment', props);
}

export function SettingsContent(props: SettingsProps) {
  return useModuleElement('settings', props);
}

function GlobalModuleLifetime({ module, runtime, active, onRetired }: {
  module: LoadedModule; runtime: ModuleRuntime; active: boolean; onRetired(module: LoadedModule): void;
}) {
  const [unmounted, setUnmounted] = useState(false);
  if (active && unmounted) setUnmounted(false);
  useEffect(() => {
    if (active) return;
    // The first commit unmounts children. The next lets their captured cleanup
    // errors reach componentDidCatch before a passive effect removes boundaries.
    if (unmounted) onRetired(module);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    else setUnmounted(true);
  }, [active, unmounted, module, onRetired]);
  return <>{(module.frontend.globalComponents ?? []).map(({ id, component: Component }) =>
      <ModuleErrorBoundary key={JSON.stringify([module.instanceId, id])} fallback={null}
        onFailure={error => runtime.fail(module, error)}>
        {active ? <Suspense fallback={null}><Component /></Suspense> : null}
      </ModuleErrorBoundary>)}</>;
}

export function ModuleGlobalComponents() {
  const runtime = useModuleRuntime();
  const modules = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const [retained, setRetained] = useState<readonly { module: LoadedModule; runtime: ModuleRuntime }[]>([]);
  const added = modules.filter(module => !module.signal.aborted && module.frontend.globalComponents?.length
    && !retained.some(entry => entry.module === module));
  if (added.length) setRetained([...retained, ...added.map(module => ({ module, runtime }))]
    .sort((a, b) => a.module.asset.id.localeCompare(b.module.asset.id)));
  const onRetired = useCallback((module: LoadedModule) => {
    setRetained(entries => entries.filter(entry => entry.module !== module));
  }, []);
  return <>{retained.map(entry =>
    <GlobalModuleLifetime key={entry.module.instanceId} {...entry} onRetired={onRetired}
      active={modules.includes(entry.module) && !entry.module.signal.aborted} />)}</>;
}

function PageNotice({ loading = false }: { loading?: boolean }) {
  return <div className="detail-empty"><div>
    <p role="status">{loading ? '正在加载模块页面…' : '模块页面不存在或已不可用。可返回主页，或刷新页面重新加载模块。'}</p>
    <Link className="ck-button ck-primary" to="/">返回主页</Link>
    {!loading && <button className="ck-button" onClick={() => window.location.reload()}>刷新页面</button>}
  </div></div>;
}

type PageLifetime = { module: LoadedModule; page: ModulePage; runtime: ModuleRuntime };
function ModulePageLifetime({ entry, active, onRetired }: {
  entry: PageLifetime; active: boolean; onRetired(entry: PageLifetime): void;
}) {
  const [unmounted, setUnmounted] = useState(false);
  if (active && unmounted) setUnmounted(false);
  useEffect(() => {
    if (active) return;
    if (unmounted) onRetired(entry);
    // Keep the boundary for child layout/passive cleanup, including route departure.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    else setUnmounted(true);
  }, [active, unmounted, entry, onRetired]);
  const Component = entry.page.component;
  return <ModuleErrorBoundary fallback={active ? <PageNotice /> : null}
    onFailure={error => entry.runtime.fail(entry.module, error)}>
    {active ? <Suspense fallback={<PageNotice loading />}><Component /></Suspense> : null}
  </ModuleErrorBoundary>;
}

/** Stays outside Routes so a departing page's cleanup retains its error owner. */
export function ModulePages() {
  const match = useMatch('/modules/:moduleId/:pageId');
  const runtime = useModuleRuntime();
  const modules = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const status = useSyncExternalStore(runtime.subscribe, runtime.getPageStatus, runtime.getPageStatus);
  const module = modules.find(item => !item.signal.aborted && item.asset.id === match?.params.moduleId);
  const page = module?.frontend.apiVersion === 3
    ? module.frontend.pages?.find(item => item.id === match?.params.pageId) : undefined;
  const [retained, setRetained] = useState<readonly PageLifetime[]>([]);
  if (module && page && !retained.some(entry => entry.module === module && entry.page === page)) {
    setRetained([...retained, { module, page, runtime }]);
  }
  const onRetired = useCallback((entry: PageLifetime) => {
    setRetained(entries => entries.filter(item => item !== entry));
  }, []);
  return <>
    {match && !page && <PageNotice loading={status === 'idle' || status === 'loading'} />}
    {retained.map(entry => <ModulePageLifetime
      key={JSON.stringify([entry.module.instanceId, entry.page.id])} entry={entry}
      active={entry.module === module && entry.page === page} onRetired={onRetired} />)}
  </>;
}

export function MarkdownReplacement({ node, fallback }: { node: MarkdownNode; fallback: ReactNode }) {
  const runtime = useModuleRuntime();
  useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const selected = runtime.renderer(node);
  if (!selected) return fallback;
  const Renderer = selected.renderer.component;
  return <ModuleErrorBoundary key={JSON.stringify([selected.module.asset.id, selected.module.asset.digest,
    selected.renderer.id, node.origin, node.kind, node.target])}
    onFailure={error => runtime.fail(selected.module, error)} fallback={fallback}>
    <Renderer node={node} fallback={fallback} />
  </ModuleErrorBoundary>;
}
