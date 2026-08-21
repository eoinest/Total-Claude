import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * Vercel Web Analytics, injected at build time only.
 *
 * The platform serves `/_vercel/insights/script.js` for a project that has analytics
 * enabled. Nothing serves it locally, so a tag written into the source HTML makes every
 * dev page load log a 404 — which `qa-deploy`'s three console arms correctly failed on
 * the moment it was added. Injecting here keeps `dist` instrumented and the dev server
 * quiet, and means a probe that captures `console` is measuring the game rather than a
 * missing analytics beacon.
 */
const vercelAnalytics = () => ({
  name: 'tc-vercel-analytics',
  apply: 'build' as const,
  transformIndexHtml: {
    order: 'post' as const,
    handler: (html: string) =>
      html.replace('</head>', '  <script defer src="/_vercel/insights/script.js"></script>\n  </head>'),
  },
});

export default defineConfig({
  plugins: [vercelAnalytics()],
  /**
   * Where Vite keeps its dependency pre-bundle.
   *
   * Default is `node_modules/.vite`, and every agent worktree in this repo symlinks
   * `node_modules` at the shared checkout — so two agents running a headless gate at the
   * same time write one cache directory from two processes. Set `TC_VITE_CACHE_DIR` to a
   * per-worktree path and each gets its own. Unset, this is exactly the old behaviour.
   */
  cacheDir: process.env.TC_VITE_CACHE_DIR || undefined,
  // Served from the domain root on Vercel, and the runtime fetches
  // `/assets/manifest.json` absolutely, so the base must be absolute too.
  base: '/',
  /**
   * Somewhere for a worktree to put its own dependency and transform cache.
   *
   * Unset — the normal case — this is `undefined` and Vite uses its default,
   * `<pkgDir>/node_modules/.vite`, exactly as it always has. The reason it is a knob at all is
   * that agent worktrees under `.claude/worktrees/` **symlink `node_modules` back to the main
   * checkout**, and Vite resolves that default as a path, through the symlink. So six agents on
   * six branches share one optimiser cache, and the failure that produces is the worst kind: a
   * page that loads perfectly while serving another branch's modules. `tools/film.mjs` sets
   * this per port; any long-running harness in a worktree should too.
   */
  cacheDir: process.env.TC_VITE_CACHE || undefined,
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
