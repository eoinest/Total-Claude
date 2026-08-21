import * as THREE from 'three';
import { clamp, lerp } from '../../util/math';
import { Rng, hash2 } from '../../util/rand';
import {
  archPanel,
  box,
  column,
  crenellation,
  cylinder,
  hipRoof,
  quadPrism,
  statue,
  type Batch,
  type GeoStream,
} from '../build';
import type { CityMatKey } from '../materials';
import { PAL } from '../palette';
import { cylinderBetween, strut } from '../wall';
import {
  frameOf,
  OUT,
  P0,
  P1,
  P2,
  P3,
  WALL,
  type Bay,
  type Frame,
} from './section';
import { GATE_X as GATE_X_SOLVED } from './survey';

/**
 * The Porta Flaminia — `docs/ROME.md` §5, the gates and the one number an aperture is
 * allowed to have.
 *
 * Split out of `wall.ts` by §15 task 0. Rome has one buildable aperture today; §5.1 books
 * three gates and two *posterulae*, and §5.2's aperture rule is the thing that has to be
 * applied here rather than in three places at once. Everything the gatehouse decides now
 * lives in one file: the block's span, the clear carriageway, the doors, the vault, the
 * approach — and `curtainSpans`, which is how the curtain is cut to receive the block
 * rather than a whole bay being replaced by it.
 *
 * Imports `./section` and never `./circuit`, so the wall modules form a tree.
 */

/** The Porta Flaminia, where the Via Flaminia crosses the crest. Solved in `survey.ts`. */
export const GATE_X = GATE_X_SOLVED;
/** Clear width of the Porta Flaminia carriageway. */
export const GATE_OPEN_WIDTH = 4.3;

// ---------------------------------------------------------------------------
// The gatehouse block, as a span the curtain has to make room for
// ---------------------------------------------------------------------------

/**
 * Along-run width of the Porta Flaminia's masonry block. `buildGate` builds to this.
 *
 * The block is centred on `GATE_X` — where the Via Flaminia crosses the crest, solved
 * from the Lanciani georeference — and `GATE_X` is not a bay boundary and need not even
 * lie in the bay the gate is booked to. So the curtain is *cut* to receive the block
 * rather than one whole bay being replaced by it.
 *
 * Replacing a whole bay is what this fixes. The gate is at x = 72, which falls in bay 19,
 * while `gateBay` rounds to 20 — so `buildGate` ran instead of `buildCurtainBay` for the
 * 35.5 m of bay 20, covered 5.5 m of it with the east end of the block, and left 28.4 m
 * of open grass immediately east of the Porta Flaminia. Meanwhile bay 19's curtain was
 * built straight through the middle of the gate passage, so the one way into Rome was
 * bricked up 3.75 m behind the doors.
 */
export const GATE_BLOCK_W = 25;
/** Front-to-back depth of the block, so the passage is a real tunnel. */
export const GATE_BLOCK_D = 11;
/** Clear height of the carriageway to the springing of the vault. */
export const GATE_PASS_H = 8.4;
/** The attic above the arch, carrying the dedicatory inscription. */
export const GATE_ATTIC = 4.8;
/** Merlon height on the gate block's crown. */
export const GATE_MERLON_H = 2.0;
/**
 * The crown's crenellation, as three numbers the stone and the collision model share.
 *
 * `buildGate` used to carry these as literals in its `crenellation()` call and
 * `GateBlockOut` published none of them, so `masonryTopAt` had nothing to alternate with and
 * reported the block solid. Named here because two callers now need the same answer.
 */
export const GATE_CREN_INSET = 0.5;
export const GATE_CREN_T = 0.9;
export const GATE_MERLON_W = 1.5;
export const GATE_CRENEL_W = 0.8;
/** Height of the brick face's springing above the road, where the barrel vault starts. */
export const GATE_SPRING = 1.15 + 4.3;
/**
 * How far the door plane stands behind the outer face of the block.
 *
 * The *cataracta* drops in its slot 0.85 m inside the face; the leaves hang 1.35 m behind
 * it, which is the arrangement at the Porta Appia and gives the portcullis somewhere to
 * fall that is not on top of the doors. Keeping them near the front also matters to the
 * siege system: a ram parks against the gatehouse and has to be able to reach what it is
 * breaking, not drive seven metres up a tunnel first.
 */
export const GATE_DOOR_SET = 2.2;
/** Top of the threshold slab, which the leaves close down onto. */
export const GATE_DOOR_SILL = 0.12;
/** Leaves run from the threshold to the springing; the lunette above is filled in brick. */
export const GATE_DOOR_H = GATE_SPRING - GATE_DOOR_SILL;
/** Twin oak leaves, iron-bound. Thick enough to need 26 blows of a ram. */
export const GATE_DOOR_T = 0.22;
/**
 * Half-width of the span the curtain is cut out of, 0.3 m inside the block's own face so
 * the curtain dies *inside* the brick and no seam can open between the two.
 */
export const GATE_CLIP_HALF = GATE_BLOCK_W * 0.5 - 0.3;

/** True where the gatehouse block stands, so nothing else may be built there. */
export function inGateBlock(x: number): boolean {
  return Math.abs(x - GATE_X) <= GATE_CLIP_HALF;
}

/**
 * The parts of a run from `x0` to `x1` that the gatehouse does not stand in: the whole
 * run, one piece of it, or the two flanks either side of the block.
 */
export function curtainSpans(x0: number, x1: number, out: [number, number][]): [number, number][] {
  out.length = 0;
  const a = GATE_X - GATE_CLIP_HALF;
  const b = GATE_X + GATE_CLIP_HALF;
  if (b <= x0 || a >= x1) {
    out.push([x0, x1]);
    return out;
  }
  if (x0 < a) out.push([x0, Math.min(a, x1)]);
  if (x1 > b) out.push([Math.max(b, x0), x1]);
  return out;
}

// ---------------------------------------------------------------------------
// Gate — the Porta Flaminia, on the axis of the Via Flaminia
// ---------------------------------------------------------------------------

