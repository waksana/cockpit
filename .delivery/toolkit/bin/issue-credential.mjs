#!/usr/bin/env node
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { join } from 'node:path';

const { values } = parseArgs({ options: Object.fromEntries(['config', 'actor', 'session', 'output'].map(key => [key, { type: 'string' }])),
  strict: true, allowPositionals: false });
if (!values.config || !values.output || !/^[\w.-]{8,120}$/.test(values.actor ?? '')
  || (values.session && !/^[a-f0-9-]{36}$/.test(values.session))) throw Error('Expected config, safe actor, output and optional session ID');
const stat = await lstat(values.config);
if (!stat.isFile() || stat.mode & 0o077) throw Error('Operator config must be private and regular');
const config = JSON.parse(await readFile(values.config, 'utf8'));
if (!config.actorsDirectory) throw Error('No actor directory configured');
const actor = { id: values.actor, role: 'submit', token: randomBytes(32).toString('hex'),
  ...(values.session ? { sessionId: values.session } : {}) };
const record = join(config.actorsDirectory, `${values.actor}.json`);
// Publish the credential first: a crash before the authority record leaves it unusable.
await writeFile(values.output, JSON.stringify({ url: `http://127.0.0.1:${config.port}`, token: actor.token }),
  { mode: 0o600, flag: 'wx' });
await writeFile(record, JSON.stringify(actor), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ credential: values.output, actor: actor.id, role: actor.role }));
