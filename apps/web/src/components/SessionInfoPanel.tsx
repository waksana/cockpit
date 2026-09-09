// Session settings panel — opened by the chat title or the shared session menu.
// It intentionally reads only snapshot metadata and model state; native plan,
// MCP and Skills resources are owned by their dedicated pages.

import { useCockpit } from '../net/store';
import { useKeyedAction } from '../lib/useKeyedResource';
import { PanelPageShell, PermissionPolicy } from './SessionPanelKit';
import type { ChatSession, ModelOption } from '../net/types';

type ContextTier = 'default' | 'long_context';

const EFFORT_LABEL: Record<string, string> = {
  none: '不思考', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大',
};

// Model controls: picker + (conditional on the selected model's capabilities)
// reasoning effort and context tier. Effort shows only for models that list
// supportedReasoningEfforts; context tier only for models with a long_context
// price tier (supportsLongContext).
function ModelControls({ session, models, onSetModel, disabled }: {
  session: ChatSession;
  models: ModelOption[];
  onSetModel: (modelId: string, opts?: { reasoningEffort?: string; contextTier?: ContextTier }) => void;
  disabled: boolean;
}) {
  const list = (session.availableModels && session.availableModels.length > 0)
    ? session.availableModels : models;
  if (!list || list.length === 0) return null;

  const current = session.currentModelId ?? '';
  const currentModel = list.find((m) => m.modelId === current);
  const globalModel = currentModel && models.find((m) => m.modelId === current);
  const efforts = currentModel?.supportedReasoningEfforts ?? globalModel?.supportedReasoningEfforts ?? [];
  const supportsLong = currentModel?.supportsLongContext ?? globalModel?.supportsLongContext ?? false;
  const curEffort = session.currentReasoningEffort ?? currentModel?.defaultReasoningEffort ?? globalModel?.defaultReasoningEffort ?? '';
  const curTier: ContextTier = session.currentContextTier ?? 'default';

  return (
    <section className="info-section">
      <div className="info-section-name">模型</div>
      <div className="info-section-content info-controls">
        <label className="info-control">
          <span className="info-control-label">模型</span>
          <select className="info-select" disabled={disabled} value={current} onChange={(e) => onSetModel(e.target.value)} aria-label="选择模型">
            {current === '' && <option value="" disabled>选择模型…</option>}
            {current !== '' && !currentModel && <option value={current} disabled>{current}（当前值，列表未提供）</option>}
            {list.map((m) => <option key={m.modelId} value={m.modelId}>{m.name}</option>)}
          </select>
        </label>

        {efforts.length > 0 && (
          <label className="info-control">
            <span className="info-control-label">思考力度</span>
            <select className="info-select" disabled={disabled} value={curEffort}
              onChange={(e) => onSetModel(current, { reasoningEffort: e.target.value, contextTier: curTier })} aria-label="思考力度">
              {curEffort === '' && <option value="" disabled>力度…</option>}
              {curEffort !== '' && !efforts.includes(curEffort) && <option value={curEffort} disabled>{curEffort}（当前值，列表未提供）</option>}
              {efforts.map((e) => <option key={e} value={e}>{EFFORT_LABEL[e] ?? e}</option>)}
            </select>
          </label>
        )}

        {supportsLong && (
          <label className="info-control">
            <span className="info-control-label">上下文长度</span>
            <select className="info-select" disabled={disabled} value={curTier}
              onChange={(e) => onSetModel(current, { reasoningEffort: curEffort || undefined, contextTier: e.target.value as ContextTier })} aria-label="上下文长度">
              <option value="default">标准上下文</option>
              <option value="long_context">长上下文</option>
            </select>
          </label>
        )}
      </div>
    </section>
  );
}

export interface SessionInfoPanelProps {
  session: ChatSession;
  models: ModelOption[];
  open: boolean;
  onClose: () => void;
  onSetModel: (modelId: string, opts?: { reasoningEffort?: string; contextTier?: ContextTier }) => void | Promise<void>;
}

export function SessionInfoPanel(props: SessionInfoPanelProps) {
  if (!props.open) return null;
  return <InfoDetails key={props.session.sessionId} {...props} />;
}

function InfoDetails({ session, models, onClose, onSetModel }: SessionInfoPanelProps) {
  const connected = useCockpit((s) => s.connState === 'open');
  const sid = session.sessionId;
  const action = useKeyedAction(`info:${sid}`);

  return (
    <PanelPageShell title={`会话设置 · ${session.title}`} onClose={onClose}>
      <section className="info-section">
        <div className="info-section-name">{session.title}</div>
        <div className="info-section-content info-meta-cwd">{session.cwd}</div>
        <div className="info-section-content info-meta-id"><span className="info-meta-id-label">ID</span>{session.sessionId}</div>
      </section>

      <ModelControls session={session} models={models} disabled={!connected || action.busy}
        onSetModel={(model, opts) => { void action.run(() => onSetModel(model, opts)); }} />
      {action.error && <div className="info-empty" role="alert">设置失败：{action.error}</div>}
      <PermissionPolicy />
    </PanelPageShell>
  );
}
