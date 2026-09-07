import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
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
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png', 'icon.svg', 'apple-touch-icon.png'],
      injectManifest: {
        globPatterns: ['**/*.{js,css,html}'],
      },
      manifest: {
        name: 'cockpit',
        short_name: 'cockpit',
        description: '控制运行在服务器上的 AI 会话',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#fdf6e3',
        theme_color: '#fdf6e3',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
    }),
  ],
})
