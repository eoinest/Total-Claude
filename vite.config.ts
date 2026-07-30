import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    host: '127.0.0.1',
    // The screenshot and trace harnesses fast-forward a battle over tens of seconds of
    // wall clock. If an agent edits a file during that window, HMR reloads the page and
    // destroys the execution context mid-run, which surfaces as a spurious "page
    // crashed" at a random simulation time. Harness runs set TC_NO_HMR=1.
    hmr: process.env.TC_NO_HMR === '1' ? false : undefined,
    watch: process.env.TC_NO_HMR === '1' ? { ignored: ['**/*'] } : undefined,
  },
  build: {
    target: 'esnext',
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
  },
  assetsInclude: ['**/*.hdr', '**/*.glb', '**/*.gltf', '**/*.ktx2', '**/*.bin'],
});
