/**
 * The shot-script format, and everything about it that does not need a browser.
 *
 * `tools/film.mjs` is the runner; this file is the *language*. It holds the vocabulary, the
 * validator, the camera maths and the frame plan, and it holds them here rather than in the
 * runner for three reasons that are worth stating because they shaped the format:
 *
 *   1. **An author must not have to read the runner.** Every field is declared once in
 *      `FIELDS` / `ANCHORS` / `STAGE` below, and `film.mjs --check` prints the plan a script
 *      resolves to without launching anything. A validation failure names the shot, the field,
 *      what was given and what is accepted.
 *   2. **A GUI has to sit on top of this later, and the owner asked for that explicitly.** So
 *      a script is *data*: no functions anywhere in it, no closures, nothing the runner calls
 *      back into. `--json` dumps a fully-resolved film and `film.mjs` accepts a `.json` script
 *      as readily as a `.mjs` one, so an editor's read and write paths are both one file
 *      format. The moment a script could contain a function, a GUI would have to be able to
 *      author JavaScript, and this whole thing would have to be rewritten.
 *   3. **The camera maths is testable without a GPU.** `planFilm` resolves a whole film into
 *      per-frame camera states given nothing but the anchors, which is exactly the input a
 *      viewport preview would need.
 *
 * ## Reproducibility, which is the hard requirement
 *
 * A shot script names a *battle*, not a *recording*. The same script on the same working tree
 * must produce the same frames, so:
 *
 *   - Every scene carries an explicit `seed`, and it reaches the app through a `?battle=`
 *     token, which is the only channel that carries one (`src/sim/battleConfig.ts:914`).
 *     A scene with no seed is refused rather than defaulted, because a default is a decision
 *     nobody wrote down.
 *   - Nothing anywhere reads the wall clock. One captured frame is one
 *     `engine.advance(1/30, 1000/30)` on the fixed 30 Hz grid, the rAF loop is stopped, and
 *     the runner asserts the clock moved by exactly what the plan said it would.
 *   - `start: { find: … }` — "cut in two seconds before the gate gives way" — is resolved by a
 *     *scouting pass* over that same 1/30 grid with `{ render: false }`, which the engine
 *     documents as bit-identical to a rendered one. It is never resolved against wall time and
 *     never against `fastForward`, whose 1000/60 step is a measurably different battle.
 *   - Provenance is stamped from the **working tree**, not from `HEAD`. See `provenance()`.
 *
 * The camera maths in `frameState` is the shipped trailer's, generalised from two keyframes to
 * N with per-segment easing and an optional Catmull-Rom rail. It is deliberately the same
 * maths: that camera model produced an eighty-six second film, and a new one would have to
 * re-learn the two things it already knows — that `RTSCamera`'s zoom scalar couples standoff,
 * pitch and focal length into one dial that no photographer would accept, and that a shot's
 * heights must be measured against a *named datum* (terrain, wall-walk, crest) or they go
 * stale the moment the curtain is re-cut.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** The simulation's fixed tick rate, and therefore the film's frame rate. Not a knob. */
export const FPS = 30;

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

/**
 * Named easings. A rail segment's `ease` is the curve *into* that key.
 *
 * `smoothstep` is the default because a camera that starts and stops abruptly reads as a cut
 * rather than as a move, and the trailer's one editorial disaster was a beat that stepped
 * backwards across a join. `hold` is a step function and exists so a rail can carry a hard
 * change — a lens swap on a cut-in — without an author having to author two shots.
 */
export const EASINGS = {
  linear: (u) => u,
  smoothstep: (u) => u * u * (3 - 2 * u),
  smootherstep: (u) => u * u * u * (u * (u * 6 - 15) + 10),
  easeIn: (u) => u * u,
  easeOut: (u) => 1 - (1 - u) * (1 - u),
  easeInCubic: (u) => u * u * u,
  easeOutCubic: (u) => 1 - (1 - u) ** 3,
  hold: (u) => (u >= 1 ? 1 : 0),
};

const lerp = (a, b, u) => a + (b - a) * u;
const clamp01 = (u) => (u < 0 ? 0 : u > 1 ? 1 : u);

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * Anchors: what a shot points at.
 *
 * `docs/tech/TOOLING.md` states the single most important convention in this project's visual
 * tooling — *use a named camera, never hand-place one* — and it was earned by a shot whose
 * fixed focus ended up in the corner of the frame with ninety per cent grass in it once the
 * line moved. An anchor is that convention: a shot names a thing, the runner asks the live
 * world where it is, and the rail is laid out in the anchor's own frame of reference.
 *
 * `frame` says which offset fields the anchor understands:
 *   - `oriented` — has an outward normal and a run: `stand` (metres out along the normal),
 *     `along` (metres down the run), and `yaw: 'in' | 'out' | 'along'`. Wall bays.
 *   - `facing` — has a heading: `along` slides down the subject's frontage.
 *   - `plain` — a point: `dx` / `dz` in world metres.
 * Every anchor also accepts `dx`/`dz`, which are applied last and in world axes.
 */
export const ANCHORS = {
  world: { frame: 'plain', fields: ['x', 'z'], desc: 'A fixed world point. The escape hatch, and the only anchor that can go stale.' },
  bay: { frame: 'oriented', fields: ['k', 'subject'], desc: "A garrison bay of the curtain, `k` bays from the gate bay. `subject: 'gate'` re-centres on the gate itself, which is not at the centre of its own bay — the road decides where it is." },
  gate: { frame: 'oriented', fields: [], desc: "Shorthand for `{ kind: 'bay', k: 0, subject: 'gate' }`." },
  unitType: { frame: 'facing', fields: ['id'], desc: "The largest surviving unit of a roster type, e.g. `war-elephants`." },
  unitClass: { frame: 'facing', fields: ['faction', 'cls', 'pick'], desc: "The largest, or `pick: 'frontmost'`, surviving unit of a class in a faction. Faction 0 is Rome." },
  cavalryUnit: { frame: 'facing', fields: [], desc: 'The largest surviving cavalry unit on either side.' },
  frontGap: { frame: 'plain', fields: [], desc: 'The midpoint of the two front *lines* — not of the two hosts, whose centroids sit tens of metres behind where the lines are about to touch.' },
  contact: { frame: 'plain', fields: [], desc: 'The densest 40 m cell of men actually in melee; before contact, the midpoint of the two hosts. Also yields `axis`.' },
  corpses: { frame: 'plain', fields: [], desc: 'The densest 40 m cell of the dead. For an aftermath beat.' },
};

