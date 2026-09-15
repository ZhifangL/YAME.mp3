import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The engine writes its actual port to <config-dir>/engine.port on startup
// (it falls back to an ephemeral port when 8000 is taken), so the dev proxy
// follows it instead of hard-coding 8000.
function enginePort(): number {
  try {
    const configDir = process.env.TAGFORGE_CONFIG_DIR || path.join(os.homedir(), '.config', 'tagforge')
    const port = parseInt(fs.readFileSync(path.join(configDir, 'engine.port'), 'utf8').trim(), 10)
    if (Number.isFinite(port) && port > 0 && port < 65536) return port
  } catch {
    /* engine not started yet — fall back */
  }
  return 8000
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The Python metadata engine (mp3-metadata-api) runs on 127.0.0.1.
      // In the packaged Tauri build the same FastAPI app runs as a sidecar.
      '/api': {
        target: 'http://127.0.0.1:' + enginePort(),
        changeOrigin: true,
      },
    },
  },
})
