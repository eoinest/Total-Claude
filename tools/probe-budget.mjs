#!/usr/bin/env node
/**
 * The frame budget, per camera per tier, with attribution.
 *
 * `probe-draws.mjs` counts what *should* draw by rebuilding the frustum in JavaScript.
 * That is useful for attribution and it is not the budget: the budget is
 * `renderer.info.render.calls` after a real frame, which includes the shadow cascades, the
 * depth prepass and every fullscreen post pass. This reports both, side by side, so a gap
 * between them is visible rather than inferred.
 *
 * It also dumps the city's LOD ladder — every chunk's radius, the distance the switcher
 * actually computes, and which level is live — because a switch distance measured to a
 * chunk's *surface* is silently unreachable when the chunk is wider than the distance.
 *
 *   node tools/probe-budget.mjs --port=5477 --tiers=ultra,high,medium,low
 *   node tools/probe-budget.mjs --port=5477 --lod --scenario=assault
 */

import path from 'node:path';
import process from 'node:process';
import { launchBrowser } from './lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
void ROOT;

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5477);
const W = Number(args.get('w') ?? 1920);
const H = Number(args.get('h') ?? 1080);
const SCENARIO = args.get('scenario') ?? 'assault';
const MAP = args.get('map') ?? '';
const TIERS = String(args.get('tiers') ?? 'ultra').split(',');
const LOD = args.has('lod');
/**
 * Sim seconds to run before measuring. This matters more than it looks: the assault boots
 * into a deployment phase with `strength` all zero and three of sixteen soldier meshes
 * submitted, so a frame measured at t=0 is a frame with no battle in it.
 */
const AT = Number(args.get('at') ?? 0);

/**
 * The cameras named in the brief. `assault` is the scenario's own boot framing — the one
 * measured at 268 — captured by not calling `setCamera` at all.
 */
/**
 * `assault: null` means the scenario's own boot framing — the one the 268 figure came from.
 * It has to be captured before anything else moves the rig, because `setCamera` is a jump
 * with no undo and the second tier's pass would otherwise photograph the previous camera.
 */
const CAMS = {
  assault: null,
  clash: { x: 15, z: -17, zoom: 0.30, yaw: -1.92 },
  melee: { x: -28, z: -37, zoom: 0.30, yaw: -1.79 },
  wide: { x: 0, z: 90, zoom: 0.72, yaw: Math.PI * 0.82 },
  romanline: { x: -100, z: 128, zoom: 0.36, yaw: Math.PI * 1.42 },
  raking: { x: -20, z: 120, zoom: 0.22, yaw: Math.PI * 1.72 },
  terrain: { x: -560, z: -420, zoom: 0.44, yaw: Math.PI * 0.4 },
  city: { x: 40, z: 620, zoom: 0.74, yaw: Math.PI * 0.06 },
  wall: { x: -120, z: 470, zoom: 0.58, yaw: 0.0 },
};
const requested = args.get('cams') ? String(args.get('cams')).split(',') : Object.keys(CAMS);

const base = `http://127.0.0.1:${PORT}`;
const r = await fetch(base, { signal: AbortSignal.timeout(4000) }).catch(() => null);
if (!r?.ok) throw new Error(`no dev server on ${base} — start your own, do not borrow one`);
console.log(`source: ${base} (my server; confirmed 200)`);

/*
 * `launchBrowser` — 22 Aug 2026. This file already refuses to start or borrow a server; the
 * one thing it did without asking anybody was open a browser, and twelve agents doing that at
 * once is what took the machine down. The slot is released by `browser.close()` below.
 */
const browser = await launchBrowser({
  label: 'probe-budget', port: PORT, root: ROOT,
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });

const url = `${base}/?harness=1&quality=${TIERS[0]}&w=${W}&h=${H}&scenario=${SCENARIO}`
  + (MAP ? `&map=${MAP}` : '');
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 240000 });
await page.addStyleTag({ content: '#hud-root, #loading { display: none !important; }' });
console.log(`booted: ready=true, ${errors.length} error(s) so far`);

