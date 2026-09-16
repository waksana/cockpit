// Directory selection is a form. Only session/new creates a native identity.
import { useCallback, useId, useState } from 'react';
import { useCockpit } from '../net/store';
import { IntentHttpError } from '../net/client';
import { useKeyedAction, useKeyedResource } from '../lib/useKeyedResource';
import { readDirectory } from '../lib/directoryResource';
import { Icon } from './Icon';
import { DirectoryModal } from './Dialog';
import { StateNotice } from './StateNotice';

interface DirPickerProps {
  initialPath?: string;
  onCreate: (cwd: string) => Promise<string>;
  onCreated: (sessionId: string) => void;
  onCancel: () => void;
}

export function DirPicker(props: DirPickerProps) {
  return <DirectoryDialog key={props.initialPath ?? ''} {...props} />;
}

function DirectoryDialog({ initialPath, onCreate, onCreated, onCancel }: DirPickerProps) {
  const listDir = useCockpit(s => s.listDir);
  const [requestedPath, setRequestedPath] = useState(initialPath);
  const [editedPath, setEditedPath] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [incompleteSessionId, setIncompleteSessionId] = useState<string>();
  const read = useCallback(() => readDirectory(listDir, requestedPath), [listDir, requestedPath]);
  const resource = useKeyedResource(JSON.stringify(['directory', requestedPath]), read);
  const identity = useId();
  const action = useKeyedAction(`create-session:${identity}`);
  const locked = submitted || action.busy;
  const path = resource.data?.path;
  const parent = resource.data?.parent;
  const entries = resource.data?.entries.filter(entry => entry.isDir);
  const edit = editedPath ?? path ?? requestedPath ?? '';
  const load = (next: string | undefined) => {
    if (!resource.connected || locked) return;
    setEditedPath(null);
    if (next === requestedPath) void resource.refresh();
    else setRequestedPath(next);
  };
  const canCreate = resource.valid && Boolean(path) && edit === path && !locked;
  const create = () => {
    if (!canCreate || !path) return;
    let sessionId: string;
    void action.run(async () => {
      setSubmitted(true);
      try { sessionId = await onCreate(path); }
      catch (error) {
        if (error instanceof IntentHttpError && error.sessionId) setIncompleteSessionId(error.sessionId);
        throw error;
      }
    }, () => { onCreated(sessionId); onCancel(); });
  };
  return <DirectoryModal busy={action.busy} onCancel={onCancel}>
    <h3 className="dialog-title">新建会话</h3>
    <p className="dialog-message">创建原生 Copilot 会话，使用所选目录的原生配置并返回真实会话 ID；不会发送初始化消息。创建后在会话中发送内容。</p>
    <div className="dirpicker-path">
      <input className="dialog-input ck-input" value={edit} onChange={event => setEditedPath(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault(); load(edit.trim() || undefined);
          }
        }}
        disabled={locked} placeholder="服务器主目录" spellCheck={false} autoCapitalize="off" autoCorrect="off"
        aria-label="当前路径" />
      <button type="button" className="ck-icon-button rp" aria-label="前往" title="前往"
        disabled={!resource.connected || resource.pending || locked} onClick={() => load(edit.trim() || undefined)}>
        <Icon name="reload" size={20} />
      </button>
    </div>
    <div className="dirpicker-list scrollable">
      {resource.status && <StateNotice kind={resource.failed ? 'error' : resource.pending ? 'loading' : 'info'}
        placement={entries?.length ? 'inline' : 'pane'}>{resource.status}</StateNotice>}
      {parent && <button type="button" className="dirpicker-row ck-button up rp" disabled={!resource.valid || locked} onClick={() => load(parent)}>
        <span className="dirpicker-ico"><Icon name="back" size={20} /></span>
        <span className="dirpicker-name">上级目录</span>
      </button>}
      {resource.valid && entries?.length === 0 ? <div className="dirpicker-empty">（没有子文件夹）</div>
        : entries?.map(entry => <button key={entry.name} type="button" className="dirpicker-row ck-button rp"
          disabled={!resource.valid || locked} onClick={() => load(`${path === '/' ? '' : path}/${entry.name}`)}>
          <span className="dirpicker-ico folder"><Icon name="folder" size={20} /></span>
          <span className="dirpicker-name">{entry.name}</span>
          <span className="dirpicker-enter"><Icon name="chevron_right" size={16} /></span>
        </button>)}
    </div>
    {action.error && <p className="dialog-message dialog-error" role="alert">
      创建未完成：{action.error}。不会自动重建或发送消息；请先检查原生会话列表。
    </p>}
    {incompleteSessionId && <p>已确认创建、后续状态尚待核对的原生会话：
      <button type="button" className="dialog-btn ck-button" onClick={() => { onCreated(incompleteSessionId); onCancel(); }}>
        {incompleteSessionId}
      </button>
    </p>}
    <p className="dialog-message">从未发送消息的空会话可能在卸载后消失；不会自动重建。</p>
    <div className="dialog-actions">
      <button type="button" className="dialog-btn ck-button rp" disabled={action.busy} onClick={onCancel}>取消</button>
      <button type="button" className="dialog-btn ck-button ck-primary primary rp" disabled={!canCreate} onClick={create}>
        {action.busy ? '创建中…' : '创建会话'}
      </button>
    </div>
  </DirectoryModal>;
}
