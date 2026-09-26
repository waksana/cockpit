import { randomUUID } from 'node:crypto';
import { readRuntimeIdentity } from '@cockpit/protocol/runtime-identity';

export function readIdentity(
  packageFile = new URL('../package.json', import.meta.url),
  manifestFile = new URL('../../../runtime-manifest.json', import.meta.url),
) {
  return Object.freeze({ instanceId: randomUUID(), ...readRuntimeIdentity(packageFile, manifestFile) });
}

export const serviceIdentity = readIdentity();
