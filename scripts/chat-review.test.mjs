import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { stripInterruptHint } from '../apps/web/review/source-exception.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
test('review pins the deployed source and substitutes only data/transport boundaries', () => {
  const config = read('apps/web/review/vite.config.ts');
  assert.match(read('apps/web/review/constants.ts'), /9eaf3481c3d5a9487ce3779adbb49dfc5a288232/);
  assert.match(config, /rev-parse.*HEAD/);
  assert.match(config, /diff.*--exit-code.*HEAD/);
  assert.doesNotMatch(config, /VitePWA|injectManifest/);
  assert.match(config, /id === fromSource\('components\/Thread.tsx'\).*stripInterruptHint\(code\)/);
  for (const component of ['Thread', 'Composer', 'MessageBody', 'FileCard']) {
    assert.doesNotMatch(config, new RegExp(`find:.*${component}`));
  }
  const harness = read('apps/web/review/Review.tsx');
  assert.match(harness, /@source\/components\/Thread/);
  assert.match(harness, /@source\/styles\/index.scss/);
  assert.doesNotMatch(harness, /<BrowserRouter|<ConnectedThread|\.init\(|localStorage[.(]|navigator\.serviceWorker/);
  assert.match(harness, /review-only-/);
  assert.match(harness, /window\.SpeechRecognition|Object\.defineProperty\(window, 'SpeechRecognition'/);
});
test('the only presentation exception removes exactly the hint and description, leaving behavior intact', () => {
  const source = 'before\n                aria-describedby={`interrupt-help-${session.sessionId}`}\n'
    + 'onClick={preserved}\n'
    + '              <span id={`interrupt-help-${session.sessionId}`}>只打断主回合，保留队列；后台任务继续，可能延后处理。</span>\n'
    + 'after\n';
  assert.equal(stripInterruptHint(source), 'before\nonClick={preserved}\nafter\n');
  assert.throws(() => stripInterruptHint('unexpected source'), /no longer matches/);
  assert.doesNotMatch(read('apps/web/src/components/Thread.tsx'), /interrupt-help|chat-execution-hint/);
});
test('review drafts are memory-only and files cannot resolve to production URLs', () => {
  const draft = read('apps/web/review/drafts.ts');
  assert.match(draft, /createSessionDrafts\(\{/);
  assert.match(draft, /values\.get\(`review:/);
  assert.doesNotMatch(draft, /localStorage[.(]/);
  const upload = read('apps/web/review/upload.ts');
  assert.match(upload, /REVIEW_BASE.*media/);
  assert.match(upload, /throw new Error/);
  const store = read('apps/web/review/store.ts');
  assert.doesNotMatch(store, /NetClient|fetch\(|EventSource|session\/new|session\/get/);
});
test('built static review matches its inventory and contains no native client or service worker', { skip: !process.env.CHAT_REVIEW_DIST }, () => {
  const dist = resolve(process.env.CHAT_REVIEW_DIST);
  const manifest = JSON.parse(readFileSync(resolve(dist, 'review-build.json'), 'utf8'));
  assert.equal(manifest.sourceSha, '9eaf3481c3d5a9487ce3779adbb49dfc5a288232');
  assert.ok(manifest.files['index.html']);
  assert.ok(manifest.files['media/lab-video.webm']);
  for (const [name, expected] of Object.entries(manifest.files)) {
    const bytes = readFileSync(resolve(dist, name));
    assert.equal(bytes.length, expected.bytes, name);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256, name);
    if (name.endsWith('.js')) {
      assert.doesNotMatch(bytes.toString(), /createCockpitStore|new EventSource|serviceWorker\.register|\/intent\/session\//, name);
    }
  }
  assert.equal(existsSync(resolve(dist, 'sw.js')), false);
  assert.match(readFileSync(resolve(dist, 'index.html'), 'utf8'), /\/review\/chat-v4\/assets\//);
});
