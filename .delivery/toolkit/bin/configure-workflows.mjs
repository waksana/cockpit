#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const [directory, branch, repository, sha, replace] = process.argv.slice(2);
if (!directory || !/^[\w.-]+$/.test(branch ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')
  || !/^[a-f0-9]{40}$/.test(sha ?? '') || (replace && replace !== '--replace-reviewed')) {
  throw Error('Expected project directory, target branch, shared repository and full shared workflow SHA');
}
const path = join(directory, '.github/workflows');
await mkdir(path, { recursive: true });
const build = `name: Delivery CI
run-name: \${{ github.event_name == 'workflow_dispatch' && format('delivery:{0}:{1}', inputs.request_id, inputs.source_sha) || format('build:{0}', github.sha) }}
on:
  push:
    branches: [${branch}]
  workflow_dispatch:
    inputs:
      source_sha:
        required: true
        type: string
      request_id:
        required: true
        type: string
      config_path:
        required: true
        type: string
      config_sha256:
        required: true
        type: string
permissions:
  contents: read
jobs:
  build:
    uses: ${repository}/.github/workflows/shared-delivery-ci.yml@${sha}
    with:
      source_sha: \${{ inputs.source_sha || github.sha }}
      request_id: \${{ inputs.request_id || github.sha }}
      config_path: \${{ inputs.config_path || 'service-delivery.json' }}
      config_sha256: \${{ inputs.config_sha256 || '' }}
      target_branch: ${branch}
`;
const transfer = `name: Delivery artifact transfer
on:
  workflow_run:
    workflows: [Delivery CI]
    types: [completed]
permissions:
  actions: read
  contents: read
jobs:
  transfer:
    if: github.event.workflow_run.event == 'workflow_dispatch' && github.event.workflow_run.conclusion == 'success'
    uses: ${repository}/.github/workflows/shared-delivery-transfer.yml@${sha}
    with:
      run_id: \${{ format('{0}', github.event.workflow_run.id) }}
    secrets:
      DEPLOY_KEY: \${{ secrets.DEPLOY_KEY }}
`;
for (const [name, contents] of [['delivery-ci.yml', build], ['delivery-transfer.yml', transfer]]) {
  await writeFile(join(path, name), contents, { flag: replace ? 'w' : 'wx' });
}
console.log(JSON.stringify({ directory, branch, shared: `${repository}@${sha}`, deployOnPush: false }));
