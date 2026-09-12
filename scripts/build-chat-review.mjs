import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';

const repo = fileURLToPath(new URL('../', import.meta.url));
const web = join(repo, 'apps/web');
const source = process.env.REVIEW_SOURCE_ROOT;
const sha = '9eaf3481c3d5a9487ce3779adbb49dfc5a288232';
if (!source) throw new Error('Set REVIEW_SOURCE_ROOT to a clean checkout of the deployed 9eaf348 commit.');
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim() !== sha) throw new Error('Wrong review source SHA');
execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', 'apps/web/src', 'packages/protocol/src'], { cwd: source });
const temporary = await mkdtemp(join(tmpdir(), 'cockpit-review-types-'));
try {
  const settings = { extends: join(web, 'tsconfig.app.json'), compilerOptions: {} };
  settings.compilerOptions.tsBuildInfoFile = join(temporary, 'buildinfo');
  settings.compilerOptions.baseUrl = web;
  settings.compilerOptions.paths = {
    '@source/*': [join(resolve(source), 'apps/web/src/*')],
    '@cockpit/protocol': [join(resolve(source), 'packages/protocol/src/index.ts')],
    react: [join(web, 'node_modules/@types/react')],
    'react/*': [join(web, 'node_modules/@types/react/*')],
    'react-dom/*': [join(web, 'node_modules/@types/react-dom/*')],
  };
  settings.compilerOptions.typeRoots = [join(web, 'node_modules/@types')];
  settings.compilerOptions.types = [join(web, 'node_modules/vite/client')];
  settings.include = [join(web, 'review')];
  await writeFile(join(temporary, 'tsconfig.json'), JSON.stringify(settings));
  execFileSync('pnpm', ['exec', 'tsc', '--project', join(temporary, 'tsconfig.json')], { cwd: web, stdio: 'inherit' });
  execFileSync('pnpm', ['exec', 'vite', 'build', '--config', 'review/vite.config.ts'], { cwd: web, stdio: 'inherit' });
} finally {
  await rm(join(temporary, 'tsconfig.json'), { force: true });
  await rm(join(temporary, 'buildinfo'), { force: true });
  await rm(temporary, { recursive: true });
}
const out = join(web, 'dist-review');
await mkdir(join(out, 'media'), { recursive: true });
for (const name of ['lab-layout.svg', 'lab-video.webm']) {
  await copyFile(join(source, 'apps/web/src/dev', name), join(out, 'media', name));
}
await copyFile(join(out, 'media/lab-layout.svg'), join(out, 'media/lab-slow.svg'));
await writeFile(join(out, 'media/lab-notes.txt'), 'Synthetic review attachment. No user content.\n');
await writeFile(join(out, 'media/lab-unknown.bin'), 'Synthetic unknown-format fixture.\n');
const files = {};
async function inventory(directory, prefix = '') {
  for (const file of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + file.name;
    if (file.isDirectory()) await inventory(join(directory, file.name), name + '/');
    else {
      if (!file.isFile()) throw new Error(`Unexpected non-file ${name}`);
      const bytes = await readFile(join(directory, file.name));
      files[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
  }
}
await inventory(out);
if (Object.keys(files).some(name => /(?:^|\/)sw\.(js|mjs)$/.test(name))) throw new Error('Review must not ship a service worker');
const sourceFiles = {};
for (const path of [
  'components/Thread.tsx', 'components/Composer.tsx', 'components/MessageBody.tsx', 'components/MessageContent.tsx',
  'components/FileCard.tsx', 'components/ChatHeader.tsx', 'components/ModeMenu.tsx', 'components/AnchoredMenu.tsx',
  'styles/index.scss', 'styles/components/chat.scss', 'styles/components/files.scss', 'styles/tokens.scss',
]) {
  sourceFiles[path] = createHash('sha256').update(await readFile(join(source, 'apps/web/src', path))).digest('hex');
}
await writeFile(join(out, 'review-build.json'), JSON.stringify({
  sourceSha: sha, reviewSourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  entry: '/review/chat-v4/', sourceFiles, files,
}, null, 2));
console.log(`Static review built from ${sha}: ${out}`);
