import { useRef } from 'react';
import { useCockpit } from '../net/store';
import { Dialog } from './Dialog';

export function SessionDeleteDialog({ sessionId, name, onCancel, onSuccess }: {
  sessionId: string; name: string; onCancel: () => void; onSuccess: () => void;
}) {
  const deleteSession = useCockpit(s => s.deleteSession);
  const submitted = useRef(false);
  return <Dialog title="永久删除会话"
    message={`永久删除「${name}」及其 Copilot 会话历史，此操作不可恢复。托管文件、工作目录和外部应用数据不会删除。只执行原生删除，不调用外部业务流程。`}
    confirmLabel="永久删除" destructive actionKey={`delete:${sessionId}`}
    onConfirm={async () => {
      if (submitted.current) throw new Error('删除结果尚未确认，请先核对原生会话状态；不会重复发送。');
      submitted.current = true;
      await deleteSession(sessionId);
    }}
    onSuccess={onSuccess} onCancel={onCancel} />;
}
