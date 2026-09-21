import type { NextLabControls } from './next-lab';

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Combined module regression: ${message}`);
}
async function until<T>(read: () => T, message: string): Promise<NonNullable<T>> {
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise(requestAnimationFrame);
  }
  throw new Error(`Combined module regression timed out: ${message}`);
}
const editor = () => document.querySelector<HTMLTextAreaElement>('.next-textarea');
const button = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
  .find(node => (node.getAttribute('aria-label') ?? node.textContent) === label && node.getClientRects().length);
function protectedLeave() {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
function key(type: 'keydown' | 'keyup', value = 'F8') {
  document.dispatchEvent(new KeyboardEvent(type, { key: value, code: value, bubbles: true, cancelable: true }));
}
function transfer(file: File, kind: 'paste' | 'drop') {
  const target = editor();
  check(target, 'real editor exists');
  const data = new DataTransfer();
  data.items.add(file);
  target.dispatchEvent(kind === 'paste'
    ? new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    : new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
}

// A browser driver holds the synthetic /_modules response before entry execution.
// Pass its release callback; no production content is delayed by this check.
export async function runNextBootstrapCheck(release: () => void, lab: NextLabControls = window.nextLab,
  text = 'A synthetic persisted draft with enough text to wrap on a narrow phone screen. Preserve this content and its original ownership while the optional modules finish starting.') {
  check(import.meta.env.DEV && import.meta.env.COCKPIT_CHAT_LAB === true && lab.modules, 'isolated module lab required');
  const owner = 'fixture-next-workspace-0';
  check(editor()?.disabled && !button('添加文件'), 'hold bootstrap before loading the modules');
  check(document.querySelector('[data-message-frame]'), 'native reading must mount before extensions');
  lab.draft(owner, text);
  await until(() => editor()?.value === text, 'retained draft before bootstrap');
  await new Promise(requestAnimationFrame);
  const before = editor()!.getBoundingClientRect();
  release();
  await until(() => button('添加文件') && button('语音输入（只写入草稿）') && !editor()?.disabled, 'settled module composer');
  await new Promise(requestAnimationFrame);
  const after = editor()!.getBoundingClientRect();
  for (const property of ['x', 'y', 'width', 'height'] as const) {
    check(Math.abs(before[property] - after[property]) <= 1,
      `bootstrap changed input ${property}: ${before[property]} -> ${after[property]}`);
  }
  check(editor()?.value === text && !lab.draftRequests().length, 'bootstrap cannot clear or submit retained text');
  return { before: before.toJSON(), after: after.toJSON() };
}

// Run in a fresh modules=1 App lab. All files/audio and native replies are synthetic;
// the host components, compiled modules, upload/capture engines and worklet are real.
export async function runNextModuleChecks(lab: NextLabControls = window.nextLab) {
  check(import.meta.env.DEV && import.meta.env.COCKPIT_CHAT_LAB === true, 'isolated lab required');
  const modules = lab.modules;
  check(modules, 'start the lab with modules=1 and both extracted module packages');
  const speech = modules.speech;
  const owner = 'fixture-next-workspace-0';
  const other = 'fixture-next-workspace-1';
  const results: string[] = [];
  lab.navigate(`/session/${owner}`);
  await until(() => button('语音输入（只写入草稿）') && button('添加文件'), 'both compiled modules');
  check(!editor()?.value && !protectedLeave(), 'use a fresh lab without unfinished work');
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 20; canvas.height = 10;
    const context = canvas.getContext('2d');
    check(context, 'synthetic image context');
    context.fillRect(0, 0, 20, 10);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value =>
      value ? resolve(value) : reject(new Error('Could not generate synthetic image')), 'image/png'));
    const name = 'fail-once-synthetic-image-with-a-long-file-name.png';
    transfer(new File([blob], name, { type: blob.type }), 'paste');
    const retry = await until(() => button(`重新上传 ${name}`), 'explicit failed-upload recovery');
    check(protectedLeave(), 'failed upload retains local bytes');
    retry.focus(); retry.click();
    const preview = await until(() => {
      const control = button(`预览 ${name}`) ?? button(`文件详情：${name}`);
      return control && !button(`重新上传 ${name}`) ? control : null;
    }, 'retried attachment');
    await until(() => !protectedLeave(), 'ready attachment persisted');
    check(document.activeElement === preview, 'removed retry returns focus to its file');
    preview.focus(); preview.click();
    const dialog = await until(() => document.querySelector('[role="dialog"]'), 'shared File dialog');
    await until(() => dialog.querySelector<HTMLImageElement>('img')?.naturalWidth === 20, 'real image preview');
    const requests = speech.microphoneRequests;
    key('keydown'); key('keyup');
    check(speech.microphoneRequests === requests, 'F8 cannot enter a portaled modal-hidden composer');
    const close = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find(node => node.textContent === '关闭');
    check(close, 'shared dialog close');
    close.click();
    await until(() => !document.querySelector('[role="dialog"]') && document.activeElement === preview, 'File return focus');
    results.push('paste, upload failure/retry, real image preview, modal F8 exclusion and focus');

    await modules.files(true);
    transfer(new File(['synthetic held upload'], 'synthetic-held.txt', { type: 'text/plain' }), 'drop');
    await until(protectedLeave, 'held upload ownership');
    lab.navigate(`/session/${other}`);
    await until(() => document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') === other, 'other draft');
    check(protectedLeave(), 'hidden draft still owns unfinished upload');
    await modules.files(false);
    await until(() => !protectedLeave(), 'hidden upload persisted');
    lab.navigate(`/session/${owner}`);
    await until(() => button('移除 synthetic-held.txt'), 'original draft attachment');
    check(document.documentElement.scrollWidth <= innerWidth, 'attachments must not widen the document');
    results.push('drop, hidden-draft upload ownership, persisted recovery and narrow layout');

    speech.transcript('Synthetic stopped recording');
    speech.failNextSession();
    const microphone = await until(() => button('语音输入（只写入草稿）'), 'microphone');
    microphone.click();
    const stop = await until(() => button('停止录音并写入草稿'), 'draft-only stop');
    // Keep enough generated audio for an actual retained-recording retry.
    await new Promise(resolve => window.setTimeout(resolve, 250));
    check(protectedLeave(), 'capture protects local audio');
    stop.click();
    const retrySpeech = await until(() => button('重试录音'), 'retained audio after credential failure');
    check(protectedLeave(), 'failed transcription retains local audio');
    const microphoneRequests = speech.microphoneRequests;
    retrySpeech.focus(); retrySpeech.click();
    await until(() => editor()?.value === 'Synthetic stopped recording' && speech.activeSockets === 0, 'canonical transcript');
    check(speech.receivedBytes > 4000 && speech.microphoneRequests === microphoneRequests,
      'retry transcribes actual retained worklet PCM without reopening the microphone');
    check(!speech.activeMicrophones && !protectedLeave(), 'retry releases audio and persists text');
    check(document.activeElement === editor() || document.activeElement === button('语音输入（只写入草稿）'),
      'removed retry returns focus within its original composer');
    check(lab.draftRequests().length === 0, 'stop must not send');
    results.push('real capture/worklet, draft-only stop, retained retry/focus, canonical transcript and cleanup');

    lab.draft(owner, '');
    await until(() => editor()?.value === '', 'empty original prompt');
    speech.transcript('Synthetic F8 attachment message');
    speech.holdFinal();
    const beforeBytes = speech.receivedBytes;
    key('keydown');
    await until(() => speech.receivedBytes > beforeBytes + 4000, 'F8 capture eligible after modal closes');
    key('keyup');
    await until(() => speech.pendingFinals === 1, 'held canonical final');
    check(protectedLeave(), 'unresolved final keeps leave protection');
    lab.navigate(`/session/${other}`);
    await until(() => document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') === other, 'post-consent navigation');
    speech.releaseFinal();
    await until(() => lab.draftRequests().length === 1, 'captured original-draft send');
    const request = lab.draftRequests()[0];
    check(request.intent === 'prompt' && request.body.sessionId === owner
      && request.body.text === 'Synthetic F8 attachment message' && request.body.attachments?.length === 2,
    'Speech captures both File attachments and its original prompt, not the newly visible draft');
    await until(() => !speech.activeSockets && !speech.activeMicrophones && !protectedLeave(), 'send cleanup');
    check(editor()?.value === '', 'newly visible draft stays unchanged');
    lab.navigate(`/session/${owner}`);
    const sentPreview = await until(() => {
      const control = button(`预览 ${name}`);
      return control?.closest('.next-attachments') ? control : null;
    }, 'submitted attachment uses the real transcript presentation');
    sentPreview.focus(); sentPreview.click();
    await until(() => document.querySelector<HTMLImageElement>('[role="dialog"] img')?.naturalWidth === 20,
      'submitted attachment media preview');
    key('keydown', 'Escape');
    await until(() => !document.querySelector('[role="dialog"]') && document.activeElement === sentPreview,
      'transcript preview return focus');
    results.push('F8 consent, held final, original-draft submission with both File attachments and cleanup');
    return results;
  } finally {
    key('keyup');
    speech.holdFinal(false);
    await modules.files(false);
  }
}
