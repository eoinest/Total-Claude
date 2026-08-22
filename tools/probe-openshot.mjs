#!/usr/bin/env node
/**
 * Probe: what the opening frame of a siege actually shows.
 *
 * The deployment phase's whole job is arranging men on and against a wall, so the one thing
 * the opening shot has to contain is the wall. This measures whether it does, off the render
 * matrix rather than off anybody's arithmetic:
 *
 *   - where the crest of each bay near the gate lands in screen pixels,
 *   - the x-extent the curtain occupies across the frame,
 *   - how much ground in front of the wall is in frame below it,
 *   - and how close the eye is to the nearest solid thing in the scene, because `place()`'s
 *     `minClear` lifts the eye over *terrain* and knows nothing about a hedge.
 *
 * `--sweep=zoom:frac,...` re-aims the camera at each candidate in the same page and measures
 * every one, so a framing rule can be chosen against real projections rather than against a
 * closed form that may not match the rig.
 *
 * Usage: node tools/probe-openshot.mjs [--port=5347] [--maps=carthage,campus-martius]
 *                                      [--shots=dir] [--json=path] [--tag=before]
 *                                      [--sweep=0.62:0.5,0.66:0.5]
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnVite } from './lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5347);
const MAPS = (args.get('maps') ?? 'carthage,campus-martius').split(',');
const SHOT_DIR = args.get('shots') ? path.resolve(ROOT, args.get('shots')) : null;
const JSON_OUT = args.get('json') ?? null;
const TAG = args.get('tag') ?? 'shot';
const W = Number(args.get('w') ?? 1600);
const H = Number(args.get('h') ?? 900);
const SWEEP = args.get('sweep')
  ? args.get('sweep').split(',').map((s) => s.split(':').map(Number))
  : null;

const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (!(await waitForServer(base, 1200))) {
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 90000))) { console.error('vite did not start'); process.exit(1); }
}
console.log(`server ${base}${server ? ' (started here)' : ' (already up)'}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
if (SHOT_DIR) await mkdir(SHOT_DIR, { recursive: true });

/** Everything measured in the page, in one evaluate so nothing can drift between calls. */
const MEASURE = ([W, H]) => {
  const g = window.__game;
  const ctx = g.engine.context;
  const cam = ctx.camera;
  const rig = g.engine.rig;
  cam.updateMatrixWorld(true);
  const V = cam.position.constructor;
  const v = new V();
  const dir = cam.getWorldDirection(new V());
  const eye = cam.position;

  const project = (x, y, z) => {
    v.set(x, y, z).project(cam);
    const behind = (x - eye.x) * dir.x + (y - eye.y) * dir.y + (z - eye.z) * dir.z < 0;
    return {
      x: +((v.x * 0.5 + 0.5) * W).toFixed(1),
      y: +((-v.y * 0.5 + 0.5) * H).toFixed(1),
      behind,
      offFrame: behind || v.x < -1 || v.x > 1 || v.y < -1 || v.y > 1,
    };
  };

  const city = ctx.tryGet('city');
  const bays = city?.getGarrisonBays?.() ?? [];
  const gate = (city?.getGates?.() ?? [])[0] ?? null;
  const gateBay = bays.find((b) => b.isGate) ?? bays[Math.floor(bays.length / 2)] ?? null;

  /** March a screen ray until it goes under the terrain; the ground point it hits. */
  const groundAtPixel = (px, py) => {
    const p = new V((px / W) * 2 - 1, -((py / H) * 2 - 1), 0.5);
    p.unproject(cam);
    const d = p.sub(eye).normalize();
    if (d.y >= -1e-4) return null;
    let t = 0;
    for (let i = 0; i < 3000; i++) {
      t += 1.5;
      if (t > 3000) return null;
      if (eye.y + d.y * t - g.battle.groundAt(eye.x + d.x * t, eye.z + d.z * t) <= 0) {
        let lo = t - 1.5, hi = t;
        for (let k = 0; k < 24; k++) {
          const m = (lo + hi) * 0.5;
          if (eye.y + d.y * m - g.battle.groundAt(eye.x + d.x * m, eye.z + d.z * m) > 0) lo = m;
          else hi = m;
        }
        const tt = (lo + hi) * 0.5;
        return {
          x: +(eye.x + d.x * tt).toFixed(1), z: +(eye.z + d.z * tt).toFixed(1),
          dist: +tt.toFixed(1),
        };
      }
    }
    return null;
  };

  /**
   * The nearest solid thing to the eye, instance by instance.
   *
   * A hedge is one matrix inside an `InstancedMesh` whose own bounding sphere covers the
   * map, so asking the mesh is useless — the instances have to be walked. Clearance is
   * distance from the eye to the instance's bounding sphere, so negative means inside it.
   *
   * **Radius sanity is part of the instrument.** The first version of this reported a
   * clearance of −2,205,242 m against a bounding sphere of radius 2,205,939 m: the foliage
   * billboards share one quad geometry that is expanded in the vertex shader, so its CPU-side
   * bounding sphere is meaningless. Anything claiming to be bigger than a plane tree is the
   * instrument talking and is dropped.
   */
  const nearestSolid = () => {
    const hits = [];
    /*
     * The rejects, kept rather than only counted.
     *
     * Dropping every instance whose bounding sphere is bigger than a plane tree is right —
     * the foliage billboards share one quad that the vertex shader expands, so their CPU-side
     * radius is meaningless and the first version of this reported a clearance of
     * -2,205,242 m. But those rejects *are* the vegetation, so a report built only from what
     * survived the filter says "nearest solid 13.7 m, inside 0" about a frame with a pine
     * filling a third of it. That reading was taken at face value once already.
     *
     * An instance's *origin* is trustworthy even when its radius is not — it is the matrix
     * translation, which is where the plant was planted. So the rejects are ranked by origin
     * distance and the nearest few reported beside the others, under a name that says the
     * number is a plant's position and not its extent.
     */
    const foliage = [];
    let scanned = 0;
    let skipped = 0;
    const p = new V();
    const s = new V();
    const m = new cam.matrixWorld.constructor();
    ctx.scene.traverse((o) => {
      if (!o.visible || !o.geometry) return;
      const name = o.name || o.parent?.name || o.type;
      if (/grass|water|terrain|clipmap|sky/i.test(name)) return;
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      const bs = o.geometry.boundingSphere;
      if (!bs || !isFinite(bs.radius)) return;
      const consider = (mat, tag) => {
        p.copy(bs.center).applyMatrix4(mat);
        s.setFromMatrixScale(mat);
        const r = bs.radius * Math.max(s.x, s.y, s.z);
        // A tree is under 25 m across. Anything larger is a shader-expanded proxy.
        if (!(r > 0) || r > 30) {
          skipped++;
          foliage.push({ name: tag, originDist: +p.distanceTo(eye).toFixed(2), radius: +r.toFixed(2) });
          return;
        }
        const d = p.distanceTo(eye);
        hits.push({
          name: tag, clearance: +(d - r).toFixed(2), dist: +d.toFixed(2), radius: +r.toFixed(2),
          at: { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) },
        });
      };
      if (o.isInstancedMesh) {
        const n = Math.min(o.count, 60000);
        for (let i = 0; i < n; i++) {
          scanned++;
          m.fromArray(o.instanceMatrix.array, i * 16).premultiply(o.matrixWorld);
          consider(m, `${name}[${i}]`);
        }
      } else {
        scanned++;
        consider(o.matrixWorld, name);
      }
    });
    hits.sort((a, b) => a.clearance - b.clearance);
    foliage.sort((a, b) => a.originDist - b.originDist);
    return {
      nearest: hits.slice(0, 4), scanned, skipped,
      inside: hits.filter((h) => h.clearance < 0).length,
      // Distance to the *origin* of the nearest shader-expanded instances. A billboard whose
      // origin is a few metres from the eye is a bush the camera is standing in, whatever its
      // unusable bounding radius says.
      nearestFoliage: foliage.slice(0, 4),
      foliageWithin30: foliage.filter((f) => f.originDist < 30).length,
    };
  };

  const gi = gateBay ? gateBay.index : 0;
  const near = [];
  for (let k = -8; k <= 8; k++) {
    const b = bays[gi + k];
    if (!b) continue;
    const mx = (b.x0 + b.x1) * 0.5;
    const mz = (b.z0 + b.z1) * 0.5;
    near.push({
      k, index: b.index, isGate: b.isGate, stage: b.stage,
      x: +mx.toFixed(1), z: +mz.toFixed(1),
      nx: +b.nx.toFixed(4), nz: +b.nz.toFixed(4),
      walkY: +b.walkY.toFixed(2), crestY: +b.crestY.toFixed(2), groundY: +b.groundY.toFixed(2),
      crest: project(mx, b.crestY, mz),
      walk: project(mx, b.walkY, mz),
      foot: project(mx, b.groundY, mz),
      end0: project(b.x0, b.crestY, b.z0),
      end1: project(b.x1, b.crestY, b.z1),
    });
  }
  const onScreen = near.filter((b) => !b.crest.offFrame);
  const inFront = near.filter((b) => !b.crest.behind);
  const xs = inFront.flatMap((b) => [b.end0.x, b.end1.x]);
  const ys = inFront.map((b) => b.crest.y);
  // Bays whose whole cross-section — foot to crest — is inside the usable frame band.
  const legible = near.filter((b) => !b.crest.behind && b.crest.y > 170 && b.foot.y < H - 200
    && b.crest.x > 20 && b.crest.x < W - 20);

  const halfV = (cam.fov * Math.PI) / 360;

  return {
    view: { W, H, aspect: +cam.aspect.toFixed(4) },
    camera: {
      focus: { x: +rig.focus.x.toFixed(2), y: +rig.focus.y.toFixed(2), z: +rig.focus.z.toFixed(2) },
      zoom: +rig.zoom.toFixed(4),
      yawDeg: +((rig.yaw * 180) / Math.PI).toFixed(2),
      radius: +rig.orbitRadius.toFixed(2),
      fov: +cam.fov.toFixed(2),
      halfFovVDeg: +((halfV * 180) / Math.PI).toFixed(2),
      halfFovHDeg: +((Math.atan(Math.tan(halfV) * cam.aspect) * 180) / Math.PI).toFixed(2),
      eye: { x: +eye.x.toFixed(2), y: +eye.y.toFixed(2), z: +eye.z.toFixed(2) },
      eyeAboveFocus: +rig.eyeHeightAboveFocus.toFixed(2),
      groundUnderEye: +g.battle.groundAt(eye.x, eye.z).toFixed(2),
      eyeAboveGround: +(eye.y - g.battle.groundAt(eye.x, eye.z)).toFixed(2),
      axisPitchDeg: +((-Math.asin(dir.y) * 180) / Math.PI).toFixed(2),
    },
    gate: gate
      ? {
        x: +gate.x.toFixed(1), z: +gate.z.toFixed(1), open: !!gate.open,
        px: project(gate.x, g.battle.groundAt(gate.x, gate.z) + 6, gate.z),
      }
      : null,
    gateBay: gateBay
      ? { index: gateBay.index, nx: +gateBay.nx.toFixed(4), nz: +gateBay.nz.toFixed(4) }
      : null,
    bays: near,
    crestTopY: ys.length ? +Math.min(...ys).toFixed(1) : null,
    crestBottomY: ys.length ? +Math.max(...ys).toFixed(1) : null,
    wallX: xs.length ? { min: +Math.min(...xs).toFixed(1), max: +Math.max(...xs).toFixed(1) } : null,
    baysOnScreen: onScreen.length,
    baysLegible: legible.length,
    ground: {
      bottomCentre: groundAtPixel(W / 2, H - 1),
      aboveCards: groundAtPixel(W / 2, H - 230),
      belowPlaques: groundAtPixel(W / 2, 175),
      centre: groundAtPixel(W / 2, H / 2),
    },
    solid: nearestSolid(),
    plaques: (() => {
      let bottom = 0;
      const seen = [];
      for (const sel of ['.topbar', '.deploy', '.banners', '.tb-side']) {
        for (const e of document.querySelectorAll(sel)) {
          const r = e.getBoundingClientRect();
          if (r.width < 40 || r.height < 10 || r.top > H * 0.5) continue;
          seen.push({ sel, top: Math.round(r.top), bottom: Math.round(r.bottom) });
          bottom = Math.max(bottom, r.bottom);
        }
      }
      return { bandBottom: Math.round(bottom), parts: seen };
    })(),
    cards: (() => {
      const e = document.querySelector('.cardbar') ?? document.querySelector('.cards');
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { top: Math.round(r.top) };
    })(),
    deployment: g.deployment ? { zone: { ...g.deployment.zone }, active: g.deployment.active } : null,
    city: { garrison: city?.cityPlan?.garrison ?? null, name: city?.cityPlan?.name ?? null },
  };
};

