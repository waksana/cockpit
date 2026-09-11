import { memo, useCallback, useState } from 'react';
import type { Attachment, UploadedFile } from '@cockpit/protocol';
import { attachmentHref } from '../lib/upload';
import { fileDownloadUrl, filePreview, filesBrowseUrl } from '../lib/managedFile';
import { useKeyedResource } from '../lib/useKeyedResource';
import { useCockpit } from '../net/store';
import { Icon } from './Icon';
import { InternalLink } from './InternalLink';
import { sessionPath } from '../lib/routeOwnership';

type ManagedCardFile = Attachment & Partial<Pick<UploadedFile, 'source' | 'sessionId' | 'sessions' | 'sourceId' | 'sha256' | 'path'>>;
const SOURCE_LABELS = { web: 'Web 上传', mcp: 'AI / MCP 上传', weixin: '微信接收', 'tool-image': '明确保留的工具图片' };

function FileProvenance({ file }: { file: ManagedCardFile }) {
  const sessions = useCockpit(state => state.sessions);
  const associated = file.sessions ?? (file.sessionId ? [file.sessionId] : []);
  return <span className="managed-file-details">
    <span>来源：{file.source ? SOURCE_LABELS[file.source] : '未记录'}</span>
    {associated.map(id => <span key={id}>关联会话：
      <InternalLink href={sessionPath(id)}>{sessions.find(session => session.sessionId === id)?.title || id}</InternalLink>
    </span>)}
    {file.sourceId && <span>来源标识：<code>{file.sourceId}</code></span>}
    {file.sha256 ? <span>原文件 SHA-256：<code>{file.sha256}</code></span> : <span>未记录原文件摘要。</span>}
  </span>;
}

export function FileCard({ file, sessionId, onSelect, preview = true, browse = true }: {
  file: ManagedCardFile; sessionId?: string; onSelect?: () => void; preview?: boolean; browse?: boolean;
}) {
  const href = attachmentHref(file.url);
  const [failed, setFailed] = useState(false);
  const [details, setDetails] = useState(false);
  const kind = preview && !failed ? filePreview(file) : undefined;
  if (!href) return <span className="attach-file">{file.name} · 文件地址无效</span>;
  return <span className="managed-file-card">
    {kind === 'image' && <a className="attach-image" href={href} target="_blank" rel="noopener noreferrer">
      <img src={href} alt={file.name} loading="lazy" onError={() => setFailed(true)} />
    </a>}
    {kind === 'video' && <video controls preload="metadata" src={href} aria-label={file.name} onError={() => setFailed(true)} />}
    <span className="managed-file-meta">
      <Icon name="file" size={20} />
      <a href={fileDownloadUrl(file.url)} download={file.name}>{file.name}</a>
      <span>{file.mime ?? '未知格式'}{file.size !== undefined ? ` · ${file.size} B` : ''}</span>
    </span>
    {failed && <span role="status">浏览器无法预览此文件，请下载原文件。</span>}
    <span className="managed-file-actions">
      <a href={fileDownloadUrl(file.url)} download={file.name}>下载原文件</a>
      {browse && <InternalLink href={filesBrowseUrl(file.url, sessionId)}>浏览文件</InternalLink>}
      {onSelect && <button type="button" onClick={onSelect}>加入草稿</button>}
      {file.path && <button type="button" aria-expanded={details} onClick={() => setDetails(value => !value)}>来源与完整性</button>}
    </span>
    {details && <FileProvenance file={file} />}
  </span>;
}

export const ManagedFileMention = memo(function ManagedFileMention({ url, name, sessionId }: { url: string; name: string; sessionId?: string }) {
  const load = useCallback((signal: AbortSignal) => useCockpit.getState().filesGet(url, signal), [url]);
  const resource = useKeyedResource(`file:${url}`, load);
  return <span className="managed-file-mention">
    <ChatFileCard key={url} file={resource.data ?? { kind: 'file', name, url }} sessionId={sessionId}
      pending={resource.pending} error={resource.error} onRetry={() => void resource.refresh()} />
  </span>;
});

export function PreviewImage({ src, name, title }: { src: string; name: string; title?: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  return <span className="chat-preview-image-shell" data-state={state}>
    {state !== 'failed' && <img src={src} alt={name} title={title} className="chat-preview-image" loading="lazy" decoding="async"
      onLoad={() => setState('ready')} onError={() => setState('failed')} />}
    {state !== 'ready' && <span className="chat-preview-state" role={state === 'failed' ? 'status' : undefined}>
      {state === 'failed' ? '图片无法预览，请查看或下载原文件' : '加载图片…'}
    </span>}
  </span>;
}

// Unknown metadata keeps its initial media-sized slot, even if it resolves to a
// document. Only an already known document can enter with a compact footprint.
export function ChatFileCard({ file, sessionId, preview = true, pending = false, error, onRetry }: {
  file: ManagedCardFile; sessionId?: string; preview?: boolean; pending?: boolean;
  error?: string | null; onRetry?: () => void;
}) {
  const [layout] = useState(() => file.mime && !filePreview(file) ? 'file' : 'media');
  const href = attachmentHref(file.url);
  const problem = error || (!href ? '文件地址无效。' : null);
  const kind = preview && !problem ? filePreview(file) : undefined;
  const detail = href ? filesBrowseUrl(file.url, sessionId) : undefined;
  const description = problem ? `文件信息读取失败：${problem}`
    : pending && !file.mime ? '正在读取文件信息…'
    : `${file.mime ?? '格式待确认'}${file.size !== undefined ? ` · ${file.size} B` : ''}`;
  return <span className="chat-file-card" data-layout={layout} data-file-url={file.url} aria-busy={pending}>
    {layout === 'media' && <span className="chat-file-preview">
      {(kind === 'image' || kind === 'video') && href && detail ? <a href={detail} target="_blank" rel="noopener noreferrer"
        aria-label={`查看${kind === 'image' ? '图片' : '视频'}：${file.name}（新页面）`}>
        {kind === 'image' ? <PreviewImage key={href} src={href} name={file.name} /> : <span className="chat-preview-state">
          <span className="chat-video-play" aria-hidden="true">▶</span>
          <span>视频 · 查看播放 ↗</span>
        </span>}
      </a> : <span className="chat-preview-state">
        <Icon name="file" size={32} />
        <span>{problem ? '文件暂不可用' : pending ? '正在读取文件信息…' : '文件预览'}</span>
      </span>}
    </span>}
    <span className="chat-file-info">
      {!problem && href
        ? <a className="chat-file-name" title={file.name} href={fileDownloadUrl(file.url)} download={file.name}>{file.name}</a>
        : <span className="chat-file-name" title={file.name}>{file.name}</span>}
      <span className="chat-file-description" title={description} role={problem ? 'alert' : undefined}>{description}</span>
      <span className="chat-file-actions">
        {detail && <a href={detail} target="_blank" rel="noopener noreferrer" aria-label={`查看文件详情：${file.name}（新页面）`}>查看详情 ↗</a>}
        {!problem && href && <a href={fileDownloadUrl(file.url)} download={file.name}>下载原文件</a>}
        {problem && onRetry && <button type="button" onClick={onRetry}>重试</button>}
      </span>
    </span>
  </span>;
}
