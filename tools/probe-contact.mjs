#!/usr/bin/env node
/**
 * Does this frame have contact darkening in it, and how much — as a number.
 *
 * ## Why a number
 *
 * Three blind rubric passes scored `A7 ambient occlusion` at 1 out of 4 and all three used
 * the same words: *no contact darkening anywhere*. But `src/render/PostFX.ts` has carried an
 * HBAO pass and a screen-space contact-shadow pass for a long time, both gated on the same
 * `quality.ssao` flag, both on at `high` and `ultra`. Somebody looking at a frame and
 * somebody looking at the source would have given opposite answers, and neither of them
 * would have been measuring.
 *
 * This measures. It shoots the *same camera twice* — once with `ssao` on and once with it
 * off — and reports what the occlusion terms actually did to the pixels:
 *
 * | mark | what it is |
 * |---|---|
 * | `meanDrop` | mean of `1 - lum_on / lum_off` over non-sky pixels: the average darkening |
 * | `p01`, `p05` | the 1st and 5th percentile of that ratio: **how dark the darkest contacts get** |
 * | `f05`, `f10`, `f20` | fraction of pixels darkened by more than 5 %, 10 %, 20 % |
 * | `cover` | fraction of pixels darkened by more than 2 % — how much of the frame is touched |
 *
 * `p05` is the one that matters. An AO term can have a large `meanDrop` and still read as a
 * dirty grey wash rather than as contact, and it can have a tiny `meanDrop` and be perfect if
 * the darkening is concentrated where two things meet. Rome II's tell is a *deep, local*
 * core: a boot sole, the gap between two shields, the inside of a rank. So the pass wants
 * `p05` low and `cover` moderate, not `meanDrop` high.
 *
 * ## The arms
 *
 * `--arms=ao` (default) is on/off for the whole occlusion group. `--arms=split` adds two more
 * loads and separates the HBAO pass from the contact-shadow pass, which is the only way to
 * tell which of the two a change moved. `--arms=none` skips the A/B and just shoots.
 *
 * ## Where it stands
 *
 * The same nine stations as `tools/probe-testudo.mjs`, in the same unit-local frame, so a
 * number here is comparable with a plate there — plus `--cams=` to name a subset. It puts the
 * largest Roman cohort with a testudo in its book into one for the same reason that probe
 * does: 320 shields in one plane is the hardest test contact darkening will ever get, and
 * every one of the nine cameras is a station a blind critic has already graded.
 *
 * Usage:
 *   node tools/probe-contact.mjs --label=before --port=5732
 *   node tools/probe-contact.mjs --label=after --cams=roof-close,corner --arms=split
 *   node tools/probe-contact.mjs --label=x --formation=line   # no testudo, ordinary ranks
 *
 * Output: `screenshots/contact/<label>/<camera>[-<arm>].png`, `contact.json`, and a table.
 */

import path from 'node:path';
import process from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { launchBrowser, startVite } from './lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5732);
const W = Number(args.get('w') ?? 1920);
const H = Number(args.get('h') ?? 1080);
const LABEL = String(args.get('label') ?? 'now');
const QUALITY = String(args.get('quality') ?? 'ultra');
const SETTLE = Number(args.get('settle') ?? 8);
const ARMS = String(args.get('arms') ?? 'ao');
const FORMATION = String(args.get('formation') ?? 'testudo');
const KEEP = args.has('keep-frames');
/**
 * Frames to time per arm, with the GPU drain on. 0 skips timing entirely, which is what a
 * pure look-at-the-picture run wants: the drain costs the whole benefit of pipelining and a
 * timed pass takes about three times as long.
 */
const TIME = Number(args.get('time') ?? 0);
/**
 * Sim seconds a `march: true` camera walks the unit before the shutter.
 *
 * The default is `probe-testudo`'s 2.2 s, which is right for judging legs and wrong for
 * judging a wake: the wake's puffs live four to eight seconds, so at 2.2 s the band is a
 * third built and the frame understates the effect it is meant to measure.
 */
