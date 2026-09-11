import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateShape, validateRequest } from './contracts.mjs';

const FULL_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CONFIG_PATH = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_./-]+$/;

export function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

export function inspectProject({ repo, sha, config }) {
  if (!CONFIG_PATH.test(config)) throw new Error('Config must be a safe repository-relative path');
  const commit = git(repo, 'rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`);
  const entry = git(repo, 'ls-tree', commit, '--', config);
  if (!entry.startsWith('100644 blob ') || entry.split('\t')[1] !== config) {
    throw new Error('Config must be a committed regular non-executable file, not a symlink');
  }
  // Hash raw committed bytes, including trailing whitespace, not a parsed/reserialized object.
  const bytes = execFileSync('git', ['-C', repo, 'show', `${commit}:${config}`], {
    maxBuffer: 1024 * 1024, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const project = validateShape('project', JSON.parse(bytes.toString('utf8')));
  git(repo, 'check-ref-format', project.targetRef);
  const observedTargetSha = git(repo, 'rev-parse', '--verify', '--end-of-options', `${project.targetRef}^{commit}`);
  return {
    project, sha: commit, observedTargetSha,
    configSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function preparePlan({ repo, sha, config, requestId, intent, authorization = null }) {
  if (!FULL_SHA.test(sha)) throw new Error('prepare requires a full lowercase commit SHA, not HEAD, branch or short SHA');
  const inspected = inspectProject({ repo, sha, config });
  if (inspected.sha !== sha) throw new Error('SHA must identify a commit directly');
  git(repo, 'merge-base', '--is-ancestor', sha, inspected.observedTargetSha);
  const request = validateRequest({
    schemaVersion: 1, requestId,
    repo: {
      id: inspected.project.projectId, sha,
      targetRef: inspected.project.targetRef, observedTargetSha: inspected.observedTargetSha,
    },
    projectConfig: { path: config, sha256: inspected.configSha256 },
    intent, environment: inspected.project.delivery.environment, authorization,
  });
  return { kind: 'delivery-plan', transport: 'not-connected', submitted: false, request };
}
