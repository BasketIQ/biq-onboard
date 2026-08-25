import { defineConfig } from 'vite';

// Embeddable library build for the biq-app module shell.
// Produces dist/embed/biq-onboard.js that defines <biq-onboard-app>.
// Mirrors the biq-methodology pattern.
export default defineConfig({
  base: './',
  publicDir: false,
  build: {
    outDir: '../dist/embed',
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: 'src/embed.ts',
      formats: ['es'],
      fileName: () => 'biq-onboard.js',
    },
  },
});
