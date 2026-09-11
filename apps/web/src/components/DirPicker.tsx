// Folder picker — a server-side directory browser for choosing a new session's
// working directory. The browser can't pick a server path, so we list dirs over
// the `fs/listDir` intent: breadcrumb path (editable), an "up" row, the
// subdirectories, and a persistent first-message draft. Native creation happens
// only when sending that draft, never when choosing a directory or role.

import { useCallback, useState, useSyncExternalStore } from 'react';
import { useCockpit } from '../net/store';
import { useKeyedAction, useKeyedResource } from '../lib/useKeyedResource';
import { readDirectory } from '../lib/directoryResource';
import { Icon } from './Icon';
import { DirectoryModal } from './Dialog';
import type { ModuleSelection } from '@cockpit/protocol';
import { Composer } from './Composer';
import { getNewSessionStart, type ArchivedStart, type ReadSessionStart, type StartSession } from '../lib/sessionStart';
import { uploadFile } from '../lib/upload';
import './Modules.scss';

export interface DirPickerProps {
  initialPath?: string;
  onStart: StartSession;
  onReadStart: ReadSessionStart;
  onCreated: (sessionId: string) => void;
  onCancel: () => void;
}

export function DirPicker(props: DirPickerProps) {
  return <DirectoryDialog key={props.initialPath ?? ''} {...props} />;
}

export function ArchivedSessionStarts({ archives, reading, onRead, onInspect }: {
  archives: ArchivedStart[]; reading: boolean; onRead: (operationId: string) => void; onInspect: (sessionId: string) => void;
}) {
  if (!archives.length) return null;
  return <details>
    <summary>已归档创建操作（只读） · {archives.length}</summary>
    <p>仅解除本地表单占用，不取消后台请求、不删除服务器回执、不证明会话或消息不存在。旧内容不会自动填回或重发。</p>
    {archives.map(entry => <section key={entry.operationId} aria-label={`归档操作 ${entry.operationId}`}>
      <p>原操作：<code>{entry.operationId}</code> · 本地归档时间：{new Date(entry.archivedAt).toLocaleString()}</p>
      <p>最后核对结果：{entry.operation?.state ?? '未确认'}（不是当前原生会话状态）</p>
      {entry.operation && <p>{entry.operation.state === 'accepted' ? '已接受消息的原生会话：' : '服务预留标识（可能尚未创建原生会话）：'}
        <code>{entry.operation.sessionId}</code></p>}
      {entry.error && <p role="alert">{entry.error}</p>}
      <button type="button" className="dialog-btn" disabled={reading} onClick={() => onRead(entry.operationId)}>只读核对归档原操作</button>
      {entry.operation && <button type="button" className="dialog-btn" onClick={() => onInspect(entry.operation!.sessionId)}>
        {entry.operation.state === 'accepted' ? '查看原会话' : '检查可能存在的原会话'}
      </button>}
    </section>)}
  </details>;
}

