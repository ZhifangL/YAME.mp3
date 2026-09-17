#!/usr/bin/env node
//
// Regenerate the app icon from the frontend's favicon.
//
// The icon IS the favicon's artwork, so the two never drift: this reads the
// live <svg> out of public/favicon.svg and hands it to Tauri's icon generator.
//
// Why this is not a screenshot pipeline any more: the previous script rendered
// the 32px SVG at 1024px with headless Chrome and then downscaled. Upscaling a
// 32px drawing to 1024 loses the detail the small sizes need, and the Windows
// taskbar shows the result — the icon was reported as "a corrupted version of
// the app icon". `tauri icon` rasterises the SVG itself, at each size, from the
// vector.
//
// Usage:  node scripts/build-icon.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FAVICON = join(ROOT, 'public', 'favicon.svg')
const SVG = join(ROOT, 'src-tauri', 'app-icon.svg')

if (!existsSync(FAVICON)) {
  console.error(`No favicon at ${FAVICON}`)
  process.exit(1)
}

// Take the live <svg> element out of the favicon, ignoring commented-out
// drafts so the result is unambiguous.
const source = readFileSync(FAVICON, 'utf8')
const live = source.replace(/<!--[\s\S]*?-->/g, '')
const match = /<svg\b[\s\S]*?<\/svg>/.exec(live)
if (!match) {
  console.error('No live <svg> element found in the favicon')
  process.exit(1)
}
const svg = match[0].trim()

// Rasterisation needs an explicit size, and 1024 is what `tauri icon` wants for
// the largest iOS/store assets. The drawing is resolution-independent, so this
// does not lose anything the way upscaling a bitmap did.
const sized = svg.includes('width=')
  ? svg.replace(/width="\d+"\s+height="\d+"/, 'width="1024" height="1024"')
  : svg.replace('<svg', '<svg width="1024" height="1024"')

mkdirSync(dirname(SVG), { recursive: true })
writeFileSync(
  SVG,
  '<!-- Generated from public/favicon.svg (same artwork, vector-scaled).\n' +
    '     Do not edit by hand — run scripts/build-icon.mjs instead. -->\n' +
    sized +
    '\n',
)
console.log('==> Wrote src-tauri/app-icon.svg from the favicon')

// `tauri icon` rasterises the SVG into every size the bundles need, including
// the multi-resolution .ico Windows reads for the taskbar and Explorer.
const result = spawnSync('pnpm', ['exec', 'tauri', 'icon', SVG], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (result.status !== 0) {
  console.error('tauri icon failed')
  process.exit(result.status ?? 1)
}

console.log('==> Regenerated src-tauri/icons')
