// Dev-only browser fixture: mount the real Composer and upload client, with
// bounded synthetic HTTP responses and manual acknowledgement control.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { Attachment } from '@cockpit/protocol';
import { Composer } from './Composer';
import { createSessionDrafts, stagedAttachments } from '../lib/attachmentSend';
import '../styles/index.scss';

if (!import.meta.env.DEV) throw new Error('Composer input fixture is development-only');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const root = createRoot(document.getElementById('composer-fixture')!);
const makeDrafts = () => createSessionDrafts({ getItem: () => null, setItem: () => {}, removeItem: () => {} });
let drafts = makeDrafts();
let draft = drafts('fixture-A');
let ack = deferred<boolean>();
const uploads: { file: File; url: URL; result: ReturnType<typeof deferred<Response>> }[] = [];
const sends: { text: string; attachments: Attachment[] }[] = [];
const unexpectedRequests: string[] = [];
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.origin);
  if (url.pathname !== '/upload' || init?.method !== 'POST' || !(init.body instanceof File)) {
    unexpectedRequests.push(url.pathname);
    throw new Error(`Unexpected fixture request: ${url.pathname}`);
  }
  const result = deferred<Response>();
  uploads.push({ file: init.body, url, result });
  return result.promise;
};

function mount(id = 'fixture-A', disabled = false, attachmentBlocked = false) {
  draft = drafts(id);
  const owner = draft;
  flushSync(() => root.render(createElement(Composer, {
    draft: owner, disabled, attachmentBlocked,
    onSend: () => owner.send(async (text, attachment, attachments) => {
      sends.push({ text, attachments: attachments ?? (attachment ? [attachment] : []) });
      return ack.promise;
    }),
  })));
}

