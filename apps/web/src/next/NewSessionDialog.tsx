import { useCallback, useId, useRef, useState } from 'react';
import { ArrowLeft, Folder } from 'lucide-react';
import {
  Alert, AlertDescription, Button, Checkbox, Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle, Input, Label,
} from '@cockpit/ui';
import type { RoleSelection } from '@cockpit/protocol';
import { useCockpit } from '../net/store';
import { IntentHttpError } from '../net/client';
import { useKeyedAction, useKeyedResource } from '../lib/useKeyedResource';
import { readDirectory } from '../lib/directoryResource';
import { useHostUnsavedChanges } from '../lib/hostLeave';
import { Errors } from './Feedback';
import { useDialogReturnFocus } from './useDialogReturnFocus';

export function NewSessionDialog({ onClose, onCreated }: { onClose(): void; onCreated(id: string): void }) {
  const returnFocus = useDialogReturnFocus();
  const listDir = useCockpit(state => state.listDir);
  const listRoles = useCockpit(state => state.listRoles);
  const [requestedPath, setRequestedPath] = useState<string>();
  const [editedPath, setEditedPath] = useState<string | null>(null);
  const [selected, setSelected] = useState<RoleSelection[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [createdId, setCreatedId] = useState<string>();
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const roles = useKeyedResource('next:create:roles', listRoles);
  const read = useCallback(() => readDirectory(listDir, requestedPath), [listDir, requestedPath]);
  const directory = useKeyedResource(JSON.stringify(['next:directory', requestedPath]), read);
  const action = useKeyedAction(`next:create:${id}`);
  const path = directory.data?.path;
  const edit = editedPath ?? path ?? requestedPath ?? '';
  const locked = submitted || action.busy;
  const rolesAvailable = selected.every(value => roles.data?.some(role =>
    role.moduleId === value.moduleId && role.roleId === value.roleId));
  const canCreate = directory.valid && roles.valid && rolesAvailable && !!path && edit === path
    && selected.length <= 64 && !locked;
  useHostUnsavedChanges(!createdId && (editedPath !== null || requestedPath !== undefined || selected.length > 0));
  const load = (value: string | undefined) => {
    if (locked || !directory.connected) return;
    setEditedPath(null);
    if (value === requestedPath) void directory.refresh();
    else setRequestedPath(value);
  };
  const create = () => {
    if (!canCreate || !path) return;
    let sessionId: string;
    void action.run(async () => {
      setSubmitted(true);
      try { sessionId = await useCockpit.getState().newSession(path, selected.length ? selected : undefined); }
      catch (error) {
        if (error instanceof IntentHttpError && error.sessionId) setCreatedId(error.sessionId);
        throw error;
      }
    }, () => { onCreated(sessionId); onClose(); });
  };
  return <Dialog open onOpenChange={open => { if (!open && !action.busy) onClose(); }}>
    <DialogContent className="next-create-dialog" showCloseButton={!action.busy}
      onCloseAutoFocus={returnFocus}
      aria-busy={action.busy}
      onOpenAutoFocus={event => { event.preventDefault(); heading.current?.focus(); }}
      onEscapeKeyDown={event => { if (action.busy) event.preventDefault(); }}
      onInteractOutside={event => { if (action.busy) event.preventDefault(); }}>
      <DialogHeader><DialogTitle ref={heading} tabIndex={-1} data-next-focus>新建会话</DialogTitle>
        <DialogDescription>选择服务器上的工作目录。创建不会发送消息。</DialogDescription></DialogHeader>
      <div className="next-form-field"><Label htmlFor={`${id}-path`}>工作目录</Label>
        <div className="next-path-row"><Input id={`${id}-path`} value={edit} disabled={locked}
          placeholder="服务器主目录" spellCheck={false} autoCapitalize="off" autoCorrect="off"
          onChange={event => setEditedPath(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault(); load(edit.trim() || undefined);
            }
          }} />
          <Button variant="outline" disabled={locked || directory.pending || !directory.connected}
            onClick={() => load(edit.trim() || undefined)}>前往</Button></div>
      </div>
      {directory.status && <Alert variant={directory.failed ? 'destructive' : 'default'} role={directory.failed ? 'alert' : 'status'}>
        <AlertDescription>{directory.status}</AlertDescription></Alert>}
      <div className="next-directory-list" aria-label="目录">
        {directory.data?.parent && <Button variant="ghost" disabled={!directory.valid || locked}
          onClick={() => load(directory.data?.parent ?? undefined)}><ArrowLeft aria-hidden="true" />上级目录</Button>}
        {directory.data?.entries.filter(entry => entry.isDir).map(entry => <Button key={entry.name} variant="ghost"
          disabled={!directory.valid || locked} onClick={() => load(`${path === '/' ? '' : path}/${entry.name}`)}>
          <Folder aria-hidden="true" /><span>{entry.name}</span>
        </Button>)}
        {directory.valid && !directory.data?.entries.some(entry => entry.isDir) && <p>没有子目录。</p>}
      </div>
      <fieldset className="next-role-options" disabled={locked}>
        <legend>模块角色（可选）</legend>
        {roles.status && <p role={roles.failed ? 'alert' : 'status'}>{roles.status}</p>}
        {roles.failed && <Button variant="outline" disabled={locked || !roles.connected || roles.pending}
          onClick={() => { void roles.refresh(); }}>重新读取角色</Button>}
        {roles.data?.map((role, index) => {
          const checked = selected.some(value => value.moduleId === role.moduleId && value.roleId === role.roleId);
          return <div key={`${role.moduleId}/${role.roleId}`} className="next-role-option">
            <Checkbox id={`${id}-role-${index}`} checked={checked} disabled={locked || !roles.valid}
              aria-describedby={role.description ? `${id}-description-${index}` : undefined}
              onCheckedChange={value => setSelected(previous => value === true
                ? [...previous, { moduleId: role.moduleId, roleId: role.roleId }]
                : previous.filter(item => item.moduleId !== role.moduleId || item.roleId !== role.roleId))} />
            <div><Label htmlFor={`${id}-role-${index}`}>{role.name} · {role.moduleName}</Label>
              {role.description && <p id={`${id}-description-${index}`}>{role.description}</p>}</div>
          </div>;
        })}
        {!rolesAvailable && <p role="alert">所选角色已不可用，请关闭后重新选择。</p>}
        {selected.length > 64 && <p role="alert">每次最多选择 64 个角色。</p>}
      </fieldset>
      <p className="next-muted">角色选择不代表能力就绪。空会话在卸载后可能消失；不会自动重建。</p>
      {action.error && <Alert variant="destructive"><AlertDescription>
        创建结果未完整确认：{action.error}。请核对原生会话列表，不会重复创建。
      </AlertDescription></Alert>}
      {createdId && <Button variant="outline" onClick={() => { onCreated(createdId); onClose(); }}>
        打开已确认创建的会话：{createdId}
      </Button>}
      <Errors />
      <DialogFooter><Button variant="outline" disabled={action.busy} onClick={onClose}>取消</Button>
        <Button disabled={!canCreate && !submitted} aria-disabled={!canCreate || undefined} aria-busy={action.busy}
          onClick={create}>{action.busy ? '创建中…' : '创建会话'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
