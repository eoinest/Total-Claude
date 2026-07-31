import * as THREE from 'three';
import { Mat, matUv } from './atlas';
import { MeshBuilder } from './meshBuilder';

/**
 * The scorpio — a Roman torsion bolt-thrower — built procedurally, one geometry, articulated
 * in the vertex shader.
 *
 * ## What it is
 * A scorpio is not a big crossbow. Its power comes from two vertical bundles of twisted sinew
 * held in a rectangular frame (the *capitulum*): each bundle has a rigid arm driven through
 * it, and winching the string back against the bundles' torsion is what stores the energy.
 * Vitruvius (X.10) gives every dimension of the machine as a multiple of the spring-hole
 * diameter, which for a three-span engine shooting a 0.58 m bolt is about 65 mm. The numbers
 * below are that scheme rounded to something a mesh builder can read, checked against the
 * Ampurias and Cremona frame fittings and Alan Wilkins' working reconstructions.
 *
 * ## Why it is one mesh with a shader rig rather than a bone rig
 * Every moving part of this machine moves along one axis: the arms rotate about their spring
 * centres, the slider translates along the case, the winch drum spins, and the string and the
 * winch rope are straight lines between two points that the first two determine. That is four
 * scalars, so the whole articulation is a handful of instructions on a `partId` attribute —
 * no animation texture, no clip set, no per-frame CPU pose. At most a couple of dozen engines
 * are ever on the field, so it is also one draw call with no LOD chain: LOD exists to stop
 * thousands of a thing costing thousands of times its triangle count, and there are not
 * thousands of these.
 *
 * ## The mechanism, and why the string is a shallow V at rest
 * The arm tips sweep an arc about their springs, from `ARM_REST` (forward of the frame plane,
 * where the springs drive them and the buffers stop them) to `ARM_DRAWN` (swept back). The
 * string is a fixed length, so the claw's position on the centreline is forced:
 *
 *     clawZ = tipZ − sqrt( STRING_HALF² − tipX² )
 *
 * Because the tips are furthest *apart* when the arms are square to the stock — halfway
 * through the sweep — the string cannot be dead straight at rest without going impossibly
 * taut in the middle of the draw. So it is a shallow arrowhead pointing back over the stock
 * with the arms forward, which is exactly what a released ballista looks like, and it opens
 * into a deep V as the winch pulls the claw back. Getting this wrong is the difference
 * between a machine and a prop: a string drawn as a straight line across two arm tips reads
 * as a decoration nailed to the frame.
 *
 * ## Frame
 * Local space: origin on the ground under the pivot column, +Z downrange, +Y up. The unit's
 * `facing` yaws it, so +Z here becomes the direction the crew are shooting.
 */

/** Part ids, matched by name in `engineMaterial.ts`'s vertex shader. */
export const enum EnginePart {
  /** Tripod, column and the ground furniture beside it. Does not pitch and does not recoil. */
  Ground = 0,
  /** Case, frame, springs, washers — everything rigid on the pivot. */
  Body = 1,
  /** Bow-arms, rotating about their own spring centres. */
  Arm = 2,
  /** Slider, claw and trigger, translating along the case. */
  Slider = 3,
  /** Bowstring: a straight run between an arm tip and the claw. */
  String = 4,
  /** The loaded bolt, riding the slider. Collapsed to a point when the engine is empty. */
  Bolt = 5,
  /** Windlass drum and its handspikes, spinning about the lateral axis as the slider comes back. */
  Winch = 6,
  /** Winch rope: a straight run between the drum and the slider. */
  Rope = 7,
}

/** Tint slots, matched by index in the fragment shader. */
export const enum EngineTint {
  /** Atlas colour untouched. */
  Atlas = 0,
  /** Structural oak: per-engine weathering. */
  Timber = 1,
  /** Iron fittings and the bolt head. */
  Iron = 2,
  /** Bronze washers and the pivot cup. */
  Bronze = 3,
  /** Sinew spring bundles — pale, greasy, slightly translucent-looking. */
  Sinew = 4,
  /** Hemp rope and leather binding. */
  Cord = 5,
}

