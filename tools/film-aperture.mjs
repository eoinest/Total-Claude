#!/usr/bin/env node
/**
 * The two reports, filmed, as matched before/after pairs.
 *
 * `tools/shoot.mjs` cannot take these frames: every shot in its table is a camera and a
 * time, and both of these scenes are *an order given to a unit*. There is no hook in that
 * file for issuing one, and adding one to a shared instrument that four other agents are
 * shooting decks with is not a change this pass should make on the side.
 *
 * So the cameras are named here instead, and the pairing property is kept the same way
 * `shoot.mjs` keeps it: the camera is a literal in world metres, the rig that sets the
 * scene is identical, the seed is identical, and this file is copied byte-for-byte into
 * both trees. Two frames with the same key differ by the source change and by nothing else.
 *
 * The scene is the same rig `tools/probe-aperture.mjs` measures, so the numbers in the
 * report and the frames beside them are of one event and not two.
 *
 * Usage:
 *   node tools/film-aperture.mjs --port=5731 --out=screenshots/aperture-after
 *   node tools/film-aperture.mjs --port=5732 --out=screenshots/aperture-before
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5731);
const OUT = args.get('out') ?? 'screenshots/aperture';
const W = Number(args.get('w') ?? 1600);
const H = Number(args.get('h') ?? 900);
const SCENE = args.get('scene') ?? 'both';

/**
 * The cameras.
 *
 * `x`/`z` are a world focus point and the rig puts the eye behind it: `zoom` 0 is eye level
 * among the men and 1 is a strategic overview. Every one of these is stated as an offset
 * from the Porta Byrsae rather than as an absolute, so a frame keeps meaning the same thing
 * if the gate ever moves — and so the two arms cannot silently drift apart.
 *
 *   out    metres outward from the gate along its own axis; negative is inside the city
 *   lat    metres along the wall
 */
const CAMS = {
  'gate-approach': { out: 30, lat: 0, zoom: 0.52, yaw: 0, at: 6,
    desc: 'the squadron closing on the Porta Byrsae, from outside and above' },
  'gate-mouth': { out: 4, lat: 0, zoom: 0.44, yaw: 0, at: 11,
    desc: 'the carriageway and the two piers, from outside' },
  'gate-spread': { out: 4, lat: 0, zoom: 0.44, yaw: 0, at: 18,
    desc: 'the same camera as gate-mouth seven seconds later — who is through and who is not' },
  'gate-through': { out: -30, lat: 0, zoom: 0.56, yaw: Math.PI, at: 26,
    desc: 'from inside Carthage, looking back at the gate the squadron came through' },
  /*
   * The flight cameras follow the unit, and the gate cameras do not, and the reason is the
   * pairing property rather than convenience.
   *
   * A fixed camera pairs two frames only if the subject is in both of them. That holds at a
   * gate, which does not move and which both arms are trying to enter. It does not hold for
   * a rout: the whole finding is that the two arms run to *different places*, so a camera
   * parked where one of them ends up frames an empty street in the other. Measured on the
   * first cut of these: at t+23 the before arm's cohort was 90 m from the camera behind two
   * insulae, and the frame is a photograph of a wall.
   *
   * Following the unit keeps the subject, the second, the zoom and the bearing identical and
   * lets the *background* differ, which is exactly the variable under test.
   */
  'rout-break': { follow: true, zoom: 0.40, yaw: 0, at: 4,
    desc: 'the cohort inside Carthage at the moment it breaks' },
  'rout-wall': { follow: true, zoom: 0.40, yaw: 0, at: 23,
    desc: 'twenty-three seconds of flight later' },
  'rout-late': { follow: true, zoom: 0.46, yaw: 0, at: 40,
    desc: 'forty seconds in — where the broken cohort actually got to' },
};