/**
 * Rail key fields. Numeric fields interpolate; the rest must be constant across a shot.
 *
 * Named the way a photographer names them — eye height, aim height, standoff, focal length —
 * rather than as `RTSCamera`'s `zoom`, and that is not a matter of taste. `zoom` is one scalar
 * from which the rig derives orbit radius, pitch *and* field of view simultaneously, so "close
 * to the men" and "far enough back to see the wall" are the same dial. Three of the first
 * trailer pass's siege frames came back as a 1080p photograph of brick because of it.
 */
export const RAIL_FIELDS = {
  at: { kind: 'number', desc: 'Position of this key, 0..1 across the shot. Keys must ascend and the first must be 0.' },
  ease: { kind: 'name', desc: `Easing into this key. One of: ${Object.keys(EASINGS).join(', ')}. Default smoothstep.` },
  stand: { kind: 'lerp', unit: 'm', desc: 'Out along the anchor\'s outward normal. Oriented anchors only.' },
  along: { kind: 'lerp', unit: 'm', desc: 'Along the anchor\'s run, or down a unit\'s frontage.' },
  dx: { kind: 'lerp', unit: 'm', desc: 'World +X from the anchor.' },
  dz: { kind: 'lerp', unit: 'm', desc: 'World +Z from the anchor.' },
  lift: { kind: 'datum', desc: "The ground datum heights are measured from: a number (metres above terrain), 'walk', 'walk+2', 'crest', 'crest-1'. The *base* may not change mid-shot; the offset may, and interpolates." },
  liftAdd: { kind: 'lerp', unit: 'm', internal: true, desc: "The numeric half of `lift`, split out by the validator so it can interpolate. Do not write it yourself; write `lift`." },
  eye: { kind: 'lerp', unit: 'm', desc: 'Eye height above the datum.' },
  aim: { kind: 'lerp', unit: 'm', desc: 'Height of the look-at point above the datum.' },
  dist: { kind: 'lerp', unit: 'm', desc: 'Horizontal standoff from the look-at point to the eye.' },
  fov: { kind: 'lerp', unit: 'deg', desc: 'Vertical field of view. This is the lens: 32 is a long lens, 55 is wide.' },
  yaw: { kind: 'yaw', desc: "Base heading: 'in' / 'out' / 'along' against an oriented anchor, a number in radians, or omitted to take the anchor's own axis." },
  yawAdd: { kind: 'lerp', unit: 'rad', desc: 'Added to the base heading. This is where a pan lives.' },
  zoom: { kind: 'lerp', desc: "RTSCamera's own zoom scalar, 0..1, for the two shots where the coupling is right — a strategic overview. Mutually exclusive with eye/aim/dist/fov." },
};

/**
 * Staged setup: everything a shot may do to the world before the camera rolls.
 *
 * The owner asked for staged setups explicitly, so this exists — but every entry is written
 * into the manifest under `staged`, and any film with a non-empty one is stamped
 * `emergent: false`. A frame that was arranged has to say so. The trailer's README ends on the
 * one thing it could not show, "and the shot of men going through is at Carthage's tower ramps
 * instead. It was not staged, because it does not happen"; that sentence is only worth
 * anything if the frames that *were* staged are labelled.
 *
 * Most staging is not here at all: the order of battle, the seed, the hour, the map, the
 * scenario and the opposing faction are *scene* fields, because they are fixed before `Engine`
 * is constructed and reach the app through the `?battle=` token. This list is only the things
 * that must happen to a world that already exists.
 */
export const STAGE = {
  shakeScale: { args: ['value'], sim: false, desc: "Scale every camera shake the battle asks for. `RTSCamera.shakeScale`, default 0.35. Camera only — the simulation never reads it." },
  shake: { args: ['amplitude', 'decay'], sim: false, desc: 'Kick the camera once, now. Camera only.' },
  weather: { args: ['kind'], sim: true, desc: "'clear' | 'overcast' | 'rain'. Applied live and asserted; it drives the VFX system." },
  rout: { args: ['unit'], sim: true, desc: 'Break a unit. `unit` is an anchor spec resolved the same way `track` is. This is a real intervention in the battle and is labelled as one.' },
};

/** Predicates `start: { find: … }` can wait for. Evaluated on the 1/30 grid, in order. */
export const FINDERS = {
  contact: { args: [], desc: 'The first tick on which anybody is in melee.' },
  melee: { args: ['n'], desc: 'At least `n` men in melee.' },
  gateBlow: { args: ['nth'], desc: 'The ram\'s `nth` blow on the gate.' },
  gateOpen: { args: [], desc: 'The gate leaves give way.' },
  climbing: { args: ['n'], desc: 'At least `n` men on ladders or ramps.' },
  routing: { args: ['n'], desc: 'At least `n` men broken and running.' },
  corpses: { args: ['n'], desc: 'At least `n` dead on the field.' },
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

class ShotError extends Error {}

const fail = (where, msg) => {
  throw new ShotError(`${where}: ${msg}`);
};

const MAPS = ['campus-martius', 'carthage', 'pydna'];
const SCENARIOS = ['field', 'assault'];
const ENEMIES = ['juthungi', 'germanic', 'carthage'];
const TIERS = ['low', 'medium', 'high', 'ultra'];
const UNIT_SIZES = ['small', 'normal', 'large', 'ultra', 'extreme'];
const DIFFICULTIES = ['easy', 'normal', 'hard', 'legendary'];
const WEATHERS = ['clear', 'overcast', 'rain'];

const isPlainNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Refuse a function anywhere in the script.
 *
 * This is the load-bearing check for the GUI, and it is cheap to make and impossible to make
 * later. A script that can hold a callback is a script no editor can round-trip, and the
 * temptation to add one — "just this one anchor needs a predicate" — arrives on the second
 * film. Fields that need computation get a named entry in a table in this file instead.
 */
function assertData(v, where) {
  if (typeof v === 'function') fail(where, 'a shot script may not contain functions — see FIELDS in tools/lib/shot-format.mjs for the named alternatives');
  if (Array.isArray(v)) { v.forEach((x, i) => assertData(x, `${where}[${i}]`)); return; }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) assertData(x, `${where}.${k}`);
  }
}

