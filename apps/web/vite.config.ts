import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { chatLabPlugin } from './chat-lab-plugin.ts'

export default defineConfig({
  plugins: [
    ...(process.env.COCKPIT_CHAT_LAB === '1' ? [chatLabPlugin()] : []),
    react(),
  ],
  build: {
    license: { fileName: 'licenses/frontend.txt' },
  },
})
