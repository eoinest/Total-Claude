/**
 * rome-wayscan — the road survey's arithmetic half, with no browser and no dev server.
 *
 * Authoring twenty-four ways against a plate needs a loop tighter than a 90-second page boot,
 * and `docs/ROME-FABRIC.md` §8.8 makes the same point about the landmark survey: the plate
 * instrument became useful when it stopped needing a browser.
 *
 * **It bundles the real modules; it does not re-implement them.** `tools/scratch/free-land.mjs`
 * re-implements `districtMask` by hand and can therefore agree with a stale copy of the thing it
 * grades — `MAP-METHOD.md` rule 6, and `ROME-FABRIC.md` §2.5 lists it by name. So this runs
 * `src/city/rome/assertions.ts`'s own `assertWaysClearOfMonuments` and `assertWayGraph` over
 * `layout.ts`'s own `WAYS` and `LANDMARKS`, compiled through Vite's SSR build. If it disagrees
 * with the boot log it is wrong, and the boot log is the authority: `--verify` prints the two
 * headline numbers so the comparison takes one line.
 *
 *   node tools/scratch/rome-wayscan.mjs            per way, per monument, and the graph
 *   node tools/scratch/rome-wayscan.mjs --pairs    every offending way/monument pair, with the
 *                                                  world clearance it is short by
 */
import { build } from 'vite';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../..');
const argv = process.argv.slice(2);

/**
 * The bundle lands inside the repo, in the gitignored `tools/scratch/.try/`, and not in
 * `/tmp`. Vite externalises `three`, so a bundle written outside the tree cannot resolve it —
 * a worktree symlinks `node_modules` at the shared checkout and Node walks *upwards* from the
 * importing file to find it.
 */
const dir = resolve(ROOT, 'tools/scratch/.try/wayscan');
mkdirSync(dir, { recursive: true });
const entry = join(dir, 'entry.ts');
writeFileSync(
  entry,
  // Survey first, deliberately: `survey.ts` is the root of the cycle and a bundler that
  // hoists `layout.ts` above it evaluates `ROME.filter(...)` against an uninitialised binding.
  `export { worldOf, KX, KZ } from '${resolve(ROOT, 'src/city/rome/survey.ts')}';\n`
  + `export { romeWallZ } from '${resolve(ROOT, 'src/terrain/topography.ts')}';\n`
  + `export { ROME_WAYS, wayBearingAt } from '${resolve(ROOT, 'src/city/rome/ways.ts')}';\n`
  + `export { WAYS, LANDMARKS, WAY_RANK, WAY_WIDTH, DISTRICTS } from '${resolve(ROOT, 'src/city/rome/layout.ts')}';\n`
  + `export { assertWaysClearOfMonuments, assertWayGraph } from '${resolve(ROOT, 'src/city/rome/assertions.ts')}';\n`
);

await build({
  root: ROOT,
  logLevel: 'error',
  /**
   * **One alias, and it is an identity rather than a substitution.**
   *
   * `survey.ts` reads `HALF_EXTENT` from `terrain/TerrainSystem.ts`; `TerrainSystem` imports
   * `activeMap` from `src/maps`, which loads every map definition, which loads every city plan,
   * which loads `rome/layout.ts` — a cycle that the browser's live bindings absorb and a bundle
   * does not. `TerrainSystem` gets `HALF_EXTENT` from `./topography` on its own line 14, so
   * pointing the import straight at `topography.ts` is the *same constant by the same
   * derivation* with the scene graph left out of it. Nothing else is aliased, and in particular
   * nothing in `layout.ts`, `ways.ts` or `assertions.ts` is: those are the modules under test.
   */
  resolve: {
    alias: [{ find: /.*\/terrain\/TerrainSystem$/, replacement: resolve(ROOT, 'src/terrain/topography.ts') }],
  },
  build: {
    ssr: entry,
    outDir: dir,
    emptyOutDir: true,
    write: true,
    // `preserveModules`, and it is not a preference. `layout.ts`, `survey.ts` and
    // `assertions.ts` form an import cycle that ES module live bindings resolve and a
    // flattened bundle does not: concatenated into one file, `SURVEY_IDS = new Set(ROME.map(...))`
    // runs before `ROME` is initialised and throws. Keeping the module graph keeps Node's own
    // cycle handling, which is the same handling the app gets.
    rollupOptions: { output: { preserveModules: true, entryFileNames: '[name].mjs', format: 'es' } },
  },
});

