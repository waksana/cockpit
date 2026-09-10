import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { IntentResult, UploadedFile } from '@cockpit/protocol';
import { useCockpit } from '../net/store';
import { useKeyedResource } from '../lib/useKeyedResource';
import { getSessionDraft } from '../lib/attachmentSend';
import { uploadFile } from '../lib/upload';
import { filePreview, managedUploadPath } from '../lib/managedFile';
import { useUp } from '../lib/nav';
import { sessionPath } from '../lib/routeOwnership';
import { FileCard } from '../components/FileCard';
import { Icon } from '../components/Icon';

function FileDetail({ url, sessionId, onSelect, revision }: {
  url: string; sessionId?: string; onSelect: (file: UploadedFile) => void; revision: number;
}) {
  const load = useCallback((signal: AbortSignal) => useCockpit.getState().filesGet(url, signal), [url]);
  const resource = useKeyedResource(`files-detail:${url}`, load, revision);
  return <section className="files-detail" aria-label="文件详情">
    {resource.status && <p role={resource.error ? 'alert' : 'status'}>{resource.status}</p>}
    {resource.error && <button type="button" onClick={() => void resource.refresh()}>重试</button>}
    {resource.data && !resource.error && <FileCard file={resource.data} sessionId={sessionId}
      onSelect={sessionId ? () => onSelect(resource.data!) : undefined} browse={false} />}
  </section>;
}

export function FileEntries({ page, sessionId, onSelect }: {
  page: IntentResult<'files/list'>; sessionId?: string; onSelect: (file: UploadedFile) => void;
}) {
  return <>
    {!page.files.length && !page.errors?.length && <div className="files-empty">
      <span className="files-empty-icon"><Icon name="folder" size={36} /></span>
      <h3>没有匹配文件</h3>
      <p>试试其他文件名或会话范围，也可以上传一个新文件。</p>
    </div>}
    <div className="files-grid">
      {page.files.map(file => <article key={file.url} className="files-tile">
        <div className="files-tile-caption">
          <span>{filePreview(file) === 'image' ? '图片' : filePreview(file) === 'video' ? '视频' : '文件'}</span>
          {file.createdAt !== undefined && <time dateTime={new Date(file.createdAt).toISOString()}>
            {new Date(file.createdAt).toLocaleDateString()}
          </time>}
        </div>
        {!filePreview(file) && <div className="files-document-preview" aria-hidden="true"><Icon name="file" size={42} /></div>}
        <FileCard file={file} sessionId={sessionId} onSelect={sessionId ? () => onSelect(file) : undefined} />
      </article>)}
      {page.errors?.map(entry => <article key={`unavailable:${entry.url}`} className="managed-file-card" role="status" aria-label="文件不可用">
        <strong>文件不可用</strong>
        <p><code>{entry.url}</code></p>
        <p>{entry.error}</p>
      </article>)}
    </div>
  </>;
}

function FileSearch({ query, onSearch }: { query: string; onSearch: (query: string) => void }) {
  const [search, setSearch] = useState(query);
  return <form className="files-search" role="search" onSubmit={event => { event.preventDefault(); onSearch(search.trim()); }}>
    <Icon name="search" size={22} />
    <input type="search" aria-label="搜索文件" placeholder="搜索文件名…" value={search} onChange={event => setSearch(event.target.value)} />
    {search && <button className="btn-icon rp" type="button" aria-label="清空搜索"
      onClick={() => { setSearch(''); onSearch(''); }}><Icon name="close" size={18} /></button>}
    <button className="files-search-submit" type="submit">搜索</button>
  </form>;
}