CAMS.assault = await page.evaluate(() => {
  const r = window.__game.engine.rig;
  return { x: r.focus.x, z: r.focus.z, zoom: r.zoom, yaw: r.yaw };
});
console.log(`boot framing (the "assault camera"): x ${CAMS.assault.x.toFixed(0)} z ${CAMS.assault.z.toFixed(0)}`
  + ` zoom ${CAMS.assault.zoom.toFixed(2)} yaw ${CAMS.assault.yaw.toFixed(2)}`);

/** Attribution: submitted meshes by top-level scene child, plus the frame's real counters. */
const measure = () => page.evaluate(() => {
  const g = window.__game;
  const ctx = g.engine.context;
  const renderer = ctx.renderer;
  const scene = ctx.scene;
  const cam = ctx.camera;
  const postfx = ctx.tryGet('postfx');

  /**
   * Decomposition by instrumentation, not by ablation. `Engine` sets
   * `renderer.info.autoReset = false` and resets once per frame, so the counter accumulates
   * across every `render()` in the frame — which means wrapping the two entry points and
   * differencing the counter gives an exact split with nothing switched off. Ablation was
   * tried first and reported the shadow passes at exactly zero draws, which is the shape of
   * an arm that never ran rather than a real number.
   */
  if (!window.__budgetHooked) {
    window.__budgetHooked = true;
    window.__budget = { shadow: 0, renders: [] };
    const sm = renderer.shadowMap;
    const smRender = sm.render.bind(sm);
    sm.render = (...a) => {
      const b = renderer.info.render.calls;
      smRender(...a);
      window.__budget.shadow += renderer.info.render.calls - b;
    };
    const rRender = renderer.render.bind(renderer);
    renderer.render = (...a) => {
      const b = renderer.info.render.calls;
      rRender(...a);
      window.__budget.renders.push(renderer.info.render.calls - b);
    };
  }
  window.__budget.shadow = 0;
  window.__budget.renders = [];
  g.engine.frame(g.engine.time.elapsed * 1000 + 16.7);
  const b = window.__budget;
  const frame = {
    draws: renderer.info.render.calls,
    tris: renderer.info.render.triangles,
    shadow: b.shadow,
    // The first `render()` of the frame is the world into the scene target; every later one
    // is a fullscreen pass.
    main: (b.renders[0] ?? 0) - b.shadow,
    post: b.renders.slice(1).reduce((s, n) => s + n, 0),
    passes: b.renders.length,
    postEnabled: postfx ? postfx.enabled : null,
  };

  cam.updateMatrixWorld();
  const m = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse);
  const e = m.elements;
  const planes = [];
  const add = (a, b, c, d) => { const l = Math.hypot(a, b, c) || 1; planes.push([a / l, b / l, c / l, d / l]); };
  add(e[3] - e[0], e[7] - e[4], e[11] - e[8], e[15] - e[12]);
  add(e[3] + e[0], e[7] + e[4], e[11] + e[8], e[15] + e[12]);
  add(e[3] + e[1], e[7] + e[5], e[11] + e[9], e[15] + e[13]);
  add(e[3] - e[1], e[7] - e[5], e[11] - e[9], e[15] - e[13]);
  add(e[3] - e[2], e[7] - e[6], e[11] - e[10], e[15] - e[14]);
  add(e[3] + e[2], e[7] + e[6], e[11] + e[10], e[15] + e[14]);

  const visibleChain = (o) => { let n = o; while (n) { if (!n.visible) return false; n = n.parent; } return true; };
  const owner = (o) => { let n = o; while (n.parent && n.parent !== scene) n = n.parent; return n.name || n.type; };
  const counts = new Map();
  scene.traverse((o) => {
    if (!o.isMesh && !o.isLine && !o.isPoints) return;
    if (!visibleChain(o)) return;
    if (o.isInstancedMesh && o.count === 0) return;
    if (o.frustumCulled && o.geometry?.boundingSphere) {
      o.updateWorldMatrix(true, false);
      const c = o.geometry.boundingSphere.center.clone().applyMatrix4(o.matrixWorld);
      const sc = o.matrixWorld.getMaxScaleOnAxis();
      const rr = o.geometry.boundingSphere.radius * sc;
      let out = false;
      for (const p of planes) if (p[0] * c.x + p[1] * c.y + p[2] * c.z + p[3] < -rr) { out = true; break; }
      if (out) return;
    }
    const key = owner(o);
    const idx = o.geometry?.index;
    const pos = o.geometry?.attributes?.position;
    let tris = idx ? idx.count / 3 : pos ? pos.count / 3 : 0;
    const inst = o.isInstancedMesh ? o.count : (o.geometry?.instanceCount ?? 1);
    tris *= Number.isFinite(inst) ? inst : 1;
    const rec = counts.get(key) ?? { draws: 0, tris: 0 };
    rec.draws += 1; rec.tris += tris;
    counts.set(key, rec);
  });

  // Every top-level scene child with its submitted-mesh count, so nothing can hide behind an
  // unnamed Group. Soldiers went missing from the first attribution pass this way.
  const tops = scene.children.map((c) => {
    let meshes = 0;
    let inst = 0;
    c.traverse((o) => {
      if (!o.isMesh && !o.isLine && !o.isPoints) return;
      if (!visibleChain(o)) return;
      // Instancing arrives two ways: `InstancedMesh.count` for city and siege, and
      // `InstancedBufferGeometry.instanceCount` for the soldiers, grass and vegetation.
      // Reading only the first reported every soldier tier as an ordinary mesh.
      const n = o.isInstancedMesh ? o.count : o.geometry?.instanceCount;
      if (Number.isFinite(n)) { if (n === 0) return; inst += n; }
      meshes += 1;
    });
    return { name: c.name || `<${c.type}>`, meshes, inst };
  }).filter((t) => t.meshes > 0).sort((a, b) => b.meshes - a.meshes);

  const battle = ctx.tryGet('battle');
  const city = ctx.tryGet('city');
  return {
    frame,
    tops,
    sim: { t: +g.simTime().toFixed(1), pool: battle?.pool?.count ?? -1, strength: battle?.strength ?? null },
    visible: [...counts.entries()].map(([k, v]) => ({ k, draws: v.draws, tris: Math.round(v.tris) }))
      .sort((a, b) => b.draws - a.draws),
    cityStats: city?.stats ? city.stats() : null,
    camPos: { x: +cam.position.x.toFixed(0), y: +cam.position.y.toFixed(0), z: +cam.position.z.toFixed(0) },
  };
});