/** Every stream `buildGate` touches. See `Batch.distinct`. */
const GATE_KEYS: readonly CityMatKey[] = ['brick', 'stone', 'metal', 'timber', 'roof', 'road'];

export function buildGate(batch: Batch, detail: number, bay: Bay, heightAt: (x: number, z: number) => number, rng: Rng): void {
  const brick = batch.s('brick');
  const stone = batch.s('stone');
  const metal = batch.s('metal');
  const timber = batch.s('timber');
  const roof = batch.s('roof');
  const road = batch.s('road');

  const f = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  const cx = GATE_X;
  const cz = lerp(bay.z0, bay.z1, (GATE_X - bay.x0) / WALL.towerSpacing);
  const g = heightAt(cx, cz);

  // The approach: built in world space before the gate's own frame is pushed, so the
  // carriageway can follow the ground. Everything the camera sees in the foreground of
  // the standard `city` viewpoint lives here, and without it that frame is half grass.
  buildGateApproach(batch, detail, cx, cz, f, heightAt, rng);

  const m = new THREE.Matrix4().makeRotationY(f.rotY).setPosition(cx, 0, cz);
  // See `Batch.distinct`: at mid detail these six keys are three streams and at far detail
  // one, so pushing per key put the whole 25 x 11 m gate block at `m^3` and `m^6`.
  const used = batch.pushAll(GATE_KEYS, m);

  // 11 m of masonry front to back so the passage is a real tunnel, and an attic
  // above the arch for the dedicatory inscription. The curtain is cut back to leave this
  // span clear — see `GATE_BLOCK_W` and `curtainSpans`.
  const blockW = GATE_BLOCK_W;
  const blockD = GATE_BLOCK_D;
  const passH = GATE_PASS_H;
  const attic = GATE_ATTIC;
  const blockTop = g + passH + attic;
  const zF = -blockD * 0.5;

  // Travertine socle, in two piers with the carriageway between them.
  //
  // It used to be one box across the whole 25 m, which put 1.15 m of solid stone across
  // the passage: the brick face starts at `g + 1.15` and the socle filled everything
  // below it, so the one road into Rome had a chest-high step in it, 3.4 m behind the
  // doors where no camera could see it. A ray down the centreline at 0.5 m struck it.
  const socleHalf = blockW / 2 + 0.45;
  const openHalf = GATE_OPEN_WIDTH * 0.5;
  for (const s of [-1, 1]) {
    box(stone, s > 0 ? openHalf : -socleHalf, g - 2.4, zF - 0.45, s > 0 ? socleHalf : -openHalf, g + 1.15, blockD * 0.5 + 0.45, PAL.travertineDirty, {
      topGain: 1.08,
    });
  }
  // A threshold slab in the opening: a real gate has one, worn into ruts, and it caps the
  // ground under the tunnel so the terrain cannot show through the basalt.
  box(stone, -openHalf, g - 2.4, zF - 0.45, openHalf, g + 0.12, blockD * 0.5 + 0.45, PAL.travertineDirty, {
    topGain: 1.14,
  });

  brick.pushTranslate(0, g + 1.15, zF);
  archPanel(brick, blockW, passH + attic - 1.15, PAL.brick, {
    depth: blockD,
    spring: 4.3,
    openWidth: GATE_OPEN_WIDTH,
    segments: detail >= 2 ? 16 : 8,
    backFace: true,
    archivolt: detail >= 1 ? 0.4 : 0,
    voidCol: new THREE.Color(0.028, 0.026, 0.022),
  });
  brick.pop();

  /**
   * End walls closing the block.
   *
   * `archPanel` builds a front face, a back face and the reveals between them — it has no
   * end caps, so the 25 x 11 m gate block was a shell open along both of its 11 m ends.
   * The curtain only covers 3.5 m of that, which left roughly 4 m of full-height daylight
   * either side of it: from an oblique camera east or west of the gate you looked straight
   * in one end of the gatehouse and out of the other. The cornice caps the top and the
   * socle the bottom, so only the storey between them needs closing.
   */
  for (const s of [-1, 1]) {
    const ex = (s * blockW) / 2;
    box(brick, Math.min(ex, ex - s * 0.09), g + 1.15, zF, Math.max(ex, ex - s * 0.09), blockTop, blockD * 0.5, PAL.brick, {
      groundShade: 0.18,
      topGain: 1.04,
    });
  }

  // Travertine voussoirs framing the arch. The gate was dressed in stone even where
  // the curtain is bare brick, because it is the face the city shows the world.
  if (detail >= 1) {
    const r = GATE_OPEN_WIDTH * 0.5;
    const spring = g + 1.15 + 4.3;
    const nV = 13;
    const midR = r + 0.32;
    for (let i = 0; i < nV; i++) {
      const a0 = Math.PI - (Math.PI * i) / nV;
      const a1 = Math.PI - (Math.PI * (i + 1)) / nV;
      const am = (a0 + a1) * 0.5;
      const halfArc = ((Math.PI / nV) * midR) / 2;
      const tx = -Math.sin(am);
      const ty = Math.cos(am);
      const vx = Math.cos(am) * midR;
      const vy = spring + Math.sin(am) * midR;
      const c = new THREE.Color().copy(PAL.travertine).multiplyScalar(0.92 + hash2(i, 3, 11) * 0.17);
      P0.set(vx - tx * halfArc, vy - ty * halfArc, zF - 0.5);
      P1.set(vx + tx * halfArc, vy + ty * halfArc, zF - 0.5);
      P2.set(P1.x + Math.cos(am) * 0.66, P1.y + Math.sin(am) * 0.66, zF - 0.5);
      P3.set(P0.x + Math.cos(am) * 0.66, P0.y + Math.sin(am) * 0.66, zF - 0.5);
      OUT.set(0, 0, -1);
      stone.quadN(OUT, P0, P1, P2, P3, c);
      OUT.set(Math.cos(am), Math.sin(am), 0);
      P0.set(P3.x, P3.y, zF - 0.5);
      P1.set(P2.x, P2.y, zF - 0.5);
      P2.set(P1.x, P1.y, zF);
      P3.set(P0.x, P0.y, zF);
      stone.quadN(OUT, P0, P1, P2, P3, new THREE.Color().copy(c).multiplyScalar(0.78));
    }
  }

  // ---- inscribed attic ----------------------------------------------------
  const insY = g + passH + 1.0;
  box(stone, -7.6, insY, zF - 0.58, 7.6, insY + 2.8, zF, PAL.marble, { topGain: 1.1 });
  box(stone, -8.1, insY - 0.38, zF - 0.76, 8.1, insY, zF, PAL.travertine, { topGain: 1.2 });
  box(stone, -8.1, insY + 2.8, zF - 0.76, 8.1, insY + 3.2, zF, PAL.travertine, { topGain: 1.2 });
  if (detail >= 1) {
    // The inscription: gilt-bronze letters set into cut beds. Modelled as rows of
    // small raised blocks — legible as lettering at 60 m, which is all that matters.
    for (let line = 0; line < 3; line++) {
      const y = insY + 2.05 - line * 0.78;
      let px = -6.6 - hash2(line, 1, 5) * 0.35;
      while (px < 6.3) {
        const w = 0.22 + hash2(Math.round(px * 10), line, 9) * 0.2;
        box(metal, px, y, zF - 0.65, px + w, y + 0.46, zF - 0.58, PAL.gilt, { zMax: false });
        px += w + 0.15 + hash2(Math.round(px * 7), line + 3, 13) * 0.12;
      }
    }
  }

  // ---- crowning cornice and battlements -----------------------------------
  box(stone, -blockW / 2 - 0.65, blockTop - 0.55, zF - 0.65, blockW / 2 + 0.65, blockTop, blockD * 0.5 + 0.65, PAL.travertine, {
    topGain: 1.18,
  });
  crenellation(
    brick, -blockW / 2, zF + GATE_CREN_INSET, blockW / 2, zF + GATE_CREN_INSET,
    blockTop, GATE_MERLON_H, GATE_CREN_T, PAL.brick, GATE_MERLON_W, GATE_CRENEL_W, detail >= 1,
  );

  // ---- flanking semicircular towers ---------------------------------------
  // Aurelian's major gates were flanked by semicircular towers rising well above the
  // curtain; the Porta Flaminia's survive inside the later Porta del Popolo.
  // Slender enough to read as towers rather than chimneys: 9.2 m across, 18.6 tall.
  const towerR = 4.6;
  const towerX = GATE_OPEN_WIDTH * 0.5 + towerR + 1.9;
  const towerTop = g + 18.6;
  const seg = detail >= 2 ? 16 : detail === 1 ? 10 : 6;
  for (const s of [-1, 1]) {
    const tx = s * towerX;
    const tz = zF + 0.5;
    cylinder(stone, tx, g - 2.0, tz, towerR + 0.78, towerR + 0.52, 3.3, seg, PAL.travertineDirty, { arcFrom: Math.PI, arcTo: Math.PI * 2 });
    cylinder(brick, tx, g + 1.3, tz, towerR + 0.52, towerR * 0.94, towerTop - g - 1.3, seg, PAL.brick, {
      arcFrom: Math.PI,
      arcTo: Math.PI * 2,
      shadeLow: 0.26,
    });
    // Flat chord closing the back of the semicircle, buried in the gate block.
    box(brick, tx - towerR - 0.6, g - 2.0, tz - 0.12, tx + towerR + 0.6, towerTop, tz, PAL.brick, { zMin: false });
    // The drum tapers, so a string course has to be sized from the radius at its own
    // height or it disappears inside the brickwork.
    const drumR = (y: number): number => {
      const t = clamp((y - (g + 1.3)) / (towerTop - g - 1.3), 0, 1);
      return towerR + 0.52 + (towerR * 0.94 - towerR - 0.52) * t;
    };
    if (detail >= 1) {
      const nb = Math.round((towerTop - g - 1.3) / WALL.courseBand);
      for (let k = 1; k < nb; k++) {
        const y = g + 1.3 + ((towerTop - g - 1.3) * k) / nb;
        const rr = drumR(y) + 0.16;
        // `bottom` as well as `top`: these project 0.16 m past the drum and an open
        // underside is the same daylight sliver the cornice had, thirty times over.
        cylinder(brick, tx, y - 0.14, tz, rr, rr, 0.14, seg, PAL.tileCourse, {
          arcFrom: Math.PI,
          arcTo: Math.PI * 2,
          top: true,
          bottom: true,
        });
      }
      // Arched windows lighting the tower chambers. Set 0.3 m proud of the drum so the
      // curvature cannot swallow a flat panel, which reads as a stone surround.
      for (let lv = 0; lv < 2; lv++) {
        const wy = g + 6.6 + lv * 5.1;
        brick.pushTranslate(tx, wy, tz - drumR(wy) - 0.3);
        archPanel(brick, 2.5, 3.9, PAL.brick, {
          depth: 1.2,
          spring: 1.6,
          openWidth: 1.2,
          segments: detail >= 2 ? 8 : 5,
          archivolt: detail >= 2 ? 0.14 : 0,
          voidCol: new THREE.Color(0.018, 0.016, 0.013),
        });
        brick.pop();
      }
    }
    /**
     * Crowning cornice, splayed out of the drum rather than perched on it.
     *
     * The ring alone was 1.08 R over a drum that tapers to 0.94 R, and `cylinder` emits no
     * bottom face unless asked: 0.65 m of open annulus with the sky behind it, all the way
     * round. From any low camera outside the gate it read as a crack straight through the
     * tower, right under the battlement. The cavetto closes the soffit.
     */
    cylinder(stone, tx, towerTop - 0.28, tz, towerR * 0.94, towerR * 1.08, 0.28, seg, PAL.travertine, {
      arcFrom: Math.PI,
      arcTo: Math.PI * 2,
    });
    cylinder(stone, tx, towerTop, tz, towerR * 1.08, towerR * 1.08, 0.6, seg, PAL.travertine, {
      arcFrom: Math.PI,
      arcTo: Math.PI * 2,
      top: true,
    });
    const nm = detail >= 1 ? 9 : 5;
    for (let k = 0; k < nm; k++) {
      const a = Math.PI + (Math.PI * (k + 0.5)) / nm;
      const ax = tx + Math.cos(a) * towerR;
      const az = tz + Math.sin(a) * towerR;
      const tg = a + Math.PI * 0.5;
      quadPrism(
        brick,
        ax - Math.cos(tg) * 0.72,
        az - Math.sin(tg) * 0.72,
        ax + Math.cos(tg) * 0.72,
        az + Math.sin(tg) * 0.72,
        Math.cos(a),
        Math.sin(a),
        0.85,
        towerTop + 0.6,
        towerTop + 2.2,
        PAL.brick,
        PAL.travertine
      );
    }
  }

  // ---- portcullis, doors, carriageway -------------------------------------
  /**
   * The *cataracta*, hanging raised in its slot 0.85 m inside the outer face.
   *
   * Left raised on purpose now that the leaves below are shut. It is the second line, not
   * the first: you drop it when the doors fail, and dropping it now would put a curtain of
   * iron bars in front of the thing the player asked to see shut. It also gives the siege
   * system somewhere to go after the ram wins — the geometry is already here.
   */
  const barTop = g + passH - 0.15;
  const barBottom = g + passH - 3.1;
  for (let i = 0; i <= 12; i++) {
    const bx = -GATE_OPEN_WIDTH * 0.5 + (GATE_OPEN_WIDTH * i) / 12;
    box(metal, bx - 0.05, barBottom, zF + 0.85, bx + 0.05, barTop, zF + 0.98, PAL.iron);
  }
  for (let k = 0; k < 3; k++) {
    const y = barBottom + k * 1.35;
    box(metal, -GATE_OPEN_WIDTH * 0.5, y, zF + 0.83, GATE_OPEN_WIDTH * 0.5, y + 0.12, zF + 1.0, PAL.iron);
  }
  box(metal, -GATE_OPEN_WIDTH * 0.5, barBottom - 0.38, zF + 0.82, GATE_OPEN_WIDTH * 0.5, barBottom, zF + 1.01, PAL.iron);

  const doorZ = zF + GATE_DOOR_SET;
  const leafHalf = GATE_OPEN_WIDTH * 0.5;
  const headY = g + GATE_SPRING;

  /**
   * The lunette over the doors, filled in brick.
   *
   * The leaves are rectangular and stop at the springing, so without this there is a 4.3 m
   * semicircular hole above them and the gate is shut only as far as a man's head. Emitted
   * as vertical columns whose tops are taken from the arc at each column's **inner** edge,
   * so every column rises to or above the intrados and the fill can never leave a gap
   * against it; the surplus is buried in the arch's own masonry.
   */
  {
    const cols = detail >= 2 ? 14 : detail === 1 ? 8 : 4;
    const r = leafHalf;
    for (let j = 0; j < cols; j++) {
      const a = -r + (2 * r * j) / cols;
      const b = -r + (2 * r * (j + 1)) / cols;
      const inner = Math.min(Math.abs(a), Math.abs(b));
      const h = Math.sqrt(Math.max(0, r * r - inner * inner));
      box(brick, a, headY - 0.05, doorZ - 0.26, b, headY + h, doorZ + 0.26, new THREE.Color().copy(PAL.brick).multiplyScalar(0.86 + hash2(j, 5, 23) * 0.2));
    }
  }

  // Polygonal basalt carriageway, rutted by two centuries of carts.
  box(road, -GATE_OPEN_WIDTH * 0.5 - 0.6, g + 0.02, zF - 0.5, GATE_OPEN_WIDTH * 0.5 + 0.6, g + 0.1, blockD * 0.5 + 18, PAL.basalt);

  // Guardhouse lean-to inside the gate.
  if (detail >= 1) {
    const gx = 13.5;
    const gz = 10.5;
    const gg = heightAt(cx + gx * Math.cos(f.rotY), cz + gz) - g;
    const guard = batch.pushAllTranslate(GUARD_KEYS, gx, gg, gz);
    box(brick, -4.2, g, -3.1, 4.2, g + 3.3, 3.1, PAL.ochreDeep, { groundShade: 0.2 });
    hipRoof(roof, 9.2, 7.1, g + 3.3, 1.6, 0.45, PAL.roofTileOld);
    batch.popAll(guard);
  }

  batch.popAll(used);
}