export function Files() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const up = useUp();
  const backRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sessions = useCockpit(state => state.sessions);
  const sessionId = params.get('sessionId') ?? '';
  const validSession = sessions.some(session => session.sessionId === sessionId);
  const onlySession = params.get('scope') === 'session' && validSession;
  const query = params.get('query') ?? '';
  const offsetValue = Number(params.get('offset') ?? 0);
  const offset = Number.isSafeInteger(offsetValue) && offsetValue >= 0 ? offsetValue : 0;
  const selectedUrl = params.get('url');
  const url = managedUploadPath(selectedUrl ?? undefined);
  const previousSelection = useRef(selectedUrl);
  const enteredFromList = useRef(false);
  useLayoutEffect(() => {
    if (selectedUrl !== previousSelection.current) {
      enteredFromList.current = Boolean(selectedUrl && !previousSelection.current);
      previousSelection.current = selectedUrl;
    }
    backRef.current?.focus();
  }, [selectedUrl]);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState<string>();
  const [upload, setUpload] = useState<{ file: File; pending: boolean; error?: string }>();
  const uploadPending = useRef(false);
  const filterSessionId = onlySession ? sessionId : undefined;
  const load = useCallback((signal: AbortSignal) => useCockpit.getState().filesList({
    query, offset, limit: 30, ...(filterSessionId ? { sessionId: filterSessionId } : {}),
  }, signal), [query, offset, filterSessionId]);
  const resource = useKeyedResource(`files:${query}:${offset}:${filterSessionId ?? 'all'}`, load, revision, !selectedUrl);

  function change(values: Record<string, string | undefined>, replace = true) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next, { replace });
  }
  function select(file: UploadedFile) {
    if (!validSession) { setNotice('请选择一个现有会话。'); return; }
    try {
      if (getSessionDraft(sessionId).addManagedAttachment(file)) navigate(sessionPath(sessionId));
      else setNotice('该会话已暂存 20 个附件，请先移除部分附件。');
    } catch (error) { setNotice(error instanceof Error ? error.message : '无法选择文件。'); }
  }
  async function sendUpload(file: File) {
    if (uploadPending.current) return;
    uploadPending.current = true;
    setUpload({ file, pending: true });
    setNotice(undefined);
    try {
      await uploadFile(file, validSession ? sessionId : undefined);
      setUpload(undefined);
      setNotice(`已上传「${file.name}」。文件已保留，可搜索或刷新后选择。`);
      setRevision(value => value + 1);
    } catch (error) {
      setUpload({ file, pending: false, error: error instanceof Error ? error.message : '上传失败。' });
    } finally { uploadPending.current = false; }
  }
  return <main className="files-page" aria-label="文件管理">
    <header className="manage-header">
      <button ref={backRef} className="btn-icon rp" type="button"
        aria-label={selectedUrl ? '返回文件列表' : '返回会话列表'}
        onClick={() => selectedUrl
          ? enteredFromList.current ? navigate(-1) : change({ url: undefined })
          : up('/')}>
        <Icon name="back" size={24} />
      </button>
      <h1 className="manage-title">{selectedUrl ? '文件详情' : '文件'}</h1>
      <button className="btn-icon rp manage-action" type="button" aria-label="刷新" disabled={resource.pending}
        onClick={() => setRevision(value => value + 1)}><Icon name="reload" size={20} /></button>
    </header>
    <div className="files-scroll scrollable">
    <div className="files-content">
      {!selectedUrl && <section className="files-intro" aria-label="文件库">
        <span className="files-intro-icon"><Icon name="folder" size={30} /></span>
        <div className="files-intro-copy">
          <h2>你的文件，都在这里</h2>
          <p>图片、视频与文档，保留原件，随时取用。</p>
        </div>
        <input ref={fileRef} type="file" hidden disabled={upload?.pending} aria-label="选择上传文件" onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void sendUpload(file);
        }} />
        <button className="files-upload rp" type="button" disabled={upload?.pending} onClick={() => fileRef.current?.click()}>
          <Icon name={upload?.pending ? 'sending' : 'attach'} size={20} />
          {upload?.pending ? '上传中…' : '上传文件'}
        </button>
      </section>}
      <section className={`files-toolbar${selectedUrl ? ' files-toolbar-detail' : ''}`} aria-label="查找与选择">
        {!selectedUrl && <FileSearch key={query} query={query} onSearch={value => change({ query: value, offset: undefined })} />}
        <div className="files-session-picker">
          <label htmlFor="files-target-session">选择到会话</label>
          <div className="files-select">
          <Icon name="newchat" size={20} />
          <select id="files-target-session" value={sessionId} onChange={event => change({
            sessionId: event.target.value, scope: event.target.value ? params.get('scope') ?? undefined : undefined,
            offset: onlySession ? undefined : params.get('offset') ?? undefined,
          })}>
            <option value="">仅浏览，不加入会话</option>
            {sessionId && !validSession && <option value={sessionId} disabled>会话不可用</option>}
            {sessions.map(session => <option key={session.sessionId} value={session.sessionId}>{session.title || session.sessionId}</option>)}
          </select>
          <Icon name="down" size={16} />
          </div>
        </div>
        <div className="files-toolbar-footer">
          {!selectedUrl && <div className="files-scope" role="group" aria-label="文件范围">
            <button type="button" aria-pressed={!onlySession} onClick={() => change({ scope: undefined, offset: undefined })}>全部文件</button>
            <button type="button" aria-pressed={onlySession} disabled={!validSession} title="仅显示此会话关联文件"
              onClick={() => change({ scope: 'session', offset: undefined })}>此会话</button>
          </div>}
          <span>{validSession ? '点击「加入草稿」，不会立即发送。' : '选择会话后，可将文件加入草稿。'}</span>
        </div>
      </section>
      {!selectedUrl && <p className="files-retention"><Icon name="check" size={16} />长期保留 · 单个文件最多 25 MiB · 不自动收集工具图片</p>}
      {upload && <p className="files-notice" role={upload.error ? 'alert' : 'status'}>
        {upload.file.name} · {upload.pending ? '上传中…' : upload.error}
        {upload.error && <button type="button" onClick={() => void sendUpload(upload.file)}>重试上传</button>}
      </p>}
      {notice && <p className="files-notice" role="status">{notice}</p>}
      {selectedUrl && !url && <p className="files-notice" role="alert">文件地址无效。</p>}
      {url && <FileDetail key={url} url={url} sessionId={validSession ? sessionId : undefined} onSelect={select} revision={revision} />}
      {!selectedUrl && resource.status && <p role={resource.error ? 'alert' : 'status'}>{resource.status}</p>}
      {!selectedUrl && resource.error && <button type="button" onClick={() => void resource.refresh()}>重试列表</button>}
      {!selectedUrl && resource.data && !resource.error && <>
        <div className="files-results-heading">
          <h2>{onlySession ? '此会话的文件' : query ? '搜索结果' : '全部文件'}</h2>
          <span>本页 {resource.data.files.length} 个文件</span>
        </div>
        <FileEntries page={resource.data} sessionId={validSession ? sessionId : undefined} onSelect={select} />
        <nav className="files-pagination" aria-label="文件分页">
          {offset > 0 && <button type="button" onClick={() => change({ offset: String(Math.max(0, offset - 30)) })}>上一页</button>}
          {resource.data.hasMore && <button type="button" onClick={() => change({ offset: String(resource.data!.nextOffset ?? offset + 30) })}>下一页</button>}
        </nav>
      </>}
    </div>
    </div>
  </main>;
}