/** Parse a `lift` datum into `{ base, add }`. */
export function parseLift(v) {
  if (isPlainNumber(v)) return { base: 'terrain', add: v };
  if (typeof v !== 'string') return null;
  if (v === 'walk') return { base: 'walk', add: 0 };
  if (v === 'crest') return { base: 'crest', add: 0 };
  let m = /^walk([+-][\d.]+)$/.exec(v);
  if (m) return { base: 'walk', add: Number(m[1]) };
  m = /^crest([+-][\d.]+)$/.exec(v);
  if (m) return { base: 'crest', add: Number(m[1]) };
  return null;
}

function validateScene(id, s) {
  const w = `scene "${id}"`;
  if (!s || typeof s !== 'object') fail(w, 'must be an object');
  if (!MAPS.includes(s.map)) fail(w, `map ${JSON.stringify(s.map)} — one of ${MAPS.join(', ')}`);
  if (!SCENARIOS.includes(s.scenario)) fail(w, `scenario ${JSON.stringify(s.scenario)} — one of ${SCENARIOS.join(', ')}`);
  if (s.scenario === 'assault' && s.map === 'pydna') fail(w, 'Pydna has no city, so it cannot carry an assault; sanitiseConfig would silently give you a field battle');
  if (s.enemy !== undefined && s.enemy !== null && !ENEMIES.includes(s.enemy)) fail(w, `enemy ${JSON.stringify(s.enemy)} — one of ${ENEMIES.join(', ')}`);
  if (!isPlainNumber(s.hour) || s.hour < 4 || s.hour > 21) fail(w, `hour must be a number in 4..21, got ${JSON.stringify(s.hour)} (SkySystem's own range)`);
  // Refused rather than defaulted: a seed nobody wrote down is a film nobody can re-shoot.
  if (!Number.isInteger(s.seed) || s.seed < 0 || s.seed > 0xffffffff)
    fail(w, `seed must be an explicit uint32 — a scene without one is not reproducible. Got ${JSON.stringify(s.seed)}`);
  if (s.unitSize !== undefined && s.unitSize !== null && !UNIT_SIZES.includes(s.unitSize)) fail(w, `unitSize ${JSON.stringify(s.unitSize)} — one of ${UNIT_SIZES.join(', ')}`);
  if (s.difficulty !== undefined && s.difficulty !== null && !DIFFICULTIES.includes(s.difficulty)) fail(w, `difficulty ${JSON.stringify(s.difficulty)} — one of ${DIFFICULTIES.join(', ')}`);
  if (s.quality !== undefined && s.quality !== null && !TIERS.includes(s.quality)) fail(w, `quality ${JSON.stringify(s.quality)} — one of ${TIERS.join(', ')}`);
  if (s.weather !== undefined && s.weather !== null && !WEATHERS.includes(s.weather)) fail(w, `weather ${JSON.stringify(s.weather)} — one of ${WEATHERS.join(', ')}`);
  if (s.armies !== undefined && s.armies !== null && (typeof s.armies !== 'object' || Array.isArray(s.armies))) fail(w, 'armies must be an object of BattleConfig composition fields (rome, juthungi, carthage, siegeRome, siegeJuthungi, siegeCarthage, siegeRomanTrain)');
  return {
    map: s.map,
    scenario: s.scenario,
    enemy: s.enemy ?? 'juthungi',
    hour: s.hour,
    seed: s.seed,
    unitSize: s.unitSize ?? 'ultra',
    difficulty: s.difficulty ?? 'hard',
    quality: s.quality ?? null,
    weather: s.weather ?? null,
    armies: s.armies ?? null,
  };
}

function validateTrack(w, tIn) {
  /*
   * Idempotent: this accepts its own output as readily as hand-written input.
   *
   * That is the whole of the `--json` round trip, and therefore the whole of "a GUI can sit on
   * top of this". `film.mjs --json` writes the *normalised* film, an editor loads it, edits it
   * and writes it back, and `film.mjs <that>.json` shoots it. If normalising were one-way the
   * editor would have to reproduce the author's spelling rather than the validator's, which is
   * two formats wearing one name.
   */
  const t = tIn && tIn.spec ? { ...tIn.spec, mode: tIn.mode, lag: tIn.lag } : tIn;
  if (!t || typeof t !== 'object') fail(w, 'track is required and must be an object — see ANCHORS in tools/lib/shot-format.mjs');
  const a = ANCHORS[t.kind];
  if (!a) fail(w, `track.kind ${JSON.stringify(t.kind)} — one of ${Object.keys(ANCHORS).join(', ')}`);
  if (t.kind === 'world' && (!isPlainNumber(t.x) || !isPlainNumber(t.z))) fail(w, 'track kind "world" needs numeric x and z');
  if (t.kind === 'unitType' && typeof t.id !== 'string') fail(w, 'track kind "unitType" needs a roster id, e.g. "war-elephants"');
  if (t.kind === 'unitClass' && (typeof t.cls !== 'string' || !Number.isInteger(t.faction))) fail(w, 'track kind "unitClass" needs cls and an integer faction (0 = Rome)');
  if (t.kind === 'bay' && !Number.isInteger(t.k)) fail(w, 'track kind "bay" needs an integer k, the offset in bays from the gate bay');
  const mode = t.mode ?? 'pin';
  if (mode !== 'pin' && mode !== 'follow') fail(w, `track.mode ${JSON.stringify(mode)} — "pin" (resolve once at the first frame) or "follow" (re-resolve every frame)`);
  if (t.lag !== undefined && (!isPlainNumber(t.lag) || t.lag < 0)) fail(w, 'track.lag is seconds of smoothing on a following anchor, and must be >= 0');
  if (mode === 'pin' && t.lag && tIn.spec === undefined) fail(w, 'track.lag only means anything with mode "follow"');
  const spec = t.kind === 'gate' ? { kind: 'bay', k: 0, subject: 'gate' } : { ...t };
  delete spec.mode; delete spec.lag;
  return { spec, mode, lag: t.lag ?? 0.35, frame: (ANCHORS[t.kind] ?? {}).frame };
}

