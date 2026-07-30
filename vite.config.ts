import { defineConfig } from 'vite';

export default defineConfig({
  // Served from the domain root on Vercel, and the runtime fetches
  // `/assets/manifest.json` absolutely, so the base must be absolute too.
  base: '/',
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
    // Source maps ship the entire TypeScript source and were 5.82 MiB of a 31 MiB
    // deployment - a quarter of the payload, and more than the whole optimised asset set.
    // Opt in with SOURCEMAP=1 when debugging a production build.
    sourcemap: process.env.SOURCEMAP === '1',
    chunkSizeWarningLimit: 4096,
    // NOT the default 'assets'. `public/assets/` holds the downloaded texture and HDRI
    // set, which Vite copies verbatim into the output root — so leaving the bundle
    // directory at its default would have Vite's own JS and CSS share a directory with
    // them, and `tools/optimize-assets.mjs` (which clears and rewrites `dist/assets`)
    // would delete the application bundle along with the originals.
    assetsDir: 'bundle',
  },
  assetsInclude: ['**/*.hdr', '**/*.glb', '**/*.gltf', '**/*.ktx2', '**/*.bin'],
});
