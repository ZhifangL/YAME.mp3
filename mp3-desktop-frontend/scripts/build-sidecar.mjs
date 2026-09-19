#!/usr/bin/env node
//
// Stage the Python engine where Tauri expects a sidecar.
//
// Tauri's `externalBin` entry "binaries/yame-engine" resolves at build time to
// "binaries/yame-engine-<target-triple>", plus ".exe" on Windows. This script
// runs PyInstaller and copies its output under that name.
//
// Node rather than bash on purpose: the Windows build has no bash, and
// PyInstaller cannot cross-compile, so the sidecar must be produced by a
// Windows Python on Windows. One script that runs identically on all three
// platforms beats three scripts that drift.
//
// Usage:
//   node scripts/build-sidecar.mjs              # host target triple
//   node scripts/build-sidecar.mjs <triple>     # explicit (e.g. in CI)
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync, chmodSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const API_DIR = resolve(ROOT, '..', 'mp3-metadata-api')
const BIN_DIR = join(ROOT, 'src-tauri', 'binaries')
const NAME = 'yame-engine'

function fail(message) {
  console.error(`==> ${message}`)
  process.exit(1)
}

/** The Rust target triple to build for: argv, or whatever rustc is set to. */
function targetTriple() {
  const explicit = process.argv[2]
  if (explicit) return explicit
  const rustc = spawnSync('rustc', ['-vV'], { encoding: 'utf8' })
  if (rustc.status !== 0) {
    fail('Could not run rustc to detect the target triple; pass it as the first argument.')
  }
  const match = /^host:\s*(\S+)$/m.exec(rustc.stdout)
  if (!match) fail('Could not read the host triple from `rustc -vV`.')
  return match[1]
}

/**
 * The interpreter to freeze.
 *
 * A bare name like "python3" has to be resolved through PATH, which
 * `existsSync` cannot do — so every candidate is probed by actually running it.
 * The venv comes first because PyInstaller can only build for the
 * architecture of the interpreter it runs under, and the venv is the one the
 * project pins.
 */
function pythonFor(apiDir) {
  const candidates =
    process.platform === 'win32'
      ? [join(apiDir, '.venv', 'Scripts', 'python.exe'), 'python', 'py']
      : [join(apiDir, '.venv', 'bin', 'python'), 'python3', 'python']
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import PyInstaller'], { stdio: 'ignore' })
    if (probe.status === 0) return candidate
  }
  return null
}

const triple = targetTriple()
const isWindows = triple.includes('windows')
const python = pythonFor(API_DIR)

if (!existsSync(API_DIR)) fail(`Engine source not found at ${API_DIR}`)
if (!python) {
  fail(
    'No Python with PyInstaller found. Run `uv sync` in mp3-metadata-api and add ' +
      'PyInstaller (`uv add --dev pyinstaller`), or install it into the interpreter ' +
      'you want to freeze.',
  )
}

console.log(`==> Building the engine for ${triple}`)
const build = spawnSync(
  python,
  ['-m', 'PyInstaller', 'yame-engine.spec', '--noconfirm', '--distpath', 'dist', '--workpath', 'build'],
  { cwd: API_DIR, stdio: 'inherit' },
)
if (build.status !== 0) fail('PyInstaller failed.')

// PyInstaller appends .exe on Windows; one-file mode keeps it a single file,
// which is what Tauri's sidecar mechanism can copy.
const built = join(API_DIR, 'dist', isWindows ? `${NAME}.exe` : NAME)
if (!existsSync(built)) fail(`PyInstaller did not produce ${built}`)

mkdirSync(BIN_DIR, { recursive: true })
const staged = join(BIN_DIR, `${NAME}-${triple}${isWindows ? '.exe' : ''}`)
copyFileSync(built, staged)
// Windows has no executable bit to set; on the others it is required.
if (!isWindows) chmodSync(staged, 0o755)

const size = (statSync(staged).size / (1024 * 1024)).toFixed(1)
console.log(`==> Sidecar staged: src-tauri/binaries/${NAME}-${triple}${isWindows ? '.exe' : ''} (${size} MB)`)
