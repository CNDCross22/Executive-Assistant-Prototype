import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    // The Pages site is public. A source map there serves the full annotated
    // client source, including every internal name and comment, to anyone who
    // asks. This only affects `vite build`; the dev server keeps its own
    // sourcemaps regardless, so nothing is lost while working locally.
    sourcemap: false,
  },
});