/**
 * Aim the camera the way a candidate rule would, and hand back what it chose.
 *
 * The rule is asked of the rig rather than re-derived: `jumpTo` at the candidate zoom, read
 * the orbit the rig actually adopted, and solve the offset from that. `RTSCamera`'s pitch,
 * radius and fov curves are therefore never copied here, so this cannot drift from them.
 */
const AIM = ([zoom, frac, span]) => {
  const g = window.__game;
  const rig = g.engine.rig;
  const city = g.engine.context.tryGet('city');
  const bays = city.getGarrisonBays();
  const gateBay = bays.find((b) => b.isGate) ?? bays[bays.length >> 1];
  const b = gateBay;
  const mx = (b.x0 + b.x1) * 0.5;
  const mz = (b.z0 + b.z1) * 0.5;
  const yaw = Math.atan2(-b.nx, -b.nz);

  // Adopt the zoom at the wall itself, then read the orbit back out of the rig.
  rig.jumpTo(mx, mz, zoom, yaw);
  const A = Math.hypot(rig.camera.position.x - rig.focus.x, rig.camera.position.z - rig.focus.z);
  const B = rig.camera.position.y - rig.focus.y;
  const halfV = (rig.camera.fov * Math.PI) / 360;
  const axis = Math.asin(-rig.camera.getWorldDirection(new rig.camera.position.constructor()).y);
  // The tallest crest in the stretch that will be in frame, not the focus bay's: Rome's
  // curtain steps up at every tower and framing on the bay under the crosshair puts the
  // tower two bays along behind the plaque.
  let hc = -Infinity;
  for (let k = -span; k <= span; k++) {
    const q = bays[b.index + k];
    if (q) hc = Math.max(hc, q.crestY - rig.focus.y);
  }
  const theta = axis - frac * halfV;
  const Dwall = (B - hc) / Math.tan(theta);
  const d = Math.max(12, Math.min(200, Dwall - A));
  rig.jumpTo(mx + b.nx * d, mz + b.nz * d, zoom, yaw);
  return {
    zoom, frac, span, offset: +d.toFixed(1), A: +A.toFixed(1), B: +B.toFixed(1),
    hc: +hc.toFixed(2), axisDeg: +((axis * 180) / Math.PI).toFixed(2),
    halfVDeg: +((halfV * 180) / Math.PI).toFixed(2), yawDeg: +((yaw * 180) / Math.PI).toFixed(2),
  };
};

