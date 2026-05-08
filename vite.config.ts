import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Auto-update strategy: a new SW activates as soon as the user closes
      // and reopens the app. No "click here to refresh" prompts — the game
      // is small and stateless enough that silent updates are fine.
      registerType: 'autoUpdate',
      // Use the manifest already in /public rather than letting the plugin
      // generate one from scratch — keeps a single source of truth.
      manifest: false,
      injectRegister: 'auto',
      includeAssets: [
        'icon.svg',
        'icon-maskable.svg',
        'apple-touch-icon.png',
        'manifest.webmanifest',
      ],
      workbox: {
        // Static asset bundle — JS, CSS, HTML, icons. Higher size cap so
        // big chunks (the main bundle is ~670KB) get precached too.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5MB
        runtimeCaching: [
          {
            // SFX mp3s — cache first, fall back to network.
            urlPattern: /\/sfx\/.*\.(mp3|wav|ogg)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'sfx-cache-v1',
              expiration: { maxEntries: 30, maxAgeSeconds: 7 * 24 * 60 * 60 },
            },
          },
          {
            // Supabase REST + auth — always network. We don't want stale
            // leaderboard / profile data served from cache.
            urlPattern: /^https:\/\/.*\.supabase\.co\//,
            handler: 'NetworkOnly',
          },
          {
            // GA4 — never cache.
            urlPattern: /^https:\/\/www\.googletagmanager\.com\//,
            handler: 'NetworkOnly',
          },
        ],
        navigateFallbackDenylist: [/^\/parties\//, /^\/ws/],
      },
      devOptions: {
        // SW disabled in dev — re-enable temporarily to QA install/update flows.
        enabled: false,
      },
    }),
  ],
});