async function until(predicate: () => boolean) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('Timed out waiting for fixture state');
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}
function check(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}
function textarea() { return document.querySelector<HTMLTextAreaElement>('textarea')!; }
function zone() { return document.querySelector<HTMLElement>('.chat-input')!; }
function slots() { return stagedAttachments(draft.getSnapshot()); }
function data(files: File[], text?: string, html?: string) {
  const data = new DataTransfer();
  for (const file of files) data.items.add(file);
  if (text !== undefined) data.setData('text/plain', text);
  if (html !== undefined) data.setData('text/html', html);
  return data;
}
function paste(payload: DataTransfer) {
  const event = new ClipboardEvent('paste', { clipboardData: payload, bubbles: true, cancelable: true });
  flushSync(() => textarea().dispatchEvent(event));
  return event;
}
function drag(type: string, payload: DataTransfer, target: Element = zone()) {
  const event = new DragEvent(type, { dataTransfer: payload, bubbles: true, cancelable: true });
  flushSync(() => target.dispatchEvent(event));
  return event;
}
function choose(files: File[]) {
  const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
  input.files = data(files).files;
  flushSync(() => input.dispatchEvent(new Event('change', { bubbles: true })));
}
function edit(text: string) { flushSync(() => draft.edit(text)); }
function click(label: string) {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find(button => button.getAttribute('aria-label') === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  flushSync(() => button.click());
}
function ready(index: number) {
  const request = uploads[index];
  // These intentionally non-media bytes must not acquire a trusted media MIME
  // just because their client name/type claims PNG or MP4.
  request.result.resolve(Response.json({
    kind: 'file', name: request.file.name, mime: 'application/octet-stream',
    size: request.file.size, url: `/uploads/fixture-${index}.bin`, path: `/synthetic/fixture-${index}.bin`,
  }));
}
function reset() {
  drafts = makeDrafts();
  uploads.length = 0;
  sends.length = 0;
  unexpectedRequests.length = 0;
  ack = deferred<boolean>();
  mount();
}

async function run() {
  reset();
  const results: string[] = [];
  const image = new File(['synthetic image bytes'], 'screenshot.png', { type: 'image/png' });
  const video = new File(['synthetic video bytes'], 'clip.mp4', { type: 'video/mp4' });
  const text = new File(['notes'], 'notes.txt', { type: 'text/plain' });
  edit('before');
  const mixed = paste(data([image, video], 'native pasted text'));
  check(!mixed.defaultPrevented, 'Mixed plain text must keep native paste behavior');
  check(uploads.length === 2 && slots().length === 2, 'items/files must not double-add');
  choose([text]);
  check(slots().length === 3 && sends.length === 0, 'File input stages, never submits');
  click('发送');
  check(sends.length === 0, 'Pending uploads must block send');
  ready(2); ready(1);
  await until(() => slots()[2].status === 'ready');
  check(slots()[0].status === 'uploading' && slots()[2].status === 'ready', 'Reverse completion');
  click('发送');
  check(sends.length === 0, 'A single unfinished upload must block send');
  ready(0);
  await until(() => slots().every(item => item.status === 'ready'));
  click('发送'); click('发送');
  check(Number(sends.length) === 1, 'Exactly one send while awaiting ACK');
  check(sends[0].attachments.map(item => item.name).join(',') === 'screenshot.png,clip.mp4,notes.txt', 'Ordered mixed send');
  edit('new caption');
  paste(data([text]));
  ready(3);
  await until(() => slots().every(item => item.status === 'ready'));
  ack.resolve(true);
  await until(() => !draft.getSnapshot().pending);
  check(draft.getSnapshot().text === 'new caption' && slots().length === 1, 'ACK preserves new edits and attachments');
  results.push('mixed paste + selection; reverse completion; atomic send; pending ACK edits');

  reset();
  edit('left RIGHT');
  textarea().focus();
  textarea().setSelectionRange(5, 10);
  const rich = paste(data([image], undefined,
    '<p>Hello <b>world</b></p><div>second<br>line</div><img src="https://invalid.example/never"><iframe src="https://invalid.example/never"></iframe><script>bad()</script>'));
  check(rich.defaultPrevented, 'HTML-only mixed data should insert readable fallback');
  check(draft.getSnapshot().text === 'left Hello world\nsecond\nline', 'HTML text and selection must survive');
  check(textarea().selectionStart === textarea().value.length, 'Fallback caret');
  const plain = paste(data([], 'https://example.test/video.mp4'));
  check(!plain.defaultPrevented && uploads.length === 1, 'No URL fetching or text interception');
  const htmlOnly = paste(data([], undefined, '<b>text only</b>'));
  check(!htmlOnly.defaultPrevented && uploads.length === 1, 'No-file rich text retains default');
  results.push('plain/HTML paste; caret; no URL conversion; no binary means native fallback');

  reset();
  const dropped = data([image, video, text]);
  const before = zone().getBoundingClientRect();
  drag('dragenter', dropped);
  drag('dragenter', dropped, textarea());
  drag('dragleave', dropped, textarea());
  await until(() => zone().dataset.fileDrag === 'true');
  check(zone().dataset.fileDrag === 'true', 'Nested leave must retain highlight');
  check(zone().getBoundingClientRect().height === before.height, 'Highlight must not shift layout');
  check(drag('drop', dropped).defaultPrevented, 'File drop must prevent browser navigation');
  await until(() => !zone().dataset.fileDrag);
  check(!zone().dataset.fileDrag && slots().length === 3, 'Drop clears highlight and adds full batch');
  check(!drag('drop', data([], 'ordinary dragged text')).defaultPrevented, 'Text dragging stays native');
  drag('dragenter', dropped);
  mount('fixture-B');
  check(!zone().dataset.fileDrag && slots().length === 0, 'Session switch resets drop state');
  for (let i = 0; i < 3; i++) ready(i);
  await until(() => stagedAttachments(drafts('fixture-A').getSnapshot()).every(item => item.status === 'ready'));
  check(slots().length === 0, 'Late uploads cannot move to B');
  mount();
  check(!zone().dataset.fileDrag && slots().length === 3, 'Original A keeps its uploads without stale highlight');
  results.push('nested file drag; no layout shift; no text hijack; per-session late results');

  reset();
  choose([image, video]);
  uploads[0].result.reject(new Error('synthetic offline'));
  await until(() => slots()[0].status === 'failed');
  check(slots()[0].status === 'failed', 'Failed upload remains visible');
  click('重试上传 screenshot.png');
  check(uploads[0].url.searchParams.get('sourceId') === uploads[2].url.searchParams.get('sourceId'), 'Retry source identity');
  const first = slots()[0].generation;
  flushSync(() => draft.removeAttachment(first));
  ready(2); ready(1);
  await until(() => slots().every(item => item.status === 'ready'));
  check(slots().length === 1 && slots()[0].name === video.name, 'Removed retry cannot reappear');
  paste(data([video]));
  ready(3);
  await until(() => slots().every(item => item.status === 'ready'));
  check(slots().length === 2, 'Deliberate repeated file must not deduplicate');
  mount('fixture-A', false, true);
  click('发送');
  check(sends.length === 0, 'Ask/plan blocks attachment send');
  mount('fixture-A', true);
  const count = uploads.length;
  paste(data([image]));
  check(drag('drop', data([image])).defaultPrevented, 'Disabled file drop still prevents navigation');
  check(uploads.length === count, 'Disabled composer cannot upload');
  results.push('retry identity; removal/late result; intentional duplicates; ask/plan/disabled');

  reset();
  const filesOnly = data([image, video, text]);
  const fileList = filesOnly.files;
  Object.defineProperty(filesOnly, 'items', { value: [] });
  Object.defineProperty(filesOnly, 'files', { value: fileList });
  paste(filesOnly);
  check(slots().length === 3, 'Files-only clipboard fallback');
  for (let i = 0; i < 3; i++) ready(i);
  await until(() => slots().every(item => item.status === 'ready'));
  click('发送');
  ack.resolve(false);
  await until(() => !draft.getSnapshot().pending);
  mount('fixture-B');
  mount();
  check(sends.length === 1 && slots().length === 3, 'Unknown/failed send retains all files without replay on remount');
  check(draft.getSnapshot().error?.includes('尚未确认'), 'Unconfirmed send warns before any explicit retry');
  results.push('files-only clipboard; unconfirmed send retains draft without automatic replay');

  reset();
  choose(Array.from({ length: 19 }, () => text));
  const prior = uploads.length;
  paste(data([image, video]));
  check(uploads.length === prior && slots().length === 19, 'Overflow batch must not partially add');
  check(draft.getSnapshot().error?.includes('本批未添加'), 'Overflow feedback');
  reset();
  const large = new File(['x'], 'large.mp4');
  Object.defineProperty(large, 'size', { value: 25 * 1024 * 1024 + 1 });
  choose([text, large]);
  check(uploads.length === 0 && slots().length === 0, 'Size failure rejects whole batch');
  const directory = data([text]);
  const entries = Array.from(directory.items);
  Object.defineProperty(entries[0], 'webkitGetAsEntry', { value: () => ({ isDirectory: true }) });
  Object.defineProperty(directory, 'items', { value: entries });
  drag('drop', directory);
  check(uploads.length === 0 && draft.getSnapshot().error?.includes('目录'), 'Directory batch rejection');
  check(unexpectedRequests.length === 0, 'No other HTTP API may be contacted');
  results.push('whole-batch count/size rejection; directories rejected without scanning');
  reset();
  edit('Synthetic fixture complete');
  document.getElementById('fixture-result')!.textContent = results.join('\n');
  return { passed: results, viewport: { width: innerWidth, height: innerHeight } };
}

mount();
Object.assign(window, { composerFixture: { run, mount, reset, uploads, sends, ready, paste, data } });