/** Guardhouse walls and roof; one stream at far detail. See `Batch.distinct`. */
const GUARD_KEYS: readonly CityMatKey[] = ['brick', 'roof'];

/** The two streams the leaves and their ironwork land in. See `Batch.distinct`. */
const GATE_DOOR_KEYS: readonly CityMatKey[] = ['timber', 'metal'];

/**
 * The twin leaves, **shut and barred** — and in their own chunk, so they can stop being.
 *
 * They used to be swung flat back against the reveals, which is the fourth thing the
 * player reported: "The main gate door is open by default. it should be closed. It should
 * have to be battered down by the battering ram." A gate standing open is not a gate, and
 * an open gate makes the whole siege train decorative — the ram had nothing to break and
 * the assault could walk up the Via Flaminia into the city.
 *
 * Built shut in the door plane rather than as two swung boxes: the leaves meet on the
 * centreline, close down onto the threshold slab and up to the springing of the vault, and
 * the semicircular lunette above them is filled in brick. Nothing can see through.
 *
 * **Why this is not part of `buildGate`.** The *state* lives in `GateDoorOut` and
 * `GateOut.open`, and the published comment has always said the siege system "swings or
 * wrecks these by hiding this geometry and drawing its own" — but the leaves were merged
 * into the gatehouse's own timber and metal streams and there was nothing separable to
 * hide. `setGateOpen` re-cut the raster and the boxes and the doors stayed drawn, so a ram
 * could land twenty-six blows, open the gate and let men through the arch while the player
 * watched two leaves that never moved. They are their own `CityChunkSpec` now, tagged
 * `gateDoorFor`, and `CitySystem.setGateDoorBroken(id)` takes them off the screen.
 *
 * The lunette stays with the gatehouse. It is brick fill above the springing and a ram
 * that breaks the doors has not taken the arch down with them.
 *
 * **`wrecked` builds the same leaves in the pose the ram left them**, into a second chunk
 * tagged `gateWreckFor`. One function and one set of constants for both states, because two
 * would drift: a wreck authored from remembered dimensions is how you get splinters that do
 * not line up with the jambs the doors hung in. See `WRECK` for what the pose is and why
 * hiding the leaves alone is not enough.
 */