const MARCH = Number(args.get('marchtime') ?? 2.2);
const OUT = path.resolve(ROOT, args.get('out') ?? `screenshots/contact/${LABEL}`);

/** The nine stations of `tools/probe-testudo.mjs`, verbatim. Do not renumber them. */
const CAMS = {
  'front-eye': { ahead: 13, right: 0, eye: 1.75, aim: 1.55, dist: 13, fov: 42 },
  'roof-rake': { ahead: 20, right: 6, eye: 8.0, aim: 1.7, dist: 21, fov: 38 },
  'flank-halt': { ahead: -4.5, right: 17, eye: 1.75, aim: 1.55, dist: 17, fov: 40 },
  corner: { ahead: 6, right: -6, eye: 1.6, aim: 1.45, dist: 8, fov: 50 },
  tactical: { ahead: 26, right: 18, eye: 34, aim: 1.5, dist: 32, fov: 40 },
  'roof-close': { ahead: 7, right: 1.5, eye: 4.6, aim: 1.74, dist: 6, fov: 30 },
  rear: { ahead: -22, right: 4, eye: 6.5, aim: 1.6, dist: 15, fov: 40 },
  far120: { ahead: 90, right: 55, eye: 42, aim: 1.5, dist: 118, fov: 24 },
  'flank-march': { ahead: -4.5, right: 17, eye: 1.75, aim: 1.55, dist: 17, fov: 40, march: true },
  /*
   * Two stations of my own, both for E1 and C6, and both **outside** the block.
   *
   * `flank-march` above is a broadside at 17 m, which is inside a `line` formation 41 files
   * wide and photographs the inside of a helmet. A wake is a thing a unit leaves *behind*
   * it, so it can only be judged from behind it and from far enough back that the ground the
   * unit has already crossed is in frame.
   */
  'wake-quarter': { ahead: -34, right: 40, eye: 7.5, aim: 2.0, dist: 52, fov: 40, march: true },
  'wake-rear': { ahead: -30, right: 0, eye: 4.2, aim: 1.7, dist: 30, fov: 46, march: true },
  /*
   * A broadside on the moment the order is obeyed, from far enough out to see the whole
   * block's silhouette against the sky. `march: 0.45` is the point of it: three tenths of a
   * second into a start is when a body leans hardest and it is the frame the speed-driven
   * lean this replaces was flat in.
   */
  'start-broad': { ahead: -6, right: 34, eye: 2.6, aim: 1.65, dist: 34, fov: 34, march: 0.45 },
};
const requested = args.get('cams') ? String(args.get('cams')).split(',') : Object.keys(CAMS);

/**
 * The A/B arms. Each is a `RenderQualityPatch` plus a `PostFX` field override; `base` is
 * whatever the tier says and is always shot first so the saved frame is the real one.
 */