function validateRail(w, rail, trackFrame, givenBase) {
  if (!Array.isArray(rail) || rail.length < 1) fail(w, 'rail must be an array of at least one key');
  let prevAt = -1;
  const liftBases = new Set();
  const constants = {};
  for (let i = 0; i < rail.length; i++) {
    const k = rail[i];
    const kw = `${w} rail[${i}]`;
    if (!k || typeof k !== 'object') fail(kw, 'each rail key must be an object');
    for (const name of Object.keys(k)) {
      // `liftAdd` is this validator's own spelling of the numeric half of `lift`, and it is
      // accepted back only alongside the shot-level `liftBase` it was split out with.
      if (name === 'liftAdd' && givenBase) continue;
      if (!Object.hasOwn(RAIL_FIELDS, name) || RAIL_FIELDS[name].internal) {
        const allowed = Object.entries(RAIL_FIELDS).filter(([, d]) => !d.internal).map(([n]) => n);
        fail(kw, `unknown field ${JSON.stringify(name)} — one of ${allowed.join(', ')}`);
      }
    }
    const at = rail.length === 1 ? 0 : k.at;
    if (!isPlainNumber(at) || at < 0 || at > 1) fail(kw, `at must be a number in 0..1, got ${JSON.stringify(k.at)}`);
    if (at <= prevAt) fail(kw, `at ${at} does not ascend past the previous key's ${prevAt}`);
    prevAt = at;
    if (k.ease !== undefined && !Object.hasOwn(EASINGS, k.ease)) fail(kw, `ease ${JSON.stringify(k.ease)} — one of ${Object.keys(EASINGS).join(', ')}`);
    if (k.lift !== undefined) {
      const p = parseLift(k.lift);
      if (!p) fail(kw, `lift ${JSON.stringify(k.lift)} — a number of metres above terrain, or 'walk' / 'crest' with an optional +N / -N`);
      liftBases.add(p.base);
    } else if (k.liftAdd !== undefined && givenBase) {
      if (!isPlainNumber(k.liftAdd)) fail(kw, 'liftAdd must be a number of metres');
      liftBases.add(givenBase);
    }
    if (k.yaw !== undefined) {
      const ok = isPlainNumber(k.yaw) || k.yaw === 'in' || k.yaw === 'out' || k.yaw === 'along';
      if (!ok) fail(kw, `yaw ${JSON.stringify(k.yaw)} — 'in', 'out', 'along', or a number of radians`);
      if (typeof k.yaw === 'string' && trackFrame !== 'oriented') {
        fail(kw, `yaw ${JSON.stringify(k.yaw)} needs an oriented anchor (a wall bay); this shot tracks a ${trackFrame} anchor`);
      }
      if (constants.yaw === undefined) constants.yaw = k.yaw;
      else if (constants.yaw !== k.yaw) fail(kw, `yaw changes from ${JSON.stringify(constants.yaw)} to ${JSON.stringify(k.yaw)} mid-shot; put the turn in yawAdd, which interpolates`);
    }
    if (k.stand !== undefined && trackFrame !== 'oriented') fail(kw, `stand needs an oriented anchor (a wall bay); this shot tracks a ${trackFrame} anchor. Use dx/dz.`);
    if (k.along !== undefined && trackFrame === 'plain') fail(kw, `along needs an anchor with a direction — a wall bay's run or a unit's frontage. This shot tracks a plain point; use dx/dz.`);
    for (const [name, def] of Object.entries(RAIL_FIELDS)) {
      if (def.kind !== 'lerp' || k[name] === undefined) continue;
      if (!isPlainNumber(k[name])) fail(kw, `${name} must be a number${def.unit ? ` (${def.unit})` : ''}, got ${JSON.stringify(k[name])}`);
    }
    const framed = k.eye !== undefined || k.aim !== undefined || k.dist !== undefined || k.fov !== undefined;
    if (framed && k.zoom !== undefined) fail(kw, 'zoom and eye/aim/dist/fov are two different camera models; pick one');
    if (framed && (k.eye === undefined || k.aim === undefined || k.dist === undefined || k.fov === undefined)) {
      fail(kw, 'eye, aim, dist and fov travel together — a key with some of them and not others has no camera');
    }
  }
  if (liftBases.size > 1) fail(w, `the lift datum changes mid-shot (${[...liftBases].join(' -> ')}); a shot measures its heights against one surface`);
  if (rail.length > 1) {
    if (rail[0].at !== 0) fail(w, `the first rail key must sit at at:0, got ${rail[0].at}`);
    if (rail[rail.length - 1].at !== 1) fail(w, `the last rail key must sit at at:1, got ${rail[rail.length - 1].at}`);
  }
  /*
   * `lift` is split here into a base the whole shot shares and an offset each key carries.
   *
   * Written as one field it cannot interpolate: `'crest'` and `'crest+2'` are two strings, and
   * any mixer that sees two strings has to keep one of them. Split, the base is checked once
   * for the whole shot — a camera that changed which surface it measured from mid-move would
   * jump by the height of a wall — and the offset is an ordinary number that eases like every
   * other. The trailer's camera had this and it was two lines of special case inside its frame
   * loop; here it is a normalisation, which is also what makes it work under Catmull-Rom.
   */
  const keys = rail.map((k, i) => {
    const out = { ...k, at: rail.length === 1 ? 0 : k.at };
    if (k.lift !== undefined) { out.liftAdd = parseLift(k.lift).add; delete out.lift; }
    else if (k.liftAdd !== undefined && givenBase) out.liftAdd = k.liftAdd;
    void i;
    return out;
  });
  return { keys, liftBase: liftBases.size ? [...liftBases][0] : null };
}

