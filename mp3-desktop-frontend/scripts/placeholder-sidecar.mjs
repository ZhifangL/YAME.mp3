#!/usr/bin/env node
//
// Create a zero-byte placeholder sidecar so the Rust crate can be *compiled*
// without the real engine.
//
// `tauri-build` resolves the `externalBin` entry in tauri.conf.json while
// generating the context, and fails the build outright if the file is missing
// ("resource path `binaries/yame-engine-<triple>` doesn't exist"). That makes
// `cargo check`, `cargo test` and a bare `cargo build` impossible in a fresh
// checkout — including in CI, and including for anyone who only wants to work
// on the Rust half.
//
// The placeholder is never shipped: `pnpm run sidecar` overwrites it with the
// real PyInstaller output before anything is packaged. Anything that actually
// runs the app is unaffected, because a placeholder is not executable in any
// useful sense.
//
// Usage:  node scripts/placeholder-sidecar.mjs [triple]
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BIN_DIR = join(ROOT, 'src-tauri', 'binaries')
const NAME = 'yame-engine'

function targetTriple() {
  if (process.argv[2]) return process.argv[2]
  const rustc = spawnSync('rustc', ['-vV'], { encoding: 'utf8' })
  const match = rustc.status === 0 ? /^host:\s*(\S+)$/m.exec(rustc.stdout) : null
  if (!match) {
    console.error('Could not determine the target triple; pass it as the first argument.')
    process.exit(1)
  }
  return match[1]
}

const triple = targetTriple()
const path = join(BIN_DIR, `${NAME}-${triple}${triple.includes('windows') ? '.exe' : ''}`)

if (existsSync(path)) {
  console.log(`==> Sidecar already present: ${path}`)
  process.exit(0)
}

mkdirSync(BIN_DIR, { recursive: true })
writeFileSync(path, '')
console.log(`==> Placeholder sidecar created: src-tauri/binaries/${NAME}-${triple}`)
console.log('    Run `pnpm run sidecar` to replace it with the real engine.')
