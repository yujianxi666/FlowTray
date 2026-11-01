import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// FlowTray renders inside the Tauri WebView2 runtime. The bundle is served from
// the executable itself in release builds, so every asset URL must stay relative.
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome120',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1200
  },
  server: {
    port: 1420,
    strictPort: true
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 10_000
  }
})