function DirectoryDialog({ initialPath, onStart, onReadStart, onCreated, onCancel }: DirPickerProps) {
  const listDir = useCockpit((s) => s.listDir);
  const moduleIntent = useCockpit(s => s.moduleIntent);
  const [creation] = useState(getNewSessionStart);
  const draftState = useSyncExternalStore(creation.subscribe, creation.getSnapshot, creation.getSnapshot);
  const selected = draftState.modules;
  const attempt = draftState.attempt;
  const operation = attempt?.operation;
  const [requestedPath, setRequestedPath] = useState(initialPath ?? draftState.cwd);
  const [editedPath, setEditedPath] = useState<string | null>(null);
  const read = useCallback(() => readDirectory(listDir, requestedPath), [listDir, requestedPath]);
  const key = JSON.stringify(['directory', requestedPath]);
  const resource = useKeyedResource(key, read);
  const action = useKeyedAction(`first-message-creation:${creation.draft.sessionId}`);
  const readAction = useKeyedAction(`first-message-readback:${creation.draft.sessionId}`);
  const historyAction = useKeyedAction('first-message-archive-readback');
  const locked = !!attempt || action.busy;
  const path = resource.data?.path;
  const readModules = useCallback((signal: AbortSignal) =>
    moduleIntent('modules/list', { ...(path ? { cwd: path } : {}) }, signal), [moduleIntent, path]);
  const modules = useKeyedResource(`new-session-modules:${path ?? ''}`, readModules);
  const parent = resource.data?.parent;
  const entries = resource.data?.entries.filter((entry) => entry.isDir);
  const edit = editedPath ?? path ?? requestedPath ?? '';
  const load = (next: string | undefined) => {
    if (!resource.connected || locked) return;
    setEditedPath(null);
    void creation.configure(next, selected);
    if (next === requestedPath) void resource.refresh();
    else setRequestedPath(next);
  };
  const setSelected = (next: ModuleSelection[]) => { void creation.configure(path ?? requestedPath, next); };
  const canStart = resource.valid && Boolean(path) && edit === path && !locked
    && (!selected.length || (modules.valid && selected.every(selection =>
      modules.data?.modules.find(module => module.id === selection.moduleId)?.roles
        .some(role => role.roleId === selection.roleId && role.available))));

  const send = async () => {
    if (!canStart || !path) return false;
    let created: string | undefined;
    return action.run(async () => {
      const accepted = await creation.send(path, selected, onStart);
      const result = creation.getSnapshot().attempt?.operation;
      if (!accepted || result?.state !== 'accepted') throw new Error(creation.getSnapshot().error ?? '首条消息尚未获确认，草稿和原操作已保留。');
      created = result.sessionId;
    }, () => {
      if (created === undefined) return;
      onCreated(created);
      onCancel();
    });
  };
  return (
    <DirectoryModal onCancel={onCancel}>
        <h3 className="dialog-title">新会话 · 发送首条消息</h3>
        <p className="dialog-message">发送后创建；准备模块后处理这条消息。选择目录和模块不会创建会话，微信在此后绑定/可用。</p>

        <div className="dirpicker-path">
          <input
            className="dialog-input"
            value={edit}
            onChange={(e) => setEditedPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); load(edit.trim() || undefined); } }}
            disabled={locked}
            placeholder="服务器主目录"
            spellCheck={false} autoCapitalize="off" autoCorrect="off"
            aria-label="当前路径"
          />
          <button type="button" className="btn-icon rp" aria-label="前往" title="前往"
            disabled={!resource.connected || resource.pending || locked} onClick={() => load(edit.trim() || undefined)}>
            <Icon name="reload" size={20} />
          </button>
        </div>

        <div className="dirpicker-list scrollable">
          {resource.status && <div className="dirpicker-empty" role={resource.failed ? 'alert' : 'status'}>
            {resource.status}
          </div>}
          {action.error && <div className="dirpicker-empty" role="alert">首条消息未获确认：{action.error}</div>}
          {parent && (
            <button type="button" className="dirpicker-row up rp" disabled={!resource.valid || locked} onClick={() => load(parent)}>
              <span className="dirpicker-ico"><Icon name="back" size={18} /></span>
              <span className="dirpicker-name">上级目录</span>
            </button>
          )}
          {resource.valid && entries?.length === 0 ? (
            <div className="dirpicker-empty">（没有子文件夹）</div>
          ) : (
            entries?.map((e) => (
              <button key={e.name} type="button" className="dirpicker-row rp" disabled={!resource.valid || locked}
                onClick={() => load(`${path === '/' ? '' : path}/${e.name}`)}>
                <span className="dirpicker-ico folder"><Icon name="folder" size={18} /></span>
                <span className="dirpicker-name">{e.name}</span>
                <span className="dirpicker-enter"><Icon name="down" size={16} /></span>
              </button>
            ))
          )}
        </div>

        <fieldset className="dirpicker-module-options" disabled={locked}>
          <legend>模块接入（可多选）</legend>
          {modules.status && <p role={modules.failed ? 'alert' : 'status'}>{modules.status}</p>}
          {modules.valid && modules.data?.modules.flatMap(module => module.roles.map(role => {
            const checked = selected.some(selection => selection.moduleId === module.id && selection.roleId === role.roleId);
            return <label key={`${module.id}:${role.roleId}`} className="module-role-option">
              <input type="checkbox" checked={checked} disabled={!role.available && !checked}
                onChange={event => setSelected(event.target.checked
                  ? [...selected.filter(selection => selection.moduleId !== module.id),
                    { moduleId: module.id, roleId: role.roleId, ...(module.selectedVersion ? { version: module.selectedVersion } : {}) }]
                  : selected.filter(selection => selection.moduleId !== module.id))} />
              <span>{role.name}<small>{role.description}</small>
                {!role.available && <small>{role.reason ?? '当前不可接入'}{role.boundSessionId && ` · ${role.boundSessionId}`}</small>}
              </span>
            </label>;
          }))}
          {modules.valid && selected.filter(selection => !modules.data?.modules
            .find(module => module.id === selection.moduleId)?.roles.some(role => role.roleId === selection.roleId))
            .map(selection => <label key={`${selection.moduleId}:${selection.roleId}`} className="module-role-option">
              <input type="checkbox" checked onChange={() => setSelected(selected.filter(item => item.moduleId !== selection.moduleId))} />
              <span>{selection.moduleId} · {selection.roleId}{selection.version && ` · ${selection.version}`}
                <small>原选择已不在当前模块列表中；请明确取消或恢复配置，不能直接发送。</small>
              </span>
            </label>)}
          <p>只配置所选模块，不写入工程角色文件。Assistant 按对话需要初始化用户文件。</p>
        </fieldset>
        {draftState.error && <p role="alert">{draftState.error}</p>}
        {readAction.error && <p role="alert">读取原操作失败：{readAction.error}</p>}
        {attempt && <section aria-label="首条消息创建操作">
          <p>原操作：<code>{attempt.request.operationId}</code></p>
          <p role="status">{operation?.state === 'accepted'
            ? '原生已接受首条消息，不代表回答已完成。'
            : operation?.state === 'creating' ? '创建/准备中，首条消息尚未确认接受。'
            : '结果未确认；保留原操作和草稿，不会再次创建或重新发送。'}</p>
          {operation?.sessionId && <p>{operation.state === 'accepted' ? '已接受消息的原生会话：' : '服务预留标识（可能尚未创建原生会话）：'}
            <code>{operation.sessionId}</code></p>}
          <button type="button" className="dialog-btn" disabled={!resource.connected || readAction.busy}
            onClick={() => { void readAction.run(async () => { await creation.read(onReadStart); }); }}>读取原操作状态</button>
          {operation?.sessionId && <button type="button" className="dialog-btn"
            onClick={() => { onCreated(operation.sessionId); onCancel(); }}>
            {operation.state === 'accepted' ? '查看已接受消息的会话' : '检查可能存在的原会话'}
          </button>}
          {operation?.state === 'accepted' && <button type="button" className="dialog-btn" disabled={action.busy}
            onClick={() => { void readAction.run(async () => { await creation.newIndependent(); }); }}>另起一个独立会话（不是重试）</button>}
          {operation?.state !== 'accepted' && <button type="button" className="dialog-btn"
            onClick={() => { void creation.archive(attempt.request.operationId, message => window.confirm(message)); }}>
            放弃当前草稿并归档本地操作（不是重试）
          </button>}
        </section>}
        {historyAction.error && <p role="alert">读取归档操作失败：{historyAction.error}</p>}
        <ArchivedSessionStarts archives={draftState.archives ?? []} reading={!historyAction.connected || historyAction.busy}
          onRead={operationId => { void historyAction.run(async () => { await creation.readArchived(operationId, onReadStart); }); }}
          onInspect={sessionId => { onCreated(sessionId); onCancel(); }} />
        <Composer draft={creation.draft} onSend={send} uploadFile={uploadFile}
          key={creation.draft.sessionId} sendBlocked={!canStart} placeholder="输入首条消息，或添加附件；发送后才创建会话…" />
        <div className="dialog-actions">
          <button type="button" className="dialog-btn rp" onClick={onCancel}>{attempt ? '关闭（保留原操作和草稿）' : '取消（保留草稿）'}</button>
        </div>
    </DirectoryModal>
  );
}
