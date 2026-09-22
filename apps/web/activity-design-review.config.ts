import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import config from './vite.config.ts';

if (process.env.COCKPIT_ACTIVITY_DESIGN_REVIEW !== '1' || !process.env.COCKPIT_REVIEW_OUTPUT) {
  throw new Error('Static synthetic review requires explicit opt-in and a separate COCKPIT_REVIEW_OUTPUT directory.');
}

export default defineConfig({
  ...config,
  base: '/review/activity-design-20260922/',
  publicDir: false,
  build: {
    ...config.build,
    outDir: process.env.COCKPIT_REVIEW_OUTPUT,
    emptyOutDir: false,
    sourcemap: false,
    rolldownOptions: {
      input: fileURLToPath(new URL('./activity-design-review.html', import.meta.url)),
    },
  },
});
