import type { ComposerFileCallback, ComposerTarget } from '@cockpit/module-api';
import type { ModuleRuntime } from './moduleRuntime';
import { resolveDraft } from './textDraft';

/** A picker owns its captured callback until change/cancel, not until React unmount. */
export function pickComposerFiles(runtime: ModuleRuntime, target: ComposerTarget, onFiles?: ComposerFileCallback, page = document): void {
  let captured: ComposerTarget;
  try {
    const draft = resolveDraft(target.draft);
    if (target.disabled || draft.isRetired() || draft.getSnapshot().pending) return;
    if (target.operation !== draft.reference.purpose.kind) throw new Error('File picker draft purpose has changed');
    captured = Object.freeze({ ...target, draft: draft.reference });
  } catch (error) { runtime.report(error); return; }
  const input = page.createElement('input');
  input.type = 'file';
  input.multiple = true;
  let settled = false;
  const release = () => {
    settled = true;
    input.removeEventListener('change', change);
    input.removeEventListener('cancel', cancel);
  };
  const cancel = () => { release(); };
  const change = () => {
    if (settled) return;
    const files = Array.from(input.files ?? []);
    release();
    input.value = '';
    runtime.receiveFiles(files, captured, 'picker', onFiles);
  };
  input.addEventListener('change', change);
  input.addEventListener('cancel', cancel);
  try { input.click(); }
  catch (error) { release(); runtime.report(error); }
}
