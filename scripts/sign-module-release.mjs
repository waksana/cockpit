#!/usr/bin/env node
import { createPrivateKey, sign } from 'node:crypto';
import { constants, closeSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModuleReleaseMetadata } from '../packages/protocol/src/modules.ts';

export function signModuleRelease(metadataFile, keyFile, outputFile) {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Publisher signing requires Node 24');
  const stat = lstatSync(keyFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077)
    || stat.uid !== process.getuid()) throw new Error('Signing key must be an owner-only regular file');
  const metadata = ModuleReleaseMetadata.parse(JSON.parse(readFileSync(metadataFile, 'utf8')));
  const now = Date.now();
  if (Date.parse(metadata.expiresAt) <= now || Date.parse(metadata.issuedAt) > now + 300_000
    || Date.parse(metadata.expiresAt) <= Date.parse(metadata.issuedAt)) throw new Error('Release metadata validity interval is invalid');
  const key = createPrivateKey(readFileSync(keyFile));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Release publisher key must be Ed25519');
  const payload = Buffer.from(JSON.stringify(metadata));
  const envelope = { payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') };
  const fd = openSync(outputFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try { writeFileSync(fd, JSON.stringify(envelope)); fsyncSync(fd); }
  finally { closeSync(fd); }
  return { sequence: metadata.sequence, targets: metadata.targets.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 5) {
    console.error('Usage: node scripts/sign-module-release.mjs METADATA_JSON PRIVATE_KEY_FILE NEW_OUTPUT_JSON');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(signModuleRelease(...process.argv.slice(2)))); }
    catch (error) { console.error(error instanceof Error ? error.message : 'Release signing failed'); process.exitCode = 1; }
  }
}
