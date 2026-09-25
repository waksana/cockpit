import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function sdkPublishInvocation(archive, stat = lstatSync) {
  assert.match(archive, /^\.\/sdk-output\/waksana-cockpit-module-sdk-\d+\.\d+\.\d+\.tgz$/,
    'SDK publish input must be an explicit local ./sdk-output tarball');
  assert.ok(stat(resolve(archive)).isFile(), 'SDK publish input must be a regular file');
  return { command: 'npm', args: ['publish', archive] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [archive, ...extra] = process.argv.slice(2);
  assert.equal(extra.length, 0, 'Usage: publish-module-sdk.mjs ./sdk-output/PACKAGE.tgz');
  assert.ok(archive, 'Usage: publish-module-sdk.mjs ./sdk-output/PACKAGE.tgz');
  const invocation = sdkPublishInvocation(archive);
  execFileSync(invocation.command, invocation.args, { stdio: 'inherit' });
}
