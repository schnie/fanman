/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind every interface, not just loopback: inside a sandbox or container
    // the host can only reach us via eth0. `strictPort` matters because the
    // published port mapping is fixed — silently falling back to 5174 would
    // leave the host pointing at nothing.
    host: true,
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: true,
    port: 4173,
    strictPort: true,
  },
  test: {
    // Domain tests run in node; component tests opt into jsdom with a
    // `@vitest-environment jsdom` docblock at the top of the file.
    setupFiles: ['./src/test/setup.ts'],
  },
})
