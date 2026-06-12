import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@main': fromRoot('./src/main'),
      '@preload': fromRoot('./src/preload'),
      '@renderer': fromRoot('./src/renderer'),
      '@shared': fromRoot('./src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
