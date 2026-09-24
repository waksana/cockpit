import type { RefObject } from 'react';
import type { ChatMessage, ChatSession } from '../../net/types';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { StateNotice } from '../../components/StateNotice';
import { RegionErrorBoundary } from '../../components/ErrorBoundary';
import { TranscriptMessages } from '../../components/Transcript';

// The scrollable transcript: history state, rows and the return-to-latest badge.
// The refs belong to the Thread scroll owner.
export function ThreadTranscript({ session, messages, scrollRef, contentRef, awayFromBottom, hasNewContent, onFollow, onRetryHistory }: {
  session: ChatSession; messages: ChatMessage[];
  scrollRef: RefObject<HTMLDivElement | null>; contentRef: RefObject<HTMLDivElement | null>;
  awayFromBottom: boolean; hasNewContent: boolean; onFollow: () => void; onRetryHistory?: () => void;
}) {
  return (
    <div className="chat-transcript">
      <div ref={scrollRef} className="chat-messages" tabIndex={0} aria-label="对话消息" aria-busy={session.loadingHistory}>
        <div ref={contentRef} className="chat-message-content">
          <HistoryControls session={session} onFollow={onFollow} onRetryHistory={onRetryHistory} />
          <div className="chat-message-rows">
            {session.messages.length === 0 && session.materialized && !session.historyStale && !session.loadingHistory && !session.hasMore && (
              <div className="chat-empty-hint"><Icon name="newchat" size={28} />
                <strong>开始对话</strong><span>输入消息开始讨论。</span><code>{session.cwd}</code></div>
            )}
            <RegionErrorBoundary label="对话记录" resetKey={messages}>
              <TranscriptMessages messages={messages} sessionId={session.sessionId}
                liveId={session.status === 'running' ? session.messages.at(-1)?.id : undefined}
                today={new Date().setHours(0, 0, 0, 0)} />
            </RegionErrorBoundary>
          </div>
        </div>
      </div>

      {awayFromBottom && (
        <Button className="new-msg-badge" onClick={onFollow}>
          {hasNewContent ? '有新内容 · 回到最新' : '回到最新'}
        </Button>
      )}
    </div>
  );
}

function HistoryControls({ session, onFollow, onRetryHistory }: {
  session: ChatSession; onFollow: () => void; onRetryHistory?: () => void;
}) {
  return (
    <div className="chat-history-controls">
      {(!session.materialized || session.hasMore) && <StateNotice className="chat-history-loading">
        加载更早的消息…
      </StateNotice>}
      <div className="chat-history-actions">
        {session.loadingHistory ? null : session.historyStale || !session.materialized ? (
          <StateNotice className="chat-loading-older" kind={session.historyError ? 'error' : 'info'}>
            {session.historyError ? `历史加载失败：${session.historyError}` : '对话历史尚未同步。'}
            {onRetryHistory && <Button className="chat-history-retry" onClick={() => {
              onFollow();
              onRetryHistory();
            }}>
              重新读取最新历史
            </Button>}
          </StateNotice>
        ) : session.historyError ? <StateNotice className="chat-loading-older" kind="error">
          历史加载失败：{session.historyError}
          {onRetryHistory && <Button className="chat-history-retry" onClick={onRetryHistory}>重试加载历史</Button>}
        </StateNotice> : null}
      </div>
      {session.partialHistory && <p className="chat-history-note" role="status">
        断线期间的临时片段可能不完整；已保留现有文字，以保存后的完整消息为准。
      </p>}
      {session.incompleteBoundary && !session.hasMore && <p className="chat-history-note">
        部分工具记录缺少对应的发起消息，现有历史无法补齐。
      </p>}
    </div>
  );
}
