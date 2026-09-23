// Directory selection is a form. Only session/new creates a native identity.
import { useCallback, useId, useState } from 'react';
import { cockpitApi, loadRoleCatalog } from '../net/api';
import { IntentHttpError } from '../net/client';
import { useKeyedAction, useKeyedResource } from '../lib/useKeyedResource';
import { readDirectory } from '../lib/directoryResource';
import { Button, IconButton } from './Button';
import { DirectoryModal } from './Dialog';
import { OperationErrorResult } from './OperationResult';
import { StateNotice } from './StateNotice';
import { ActionRow } from './UI';
import type { RoleSelection } from '@cockpit/protocol';
import { RolePicker } from './RolePicker';

interface DirPickerProps {
  initialPath?: string;
  onCreate: (cwd: string, roles?: RoleSelection[]) => Promise<string>;
  onCreated: (sessionId: string) => void;
  onCancel: () => void;
}

export function DirPicker(props: DirPickerProps) {
  return <DirectoryDialog key={props.initialPath ?? ''} {...props} />;
}

function DirectoryDialog({ initialPath, onCreate, onCreated, onCancel }: DirPickerProps) {
  const roleResource = useKeyedResource('module-roles', loadRoleCatalog);
  const [selectedRoles, setSelectedRoles] = useState<RoleSelection[]>([]);
  const [requestedPath, setRequestedPath] = useState(initialPath);
  const [editedPath, setEditedPath] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [incompleteSessionId, setIncompleteSessionId] = useState<string>();
  const read = useCallback(() => readDirectory(cockpitApi.listDir, requestedPath), [requestedPath]);
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
  const rolesAvailable = selectedRoles.every(selected => roleResource.data?.some(role =>
    role.moduleId === selected.moduleId && role.roleId === selected.roleId));
  const canCreate = resource.valid && roleResource.valid && rolesAvailable && Boolean(path) && edit === path && !locked;
  const create = () => {
    if (!canCreate || !path) return;
    let sessionId: string;
    void action.run(async () => {
      setSubmitted(true);
      try { sessionId = await onCreate(path, selectedRoles.length ? selectedRoles : undefined); }
      catch (error) {
        if (error instanceof IntentHttpError && error.sessionId) setIncompleteSessionId(error.sessionId);
        throw error;
      }
    }, () => { onCreated(sessionId); onCancel(); });
  };
  return <DirectoryModal busy={action.busy} onCancel={onCancel}>
    <p className="dialog-message">选择工作目录，按需添加模块角色。</p>
    <div className="dirpicker-content scrollable">
    <label className="dirpicker-section-title" htmlFor={`${identity}-path`}>工作目录</label>
    <div className="dirpicker-path">
      <input id={`${identity}-path`} className="dialog-input ck-input" value={edit} onChange={event => setEditedPath(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault(); load(edit.trim() || undefined);
          }
        }}
        disabled={locked} placeholder="服务器主目录" spellCheck={false} autoCapitalize="off" autoCorrect="off"
        aria-label="当前路径" />
      <IconButton icon="reload" iconSize={20} label="前往" title="前往"
        disabled={!resource.connected || resource.pending || locked} onClick={() => load(edit.trim() || undefined)} />
    </div>
    <div className="dirpicker-list scrollable">
      {resource.status && <StateNotice kind={resource.failed ? 'error' : resource.pending ? 'loading' : 'info'}
        placement={entries?.length ? 'inline' : 'pane'}>{resource.status}</StateNotice>}
      {parent && <ActionRow icon="back" name="上级目录" trailing={false} data-parent
        disabled={!resource.valid || locked} onClick={() => load(parent)} />}
      {resource.valid && entries?.length === 0 ? <StateNotice kind="empty" placement="pane">（没有子文件夹）</StateNotice>
        : entries?.map(entry => <ActionRow key={entry.name} icon="folder" name={entry.name}
          disabled={!resource.valid || locked} onClick={() => load(`${path === '/' ? '' : path}/${entry.name}`)} />)}
    </div>
    {roleResource.status && <StateNotice kind={roleResource.failed ? 'error' : 'loading'}>{roleResource.status}</StateNotice>}
    {roleResource.failed && <Button disabled={locked}
      onClick={() => void roleResource.refresh()}>重试加载角色</Button>}
    {roleResource.valid && !rolesAvailable && <StateNotice kind="error">所选角色已不可用，请关闭窗口后重新选择。</StateNotice>}
    {!!roleResource.data?.length && <RolePicker roles={roleResource.data} selected={selectedRoles}
      disabled={locked || !roleResource.valid} onChange={setSelectedRoles} />}
    {action.error && <OperationErrorResult label="创建会话" error={action.error} cause={action.errorCause} />}
    {incompleteSessionId && <p>已创建、状态待核对的会话：
      <Button onClick={() => { onCreated(incompleteSessionId); onCancel(); }}>
        {incompleteSessionId}
      </Button>
    </p>}
    </div>
    <div className="dialog-actions ck-actions">
      <Button disabled={action.busy} onClick={onCancel}>取消</Button>
      <Button variant="primary" disabled={!canCreate} onClick={create}>
        {action.busy ? '创建中…' : '创建会话'}
      </Button>
    </div>
  </DirectoryModal>;
}
