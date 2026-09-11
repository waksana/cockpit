import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const instanceId = process.env.SERVICE_DELIVERY_INSTANCE ?? randomUUID();
const sha = process.env.SERVICE_DELIVERY_SHA;
const artifactSha256 = process.env.SERVICE_DELIVERY_ARTIFACT;
const requestId = process.env.SERVICE_DELIVERY_REQUEST;
if ([sha, artifactSha256, requestId].some(value => value !== undefined)
  && (!/^[a-f0-9]{40}$/.test(sha ?? '') || !/^[a-f0-9]{64}$/.test(artifactSha256 ?? '')
    || !/^[\w.-]{8,120}$/.test(requestId ?? '') || !/^[a-f0-9-]{36}$/.test(instanceId))) {
  throw new Error('Incomplete delivery identity; refusing ambiguous packaged startup');
}
const version: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const deliveryIdentity = Object.freeze({ instanceId, version, sha, artifactSha256, requestId });
