import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // Relative paths so the built site works from branch root
  // (https://<user>.github.io/ForexAnalysis/) and locally.
  base: './',
  plugins: [react()],
})