/**
 * What is actually in each shadow cascade, by replicating `WebGLShadowMap`'s own cull: an
 * object is drawn into cascade `i` if it casts and its bounding sphere meets that cascade's
 * ortho frustum. Validated against the instrumented pass total — if the two disagree the
 * replication is wrong and the attribution must not be quoted.
 */
const shadowTable = () => page.evaluate(() => {
  const ctx = window.__game.engine.context;
  const scene = ctx.scene;
  const lights = [];
  scene.traverse((o) => { if (o.isDirectionalLight && o.castShadow && o.shadow) lights.push(o); });
  const owner = (o) => { let n = o; while (n.parent && n.parent !== scene) n = n.parent; return n.name || `<${n.type}>`; };

  const casters = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.castShadow) return;
    let n = o; let vis = true;
    while (n) { if (!n.visible) { vis = false; break; } n = n.parent; }
    if (!vis) return;
    const c = o.isInstancedMesh ? o.count : o.geometry?.instanceCount;
    if (Number.isFinite(c) && c === 0) return;
    o.updateWorldMatrix(true, false);
    if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
    casters.push(o);
  });

  const planesOf = (cam) => {
    cam.updateMatrixWorld();
    const m = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse);
    const e = m.elements;
    const out = [];
    const add = (a, b, c, d) => { const l = Math.hypot(a, b, c) || 1; out.push([a / l, b / l, c / l, d / l]); };
    add(e[3] - e[0], e[7] - e[4], e[11] - e[8], e[15] - e[12]);
    add(e[3] + e[0], e[7] + e[4], e[11] + e[8], e[15] + e[12]);
    add(e[3] + e[1], e[7] + e[5], e[11] + e[9], e[15] + e[13]);
    add(e[3] - e[1], e[7] - e[5], e[11] - e[9], e[15] - e[13]);
    add(e[3] - e[2], e[7] - e[6], e[11] - e[10], e[15] - e[14]);
    add(e[3] + e[2], e[7] + e[6], e[11] + e[10], e[15] + e[14]);
    return out;
  };

  const rows = [];
  let total = 0;
  for (let i = 0; i < lights.length; i++) {
    const cam = lights[i].shadow.camera;
    const planes = planesOf(cam);
    const by = new Map();
    let n = 0;
    for (const o of casters) {
      const bs = o.geometry.boundingSphere;
      const c = bs.center.clone().applyMatrix4(o.matrixWorld);
      const r = bs.radius * o.matrixWorld.getMaxScaleOnAxis();
      let out = false;
      if (o.frustumCulled !== false) {
        for (const p of planes) if (p[0] * c.x + p[1] * c.y + p[2] * c.z + p[3] < -r) { out = true; break; }
      }
      if (out) continue;
      n++;
      const k = owner(o);
      by.set(k, (by.get(k) ?? 0) + 1);
    }
    total += n;
    rows.push({
      cascade: i,
      extent: `${(cam.right - cam.left).toFixed(0)}x${(cam.top - cam.bottom).toFixed(0)}m`,
      draws: n,
      by: [...by.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '),
    });
  }
  return { rows, total, casters: casters.length };
});