const ARM_SETS = {
  none: [{ name: 'base', q: {}, fx: {} }],
  ao: [
    { name: 'base', q: {}, fx: {} },
    { name: 'noao', q: { ssao: false }, fx: {} },
  ],
  split: [
    { name: 'base', q: {}, fx: {} },
    { name: 'noao', q: { ssao: false }, fx: {} },
    { name: 'nohbao', q: {}, fx: { aoStrength: 0, aoContactStrength: 0 } },
    { name: 'nocontactpass', q: {}, fx: { contactShadows: false } },
    { name: 'noneartorm', q: {}, fx: { aoContactStrength: 0 } },
  ],
  /**
   * The occlusion buffers themselves, straight to the canvas. Nothing to compare — this arm
   * set exists so a human can *look at* the term rather than at a graded frame that has an
   * unsharp mask and a filmic curve standing between them.
   */
  view: [
    { name: 'base', q: {}, fx: {} },
    { name: 'occ', q: {}, fx: { debugView: 'occ' } },
    { name: 'hbao', q: {}, fx: { debugView: 'ao' } },
    { name: 'contactbuf', q: {}, fx: { debugView: 'contact' } },
  ],
  /**
   * Is there dust behind this unit? Ablates the soft-particle layer at a frozen instant, so
   * the pair differs only by the dust. `cover` in the table below is then literally the
   * share of the frame the dust is over.
   */
  dust: [
    { name: 'base', q: {}, fx: {} },
    { name: 'noao', q: {}, fx: { noDust: true } },
  ],
  /** A strength ladder for the near-field contact term, buffers and frames both. */
  sweep: [
    { name: 'base', q: {}, fx: {} },
    { name: 'occ-s0', q: {}, fx: { debugView: 'occ', aoContactStrength: 0 } },
    { name: 'occ-s2', q: {}, fx: { debugView: 'occ' } },
    { name: 'occ-s4', q: {}, fx: { debugView: 'occ', aoContactStrength: 4 } },
    { name: 'occ-s7', q: {}, fx: { debugView: 'occ', aoContactStrength: 7 } },
    { name: 'frame-s4', q: {}, fx: { aoContactStrength: 4 } },
    { name: 'frame-s7', q: {}, fx: { aoContactStrength: 7 } },
  ],
};
const arms = ARM_SETS[ARMS];
if (!arms) throw new Error(`--arms must be one of ${Object.keys(ARM_SETS).join(', ')}`);

/**
 * Compare two frames and say what the occlusion did.
 *
 * Sky is excluded by luminance rather than by depth: this runs on PNG bytes, and any pixel
 * the two arms agree on to within a 1/255 is either sky or a surface nothing occludes, so
 * including them would only dilute the marks with pixels that carry no information. The
 * denominator is the *off* frame, so the ratio is "what fraction of its unoccluded light
 * this pixel kept".
 */
function coverage(onBuf, offBuf, n) {
  let cover = 0;
  let veil = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const lOn = 0.2126 * onBuf[o] + 0.7152 * onBuf[o + 1] + 0.0722 * onBuf[o + 2];
    const lOff = 0.2126 * offBuf[o] + 0.7152 * offBuf[o + 1] + 0.0722 * offBuf[o + 2];
    const d = Math.abs(lOn - lOff);
    sum += d;
    if (d > 2) cover++;
    if (d > 12) veil++;
  }
  return {
    cover: +(cover / n).toFixed(4), veil: +(veil / n).toFixed(4),
    dLum: +(sum / n).toFixed(3),
  };
}

function compare(onBuf, offBuf, n) {
  const ratios = [];
  let touched = 0;
  let f05 = 0; let f10 = 0; let f20 = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const lOn = 0.2126 * onBuf[o] + 0.7152 * onBuf[o + 1] + 0.0722 * onBuf[o + 2];
    const lOff = 0.2126 * offBuf[o] + 0.7152 * offBuf[o + 1] + 0.0722 * offBuf[o + 2];
    if (lOff < 2) continue;              // black; the ratio is meaningless
    const r = lOn / lOff;
    ratios.push(r);
    sum += 1 - r;
    if (r < 0.98) touched++;
    if (r < 0.95) f05++;
    if (r < 0.90) f10++;
    if (r < 0.80) f20++;
  }
  if (!ratios.length) return null;
  ratios.sort((a, b) => a - b);
  const at = (p) => +ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * p))].toFixed(4);
  const m = ratios.length;
  return {
    meanDrop: +(sum / m).toFixed(4),
    p01: at(0.01), p05: at(0.05), p25: at(0.25), median: at(0.5),
    cover: +(touched / m).toFixed(4),
    f05: +(f05 / m).toFixed(4), f10: +(f10 / m).toFixed(4), f20: +(f20 / m).toFixed(4),
    px: m,
  };
}

/**
 * What an occlusion *buffer* looks like, read off the buffer rather than off a graded frame.
 *
 * Sky is 1.0 by construction in every one of these passes, and so is any surface nothing
 * occludes, so a run of exact 255s would swamp the percentiles with pixels that carry no
 * information. They are counted (`open`) and excluded.
 */
