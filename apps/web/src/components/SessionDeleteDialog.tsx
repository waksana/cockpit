import { useRef } from 'react';
import { useCockpit } from '../net/store';
import { Dialog } from './Dialog';

export function SessionDeleteDialog({ sessionId, name, onCancel, onSuccess }: {
  sessionId: string; name: string; onCancel: () => void; onSuccess: () => void;
}) {
  const deleteSession = useCockpit(s => s.deleteSession);
  const submitted = useRef(false);
  return <Dialog title="永久删除会话"
    message={`永久删除「${name}」及其 Copilot 会话历史，无法恢复。工作目录、托管文件和外部数据不会删除。`}
    confirmLabel="永久删除" destructive actionKey={`delete:${sessionId}`}
    onConfirm={async () => {
      if (submitted.current) throw new Error('上次删除仍在确认');
      submitted.current = true;
      await deleteSession(sessionId);
    }}
    onSuccess={onSuccess} onCancel={onCancel} />;
}