/** The city LOD ladder, read out of the live chunk list rather than from the source. */
const lodTable = () => page.evaluate(() => {
  const ctx = window.__game.engine.context;
  const city = ctx.tryGet('city');
  if (!city) return null;
  const chunks = city.chunks ?? city._chunks;
  if (!chunks) return { error: 'chunks not reachable from the outside' };
  const cam = ctx.camera.position;
  return chunks.map((c) => {
    const d0 = Math.hypot(cam.x - c.cx, cam.y - c.cy, cam.z - c.cz);
    // The same expression `CitySystem.surfaceCorrection` uses, and the uncapped 0.55 beside
    // it. Printed rather than assumed: the first version of this table quoted only the raw
    // 0.55 and went on flagging a ladder that had already been fixed.
    const nearSwitch = c.switchAt.length > 0 ? c.switchAt[0] : Infinity;
    const corr = Math.min(c.radius * 0.55, nearSwitch * 0.5);
    return {
      name: c.name,
      radius: +c.radius.toFixed(0),
      correction: +corr.toFixed(0),
      raw: +(c.radius * 0.55).toFixed(0),
      centreD: +d0.toFixed(0),
      surfaceD: +Math.max(0, d0 - corr).toFixed(0),
      switchAt: c.switchAt.map((n) => (n > 1e8 ? Infinity : +n.toFixed(0))),
      levels: c.levels.length,
      current: c.current,
      meshes: c.levels.map((l) => l.group.children.length),
      visMeshes: c.levels[c.current].group.children.length,
    };
  });
});

if (AT > 0) {
  await page.evaluate((t) => window.__game.advance(t), AT);
  const s = await page.evaluate(() => ({
    t: window.__game.simTime(),
    strength: window.__game.engine.context.tryGet('battle')?.strength,
  }));
  console.log(`advanced to t+${s.t.toFixed(1)}s, strength ${JSON.stringify(s.strength)}`);
}

