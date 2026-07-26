import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve(process.cwd(), 'office-web'),
  base: '/office/',
  build: {
    outDir: resolve(process.cwd(), 'office-dist/office'),
    emptyOutDir: true,
  },
})
