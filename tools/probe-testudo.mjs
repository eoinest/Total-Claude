#!/usr/bin/env node
/**
 * The testudo rig: one cohort, one formation, five cameras that can be stood in again.
 *
 * A testudo is the one formation in this game whose whole quality is a *surface*. Every
 * other formation can be judged from a tactical camera — is it dense, are the ranks
 * legible — and this one cannot, because the failure modes are gaps between shields,
 * inconsistent angles, a roof that undulates with each man's stature, and men standing
 * upright inside a formation whose entire point is that they are not. All four of those
 * are invisible from 60 m up and unmissable from 12 m out at eye level.
 *
 * So this probe does three things `tools/shoot.mjs` cannot:
 *
 *  1. **It puts a cohort in testudo on purpose.** The AI only calls for one under missile
 *     pressure (`TacticalAI.Testudo`, `missilePressure > 0.55`), which on the field battle
 *     happens at a moment nobody chose, to a unit nobody chose, at a heading nobody chose.
 *     A before/after needs the same cohort at the same heading both times.
 *  2. **It parks the camera by eye height, aim height, standoff and lens** rather than by
 *     `RTSCamera.zoom`, whose single scalar couples orbit radius, pitch and field of view
 *     and floors the eye at 1.7 m — see `docs/video/SHOT-FORMAT.md`. §H of the visual
 *     rubric is scored *only* on frames at 1.75 m with the lens within 15° of level, and
 *     `zoom` cannot take one.
 *  3. **It prints every camera's world coordinates** into `cameras.json` beside the frames,
 *     so a judge can stand where the shot stood.
 *
 * The cameras are specified in the *unit's own frame* — metres in front of the front rank,
 * metres to its right — and resolved against the live formation, so they stay pointed at
 * the testudo when the cohort deploys somewhere else. The resolved world positions are
 * written out, which is the half a reader needs.
 *
 * Usage:
 *   node tools/probe-testudo.mjs --label=before
 *   node tools/probe-testudo.mjs --label=after --cams=front-eye,roof-rake
 *   node tools/probe-testudo.mjs --label=x --port=5591 --w=1920 --h=1080
 *
 * Output: screenshots/testudo/<label>/<camera>.png plus cameras.json and a cost line.
 */

import path from 'node:path';
import process from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchBrowser, startVite } from './lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5591);
const W = Number(args.get('w') ?? 1920);
const H = Number(args.get('h') ?? 1080);
const LABEL = String(args.get('label') ?? 'now');
const QUALITY = String(args.get('quality') ?? 'ultra');
/** Sim seconds to let the cohort dress into the formation before the shutter. */
const SETTLE = Number(args.get('settle') ?? 8);
const OUT = path.resolve(ROOT, args.get('out') ?? `screenshots/testudo/${LABEL}`);

/**
 * The camera set.
 *
 * `ahead` / `right` are metres in the *unit's* frame from the centre of its front rank:
 * `ahead` is out along the way it is facing, `right` is to the unit's own right. `eye` and
 * `aim` are metres above the terrain under the aim point, `dist` the horizontal standoff
 * and `fov` the vertical field of view in degrees.
 *
 * Chosen so that between them they can see every way this can fail:
 *
 *  - `front-eye` is the rubric's §H camera and the one that matters most: a man's eye
 *    height, a level lens, at the distance the man who has to attack it would be standing.
 *    If the front face is not one wall of shield, this frame says so.
 *  - `roof-rake` is 8 m up and 20 m out at about 17° of depression. That is the shallowest
 *    angle from which the roof plane reads as a plane rather than as a row of hats, and it
 *    is where undulation and gaps show.
 *  - `flank-march` watches it move from the side at chest height, which is the only frame
 *    that shows whether the roof holds together while the legs work.
 *  - `corner` stands at the front-right corner at 1.6 m, where the front face, the flank
 *    and the roof all meet — the join nobody builds and everybody sees.
 *  - `tactical` is a player's own camera at 34 m up, so a pass cannot buy the ground shots
 *    by making something that only works at eye level.
 */
