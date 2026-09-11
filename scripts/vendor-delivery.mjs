import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const [source, sha, previous] = process.argv.slice(2);
if (!source || !/^[a-f0-9]{40}$/.test(sha ?? '')) throw Error('Expected trusted toolkit checkout and full commit SHA');
const destination = resolve('.delivery/toolkit');
const paths = ['bin', 'lib', 'schemas', 'package.json', 'package-lock.json'];
const archive = execFileSync('git', ['-C', source, 'archive', sha,
  ...paths], { maxBuffer: 8 * 1024 * 1024 });
if (existsSync(destination)) {
  const provenance = JSON.parse(readFileSync(resolve('.delivery/provenance.json'), 'utf8'));
  if (!previous || provenance.commit !== previous) throw Error('Explicit matching previous vendor commit required for upgrade');
  const entries = execFileSync('git', ['-C', source, 'ls-tree', '-r', previous, '--', ...paths], { encoding: 'utf8' }).trim().split('\n');
  for (const entry of entries) {
    const match = /^100(?:644|755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if (!match || execFileSync('git', ['hash-object', resolve(destination, match[2])], { encoding: 'utf8' }).trim() !== match[1]) {
      throw Error('Locally modified or unsupported vendor file; refusing overwrite');
    }
  }
  for (const entry of entries) unlinkSync(resolve(destination, entry.split('\t')[1]));
  unlinkSync(resolve('.delivery/provenance.json'));
}
mkdirSync(destination, { recursive: true });
execFileSync('tar', ['-xf', '-', '-C', destination], { input: archive });
writeFileSync(resolve('.delivery/provenance.json'), JSON.stringify({
  module: 'service-delivery-toolkit', commit: sha, method: 'git archive',
  paths,
}, null, 2) + '\n', { flag: 'wx' });