/**
 * **Import `survey.mjs` before `entry.mjs`, and the ordering is load-bearing.**
 *
 * `survey.ts` reads `HALF_EXTENT` out of `terrain/TerrainSystem.ts`, which pulls in enough of
 * the scene graph to close a cycle back to `layout.ts`. Under Vite's dev server and in the
 * browser the ES module live bindings make that harmless; a flattened SSR bundle evaluates
 * `LANDMARKS = ROME.filter(...)` before `ROME` exists and throws. Evaluating the survey module
 * first — which is what the app effectively does — puts the cycle back in the order that works.
 */
await import(pathToFileURL(join(dir, 'src/city/rome/survey.mjs')).href);
// `preserveModules` mirrors each source file's path under `outDir`, so the entry lands at its
// own path relative to the project root rather than at the top.
const M = await import(
  pathToFileURL(join(dir, 'tools/scratch/.try/wayscan/entry.mjs')).href
);

const way = M.assertWaysClearOfMonuments();
const graph = M.assertWayGraph();

console.log('=== ranked ways inside a monument (the carriageway, in world metres) ===');
console.log(
  `  ${way.inside}/${way.samples} samples = ${((100 * way.inside) / way.samples).toFixed(1)} %`
);
for (const w of way.byWay) {
  if (!w.inside) continue;
  console.log(`  ${w.id.padEnd(22)} ${String(w.pct).padStart(3)} %  ${w.inside}/${w.samples}  ${w.hit.join(' + ')}`);
}
const clean = way.byWay.filter((w) => !w.inside).map((w) => w.id);
console.log(`  clear: ${clean.join(', ')}`);

console.log('\n=== the same question in SURVEY metres, against the published footprints ===');
console.log(`  ${way.survey.inside}/${way.survey.samples} samples = ${way.survey.pct} %`);
for (const w of way.survey.byWay) {
  if (!w.inside) continue;
  console.log(`  ${w.id.padEnd(22)} ${String(w.pct).padStart(3)} %  ${w.inside}/${w.samples}  ${w.hit.join(' + ')}`);
}
console.log(`  clear: ${way.survey.byWay.filter((w) => !w.inside).map((w) => w.id).join(', ')}`);

console.log('\n=== the graph ===');
console.log(`  ${graph.ways} ways; consular-and-above in ${graph.rankedComponents} piece(s); ok=${graph.ok}`);
for (const g of graph.gates) console.log(`  gate ${g.id.padEnd(20)} -> ${g.on ?? 'NOTHING'} ${g.cls ?? ''}`);
for (const d of graph.dangling) console.log(`  end  ${d.way.padEnd(22)} (${d.x}, ${d.z})  ${d.why}`);
for (const f of graph.faults) console.log(`  FAULT ${f}`);