const CAMS = {
  'front-eye': { ahead: 13, right: 0, eye: 1.75, aim: 1.55, dist: 13, fov: 42 },
  'roof-rake': { ahead: 20, right: 6, eye: 8.0, aim: 1.7, dist: 21, fov: 38 },
  // A true broadside, aimed at the middle of the block's length rather than at its front
  // corner. The first version of this camera stood at `ahead: 2` and photographed the
  // corner at a grazing angle, which shows a seam in any shield wall ever built.
  'flank-halt': { ahead: -4.5, right: 17, eye: 1.75, aim: 1.55, dist: 17, fov: 40 },
  corner: { ahead: 6, right: -6, eye: 1.6, aim: 1.45, dist: 8, fov: 50 },
  tactical: { ahead: 26, right: 18, eye: 34, aim: 1.5, dist: 32, fov: 40 },
  // Close enough to read one board: is that the painted face or the hide back, is the umbo
  // on top, do the two tile courses actually lap. Every argument about the roof is settled
  // here and nowhere else — at 20 m a 75 mm umbo is four pixels.
  'roof-close': { ahead: 7, right: 1.5, eye: 4.6, aim: 1.74, dist: 6, fov: 30 },
  // The back of the shell. The rearmost rank turns about, and if it does not, this says so.
  rear: { ahead: -22, right: 4, eye: 6.5, aim: 1.6, dist: 15, fov: 40 },
  // Does it still read as a tortoise from a tactical camera at range? Recent judgements on
  // this project have been about exactly this: a portico whose columns stopped resolving
  // past 40 m, a monument unidentifiable at 90 m. 120 m at a long lens is where a player
  // manoeuvres from, and it is past the distance at which a man would otherwise become a
  // billboard of a man standing up.
  far120: { ahead: 90, right: 55, eye: 42, aim: 1.5, dist: 118, fov: 24 },
  /*
   * **Last, and that is not cosmetic.** A camera with `march: true` orders the cohort
   * forward and lets it walk for 2.2 s before the shutter, and the simulation cannot be
   * rewound: every camera after it is photographing a block that has moved, at an anchor
   * that has moved with it. In the first pass `tactical` came after the marching shot in
   * one arm and before it in the other, so the two frames differed by 1.79 m of world
   * position and the pair was not a comparison. Everything halted is shot first.
   */
  'flank-march': { ahead: -4.5, right: 17, eye: 1.75, aim: 1.55, dist: 17, fov: 40, march: true },
};
const requested = args.get('cams') ? String(args.get('cams')).split(',') : Object.keys(CAMS);

// ---------------------------------------------------------------------------

let browser = null;
let server = null;
const results = [];
const errors = [];

