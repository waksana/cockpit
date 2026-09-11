import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import type { Attachment, ChatMessage, UploadedFile } from '@cockpit/protocol';
import { Thread } from '../components/Thread';
import { FileCard } from '../components/FileCard';
import { ChatHeader } from '../components/ChatHeader';
import { ModeMenu } from '../components/ModeMenu';
import { AnchoredMenu } from '../components/AnchoredMenu';
import { sessionActionItems } from '../lib/sessionActions';
import { UxErrorNotifications } from '../components/UxErrorNotifications';
import { getSessionDraft } from '../lib/attachmentSend';
import { useCockpit } from '../net/store';
import { fixtureSession, labFiles, scenarios, type Scenario } from './chat-fixtures';
import '../styles/index.scss';
import '../components/UxErrorNotifications.scss';
import './chat-lab.scss';

if (!import.meta.env.DEV || import.meta.env.COCKPIT_CHAT_LAB !== true) {
  throw new Error('Start the isolated chat lab with COCKPIT_CHAT_LAB=1.');
}

class FixtureSpeechRecognition {
  onresult?: (event: { resultIndex: number; results: { isFinal: boolean; 0: { transcript: string } }[] }) => void;
  onerror?: (event: { error: string }) => void;
  onend?: () => void;
  start() {
    fixtureSpeech = {
      transcribe: () => this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: '合成语音转写，不采集麦克风。' } }] }),
      fail: () => this.onerror?.({ error: 'Synthetic speech failure; no microphone used.' }),
    };
  }
  stop() { fixtureSpeech = null; this.onend?.(); }
}
let fixtureSpeech: { transcribe: () => void; fail: () => void } | null = null;
Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: FixtureSpeechRecognition });

// No App/ConnectedThread/init: these are synthetic component inputs, never
// registered sessions or a substitute native store. Unhandled HTTP is rejected
// by the opt-in Vite lab server as well.
useCockpit.setState({
  connState: 'open',
  speechToken: async () => ({ enabled: false }),
  filesGet: async (url, signal) => {
    if (url === '/uploads/lab-pending.txt') {
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) reject(new DOMException('Aborted', 'AbortError'));
        else signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }
    const file = labFiles.find(file => file.url === url);
    if (!file) throw new Error('Synthetic metadata unavailable. Retry is explicit.');
    return file;
  },
});

