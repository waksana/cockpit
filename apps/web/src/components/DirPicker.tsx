// Directory and role selection is a form. Only session/new creates a native identity.
import { useCallback, useId, useState } from 'react';
import type { ModuleSelection } from '@cockpit/protocol';
import { useCockpit } from '../net/store';
import { IntentHttpError } from '../net/client';
import { useKeyedAction, useKeyedResource } from '../lib/useKeyedResource';
import { readDirectory } from '../lib/directoryResource';
import { Icon } from './Icon';
import { DirectoryModal } from './Dialog';
import './Modules.scss';

export interface DirPickerProps {
  initialPath?: string;
  onCreate: (cwd: string, modules?: ModuleSelection[]) => Promise<string>;
  onCreated: (sessionId: string) => void;
  onCancel: () => void;
}

export function DirPicker(props: DirPickerProps) {
  return <DirectoryDialog key={props.initialPath ?? ''} {...props} />;
}

function DirectoryDialog({ initialPath, onCreate, onCreated, onCancel }: DirPickerProps) {
  const listDir = useCockpit(s => s.listDir);
  const moduleIntent = useCockpit(s => s.moduleIntent);
  const [requestedPath, setRequestedPath] = useState(initialPath);
  const [editedPath, setEditedPath] = useState<string | null>(null);
  const [selected, setSelected] = useState<ModuleSelection[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [incompleteSessionId, setIncompleteSessionId] = useState<string>();
  const read = useCallback(() => readDirectory(listDir, requestedPath), [listDir, requestedPath]);
  const resource = useKeyedResource(JSON.stringify(['directory', requestedPath]), read);
  const identity = useId();
  const action = useKeyedAction(`create-session:${identity}`);
  const locked = submitted || action.busy;
  const path = resource.data?.path;
  const readModules = useCallback((signal: AbortSignal) =>
    moduleIntent('modules/list', { ...(path ? { cwd: path } : {}), checkAvailability: true }, signal), [moduleIntent, path]);
  const modules = useKeyedResource(`new-session-modules:${path ?? ''}`, readModules);
  const parent = resource.data?.parent;
  const entries = resource.data?.entries.filter(entry => entry.isDir);
  const edit = editedPath ?? path ?? requestedPath ?? '';
  const load = (next: string | undefined) => {
    if (!resource.connected || locked) return;
    setEditedPath(null);
    if (next === requestedPath) void resource.refresh();
    else setRequestedPath(next);
  };
  const canCreate = resource.valid && Boolean(path) && edit === path && !locked
    && (!selected.length || (modules.valid && selected.every(selection =>
      modules.data?.modules.find(module => module.id === selection.moduleId)?.roles
        .some(role => role.roleId === selection.roleId && role.available))));
  const create = () => {
    if (!canCreate || !path) return;
    let sessionId: string;
    void action.run(async () => {
      setSubmitted(true);
      try { sessionId = await onCreate(path, selected); }
      catch (error) {
        if (error instanceof IntentHttpError && error.sessionId) setIncompleteSessionId(error.sessionId);
        throw error;
      }
    }, () => { onCreated(sessionId); onCancel(); });
  };
  return <DirectoryModal busy={action.busy} onCancel={onCancel}>
    <h3 className="dialog-title">新建会话</h3>
    <p className="dialog-message">创建原生 Copilot 会话并配置所选模块，返回真实会话 ID；不会发送初始化消息。创建后在会话中发送内容。</p>
    <div className="dirpicker-path">
      <input className="dialog-input" value={edit} onChange={event => setEditedPath(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); load(edit.trim() || undefined); } }}
        disabled={locked} placeholder="服务器主目录" spellCheck={false} autoCapitalize="off" autoCorrect="off"
        aria-label="当前路径" />
      <button type="button" className="btn-icon rp" aria-label="前往" title="前往"
        disabled={!resource.connected || resource.pending || locked} onClick={() => load(edit.trim() || undefined)}>
        <Icon name="reload" size={20} />
      </button>
    </div>
    <div className="dirpicker-list scrollable">
      {resource.status && <div className="dirpicker-empty" role={resource.failed ? 'alert' : 'status'}>{resource.status}</div>}
      {parent && <button type="button" className="dirpicker-row up rp" disabled={!resource.valid || locked} onClick={() => load(parent)}>
        <span className="dirpicker-ico"><Icon name="back" size={18} /></span>
        <span className="dirpicker-name">上级目录</span>
      </button>}
      {resource.valid && entries?.length === 0 ? <div className="dirpicker-empty">（没有子文件夹）</div>
        : entries?.map(entry => <button key={entry.name} type="button" className="dirpicker-row rp"
          disabled={!resource.valid || locked} onClick={() => load(`${path === '/' ? '' : path}/${entry.name}`)}>
          <span className="dirpicker-ico folder"><Icon name="folder" size={18} /></span>
          <span className="dirpicker-name">{entry.name}</span>
          <span className="dirpicker-enter"><Icon name="down" size={16} /></span>
        </button>)}
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
      <button type="button" className="dialog-btn" disabled={!modules.connected || modules.pending}
        onClick={() => { void modules.refresh(); }}>刷新接入条件</button>
      <p>条件检查不预留名额；创建后的模块绑定会再次核对。Assistant 按对话需要初始化用户文件。</p>
    </fieldset>
    {action.error && <p className="dialog-message dialog-error" role="alert">
      创建未完成：{action.error}。不会自动重建或发送消息；请先检查原生会话列表。
    </p>}
    {incompleteSessionId && <p>已创建但模块接入未完成的原生会话：
      <button type="button" className="dialog-btn" onClick={() => { onCreated(incompleteSessionId); onCancel(); }}>
        {incompleteSessionId}
      </button>
    </p>}
    <p className="dialog-message">从未发送消息的空会话可能在卸载后消失；不会自动重建。</p>
    <div className="dialog-actions">
      <button type="button" className="dialog-btn rp" disabled={action.busy} onClick={onCancel}>取消</button>
      <button type="button" className="dialog-btn primary rp" disabled={!canCreate} onClick={create}>
        {action.busy ? '创建中…' : '创建会话'}
      </button>
    </div>
  </DirectoryModal>;
}