function validateSpeed(w, speed) {
  if (speed === undefined) return [{ at: 0, v: 1 }, { at: 1, v: 1 }];
  if (isPlainNumber(speed)) {
    if (speed < 0) fail(w, 'speed may not be negative — the simulation cannot be rewound');
    if (speed > 8) fail(w, 'speed above 8 outruns the engine\'s own maxStepsPerFrame guard and stops being a measurement');
    return [{ at: 0, v: speed }, { at: 1, v: speed }];
  }
  if (!Array.isArray(speed) || speed.length < 2) fail(w, 'speed is a number (sim seconds per footage second, 0 = freeze) or an array of at least two { at, v } keys');
  let prev = -1;
  for (const k of speed) {
    if (!isPlainNumber(k?.at) || !isPlainNumber(k?.v)) fail(w, `speed keys are { at: 0..1, v: number }, got ${JSON.stringify(k)}`);
    if (k.v < 0 || k.v > 8) fail(w, `speed value ${k.v} out of range 0..8`);
    if (k.at <= prev) fail(w, 'speed keys must ascend in at');
    prev = k.at;
  }
  if (speed[0].at !== 0 || speed[speed.length - 1].at !== 1) fail(w, 'a speed ramp must run from at:0 to at:1');
  return speed;
}

function validateStage(w, stage) {
  if (stage === undefined) return [];
  if (!Array.isArray(stage)) fail(w, 'stage must be an array of actions');
  return stage.map((a, i) => {
    const aw = `${w} stage[${i}]`;
    const def = STAGE[a?.do];
    if (!def) fail(aw, `do ${JSON.stringify(a?.do)} — one of ${Object.keys(STAGE).join(', ')}`);
    for (const arg of def.args) if (a[arg] === undefined) fail(aw, `"${a.do}" needs ${def.args.map((x) => `\`${x}\``).join(', ')}`);
    if (a.do === 'weather' && !WEATHERS.includes(a.kind)) fail(aw, `weather kind ${JSON.stringify(a.kind)} — one of ${WEATHERS.join(', ')}`);
    if (a.do === 'rout') validateTrack(aw, a.unit);
    return { ...a, touchesSim: def.sim };
  });
}

function validateStart(w, startIn) {
  // Idempotent, for the same reason as `validateTrack`.
  const start = (startIn && typeof startIn === 'object' && 'find' in startIn && Object.hasOwn(startIn, 'at'))
    ? (startIn.find ?? startIn.at)
    : startIn;
  if (isPlainNumber(start)) {
    if (start < 0) fail(w, 'start must be >= 0 sim seconds');
    return { at: start, find: null };
  }
  if (!start || typeof start !== 'object') fail(w, 'start is a number of sim seconds, or { find, … , offset }');
  const f = FINDERS[start.find];
  if (!f) fail(w, `start.find ${JSON.stringify(start.find)} — one of ${Object.keys(FINDERS).join(', ')}`);
  for (const arg of f.args) if (!isPlainNumber(start[arg])) fail(w, `find "${start.find}" needs a numeric \`${arg}\``);
  if (start.offset !== undefined && !isPlainNumber(start.offset)) fail(w, 'start.offset is a number of sim seconds, usually negative — "cut in two seconds before it happens"');
  if (start.before !== undefined && !isPlainNumber(start.before)) fail(w, 'start.before is a ceiling in sim seconds on how far the scouting pass will run');
  return { at: null, find: { ...start, offset: start.offset ?? 0, before: start.before ?? 600 } };
}

/**
 * Validate and normalise a film. Throws a `ShotError` naming the exact field on any fault.
 *
 * Returns a *new* object; the input is never mutated, because `--json` has to be able to dump
 * both the script as written and the film as resolved without one contaminating the other.
 */