export function Lab() {
  const query = new URLSearchParams(location.search);
  const initial = scenarios.find(([id]) => id === query.get('scene'))?.[0] ?? 'all';
  const [scenario, setScenario] = useState<Scenario>(initial);
  const [session, setSession] = useState(() => fixtureSession(initial));
  const [receipt, setReceipt] = useState('仅合成输入；无原生会话、无后端连接。');
  const [fail, setFail] = useState(false);
  const [hold, setHold] = useState(false);
  const pending = useRef<(() => void)[]>([]);
  const generation = useRef(0);
  const counter = useRef(0);
  const historyBusy = useRef(false);
  const modeRef = useRef<HTMLButtonElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [modeOpen, setModeOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const draft = getSessionDraft(session.sessionId);
  const detail = labFiles.find(file => file.url === query.get('url'));

  useEffect(() => () => { generation.current++; pending.current.splice(0).forEach(resolve => resolve()); }, []);

  function choose(value: Scenario) {
    generation.current++;
    pending.current.splice(0).forEach(resolve => resolve());
    historyBusy.current = false;
    setModeOpen(false);
    setMoreOpen(false);
    setScenario(value);
    setSession(fixtureSession(value));
    history.replaceState(null, '', `/chat-lab.html?scene=${value}`);
    setReceipt(`场景：${value}。操作不会发送到后端。`);
  }
  async function action(label: string, apply: () => void): Promise<boolean> {
    const owner = generation.current;
    if (hold) await new Promise<void>(resolve => pending.current.push(resolve));
    if (owner !== generation.current) return false;
    setReceipt(`${fail ? '模拟失败' : '组件回调'}：${label}`);
    if (fail) throw new Error(`Synthetic ${label} failure; no request was sent.`);
    apply();
    return true;
  }
  function append(text: string, role: ChatMessage['role'] = 'assistant', attachments?: Attachment[], subtype?: ChatMessage['subtype']) {
    setSession(value => ({ ...value, messages: [...value.messages, {
      id: `lab-add-${++counter.current}`, role, content: text, timestamp: Date.now(), attachments, subtype,
    }] }));
  }
  const loadMore = useCallback(() => {
    if (historyBusy.current) return;
    historyBusy.current = true;
    const owner = generation.current;
    setSession(value => ({ ...value, loadingHistory: true }));
    window.setTimeout(() => {
      if (generation.current !== owner) return;
      setSession(value => ({ ...value, loadingHistory: false, materialized: true, hasMore: false,
        messages: [...Array.from({ length: 6 }, (_, i): ChatMessage => ({
          id: `older-${i}`, role: i % 2 ? 'assistant' : 'user',
          content: `更早的消息 ${i + 1}。保留当前可见消息的位置。\n\n这是用于历史插入的合成内容。`,
          timestamp: new Date('2026-09-10T09:30:00').getTime() + i * 60_000,
        })), ...value.messages],
      }));
      setReceipt('一次有界合成历史插入；未读取真实历史。');
      historyBusy.current = false;
    }, 900);
  }, [setSession, setReceipt]);
  const upload = async (file: File): Promise<UploadedFile> => {
    const owner = generation.current;
    await new Promise<void>(resolve => { if (hold) pending.current.push(resolve); else window.setTimeout(resolve, 900); });
    if (owner !== generation.current) throw new Error('Fixture changed during upload.');
    if (fail) throw new Error('Synthetic upload failure. Explicit retry only.');
    setReceipt(`暂存 ${file.name}；未上传或发送原文件。`);
    const base = labFiles[file.type.startsWith('image/') ? 0 : file.type.startsWith('video/') ? 1 : 2];
    return { ...base, name: file.name, size: file.size };
  };
  if (detail) return <div className="lab-file-detail">
    <h1>隔离文件详情</h1><p>同一生产 FileCard；合成文件，不访问托管库。</p>
    <FileCard file={detail} browse={false} />
    <a href="/chat-lab.html?scene=attachments">回到组件场景</a>
  </div>;
  return <div className="chat-lab">
    <header className="lab-toolbar">
      <strong>Chat / 组件场景</strong>
      <label>场景 <select value={scenario} onChange={e => choose(e.target.value as Scenario)}>
        {scenarios.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
      </select></label>
      <label><input type="checkbox" checked={fail} onChange={e => setFail(e.target.checked)} />模拟失败</label>
      <label><input type="checkbox" checked={hold} onChange={e => setHold(e.target.checked)} />保持请求中</label>
      <button onClick={() => pending.current.splice(0).forEach(resolve => resolve())}>释放结果</button>
      <button onClick={() => {
        const connected = useCockpit.getState().connState === 'open';
        useCockpit.setState({ connState: connected ? 'connecting' : 'open' });
        setReceipt(connected ? '连接关闭（合成）' : '连接打开（合成）');
      }}>切换连接</button>
      <button onClick={() => {
        draft.edit('一段保留的草稿。');
        void draft.addAttachments([new File(['synthetic'], 'review.txt', { type: 'text/plain' })], upload);
      }}>暂存样例</button>
      <button onClick={() => append('新消息到达。正在上翻时应显示新消息入口，不应强跳。')}>追加消息</button>
      <button onClick={() => setSession(value => ({ ...value, messages: value.messages.map((m, i) => i === value.messages.length - 1
        ? { ...m, content: `${m.content}更加清楚。流式增量也不应打断上翻阅读。` } : m) }))}>流式一步</button>
      <button onClick={() => setSession(value => ({ ...value, status: 'idle', compacting: false, intent: null }))}>结束回合</button>
      <button onClick={loadMore}>插入历史 / 完成加载</button>
      <button onClick={() => choose(scenario)}>重置场景</button>
      <button onClick={() => fixtureSpeech?.transcribe()}>模拟转写</button>
      <button onClick={() => fixtureSpeech?.fail()}>语音错误</button>
    </header>
    <output className="lab-receipt" aria-live="polite">{receipt}</output>
    <div className="lab-stage">
      <ChatHeader title={`${session.title} · 长标题与会话入口边界`} modelLabel="Synthetic model · no native connection" mode={session.currentMode}
        modeRef={modeRef} moreRef={moreRef} modeOpen={modeOpen} moreOpen={moreOpen}
        onBack={() => setReceipt('返回入口回调（导航不在此场景内执行）。')}
        onInfo={() => setReceipt('会话信息入口回调（会话管理面板不在本次精修范围）。')}
        onMode={() => setModeOpen(value => !value)} onMore={() => setMoreOpen(true)} />
      <Thread key={scenario} session={session} uploadFile={upload} readOnly={scenario === 'readonly'}
        onLoadMore={loadMore}
        onRetryHistory={() => {
          setReceipt('显式重读回调；未发出网络请求。');
          setSession(value => ({ ...value, historyError: undefined, error: null, historyStale: false, partialHistory: false, incompleteBoundary: false, materialized: true }));
        }}
        onSend={(text, attachment, attachments) => action('发送', () => append(text, 'user', attachments ?? (attachment ? [attachment] : undefined)))}
        onRespondAsk={(id, answer, freeform) => action(`${id} / ${answer} / freeform=${freeform}`, () => {
          setSession(value => ({ ...value, ask: null })); append(answer, 'user', undefined, 'ask-reply');
        })}
        onRespondPlan={(id, answer) => action(`${id} / ${answer}`, () => setSession(value => ({ ...value, planRequest: null })))}
        onPlanSupersede={(id, text) => action(`${id} / 新指令`, () => {
          setSession(value => ({ ...value, planRequest: null })); append(text, 'user');
        })}
        onRespondElicitation={(id, answer) => action(`${id} / ${answer}`, () => setSession(value => ({ ...value, elicitation: null })))}
        onRemoveQueued={id => { setReceipt(`移除队列项：${id}`); setSession(value => ({ ...value, queue: value.queue?.filter(q => q.id !== id) })); }}
        onCancel={() => { setReceipt('停止回调：清空队列；没有中断任何真实工作。'); setSession(value => ({ ...value, status: 'idle', queue: [] })); append('本次执行已取消（合成记录）。', 'system'); }}
        onInterrupt={async () => {
          await action('打断并保留队列', () => setSession(value => ({ ...value, status: 'idle' })));
          return { ok: true, interrupted: true };
        }}
      />
      {modeOpen && <ModeMenu triggerRef={modeRef} current={session.currentMode ?? null} running={session.status === 'running'}
        onClose={() => setModeOpen(false)} onPick={mode => { setReceipt(`模式回调：${mode}`); setSession(value => ({ ...value, currentMode: mode })); }} />}
      {moreOpen && <AnchoredMenu triggerRef={moreRef} label={session.title} onClose={() => setMoreOpen(false)}
        items={sessionActionItems(session, true, {
          openPanel: (_id, panel) => setReceipt(`面板入口：${panel ?? 'info'}（管理面板不在本次精修范围）。`),
          fork: () => setReceipt('分叉入口回调；没有创建会话。'),
          pin: () => setReceipt('置顶入口回调；没有修改产品数据。'),
          delete: () => setReceipt('删除入口回调；没有调用原生删除。'),
        })} />}
    </div>
    <UxErrorNotifications />
  </div>;
}

createRoot(document.getElementById('root')!).render(<BrowserRouter><Lab /></BrowserRouter>);
