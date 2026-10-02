/// <reference types="vite/client" />

/**
 * The package version, substituted at build time by Vite's `define` (see
 * `vite.config.ts`). Only used in a plain browser; the packaged app reads the
 * shell's version instead, which is available even when the engine is not.
 */
declare const __APP_VERSION__: string
