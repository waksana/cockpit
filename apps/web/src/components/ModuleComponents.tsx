import { createContext, createElement, useContext, useSyncExternalStore, type Attributes, type ComponentType, type ReactNode } from 'react';
import type {
  AttachmentProps, GlobalActionsProps, MarkdownNode, MessageProps, ModuleComponentProps, SessionStatusProps,
} from '@cockpit/module-api';
import { ModuleErrorBoundary, moduleRuntime, type ModuleRuntime } from '../lib/moduleRuntime';

const RuntimeContext = createContext(moduleRuntime);
export function ModuleRuntimeProvider({ runtime, children }: { runtime: ModuleRuntime; children: ReactNode }) {
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}
// These hooks expose cached runtime-owned component types, not render-created HOCs.
// eslint-disable-next-line react-refresh/only-export-components
export function useModuleRuntime() { return useContext(RuntimeContext); }
// eslint-disable-next-line react-refresh/only-export-components
export function useModuleElement<Key extends keyof ModuleComponentProps>(
  boundary: Key, Base: ComponentType<ModuleComponentProps[Key]>, props: ModuleComponentProps[Key],
): ReactNode {
  const runtime = useModuleRuntime();
  useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  return createElement(runtime.compose(boundary, Base), props as Attributes & ModuleComponentProps[Key]);
}

function MessageBase({ identity: _identity, complete: _complete, bodyRef, adornment, children, ...props }: MessageProps) {
  // Sibling adornments preserve the actual body's prose margins and measurement.
  return <><div {...props} ref={bodyRef}>{children}</div>{adornment}</>;
}
export function MessagePresentation(props: MessageProps) {
  return useModuleElement('message', MessageBase, props);
}

const STATUS_TEXT = { unloaded: '', idle: '', running: '回复中', error: '出错' };
function SessionStatusBase({ status, needsDecision, children }: SessionStatusProps) {
  return <span className="dialog-meta">
    {children}
    {STATUS_TEXT[status] && <span className="dialog-status" data-tone={status}>{STATUS_TEXT[status]}</span>}
    {needsDecision && <span className="dialog-status" title="需要选择" aria-label="需要选择">选</span>}
  </span>;
}
export function SessionStatus(props: SessionStatusProps) {
  return useModuleElement('sessionStatus', SessionStatusBase, props);
}

function AttachmentBase({ children, actions }: AttachmentProps) { return <>{children}{actions}</>; }
export function Attachment(props: AttachmentProps) {
  return useModuleElement('attachment', AttachmentBase, props);
}

function GlobalActionsBase({ children }: GlobalActionsProps) { return <>{children}</>; }
export function GlobalActions(props: GlobalActionsProps) {
  return useModuleElement('globalActions', GlobalActionsBase, props);
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
