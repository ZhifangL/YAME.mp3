import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The Python metadata engine (mp3-metadata-api) runs on 127.0.0.1:8000
      // in dev. In the packaged Tauri build the same FastAPI app runs as a
      // sidecar on the same port.
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})