export function validateFilm(film, { source = '<film>' } = {}) {
  assertData(film, 'film');
  if (!film || typeof film !== 'object') fail(source, 'a shot script must default-export an object');
  if (typeof film.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(film.id)) {
    fail(source, `id must be a lowercase kebab-case string (it names the output directory), got ${JSON.stringify(film.id)}`);
  }
  if (!film.scenes || typeof film.scenes !== 'object') fail(source, 'scenes is required: a map of scene id -> { map, scenario, hour, seed, … }');
  if (!Array.isArray(film.shots) || film.shots.length === 0) fail(source, 'shots must be a non-empty array — the cut, in order');

  const scenes = {};
  for (const [id, s] of Object.entries(film.scenes)) scenes[id] = validateScene(id, s);

  const seen = new Set();
  const shots = film.shots.map((sh, i) => {
    const w = `shot[${i}]${sh?.id ? ` "${sh.id}"` : ''}`;
    if (typeof sh?.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(sh.id)) fail(w, 'each shot needs a lowercase kebab-case id (it names its frames)');
    if (seen.has(sh.id)) fail(w, 'duplicate shot id');
    seen.add(sh.id);
    if (!scenes[sh.scene]) fail(w, `scene ${JSON.stringify(sh.scene)} is not declared; declared scenes are ${Object.keys(scenes).join(', ')}`);
    if (!isPlainNumber(sh.len) || sh.len <= 0) fail(w, 'len is the shot\'s length in *footage* seconds and must be > 0');
    const start = validateStart(w, sh.start);
    const speed = validateSpeed(w, sh.speed);
    const motion = sh.motion ?? 'hold';
    if (motion !== 'hold' && motion !== 'substep') fail(w, `motion ${JSON.stringify(motion)} — 'hold' (frame-doubling; the sim is bit-identical to speed 1) or 'substep' (smoother, and a measurably different battle — see docs/video/SHOT-FORMAT.md)`);
    if (motion === 'substep') {
      /*
       * `substep` runs one `advance(1/(30n), 1000/(30n))` per output frame and ticks on every
       * nth, so `n` has to be one integer for the whole shot. A ramp has no single `n`, and a
       * runner that guessed one from the mean would hand back footage whose clock did not match
       * its own plan. Refused here rather than approximated there.
       */
      const v = speed[0].v;
      if (!speed.every((k) => k.v === v)) fail(w, "motion 'substep' needs one constant speed; a ramp has no single sub-step count. Use the default 'hold', which ramps.");
      if (!(v > 0 && v <= 1 && Math.abs(1 / v - Math.round(1 / v)) < 1e-9)) {
        fail(w, `motion 'substep' needs a speed of 1/n for a whole n (1, 0.5, 0.333…, 0.25, …), got ${v}`);
      }
    }
    const interp = sh.interp ?? 'linear';
    if (interp !== 'linear' && interp !== 'catmull') fail(w, `interp ${JSON.stringify(interp)} — 'linear' (piecewise, eased per segment) or 'catmull' (one smooth curve through every key)`);
    const track = validateTrack(w, sh.track);
    const { keys: rail, liftBase } = validateRail(w, sh.rail, track.frame, sh.liftBase ?? null);
    if (interp === 'catmull' && rail.length < 3) fail(w, "interp 'catmull' wants at least three keys; with two it is a straight line and 'linear' says so honestly");
    const stage = validateStage(w, sh.stage);
    if (sh.caption !== undefined && sh.caption !== null) {
      const c = sh.caption;
      if (typeof c?.text !== 'string') fail(w, 'caption needs text');
      if (c.in !== undefined && !isPlainNumber(c.in)) fail(w, 'caption.in is a fraction of the shot, 0..1');
      if (c.out !== undefined && !isPlainNumber(c.out)) fail(w, 'caption.out is a fraction of the shot, 0..1');
    }
    for (const f of ['fadeIn', 'fadeOut']) {
      if (sh[f] !== undefined && sh[f] !== null && (!isPlainNumber(sh[f]) || sh[f] < 0)) fail(w, `${f} is a number of seconds`);
    }
    return {
      id: sh.id,
      scene: sh.scene,
      desc: sh.desc ?? '',
      start,
      len: sh.len,
      speed,
      motion,
      interp,
      track,
      rail,
      liftBase,
      stage,
      caption: sh.caption ? { text: sh.caption.text, sub: sh.caption.sub ?? '', in: sh.caption.in ?? 0.12, out: sh.caption.out ?? 0.92 } : null,
      fadeIn: sh.fadeIn ?? 0,
      fadeOut: sh.fadeOut ?? 0,
      endcard: sh.endcard ? { title: sh.endcard.title ?? 'TOTAL CLAUDE', tagline: sh.endcard.tagline ?? '', url: sh.endcard.url ?? '' } : null,
    };
  });

  return {
    id: film.id,
    title: film.title ?? film.id,
    source,
    width: film.width ?? 1920,
    height: film.height ?? 1080,
    quality: film.quality ?? 'ultra',
    fps: FPS,
    scenes,
    shots,
  };
}

// ---------------------------------------------------------------------------
// The camera
// ---------------------------------------------------------------------------

/** Interpolate every numeric field of two like-shaped key objects. Strings take the earlier. */
function mixKeys(a, b, u) {
  const o = {};
  for (const k of Object.keys(a)) {
    const va = a[k];
    const vb = b === undefined || b[k] === undefined ? va : b[k];
    o[k] = typeof va === 'number' && typeof vb === 'number' ? lerp(va, vb, u) : va;
  }
  for (const k of Object.keys(b ?? {})) if (o[k] === undefined) o[k] = b[k];
  return o;
}

const CR = (p0, p1, p2, p3, t) => {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
};

/**
 * The rail's parameters at normalised position `u` along the shot.
 *
 * `linear` is piecewise: find the segment, ease inside it with the *ending* key's curve. That
 * is C0 and not C1, so a three-key rail has a visible velocity change at the middle key — which
 * is sometimes exactly what a beat wants (arrive, hold, leave) and sometimes a bump.
 *
 * `catmull` runs one uniform Catmull-Rom spline through every key instead, with the ends
 * duplicated so the curve starts and stops at the first and last key rather than overshooting
 * past them. The parameterisation is still eased end-to-end, so the *whole move* starts and
 * stops gently while the middle of it never changes direction abruptly. This is the "camera on
 * a rail" case: three or four stations, one continuous glide.
 */
