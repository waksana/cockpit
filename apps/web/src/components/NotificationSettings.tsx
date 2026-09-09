import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PushDelivery } from '@cockpit/protocol';
import type { NotificationSettingsState } from '../lib/notificationSettings';
import { useModalFocus } from '../lib/useModalFocus';
import './NotificationSettings.scss';

export interface NotificationSettingsProps {
  state: NotificationSettingsState;
  onRefresh: () => Promise<void>;
  onEnable: () => Promise<void>;
  onDisable: () => Promise<void>;
  onTest: (confirm: true) => Promise<void>;
  onClose: () => void;
}

const permissionLabels: Record<NotificationPermission, string> = {
  default: '尚未授权',
  granted: '已允许',
  denied: '已拒绝',
};

const deliveryLabels: Record<PushDelivery['status'], string> = {
  accepted: '推送服务已接受，仍需确认设备收到',
  failed: '推送请求失败，请稍后重试',
  expired: '推送订阅已过期，请重新启用通知',
};

function controllerHandlesError() {
  // Only the controller's sanitized state is displayed, never callback errors.
}

export function NotificationSettings({
  state, onRefresh, onEnable, onDisable, onTest, onClose,
}: NotificationSettingsProps) {
  const identity = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  useModalFocus(cardRef);
  const [testConfirmed, setTestConfirmed] = useState(false);
  const [showDeviceState, setShowDeviceState] = useState(false);
  const canEnable = !state.busy && state.supported && state.permission !== 'denied'
    && state.configured !== false && !state.ready;
  // Public state cannot expose every stale endpoint or failed local unsubscribe.
  const canDisable = !state.busy;
  const canTest = state.ready && !state.busy && state.supported && state.configured === true
    && state.registered === true && state.permission === 'granted';

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const dialog = (
    <div className="dialog-scrim notification-settings-scrim" onPointerDown={onClose}>
      <div
        ref={cardRef}
        className="dialog-card notification-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${identity}-title`}
        aria-describedby={`${identity}-description`}
        aria-busy={state.busy}
        tabIndex={-1}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="notification-settings-header">
          <h3 id={`${identity}-title`} className="dialog-title">通知设置</h3>
          <button type="button" className="dialog-btn rp" onClick={onClose}>关闭</button>
        </header>
        <p id={`${identity}-description`} className="dialog-message" role="status">
          {state.ready ? '当前设备推送已就绪' : '当前设备推送未就绪'}
          {state.disabled && ' · 本设备已停用'}
        </p>
        {!state.supported && (
          <p className="dialog-message">需要支持推送的安全浏览器环境；iPhone / iPad 需从主屏幕打开。</p>
        )}
        {state.permission === 'denied' && (
          <p className="dialog-message">通知权限已拒绝。请在浏览器或系统设置中允许通知，再刷新状态。</p>
        )}
        {state.configured === false && (
          <p className="dialog-message">服务端未配置推送，无法启用或测试。请联系管理员配置后刷新。</p>
        )}
        {state.permission === 'default' && <p className="dialog-message">通知权限尚未授权。</p>}
        {state.configured === null && <p className="dialog-message">服务端推送配置未知，请刷新状态。</p>}
        {state.registered === null && <p className="dialog-message">当前设备订阅状态未知。</p>}
        {state.registered === false && <p className="dialog-message">当前设备尚未注册推送订阅。</p>}
        <div role="status" aria-live="polite" aria-atomic="true">
          {state.busy && <p className="dialog-message">处理中…仍可关闭此窗口。</p>}
          {state.message && <p className="dialog-message">{state.message}</p>}
        </div>
        {state.error && <p className="dialog-message notification-settings-error" role="alert">{state.error}</p>}
        <div className="dialog-actions">
          <button type="button" className="dialog-btn rp" aria-disabled={state.busy}
            onClick={() => { if (!state.busy) void onRefresh().catch(controllerHandlesError); }}>
            刷新状态
          </button>
          <button type="button" className="dialog-btn rp" aria-disabled={!canDisable}
            onClick={() => { if (canDisable) void onDisable().catch(controllerHandlesError); }}>
            停用通知
          </button>
          <button type="button" className="dialog-btn primary rp" aria-disabled={!canEnable}
            onClick={() => { if (canEnable) void onEnable().catch(controllerHandlesError); }}>
            启用通知
          </button>
        </div>
        {/* Use the existing focusable button primitive: the modal trap does not include native summary elements. */}
        <button type="button" className="dialog-btn notification-settings-details rp"
          aria-expanded={showDeviceState} aria-controls={`${identity}-device-state`}
          onClick={() => setShowDeviceState((open) => !open)}>设备状态</button>
        <div id={`${identity}-device-state`} hidden={!showDeviceState}>
          <dl className="notification-settings-status">
            <div><dt>浏览器支持</dt><dd>{state.supported ? '支持' : '不支持'}</dd></div>
            <div><dt>主屏幕应用</dt><dd>{state.installed ? '已安装并打开' : '未以主屏幕应用打开'}</dd></div>
            <div><dt>通知权限</dt><dd>{permissionLabels[state.permission]}</dd></div>
            <div><dt>设备通知偏好</dt><dd>{state.disabled ? '已停用（存储失败时仅当前页面）' : '未停用'}</dd></div>
            <div><dt>后端推送配置</dt><dd>{state.configured === null ? '未知' : state.configured ? '已配置' : '未配置'}</dd></div>
            <div><dt>当前设备订阅</dt><dd>{state.registered === null ? '未知' : state.registered ? '已注册' : '未注册'}</dd></div>
            <div><dt>推送状态</dt><dd>{state.ready ? '已就绪' : '未就绪'}</dd></div>
            <div><dt>最近传输结果</dt><dd>{state.lastDelivery ? deliveryLabels[state.lastDelivery.status] : '暂无记录'}</dd></div>
          </dl>
        </div>
        <div className="notification-settings-test">
          <p className="dialog-message">服务接受不代表设备已收到。</p>
          {state.lastDelivery && <p className="dialog-message" role="status">{deliveryLabels[state.lastDelivery.status]}</p>}
          <label>
            <input type="checkbox" checked={testConfirmed} aria-disabled={!canTest}
              onChange={(event) => { if (canTest) setTestConfirmed(event.target.checked); }} />
            我确认向当前设备发送一条测试通知
          </label>
          <button type="button" className="dialog-btn rp" aria-disabled={!canTest || !testConfirmed}
            onClick={() => {
              if (!canTest || !testConfirmed) return;
              setTestConfirmed(false);
              void onTest(true).catch(controllerHandlesError);
            }}>
            发送测试通知
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
