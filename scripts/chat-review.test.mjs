import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
test('review pins the deployed source and substitutes only data/transport boundaries', () => {
  const config = read('apps/web/review/vite.config.ts');
  assert.match(read('apps/web/review/constants.ts'), /9eaf3481c3d5a9487ce3779adbb49dfc5a288232/);
  assert.match(config, /rev-parse.*HEAD/);
  assert.match(config, /diff.*--exit-code.*HEAD/);
  assert.doesNotMatch(config, /VitePWA|injectManifest|transform\(/);
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
