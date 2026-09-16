import { defineConfig } from 'vitest/config'

// Test config lives apart from vite.config.ts on purpose: the shipped
// `vite build` should not have to resolve a test-only package, and Vite's own
// `defineConfig` rejects the `test` key outright. Vitest reads vite.config.ts
// as well, so plugins and resolve rules stay identical to the dev server.
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
})
