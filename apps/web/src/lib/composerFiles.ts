import type { ComposerFileCallback, ComposerTarget } from '@cockpit/module-api';
import type { ModuleRuntime } from './moduleRuntime';

/** A picker owns its captured callback until change/cancel, not until React unmount. */
export function pickComposerFiles(runtime: ModuleRuntime, target: ComposerTarget, onFiles?: ComposerFileCallback, page = document): void {
  if (target.disabled || target.operation !== 'prompt' || target.draft.getSnapshot().pending) return;
  const captured = Object.freeze({ ...target });
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
