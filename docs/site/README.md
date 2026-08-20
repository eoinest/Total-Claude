# The documentation site

A self-contained static build of the Markdown in `docs/`. Markdown in, plain HTML out: one
stylesheet, no client-side JavaScript, no framework, no bundler.

## It does not share a build with the game, deliberately

The game is a Vite application whose deployment is verified by bundle hash
(`docs/RELEASING.md` step 2). If the documentation shared that build, adding a page would
change the bundle hash and invalidate a release that had already been verified live.

So this directory has its own `package.json`, its own `node_modules` and its own output. It
does not touch `vite.config.ts`, the root `package.json` scripts, `dist/`, or anything under
`/tmp/tc-release-*`. No root script invokes it. The only coupling is that `build.mjs` *reads*
Markdown out of `docs/`.

## Build

```sh
cd docs/site
npm install          # once; two dev dependencies, marked and highlight.js
npm run build        # → docs/site/dist
```

`dist/` is matched by the root `.gitignore` and is not committed. Build it before deploying.

Flags:

| Flag | Effect |
|---|---|
| `--out=<dir>` | Output directory, relative to `docs/site`. Default `dist`. |
| `--strict` | Exit non-zero if any volume named in `NAV` is missing. Use this for the build you are about to deploy. |

A volume whose Markdown does not exist yet is skipped with a warning and omitted from the nav,
so the site can be built while `docs/tech/SIMULATION.md`, `RENDERING.md` and `SIEGE.md` are
still being written on their own branches. When they land, rebuild — nothing else changes.

## Preview

```sh
npm run serve                    # http://127.0.0.1:8477
node serve.mjs --port=8600
```

**Never port 5173.** That is the owner's playtest server, and `vite.config.ts` pins the game's
dev server to it. `serve.mjs` refuses 5173 outright. Kill the preview by PID.

## Deploy

**Build first, then upload the prebuilt tree.** From the repository root:

```sh
cd docs/site && npm install && npm run build -- --strict && cd ../..
node tools/deploy-vercel.mjs --name total-claude-docs --dir docs/site/dist
```

`tools/deploy-vercel.mjs` posts the tree with `framework: null`, `buildCommand: null` and
`installCommand: null`, so Vercel serves the uploaded files as static output and **cannot run
the game's build even by accident**. `--name` selects the Vercel project, so a name other than
`total-claude` creates and deploys a separate project and the two deployments cannot interfere.

Add `--preview` for a preview deployment rather than production.

## The image rule, enforced rather than remembered

`reference/` and `reference-crops/` hold copyrighted Total War: ROME II press plates and
licensed museum photographs. They are gitignored so they cannot be published by accident, and
"gitignored" is not a mechanism that survives a build script copying files by glob.

`build.mjs` therefore:

1. copies images **one at a time**, only the ones a page actually referenced, and only from
   `docs/images/` — never a directory glob;
2. drops any Markdown image resolving outside `docs/images/` and records a warning;
3. re-checks the **emitted HTML** in `assertNoReferenceImagery`, after every rewrite, and
   exits 3 if any `<img src>` is remote, empty, outside `img/`, or missing from the output;
4. walks the finished output tree and exits 3 if any path matches `reference` or
   `reference-crops`, or if any published raster has no byte-origin in `docs/images/`.

Both refusal arms have been tested against a real reference crop and both fire. The check is
on the artefact, not on the source, because the thing that must be true is about what ships.

## Files

| File | |
|---|---|
| `build.mjs` | The whole build. `NAV` at the top is the site map; edit it to add a page. |
| `style.css` | One stylesheet, light and dark, no webfont. |
| `serve.mjs` | Local preview server. Refuses 5173. |
