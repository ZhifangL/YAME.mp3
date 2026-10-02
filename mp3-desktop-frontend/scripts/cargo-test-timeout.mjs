#!/usr/bin/env node
//
// Run `cargo test` with a hard cap on how long it may take.
//
// Why this exists: a test that blocks (rather than fails) holds a CI runner
// until the *job* timeout — 40 minutes, once — and reports nothing useful about
// which test did it. That is exactly what a shell-dialog test did:
// `SHOpenWithDialog` does not validate its path before showing, so on a
// headless runner it waited forever for someone to click it.
//
// A bound on the whole run turns "hangs until the job dies" into "fails in
// minutes, and the last test printed is the culprit". The timeout is generous
// because a cold Windows build of the Tauri tree is genuinely slow; this
// catches *hangs*, not slowness.
//
// Usage:  node scripts/cargo-test-timeout.mjs [seconds]
import { spawn } from 'node:child_process'

const seconds = Number(process.argv[2] ?? 600)
const cwd = process.env.CARGO_TEST_CWD ?? process.cwd()

console.log(`==> cargo test (timeout ${seconds}s) in ${cwd}`)

const child = spawn('cargo', ['test', '--verbose'], {
  cwd,
  stdio: ['ignore', 'pipe', 'pipe'],
  // Needed on Windows, where `cargo` is a .cmd shim rather than an executable.
  shell: process.platform === 'win32',
})

// Stream through, so the output is in the log even if we have to kill it —
// which is the whole point, since the last line names the test that hung.
child.stdout.on('data', (chunk) => process.stdout.write(chunk))
child.stderr.on('data', (chunk) => process.stderr.write(chunk))

let timedOut = false
const timer = setTimeout(() => {
  timedOut = true
  console.error(`\n==> cargo test exceeded ${seconds}s — killing it.`)
  // The shell wrapper means `cargo` may not be the direct child; kill the whole
  // tree so no test process is left holding the runner.
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGKILL')
  }
}, seconds * 1000)

child.on('close', (code) => {
  clearTimeout(timer)
  if (timedOut) {
    console.error('==> A test is hanging. The last "test ... " line above is the one to fix.')
    process.exit(1)
  }
  process.exit(code ?? 1)
})