try {
  browser = await launchBrowser({
    label: 'probe-testudo', port: PORT, root: ROOT,
    args: [
      '--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--hide-scrollbars',
    ],
  });
  const started = await startVite({ port: PORT, root: ROOT, label: 'probe-testudo', slot: browser.budgetSlot });
  server = started.started ? started : null;
  const base = started.base;
  await mkdir(OUT, { recursive: true });

  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 240)); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  // `autoplay=0` leaves Rome under player control, so `TacticalAI` cannot reform the cohort
  // out of the formation this probe just put it in.
  const url = `${base}/?harness=1&autoplay=0&quality=${QUALITY}&w=${W}&h=${H}&scenario=field`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 300000 });
  await page.addStyleTag({ content: '#hud-root, #loading, #menu-root { display: none !important; }' });

  /** Install the page-side helper: pick the cohort, hold it, park the camera. */
  await page.evaluate(() => {
    const g = window.__game;
    const b = g.battle;
    const rig = g.engine.rig;
    const T = {
      savedHeightAt: rig.heightAt,
      savedWalkAt: rig.walkableTopAt ?? null,
      savedPitch: rig.pitchForZoom,
      savedFov: rig.fovForZoom,
      savedRadius: Object.getOwnPropertyDescriptor(rig, 'radius') ?? null,
    };
    window.__tt = T;

    T.reset = () => {
      rig.heightAt = T.savedHeightAt;
      rig.walkableTopAt = T.savedWalkAt;
      rig.pitchForZoom = T.savedPitch;
      rig.fovForZoom = T.savedFov;
      if (T.savedRadius) Object.defineProperty(rig, 'radius', T.savedRadius);
      else delete rig.radius;
    };

    /** The biggest Roman unit that can actually form testudo. */
    T.pick = () => {
      let best = null;
      for (const u of b.units) {
        const def = b.typeOf(u);
        if (!def.formations.includes('testudo')) continue;
        if (u.faction !== 0) continue;
        if (!best || u.alive > best.alive) best = u;
      }
      if (!best) throw new Error('[probe-testudo] no Roman unit with a testudo in its book');
      T.unitId = best.id;
      return best.id;
    };

    T.unit = () => b.units.find((u) => u.id === T.unitId);

    /** Put it in testudo and stop it, or put it in testudo and walk it. */
    T.form = (march) => {
      const u = T.unit();
      b.setFormation(u, 'testudo');
      u.order = 'hold';
      u.running = false;
      u.charging = false;
      u.targetUnitId = -1;
      u.waypoints = [];
      if (march) {
        // Straight ahead, far enough that it is still walking when the shutter opens.
        u.order = 'move';
        u.targetX = u.x + Math.sin(u.facing) * 40;
        u.targetZ = u.z + Math.cos(u.facing) * 40;
        u.targetFacing = u.facing;
      } else {
        u.targetX = u.x;
        u.targetZ = u.z;
        u.targetFacing = u.facing;
      }
      return { id: u.id, type: b.typeOf(u).id, alive: u.alive, width: u.width,
        formation: u.formationId, spacingX: u.spacingX, spacingZ: u.spacingZ };
    };

    /**
     * Where the front rank is, in world metres, and which way it faces.
     *
     * `u.x, u.z` is the formation anchor — the middle of the front rank — so the camera
     * offsets below are measured from exactly the surface a man walking up to it would see.
     */
    T.frame = () => {
      const u = T.unit();
      return { x: u.x, z: u.z, facing: u.facing, alive: u.alive, formation: u.formationId };
    };

    /**
     * Park the rig at (eye, aim, dist, fov) about a world point.
     *
     * Same arithmetic as `tools/lib/shot-page.mjs`: `place()` adds a 1.55 m lift to the
     * look-at at zoom 0, so setting `heightAt` to `ground + aim - LIFT` puts the aim point
     * at `ground + aim`, and an orbit of radius `hypot(rise, dist)` at pitch
     * `atan2(rise, dist)` puts the eye at `ground + eye`, `dist` metres away horizontally.
     */
    T.park = (fx, fz, yaw, cam) => {
      T.reset();
      const LIFT = 1.55;
      const groundY = T.savedHeightAt.call(rig, fx, fz);
      const rise = cam.eye - cam.aim + LIFT;
      const R = Math.hypot(rise, cam.dist);
      const P = Math.atan2(rise, cam.dist);
      rig.zoom = 0;
      rig.zoomTarget = 0;
      rig.pitchForZoom = () => P;
      rig.fovForZoom = () => cam.fov;
      Object.defineProperty(rig, 'radius', { get: () => R, configurable: true });
      rig.heightAt = () => groundY + cam.aim - LIFT;
      rig.walkableTopAt = null;
      rig.jumpTo(fx, fz, 0, yaw);
      const c = g.engine.context.camera;
      return {
        aimWorld: [+fx.toFixed(2), +(groundY + cam.aim).toFixed(2), +fz.toFixed(2)],
        eyeWorld: [+c.position.x.toFixed(2), +c.position.y.toFixed(2), +c.position.z.toFixed(2)],
        groundY: +groundY.toFixed(2), fov: +c.fov.toFixed(2), yaw: +yaw.toFixed(4),
      };
    };

    /**
     * What the block actually measures, as opposed to what the formation asked for.
     *
     * A shield roof is a geometry problem before it is an art problem: a 0.66 m scutum
     * cannot close a rank whose men stand 0.84 m apart, however it is held. Crowd
     * separation in `BattleSystem.resolveCrowding` works at a 0.42 m body radius and the
     * testudo asks for 0.516 m between files, so the two are in direct conflict and only a
     * measurement says who wins. Everything is in the *unit's own frame*: `+u` is the
     * unit's right, `+v` is the way it faces.
     */
    T.metrics = () => {
      const u = T.unit();
      const p = b.pool;
      const s = Math.sin(u.facing);
      const c = Math.cos(u.facing);
      const live = u.members.filter((i) => p.state[i] !== 10 && p.state[i] !== 11);
      const rows = new Map();
      const pts = [];
      for (const i of live) {
        const dx = p.x[i] - u.x;
        const dz = p.z[i] - u.z;
        // World -> unit frame. Right is +X of the local frame, forward is +Z.
        const uu = dx * c - dz * s;
        const vv = dx * s + dz * c;
        pts.push([uu, vv]);
        const rank = Math.floor(p.slot[i] / u.width);
        if (!rows.has(rank)) rows.set(rank, []);
        rows.get(rank).push(uu);
      }
      // Nearest neighbour, brute force. A few hundred men is 100k compares and this runs
      // five times a pass.
      const nn = [];
      for (let a = 0; a < pts.length; a++) {
        let best = Infinity;
        for (let z = 0; z < pts.length; z++) {
          if (z === a) continue;
          const dd = (pts[a][0] - pts[z][0]) ** 2 + (pts[a][1] - pts[z][1]) ** 2;
          if (dd < best) best = dd;
        }
        nn.push(Math.sqrt(best));
      }
      // Lateral gap between men who are supposed to be shoulder to shoulder in one rank.
      const lat = [];
      for (const r of rows.values()) {
        r.sort((x, y) => x - y);
        for (let k = 1; k < r.length; k++) lat.push(r[k] - r[k - 1]);
      }
      const med = (a) => {
        if (!a.length) return null;
        const q = [...a].sort((x, y) => x - y);
        return +q[Math.floor(q.length / 2)].toFixed(3);
      };
      const uus = pts.map((q) => q[0]);
      const vvs = pts.map((q) => q[1]);
      // How far a man is from the slot his own formation asks for. This is the number the
      // renderer's dress correction has to be big enough to absorb, and the number that
      // says whether a hole in the roof is a pose fault or a placement fault.
      const dev = [];
      for (const i of live) {
        const rank = Math.floor(p.slot[i] / u.width);
        const file = p.slot[i] % u.width;
        const lx = (file - (u.width - 1) * 0.5) * u.spacingX;
        const lz = -rank * u.spacingZ;
        const tx = u.x + lx * c + lz * s;
        const tz = u.z - lx * s + lz * c;
        dev.push(Math.hypot(p.x[i] - tx, p.z[i] - tz));
      }
      dev.sort((a, z) => a - z);
      // What the men are actually doing. A block that never settles plays the marching
      // clip for ever, and that is visible in the legs.
      const states = {};
      for (const i of live) states[p.state[i]] = (states[p.state[i]] ?? 0) + 1;
      return {
        devMedian: +dev[Math.floor(dev.length / 2)].toFixed(3),
        devP90: +dev[Math.floor(dev.length * 0.9)].toFixed(3),
        devMax: +dev[dev.length - 1].toFixed(3),
        states,
        men: live.length, width: u.width,
        askedX: +u.spacingX.toFixed(3), askedZ: +u.spacingZ.toFixed(3),
        nnMedian: med(nn), nnMin: +Math.min(...nn).toFixed(3),
        latMedian: med(lat),
        widthM: +(Math.max(...uus) - Math.min(...uus)).toFixed(2),
        depthM: +(Math.max(...vvs) - Math.min(...vvs)).toFixed(2),
        areaPerMan: +(((Math.max(...uus) - Math.min(...uus))
          * (Math.max(...vvs) - Math.min(...vvs))) / live.length).toFixed(3),
      };
    };

    /** Draw calls and triangles of the frame just submitted. */
    T.cost = () => {
      const info = g.engine.renderer.info.render;
      return { calls: info.calls, triangles: info.triangles };
    };
  });

  const info = await page.evaluate(() => {
    window.__tt.pick();
    return window.__tt.form(false);
  });
  console.log(`unit: ${info.type} #${info.id}  ${info.alive} men, ${info.width} wide, `
    + `spacing ${info.spacingX.toFixed(3)} x ${info.spacingZ.toFixed(3)} m`);

  // Let it dress. `fastForward` skips the submit only, so this is the same battle sooner.
  await page.evaluate((s) => window.__game.fastForward(s), SETTLE);
  await page.evaluate(() => window.__game.advance(0.5));

  const metrics = await page.evaluate(() => window.__tt.metrics());
  console.log(`block: ${metrics.men} men, ${metrics.width} wide, ${metrics.widthM} x ${metrics.depthM} m`
    + `  asked ${metrics.askedX}/${metrics.askedZ}  measured nn ${metrics.nnMedian}`
    + ` (min ${metrics.nnMin})  lateral ${metrics.latMedian}  ${metrics.areaPerMan} m2/man`);
  console.log(`off-slot: median ${metrics.devMedian} p90 ${metrics.devP90} max ${metrics.devMax} m`
    + `   states ${JSON.stringify(metrics.states)}`);

  const cams = {};
  for (const name of requested) {
    const cam = CAMS[name];
    if (!cam) { console.log(`  ? no camera "${name}"`); continue; }

    // The marching frame needs the cohort walking; everything else needs it stood still.
    await page.evaluate((m) => window.__tt.form(m), !!cam.march);
    if (cam.march) {
      await page.evaluate(() => window.__game.fastForward(2.2));
      await page.evaluate(() => window.__game.advance(0.4));
    }

    const placed = await page.evaluate(({ c }) => {
      const T = window.__tt;
      const f = T.frame();
      const s = Math.sin(f.facing);
      const co = Math.cos(f.facing);
      // Unit frame -> world. +ahead is along the facing, +right is 90 deg clockwise of it.
      const fx = f.x + s * c.ahead + co * c.right;
      const fz = f.z + co * c.ahead - s * c.right;
      // Look back at the middle of the formation, not at the point the camera stands on.
      const aimX = f.x + s * 1.5;
      const aimZ = f.z + co * 1.5;
      const yaw = Math.atan2(aimX - fx, aimZ - fz);
      const d = Math.hypot(aimX - fx, aimZ - fz);
      const cc = { ...c, dist: d };
      const out = T.park(aimX, aimZ, yaw, cc);
      out.unit = { x: +f.x.toFixed(2), z: +f.z.toFixed(2), facing: +f.facing.toFixed(4),
        alive: f.alive, formation: f.formation };
      out.spec = c;
      return out;
    }, { c: cam });

    await page.evaluate(() => window.__game.advance(0.1));
    await page.screenshot({ path: path.join(OUT, `${name}.png`), type: 'png' });
    const cost = await page.evaluate(() => window.__tt.cost());
    cams[name] = { ...placed, cost };
    results.push({ name, ...cost });
    console.log(`  ${name.padEnd(12)} eye ${JSON.stringify(placed.eyeWorld)} `
      + `aim ${JSON.stringify(placed.aimWorld)} fov ${placed.fov}  `
      + `${cost.calls} draws, ${(cost.triangles / 1e6).toFixed(2)} Mtri`);
  }

  await writeFile(path.join(OUT, 'cameras.json'), JSON.stringify({
    label: LABEL, width: W, height: H, quality: QUALITY, settle: SETTLE,
    unit: info, metrics, cams,
  }, null, 2));

  if (errors.length) {
    console.log(`\n${errors.length} console error(s):`);
    for (const e of [...new Set(errors)].slice(0, 8)) console.log(`  ${e}`);
  }
  console.log(`\nwrote ${results.length} frame(s) to ${path.relative(ROOT, OUT)}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await server.close().catch(() => {});
}

process.exit(errors.length ? 1 : 0);
