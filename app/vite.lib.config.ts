import { defineConfig } from 'vite';

// Library build: produces a single self-contained ESM bundle consumed by
// the biq-app shell. Mirrors the biq-methodology pattern.
export default defineConfig({
  build: {
    lib: {
      entry: 'src/embed.ts',
      formats: ['es'],
      fileName: () => 'biq-onboard.js',
    },
    outDir: 'dist',
    emptyOutDir: true,
  },
});
