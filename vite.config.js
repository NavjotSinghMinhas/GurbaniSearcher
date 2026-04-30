import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // 'prompt' means the new SW installs in the background but waits —
      // it does NOT take over until the user reloads or clicks "Reload Now".
      // The update banner in the UI notifies the user.
      registerType: 'prompt',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      devOptions: {
        enabled: true,
        type: 'module',
      },
      injectManifest: {
        // Only precache the app shell; gurbani.min.json is 321 MB and is
        // handled by the CacheFirst runtime route inside sw.js instead.
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
      },
      manifest: {
        id: '/',
        name: 'Gurbani Search',
        short_name: 'Gurbani',
        description: 'Live Gurbani search from audio or text input',
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
        screenshots: [
          {
            src: 'screenshot-wide.png',    // desktop screenshot
            sizes: '1280x720',
            type: 'image/png',
            form_factor: 'wide',
            label: 'Gurbani Search desktop view'
          },
          {
            src: 'screenshot-mobile.png',  // mobile screenshot
            sizes: '390x844',
            type: 'image/png',
            form_factor: 'narrow',
            label: 'Gurbani Search mobile view'
          }
        ]
      },
    }),
  ],
})
