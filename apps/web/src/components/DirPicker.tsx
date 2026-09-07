// Folder picker — a server-side directory browser for choosing a new session's
// working directory. The browser can't pick a server path, so we list dirs over
// the `fs/listDir` intent: breadcrumb path (editable), an "up" row, the
// subdirectories, and a confirm that returns the currently-shown directory.
// Modal styled like Dialog (scrim + centered card).

import { useCallback, useEffect, useState } from 'react';
import { useCockpit } from '../net/store';
import { Icon } from './Icon';

export function DirPicker({ initialPath, onPick, onCancel }: {
  initialPath: string;
  onPick: (path: string) => void;
  onCancel: () => void;
}) {
  const listDir = useCockpit((s) => s.listDir);
  const [path, setPath] = useState(initialPath);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<{ name: string; isDir: boolean }[] | null>(null);
  const [edit, setEdit] = useState(initialPath);

  const load = useCallback((p: string) => {
    setEntries(null);
    listDir(p).then((r) => {
      setPath(r.path);
      setEdit(r.path);
      setParent(r.parent);
      setEntries(r.entries.filter((e) => e.isDir));
    }).catch(() => setEntries([]));
  }, [listDir]);

  // Load the initial directory once when the picker opens. `load` sets state
  // (the listing) — that's the picker's whole job, so the synchronous-setState
  // lint is expected here.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(initialPath); }, [load, initialPath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="dialog-scrim" onPointerDown={onCancel}>
      <div className="dialog-card dirpicker" role="dialog" aria-modal="true" aria-label="选择工作目录" onPointerDown={(e) => e.stopPropagation()}>
        <h3 className="dialog-title">选择工作目录</h3>

        <div className="dirpicker-path">
          <input
            className="dialog-input"
            value={edit}
            onChange={(e) => setEdit(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); load(edit); } }}
            spellCheck={false} autoCapitalize="off" autoCorrect="off"
            aria-label="当前路径"
          />
          <button type="button" className="btn-icon rp" aria-label="前往" title="前往" onClick={() => load(edit)}>
            <Icon name="reload" size={20} />
          </button>
        </div>

        <div className="dirpicker-list scrollable">
          {parent && (
            <button type="button" className="dirpicker-row up rp" onClick={() => load(parent)}>
              <span className="dirpicker-ico"><Icon name="back" size={18} /></span>
              <span className="dirpicker-name">上级目录</span>
            </button>
          )}
          {entries === null ? (
            <div className="dirpicker-empty">加载中…</div>
          ) : entries.length === 0 ? (
            <div className="dirpicker-empty">（没有子文件夹）</div>
          ) : (
            entries.map((e) => (
              <button key={e.name} type="button" className="dirpicker-row rp" onClick={() => load(`${path === '/' ? '' : path}/${e.name}`)}>
                <span className="dirpicker-ico folder"><Icon name="folder" size={18} /></span>
                <span className="dirpicker-name">{e.name}</span>
                <span className="dirpicker-enter"><Icon name="down" size={16} /></span>
              </button>
            ))
          )}
        </div>

        <div className="dialog-actions">
          <button type="button" className="dialog-btn rp" onClick={onCancel}>取消</button>
          <button type="button" className="dialog-btn primary rp" onClick={() => onPick(path)}>
            在此创建
          </button>
        </div>
      </div>
    </div>
  );
}
