#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** This small verifier itself comes from trusted operator media, not an unverified download. */
export async function verifyConsumerBootstrap({ archive, envelopeFile, publicKeyFile, sourceSha, destination }) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Out-of-band expected full source SHA required');
  const stat = await lstat(archive);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid bounded bootstrap archive');
  const envelopeStat = await lstat(envelopeFile);
  if (!envelopeStat.isFile() || envelopeStat.size > 16_384) throw new Error('Invalid bootstrap signature envelope');
  const envelope = JSON.parse(await readFile(envelopeFile, 'utf8'));
  const payload = Buffer.from(envelope.payload, 'base64'), signature = Buffer.from(envelope.signature, 'base64');
  const key = createPublicKey(await readFile(publicKeyFile));
  if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 || !verify(null, payload, key, signature)) {
    throw new Error('Bootstrap publisher signature is not trusted');
  }
  const metadata = JSON.parse(payload.toString('utf8'));
  if (metadata.schemaVersion !== 1 || metadata.kind !== 'cockpit-bootstrap' || metadata.sourceSha !== sourceSha
    || metadata.bytes !== stat.size || metadata.sha256 !== createHash('sha256').update(await readFile(archive)).digest('hex')) {
    throw new Error('Bootstrap archive/source does not match trusted signed identity');
  }
  await mkdir(destination, { mode: 0o700 });
  execFileSync('python3', ['-c',
    'import os,sys,zipfile\nexpected={"cli.mjs","launcher.mjs","state.mjs","channel.mjs","archive.mjs","module-runner.mjs","release-transport.mjs","artifact.mjs","extract.py"}\nwith zipfile.ZipFile(sys.argv[1]) as z:\n entries=z.infolist()\n if len(entries)!=len(expected) or {x.filename for x in entries}!=expected or sum(x.file_size for x in entries)>2*1024*1024: raise ValueError("Invalid bootstrap contents")\n for entry in entries:\n  with open(os.path.join(sys.argv[2],entry.filename),"xb") as out: out.write(z.read(entry))',
    archive, destination], { stdio: 'pipe' });
  return { verified: true, sourceSha, destination };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [archive, envelopeFile, publicKeyFile, sourceSha, destination] = process.argv.slice(2);
  if (!destination || process.argv.length !== 7) {
    console.error('Usage: node verify-consumer-bootstrap.mjs ARCHIVE SIGNED_JSON PINNED_PUBLIC_KEY EXPECTED_SOURCE_SHA NEW_DIRECTORY');
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(await verifyConsumerBootstrap({ archive: resolve(archive), envelopeFile: resolve(envelopeFile),
        publicKeyFile: resolve(publicKeyFile), sourceSha, destination: resolve(destination) })));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
