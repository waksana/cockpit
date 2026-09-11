#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { inspectProject, git } from '../lib/project.mjs';
const [config, expectedHash] = process.argv.slice(2);
const inspected = inspectProject({ repo: process.cwd(), sha: git(process.cwd(), 'rev-parse', 'HEAD'), config });
if (expectedHash && inspected.configSha256 !== expectedHash) throw Error('Requested config digest mismatch');
for (const argv of [...inspected.project.validation, inspected.project.build.argv]) {
  execFileSync(argv[0], argv.slice(1), { stdio: 'inherit', timeout: 20 * 60_000 });
}
