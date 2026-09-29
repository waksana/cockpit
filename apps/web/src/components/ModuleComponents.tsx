import { createElement, Suspense, useCallback, useContext, useEffect, useState, useSyncExternalStore, type Attributes, type ReactNode } from 'react';
import type {
  AttachmentProps, MarkdownNode, MessageProps, ModuleComponentProps, SessionStatusProps, SettingsProps,
} from '@cockpit/module-api/frontend';
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
