import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ToolImage, UploadedFile } from '@cockpit/protocol';
import { createKeyedAsync } from '../lib/keyedAsync';
import { loadToolImage } from '../lib/toolImage';
import { useCockpit } from '../net/store';
import { useKeyedAction } from '../lib/useKeyedResource';
import { getSessionDraft } from '../lib/attachmentSend';
import { FileCard } from './FileCard';

function DecodedImage({ blob, label }: { blob: Blob; label: string }) {
  const [ready, setReady] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    let active = true;
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.src = url;
    void image.decode().then(() => {
      if (active) setReady({ url });
    }, () => {
      if (active) setReady({ error: '图片数据损坏或浏览器不支持解码。' });
      URL.revokeObjectURL(url);
    });
    return () => { active = false; URL.revokeObjectURL(url); };
  }, [blob]);
  if (ready.error) return <span role="alert">{ready.error}</span>;
  if (!ready.url) return <span role="status">正在解码图片…</span>;
  return <a className="attach-image" href={ready.url} target="_blank" rel="noopener noreferrer" title="打开完整图片">
    <img src={ready.url} alt={label} onError={() => setReady({ error: '图片显示失败，请重新打开预览。' })} />
  </a>;
}

function ToolImagePreview({ image, sessionId }: { image: ToolImage; sessionId: string }) {
  const identity = JSON.stringify([sessionId, image.eventId, image.toolCallId, image.part]);
  const resource = useMemo(() => createKeyedAsync<Blob>(identity, useCockpit.getState), [identity]);
  const snapshot = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot);
  const connected = useCockpit(state => state.connState === 'open');
  const generation = useCockpit(state => state.connectionGeneration);
  useLayoutEffect(() => {
    if (connected) resource.activate();
    return () => resource.release();
  }, [resource, connected, generation]);
  const label = `工具图片 ${image.part + 1}`;
  const retain = useKeyedAction(`retain-tool-image:${identity}`);
  const [retained, setRetained] = useState<UploadedFile>();
  const [selection, setSelection] = useState<string>();
  const save = () => {
    const { eventId, toolCallId, part, cursor, count } = image;
    void retain.run(async () => {
      const file = await useCockpit.getState().retainToolImage({
        sessionId, image: { eventId, toolCallId, part, cursor, count },
      });
      setRetained(file);
    });
  };
  const load = () => {
    const { eventId, toolCallId, part, cursor, count } = image;
    void resource.run(signal => loadToolImage({
      sessionId, image: { eventId, toolCallId, part, cursor, count },
    }, signal), undefined, true);
  };
  return <div className="tool-image-preview">
    <span>{label} · {image.mime || '未知格式'}{image.byteLength !== undefined ? ` · ${image.byteLength} B` : ''}</span>
    {image.unavailable ? <span role="status">{image.unavailable}</span> : <>
      {!snapshot.data && <button type="button" disabled={!connected || snapshot.pending} onClick={load}>
        {snapshot.pending ? '正在读取图片…' : snapshot.error ? '重试图片' : '查看图片'}
      </button>}
      {snapshot.error && <span role="alert">{snapshot.error}</span>}
      {snapshot.data && <DecodedImage key={snapshot.dataGeneration} blob={snapshot.data} label={label} />}
      {snapshot.data && <button type="button" onClick={() => { resource.release(); resource.activate(); }}>关闭图片</button>}
      {!retained && <button type="button" disabled={!connected || retain.busy} onClick={save}>
        {retain.busy ? '正在保留…' : '保留到文件'}
      </button>}
      {retain.error && <span role="alert">{retain.error}</span>}
      {retained && <FileCard file={retained} sessionId={sessionId} preview={false} onSelect={() => {
        try {
          setSelection(getSessionDraft(sessionId).addManagedAttachment(retained) ? '已加入本会话草稿。' : '草稿附件已达 20 个，请先移除部分附件。');
        } catch (error) { setSelection(error instanceof Error ? error.message : '无法加入草稿。'); }
      }} />}
      {selection && <span role="status">{selection}</span>}
    </>}
  </div>;
}

export function ToolImages({ images, sessionId }: { images: ToolImage[]; sessionId: string }) {
  return <div className="tool-images">{images.map(image => <ToolImagePreview
    key={JSON.stringify([sessionId, image.eventId, image.toolCallId, image.part])} image={image} sessionId={sessionId}
  />)}</div>;
}