const report = (m, label) => {
  const c = m.camera;
  console.log(`${label}`);
  console.log(`  focus (${c.focus.x}, ${c.focus.z}) zoom ${c.zoom} yaw ${c.yawDeg}deg  r ${c.radius}  fov ${c.fov}  axis ${c.axisPitchDeg}deg`);
  console.log(`  eye (${c.eye.x}, ${c.eye.y}, ${c.eye.z})  above ground ${c.eyeAboveGround}`);
  console.log(`  crest y top ${m.crestTopY} bottom ${m.crestBottomY}  wall x ${JSON.stringify(m.wallX)}  bays on screen ${m.baysOnScreen} legible ${m.baysLegible}`);
  console.log(`  gate px ${JSON.stringify(m.gate?.px)}`);
  console.log(`  ground bottom ${JSON.stringify(m.ground.bottomCentre)}  y175 ${JSON.stringify(m.ground.belowPlaques)}`);
  const clearOfPlaque = m.crestTopY !== null && m.plaques
    ? (m.bays.filter((b) => !b.crest.offFrame).every((b) => b.crest.y > m.plaques.bandBottom))
    : null;
  console.log(`  plaque band ends y ${m.plaques?.bandBottom}  every on-screen crest below it: ${clearOfPlaque}`);
  const n = m.solid.nearest[0];
  console.log(`  nearest solid ${n ? `${n.name} clearance ${n.clearance} m` : 'none'}  inside ${m.solid.inside}  [${m.solid.scanned} scanned, ${m.solid.skipped} rejected]`);
  const f = m.solid.nearestFoliage?.[0];
  console.log(`  nearest foliage origin ${f ? `${f.name} at ${f.originDist} m` : 'none'}`
    + `  within 30 m of the eye: ${m.solid.foliageWithin30}`);
};