for (const tier of TIERS) {
  await page.evaluate((t) => { window.__game.engine.setQuality(t); }, tier);
  await page.evaluate(() => { window.__game.engine.time.paused = true; window.__game.engine.advance(0.2); });
  console.log(`\n################  tier=${tier}  ${W}x${H}  scenario=${SCENARIO}${MAP ? ` map=${MAP}` : ''}  ################`);
  for (const name of requested) {
    const c = CAMS[name];
    if (!c) { console.error(`unknown camera ${name}`); continue; }
    await page.evaluate((s) => { window.__game.setCamera(s.x, s.z, s.zoom, s.yaw); }, c);
    // Let the rig damp in and the LOD hysteresis settle before reading.
    await page.evaluate(() => { for (let i = 0; i < 12; i++) window.__game.engine.advance(1 / 60); });
    const out = await measure();
    const over = out.frame.draws - 220;
    console.log(`\n=== ${name.padEnd(10)} eye(${out.camPos.x},${out.camPos.y},${out.camPos.z})`
      + ` t+${out.sim.t}s  renderer.info ${out.frame.draws} draws  ${(out.frame.tris / 1e6).toFixed(2)}M tris`
      + `  [${over > 0 ? `+${over} OVER` : `${-over} spare`}]`);
    console.log(`  decomposition: main ${out.frame.main}  + shadow ${out.frame.shadow}`
      + `  + post ${out.frame.post} over ${out.frame.passes} render() calls`);
    if (out.cityStats) {
      const s = out.cityStats;
      console.log(`  city: ${s.visibleMeshes} visible meshes, ${(s.visibleTriangles / 1e6).toFixed(2)}M tris`
        + `, by family ${s.drawsByFamily.map((f) => `${f.family}:${f.meshes}`).join(' ')}`);
    }
    const line = out.visible.map((v) => `${v.k}:${v.draws}`).join('  ');
    console.log(`  post-cull attribution (${out.visible.reduce((a, v) => a + v.draws, 0)} total): ${line}`);
    console.log(`  scene children, submitted meshes (${out.tops.reduce((a, v) => a + v.meshes, 0)} total): `
      + out.tops.map((t) => `${t.name}:${t.meshes}${t.inst ? `[${t.inst}i]` : ''}`).join('  '));
    if (args.has('shadow')) {
      const s = await shadowTable();
      const agree = s.total === out.frame.shadow ? 'agrees with the instrumented pass'
        : `DISAGREES with the instrumented pass (${out.frame.shadow}) — do not quote the attribution`;
      console.log(`  shadow: ${s.casters} casters in scene, replication total ${s.total} — ${agree}`);
      for (const r of s.rows) {
        console.log(`    cascade ${r.cascade} ${r.extent.padStart(12)}  ${String(r.draws).padStart(3)} draws   ${r.by}`);
      }
    }
    if (LOD) {
      const t = await lodTable();
      if (t && !t.error) {
        console.log('    chunk                 radius  corr   raw  centreD  surfD   switchAt          lvl/of  meshes');
        for (const row of t) {
          const reach = row.switchAt.length ? row.switchAt[0] : Infinity;
          // The defect this column exists for: when the surface correction is at least the
          // near switch distance, no camera anywhere can push the chunk past that switch, so
          // the chunk is pinned at full detail for the whole game. `raw` is what the
          // correction would be uncapped, so a capped row shows the fix doing work.
          const pinned = row.correction >= reach;
          console.log(`    ${row.name.padEnd(20)} ${String(row.radius).padStart(6)} ${String(row.correction).padStart(5)}`
            + ` ${String(row.raw).padStart(5)} ${String(row.centreD).padStart(8)} ${String(row.surfaceD).padStart(6)}`
            + `   [${row.switchAt.join(', ')}]`.padEnd(18)
            + ` ${row.current}/${row.levels - 1}   ${row.meshes.join('/')}`
            + (pinned ? '   <-- PINNED AT FULL DETAIL: correction >= near switch' : '')
            + (!pinned && row.raw >= reach ? '   (was pinned; the cap freed it)' : ''));
        }
      } else if (t) {
        console.log(`    lod: ${t.error}`);
      }
    }
  }
}

if (errors.length) {
  console.log(`\n!! ${errors.length} page error(s):`);
  for (const e of errors.slice(0, 12)) console.log(`   ${e}`);
}
await browser.close();
