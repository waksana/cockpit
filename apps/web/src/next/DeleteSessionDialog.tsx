import { useRef, useState } from 'react';
import {
  Alert, AlertDescription, AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@cockpit/ui';
import { useKeyedAction } from '../lib/useKeyedResource';
import { useCockpit } from '../net/store';
import { Errors } from './Feedback';
import { useDialogReturnFocus } from './useDialogReturnFocus';

export function DeleteSessionDialog({ sessionId, name, onClose, onDeleted }: {
  sessionId: string; name: string; onClose(): void; onDeleted(): void;
}) {
  const returnFocus = useDialogReturnFocus();
  const action = useKeyedAction(`next:delete:${sessionId}`);
  const submitted = useRef(false);
  const [attempted, setAttempted] = useState(false);
  const confirm = () => {
    if (submitted.current || action.busy || !action.connected) return;
    submitted.current = true;
    setAttempted(true);
    void action.run(() => useCockpit.getState().deleteSession(sessionId), () => { onDeleted(); onClose(); });
  };
  return <AlertDialog open onOpenChange={open => { if (!open && !action.busy) onClose(); }}>
    <AlertDialogContent aria-busy={action.busy} onCloseAutoFocus={returnFocus}
      onEscapeKeyDown={event => { if (action.busy) event.preventDefault(); }}>
      <AlertDialogHeader><AlertDialogTitle tabIndex={-1} data-next-focus>永久删除会话</AlertDialogTitle>
        <AlertDialogDescription>永久删除「{name}」及其 Copilot 会话历史，此操作不可恢复。
          不会删除工作目录、托管文件或外部应用数据，也不会执行外部业务流程。</AlertDialogDescription></AlertDialogHeader>
      {action.error && <Alert variant="destructive"><AlertDescription>
        删除结果未确认：{action.error}。请先核对原生会话状态；不会重复发送。
      </AlertDescription></Alert>}
      {!action.connected && <p role="status">等待连接。已提交操作不会自动重试。</p>}
      <Errors />
      <AlertDialogFooter><AlertDialogCancel disabled={action.busy}>取消</AlertDialogCancel>
        <AlertDialogAction variant="destructive" disabled={!action.connected}
          aria-disabled={action.busy || attempted || undefined} aria-busy={action.busy}
          onClick={event => { event.preventDefault(); confirm(); }}>{action.busy ? '处理中…' : '永久删除'}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
