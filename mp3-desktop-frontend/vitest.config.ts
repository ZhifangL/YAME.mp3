import { defineConfig } from 'vitest/config'

import pkg from './package.json' with { type: 'json' }

// Test config lives apart from vite.config.ts on purpose: the shipped
// `vite build` should not have to resolve a test-only package, and Vite's own
// `defineConfig` rejects the `test` key outright.
//
// Vitest does read vite.config.ts for plugins and resolve rules, but *not* for
// `define` — so anything the app expects to be substituted at build time has to
// be declared here too. `__APP_VERSION__` is one: without it, importing the
// store throws `ReferenceError: __APP_VERSION__ is not defined` in every test
// that touches it.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
})
