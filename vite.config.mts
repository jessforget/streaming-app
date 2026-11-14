import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** The web interface: main window (index), tablet remote and the interactive mockup (demo). */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'out/web'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/renderer/index.html'),
        remote: resolve(__dirname, 'src/renderer/remote.html'),
        demo: resolve(__dirname, 'src/renderer/demo.html')
      }
    }
  }
})