const out = {};
for (const map of MAPS) {
  console.log(`\n=== ${map} ===`);
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });
  await page.goto(`${base}/?menu=0&map=${map}&scenario=assault&deploy=1&autoplay=0&quality=high`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
  await page.waitForTimeout(2500);

  const m0 = await page.evaluate(MEASURE, [W, H]);
  m0.errors = errs.slice(0, 4);
  out[map] = { asShipped: m0, sweep: [] };
  report(m0, 'as the scenario aimed it:');
  if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, `${TAG}-${map}.png`) });

  for (const [zoom, frac, span] of SWEEP ?? []) {
    const aim = await page.evaluate(AIM, [zoom, frac, span ?? 3]);
    await page.waitForTimeout(700);
    const m = await page.evaluate(MEASURE, [W, H]);
    m.aim = aim;
    out[map].sweep.push(m);
    report(m, `zoom ${zoom} frac ${frac} -> offset ${aim.offset} m (A ${aim.A} B ${aim.B} hc ${aim.hc} axis ${aim.axisDeg} halfV ${aim.halfVDeg} yaw ${aim.yawDeg})`);
    if (SHOT_DIR) {
      await page.screenshot({
        path: path.join(SHOT_DIR, `${TAG}-${map}-z${String(zoom).replace('.', '')}f${String(frac).replace('.', '')}.png`),
      });
    }
  }
  if (errs.length) console.log(`errors: ${errs.slice(0, 3).join(' | ')}`);
  await page.close();
}

if (JSON_OUT) {
  await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify(out, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}
await browser.close();
if (server) server.kill();
