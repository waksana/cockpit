import { useLayoutEffect, useRef, useState } from 'react';
import { Dialog, DirectoryModal } from '../components/Dialog';
import { Attachment, MarkdownReplacement } from '../components/ModuleComponents';
import { InspectorPane } from '../components/Shell';

type Scene = 'confirm' | 'input' | 'directory' | 'inspector';
declare global {
  interface Window {
    dialogFocusLab: {
      directoryReady(): void;
      replaceTrigger(): void;
      removeTrigger(): void;
      release(): void;
    };
  }
}

// Real production boundaries; only content, resources and actions are synthetic.
export function DialogFocusLab({ modules }: { modules: boolean }) {
  const [scene, setScene] = useState<Scene>();
  const [nested, setNested] = useState(false);
  const [ready, setReady] = useState(false);
  const [trigger, setTrigger] = useState(0);
  const [removed, setRemoved] = useState(false);
  const [hold, setHold] = useState(false);
  const pending = useRef<(() => void) | undefined>(undefined);
  const [image] = useState(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 80;
    canvas.height = 60;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Focus fixture requires a canvas context');
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL().split(',')[1];
  });
  useLayoutEffect(() => {
    window.dialogFocusLab = {
      directoryReady: () => setReady(true),
      replaceTrigger: () => setTrigger(value => value + 1),
      removeTrigger: () => setRemoved(true),
      release: () => { pending.current?.(); pending.current = undefined; },
    };
    return () => { pending.current?.(); };
  }, []);
  const close = () => setScene(undefined);
  return <main className="dialog-focus-lab ck-surface">
    <h1 className="ck-heading">Native dialog focus / synthetic inputs only</h1>
    <p>Use pointer, Tab / Shift+Tab, Enter / Space and Escape. No native sessions or backend operations.</p>
    <label><input type="checkbox" checked={hold} onChange={event => setHold(event.target.checked)} /> Hold confirmation</label>
    <div className="ck-actions">
      {!removed && (['confirm', 'input', 'directory', 'inspector'] as const).map(value =>
        <button key={`${value}-${trigger}`} className="ck-button" data-focus-trigger={value}
          onClick={() => { setReady(false); setScene(value); }}>{value}</button>)}
      <button className="ck-button" data-focus-outside>Outside control</button>
    </div>
    <div className="chat">
      <div className="chat-messages" tabIndex={0} aria-label="Synthetic reading region">
        <p>Focusable reading ancestor, including module-owned previews.</p>
        {modules && <>
          <Attachment index={0} label="focus-synthetic.png"
            attachment={{ type: 'blob', data: image, mimeType: 'image/png', displayName: 'focus-synthetic.png' }}>
            Synthetic image attachment
          </Attachment>
          <p><MarkdownReplacement node={{
            kind: 'link', target: '/synthetic/unavailable.png', label: 'Synthetic inline reference',
            origin: { sessionId: 'synthetic-focus', messageId: 'synthetic-reference' },
          }} fallback={<span>File module unavailable</span>} /></p>
        </>}
      </div>
    </div>
    {(scene === 'confirm' || scene === 'input') && <Dialog title="Synthetic confirmation"
      input={scene === 'input' ? { initial: 'Synthetic name' } : undefined}
      onCancel={close} onConfirm={() => hold ? new Promise<void>(resolve => { pending.current = resolve; }) : undefined} />}
    {scene === 'directory' && <DirectoryModal onCancel={close}>
      {ready ? <label>Directory <input className="ck-input" defaultValue="/synthetic/workspace" /></label>
        : <p role="status">Synthetic directory loading</p>}
      <button className="ck-button" onClick={() => setNested(true)}>Nested confirmation</button>
      <button className="ck-button" onClick={close}>Close directory</button>
    </DirectoryModal>}
    {scene === 'inspector' && <InspectorPane ariaLabel="Synthetic settings" onClose={close}>
      <h2 className="ck-heading">Synthetic settings</h2>
      <input className="ck-input" aria-label="Setting" defaultValue="Retained setting" />
      <button className="ck-button" onClick={close}>Close settings</button>
    </InspectorPane>}
    {nested && <Dialog title="Nested confirmation" onConfirm={() => {}} onCancel={() => setNested(false)} />}
  </main>;
}
