import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// "/api" calls are forwarded to the Node backend (port 5050)
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true, // fail instead of silently using another port
    proxy: {
      '/api': 'http://localhost:5050'
    }
  }
})
