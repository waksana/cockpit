import { randomUUID } from 'node:crypto';

const instanceId = process.env.SERVICE_DELIVERY_INSTANCE ?? randomUUID();
const sha = process.env.SERVICE_DELIVERY_SHA;
const artifactSha256 = process.env.SERVICE_DELIVERY_ARTIFACT;
const requestId = process.env.SERVICE_DELIVERY_REQUEST;
if ([sha, artifactSha256, requestId].some(value => value !== undefined)
  && (!/^[a-f0-9]{40}$/.test(sha ?? '') || !/^[a-f0-9]{64}$/.test(artifactSha256 ?? '')
    || !/^[\w.-]{8,120}$/.test(requestId ?? '') || !/^[a-f0-9-]{36}$/.test(instanceId))) {
  throw new Error('Incomplete delivery identity; refusing ambiguous packaged startup');
}
export const deliveryIdentity = Object.freeze({ instanceId, sha, artifactSha256, requestId });
