import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

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
    // Deliberately NOT `watch: { ignored: ['**/*'] }`. Ignoring every file stops Vite
    // invalidating its module graph, so a long-lived dev server keeps serving stale TS
    // transforms indefinitely — an agent measured an "after" shot that was silently
    // still the "before" code. Disabling HMR alone is enough: the client never gets a
    // reload pushed at it mid-run, but each fresh page load still gets fresh transforms.
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
    rollupOptions: {
      /**
       * Two pages, one build. `viewer.html` is the model inspector; it imports the same
       * `src/units` and `src/anim` modules the game does, so Rollup hoists those into a
       * chunk both entries share rather than duplicating them. Measured against a game-only
       * build of the same source: 1,876 KB to 1,964 KB, so +88 KB, of which 80 KB is the
       * viewer's own three files. Everything expensive — the mesh builders, the clip library,
       * three itself — was already being shipped for the game. A visitor who only plays the
       * game downloads about a kilobyte more gzipped, which is the cost of the split.
       *
       * Listing `index.html` explicitly is required: the moment `input` is set, Vite stops
       * inferring the root `index.html`, and omitting it would silently ship a deployment
       * with no game in it.
       */
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        viewer: fileURLToPath(new URL('./viewer.html', import.meta.url)),
      },
    },
  },
  assetsInclude: ['**/*.hdr', '**/*.glb', '**/*.gltf', '**/*.ktx2', '**/*.bin'],
});
