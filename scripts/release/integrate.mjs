import { execFileSync } from 'node:child_process';
import { SHA } from './model.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (process.argv.length !== 3 || process.argv[2] !== '--publish-main') {
  throw new Error('Explicit --publish-main is required: updating main requests production deployment.');
}
if (git('status', '--porcelain')) throw new Error('Commit or preserve all work before integrating');
if (git('branch', '--show-current') === 'main') throw new Error('Integrate from the owner worktree, not shared main');
git('fetch', 'origin', 'main');
const commit = git('rev-parse', 'HEAD');
if (!SHA.test(commit)) throw new Error('Invalid candidate commit');
execFileSync('git', ['merge-base', '--is-ancestor', 'origin/main', commit], { stdio: 'inherit' });
// A competing remote update not contained in this candidate is rejected by Git.
execFileSync('git', ['push', 'origin', `${commit}:refs/heads/main`], { stdio: 'inherit' });
console.log(`Main accepted ${commit}; CI builds it next. This is not production health confirmation.`);
