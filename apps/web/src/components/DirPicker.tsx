// Folder picker — a server-side directory browser for choosing a new session's
// working directory. The browser can't pick a server path, so we list dirs over
// the `fs/listDir` intent: breadcrumb path (editable), an "up" row, the
// subdirectories, and a confirm that returns the currently-shown directory.
// Modal styled like Dialog (scrim + centered card).

import { useCallback, useState } from 'react';
import { useCockpit } from '../net/store';
import { useKeyedAction, useKeyedResource } from '../lib/useKeyedResource';
import { readDirectory } from '../lib/directoryResource';
import { Icon } from './Icon';
import { DirectoryModal } from './Dialog';

export interface DirPickerProps {
  initialPath?: string;
  onPick: (path: string) => Promise<string>;
  onCreated: (sessionId: string) => void;
  onCancel: () => void;
}

export function DirPicker(props: DirPickerProps) {
  return <DirectoryDialog key={props.initialPath ?? ''} {...props} />;
}

function DirectoryDialog({ initialPath, onPick, onCreated, onCancel }: DirPickerProps) {
  const listDir = useCockpit((s) => s.listDir);
  const [requestedPath, setRequestedPath] = useState(initialPath);
  const [editedPath, setEditedPath] = useState<string | null>(null);
  const read = useCallback(() => readDirectory(listDir, requestedPath), [listDir, requestedPath]);
  const key = JSON.stringify(['directory', requestedPath]);
  const resource = useKeyedResource(key, read);
  const action = useKeyedAction(key);
  const path = resource.data?.path;
  const parent = resource.data?.parent;
  const entries = resource.data?.entries.filter((entry) => entry.isDir);
  const edit = editedPath ?? path ?? requestedPath ?? '';
  const load = (next: string | undefined) => {
    if (!resource.connected || action.busy) return;
    setEditedPath(null);
    if (next === requestedPath) void resource.refresh();
    else setRequestedPath(next);
  };
  const cancel = useCallback(() => { if (!action.busy) onCancel(); }, [action.busy, onCancel]);
  const canPick = resource.valid && Boolean(path) && edit === path && !action.busy;

  const create = () => {
    if (!canPick || !path) return;
    let created: string | undefined;
    void action.run(async () => { created = await onPick(path); }, () => {
      if (created === undefined) return;
      onCreated(created);
      onCancel();
    });
  };
  return (
    <DirectoryModal busy={action.busy} onCancel={cancel}>
        <h3 className="dialog-title">选择工作目录</h3>

        <div className="dirpicker-path">
          <input
            className="dialog-input"
            value={edit}
            onChange={(e) => setEditedPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); load(edit.trim() || undefined); } }}
            disabled={action.busy}
            placeholder="服务器主目录"
            spellCheck={false} autoCapitalize="off" autoCorrect="off"
            aria-label="当前路径"
          />
          <button type="button" className="btn-icon rp" aria-label="前往" title="前往"
            disabled={!resource.connected || resource.pending || action.busy} onClick={() => load(edit.trim() || undefined)}>
            <Icon name="reload" size={20} />
          </button>
        </div>

        <div className="dirpicker-list scrollable">
          {resource.status && <div className="dirpicker-empty" role={resource.failed ? 'alert' : 'status'}>
            {resource.status}
          </div>}
          {action.error && <div className="dirpicker-empty" role="alert">创建会话失败：{action.error}</div>}
          {parent && (
            <button type="button" className="dirpicker-row up rp" disabled={!resource.valid || action.busy} onClick={() => load(parent)}>
              <span className="dirpicker-ico"><Icon name="back" size={18} /></span>
              <span className="dirpicker-name">上级目录</span>
            </button>
          )}
          {resource.valid && entries?.length === 0 ? (
            <div className="dirpicker-empty">（没有子文件夹）</div>
          ) : (
            entries?.map((e) => (
              <button key={e.name} type="button" className="dirpicker-row rp" disabled={!resource.valid || action.busy}
                onClick={() => load(`${path === '/' ? '' : path}/${e.name}`)}>
                <span className="dirpicker-ico folder"><Icon name="folder" size={18} /></span>
                <span className="dirpicker-name">{e.name}</span>
                <span className="dirpicker-enter"><Icon name="down" size={16} /></span>
              </button>
            ))
          )}
        </div>

        <div className="dialog-actions">
          <button type="button" className="dialog-btn rp" disabled={action.busy} onClick={cancel}>取消</button>
          <button type="button" className="dialog-btn primary rp" disabled={!canPick} aria-busy={action.busy}
            onClick={create}>
            {action.busy ? '创建中…' : '在此创建'}
          </button>
        </div>
    </DirectoryModal>
  );
}
