import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyHostClass } from './env.ts'
import { StoreProvider } from './store.tsx'

// Marks <html> when running inside the Tauri shell so CSS can leave room for
// the native window controls (see .titlebar in App.css).
applyHostClass()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
)