export function buildGateLeaves(
  batch: Batch,
  detail: number,
  bay: Bay,
  heightAt: (x: number, z: number) => number,
  wrecked = false
): void {
  const metal = batch.s('metal');
  const timber = batch.s('timber');
  const f = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  const cx = GATE_X;
  const cz = lerp(bay.z0, bay.z1, (GATE_X - bay.x0) / WALL.towerSpacing);
  const g = heightAt(cx, cz);
  const zF = -GATE_BLOCK_D * 0.5;
  const used = batch.pushAll(GATE_DOOR_KEYS, new THREE.Matrix4().makeRotationY(f.rotY).setPosition(cx, 0, cz));

  const doorZ = zF + GATE_DOOR_SET;
  const leafHalf = GATE_OPEN_WIDTH * 0.5;
  const sillY = g + GATE_DOOR_SILL;
  const headY = g + GATE_SPRING;
  const planks = detail >= 2 ? 11 : detail === 1 ? 6 : 1;
  /**
   * The meeting stile: a 45 mm shadow gap on the centreline.
   *
   * Two leaves built hard against each other are one slab. A reviewer shown the shut gate
   * said exactly that — "the plank field runs continuously with no vertical joint anywhere;
   * as rendered this is one slab" — and the centre joint is the single cue that says *twin
   * leaves* at any distance. The gap is a real void down the middle, closed behind by the
   * rebate below so nothing can see through it.
   */
  const MEET = 0.045;
  for (const s of [-1, 1]) {
    /**
     * The wrecked pose, as a transform around the intact leaf.
     *
     * `s = -1` is still on its harr-post: swung `WRECK.swing` into the passage, canted off
     * plumb because the upper pintle has torn out, and with its head beaten away. `s = +1`
     * came off altogether and lies face-up across the carriageway inside the arch. Both are
     * hinged **inward**, which is the only way a ram can drive them; local `+z` is the city
     * side here, the same convention the guardhouse and the carriageway are placed in.
     *
     * A rotation about the hinge, not a hand-placed box: the hinge line is
     * `GateDoorOut.halfWidth` and the sill is `GATE_DOOR_SILL`, so the wreck stands in the
     * same jambs the doors hung in and cannot drift from them. Composed as
     * `T(hinge)·R·T(-hinge)` and pushed onto both streams, so every plank, strap, boss and
     * brace of the intact leaf comes along without being re-authored.
     */
    const hingeX = s * leafHalf;
    let posed: GeoStream[] | null = null;
    if (wrecked) {
      const m = new THREE.Matrix4();
      if (s < 0) {
        m.makeTranslation(hingeX, sillY, doorZ)
          .multiply(new THREE.Matrix4().makeRotationY(s * WRECK.swing))
          .multiply(new THREE.Matrix4().makeRotationX(WRECK.cant))
          .multiply(new THREE.Matrix4().makeTranslation(-hingeX, -sillY, -doorZ));
      } else {
        m.makeTranslation(hingeX * WRECK.slide, g + WRECK.lie, doorZ + WRECK.shove)
          .multiply(new THREE.Matrix4().makeRotationY(WRECK.yaw))
          .multiply(new THREE.Matrix4().makeRotationX(WRECK.flat))
          .multiply(new THREE.Matrix4().makeTranslation(-hingeX, -sillY, -doorZ));
      }
      posed = batch.pushAll(GATE_DOOR_KEYS, m);
    }
    /**
     * How much of each plank column survives, and why the head goes first.
     *
     * A ram strikes the meeting stile, so the loss is greatest on the centreline and tapers
     * to the hanging stile, which is braced against the jamb — which is also what leaves the
     * unmistakable silhouette of a broken gate: a ragged V bitten out of the middle, not a
     * clean rectangle of missing door. `j` counts outward from the centre, so the profile is
     * a straight function of it, hashed a little so no two columns break level.
     */
    const survives = (j: number): number =>
      !wrecked
        ? 1
        : Math.min(1, (s < 0 ? 0.26 : 0.5) + (0.5 * j) / planks + hash2(j, s + 3, 71) * 0.16);
    const topAt = (j: number): number => sillY + (headY - sillY) * survives(j);
    /** The hanging stile: the tallest thing still standing on this leaf. */
    const leafTop = topAt(planks - 1);
    /** Inner edge of the first column still standing at height `y`, for clipping a strap. */
    const standingFrom = (y: number): number => {
      for (let j = 0; j < planks; j++) {
        if (topAt(j) >= y) return s * (MEET + ((leafHalf - MEET) * j) / planks);
      }
      return s * leafHalf;
    };
    /**
     * Vertical oak boarding.
     *
     * Vertical is not a detail. Roman gate leaves — and effectively all pre-modern ones —
     * are vertically planked onto horizontal ledges, because horizontal boards put every
     * plank in bending across the full width of the leaf with nothing to hang them from. The
     * planks are stepped 20 mm proud and shy of each other in turn, which is what puts a
     * vertical shadow line between them: without it the timber material's own horizontal
     * grain wins and the leaf reads as horizontal boarding, which is how the first pass was
     * described.
     */
    for (let j = 0; j < planks; j++) {
      const a = MEET + ((leafHalf - MEET) * j) / planks;
      const b = MEET + ((leafHalf - MEET) * (j + 1)) / planks;
      const jut = planks > 1 ? (j % 2 === 0 ? 0.02 : -0.014) + (hash2(j, s + 1, 17) - 0.5) * 0.01 : 0;
      /**
       * Weathered oak, not the dark timber the rest of the site is built from.
       *
       * The leaves hang 2.2 m inside an 11 m barrel vault with no bounce light in the engine,
       * so at `timberDark` they render as a black rectangle and a reviewer reported the ram's
       * target — the most important object on the map for a siege — as simply invisible. Oak
       * that has stood in the weather on the north face of a city gate for a century is
       * silver-grey, not brown, so the brighter value is also the truer one; it is what lets
       * the boarding and the meeting stile read at all in that shadow.
       */
      const tone = 1.02 + hash2(j, s + 7, 53) * 0.34;
      box(
        timber,
        Math.min(s * a, s * b), sillY, doorZ - GATE_DOOR_T * 0.5 - jut,
        Math.max(s * a, s * b), topAt(j), doorZ + GATE_DOOR_T * 0.5 + jut,
        new THREE.Color().copy(PAL.timber).multiplyScalar(tone)
      );
    }
    // The rebate the leaf shuts against, one plank thickness behind the meeting stile, so
    // the shadow gap is a joint between two doors and not a slot through the gate.
    box(
      timber,
      Math.min(0, s * (MEET + 0.06)), sillY, doorZ + GATE_DOOR_T * 0.5 - 0.02,
      Math.max(0, s * (MEET + 0.06)), topAt(0), doorZ + GATE_DOOR_T * 0.5 + 0.07,
      new THREE.Color().copy(PAL.timber).multiplyScalar(0.62)
    );
    if (detail >= 1) {
      // Iron straps across the boarding, and the pintle band at the hinge stile. A strap
      // whose boarding has gone is clipped back to the first column still under it, so the
      // ironwork ends where the timber does instead of hanging in the gap.
      for (let k = 0; k < 4; k++) {
        const y = sillY + 0.62 + k * 1.24;
        if (y + 0.15 > leafTop) continue;
        const inner = standingFrom(y + 0.15);
        box(metal, Math.min(inner, s * leafHalf), y, doorZ - GATE_DOOR_T * 0.5 - 0.05, Math.max(inner, s * leafHalf), y + 0.15, doorZ + GATE_DOOR_T * 0.5 + 0.05, PAL.iron);
      }
      const hx = s * leafHalf;
      box(metal, Math.min(hx, hx - s * 0.26), sillY, doorZ - GATE_DOOR_T * 0.5 - 0.06, Math.max(hx, hx - s * 0.26), leafTop, doorZ + GATE_DOOR_T * 0.5 + 0.06, PAL.iron);
      /**
       * Pintles, and the harr-post they turn on.
       *
       * A Roman leaf does not hang on hinges in the mediaeval sense: its hanging stile runs
       * down past the sill as a *harr*-post and turns in a socket cut in the threshold, with
       * iron collars strapping it to the jamb. That socket is the detail that reads as "this
       * is a gate that swings" rather than a panel dropped into a hole, and its absence was
       * the first thing named about the closure.
       */
      // Upper pintle first: on a wrecked leaf it is the collar that tore out of the jamb and
      // let the leaf drop, so it is the one piece of ironwork that must *not* still be there.
      for (const hy of wrecked ? [sillY + 0.55] : [sillY + 0.55, headY - 0.75]) {
        box(metal, Math.min(hx, hx + s * 0.3), hy, doorZ - 0.2, Math.max(hx, hx + s * 0.3), hy + 0.26, doorZ + 0.2, PAL.iron);
      }
      // The harr-post itself, and its bronze-lined socket worn into the threshold slab.
      box(timber, Math.min(hx, hx - s * 0.2), sillY - 0.14, doorZ - 0.17, Math.max(hx, hx - s * 0.2), leafTop, doorZ + 0.17, PAL.timberDark);
      box(metal, hx - 0.24, sillY - 0.02, doorZ - 0.24, hx + 0.24, sillY + 0.06, doorZ + 0.24, PAL.bronze);
      // Diagonal ledge-brace on the city face, rising from the hanging stile. Cut short with
      // the boarding it braces: a brace running up through nothing reads as a bug.
      const braceTop = Math.min(headY - 0.8, leafTop - 0.25);
      if (braceTop > sillY + 0.8) {
        const reach = (braceTop - (sillY + 0.5)) / Math.max(1e-3, headY - 0.8 - (sillY + 0.5));
        strut(
          timber,
          P0.set(hx - s * 0.18, sillY + 0.5, doorZ + GATE_DOOR_T * 0.5 + 0.06),
          P1.set(lerp(hx - s * 0.18, s * MEET, reach), braceTop, doorZ + GATE_DOOR_T * 0.5 + 0.06),
          0.075,
          PAL.timber,
          4
        );
      }
    }
    if (detail >= 2) {
      // Bosses: square-headed nails on the strap crossings.
      for (let k = 0; k < 4; k++) {
        for (let j = 0; j < 3; j++) {
          const bx = s * (0.45 + j * 0.72);
          const y = sillY + 0.62 + k * 1.24;
          if (y + 0.21 > topAt(Math.min(planks - 1, Math.floor(((Math.abs(bx) - MEET) * planks) / (leafHalf - MEET))))) continue;
          box(metal, bx - 0.06, y - 0.06, doorZ - GATE_DOOR_T * 0.5 - 0.11, bx + 0.06, y + 0.21, doorZ - GATE_DOOR_T * 0.5 - 0.05, PAL.iron);
        }
      }
    }
    if (posed) batch.popAll(posed);
  }
  /**
   * The drawbar: one oak baulk across both leaves, dropped into sockets cut in the piers.
   * This is what actually holds a gate, and what a ram has to snap — so on the wrecked pose
   * it is snapped, in two pieces on the paving with the iron collars still on them. Nothing
   * else in the frame says "this was barred and the bar gave way".
   */
  if (!wrecked) {
    box(timber, -leafHalf - 0.55, g + 2.35, doorZ + GATE_DOOR_T * 0.5, leafHalf + 0.55, g + 2.68, doorZ + GATE_DOOR_T * 0.5 + 0.3, PAL.timber);
    if (detail >= 1) {
      for (const s of [-1, 1]) {
        box(metal, s * leafHalf * 0.62 - 0.08, g + 2.3, doorZ + GATE_DOOR_T * 0.5 - 0.03, s * leafHalf * 0.62 + 0.08, g + 2.73, doorZ + GATE_DOOR_T * 0.5 + 0.35, PAL.iron);
      }
    }
  } else {
    for (const s of [-1, 1]) {
      const yaw = s * 0.42 + WRECK.yaw * 0.5;
      const bm = new THREE.Matrix4()
        .makeTranslation(s * leafHalf * 0.5, g + 0.28, doorZ + 1.5 + s * 0.9)
        .multiply(new THREE.Matrix4().makeRotationY(yaw))
        .multiply(new THREE.Matrix4().makeRotationZ(s * 0.06));
      const bs = batch.pushAll(GATE_DOOR_KEYS, bm);
      const half = leafHalf * 0.55 + 0.3;
      // Split square across the bar, then torn back along the grain on one side, which is
      // how a baulk in bending actually fails.
      box(timber, -half, -0.165, -0.15, half, 0.165, 0.15, PAL.timber);
      box(timber, half - 0.02, -0.06, -0.11, half + 0.44 + s * 0.2, 0.05, 0.02, PAL.timber);
      if (detail >= 1) {
        box(metal, -0.08, -0.19, -0.19, 0.08, 0.19, 0.19, PAL.iron);
      }
      batch.popAll(bs);
    }
    /**
     * Splinters and plank ends, scattered **through** the arch and not just behind it.
     *
     * The leaves hang 2.2 m inside an 11 m barrel vault, so anything modelled at the door
     * plane is behind a stone reveal and in shadow: from the field the broken gate and the
     * merely open gate photograph as the same dark rectangle. The player watches the ram from
     * outside, so the wreck has to reach outside — the run below straddles the outer face at
     * local z −5.5 and puts timber on the apron of the Via Flaminia, which is also where a
     * ram striking a leaf's outer face throws it.
     */
    for (let k = 0; k < 10; k++) {
      const hx0 = hash2(k, 3, 91);
      const hz0 = hash2(k, 8, 37);
      const ha = hash2(k, 12, 61);
      const px = (hx0 - 0.5) * GATE_OPEN_WIDTH * 1.45;
      const pz = doorZ - 5.2 + hz0 * 11.0;
      const sm = new THREE.Matrix4()
        .makeTranslation(px, g + 0.12, pz)
        .multiply(new THREE.Matrix4().makeRotationY(ha * Math.PI))
        .multiply(new THREE.Matrix4().makeRotationZ((ha - 0.5) * 0.3));
      const ss = batch.pushAll(GATE_DOOR_KEYS, sm);
      const ln = 0.5 + ha * 1.5;
      box(timber, -ln, -0.055, -0.11, ln, 0.055, 0.11, new THREE.Color().copy(PAL.timber).multiplyScalar(0.9 + hz0 * 0.3));
      batch.popAll(ss);
    }
  }
  batch.popAll(used);
}

