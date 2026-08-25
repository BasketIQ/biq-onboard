import { defineConfig } from 'vite';

// Standalone app build for local preview / static hosting.
export default defineConfig({
  base: './',
  build: {
    outDir: '../dist/app',
    emptyOutDir: true,
    cssCodeSplit: false,
  },
});
