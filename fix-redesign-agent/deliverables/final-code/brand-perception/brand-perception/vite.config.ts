import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The real Ken Design System source is imported by path; nothing is copied or modified.
// `dedupe` keeps a single React instance: DS files live next to their own node_modules.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: '@kenresearch/design-system', replacement: fileURLToPath(new URL("./design-system/core-v2/src", import.meta.url)) },
      { find: '@kenresearch/tokens', replacement: fileURLToPath(new URL("./design-system/tokens", import.meta.url)) },
    ],
    dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
  },
  server: { fs: { strict: false } },
});
