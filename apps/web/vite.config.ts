import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { chatLabPlugin } from './chat-lab-plugin'

export default defineConfig({
  plugins: [
    ...(process.env.COCKPIT_CHAT_LAB === '1' ? [chatLabPlugin()] : []),
    react(),
    // PWA: generate the manifest + build our custom service worker (src/sw.ts)
    // via injectManifest. We register the SW ourselves (lib/push.ts), so
    // injectRegister is disabled. The SW is emitted as /sw.js (matches the
    // manual registration). Push/notificationclick logic lives in src/sw.ts.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: null,
      registerType: 'autoUpdate',
      includeAssets: [
        'favicon-refined-r4.ico', 'favicon-refined-r4.svg',
        'favicon-refined-r4-16.png', 'favicon-refined-r4-32.png', 'icon-refined-r4.svg',
        'icon-refined-r4-192.png', 'icon-refined-r4-512.png', 'apple-touch-icon-refined-r4.png',
        'badge-refined-r4-96.png',
      ],
      injectManifest: {
        globPatterns: ['**/*.{js,css,html}'],
      },
      manifest: {
        id: '/',
        name: 'cockpit',
        short_name: 'cockpit',
        description: '控制运行在服务器上的 AI 会话',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#fdf6e3',
        theme_color: '#fdf6e3',
        icons: [
          { src: '/icon-refined-r4-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: '/icon-refined-r4-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          { src: '/icon-refined-r4.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
    }),
  ],
})