// ---------------------------------------------------------------------------
// Dimensions. Every number below is metres and every one of them is load-bearing:
// they are also read by `engineMaterial.ts` (as shader defines) and by
// `engines.ts` (for crew stations and muzzle points), so there is one source.
// ---------------------------------------------------------------------------

/** Lateral offset of a spring bundle's centre from the stock's centreline. */
export const SPRING_X = 0.262;
/** Height of the arms' rotation axis — the middle of the spring bundle. */
export const SPRING_Y = 1.26;
/** Where the frame plane sits along the stock. */
export const SPRING_Z = 0.30;
/**
 * Arm length from spring centre to string nock.
 *
 * 0.62 m, which puts the tips 1.76 m apart across the machine. That is the widest single
 * measurement on a scorpio and it is the one that has to read: at 0.50 m the arms sat inside
 * the frame's own outline from any rear three-quarter camera and the machine looked like a
 * trestle table with a plank on it. Wilkins' working three-span reconstruction is about
 * 1.7 m across the arms, so this is the archaeology as much as it is the silhouette.
 */
export const ARM_R = 0.62;
/** Arms rake up a few degrees so they clear the frame's cross-timbers. */
export const ARM_RAKE = 0.09;
/**
 * Arm sweep, radians from the lateral (+X) axis toward downrange (+Z).
 *
 * Square to the stock at rest, 32 degrees back at full draw. Against a 0.62 m arm that is
 * 0.626 m of claw travel, which is the draw a 0.66 m bolt wants.
 *
 * **The rest angle is not a style choice and it is not 40 degrees forward.** It was, and at
 * that angle the arm tips stand 0.3 m in front of the frame, so the bowstring — a straight
 * run from nock to claw — crosses the frame plane at x = 0.17 and passes through solid oak
 * for the first third of every winch. Sweeping the parameters against the frame's own
 * geometry (a 100-step draw against the uprights, the outer posts and the spring bundles)
 * puts the clash at 0% square, 4% at +0.06, 10% at +0.10 and 22% at +0.20 rad. +0.06 is the
 * knee: it keeps a visible forward set on the released arms and the residual clash is a
 * centimetre of cord inside a spring for two frames of the cycle.
 *
 * It is also the more honest pose. A released ballista's arms are stopped by buffers at very
 * nearly square to the stock, not raked forward like a bow that has just loosed — the springs
 * have nothing left to push against by then.
 */
export const ARM_REST = 0.06;
export const ARM_DRAWN = -0.56;
/**
 * Half the bowstring, tip to claw.
 *
 * Must exceed the widest tip half-separation over the whole sweep, which is at arms-square
 * (SPRING_X + ARM_R*cos(ARM_RAKE) = 0.8795); 0.894 leaves the string just off dead-taut at
 * that point rather than snapping to a NaN under the square root.
 */
export const STRING_HALF = 0.894;
/** Height of the bowstring and the claw hook above the ground. */
export const CLAW_Y = 1.225;
/** Slider length, claw at its rear end. */
export const SLIDER_LEN = 0.78;
/** Windlass drum: centre height, position along the stock, and radius. */
export const DRUM_Y = 1.205;
export const DRUM_Z = -0.94;
export const DRUM_R = 0.075;
/** Height of the pitch pivot — the pintle joining the case to the column. */
export const PIVOT_Y = 1.06;
export const PIVOT_Z = -0.22;
/**
 * Length of the bolt, head to nock.
 *
 * Roman bolt heads and shafts from Dura-Europos and Vindonissa put a light engine's bolt
 * between 0.55 and 0.70 m; 0.66 is chosen at the long end so that at full draw the head sits
 * *inside* the frame's window rather than 0.14 m behind it, where the one thing a viewer looks
 * for down the barrel of a loaded engine is invisible.
 */
export const BOLT_LEN = 0.66;

