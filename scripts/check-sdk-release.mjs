import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { checkSdkRelease, checkSdkTagTarget } from './check-release.mjs';

const [tag, sha, archive, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0, 'Usage: check-sdk-release.mjs <tag> <source-sha> <archive>');
assert.ok(tag && sha && archive, 'Usage: check-sdk-release.mjs <tag> <source-sha> <archive>');
const result = checkSdkRelease(tag, sha, resolve(archive));
const refs = execFileSync('git', ['ls-remote', '--exit-code', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], {
  encoding: 'utf8',
  timeout: 30_000,
});
checkSdkTagTarget(tag, sha, refs);
console.log(JSON.stringify(result, null, 2));
