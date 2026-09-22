import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chatLabPlugin } from './chat-lab-plugin.ts'
import { parallelUiPlugin } from './parallel-ui-plugin.ts'

export default defineConfig({
  plugins: [
    ...(process.env.COCKPIT_CHAT_LAB === '1' ? [chatLabPlugin()] : []),
    parallelUiPlugin(),
    tailwindcss(),
    react(),
    {
      name: 'ui-source-attribution',
      generateBundle() {
        for (const [fileName, source] of [
          ['licenses/shadcn.txt', '../../packages/ui/LICENSE.shadcn'],
          ['licenses/tw-animate-css.txt', '../../packages/ui/node_modules/tw-animate-css/LICENSE'],
        ]) {
          this.emitFile({ type: 'asset', fileName, source: readFileSync(new URL(source, import.meta.url), 'utf8') })
        }
      },
    },
  ],
  build: {
    license: { fileName: 'licenses/frontend.txt' },
    rolldownOptions: {
      input: {
        classic: fileURLToPath(new URL('./index.html', import.meta.url)),
        next: fileURLToPath(new URL('./next/index.html', import.meta.url)),
      },
    },
  },
})
