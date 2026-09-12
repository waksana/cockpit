import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REVIEW_BASE, SOURCE_SHA } from './constants.ts';

const root = dirname(fileURLToPath(import.meta.url));
const source = process.env.REVIEW_SOURCE_ROOT;
if (!source) throw new Error('REVIEW_SOURCE_ROOT must point to the pinned source checkout.');
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim() !== SOURCE_SHA) {
  throw new Error(`Review source must be exactly ${SOURCE_SHA}`);
}
execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', 'apps/web/src', 'packages/protocol/src'], { cwd: source });
const fromSource = (path: string) => resolve(source, 'apps/web/src', path);
const local = (name: string) => resolve(root, name);

export default defineConfig({
  root, base: REVIEW_BASE, publicDir: resolve(source, 'apps/web/public'),
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom', 'zustand'],
    alias: [
      { find: '../net/store', replacement: local('store.ts') },
      { find: '../lib/attachmentSend', replacement: local('drafts.ts') },
      { find: '../lib/upload', replacement: local('upload.ts') },
      { find: '../lib/managedFile', replacement: local('managedFile.ts') },
      { find: './config', replacement: local('config.ts') },
      { find: '../lib/config', replacement: local('config.ts') },
      { find: '@source', replacement: fromSource('') },
      { find: '@cockpit/protocol', replacement: resolve(source, 'packages/protocol/src/index.ts') },
    ],
  },
  build: { outDir: resolve(root, '../dist-review'), emptyOutDir: true },
});
