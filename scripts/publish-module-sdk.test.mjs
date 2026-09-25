import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sdkPublishInvocation } from './publish-module-sdk.mjs';

const file = () => ({ isFile: () => true });

test('SDK publisher passes an explicit local tarball to npm', () => {
  assert.deepEqual(
    sdkPublishInvocation('./sdk-output/waksana-cockpit-module-sdk-0.1.1.tgz', file),
    {
      command: 'npm',
      args: ['publish', './sdk-output/waksana-cockpit-module-sdk-0.1.1.tgz'],
    },
  );
  for (const invalid of [
    'sdk-output/waksana-cockpit-module-sdk-0.1.1.tgz',
    '@waksana/cockpit-module-sdk@0.1.1',
    './sdk-output/other-0.1.1.tgz',
    './sdk-output/waksana-cockpit-module-sdk-0.1.1.tgz.git',
  ]) {
    assert.throws(() => sdkPublishInvocation(invalid, file), /explicit local/);
  }
  assert.throws(
    () => sdkPublishInvocation('./sdk-output/waksana-cockpit-module-sdk-0.1.1.tgz',
      () => ({ isFile: () => false })),
    /regular file/,
  );
});

test('SDK release workflow publishes only through the guarded local-tarball script', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release-module-sdk.yml', import.meta.url), 'utf8');
  assert.match(workflow,
    /node scripts\/publish-module-sdk\.mjs \.\/sdk-output\/waksana-cockpit-module-sdk-\*\.tgz/);
  assert.doesNotMatch(workflow, /^\s*run:\s*npm publish\b/m);
});
