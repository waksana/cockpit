import { createContext, useCallback, useContext, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { Alert, AlertDescription, Button, Textarea } from '@cockpit/ui';
import { ArrowUp } from 'lucide-react';
import type { ComposerProps, ComposerEditorProps, ComposerInputProps } from '@cockpit/module-api';
import { resolveDraft, type SessionDraft } from '../../lib/textDraft';
import { useModuleElement, useModuleRuntime } from '../modules';

export type ModuleBootstrap = 'loading' | 'settled';
const ModuleInputReady = createContext(false);

export function DraftNotices({ draft, moduleBootstrap }: { draft: SessionDraft; moduleBootstrap: ModuleBootstrap }) {
  const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const runtime = useModuleRuntime();
  useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const unknown = draft.hasUnclaimedStoredData();
  return <>
    {moduleBootstrap === 'loading' && <p role="status">正在准备模块输入；对话内容仍可阅读。</p>}
    {unknown && <Alert variant="destructive"><AlertDescription>
      此草稿包含当前界面未接管的模块数据，已阻止发送以免丢失附件。请在<a href={`/session/${encodeURIComponent(draft.sessionId)}`}>经典界面</a>恢复并检查此会话草稿。
    </AlertDescription></Alert>}
    {state.blocks.map(block => <Alert key={block.reason}><AlertDescription>{block.reason}</AlertDescription></Alert>)}
    {state.unconfirmed && <Alert variant="destructive"><AlertDescription>
      发送或草稿确认尚未完整完成，重发前请先检查会话。
      <Button variant="ghost" onClick={draft.dismissNotice}>关闭发送提示</Button>
    </AlertDescription></Alert>}
  </>;
}

export function Composer({ draft, moduleBootstrap, disabled = false, sendBlocked = false, onSend, ...props }: {
  draft: SessionDraft; moduleBootstrap: ModuleBootstrap; disabled?: boolean; sendBlocked?: boolean;
  onSend: () => Promise<boolean>; children?: ReactNode; busy?: boolean; placeholder?: string; submitLabel?: string;
  editorRef?: ComposerProps['editorRef'];
}) {
  const runtime = useModuleRuntime();
  useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const prepared = useSyncExternalStore(runtime.subscribe, () => runtime.isDraftPrepared(draft), () => runtime.isDraftPrepared(draft));
  useLayoutEffect(() => {
    if (moduleBootstrap === 'settled') runtime.prepareDraft(draft);
  }, [runtime, draft, moduleBootstrap]);
  const active = useRef<SessionDraft | null>(null);
  const current = useRef({ disabled, sendBlocked, moduleBootstrap, onSend });
  useLayoutEffect(() => { current.current = { disabled, sendBlocked, moduleBootstrap, onSend }; });
  useLayoutEffect(() => { active.current = draft; return () => { active.current = null; }; }, [draft]);
  const update = useCallback((text: string) => {
    if (active.current === draft && !current.current.disabled && current.current.moduleBootstrap === 'settled'
      && runtime.isDraftPrepared(draft) && !draft.isRetired()) draft.edit(text);
  }, [runtime, draft]);
  const submit = useCallback(() => {
    const options = current.current;
    const state = draft.getSnapshot();
    if (active.current !== draft || options.disabled || options.sendBlocked || options.moduleBootstrap !== 'settled'
      || !runtime.isDraftPrepared(draft) || draft.hasUnclaimedStoredData()
      || draft.isRetired() || state.pending || state.blocks.length || !state.hasContent) return;
    void options.onSend();
  }, [runtime, draft]);
  const ready = prepared && moduleBootstrap === 'settled';
  const publicProps: ComposerProps = {
    ...props, busy: props.busy ?? false, draft: draft.reference, operation: draft.reference.purpose.kind,
    disabled: disabled || !ready, sendBlocked: sendBlocked || !ready || draft.hasUnclaimedStoredData(),
    onTextChange: update, onSubmit: submit,
  };
  return <ModuleInputReady.Provider value={ready}>
    {ready ? <EnhancedComposer {...publicProps} /> : <ComposerBase {...publicProps} />}
  </ModuleInputReady.Provider>;
}

function EnhancedComposer(props: ComposerProps) { return useModuleElement('composer', ComposerBase, props); }
function ComposerBase({ children, ...props }: ComposerProps) {
  return <div className="next-composer"><div>{children}</div><Editor {...props} /></div>;
}
function Editor(props: ComposerEditorProps) {
  const ready = useContext(ModuleInputReady);
  const runtime = useModuleRuntime();
  const draft = resolveDraft(props.draft);
  const prepared = useSyncExternalStore(runtime.subscribe, () => runtime.isDraftPrepared(draft), () => runtime.isDraftPrepared(draft));
  return prepared && ready ? <EnhancedEditor {...props} /> : <EditorBase {...props} />;
}
function EnhancedEditor(props: ComposerEditorProps) { return useModuleElement('composerEditor', EditorBase, props); }
function EditorBase({ draft, operation, disabled, busy, placeholder, submitLabel, sendBlocked, statusInHeader: _status,
  editorRef, onTextChange, onSubmit, children, className, ...domProps }: ComposerEditorProps) {
  const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const canSend = state.hasContent && !disabled && !sendBlocked && !state.pending && !state.blocks.length;
  const submit = () => { if (canSend) onSubmit(); };
  return <div {...domProps} className={['next-editor', className].filter(Boolean).join(' ')}>
    {children}
    <Input draft={draft} operation={operation} sendBlocked={sendBlocked} onSubmit={submit} editorRef={editorRef}
      className="next-textarea chat-input-message" aria-label="消息输入" value={state.text} disabled={disabled}
      onChange={event => onTextChange(event.target.value)} placeholder={placeholder ?? '输入消息…'} rows={3} />
    <Button type="button" size="lg" className="min-h-10" disabled={!canSend} onClick={submit} aria-busy={state.pending}
      aria-label={state.pending ? '正在提交，草稿仍可编辑' : submitLabel ?? (busy ? '排队发送' : '发送')}>
      <ArrowUp aria-hidden="true" />{state.pending ? '提交中' : submitLabel ?? (busy ? '排队' : '发送')}
    </Button>
  </div>;
}
function Input(props: ComposerInputProps) {
  const ready = useContext(ModuleInputReady);
  const runtime = useModuleRuntime();
  const draft = resolveDraft(props.draft);
  const prepared = useSyncExternalStore(runtime.subscribe, () => runtime.isDraftPrepared(draft), () => runtime.isDraftPrepared(draft));
  return prepared && ready ? <EnhancedInput {...props} /> : <ComposerInputBase {...props} />;
}
function EnhancedInput(props: ComposerInputProps) { return useModuleElement('composerInput', ComposerInputBase, props); }

export function ComposerInputBase({ draft: _draft, operation: _operation, sendBlocked: _blocked, editorRef,
  onSubmit, onKeyDown, ...props }: ComposerInputProps) {
  return <Textarea {...props} ref={editorRef} onKeyDown={event => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key !== 'Enter') return;
    const desktop = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? true;
    if (event.metaKey || event.ctrlKey || (!event.shiftKey && desktop)) {
      event.preventDefault(); onSubmit();
    }
  }} />;
}