/**
 * The pose the ram leaves the leaves in, and the reason the wreck is modelled at all.
 *
 * Hiding the doors on a breach is one line and it is not enough: an empty archway with the
 * portcullis still raised behind it is what an *opened* gate looks like, and the player has
 * just watched a ram spend two minutes on it. What says "broken" is timber that is still
 * there and is in the wrong place — one leaf hanging skewed off its harr-post with its head
 * beaten in, the other down across the carriageway, and the drawbar snapped.
 *
 * Angles in radians, distances in metres, all applied about the leaf's own hinge line so the
 * wreck stands in the jambs the intact doors hung in. Local `+z` is the city side.
 */
const WRECK = {
  /** Swing of the surviving leaf into the passage. 41 deg: enough to read at battle range. */
  swing: 0.72,
  /** Cant off plumb, the upper collar having torn out of the jamb. */
  cant: 0.085,
  /** Tip of the fallen leaf: 84 deg, so it lies on the paving with its head slightly raised. */
  flat: 1.466,
  /** Skew of the fallen leaf across the carriageway. */
  yaw: -0.31,
  /** How far its foot slid off the hinge line, as a fraction of the half-width. */
  slide: 0.62,
  /** How far in from the door plane it came to rest. */
  shove: 0.85,
  /** Height of its foot above the ground under the gate. */
  lie: 0.19,
} as const;