/** Arm tip position for a sweep angle, in local space. `side` is +1 right, -1 left. */
export function armTip(phi: number, side: number): [number, number, number] {
  const rh = ARM_R * Math.cos(ARM_RAKE);
  return [
    side * (SPRING_X + rh * Math.cos(phi)),
    SPRING_Y + ARM_R * Math.sin(ARM_RAKE),
    SPRING_Z + rh * Math.sin(phi),
  ];
}

/**
 * Where the claw sits for a given arm sweep — forced by the string's fixed length.
 * See the header: this is the whole mechanism in one line.
 */
export function clawZ(phi: number): number {
  const [tx, , tz] = armTip(phi, 1);
  const k = STRING_HALF * STRING_HALF - tx * tx;
  return tz - Math.sqrt(Math.max(0, k));
}

/** Claw travel at the two ends of the sweep, for anyone sizing a bolt against it. */
export const CLAW_REST_Z = clawZ(ARM_REST);
export const CLAW_DRAWN_Z = clawZ(ARM_DRAWN);

/** Where a released bolt leaves the machine, local space — the front of the frame window. */
export const MUZZLE: readonly [number, number, number] = [0, CLAW_Y + 0.018, SPRING_Z + 0.08];

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const UPZ: [number, number, number] = [0, 1, 0];

/** A tapered square post between two points, with an optional taper. */
function post(
  b: MeshBuilder,
  a: readonly [number, number, number],
  c: readonly [number, number, number],
  r0: number,
  r1: number,
  uv: ReturnType<typeof matUv>
): void {
  b.sweep(
    [
      { p: a, rx: r0, rz: r0 },
      { p: c, rx: r1, rz: r1 },
    ],
    UPZ, 4, uv, { capStart: true, capEnd: true, repeatV: 2 }
  );
}

/**
 * A straight run of cord, emitted in the frame the shader expects.
 *
 * String and rope vertices carry only their *cross-section offset* in `position`; the shader
 * puts them on the live line between two moving endpoints using the parameter in `aPart.z`.
 * So this emits a tube about the origin, not about a rest line — there is no rest line, and
 * baking one in would have to be undone.
 */
function cord(
  b: MeshBuilder,
  part: EnginePart,
  span: number,
  radius: number,
  segments: number,
  rings: number,
  uv: ReturnType<typeof matUv>,
  tint: EngineTint = EngineTint.Cord
): void {
  b.setPiece(part, tint);
  const grid: number[][] = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    b.setAux(t, span);
    const row: number[] = [];
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const cx = Math.cos(a);
      const cy = Math.sin(a);
      const [u, v] = MeshBuilder.tileUv(uv, s / segments, t, 1, 3);
      row.push(b.vert(cx * radius, cy * radius, 0, cx, cy, 0, u, v));
    }
    grid.push(row);
  }
  for (let i = 0; i < rings; i++) {
    for (let s = 0; s < segments; s++) {
      const s2 = (s + 1) % segments;
      b.quad(grid[i][s], grid[i][s2], grid[i + 1][s2], grid[i + 1][s]);
    }
  }
  b.setAux(0, 0);
}

