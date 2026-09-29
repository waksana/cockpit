import { createElement, useContext, useSyncExternalStore } from 'react';
import type {
  AttachmentProps, ComposerProps, ComposerEditorProps, ComposerInputProps, ManagementHeaderProps,
  ManagementDetailHeaderProps, MessageProps, ModuleComponentProps, PublicButtonProps, SessionStatusProps, SettingsProps,
} from '@cockpit/module-api/frontend';
import { PublicComponentRuntime } from '../lib/publicComponentContext';
import { sessionActivityIndicators } from '../lib/sessionActivity';
import { SessionActivity } from './SessionActivity';
import { PaneHeader } from './PaneHeader';
import { StateNotice } from './StateNotice';
import { Button, IconButton, RefreshButton } from './Button';
import { Icon } from './Icon';

function PublicComponent<Name extends keyof ModuleComponentProps>({ name, props }: {
  name: Name; props: ModuleComponentProps[Name];
}) {
  const runtime = useContext(PublicComponentRuntime);
  if (!runtime) throw new Error('Public component runtime is missing');
  return createElement(runtime.components.get(name), props);
}

export function MessageBase({ identity: _identity, origin: _origin, decisionOrigin: _decisionOrigin,
  complete: _complete, bodyRef, adornment, children, ...props }: MessageProps) {
  return <><div {...props} ref={bodyRef}>{children}</div>{adornment}</>;
}
export function SessionStatusBase({ status, needsDecision, activity, activityRefreshing, activityDisplay, compacting,
  error, loaded, connected = false, children }: SessionStatusProps) {
  const items = sessionActivityIndicators({ status, needsDecision, activity, activityRefreshing, activityDisplay, compacting, error, loaded }, connected);
  return <span className="dialog-meta"><SessionActivity items={items} />{children}</span>;
}
export function AttachmentBase({ children, actions }: AttachmentProps) { return <>{children}{actions}</>; }
export function SettingsBase({ children, ...props }: SettingsProps) { return <section {...props}>{children}</section>; }
export function ButtonBase(props: PublicButtonProps) { return <Button {...props} />; }

export function ComposerBase({ children, ...props }: ComposerProps) {
  return <div className="chat-composer"><div className="chat-composer-body">
    <div className="chat-composer-context">{children}</div>
    <div className="chat-composer-editor"><PublicComponent name="composerEditor" props={props} /></div>
  </div></div>;
}
export function ComposerEditorBase({ draft, operation, disabled, busy, placeholder, submitLabel, sendBlocked, statusInHeader, editorRef,
  onTextChange, onSubmit, children, className, ...domProps }: ComposerEditorProps) {
  const { text, hasContent, blocks, pending, editable, submittable, retired, unconfirmed } =
    useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const blockedReason = blocks.map(block => block.reason).join('；');
  const canSend = hasContent && editable && submittable && !retired && !unconfirmed && !disabled && !sendBlocked && !pending && !blocks.length;
  const submit = () => { if (canSend) onSubmit(); };
  return <div {...domProps} className={['chat-input', 'ck-input-row', className].filter(Boolean).join(' ')}>
    {children}
    <PublicComponent name="composerInput" props={{
      draft, operation, sendBlocked, onSubmit: submit, editorRef,
      className: 'chat-input-message ck-input', 'aria-label': '消息输入', value: text,
      disabled: disabled || !editable || retired, onChange: event => onTextChange(event.target.value), placeholder: placeholder ?? '输入消息…', rows: 1,
    }} />
    <PublicComponent name="button" props={{
      className: 'chat-input-btn send', appearance: 'icon', disabled: !canSend, onClick: submit,
      'aria-label': pending ? '正在提交' : submitLabel ?? (busy ? '排队发送' : '发送'), 'aria-busy': pending,
      title: pending ? '正在提交，草稿仍可编辑' : blockedReason || (submitLabel ?? (busy ? '加入队列' : '发送')),
      children: <Icon name={pending && !statusInHeader ? 'sending' : 'arrow_up'} size={24} />,
    }} />
  </div>;
}
export function ComposerInputBase({ draft, operation: _operation, sendBlocked, editorRef, onSubmit, onKeyDown, ...props }: ComposerInputProps) {
  const snapshot = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const disabled = props.disabled || !snapshot.editable || snapshot.retired;
  return <textarea {...props} disabled={disabled} ref={editorRef} onKeyDown={event => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const desktop = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? true;
    if (event.key === 'Enter' && ((event.metaKey || event.ctrlKey) || (!event.shiftKey && desktop))) {
      event.preventDefault();
      const current = draft.getSnapshot();
      if (!sendBlocked && !disabled && current.editable && current.submittable && !current.retired
        && !current.pending && !current.unconfirmed && !current.blocks.length) onSubmit();
    }
  }} />;
}
export function ManagementHeaderBase({ section, onRefresh, actions, onBack, refreshDisabled, refreshing = false, error }: ManagementHeaderProps) {
  return <>
    <PaneHeader leading={<IconButton icon="back" label="返回会话列表" onClick={onBack} />}
      title={<span className="pane-title ck-text-primary">{section === 'mcp' ? '全局 MCP' : '全局 Skills'}</span>}
      actions={<>{actions}<RefreshButton label={section === 'mcp' ? '刷新 Copilot MCP 配置缓存' : '刷新'}
        disabled={refreshDisabled || !onRefresh} pending={refreshing} onClick={() => onRefresh?.()} /></>} />
    {error && <StateNotice kind="error">刷新失败：{error}</StateNotice>}
  </>;
}
export function ManagementDetailHeaderBase({ item, titlePrefix, actions, onBack }: ManagementDetailHeaderProps) {
  return <PaneHeader className="chat-topbar manage-detail-header"
    leading={<IconButton className="chat-back lg:hidden" icon="back" label="返回" onClick={onBack} />}
    title={<span className="pane-title resource-name">{titlePrefix}<span>{item}</span></span>} actions={actions} />;
}
