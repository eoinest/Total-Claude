/**
 * The half of the video studio that runs inside the page.
 *
 * Everything here is stringified into the browser by `tools/film.mjs`, so it must be one
 * self-contained function with no imports and no references to module scope.
 *
 * The split between this file and `shot-format.mjs` is deliberate and is the reason a GUI can
 * be built on top later: **this file only answers questions about the live world and parks the
 * camera; it computes no camera geometry at all.** Anchor resolution is a query — where is the
 * gate, where is the densest melee, where is the largest elephant unit — and its answer is a
 * handful of plain numbers. The rail, the easing, the interpolation and the framing maths are
 * all in Node, where they can be run without a GPU, unit-tested, and previewed by an editor
 * that has no browser open.
 *
 * The one thing that would tempt a maintainer to move maths in here is `track.mode: 'follow'`,
 * which needs a fresh anchor every frame and therefore costs a second round trip per frame. It
 * is worth the round trip. A page that computed the camera would put the studio's most
 * load-bearing code somewhere no test can reach it, which is where the trailer's camera lived
 * for its whole first pass and is why `trailer-audio-pass.mjs` had to be written to check that
 * two copies of it agreed.
 */

/**
 * Installed as `window.__tc` by the runner. Returns nothing; everything is reached off the
 * global afterwards, because `page.evaluate` cannot hand a live object back to Node.
 */