export function railAt(shot, u) {
  const keys = shot.rail;
  if (keys.length === 1) return { ...keys[0] };
  if (shot.interp === 'catmull') {
    const e = EASINGS[keys[keys.length - 1].ease ?? 'smoothstep'];
    const s = e(clamp01(u));
    // Position on the key index axis, so the keys' own `at` values still set their spacing.
    let seg = 0;
    while (seg < keys.length - 2 && s > keys[seg + 1].at) seg++;
    const a = keys[seg].at, b = keys[seg + 1].at;
    const t = b > a ? (s - a) / (b - a) : 0;
    const k = (i) => keys[Math.max(0, Math.min(keys.length - 1, i))];
    const out = {};
    for (const [name, def] of Object.entries(RAIL_FIELDS)) {
      if (def.kind !== 'lerp') continue;
      if (keys.every((q) => q[name] === undefined)) continue;
      const val = (i) => {
        const q = k(i);
        if (q[name] !== undefined) return q[name];
        // A key that omits a field inherits the nearest one that has it, so a rail can name
        // `fov` on two keys out of five without the other three punching a hole in it.
        for (let d = 1; d < keys.length; d++) {
          if (k(i - d)[name] !== undefined) return k(i - d)[name];
          if (k(i + d)[name] !== undefined) return k(i + d)[name];
        }
        return 0;
      };
      out[name] = CR(val(seg - 1), val(seg), val(seg + 1), val(seg + 2), t);
    }
    for (const q of keys) for (const [name, v] of Object.entries(q)) {
      if (out[name] === undefined && RAIL_FIELDS[name]?.kind !== 'lerp') out[name] = v;
    }
    return out;
  }
  let seg = 0;
  while (seg < keys.length - 2 && u > keys[seg + 1].at) seg++;
  const a = keys[seg], b = keys[seg + 1];
  const span = b.at - a.at;
  const t = span > 0 ? clamp01((u - a.at) / span) : 1;
  return mixKeys(a, b, EASINGS[b.ease ?? 'smoothstep'](t));
}

/**
 * The absolute camera state for one frame, given the rail parameters and a resolved anchor.
 *
 * Everything is absolute and nothing is remembered: `apply` in the page resets the rig and
 * re-parks it from scratch every frame, so a dropped frame, a re-shot shot or a GUI scrubbing
 * backwards all produce the same picture as a straight run.
 */
