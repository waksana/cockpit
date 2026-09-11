import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const consumerKeys = ['SHA', 'ARTIFACT', 'REQUEST', 'INSTANCE', 'INSTALLATION'] as const;
const consumer = consumerKeys.some(key => process.env[`COCKPIT_CONSUMER_${key}`] !== undefined);
const privateDelivery = Object.keys(process.env).some(key => key.startsWith('SERVICE_DELIVERY_'));
if (consumer && (privateDelivery || process.env.COCKPIT_DELIVERY_VIEWER_CREDENTIAL !== undefined)) {
  throw new Error('Consumer and private-CD runtime authorities are mutually exclusive');
}
const instanceId = (consumer ? process.env.COCKPIT_CONSUMER_INSTANCE : process.env.SERVICE_DELIVERY_INSTANCE) ?? randomUUID();
const sha = consumer ? process.env.COCKPIT_CONSUMER_SHA : process.env.SERVICE_DELIVERY_SHA;
const artifactSha256 = consumer ? process.env.COCKPIT_CONSUMER_ARTIFACT : process.env.SERVICE_DELIVERY_ARTIFACT;
const requestId = consumer ? process.env.COCKPIT_CONSUMER_REQUEST : process.env.SERVICE_DELIVERY_REQUEST;
const installationId = consumer ? process.env.COCKPIT_CONSUMER_INSTALLATION : undefined;
if (consumer && (!consumerKeys.every(key => process.env[`COCKPIT_CONSUMER_${key}`])
  || !/^[a-f0-9-]{36}$/.test(installationId ?? ''))) {
  throw new Error('Incomplete consumer runtime identity');
}
if ([sha, artifactSha256, requestId].some(value => value !== undefined)
  && (!/^[a-f0-9]{40}$/.test(sha ?? '') || !/^[a-f0-9]{64}$/.test(artifactSha256 ?? '')
    || !/^[\w.-]{8,120}$/.test(requestId ?? '') || !/^[a-f0-9-]{36}$/.test(instanceId))) {
  throw new Error('Incomplete delivery identity; refusing ambiguous packaged startup');
}
const version: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const deliveryIdentity = Object.freeze({ instanceId, version, sha, artifactSha256, requestId,
  ...(consumer ? { authority: 'consumer' as const, installationId } : {}) });
