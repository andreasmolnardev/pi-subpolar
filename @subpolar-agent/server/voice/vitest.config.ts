import { defineConfig } from 'vitest/config'

// Process tests must not load the browser-only shared test setup.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/voice/**/*.spec.ts'],
  },
})
