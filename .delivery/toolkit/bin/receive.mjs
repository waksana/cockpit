#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { call } from '../lib/client.mjs';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (process.argv.length > 4) throw Error('Unexpected receiver arguments');
const match = /^receive ([\w.-]{8,120}) ([1-9]\d*) ([1-9]\d*)$/.exec(process.argv[3] ?? process.env.SSH_ORIGINAL_COMMAND ?? '');
if (!match) throw Error('Only receive REQUEST_ID RUN_ID ARTIFACT_ID is allowed');
const uploadId = randomBytes(16).toString('hex'), dir = join(config.root, 'incoming', uploadId);
await mkdir(dir, { recursive: true, mode: 0o700 });
let size = 0;
try {
  await pipeline(process.stdin, new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    callback(size > 400 * 1024 * 1024 ? Error('Artifact transfer exceeds bound') : null, chunk);
  } }), createWriteStream(join(dir, 'artifact.zip'), { flags: 'wx', mode: 0o600 }));
  console.log(JSON.stringify(await call(config.credential, '/artifact', {
    requestId: match[1], runId: match[2], artifactId: match[3], uploadId,
  }, { timeoutMs: 300_000 })));
} catch (error) {
  // Leave the bounded incoming file for explicit reconciliation on unknown response.
  console.error(error.message); process.exitCode = 1;
}
