import { useCallback } from 'react';
import { useCockpit } from '../net/store';
import { useSessionResource } from '../lib/useSessionResource';
import { MessageBody } from './MessageBody';
import { CollapsibleSection, PanelPageShell, ResourceStatus, SessionResume } from './SessionPanelKit';
import { Icon } from './Icon';
import { SessionUsage } from './SessionUsage';
import type { ChatSession, PanelItem, TodoItem } from '../net/types';

const STATUS_ORDER: TodoItem['status'][] = ['in_progress', 'pending', 'blocked', 'done'];
const STATUS_LABEL: Record<TodoItem['status'], string> = {
  in_progress: '进行中', pending: '待办', blocked: '受阻', done: '已完成',
};

function TodoStatusIcon({ status }: { status: TodoItem['status'] }) {
  if (status === 'done') return <span className="todo-item-ico" data-status="done"><Icon name="check" size={16} /></span>;
  if (status === 'blocked') return <span className="todo-item-ico" data-status="blocked"><Icon name="close" size={14} /></span>;
  return <span className="todo-item-ico" data-status={status}><Icon name="radiooff" size={12} /></span>;
}

function PanelSection({ name, items }: { name: string; items: PanelItem[] }) {
  return (
    <CollapsibleSection title={name} count={items.length} bodyClassName="info-panel-list">
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`} className="info-panel-row" data-enabled={item.enabled === false ? 'false' : 'true'}>
          <span className="info-panel-row-label">{item.label}</span>
          {item.enabled === false && <span className="info-panel-row-off">已停用</span>}
          {item.sublabel && <span className="info-panel-row-sub">{item.sublabel}</span>}
        </div>
      ))}
    </CollapsibleSection>
  );
}

type SessionContextProps = { session: ChatSession; onClose: () => void };

export function SessionPlan({ session, onClose }: SessionContextProps) {
  const getPlan = useCockpit((s) => s.getPlan);
  const sid = session.sessionId;
  const loadPlan = useCallback(() => getPlan(sid), [getPlan, sid]);
  const resource = useSessionResource(sid, `plan:${sid}`, loadPlan);
  const plan = resource.data;
  const todos = plan?.todos ?? [];
  const grouped = STATUS_ORDER
    .map((status) => ({ status, items: todos.filter((todo) => todo.status === status) }))
    .filter((group) => group.items.length > 0);
  return (
    <PanelPageShell title={`计划与任务 · ${session.title}`} onClose={onClose}
      action={<button type="button" className="btn-icon rp manage-action" aria-label="刷新"
        disabled={resource.requiresResume || !resource.connected || resource.pending}
        onClick={() => { void resource.refresh(); }}><Icon name="reload" size={20} /></button>}>
      <SessionResume sessionId={sid} required={resource.requiresResume} onResumed={() => { void resource.refresh(); }} />
      <ResourceStatus status={resource.status} failed={resource.failed} />
      {resource.valid && !plan?.planMarkdown && todos.length === 0 && <div className="info-empty">本会话还没有计划或任务</div>}
      {plan?.planMarkdown && (
        <CollapsibleSection title="计划（plan.md）" bodyClassName="info-plan">
          <MessageBody body={plan.planMarkdown} />
        </CollapsibleSection>
      )}
      {todos.length > 0 && (
        <section className="info-section">
          <div className="info-section-name">任务清单 <span className="info-section-name-right">
            {todos.filter((todo) => todo.status === 'done').length}/{todos.length}
          </span></div>
          <div className="info-section-content">
            {grouped.map((group) => (
              <div key={group.status} className="todo-group">
                <div className="todo-group-label">{STATUS_LABEL[group.status]}（{group.items.length}）</div>
                {group.items.map((todo) => (
                  <div key={todo.id} className="todo-item" data-status={todo.status}>
                    <TodoStatusIcon status={todo.status} />
                    <div className="todo-item-body">
                      <div className="todo-item-title">{todo.title}</div>
                      {todo.description && <div className="todo-item-desc">{todo.description}</div>}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>
      )}
    </PanelPageShell>
  );
}

function ContextDetails({ session, onClose }: SessionContextProps) {
  const getPanels = useCockpit((s) => s.getPanels);
  const sid = session.sessionId;
  const loadPanels = useCallback(() => getPanels(sid), [getPanels, sid]);
  const panelsResource = useSessionResource(sid, `context-panels:${sid}`, loadPanels);
  const panels = panelsResource.data;

  const tasks = panels?.tasks ?? [];
  const instructionSources = panels?.instructionSources ?? [];
  const empty = !tasks.length && !instructionSources.length;
  const requiresResume = panelsResource.requiresResume;
  const refresh = () => { void panelsResource.refresh(); };
  return (
    <PanelPageShell title={`上下文资料 · ${session.title}`} onClose={onClose}
      action={<button type="button" className="btn-icon rp manage-action" aria-label="刷新"
        disabled={requiresResume || !panelsResource.connected || panelsResource.pending}
        onClick={refresh}><Icon name="reload" size={20} /></button>}>
      <SessionUsage key={sid} sessionId={sid} />
      <SessionResume sessionId={sid} required={requiresResume} onResumed={refresh} />
      <ResourceStatus status={panelsResource.status && `指令文件和子代理：${panelsResource.status}`} failed={panelsResource.failed} />
      {panelsResource.valid && empty && <div className="info-empty">本会话还没有上下文</div>}
      {instructionSources.length > 0 && <PanelSection name="指令文件" items={instructionSources} />}
      {tasks.length > 0 && <PanelSection name="子代理" items={tasks} />}
    </PanelPageShell>
  );
}

export function SessionContext(props: SessionContextProps) {
  return <ContextDetails key={props.session.sessionId} {...props} />;
}
