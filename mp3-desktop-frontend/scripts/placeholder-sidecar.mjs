#!/usr/bin/env node
//
// Create a zero-byte placeholder sidecar so the Rust crate can be *compiled*
// without the real engine.
//
// This was originally required: `tauri-build` used to resolve the `externalBin`
// entry in tauri.conf.json while generating the context, and failed the build
// outright when the file was missing ("resource path `binaries/yame-engine-
// <triple>` doesn't exist") — which made `cargo check`, `cargo test` and a bare
// `cargo build` impossible in a fresh checkout, including in CI.
//
// YAME no longer uses `externalBin`: the engine is embedded by `build.rs`
// instead, and compiling without a staged sidecar is now fine. The stub is kept
// because it makes the "no engine built yet" case explicit rather than silent —
// a checkout with no sidecar produces an app with no engine, which still works
// on the machine that built it and nowhere else. `build.rs` embeds only a
// non-empty file, so a stub is never baked into a binary and cannot fail at
// runtime; `pnpm run sidecar` overwrites it with the real engine before
// anything is packaged.
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