/**
 * The ground outside the Porta Flaminia: the paved apron of the Via Flaminia widening
 * into the gate, the material yard where stone and timber came off the carts for the
 * new wall, and a pair of wayside monuments. Historically the approach to a Roman gate
 * was the busiest ground in the suburbs, and it is also the whole foreground of the
 * standard establishing viewpoint.
 */
function buildGateApproach(
  batch: Batch,
  detail: number,
  cx: number,
  cz: number,
  f: Frame,
  heightAt: (x: number, z: number) => number,
  rng: Rng
): void {
  const road = batch.s('road');
  const stone = batch.s('stone');
  const timber = batch.s('timber');
  const { nx, nz, dx, dz } = f;

  // Apron: a straight run of polygonal basalt from the gate out to z ≈ 258, splayed so
  // it funnels into the carriageway. Emitted as terrain-following strips.
  const from = 7;
  const to = 175;
  const strips = detail >= 1 ? 44 : 12;
  const pA = new THREE.Vector3();
  const pB = new THREE.Vector3();
  const pC = new THREE.Vector3();
  const pD = new THREE.Vector3();
  const col = new THREE.Color();
  for (let i = 0; i < strips; i++) {
    const t0 = from + ((to - from) * i) / strips;
    const t1 = from + ((to - from) * (i + 1)) / strips;
    // Splay from 5.5 m at the gate to 11 m at the far end.
    // Splayed at the gate, then settling to a consular carriageway of 4.6 m.
    const w0 = lerp(3.1, 2.35, Math.min(1, ((t0 - from) / 34) ** 0.7));
    const w1 = lerp(3.1, 2.35, Math.min(1, ((t1 - from) / 34) ** 0.7));
    const ax = cx + nx * t0;
    const az = cz + nz * t0;
    const bx = cx + nx * t1;
    const bz = cz + nz * t1;
    pA.set(ax - dx * w0, heightAt(ax - dx * w0, az - dz * w0) + 0.09, az - dz * w0);
    pB.set(bx - dx * w1, heightAt(bx - dx * w1, bz - dz * w1) + 0.09, bz - dz * w1);
    pC.set(bx + dx * w1, heightAt(bx + dx * w1, bz + dz * w1) + 0.09, bz + dz * w1);
    pD.set(ax + dx * w0, heightAt(ax + dx * w0, az + dz * w0) + 0.09, az + dz * w0);
    col.copy(PAL.basalt).multiplyScalar(0.82 + hash2(i, 3, 55) * 0.4);
    UPV.set(0, 1, 0);
    road.quadN(UPV, pA, pB, pC, pD, col);
    // Cart ruts polished into the setts down the centre of the carriageway.
    if (detail >= 2) {
      for (const side of [-1, 1]) {
        const o = side * 0.72;
        pA.set(ax + dx * (o - 0.16), heightAt(ax, az) + 0.1, az + dz * (o - 0.16));
        pB.set(bx + dx * (o - 0.16), heightAt(bx, bz) + 0.1, bz + dz * (o - 0.16));
        pC.set(bx + dx * (o + 0.16), heightAt(bx, bz) + 0.1, bz + dz * (o + 0.16));
        pD.set(ax + dx * (o + 0.16), heightAt(ax, az) + 0.1, az + dz * (o + 0.16));
        road.quadN(UPV, pA, pB, pC, pD, new THREE.Color().copy(PAL.basalt).multiplyScalar(1.45));
      }
    }
  }

  // Material yard: travertine and tufa off the carts, waiting to go through the gate.
  for (let i = 0; i < (detail >= 1 ? 9 : 3); i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const along = rng.range(14, 58);
    const off = side * rng.range(9, 26);
    const px = cx + nx * along + dx * off;
    const pz = cz + nz * along + dz * off;
    const g = heightAt(px, pz);
    const cols = 2 + rng.int(0, 2);
    const rows = 1 + rng.int(0, 3);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols - (r > 1 ? 1 : 0); c++) {
        const ox = (c - (cols - 1) * 0.5) * 1.3;
        const bx = px + dx * ox;
        const bz = pz + dz * ox;
        const tone = 0.6 + hash2(i * 5 + c, r, 71) * 0.5;
        const cc = new THREE.Color().copy(PAL.travertineDirty).multiplyScalar(tone);
        quadPrism(stone, bx - dx * 0.6, bz - dz * 0.6, bx + dx * 0.6, bz + dz * 0.6, nx, nz, 0.62, g + r * 0.62, g + (r + 1) * 0.62 - 0.02, cc, cc);
      }
    }
  }
  // Timber baulks and a stack of scaffold poles.
  if (detail >= 1) {
    for (let i = 0; i < 3; i++) {
      const along = rng.range(16, 52);
      const off = (i % 2 === 0 ? -1 : 1) * rng.range(12, 24);
      const px = cx + nx * along + dx * off;
      const pz = cz + nz * along + dz * off;
      const g = heightAt(px, pz);
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          cylinderBetween(
            timber,
            px + nx * (c - 1) * 0.34 - dx * 3.0,
            g + 0.17 + r * 0.32,
            pz + nz * (c - 1) * 0.34 - dz * 3.0,
            px + nx * (c - 1) * 0.34 + dx * 3.0,
            g + 0.17 + r * 0.32,
            pz + nz * (c - 1) * 0.34 + dz * 3.0,
            0.15,
            PAL.timber
          );
        }
      }
    }
  }
  // Kerbstones down both sides of the carriageway.
  if (detail >= 1) {
    for (let i = 0; i < strips; i++) {
      const t0 = from + ((to - from) * i) / strips;
      const t1 = from + ((to - from) * (i + 1)) / strips;
      const w0 = lerp(3.1, 2.35, Math.min(1, ((t0 - from) / 34) ** 0.7));
      const w1 = lerp(3.1, 2.35, Math.min(1, ((t1 - from) / 34) ** 0.7));
      for (const side of [-1, 1]) {
        const ax = cx + nx * t0 + dx * side * w0;
        const az = cz + nz * t0 + dz * side * w0;
        const bx = cx + nx * t1 + dx * side * w1;
        const bz = cz + nz * t1 + dz * side * w1;
        const gk = Math.min(heightAt(ax, az), heightAt(bx, bz));
        quadPrism(stone, ax, az, bx, bz, dx * side, dz * side, 0.34, gk - 0.2, gk + 0.24, PAL.peperino, PAL.travertineDirty, {
          ends: false,
        });
      }
    }
  }

  // Wayside honorific columns either side of the road, 40 m out.
  for (const side of [-1, 1]) {
    const px = cx + nx * 40 + dx * side * 8.5;
    const pz = cz + nz * 40 + dz * side * 8.5;
    const g = heightAt(px, pz);
    box(stone, px - 1.1, g - 0.4, pz - 1.1, px + 1.1, g + 1.5, pz + 1.1, PAL.travertineDirty, { topGain: 1.12 });
    column(stone, px, g + 1.5, pz, 0.42, 6.2, 'corinthian', PAL.travertine, detail);
    if (detail >= 1) statue(batch.s('metal'), px, g + 7.8, pz, 2.9, PAL.bronze, Math.PI + side * 0.4, detail >= 2 ? 8 : 5);
  }
}

const UPV = new THREE.Vector3(0, 1, 0);