const enc = (c) => Buffer.from(JSON.stringify(c)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const tok = enc({
  map: 'carthage', opponent: 2, unitSize: 'ultra',
  rome: { 'legio-cohort': 6, 'praetorian-cohort': 2, 'urban-cohort': 2, sagittarii: 2, equites: 3, scorpio: 1 },
  juthungi: { 'juthungi-warband': 6, 'juthungi-spears': 3, 'juthungi-skirmishers': 3, 'juthungi-chosen': 2, 'juthungi-berserkers': 2, 'juthungi-riders': 3 },
  quality: 'high', difficulty: 'hard', seed: 4265438264,
});

const base = `http://127.0.0.1:${PORT}`;
const up = await fetch(`${base}/src/main.ts`).catch(() => null);
if (!up || !up.ok) { console.error(`no dev server at ${base}`); process.exit(2); }

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const errs = [];

const RIG = `
window.__film = (() => {
  const g = window.__game, e = g.engine, ctx = e.context, battle = g.battle;
  const city = ctx.tryGet('city');
  const pool = battle.pool;
  const gt = city.getGates()[0];
  const ox = Math.sin(gt.facing), oz = Math.cos(gt.facing);
  const lx = Math.cos(gt.facing), lz = -Math.sin(gt.facing);
  const held = [];
  const holdAI = () => {
    for (const nm of ['tactical-ai', 'general-ai']) {
      const s = ctx.tryGet(nm);
      if (!s || !s.fixedUpdate) continue;
      held.push([s, s.fixedUpdate]);
      s.fixedUpdate = () => {};
    }
  };
  const place = (u, x, z, facing) => {
    const dx = x - u.x, dz = z - u.z;
    for (const i of u.members) {
      pool.x[i] += dx; pool.z[i] += dz;
      pool.y[i] = battle.groundAt(pool.x[i], pool.z[i]);
      pool.vx[i] = 0; pool.vz[i] = 0; pool.facing[i] = facing;
    }
    u.x = x; u.z = z; u.facing = facing; u.targetFacing = facing;
    u.targetX = x; u.targetZ = z; u.waypoints.length = 0; u.contactLock = false;
  };
  const isCav = (d) => d.unitClass === 'heavy-cavalry' || d.unitClass === 'light-cavalry';
  const pick = (cav) => {
    let best = null;
    for (const u of battle.units) {
      if (u.destroyed || u.alive === 0) continue;
      if (battle.siege && battle.siege.ownsUnit && battle.siege.ownsUnit(u.id)) continue;
      const d = battle.typeOf(u);
      if (!d) continue;
      if (cav ? !isCav(d) : (isCav(d) || d.walkSpeed < 1.0)) continue;
      if (!best || u.alive > best.alive) best = u;
    }
    return best;
  };
  return {
    at: (out, lat) => ({ x: gt.x + ox * out + lx * lat, z: gt.z + oz * out + lz * lat }),
    anchorOf: (id) => { const u = battle.unitById(id); return u ? { x: u.x, z: u.z } : null; },
    gate: () => ({ x: gt.x, z: gt.z, facing: gt.facing }),
    setupGate() {
      city.setGateOpen(gt.id, true);
      if (city.setGateDoorBroken) city.setGateDoorBroken(gt.id);
      holdAI();
      const u = pick(true);
      place(u, gt.x + ox * 55, gt.z + oz * 55, gt.facing + Math.PI);
      e.events.emit('orderIssued', {
        unitIds: [u.id], kind: 'move',
        x: gt.x - ox * 60, z: gt.z - oz * 60, facing: gt.facing + Math.PI, running: true,
      });
      return { unitId: u.id, typeId: u.typeId };
    },
    /**
     * What is in the frame, in numbers.
     *
     * A pair of frames in which the subject is absent from one of them is a pair of frames
     * about nothing, and there is no way to tell that by looking. This is recorded beside
     * every shot so the caption can be checked against the world.
     */
    census(unitId) {
      const u = battle.unitById(unitId);
      if (!u) return { gone: true };
      let live = 0, through = 0, inBand = 0, worstLat = 0, bodyIn = 0;
      for (const i of u.members) {
        const st = pool.state[i];
        if (st === 10 || st === 11) continue;
        live++;
        const dOut = (pool.x[i] - gt.x) * ox + (pool.z[i] - gt.z) * oz;
        const dLat = Math.abs((pool.x[i] - gt.x) * lx + (pool.z[i] - gt.z) * lz);
        if (dOut < -2) through++;
        if (Math.abs(dOut) < 14 && dLat < 22) inBand++;
        if (Math.abs(dOut) < 14 && dLat > worstLat) worstLat = dLat;
        if (battle.elevated[i] === 0
          && battle.masonry.solidAt(pool.x[i], pool.z[i], pool.y[i], 1.05) >= 0) bodyIn++;
      }
      return {
        live, through, inFrame: inBand, worstLateral: +worstLat.toFixed(2),
        mountInMasonry: bodyIn, files: u.width,
        squeezedFrom: battle.squeezedFrom ? battle.squeezedFrom(u.id) : -1,
        anchor: { x: +u.x.toFixed(1), z: +u.z.toFixed(1) },
        order: u.order,
      };
    },
    setupRout() {
      holdAI();
      const u = pick(false);
      const px = gt.x + lx * -60 - ox * 35;
      const pz = gt.z + lz * -60 - oz * 35;
      place(u, px, pz, gt.facing + Math.PI);
      battle.rout(u);
      return { unitId: u.id, typeId: u.typeId };
    },
  };
})();
`;

const shoot = async (scene, keys) => {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on('pageerror', (e) => errs.push(`${scene}: ${String(e)}`));
  const url = `${base}/?harness=1&quality=high&w=${W}&h=${H}&scenario=assault&hour=11.4&battle=${tok}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
  // The interface is not the subject. Same policy and the same two mechanisms as
  // `shoot.mjs`: strip the DOM root, and hide `WorldOverlay`, which is a THREE.Group in the
  // scene and survives any amount of CSS.
  await page.addStyleTag({
    content: '#hud-root, #loading, #menu-root { display: none !important; visibility: hidden !important; }',
  });
  await page.evaluate(() => {
    const hud = window.__game?.engine?.context?.tryGet?.('hud');
    if (hud && hud.overlay) hud.overlay.visible = false;
  });
  await page.evaluate(RIG);
  const info = await page.evaluate((s) => (s === 'gate'
    ? window.__film.setupGate() : window.__film.setupRout()), scene);
  console.log(`  ${scene}: ${info.typeId} (unit ${info.unitId})`);

  let t = 0;
  const census = {};
  for (const key of keys) {
    const cam = CAMS[key];
    await page.evaluate(([dt, c, id]) => {
      const g = window.__game;
      while (g.simTime() < dt - 1e-6) g.advance(Math.min(0.5, dt - g.simTime()));
      const p = c.follow ? window.__film.anchorOf(id) : window.__film.at(c.out, c.lat);
      g.setCamera(p.x, p.z, c.zoom, c.yaw);
      g.advance(0.3);
    }, [cam.at, cam, info.unitId]);
    t = cam.at;
    const cen = await page.evaluate((id) => window.__film.census(id), info.unitId);
    census[key] = cen;
    const file = path.join(OUT, `${key}.png`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, await page.screenshot({ type: 'png' }));
    console.log(`    ${key.padEnd(15)} t+${String(cam.at).padStart(3)}s  ${file}`);
    console.log(`      live ${cen.live}  through ${cen.through}  within 14 m of the gate ${cen.inFrame}`
      + `  worst lateral ${cen.worstLateral} m  mount-in-stone ${cen.mountInMasonry}`
      + `  files ${cen.files}${cen.squeezedFrom >= 0 ? ` (from ${cen.squeezedFrom})` : ''}`
      + `  anchor ${cen.anchor.x},${cen.anchor.z}`);
  }
  void t;
  await writeFile(path.join(OUT, `${scene}-census.json`),
    JSON.stringify({ scene, unit: info, cams: CAMS, census }, null, 2));
  await page.close();
};

if (SCENE === 'gate' || SCENE === 'both') {
  await shoot('gate', ['gate-approach', 'gate-mouth', 'gate-spread', 'gate-through']);
}
if (SCENE === 'rout' || SCENE === 'both') {
  await shoot('rout', ['rout-break', 'rout-wall', 'rout-late']);
}
if (errs.length) { console.error(`page errors:\n  ${errs.join('\n  ')}`); }
await browser.close();
process.exit(errs.length ? 1 : 0);