export function frameState(shot, p, anchor) {
  const st = { fx: 0, fz: 0, yaw: 0, zoom: 0.5, liftY: null, cam: null };

  // Focus, in whichever frame the anchor provides.
  if (anchor.nx !== undefined && (p.stand !== undefined || p.along !== undefined)) {
    st.fx = anchor.x + anchor.nx * (p.stand ?? 0) + anchor.dx * (p.along ?? 0);
    st.fz = anchor.z + anchor.nz * (p.stand ?? 0) + anchor.dz * (p.along ?? 0);
  } else if (anchor.facing !== undefined && p.along !== undefined) {
    // A unit: slide down its own frontage, which is perpendicular to its facing.
    st.fx = anchor.x + Math.cos(anchor.facing) * p.along;
    st.fz = anchor.z - Math.sin(anchor.facing) * p.along;
  } else {
    st.fx = anchor.x;
    st.fz = anchor.z;
  }
  st.fx += p.dx ?? 0;
  st.fz += p.dz ?? 0;

  // The ground datum this shot measures its heights against.
  if (shot.liftBase) {
    const add = p.liftAdd ?? 0;
    st.liftY = shot.liftBase === 'walk' ? anchor.walkY + add
      : shot.liftBase === 'crest' ? anchor.crestY + add
        : anchor.terrY + add;
    if (!Number.isFinite(st.liftY)) {
      throw new ShotError(`shot "${shot.id}": lift datum '${shot.liftBase}' resolved to ${st.liftY} — this anchor has no ${shot.liftBase} surface`);
    }
  }

  // Yaw. Named against the wall where there is one, so it cannot go stale when the curtain is
  // re-cut; otherwise off the axis between the armies, or the subject's own facing.
  const base = p.yaw === 'in' ? Math.atan2(-anchor.nx, -anchor.nz)
    : p.yaw === 'out' ? Math.atan2(anchor.nx, anchor.nz)
      : p.yaw === 'along' ? Math.atan2(anchor.dx, anchor.dz)
        : typeof p.yaw === 'number' ? p.yaw
          : (anchor.axis ?? ((anchor.facing ?? 0) + Math.PI));
  st.yaw = base + (p.yawAdd ?? 0);

  if (p.eye !== undefined) st.cam = { eye: p.eye, aim: p.aim, dist: p.dist, fov: p.fov };
  else st.zoom = p.zoom ?? 0.5;
  return st;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

const speedAt = (keys, u) => {
  let i = 0;
  while (i < keys.length - 2 && u > keys[i + 1].at) i++;
  const a = keys[i], b = keys[i + 1];
  const span = b.at - a.at;
  const t = span > 0 ? clamp01((u - a.at) / span) : 1;
  return lerp(a.v, b.v, EASINGS.smoothstep(t));
};

/**
 * Turn a shot into its frame schedule: for each output frame, how many 1/30 s ticks to fire.
 *
 * This is the whole of time scaling, and it is an accumulator rather than a rate so that a
 * ramp works and a fractional speed does not have to be an exact reciprocal.
 *
 *   - **`ticks === 1`** is the ordinary case and is exactly what the trailer did: one output
 *     frame, one `advance(1/30, 1000/30)`, one simulation tick.
 *   - **`ticks === 0`** is slow motion, and the mechanism is frame-doubling. The runner renders
 *     that frame with `Time.paused` set, which makes `beginFrame` return zero steps and
 *     `scaledDt` zero: the simulation does not move, every visual system is handed dt 0, and
 *     only the camera advances. So the sim on a 0.5x shot is *bit-identical* to the sim on a 1x
 *     shot of the same window — the same ticks in the same order — and the picture is
 *     step-printed the way an optically-printed slow-motion insert is. `motion: 'substep'`
 *     trades that guarantee for interpolated soldier positions; see the doc.
 *   - **`ticks >= 2`** is fast motion. The extra ticks are run with `{ render: false }`, which
 *     the engine documents and `qa-determinism` asserts is bit-identical to a rendered tick.
 *
 * Whatever the speed, a tick is always a whole 1/30 s and always in order, so `simTime` at any
 * frame is an exact multiple of 1/30 and the runner asserts it.
 */
export function scheduleShot(shot) {
  const n = Math.max(1, Math.round(shot.len * FPS));
  const frames = [];
  let acc = 0;
  let fired = 0;
  for (let i = 0; i < n; i++) {
    const u = n <= 1 ? 0 : i / (n - 1);
    acc += speedAt(shot.speed, u) / FPS;
    const want = Math.floor(acc * FPS + 1e-9);
    const ticks = Math.max(0, want - fired);
    fired = want;
    frames.push({ i, u, ticks });
  }
  return { n, frames, simSeconds: fired / FPS };
}

/**
 * The whole film, resolved as far as it can be without a world.
 *
 * Anchors are the one thing missing: they are queries against a live battle and no amount of
 * static analysis will answer them. Everything else — frame counts, tick schedules, rail
 * parameters, overlay opacities, capture order, the total run time — is here, which is what
 * `--check` prints and what a GUI's timeline would draw.
 */
export function planFilm(film) {
  const shots = film.shots.map((sh) => {
    const sched = scheduleShot(sh);
    return {
      id: sh.id,
      scene: sh.scene,
      desc: sh.desc,
      frames: sched.n,
      footageSeconds: +(sched.n / FPS).toFixed(3),
      simSeconds: +sched.simSeconds.toFixed(3),
      start: sh.start,
      motion: sh.motion,
      interp: sh.interp,
      track: sh.track,
      staged: sh.stage.filter((a) => a.touchesSim).map((a) => a.do),
      schedule: sched.frames,
      shot: sh,
    };
  });

  /*
   * Capture order is not cut order.
   *
   * `map`, `scenario`, the seed and the opposing faction are fixed before `Engine` exists, so a
   * shot on another world costs a page load — and a page load resets the clock, which can only
   * be fast-forwarded, never rewound. So shots are captured grouped by scene and in ascending
   * start time within each group, and the cut is reassembled in declaration order at the end.
   * A shot whose start is a `find` sorts by the ceiling its scouting pass will not exceed.
   */
  const sceneOrder = [...new Set(shots.map((s) => s.scene))];
  const sortKey = (s) => (s.start.at ?? (s.start.find.before + s.start.find.offset));
  const captureOrder = sceneOrder.flatMap((sc) =>
    shots.filter((s) => s.scene === sc).sort((a, b) => sortKey(a) - sortKey(b)).map((s) => s.id));

  const totalFrames = shots.reduce((a, s) => a + s.frames, 0);
  return {
    id: film.id,
    title: film.title,
    source: film.source,
    width: film.width,
    height: film.height,
    quality: film.quality,
    fps: FPS,
    scenes: film.scenes,
    shots,
    captureOrder,
    pageLoads: sceneOrder.length,
    totalFrames,
    runtimeSeconds: +(totalFrames / FPS).toFixed(3),
    /*
     * True when nothing in this film was arranged.
     *
     * A custom `armies` block counts as staging as firmly as a `rout` does — it is an order of
     * battle nobody would have fought — even though it is a *scene* field and costs the running
     * simulation nothing. The point of the flag is to let a reader trust an unlabelled frame,
     * and "the elephants are in this shot because I put four of them in the army" is exactly
     * the kind of thing a reader would want to have been told.
     */
    emergent: shots.every((s) => s.staged.length === 0)
      && Object.values(film.scenes).every((sc) => !sc.armies),
    stagedScenes: Object.entries(film.scenes).filter(([, sc]) => sc.armies).map(([id]) => id),
  };
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * What tree produced these frames — read off **disk**, not off `HEAD`.
 *
 * `tools/shoot.mjs` stamps a pass with `git rev-parse HEAD:src`, and that is a known defect
 * recorded in `docs/HANDOFF.md`: Vite serves files from the working tree, so any frame taken
 * with an uncommitted edit under `src/` is labelled with the *previous* commit, and the
 * before/after workflow the shot table exists for produces two arms stamped identically. The
 * merge guard then happily merges two different renderers into one record.
 *
 * This does not inherit that. `srcHash` is a content hash of `src/` exactly as it sits on disk:
 * sorted relative paths, each with the SHA-1 of its bytes. It is the number that actually
 * decides what a frame looks like, it needs no git at all, and it differs the instant a file
 * is edited whether or not anyone has committed. `commit` and `srcTree` are still recorded
 * beside it — the commit is how a human finds the tree, and `srcTree` is how a record here can
 * be cross-referenced against a `shoot.mjs` deck — and `dirty` names every file that makes the
 * two disagree, so a reader is never left to guess which one is the truth.
 */
export function provenance(root) {
  const git = (...a) => {
    try { return execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim(); }
    catch { return null; }
  };
  const srcDir = path.join(root, 'src');
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(p);
    }
  };
  walk(srcDir);
  const h = createHash('sha1');
  let bytes = 0;
  for (const f of files) {
    const buf = readFileSync(f);
    bytes += buf.length;
    h.update(path.relative(root, f).split(path.sep).join('/'));
    h.update('\0');
    h.update(createHash('sha1').update(buf).digest('hex'));
    h.update('\n');
  }
  const status = git('status', '--porcelain', '--', 'src') ?? '';
  const dirty = status.split('\n').map((l) => l.trim()).filter(Boolean);
  return {
    commit: git('rev-parse', '--short', 'HEAD') ?? 'unknown',
    branch: git('rev-parse', '--abbrev-ref', 'HEAD') ?? 'unknown',
    srcTree: git('rev-parse', 'HEAD:src') ?? 'unknown',
    /** The hash that actually decides the pixels. See the note above. */
    srcHash: h.digest('hex'),
    srcFiles: files.length,
    srcBytes: bytes,
    dirty,
    clean: dirty.length === 0,
  };
}

export { ShotError };
