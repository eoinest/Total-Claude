import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5173, host: '127.0.0.1' },
  build: {
    target: 'esnext',
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
  },
  assetsInclude: ['**/*.hdr', '**/*.glb', '**/*.gltf', '**/*.ktx2', '**/*.bin'],
});
