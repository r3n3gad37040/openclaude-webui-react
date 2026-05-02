import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    outDir: 'dist/ui',
    emptyOutDir: false,
  },
  preview: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:8789', changeOrigin: true },
      '/or-proxy': { target: 'http://localhost:8789', changeOrigin: true },
      '/venice-proxy': { target: 'http://localhost:8789', changeOrigin: true },
      '/xai-proxy': { target: 'http://localhost:8789', changeOrigin: true },
      '/groq-proxy': { target: 'http://localhost:8789', changeOrigin: true },
      '/dolphin-proxy': { target: 'http://localhost:8789', changeOrigin: true },
      '/nineteen-proxy': { target: 'http://localhost:8789', changeOrigin: true },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8789', changeOrigin: true },
      '/or-proxy': { target: 'http://localhost:8789', changeOrigin: true },
      '/venice-proxy': { target: 'http://localhost:8789', changeOrigin: true },
      '/xai-proxy': { target: 'http://localhost:8789', changeOrigin: true },
      '/groq-proxy': { target: 'http://localhost:8789', changeOrigin: true },
      '/dolphin-proxy': { target: 'http://localhost:8789', changeOrigin: true },
      '/nineteen-proxy': { target: 'http://localhost:8789', changeOrigin: true },
    },
  },
})