export function PAGE_LIB() {
  const g = window.__game;
  const rig = g.engine.rig;

  /*
   * Soldier state numbers, from `SoldierState` in `src/sim/types.ts:127`.
   *
   * Copied rather than imported because the pool is a flat typed array and the enum is erased
   * at build time. `qa-determinism.mjs` and `qa-deploy.mjs` each carry their own copy of two of
   * these and `docs/HANDOFF.md` records that as a fault, so this copy is the whole enum, named,
   * in one place, and it is checked rather than assumed: `counts()` throws by name if the pool
   * ever holds a state number outside 0..MAX_STATE, which is what a new enum member looks like
   * from here.
   */
  const S = {
    Idle: 0, Marching: 1, Running: 2, Charging: 3, Fighting: 4, Bracing: 5,
    Throwing: 6, Shooting: 7, Reloading: 8, Staggered: 9, Dying: 10, Dead: 11,
    Routing: 12, Climbing: 13, Cheering: 14,
  };
  const MAX_STATE = 14;

  const T = {
    savedHeightAt: rig.heightAt,
    savedWalkAt: rig.walkableTopAt ?? null,
    savedPitch: rig.pitchForZoom,
    savedFov: rig.fovForZoom,
    savedRadius: Object.getOwnPropertyDescriptor(rig, 'radius') ?? null,
    savedShakeScale: rig.shakeScale,
    /** Every intervention this page has made in the battle, in order, for the manifest. */
    interventions: [],
  };
  window.__tc = T;

  T.reset = () => {
    rig.heightAt = T.savedHeightAt;
    rig.walkableTopAt = T.savedWalkAt;
    rig.pitchForZoom = T.savedPitch;
    rig.fovForZoom = T.savedFov;
    if (T.savedRadius) Object.defineProperty(rig, 'radius', T.savedRadius);
    else delete rig.radius;
  };

  /** The HUD is not in a film. Re-applied before every shutter; see `applyHudPolicy` in shoot.mjs. */
  T.hideHud = () => {
    for (const id of ['hud-root', 'loading', 'menu-root']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    const hud = g.engine.context.tryGet && g.engine.context.tryGet('hud');
    if (hud && hud.overlay) hud.overlay.visible = false;
    return !!(hud && hud.overlay && hud.overlay.visible === false);
  };

  // -------------------------------------------------------------------------
  // Anchors
  // -------------------------------------------------------------------------

  const groundAt = (x, z) => (T.savedHeightAt ? T.savedHeightAt(x, z) : 0);

  /**
   * Resolve an anchor spec against the live world. Plain numbers only — this crosses the
   * `page.evaluate` boundary, so anything that is not JSON is not an answer.
   *
   * Returns `null` when the subject is not on the field, and the runner turns that into an
   * error naming the shot and the spec rather than quietly framing the origin. A shot that
   * asks for the war elephants on a map that has none has a mistake in it, and 1080p of empty
   * grass is not the way to be told.
   */
  T.anchor = (spec) => {
    const b = g.battle;
    const city = g.engine.context.tryGet ? g.engine.context.tryGet('city') : null;

    if (spec.kind === 'world') {
      return { x: spec.x, z: spec.z, terrY: groundAt(spec.x, spec.z) };
    }

    if (spec.kind === 'bay') {
      if (!city || !city.getGarrisonBays) return null;
      const bays = city.getGarrisonBays();
      if (!bays || !bays.length) return null;
      const gi = bays.findIndex((q) => q.isGate);
      const idx = Math.max(0, Math.min(bays.length - 1, (gi < 0 ? 0 : gi) + spec.k));
      const bay = bays[idx];
      let mx = (bay.x0 + bay.x1) * 0.5;
      let mz = (bay.z0 + bay.z1) * 0.5;
      if (spec.subject === 'gate') {
        // The gate is not at the centre of its own bay — the road decides where it is.
        const gate = city.getGates ? city.getGates()[0] : null;
        if (gate) { mx = gate.x; mz = gate.z; }
      }
      return {
        x: mx, z: mz, nx: bay.nx, nz: bay.nz, dx: bay.dx, dz: bay.dz,
        walkY: bay.walkY, crestY: bay.crestY, terrY: groundAt(mx, mz),
        bayIndex: bay.index, isGate: !!bay.isGate,
      };
    }

    if (spec.kind === 'frontGap') {
      /*
       * The midpoint of the two front *lines*, not of the two hosts.
       *
       * A host's centroid includes its reserves and its artillery, so the midpoint of two
       * centroids sits tens of metres behind where the lines are about to touch. The trailer's
       * clash beat opened on two thirds of a frame of empty grass for exactly this reason.
       */
      let ours = null;
      let theirs = null;
      for (const u of b.units) {
        if (u.destroyed || u.alive === 0) continue;
        const cls = b.typeOf(u).unitClass;
        const line = cls === 'heavy-infantry' || cls === 'spear-infantry'
          || cls === 'shock-infantry' || cls === 'light-infantry';
        if (!line) continue;
        if (u.faction === 0) { if (!ours || u.z < ours.z) ours = u; }
        else if (!theirs || u.z > theirs.z) theirs = u;
      }
      if (!ours || !theirs) return null;
      const x = (ours.x + theirs.x) / 2;
      const z = (ours.z + theirs.z) / 2;
      return {
        x, z, terrY: groundAt(x, z),
        gap: +(ours.z - theirs.z).toFixed(1),
        axis: Math.atan2(theirs.x - ours.x, theirs.z - ours.z),
      };
    }

    if (spec.kind === 'contact' || spec.kind === 'corpses') {
      const p = b.pool;
      const wantDead = spec.kind === 'corpses';
      const cells = new Map();
      const cx = [0, 0, 0];
      const cz = [0, 0, 0];
      const cn = [0, 0, 0];
      for (let i = 0; i < p.count; i++) {
        const st = p.state[i];
        const dead = st === S.Dead || st === S.Dying;
        if (!dead) {
          const f = p.faction[i];
          cx[f] += p.x[i]; cz[f] += p.z[i]; cn[f]++;
        }
        if (wantDead ? !dead : st !== S.Fighting) continue;
        const key = Math.floor((p.z[i] + 1400) / 40) * 128 + Math.floor((p.x[i] + 1400) / 40);
        const c = cells.get(key);
        if (c) { c.x += p.x[i]; c.z += p.z[i]; c.n++; } else cells.set(key, { x: p.x[i], z: p.z[i], n: 1 });
      }
      const foe = cn[2] > cn[1] ? 2 : 1;
      const ax = cn[0] ? cx[0] / cn[0] : 0;
      const az = cn[0] ? cz[0] / cn[0] : 0;
      const bx = cn[foe] ? cx[foe] / cn[foe] : 0;
      const bz = cn[foe] ? cz[foe] / cn[foe] : 0;
      let best = null;
      for (const c of cells.values()) if (!best || c.n > best.n) best = c;
      const useCell = best && best.n >= 12;
      if (wantDead && !useCell) return null;
      const x = useCell ? best.x / best.n : (ax + bx) / 2;
      const z = useCell ? best.z / best.n : (az + bz) / 2;
      return {
        x, z, terrY: groundAt(x, z),
        axis: Math.atan2(bx - ax, bz - az),
        cellN: best ? best.n : 0,
      };
    }

    if (spec.kind === 'unitType' || spec.kind === 'unitClass' || spec.kind === 'cavalryUnit') {
      let best = null;
      for (const u of b.units) {
        if (u.destroyed || u.alive === 0) continue;
        const t = b.typeOf(u);
        if (spec.kind === 'unitType' && t.id !== spec.id) continue;
        if (spec.kind === 'unitClass' && (u.faction !== spec.faction || t.unitClass !== spec.cls)) continue;
        if (spec.kind === 'cavalryUnit'
          && t.unitClass !== 'heavy-cavalry' && t.unitClass !== 'light-cavalry') continue;
        if (spec.pick === 'frontmost') {
          // Nearest the enemy: faction 0 faces -Z on every map in this project.
          if (!best || (u.faction === 0 ? u.z < best.z : u.z > best.z)) best = u;
        } else if (!best || u.alive > best.alive) best = u;
      }
      if (!best) return null;
      return {
        x: best.x, z: best.z, facing: best.facing, alive: best.alive,
        terrY: groundAt(best.x, best.z), unit: b.typeOf(best).id, unitId: best.id,
      };
    }

    return null;
  };

  // -------------------------------------------------------------------------
  // The camera
  // -------------------------------------------------------------------------

  /**
   * Park the rig for one frame. Everything is absolute and nothing is remembered.
   *
   * `RTSCamera`'s public surface is one scalar — `zoom` — from which it derives orbit radius,
   * pitch and field of view together, plus a floor in `place()` that will not let the eye sit
   * closer than `lerp(1.7, 22, smoothstep(zoom))` to the ground. That is the right camera for a
   * player and the wrong one for a photographer, so the four curves are replaced for the
   * duration of a frame and put back by `reset` on the next one. Nothing in `src/` changes; the
   * rig is left exactly as it was found the moment the film ends.
   *
   * The arithmetic, which is the trailer's:
   *   `LIFT` is the 1.55 m `place()` adds to the look-at point at zoom 0. Setting `heightAt` to
   *   the constant `groundY + aim - LIFT` therefore puts the aim point at `groundY + aim`, and
   *   the orbit `(P, R)` puts the eye at `groundY + eye` and `dist` metres away horizontally.
   *   `walkableTopAt` is nulled with it, or the rig would adopt a wall-walk lift on top of a
   *   ground plane that is already artificial and the eye would climb by the height of a wall.
   */
  T.apply = (s) => {
    T.reset();
    if (s.liftY !== null && s.liftY !== undefined) {
      const y = s.liftY;
      rig.heightAt = () => y;
      rig.walkableTopAt = null;
    }
    if (s.cam) {
      const LIFT = 1.55;
      const groundY = (s.liftY !== null && s.liftY !== undefined) ? s.liftY : T.savedHeightAt(s.fx, s.fz);
      const rise = s.cam.eye - s.cam.aim + LIFT;
      const R = Math.hypot(rise, s.cam.dist);
      const P = Math.atan2(rise, s.cam.dist);
      rig.zoom = 0;
      rig.zoomTarget = 0;
      rig.pitchForZoom = () => P;
      rig.fovForZoom = () => s.cam.fov;
      Object.defineProperty(rig, 'radius', { get: () => R, configurable: true });
      rig.heightAt = () => groundY + s.cam.aim - LIFT;
      rig.walkableTopAt = null;
      rig.jumpTo(s.fx, s.fz, 0, s.yaw);
    } else {
      rig.jumpTo(s.fx, s.fz, s.zoom, s.yaw);
    }
  };

  // -------------------------------------------------------------------------
  // The clock
  // -------------------------------------------------------------------------

  /**
   * Advance the world by `ticks` simulation ticks and render exactly one frame.
   *
   * Three cases, and the whole of the studio's time scaling is here.
   *
   *  - `ticks === 1` — one `advance(1/30, 1000/30)`. One rendered frame, one 30 Hz tick, the
   *    same `Engine.frame()` the rAF loop calls at the dt a player at 30 fps gets. Playback at
   *    30 fps is real time.
   *  - `ticks === 0` — slow motion, by frame-doubling. `Time.paused` makes `beginFrame` return
   *    zero steps and hand every visual system `scaledDt` 0, while `rig.update` still gets the
   *    real frame delta. So the battle does not move, the camera does, and the accumulator is
   *    untouched — which means a 0.5x shot fires exactly the same ticks in exactly the same
   *    order as a 1x shot of the same window. The picture is step-printed, the way an optical
   *    printer does slow motion, because the men's animation phase is `time.simTime` and their
   *    positions are interpolated on `time.alpha`, and neither moves on a paused frame.
   *  - `ticks >= 2` — fast motion. The extra ticks run with `{ render: false }`, which skips
   *    only the submit; `Engine.advance`'s own comment records that the two are bit-identical
   *    at every checkpoint `qa-determinism` measures.
   *
   * `substep` is the other slow-motion mode and is opt-in for a reason: it runs one
   * `advance(1/(30n), 1000/(30n))` instead, which ticks on every nth call and interpolates the
   * men in between, but hands every `update` a different dt from the 1x pass. Measured, that
   * changes the battle. See `docs/video/SHOT-FORMAT.md`.
   */
  T.step = (ticks, opts) => {
    const time = g.engine.time;
    if (opts && opts.substep && opts.substep > 1) {
      const n = opts.substep;
      g.engine.advance(1 / (30 * n), 1000 / (30 * n));
      return;
    }
    if (ticks <= 0) {
      const was = time.paused;
      time.paused = true;
      try { g.engine.advance(1 / 30, 1000 / 30); } finally { time.paused = was; }
      return;
    }
    for (let k = 0; k < ticks - 1; k++) g.engine.advance(1 / 30, 1000 / 30, { render: false });
    g.engine.advance(1 / 30, 1000 / 30);
  };

  /** Fast-forward to a sim time on the same 1/30 grid the capture uses, without drawing. */
  T.runTo = (t) => {
    let guard = 0;
    while (g.simTime() < t - 1e-6) {
      g.engine.advance(1 / 30, 1000 / 30, { render: false });
      if (++guard > 200000) throw new Error('runTo: 200k ticks without reaching the target');
    }
    return g.simTime();
  };

  // -------------------------------------------------------------------------
  // Finders — "cut in two seconds before the gate gives way"
  // -------------------------------------------------------------------------

  const counts = () => {
    const p = g.battle.pool;
    let fighting = 0;
    let climbing = 0;
    let routing = 0;
    let dead = 0;
    let bad = -1;
    for (let i = 0; i < p.count; i++) {
      const st = p.state[i];
      if (st > MAX_STATE || st < 0) { bad = st; continue; }
      if (st === S.Fighting) fighting++;
      else if (st === S.Climbing) climbing++;
      else if (st === S.Routing) routing++;
      else if (st === S.Dead || st === S.Dying) dead++;
    }
    if (bad >= 0) throw new Error(`soldier state ${bad} is outside SoldierState 0..${MAX_STATE}; the copy in tools/lib/shot-page.mjs is stale`);
    return { fighting, climbing, routing, dead };
  };

  const gate = () => {
    const s = g.battle.siege;
    return s && s.gateReport ? s.gateReport() : null;
  };

  const met = (f) => {
    const c = counts();
    if (f.find === 'contact') return c.fighting > 0;
    if (f.find === 'melee') return c.fighting >= f.n;
    if (f.find === 'climbing') return c.climbing >= f.n;
    if (f.find === 'routing') return c.routing >= f.n;
    if (f.find === 'corpses') return c.dead >= f.n;
    const gr = gate();
    // A gate that was never shut is not an event: on a circuit whose leaves start open,
    // `open` is true at t+0 and a shot cut against it would open on the deployment.
    if (f.find === 'gateOpen') return !!gr && (gr.shutAtStart ? gr.open : gr.breached);
    if (f.find === 'gateBlow') return !!gr && gr.blows >= f.nth;
    return false;
  };

  /**
   * Scout: run the battle forward until a predicate first holds, and report *when*.
   *
   * On the same 1/30 grid and with `{ render: false }`, which is bit-identical to the capture
   * pass. So the sim time this returns is the sim time the capture will see the same thing at,
   * and a shot can be cut against an event rather than against a number somebody wrote down
   * once and that moved the next time the roster changed.
   *
   * The page is reloaded afterwards and the battle re-run from zero, because a simulation can
   * only be fast-forwarded. That is the whole cost of the feature: one extra run of the battle
   * up to the event.
   */
  T.scout = (f, before) => {
    const t0 = g.simTime();
    if (met(f)) return { at: t0, already: true, scanned: 0 };
    let n = 0;
    while (g.simTime() < before) {
      g.engine.advance(1 / 30, 1000 / 30, { render: false });
      n++;
      if (met(f)) return { at: +g.simTime().toFixed(4), already: false, scanned: n };
    }
    return { at: null, already: false, scanned: n, reached: +g.simTime().toFixed(4) };
  };

  // -------------------------------------------------------------------------
  // Staging
  // -------------------------------------------------------------------------

  /**
   * Apply one staged action. Everything here is recorded in `T.interventions` and lands in the
   * film manifest, because a frame that was arranged has to say so.
   */
  T.stage = (a) => {
    // `touchesSim` comes from the STAGE table in shot-format.mjs and rides along on the
    // action, so the manifest's `emergent` flag and `--check`'s ✱ markers cannot disagree
    // about whether a camera knob counts as arranging the battle. They did once.
    const rec = { do: a.do, at: +g.simTime().toFixed(4), touchesSim: !!a.touchesSim };
    if (a.do === 'shakeScale') {
      rec.from = rig.shakeScale;
      rig.shakeScale = a.value;
      rec.to = rig.shakeScale;
    } else if (a.do === 'shake') {
      rig.shake(a.amplitude, a.decay === undefined ? 3.2 : a.decay);
      rec.amplitude = a.amplitude;
    } else if (a.do === 'weather') {
      const vfx = g.engine.context.tryGet('vfx');
      if (!vfx || !vfx.setWeather) throw new Error('stage weather: no VFX system');
      vfx.setWeather(a.kind);
      rec.kind = vfx.weatherKind;
      if (rec.kind !== a.kind) throw new Error(`stage weather: asked for ${a.kind}, got ${rec.kind}`);
    } else if (a.do === 'rout') {
      const anch = T.anchor(a.unit);
      if (!anch || anch.unitId === undefined) throw new Error(`stage rout: ${JSON.stringify(a.unit)} resolved to no unit`);
      const u = g.battle.unitById(anch.unitId);
      if (!u) throw new Error(`stage rout: unit ${anch.unitId} is gone`);
      g.battle.rout(u);
      rec.unit = anch.unit;
      rec.alive = u.alive;
    } else {
      throw new Error(`stage: unknown action ${a.do}`);
    }
    T.interventions.push(rec);
    return rec;
  };

  T.restoreCameraKnobs = () => { rig.shakeScale = T.savedShakeScale; };

  // -------------------------------------------------------------------------
  // Per-frame record
  // -------------------------------------------------------------------------

  /**
   * What was true on this frame. Written per frame into the manifest.
   *
   * `sunAngle` is here because it is the number that decided the trailer's opening beat: inside
   * about 45 degrees of a low sun every surface in frame goes to one flat cream, and the first
   * pass of that shot came back at 14 degrees off an 8-degree sun and read as a lighting fault
   * rather than as dawn. It is a number, so it is recorded rather than argued about.
   *
   * The head counts are the anti-freeze assertion. This project has shipped a battle that froze
   * for sixteen minutes and photographed perfectly.
   */
  T.stats = () => {
    const b = g.battle;
    const p = b.pool;
    let alive = 0; let fighting = 0; let corpses = 0; let moving = 0;
    let climbing = 0; let shooting = 0; let routing = 0;
    for (let i = 0; i < p.count; i++) {
      const st = p.state[i];
      if (st === S.Dead || st === S.Dying) { corpses++; continue; }
      alive++;
      if (st === S.Fighting) fighting++;
      else if (st === S.Marching || st === S.Running || st === S.Charging) moving++;
      else if (st === S.Climbing) climbing++;
      else if (st === S.Throwing || st === S.Shooting || st === S.Reloading) shooting++;
      else if (st === S.Routing) routing++;
    }
    const est = g.engine.stats();
    const cam = rig.camera;
    let sunAngle = null;
    let sunElev = null;
    const sky = g.engine.context.tryGet('sky');
    const sd = sky && sky.sunDirection;
    if (sd) {
      const f = new (cam.position.constructor)(0, 0, -1).applyQuaternion(cam.quaternion);
      const fl = Math.hypot(f.x, f.z) || 1e-6;
      const sl = Math.hypot(sd.x, sd.z) || 1e-6;
      const c = (f.x * sd.x + f.z * sd.z) / (fl * sl);
      sunAngle = +((Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI).toFixed(1);
      sunElev = +((Math.asin(Math.max(-1, Math.min(1, sd.y))) * 180) / Math.PI).toFixed(1);
    }
    const gr = gate();
    return {
      // Full precision, not `toFixed`. The runner asserts this against the plan to within
      // 1e-6 s, and a value rounded to four places cannot carry a 1/30 s grid: 0.03333… is
      // 5e-5 away from anything four decimals can spell, which is fifty times the tolerance.
      t: g.simTime(),
      alive, fighting, corpses, moving, climbing, shooting, routing,
      draws: est.calls, tris: est.tris,
      fov: +cam.fov.toFixed(2),
      eye: [+cam.position.x.toFixed(2), +cam.position.y.toFixed(2), +cam.position.z.toFixed(2)],
      sunAngle, sunElev,
      gateBlows: gr ? gr.blows : null,
      gateOpen: gr ? gr.open : null,
    };
  };
}

/**
 * The overlay: captions, the end card and the fades, drawn as DOM over the canvas.
 *
 * DOM rather than a render pass, for the same reason the trailer did it: a caption composited
 * by the page is a caption the capture cannot get wrong, it costs the renderer nothing, and
 * every font on the machine is available to it. It also means `--noverlay` is a real option —
 * a shot script's frames can be shot clean and titled later — which a burned-in pass would not
 * allow.
 */
export const OVERLAY_HTML = `
<div id="tc-ov" style="position:fixed;inset:0;pointer-events:none;z-index:99999;font-kerning:normal">
  <div id="tc-scrim" style="position:absolute;inset:0;opacity:0;
    background:linear-gradient(to top,rgba(0,0,0,.72) 0%,rgba(0,0,0,.34) 16%,rgba(0,0,0,0) 34%)"></div>
  <div id="tc-cap" style="position:absolute;left:6.2%;bottom:8.5%;opacity:0;
    font-family:'Optima','Palatino Linotype',Palatino,Georgia,serif;color:#f3ece0;
    text-shadow:0 2px 18px rgba(0,0,0,.85),0 0 3px rgba(0,0,0,.7)">
    <div id="tc-cap-t" style="font-size:34px;letter-spacing:.34em;font-weight:600"></div>
    <div id="tc-cap-s" style="font-size:20px;letter-spacing:.16em;margin-top:10px;opacity:.82;
      font-style:italic"></div>
  </div>
  <div id="tc-endscrim" style="position:absolute;inset:0;opacity:0;
    background:radial-gradient(ellipse 74% 62% at 50% 46%,rgba(0,0,0,.70) 0%,rgba(0,0,0,.52) 55%,rgba(0,0,0,.30) 100%)"></div>
  <div id="tc-end" style="position:absolute;inset:0;opacity:0;display:flex;flex-direction:column;
    align-items:center;justify-content:center;
    font-family:'Optima','Palatino Linotype',Palatino,Georgia,serif;color:#f6efe2;
    text-shadow:0 4px 40px rgba(0,0,0,.9)">
    <div id="tc-end-t" style="font-size:96px;letter-spacing:.30em;font-weight:600;padding-left:.30em"></div>
    <div style="width:230px;height:1px;background:linear-gradient(90deg,transparent,#c9a24a,transparent);
      margin:34px 0 30px"></div>
    <div id="tc-end-s" style="font-size:25px;letter-spacing:.20em;opacity:.88;padding-left:.20em"></div>
    <div id="tc-url" style="font-size:29px;letter-spacing:.13em;margin-top:64px;opacity:0;
      color:#e8d9b4"></div>
  </div>
  <div id="tc-fade" style="position:absolute;inset:0;background:#000;opacity:1"></div>
</div>`;

/** Installed as `window.__tcOverlay`. One call per frame; every field is absolute. */
export function SET_OVERLAY(o) {
  const el = (id) => document.getElementById(id);
  const cap = el('tc-cap');
  if (o.capText !== undefined) {
    el('tc-cap-t').textContent = o.capText;
    el('tc-cap-s').textContent = o.capSub || '';
  }
  if (o.endTitle !== undefined) {
    el('tc-end-t').textContent = o.endTitle;
    el('tc-end-s').textContent = o.endSub || '';
    el('tc-url').textContent = o.endUrl || '';
  }
  cap.style.opacity = String(o.cap || 0);
  el('tc-scrim').style.opacity = String((o.cap || 0) * 0.92);
  el('tc-endscrim').style.opacity = String(o.end || 0);
  cap.style.transform = `translateY(${(1 - (o.cap || 0)) * 9}px)`;
  el('tc-end').style.opacity = String(o.end || 0);
  el('tc-url').style.opacity = String(o.url || 0);
  el('tc-fade').style.opacity = String(o.fade || 0);
}