function histogram(buf, n) {
  const v = [];
  let open = 0;
  for (let i = 0; i < n; i++) {
    const g = buf[i * 3];
    if (g >= 254) { open++; continue; }
    v.push(g / 255);
  }
  if (!v.length) return { open: 1, mean: 1, p01: 1, p05: 1, p25: 1, median: 1 };
  v.sort((a, b) => a - b);
  const at = (p) => +v[Math.min(v.length - 1, Math.floor(v.length * p))].toFixed(4);
  return {
    open: +(open / n).toFixed(4),
    mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4),
    p01: at(0.01), p05: at(0.05), p25: at(0.25), median: at(0.5),
    below50: +(v.filter((x) => x < 0.5).length / n).toFixed(4),
    below70: +(v.filter((x) => x < 0.7).length / n).toFixed(4),
  };
}

// ---------------------------------------------------------------------------

let browser = null;
let server = null;
const errors = [];
const report = { label: LABEL, quality: QUALITY, formation: FORMATION, arms: ARMS, cams: {} };

try {
  browser = await launchBrowser({
    label: 'probe-contact', port: PORT, root: ROOT,
    args: [
      '--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--hide-scrollbars',
    ],
  });
  const started = await startVite({ port: PORT, root: ROOT, label: 'probe-contact', slot: browser.budgetSlot });
  server = started.started ? started : null;
  const base = started.base;
  await mkdir(OUT, { recursive: true });

  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 240)); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  const url = `${base}/?harness=1&autoplay=0&quality=${QUALITY}&w=${W}&h=${H}&scenario=field`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 300000 });
  await page.addStyleTag({ content: '#hud-root, #loading, #menu-root { display: none !important; }' });

  await page.evaluate(({ formation }) => {
    const g = window.__game;
    const b = g.battle;
    const rig = g.engine.rig;
    const T = {
      savedHeightAt: rig.heightAt,
      savedWalkAt: rig.walkableTopAt ?? null,
      savedPitch: rig.pitchForZoom,
      savedFov: rig.fovForZoom,
      savedRadius: Object.getOwnPropertyDescriptor(rig, 'radius') ?? null,
      formation,
    };
    window.__tc = T;

    T.postfx = () => g.engine.context.tryGet('postfx') ?? null;

    /**
     * Hide (or restore) the soft-particle layer, which is where all dust lives.
     *
     * `visible` is redefined as a getter rather than assigned, because several systems
     * rewrite `mesh.visible` every frame and a plain assignment is undone before the next
     * draw. `tools/probe-dust.mjs` established this and the reason is worth repeating.
     */
    T.dust = (hidden) => {
      const hit = [];
      g.engine.scene.traverse((o) => {
        if (typeof o.name === 'string' && o.name.startsWith('vfx-particles')) hit.push(o);
      });
      for (const o of hit) {
        if (hidden) {
          if (!T.dustSaved) T.dustSaved = new Map();
          if (!T.dustSaved.has(o)) T.dustSaved.set(o, Object.getOwnPropertyDescriptor(o, 'visible') ?? null);
          Object.defineProperty(o, 'visible', { get: () => false, set: () => {}, configurable: true });
        } else if (T.dustSaved && T.dustSaved.has(o)) {
          const d = T.dustSaved.get(o);
          delete o.visible;
          if (d) Object.defineProperty(o, 'visible', d);
          else o.visible = true;
          T.dustSaved.delete(o);
        }
      }
      return hit.length;
    };

    T.reset = () => {
      rig.heightAt = T.savedHeightAt;
      rig.walkableTopAt = T.savedWalkAt;
      rig.pitchForZoom = T.savedPitch;
      rig.fovForZoom = T.savedFov;
      if (T.savedRadius) Object.defineProperty(rig, 'radius', T.savedRadius);
      else delete rig.radius;
    };

    T.pick = () => {
      let best = null;
      for (const u of b.units) {
        const def = b.typeOf(u);
        if (!def.formations.includes('testudo')) continue;
        if (u.faction !== 0) continue;
        if (!best || u.alive > best.alive) best = u;
      }
      if (!best) throw new Error('[probe-contact] no Roman unit with a testudo in its book');
      T.unitId = best.id;
      return best.id;
    };
    T.unit = () => b.units.find((u) => u.id === T.unitId);

    const HOLD = 0; const MOVE_TO = 1;
    T.form = (march) => {
      const u = T.unit();
      b.setFormation(u, T.formation);
      u.running = false; u.charging = false; u.targetUnitId = -1; u.waypoints = [];
      u.targetFacing = u.facing;
      if (march) {
        u.order = MOVE_TO;
        u.targetX = u.x + Math.sin(u.facing) * 40;
        u.targetZ = u.z + Math.cos(u.facing) * 40;
      } else {
        u.order = HOLD; u.targetX = u.x; u.targetZ = u.z;
      }
      return { id: u.id, type: b.typeOf(u).id, alive: u.alive, width: u.width,
        formation: u.formationId };
    };

    T.frame = () => {
      const u = T.unit();
      return { x: u.x, z: u.z, facing: u.facing, alive: u.alive, formation: u.formationId };
    };

    T.park = (fx, fz, yaw, cam) => {
      T.reset();
      const LIFT = 1.55;
      const groundY = T.savedHeightAt.call(rig, fx, fz);
      const rise = cam.eye - cam.aim + LIFT;
      const R = Math.hypot(rise, cam.dist);
      const P = Math.atan2(rise, cam.dist);
      rig.zoom = 0; rig.zoomTarget = 0;
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
        fov: +c.fov.toFixed(2), yaw: +yaw.toFixed(4),
      };
    };

    /** Apply one arm. Returns what it believes it set, so a silent no-op is visible. */
    T.arm = (a) => {
      const fx = T.postfx();
      if (!T.fxSaved && fx) {
        T.fxSaved = {
          contactShadows: fx.contactShadows,
          aoStrength: fx.aoStrength,
          aoContactStrength: fx.aoContactStrength,
        };
      }
      T.dust(!!a.fx.noDust);
      if (fx) {
        fx.contactShadows = a.fx.contactShadows ?? T.fxSaved.contactShadows;
        fx.aoStrength = a.fx.aoStrength ?? T.fxSaved.aoStrength;
        fx.aoContactStrength = a.fx.aoContactStrength ?? T.fxSaved.aoContactStrength;
        fx.debugView = a.fx.debugView ?? null;
      }
      g.engine.applyRenderQuality({ ssao: a.q.ssao ?? true });
      return {
        ssao: g.engine.context.quality.ssao,
        contactShadows: fx ? fx.contactShadows : null,
        aoStrength: fx ? fx.aoStrength : null,
        aoContactStrength: fx ? fx.aoContactStrength : null,
        debugView: fx ? fx.debugView : null,
        foundPostFX: !!fx,
      };
    };

    /**
     * Draw the frame again without advancing anything.
     *
     * **The A and B of an A/B have to be the same instant.** The first version of this probe
     * called `advance(0.05)` between arms so the change would take effect, which stepped the
     * simulation 0.1 s per arm: at `roof-close`, where a shield fills 300 px, two frames a
     * tenth of a second apart differ in every pixel the animation touched and the measured
     * "AO contribution" was mostly leg movement. It reported a *negative* mean darkening —
     * the AO-on frame brighter than the AO-off one — which is not a thing an occlusion term
     * can do and was the tell.
     *
     * `renderOverride` is the whole of `PostFXSystem.render`, and everything upstream of it
     * — `fixedUpdate`, `update`, `preRender`, the animation texture, the instance buffers,
     * the camera matrices — is left exactly as the last real frame left it. So this is the
     * same world, drawn twice, and the only thing that differs between the two images is the
     * thing the arm changed.
     */
    T.redraw = () => {
      const e = g.engine;
      e.renderer.info.reset();
      if (e.renderOverride) e.renderOverride(e.context);
      else e.renderer.render(e.scene, e.context.camera);
    };

    /**
     * Milliseconds per frame for the current arm, GPU included.
     *
     * `Engine.drainAfterFrame` exists for exactly this and says why in its own comment: a
     * 1x1 `readPixels` is the only real barrier on ANGLE-on-Metal, `gl.finish()` returns
     * early, and without a barrier a fill-rate lever measures as free. It is turned on for
     * the measurement and off again straight after, because it costs the whole benefit of
     * pipelining and nothing should ship with it on.
     */
    T.timeMs = (n) => {
      const e = g.engine;
      const was = e.drainAfterFrame;
      e.drainAfterFrame = true;
      const gl = e.renderer.getContext();
      const px = new Uint8Array(4);
      for (let k = 0; k < 4; k++) { T.redraw(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
      const samples = [];
      for (let k = 0; k < n; k++) {
        const t0 = performance.now();
        T.redraw();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        samples.push(performance.now() - t0);
      }
      e.drainAfterFrame = was;
      samples.sort((a, b) => a - b);
      return {
        median: +samples[Math.floor(n / 2)].toFixed(3),
        min: +samples[0].toFixed(3),
        p90: +samples[Math.floor(n * 0.9)].toFixed(3),
      };
    };

    /**
     * The lean ladder: the acceleration lean over the unit's own men at a start, at a
     * steady march and at a halt, read at each of the three moments in one page.
     *
     * A still frame cannot show this and should not be asked to. The claim is about a
     * derivative; the test is that the sign flips.
     */
    T.leanLadder = () => {
      const urs = g.engine.context.tryGet('unitRender');
      if (!urs || typeof urs.leanStats !== 'function') return null;
      const u = T.unit();
      const out = {};
      // Halted and settled.
      T.form(false);
      g.engine.advance(1.2);
      out.halted = urs.leanStats(u.members);
      // The order, three tenths of a second in.
      T.form(true);
      g.engine.advance(0.30);
      out.start = urs.leanStats(u.members);
      // Steady, five seconds later.
      g.engine.advance(5.0);
      out.steady = urs.leanStats(u.members);
      // Checked: ordered to stand, three tenths of a second in.
      T.form(false);
      g.engine.advance(0.30);
      out.halt = urs.leanStats(u.members);
      // And the simulation's own term over the same men, for the comparison that matters.
      const p = g.battle ? g.battle.pool : g.engine.context.tryGet('battle').pool;
      let mn = Infinity; let mx = -Infinity; let sum = 0;
      for (const i of u.members) {
        const l = p.lean[i];
        if (l < mn) mn = l;
        if (l > mx) mx = l;
        sum += Math.abs(l);
      }
      out.poolLeanAtHalt = {
        n: u.members.length, min: +mn.toFixed(5), max: +mx.toFixed(5),
        meanAbs: +(sum / u.members.length).toFixed(5),
      };
      return out;
    };

    T.cost = () => {
      const i = g.engine.renderer.info.render;
      return { calls: i.calls, triangles: i.triangles };
    };
  }, { formation: FORMATION });

  const info = await page.evaluate(() => { window.__tc.pick(); return window.__tc.form(false); });
  console.log(`unit: ${info.type} #${info.id}  ${info.alive} men, ${info.width} wide, formation ${info.formation}`);

  await page.evaluate((s) => window.__game.fastForward(s), SETTLE);
  await page.evaluate(() => window.__game.advance(0.5));

  if (args.has('lean')) {
    const L = await page.evaluate(() => window.__tc.leanLadder());
    if (!L) {
      console.log('lean: no `units` subsystem with leanStats() — nothing measured');
    } else {
      console.log('');
      console.log('the acceleration lean, radians, over the unit\'s own men');
      console.log('moment                  n   meanAbs        min        max     p90abs');
      console.log('──────────────────  ─────  ────────  ─────────  ─────────  ─────────');
      for (const k of ['halted', 'start', 'steady', 'halt']) {
        const x = L[k];
        console.log(`${k.padEnd(18)}  ${String(x.n).padStart(5)}  ${String(x.meanAbs).padStart(8)}  `
          + `${String(x.min).padStart(9)}  ${String(x.max).padStart(9)}  ${String(x.p90abs).padStart(9)}`);
      }
      const q = L.poolLeanAtHalt;
      console.log(`pool.lean (sim)     ${String(q.n).padStart(5)}  ${String(q.meanAbs).padStart(8)}  `
        + `${String(q.min).padStart(9)}  ${String(q.max).padStart(9)}          -`);
      report.lean = L;
    }
  }

  const raw = new Map();
  for (const name of requested) {
    const cam = CAMS[name];
    if (!cam) { console.log(`  ? no camera "${name}"`); continue; }

    await page.evaluate((m) => window.__tc.form(m), !!cam.march);
    if (cam.march) {
      // `fastForward` is safe here and was checked rather than assumed: `ParticleSystem`
      // is integrated by `particles.advance(sdt)` inside `VFXSystem.update`, and written to
      // the GPU by `flush` inside `preRender`, both of which a skipped submit still runs.
      // Only the rasterisation is dropped, so a wake fast-forwarded is the same wake.
      // A camera may name its own march time; `start-broad` wants a fraction of a second
      // where the wake stations want seven.
      const secs = typeof cam.march === 'number' ? cam.march : MARCH;
      if (secs > 0.6) await page.evaluate((m) => window.__game.fastForward(m - 0.4), secs);
      await page.evaluate((m) => window.__game.advance(Math.min(0.4, m)), secs);
    }

    const placed = await page.evaluate(({ c }) => {
      const T = window.__tc;
      const f = T.frame();
      const s = Math.sin(f.facing); const co = Math.cos(f.facing);
      const fx = f.x + s * c.ahead + co * c.right;
      const fz = f.z + co * c.ahead - s * c.right;
      const aimX = f.x + s * 1.5; const aimZ = f.z + co * 1.5;
      const yaw = Math.atan2(aimX - fx, aimZ - fz);
      const d = Math.hypot(aimX - fx, aimZ - fz);
      return T.park(aimX, aimZ, yaw, { ...c, dist: d });
    }, { c: cam });

    const shots = {};
    const entry = { ...placed, arms: {} };
    // One real frame at this camera, and then nothing else moves. Every arm below redraws
    // this same instant, so the only difference between two images is the arm.
    await page.evaluate(() => window.__game.advance(0.05));
    for (const a of arms) {
      const st = await page.evaluate((x) => window.__tc.arm(x), a);
      // Twice: the first draw lets anything with a one-frame history (TAA, motion blur's
      // previous view-projection) settle into the new arm, the second is photographed.
      await page.evaluate(() => { window.__tc.redraw(); window.__tc.redraw(); });
      const buf = await page.screenshot({ type: 'png' });
      shots[a.name] = buf;
      entry.arms[a.name] = { ...st, cost: await page.evaluate(() => window.__tc.cost()) };
      entry.arms[a.name].live = await page.evaluate(() => {
        const v = window.__game.engine.context.tryGet('vfx');
        if (!v) return null;
        return {
          soft: v.particles ? v.particles.softLive : null,
          wake: v.dust ? v.dust.wakeSpawnedLastFrame : null,
          wakeUnits: v.dust ? v.dust.wakeUnitsLastFrame : null,
        };
      });
      if (TIME > 0) entry.arms[a.name].ms = await page.evaluate((n) => window.__tc.timeMs(n), TIME);
      if (st.debugView) {
        const px = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        entry.arms[a.name].buffer = histogram(px.data, px.info.width * px.info.height);
      }
      if (a.name === 'base' || KEEP) {
        await writeFile(path.join(OUT, a.name === 'base' ? `${name}.png` : `${name}-${a.name}.png`), buf);
      }
    }
    raw.set(name, shots);
    report.cams[name] = entry;
  }

  // Restore, so anything after this in the same page sees the shipped settings.
  await page.evaluate(() => window.__tc.arm({ q: {}, fx: {} }));

  // ---- measure ----------------------------------------------------------
  console.log('');
  console.log('camera        arm         meanDrop    p01    p05    p25    med   cover    f10    f20   cover2  veil12   dLum');
  console.log('────────────  ─────────  ─────────  ─────  ─────  ─────  ─────  ──────  ─────  ─────  ───────  ──────  ─────');
  for (const [name, shots] of raw) {
    if (!shots.noao) continue;
    const px = { on: null, off: null };
    px.off = await sharp(shots.noao).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    for (const [arm, buf] of Object.entries(shots)) {
      if (arm === 'noao') continue;
      px.on = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const n = px.on.info.width * px.on.info.height;
      const c = compare(px.on.data, px.off.data, n);
      if (!c) continue;
      report.cams[name].arms[arm].vsNoAo = c;
      const cv = coverage(px.on.data, px.off.data, n);
      report.cams[name].arms[arm].vsNoAo.cover2 = cv.cover;
      report.cams[name].arms[arm].vsNoAo.veil12 = cv.veil;
      report.cams[name].arms[arm].vsNoAo.dLum = cv.dLum;
      console.log(`${name.padEnd(13)} ${arm.padEnd(10)} `
        + `${String(c.meanDrop).padStart(9)}  ${String(c.p01).padStart(5)}  ${String(c.p05).padStart(5)}  `
        + `${String(c.p25).padStart(5)}  ${String(c.median).padStart(5)}  `
        + `${String(c.cover).padStart(6)}  ${String(c.f10).padStart(5)}  ${String(c.f20).padStart(5)}`
        + `  ${String(c.cover2).padStart(7)}  ${String(c.veil12).padStart(6)}  ${String(c.dLum).padStart(5)}`);
    }
  }

  const anyBuf = Object.values(report.cams).some((e) => Object.values(e.arms).some((a) => a.buffer));
  if (anyBuf) {
    console.log('');
    console.log('camera        arm           open    mean    p01    p05    p25    med   <0.5   <0.7');
    console.log('────────────  ──────────  ──────  ──────  ─────  ─────  ─────  ─────  ─────  ─────');
    for (const [name, e] of Object.entries(report.cams)) {
      for (const [arm, a] of Object.entries(e.arms)) {
        if (!a.buffer) continue;
        const b = a.buffer;
        console.log(`${name.padEnd(13)} ${arm.padEnd(11)} ${String(b.open).padStart(6)}  `
          + `${String(b.mean).padStart(6)}  ${String(b.p01).padStart(5)}  ${String(b.p05).padStart(5)}  `
          + `${String(b.p25).padStart(5)}  ${String(b.median).padStart(5)}  `
          + `${String(b.below50).padStart(5)}  ${String(b.below70).padStart(5)}`);
      }
    }
  }

  if (TIME > 0) {
    console.log('');
    console.log('camera        arm          draws     Mtri    ms med     ms min     ms p90');
    console.log('────────────  ─────────  ───────  ───────  ─────────  ─────────  ─────────');
    for (const [name, e] of Object.entries(report.cams)) {
      for (const [arm, a] of Object.entries(e.arms)) {
        if (!a.ms) continue;
        console.log(`${name.padEnd(13)} ${arm.padEnd(10)} ${String(a.cost.calls).padStart(7)} `
          + `${(a.cost.triangles / 1e6).toFixed(2).padStart(8)} ${String(a.ms.median).padStart(10)} `
          + `${String(a.ms.min).padStart(10)} ${String(a.ms.p90).padStart(10)}`);
      }
    }
  }

  await writeFile(path.join(OUT, 'contact.json'), JSON.stringify(report, null, 2));
  if (errors.length) {
    console.log(`\n${errors.length} console error(s):`);
    for (const e of [...new Set(errors)].slice(0, 8)) console.log(`  ${e}`);
  }
  console.log(`\nwrote ${path.relative(ROOT, OUT)}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await server.close().catch(() => {});
}

process.exit(errors.length ? 1 : 0);
