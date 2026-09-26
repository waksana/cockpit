import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

// This entry only reads a verified candidate's declared protocol; no native session is constructed.
export async function candidateFacts(root: string) {
  const protocol = await import(pathToFileURL(resolve(root, 'packages/protocol/dist/index.js')).href) as { Intents?: object };
  if (!protocol.Intents || typeof protocol.Intents !== 'object') throw new Error('Candidate has no public intent registry');
  const sdk = JSON.parse(await readFile(resolve(root, 'packages/core/package.json'), 'utf8')).dependencies?.['@github/copilot-sdk'];
  if (typeof sdk !== 'string' || !/^\d+\.\d+\.\d+$/.test(sdk)) throw new Error('Candidate has no exact native SDK dependency');
  return { node: process.versions.node, intents: Object.keys(protocol.Intents), sdk };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('Usage: candidate <verified-runtime-root>');
  process.stdout.write(`${JSON.stringify(await candidateFacts(process.argv[2]!))}\n`);
}
