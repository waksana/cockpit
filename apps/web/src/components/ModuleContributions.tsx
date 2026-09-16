import { Component, useSyncExternalStore, type ReactNode } from 'react';
import type { ComposerContext, RenderNode } from '@cockpit/module-api';
import { moduleRuntime, type ModuleRuntime } from '../lib/moduleRuntime';
import type { SessionDraft } from '../lib/textDraft';

class ModuleBoundary extends Component<{ children: ReactNode; fallback: ReactNode; runtime: ModuleRuntime; onFailure?: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { this.props.runtime.report(error); this.props.onFailure?.(); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export function ModuleContributions({ slot, draft, operation, disabled, runtime = moduleRuntime }: {
  slot: 'composerActions' | 'composerAbove'; draft: SessionDraft;
  operation: ComposerContext['operation']; disabled: boolean; runtime?: ModuleRuntime;
}) {
  useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  return <div className={slot === 'composerActions' ? 'module-composer-actions' : 'module-composer-above'}>
    {runtime.contributions(slot).map(({ module, contribution }) => {
      const Contribution = contribution.component;
      return <ModuleBoundary key={`${module.asset.id}:${module.asset.digest}:${contribution.id}`} runtime={runtime}
        onFailure={() => runtime.unregister(module)}
        fallback={<span role="status">模块控件不可用</span>}>
        <Contribution {...runtime.context(module, draft, operation, disabled)} />
      </ModuleBoundary>;
    })}
  </div>;
}

export function ModuleRenderNode({ node, fallback, runtime = moduleRuntime }: {
  node: RenderNode; fallback: ReactNode; runtime?: ModuleRuntime;
}) {
  useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const selected = runtime.renderer(node);
  if (!selected) return fallback;
  const Renderer = selected.renderer.component;
  return <ModuleBoundary key={`${selected.module.asset.id}:${selected.module.asset.digest}:${selected.renderer.id}:${node.origin.messageId}:${node.target ?? node.label}`}
    runtime={runtime} fallback={fallback}><Renderer node={node} /></ModuleBoundary>;
}
