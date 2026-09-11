#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { inspectProject, preparePlan } from '../lib/project.mjs';
import { validateResult } from '../lib/contracts.mjs';
import { call } from '../lib/client.mjs';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function run() {
  const command = process.argv[2];
  const allowed = {
    check: ['repo', 'sha', 'config'],
    prepare: ['repo', 'sha', 'config', 'request-id', 'intent', 'authorization'],
    'result-check': ['request', 'result'],
    submit: ['request', 'credential'],
    lookup: ['request-id', 'credential'],
    authorize: ['request', 'credential', 'reference', 'expires-at'],
    revoke: ['reference', 'credential'],
    recover: ['request-id', 'credential', 'action', 'confirm-binary-only'],
  };
  if (!Object.hasOwn(allowed, command)) {
    throw new Error('Usage: service-delivery.mjs check|prepare|result-check|submit|lookup|authorize|revoke|recover');
  }
  const { values } = parseArgs({
    args: process.argv.slice(3), strict: true, allowPositionals: false,
    options: Object.fromEntries(allowed[command].map(name => [name, { type: 'string' }])),
  });
  for (const key of allowed[command].filter(key => !['authorization', 'action', 'confirm-binary-only'].includes(key))) {
    if (!values[key]) throw new Error(`Missing --${key}`);
  }
  if (command === 'check') {
    const { project, sha, configSha256, observedTargetSha } = inspectProject(values);
    return { valid: true, projectId: project.projectId, sha, configSha256, observedTargetSha, transport: 'not-connected' };
  }
  if (command === 'prepare') {
    return preparePlan({
      ...values, requestId: values['request-id'],
      authorization: values.authorization ? readJson(values.authorization) : null,
    });
  }
  if (command === 'submit') {
    const input = readJson(values.request);
    return call(values.credential, '/submit', input.request ?? input);
  }
  if (command === 'lookup') return call(values.credential, `/requests/${encodeURIComponent(values['request-id'])}`);
  if (command === 'recover') return call(values.credential, '/recover', { requestId: values['request-id'],
    action: values.action ?? 'reconcile', confirmBinaryOnly: values['confirm-binary-only'] === 'true' });
  if (command === 'revoke') return call(values.credential, '/revoke', { reference: values.reference });
  if (command === 'authorize') {
    const input = readJson(values.request), request = input.request ?? input;
    return call(values.credential, '/authorize', { reference: values.reference, repoId: request.repo.id,
      sha: request.repo.sha, environment: request.environment, action: 'deploy', expiresAt: values['expires-at'] });
  }
  const request = readJson(values.request);
  const result = validateResult(request, readJson(values.result));
  return { valid: true, authoritative: false, requestId: result.requestId, state: result.state };
}

try {
  console.log(JSON.stringify(await run(), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