export function buildScorpioGeometry(): THREE.InstancedBufferGeometry {
  const b = new MeshBuilder();
  const oak = matUv(Mat.OakBeam);
  const iron = matUv(Mat.IronWorn);
  const plate = matUv(Mat.IronPlate);
  const bronze = matUv(Mat.Bronze);
  const sinew = matUv(Mat.SinewCord);
  const rope = matUv(Mat.Rope);
  const leather = matUv(Mat.LeatherDark);
  const wood = matUv(Mat.WoodPlank);

  // =========================================================================
  // Stand: a three-legged trestle carrying a short column, with the pintle on top.
  // The bolt groove has to end up at a standing man's chest so he can sight along it,
  // which is what fixes the column height at just over a metre.
  // =========================================================================
  b.setPiece(EnginePart.Ground, EngineTint.Timber);
  const hub: [number, number, number] = [0, 0.80, PIVOT_Z];
  post(b, [0, 0.30, PIVOT_Z], [0, PIVOT_Y - 0.02, PIVOT_Z], 0.058, 0.05, oak);
  const feet: [number, number, number][] = [
    [0, 0, PIVOT_Z + 0.72],
    [-0.64, 0, PIVOT_Z - 0.44],
    [0.64, 0, PIVOT_Z - 0.44],
  ];
  for (const f of feet) {
    post(b, hub, f, 0.042, 0.032, oak);
    // Iron shoe, so the leg does not read as a stick pushed into the grass.
    b.setPiece(EnginePart.Ground, EngineTint.Iron);
    b.setMatrix(new THREE.Matrix4().makeTranslation(f[0], 0.035, f[2]));
    b.box(0, 0, 0, 0.075, 0.07, 0.075, iron);
    b.setMatrix(null);
    b.setPiece(EnginePart.Ground, EngineTint.Timber);
  }
  // Lower tie ring: three short braces between the legs at knee height. Without them the
  // legs read as three independent sticks rather than as one trestle.
  for (let i = 0; i < 3; i++) {
    const a = feet[i];
    const c = feet[(i + 1) % 3];
    const mid = (p: readonly [number, number, number]): [number, number, number] =>
      [hub[0] + (p[0] - hub[0]) * 0.62, hub[1] + (p[1] - hub[1]) * 0.62, hub[2] + (p[2] - hub[2]) * 0.62];
    post(b, mid(a), mid(c), 0.025, 0.025, oak);
  }
  // Pintle cup: the bronze socket the case's pin turns in.
  b.setPiece(EnginePart.Ground, EngineTint.Bronze);
  b.setMatrix(new THREE.Matrix4().makeTranslation(0, PIVOT_Y - 0.03, PIVOT_Z));
  b.revolve([[0.001, -0.03], [0.062, -0.03], [0.07, 0.02], [0.055, 0.035], [0.001, 0.035]], 8, bronze);
  b.setMatrix(null);

  // Ammunition: a wicker quiver of spare bolts stood on the ground where the loader can
  // reach it. Nothing says "artillery" faster than a sheaf of shafts leaning by the gun.
  {
    const bx = 0.74;
    const bz = PIVOT_Z - 0.30;
    b.setPiece(EnginePart.Ground, EngineTint.Cord);
    b.setMatrix(new THREE.Matrix4().makeTranslation(bx, 0, bz));
    b.revolve([[0.001, 0], [0.135, 0.01], [0.145, 0.2], [0.15, 0.36], [0.135, 0.37]], 8, rope, 2);
    b.setMatrix(null);
    // Seven shafts, fletching up, splayed the way a handful of them settles in a basket.
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.4;
      const lean = 0.055 + (i % 3) * 0.022;
      const px = bx + Math.cos(a) * 0.06;
      const pz = bz + Math.sin(a) * 0.06;
      b.setPiece(EnginePart.Ground, EngineTint.Timber);
      post(b,
        [px, 0.18, pz],
        [px + Math.cos(a) * lean * 4, 0.78 + (i % 2) * 0.05, pz + Math.sin(a) * lean * 4],
        0.014, 0.012, wood);
    }
  }

  // =========================================================================
  // Case: the bed the slider runs in, and the cheeks that hold it down.
  // =========================================================================
  b.setPiece(EnginePart.Body, EngineTint.Timber);
  const caseZ0 = -1.06;
  const caseZ1 = SPRING_Z + 0.04;
  const caseMid = (caseZ0 + caseZ1) / 2;
  const caseLen = caseZ1 - caseZ0;
  b.setMatrix(new THREE.Matrix4().makeTranslation(0, 1.08, caseMid));
  b.box(0, 0, 0, 0.19, 0.115, caseLen, oak, 2);
  // Two raised cheeks form the dovetail; the slider sits between them. Tall and thin, so the
  // groove reads as a groove: at 0.05 x 0.05 on a 0.24 m bed this was a table top.
  for (const s of [-1, 1]) b.box(s * 0.085, 0.093, 0, 0.038, 0.075, caseLen, oak, 2);
  b.setMatrix(null);
  // Pin block down onto the pintle, and iron straps round the case at each end.
  b.setMatrix(new THREE.Matrix4().makeTranslation(0, PIVOT_Y + 0.01, PIVOT_Z));
  b.box(0, 0, 0, 0.16, 0.06, 0.2, oak);
  b.setMatrix(null);
  b.setPiece(EnginePart.Body, EngineTint.Iron);
  for (const z of [caseZ0 + 0.08, caseZ1 - 0.1]) {
    b.setMatrix(new THREE.Matrix4().makeTranslation(0, 1.08, z));
    b.box(0, 0, 0, 0.202, 0.122, 0.026, iron);
    b.setMatrix(null);
  }

  // =========================================================================
  // Capitulum: the spring frame. Two cross-timbers, four uprights, and the window the
  // bolt flies through between the inner pair.
  // =========================================================================
  b.setPiece(EnginePart.Body, EngineTint.Timber);
  const FRAME_D = 0.115;
  for (const y of [1.075, 1.445]) {
    b.setMatrix(new THREE.Matrix4().makeTranslation(0, y, SPRING_Z));
    b.box(0, 0, 0, 0.885, 0.125, FRAME_D, oak, 2);
    b.setMatrix(null);
  }
  // Four uprights, as Vitruvius' capitulum has them: an outer post closing each side, and an
  // inner pair (the parastatai) flanking the window. The gap between each pair is the slot the
  // arm swings through, and the spring bundle stands in it.
  for (const x of [-0.40, -0.17, 0.17, 0.40]) {
    const w = Math.abs(x) > 0.3 ? 0.082 : 0.05;
    b.setMatrix(new THREE.Matrix4().makeTranslation(x, 1.26, SPRING_Z));
    b.box(0, 0, 0, w, 0.245, FRAME_D, oak, 1);
    b.setMatrix(null);
  }
  // Iron corner plates. Every surviving capitulum fitting — Ampurias, Gornea, Elenovo — is a
  // flat plate pinned across a timber joint, and on the machine they are also the only thing
  // that stops a 0.94 m frame of one timber reading as a single brown slab at forty metres.
  b.setPiece(EnginePart.Body, EngineTint.Iron);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const x = sx * 0.40;
      const y = 1.26 + sy * 0.1225;
      b.setMatrix(new THREE.Matrix4().makeTranslation(x, y, SPRING_Z - FRAME_D * 0.5 - 0.007));
      b.box(0, 0, 0, 0.115, 0.05, 0.014, plate);
      b.setMatrix(null);
      b.setMatrix(new THREE.Matrix4().makeTranslation(x, y, SPRING_Z + FRAME_D * 0.5 + 0.007));
      b.box(0, 0, 0, 0.115, 0.05, 0.014, plate);
      b.setMatrix(null);
    }
  }
  b.setPiece(EnginePart.Body, EngineTint.Timber);

  // Iron ties across the mouth of the window, top and bottom. The Ampurias and Gornea frame
  // fittings are exactly this: flat straps pinned across the timber joints, and they are what
  // stops a torsion frame racking itself apart under a tonne of twist.
  b.setPiece(EnginePart.Body, EngineTint.Iron);
  for (const y of [1.148, 1.372]) {
    b.setMatrix(new THREE.Matrix4().makeTranslation(0, y, SPRING_Z - FRAME_D * 0.5 - 0.008));
    b.box(0, 0, 0, 0.34, 0.026, 0.016, iron);
    b.setMatrix(null);
  }
  b.setPiece(EnginePart.Body, EngineTint.Timber);
  // Springs: a tight vertical bundle of sinew through each hole, and the bronze washers
  // top and bottom that the tensioning bar levers against.
  for (const s of [-1, 1]) {
    b.setPiece(EnginePart.Body, EngineTint.Sinew);
    b.tube(
      [
        { y: 1.12, rx: 0.058, rz: 0.058, x: s * SPRING_X, z: SPRING_Z },
        { y: 1.26, rx: 0.064, rz: 0.064, x: s * SPRING_X, z: SPRING_Z },
        { y: 1.40, rx: 0.058, rz: 0.058, x: s * SPRING_X, z: SPRING_Z },
      ],
      8, sinew, { repeatV: 3, repeatU: 2 }
    );
    // Modioli: the bronze washers the bundle is tensioned through. They stand *proud* of the
    // cross-timbers with the twisted head of the sinew showing above, which is the single most
    // distinctive thing about a torsion frame seen from any angle — the Mora de Rubiols and
    // Auerberg reconstructions both put two capstans up on top of the capitulum where nothing
    // else on a wooden machine is. Sunk flush inside the frame, as they were, they were
    // invisible and the engine could have been sprung by anything.
    b.setPiece(EnginePart.Body, EngineTint.Bronze);
    for (const [y, dir] of [[1.055, -1], [1.465, 1]] as const) {
      b.setMatrix(new THREE.Matrix4().makeTranslation(s * SPRING_X, y, SPRING_Z));
      b.revolve(
        [[0.001, dir * -0.02], [0.088, dir * -0.02], [0.092, dir * 0.028],
          [0.078, dir * 0.062], [0.001, dir * 0.062]],
        8, bronze
      );
      b.setMatrix(null);
      // The head of the bundle, twisted through the washer and standing above it.
      b.setPiece(EnginePart.Body, EngineTint.Sinew);
      b.setMatrix(new THREE.Matrix4().makeTranslation(s * SPRING_X, y + dir * 0.062, SPRING_Z));
      b.revolve([[0.062, 0], [0.058, dir * 0.05], [0.04, dir * 0.075], [0.001, dir * 0.082]], 7, sinew, 2);
      b.setMatrix(null);
      b.setPiece(EnginePart.Body, EngineTint.Bronze);
    }
    // Epizygis: the iron bar through the washer that holds the twist. A small thing, but it
    // is the one detail that says "torsion" rather than "bow".
    b.setPiece(EnginePart.Body, EngineTint.Iron);
    b.setMatrix(new THREE.Matrix4().makeTranslation(s * SPRING_X, 1.545, SPRING_Z));
    b.box(0, 0, 0, 0.17, 0.022, 0.024, iron);
    b.setMatrix(null);
  }

  // =========================================================================
  // Arms. Built at ARM_REST; the shader rotates them about their own spring centres.
  // =========================================================================
  for (const s of [-1, 1]) {
    b.setPiece(EnginePart.Arm, EngineTint.Timber);
    b.setAux(0, s);
    const dirX = Math.cos(ARM_REST) * Math.cos(ARM_RAKE);
    const dirZ = Math.sin(ARM_REST) * Math.cos(ARM_RAKE);
    const dirY = Math.sin(ARM_RAKE);
    const at = (d: number): [number, number, number] => [
      s * (SPRING_X + dirX * d), SPRING_Y + dirY * d, SPRING_Z + dirZ * d,
    ];
    b.sweep(
      [
        { p: at(-0.09), rx: 0.062, rz: 0.052 },
        { p: at(0.10), rx: 0.065, rz: 0.055 },
        { p: at(0.34), rx: 0.048, rz: 0.041 },
        { p: at(ARM_R - 0.06), rx: 0.033, rz: 0.029 },
        { p: at(ARM_R + 0.025), rx: 0.024, rz: 0.024 },
      ],
      UPZ, 5, oak, { capStart: true, capEnd: true, repeatV: 3 }
    );
    // Leather binding at the nock, where the string bears.
    b.setPiece(EnginePart.Arm, EngineTint.Cord);
    b.sweep(
      [
        { p: at(ARM_R - 0.085), rx: 0.033, rz: 0.033 },
        { p: at(ARM_R - 0.015), rx: 0.034, rz: 0.034 },
      ],
      UPZ, 5, leather
    );
    b.setAux(0, 0);
  }

  // =========================================================================
  // Slider, claw and trigger. Built with the claw at the origin of its travel (z = 0),
  // so the shader translates by the live claw position alone.
  // =========================================================================
  b.setPiece(EnginePart.Slider, EngineTint.Timber);
  b.setMatrix(new THREE.Matrix4().makeTranslation(0, CLAW_Y - 0.035, SLIDER_LEN * 0.5 - 0.02));
  b.box(0, 0, 0, 0.15, 0.06, SLIDER_LEN, oak, 3);
  b.setMatrix(null);
  // The groove: two low ribs the bolt lies between.
  for (const s of [-1, 1]) {
    b.setMatrix(new THREE.Matrix4().makeTranslation(s * 0.052, CLAW_Y + 0.006, SLIDER_LEN * 0.5 - 0.02));
    b.box(0, 0, 0, 0.045, 0.026, SLIDER_LEN - 0.06, oak, 3);
    b.setMatrix(null);
  }
  // Claw box and trigger lever at the rear.
  b.setPiece(EnginePart.Slider, EngineTint.Iron);
  b.setMatrix(new THREE.Matrix4().makeTranslation(0, CLAW_Y + 0.012, -0.035));
  b.box(0, 0, 0, 0.105, 0.085, 0.13, plate);
  // Two hooks either side of the groove, which is what actually grips the string.
  for (const s of [-1, 1]) b.box(s * 0.045, 0.045, 0.055, 0.03, 0.05, 0.05, plate);
  b.setMatrix(null);
  b.setPiece(EnginePart.Slider, EngineTint.Iron);
  b.setMatrix(
    new THREE.Matrix4().makeRotationX(-0.5)
      .premultiply(new THREE.Matrix4().makeTranslation(0, CLAW_Y - 0.09, -0.1))
  );
  b.box(0, 0, 0, 0.024, 0.18, 0.024, iron);
  b.setMatrix(null);

  // =========================================================================
  // Bowstring: two straight runs from the arm nocks to the claw, plus the serving where
  // the claw grips. Vertices carry only their cross-section offset — see `cord`.
  // =========================================================================
  // 17 mm radius, so 34 mm of cord. A ballista string is a laid rope of sinew or horsehair
  // and the finds put it in that band, which is fortunate: at the 9.5 mm this started at it
  // was under two pixels at any camera that also framed the crew, so the single element that
  // says "this thing is under tension" was simply not in the image. Sinew-tinted rather than
  // hemp, because it needs to read pale against the frame's oak.
  cord(b, EnginePart.String, -1, 0.017, 5, 1, sinew, EngineTint.Sinew);
  cord(b, EnginePart.String, 1, 0.017, 5, 1, sinew, EngineTint.Sinew);

  // =========================================================================
  // Bolt. Rides the slider, so it is built in the same claw-relative frame.
  // =========================================================================
  b.setPiece(EnginePart.Bolt, EngineTint.Timber);
  b.tube(
    [
      { y: 0.02, rx: 0.0145, rz: 0.0145 },
      { y: BOLT_LEN - 0.1, rx: 0.0155, rz: 0.0155 },
      { y: BOLT_LEN - 0.06, rx: 0.017, rz: 0.017 },
    ],
    5, wood, { capStart: true, repeatV: 3 }
  );
  b.setPiece(EnginePart.Bolt, EngineTint.Iron);
  // Pyramidal head, socketed onto the shaft.
  b.tube(
    [
      { y: BOLT_LEN - 0.09, rx: 0.019, rz: 0.019 },
      { y: BOLT_LEN - 0.045, rx: 0.021, rz: 0.021 },
      { y: BOLT_LEN, rx: 0.001, rz: 0.001 },
    ],
    4, plate, { capStart: true }
  );
  // Three flights. Roman bolts were fletched with wood or leather vanes, not feathers.
  b.setPiece(EnginePart.Bolt, EngineTint.Cord);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    const v: number[] = [];
    const pts: [number, number, number][] = [
      [0, 0.03, 0], [0.036, 0.045, 0], [0.036, 0.115, 0], [0, 0.125, 0],
    ];
    for (const f of [1, -1]) {
      const row = pts.map(([r, y]) =>
        b.vert(cx * r, y, cz * r, -cz * f, 0, cx * f, ...MeshBuilder.tileUv(leather, r * 12, y * 6)));
      v.push(...row);
    }
    b.quad(v[0], v[1], v[2], v[3]);
    b.quad(v[4], v[7], v[6], v[5]);
  }

  // =========================================================================
  // Windlass: the drum and two handspikes, spinning about the lateral axis.
  // =========================================================================
  b.setPiece(EnginePart.Winch, EngineTint.Timber);
  b.setMatrix(
    new THREE.Matrix4().makeRotationZ(Math.PI / 2)
      .premultiply(new THREE.Matrix4().makeTranslation(0, DRUM_Y, DRUM_Z))
  );
  b.revolve(
    [[0.001, -0.17], [0.09, -0.17], [0.09, -0.13], [DRUM_R, -0.12],
      [DRUM_R, 0.12], [0.09, 0.13], [0.09, 0.17], [0.001, 0.17]],
    8, oak
  );
  b.setMatrix(null);
  // Handspikes: four bars through the drum at right angles, the crew's purchase on it.
  b.setPiece(EnginePart.Winch, EngineTint.Timber);
  for (let i = 0; i < 2; i++) {
    const a = (i / 2) * Math.PI;
    const dy = Math.cos(a);
    const dz = Math.sin(a);
    for (const s of [-1, 1]) {
      b.sweep(
        [
          { p: [0, DRUM_Y, DRUM_Z], rx: 0.021, rz: 0.021 },
          { p: [0, DRUM_Y + dy * s * 0.24, DRUM_Z + dz * s * 0.24], rx: 0.018, rz: 0.018 },
        ],
        [1, 0, 0], 4, oak, { capEnd: true }
      );
    }
  }
  // Pawl and ratchet, so the drum is visibly held between pulls.
  b.setPiece(EnginePart.Body, EngineTint.Iron);
  b.setMatrix(new THREE.Matrix4().makeTranslation(0.135, DRUM_Y + 0.07, DRUM_Z));
  b.box(0, 0, 0, 0.022, 0.03, 0.16, iron);
  b.setMatrix(null);

  // Elevation lever. A long ash pole raked up and back off the rear of the stock, and on the
  // museum machines the tallest single element on them — the gunner lays the engine on it and
  // it is most of what gives a scorpio a silhouette rather than an outline.
  b.setPiece(EnginePart.Body, EngineTint.Timber);
  b.sweep(
    [
      { p: [0, 1.06, caseZ0 + 0.10], rx: 0.032, rz: 0.032 },
      { p: [0, 1.34, caseZ0 - 0.14], rx: 0.028, rz: 0.028 },
      { p: [0, 1.78, caseZ0 - 0.52], rx: 0.021, rz: 0.021 },
    ],
    [0, 0, 1], 5, oak, { capStart: true, capEnd: true, repeatV: 3 }
  );

  // Winch rope, drum to slider.
  cord(b, EnginePart.Rope, 2, 0.013, 4, 1, rope);

  const g = b.toGeometry('scorpio');
  // `MeshBuilder` names its per-vertex channel `aPieceTint` because it was written for the
  // soldier skinner. The engine shader wants the same four floats under its own name —
  // (part, tint slot, cord parameter, cord span / arm side) — and has no use at all for the
  // skin weights, which are four floats a vertex of nothing.
  const pt = g.getAttribute('aPieceTint');
  g.setAttribute('aPart', pt);
  g.deleteAttribute('aPieceTint');
  g.deleteAttribute('aSkin');
  // Culling is per instance on the CPU; make the sphere generous enough to cover the arms
  // at any sweep and the slider at either end of its travel.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.7);
  return g;
}
