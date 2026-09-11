import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [source, sha] = process.argv.slice(2);
if (!source || !/^[a-f0-9]{40}$/.test(sha ?? '')) throw Error('Expected trusted toolkit checkout and full commit SHA');
const destination = resolve('.delivery/toolkit');
if (existsSync(destination)) throw Error('Vendor destination exists; inspect before an explicit upgrade');
const archive = execFileSync('git', ['-C', source, 'archive', sha,
  'bin', 'lib', 'schemas', 'package.json', 'package-lock.json'], { maxBuffer: 8 * 1024 * 1024 });
mkdirSync(destination, { recursive: true });
execFileSync('tar', ['-xf', '-', '-C', destination], { input: archive });
writeFileSync(resolve('.delivery/provenance.json'), JSON.stringify({
  module: 'service-delivery-toolkit', commit: sha, method: 'git archive',
  paths: ['bin', 'lib', 'schemas', 'package.json', 'package-lock.json'],
}, null, 2) + '\n', { flag: 'wx' });
