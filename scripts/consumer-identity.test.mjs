import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

function readIdentity(values) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('SERVICE_DELIVERY_') && !key.startsWith('COCKPIT_CONSUMER_') && key !== 'COCKPIT_DELIVERY_VIEWER_CREDENTIAL'));
  return JSON.parse(execFileSync(process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', "import {deliveryIdentity} from './src/delivery-identity.ts'; console.log(JSON.stringify(deliveryIdentity));"],
    { cwd: fileURLToPath(new URL('../apps/server', import.meta.url)), env: { ...env, TSX_DISABLE_CACHE: '1', ...values }, encoding: 'utf8', stdio: 'pipe' }));
}
test('runtime provenance preserves private-CD shape and rejects competing or partial consumer identities', () => {
  const sha = 'a'.repeat(40), artifact = 'b'.repeat(64), instance = '12345678-1234-1234-1234-123456789abc';
  const privateIdentity = { SERVICE_DELIVERY_SHA: sha, SERVICE_DELIVERY_ARTIFACT: artifact,
    SERVICE_DELIVERY_REQUEST: 'private-request-1', SERVICE_DELIVERY_INSTANCE: instance };
  assert.equal(readIdentity({}).sha, undefined);
  const before = readIdentity(privateIdentity);
  assert.equal(before.sha, sha);
  assert.equal(before.authority, undefined);
  const consumer = { COCKPIT_CONSUMER_SHA: sha, COCKPIT_CONSUMER_ARTIFACT: artifact,
    COCKPIT_CONSUMER_REQUEST: 'consumer-request-1', COCKPIT_CONSUMER_INSTANCE: instance,
    COCKPIT_CONSUMER_INSTALLATION: instance };
  const actual = readIdentity(consumer);
  assert.equal(actual.authority, 'consumer');
  assert.equal(actual.installationId, instance);
  assert.equal(actual.artifactSha256, artifact);
  assert.throws(() => readIdentity({ COCKPIT_CONSUMER_SHA: sha }), /Incomplete consumer/);
  assert.throws(() => readIdentity({ ...consumer, ...privateIdentity }), /mutually exclusive/);
  assert.throws(() => readIdentity({ ...consumer, COCKPIT_DELIVERY_VIEWER_CREDENTIAL: '/not/read/by/test' }), /mutually exclusive/);
});