if (argv.includes('--gates')) {
  /**
   * Why a gate mouth is or is not on a consular way. Prints the mouth point, then for every
   * consular-and-above way the perpendicular distance from the mouth to its nearest segment and
   * that segment's angle to the curtain — which is the pair of numbers the check gates on.
   */
  console.log('\n=== gate mouths, and what is near them ===');
  const R = M.WAY_RANK;
  const fold180 = (d) => { let a2 = d % Math.PI; if (a2 > Math.PI / 2) a2 -= Math.PI; if (a2 < -Math.PI / 2) a2 += Math.PI; return a2; };
  for (const g of M.assertWayGraph().gates) {
    const mz = M.romeWallZ(g.x) + 26;
    const tangent = Math.atan2(M.romeWallZ(g.x + 12) - M.romeWallZ(g.x - 12), 24);
    console.log(`  ${g.id.padEnd(20)} mouth (${g.x.toFixed(1)}, ${mz.toFixed(1)})  crest ${M.romeWallZ(g.x).toFixed(1)}  tangent ${((tangent * 180) / Math.PI).toFixed(1)} deg  -> ${g.on ?? 'NOTHING'}`);
    for (const w of M.WAYS) {
      if (R[w.cls] < R.secondary) continue;
      let bd = Infinity;
      let bb = 0;
      for (let i = 0; i + 1 < w.path.length; i++) {
        const a2 = w.path[i];
        const b2 = w.path[i + 1];
        const ax = b2.x - a2.x;
        const az = b2.z - a2.z;
        const l2 = ax * ax + az * az;
        const t = l2 < 1e-6 ? 0 : Math.max(0, Math.min(1, ((g.x - a2.x) * ax + (mz - a2.z) * az) / l2));
        const d = Math.hypot(g.x - (a2.x + ax * t), mz - (a2.z + az * t));
        if (d < bd) { bd = d; bb = Math.atan2(az, ax); }
      }
      if (bd > 120) continue;
      console.log(
        `      ${w.id.padEnd(20)} dist ${bd.toFixed(1)} (half-width ${(w.width / 2).toFixed(0)})`
        + `  angle to curtain ${Math.abs((fold180(bb - tangent) * 180) / Math.PI).toFixed(1)} deg (needs > 35)`
      );
    }
  }
}

if (argv.includes('--pairs')) {
  // Per pair, how far the way's centreline would have to move to clear the box. Reported in
  // BOTH frames, because the whole difficulty of this map is that they are not the same
  // number: positions compress by KX/KZ and monument cross-sections do not, so 100 real metres
  // of clearance in the east is 44 world metres against a box that kept its true size.
  console.log('\n=== worst pair, per way: world shortfall, and what it is in survey metres ===');
  const solids = M.LANDMARKS.filter((l) => !l.soft);
  for (const w of M.WAYS) {
    if (M.WAY_RANK[w.cls] < M.WAY_RANK.secondary) continue;
    let worst = null;
    for (let i = 0; i + 1 < w.path.length; i++) {
      const a = w.path[i];
      const b = w.path[i + 1];
      const steps = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.z - a.z) / 10));
      for (let s = 0; s <= steps; s++) {
        const x = a.x + ((b.x - a.x) * s) / steps;
        const z = a.z + ((b.z - a.z) * s) / steps;
        for (const l of solids) {
          const dx = x - l.x;
          const dz = z - l.z;
          const cs = Math.cos(l.rot);
          const sn = Math.sin(l.rot);
          const u = Math.abs(dx * cs - dz * sn) - l.hw;
          const v = Math.abs(dx * sn + dz * cs) - l.hd;
          const gap = Math.max(u, v);
          const need = w.width * 0.5 - gap;
          if (need > 0 && (!worst || need > worst.need)) {
            worst = { id: l.id, need, x, z, hw: l.hw, hd: l.hd, lx: l.x, lz: l.z };
          }
        }
      }
    }
    if (!worst) continue;
    console.log(
      `  ${w.id.padEnd(22)} ${worst.id.padEnd(20)} short by ${worst.need.toFixed(1)} world m`
      + `  (box ${(worst.hw * 2).toFixed(0)} x ${(worst.hd * 2).toFixed(0)} world m at ${worst.lx.toFixed(0)},${worst.lz.toFixed(0)};`
      + ` way at ${worst.x.toFixed(0)},${worst.z.toFixed(0)})`
      + `  = ${(worst.need / M.KX).toFixed(0)} survey m east or ${(worst.need / M.KZ).toFixed(0)} north`
    );
  }
}

rmSync(dir, { recursive: true, force: true });
