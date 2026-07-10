import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Build lands in backend/static — Flask serves it as the SPA, so deploying the dashboard
// is just `npm run build` + git push. Dev mode proxies /api to a locally-running backend.
export default defineConfig({
  plugins: [react()],
  build: { outDir: '../backend/static', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:8899' } },
})
