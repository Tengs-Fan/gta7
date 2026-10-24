import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the production build works from any static host or sub-path.
  base: './',
  build: {
    target: 'es2022',
    // Models and textures are fetched by URL at boot; none may become a data: URI.
    assetsInlineLimit: 0,
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 5173 },
  preview: { port: 4173 },
});
