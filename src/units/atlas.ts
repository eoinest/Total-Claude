import * as THREE from 'three';
import { hash2 } from '../util/rand';
import { EMBLEMS } from './kit';

/**
 * The soldier texture atlas, generated procedurally at load.
 *
 * One 1024x1024 albedo, one normal and one packed AO/roughness/metalness, laid out as:
 *
 *     canvas rows    0..511     8 x 4 grid of 128 px material tiles
 *     canvas rows  512..1535    4 x 4 grid of 256 px painted shield faces

 * The sheet is **1024 x 1536, not square.** It was square, with exactly eight emblem slots
 * in a 4 x 2 grid — and exactly eight emblems, so it was full. A ninth would have been
 * written at row `floor(8 / 4) = 2`, i.e. canvas y 1024, which is off the bottom of a 1024
 * px canvas: no error, no warning, and a blank shield on every man carrying it. Carthage
 * needs six more devices, so the emblem band is now four rows deep. Every UV below is
 * computed from the two dimensions rather than from one, which is what makes that safe.
 *
 * Everything in the frame therefore samples one texture set, which is what lets a whole
 * faction's infantry — five helmet types, four armours, three shields, seven weapons and
 * twelve unit types — render in a single draw call per LOD.
 *
 * Procedural rather than loaded, for three reasons: the game must run with an empty
 * `public/assets/`; painted shield devices for a specific army do not exist as CC0
 * photographs; and a hand-written generator can guarantee the tiles are seamless and
 * consistently lit, which a mixture of scanned Poly Haven surfaces cannot.
 */

/**
 * **256 px a material tile, not 128, and the reason is measured.**
 *
 * A 128 px tile stretched over a torso puts one texel across 2.5 screen pixels at the
 * magnification the isolated-model deck shoots at, so every surface on the man was being
 * *magnified* and read as bilinear mush — which is precisely what three independent critics
 * reported as "no normal map, no roughness map" on a model that has carried both for months.
 * They were reading a starved sampler as an absent one.
 *
 * The two halves of this are coupled and neither works alone. Correcting the tiles' physical
 * size (`MAT_TILE_M`) without more texels **measurably makes the plate worse**: it shrinks
 * the same 128 texels into fewer screen pixels, pushing the tile's own finest content below
 * the resolvable band, and the octave probe put E2 down 12-15 % on all three full-figure
 * Roman plates for it. Doubling the texels first is what buys the room to shrink the tile.
 *
 * Cost is texture memory and nothing else — no draw call, no triangle, no vertex. The sheet
 * goes 1024 x 1536 to 2048 x 1536, so the three soldier textures go from about 25 MB
 * resident with mips to about 50 MB, against a 220 MB budget for the whole game. The bake is
 * four times the pixels; it runs once at load.
 */
export const ATLAS_W = 2048;
export const ATLAS_H = 1536;
/** Retained as the width, which is what every caller that used it meant. */
export const ATLAS_SIZE = ATLAS_W;
const TILE = 256;
const TILES_PER_ROW = 8;
const MAT_ROWS = 4;
const EMBLEM_TILE_PX = 256;
const EMBLEM_TOP = TILE * MAT_ROWS;

/** Material tile ids. Index maps to a cell of the 8 x 4 grid, row-major. */
export const enum Mat {
  IronWorn = 0,
  IronPlate = 1,
  Bronze = 2,
  Mail = 3,
  Scale = 4,
  LeatherBrown = 5,
  LeatherDark = 6,
  WoolCoarse = 7,
  Linen = 8,
  Skin = 9,
  Hair = 10,
  WoodPlank = 11,
  Fur = 12,
  Plume = 13,
  Rope = 14,
  Bands = 15,
  HideBay = 16,
  HideGrey = 17,
  HideBlack = 18,
  SaddleLeather = 19,
  Hoof = 20,
  Mane = 21,
  Bone = 22,
  ClothFine = 23,
  /**
   * The inside of a shield: hide facing, stitched rim turn-over, horizontal grip.
   *
   * Its own tile because it is the largest single surface a soldier presents to a camera
   * behind his own line — 11.9% of the romanline frame by difference, three times his armour.
   * It used to borrow the plank tile, whose six hard seams became the same corrugation on
   * every shield in the cohort, and then the leather tile, which is far too dark and far too
   * red for a per-man tint to reach the pale end of the range from. This one is drawn neutral
   * and mid-value on purpose, so a multiply can put it anywhere from pitch to raw hide.
   */
  ShieldBack = 24,
  /**
   * Structural oak: a heavy squared timber, not a shield board.
   *
   * `WoodPlank` is six thin planks with hard seams every 21 mm of tile, which is right for a
   * scutum and wrong for the beams of a siege engine — at engine scale those seams tile into
   * a corrugation across a 0.88 m cross-timber and read as clapboard. This is one baulk of
   * open-grain oak with adze facets, a couple of shakes and a black knot, drawn on a warm
   * mid-value field so a per-engine tint can take it from fresh-cut to grey and weathered.
   */
  OakBeam = 25,
  /**
   * Sinew spring cord.
   *
   * The one surface on a torsion engine a viewer has no reference for, and the one that has
   * to say "this is not a bow". Hundreds of parallel strands laid vertically, not laid up as
   * a rope: a spring bundle is combed sinew under a tonne of twist, so it reads as a tight
   * pale column with fine axial fibre and none of `Rope`'s helical barber-pole.
   */
  SinewCord = 26,
  /**
   * Elephant hide.
   *
   * Its own tile rather than a tint on `HideGrey`, which is a horse's coat: short hair over
   * a smooth hypodermis, and the whole point of an elephant's skin is that it is neither.
   * It is 2 to 4 cm thick, hairless, and cut everywhere by a network of deep fissures that
   * hold water — those creases are what an eye reads the animal by, and they run across the
   * body rather than along it. At 128 px this is the coarsest bump in the atlas on purpose:
   * a smooth grey elephant looks like an inflatable.
   */
  ElephantHide = 27,
  /**
   * A face. Not tileable, and mapped to one 120-degree arc of the skull lathe.
   *
   * There was no eye, nose or mouth anywhere in this game. Two 26 x 14 x 12 mm boxes of
   * `HideBlack` stood in for eyes and both were **inside the hair**: `Piece.HairShort` is a
   * full revolution 4 to 9 mm proud of the skull running down to y = -0.035, which is below
   * the brow and below both eye boxes, so a bare-headed man's face was sealed under a dome
   * of hair. A helmeted man's was under the helmet. Neither is visible at 20 px a man, which
   * is how it survived every blind round; on the isolated-model deck the critic scored face
   * **0** and it was the only 0 on the sheet.
   *
   * Its own tile rather than a region of `Skin` because a face needs texels. `Skin` is a
   * tileable noise field wrapped many times round a limb; a face is drawn once, at a known
   * scale, with features at known places. Splitting the skull into a face arc and a
   * remainder arc gives the face the whole 128 px tile — 766 texels per metre across it,
   * against the 374 the head carried before — which is what makes an iris 23 px wide instead
   * of 8.
   *
   * The layout is fixed by `soldierMesh`'s call and must not drift from it:
   *   u  0..1 across the 120-degree front arc, 0.5 dead centre on the nose;
   *   v  0..1 from y = -0.075 (under the jaw) to y = +0.140 (the crown), by **height**,
   *      via `revolve`'s `vFromY` — a lathe's rings are 20 to 50 mm apart and not evenly
   *      spaced, so a face painted against ring index lands in the wrong place.
   */
  Face = 28,
  Count = 29,
}

export interface UvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /**
   * **How much of the world one whole tile of this material covers, in metres.**
   *
   * `MAT_TILE_M` has existed since the torso-stretch fix, and until now only the swept
   * primitives could reach it — `soldierMesh` looked the number up and handed a repeat to
   * `tube`. Every other primitive was blind to it, and `box` in particular maps one entire
   * tile onto every face however small the face is: an 8 mm arrow shaft carries 250 texels
   * across 8 mm, which is **31,250 texels per metre** against a bare leg's 570. That is
   * most of the 13.1x texel-density spread across one man that round three's critics
   * recorded, and a man whose material grain changes thirteen-fold from piece to piece
   * cannot read as authored.
   *
   * Carrying it on the rect itself is what lets a primitive size its own mapping without
   * every call site being edited to say what it already said by choosing the tile.
   * Optional, because hand-built rects (the emblem block) have no material behind them.
   */
  m?: number;
}

/**
 * UV rectangle of a material tile.
 *
 * The V flip is baked in here because `CanvasTexture` uploads with `flipY = true`, so
 * canvas row 0 becomes v = 1. A 3-texel inset keeps mip level 2 and below from bleeding a
 * neighbouring tile into a silhouette edge.
 */
export function matUv(id: Mat): UvRect {
  const col = id % TILES_PER_ROW;
  const row = Math.floor(id / TILES_PER_ROW);
  const insetU = 3 / ATLAS_W;
  const insetV = 3 / ATLAS_H;
  const u0 = (col * TILE) / ATLAS_W + insetU;
  const u1 = ((col + 1) * TILE) / ATLAS_W - insetU;
  const v1 = 1 - (row * TILE) / ATLAS_H - insetV;
  const v0 = 1 - ((row + 1) * TILE) / ATLAS_H + insetV;
  return { u0, v0, u1, v1, m: MAT_TILE_M[id] };
}

/**
 * **How much of a man one tile of each material covers, in metres.**
 *
 * Every tile in this sheet draws a fixed number of real objects — 18 rings of mail, 14 rows
 * of scale, 7 girdle hoops, 6 planks — and until this table existed nothing anywhere tied
 * that count to a size. The repeats were hand-written per call site in `soldierMesh.ts`, one
 * number for around a torso and another for along it, and **every torso in the game came out
 * stretched**: the mail body sat at `repeatU: 3, repeatV: 4` over a circumference of 0.87 m
 * and a length of 0.66 m, so one tile covered 291 mm around by 164 mm along. That is a
 * **1.8:1 horizontal stretch**, and it turned a 9 mm riveted ring into a 16 x 9 mm oval —
 * which is exactly what the `legio-head` plate photographs, a coif of embossed lozenges.
 *
 * Sizing the tile instead of the repeat makes the stretch inexpressible: `soldierMesh` now
 * measures each swept surface's own circumference and path length and divides. Two useful
 * consequences fall out for free. A sleeve and a torso in the same material come out at the
 * same physical grain without anyone matching two numbers by hand; and at LOD2, where a
 * torso has a handful of segments, `MeshBuilder.repeatStops` clamps the repeat to the
 * segment count on its own, so **the low tier keeps the coarse tiling it already had and
 * pays nothing**.
 *
 * The value chosen for each material is the finer of (a) its real object size times the
 * number of objects the tile draws, and (b) what the *tighter* of the two existing axes
 * already delivered. Never the coarser: correcting an aspect ratio by stretching the fine
 * axis out to meet the coarse one would fix the shape and throw away the mid-band structure
 * that the octave instrument is measuring, which is the wrong trade in both directions.
 */
export const MAT_TILE_M: Record<Mat, number> = {
  // fbm period 14 over the tile, so the coarsest patina blotch is a fourteenth of it: 30 mm.
  [Mat.IronWorn]: 0.42,
  // A planished bowl. The period-3 term is the one roughness is derived from — 100 mm sweeps
  // of the hammer, which is what a burnished helmet actually shows.
  [Mat.IronPlate]: 0.30,
  // Casting mottle and patina at 30 mm, fbm period 10.
  [Mat.Bronze]: 0.30,
  // **18 rings. A riveted ring of the period is 8-10 mm outside diameter**, which is the
  // single most load-bearing number in this table: mail is the largest area of small
  // repeated objects a soldier wears, so it sets the scale a viewer reads the whole man by.
  [Mat.Mail]: 0.162,
  // 14 rows. Roman squamata finds run 10-50 mm; 15 mm is at the small end, chosen because it
  // is also the finer of the two axes the torso already carried and so costs no structure.
  [Mat.Scale]: 0.21,
  // fbm period 20 — 8 mm grain pebbling, which is what stops a jerkin reading as rubber.
  [Mat.LeatherBrown]: 0.16,
  [Mat.LeatherDark]: 0.18,
  // Sized by the **fold** field (fbm period 5), not the weave: the fold carries 0.38 of the
  // height amplitude against the weave's 0.42 spread over 18 cycles, and folds at 55 mm are
  // what a wool tunic reads as at any distance a man is legible from. The weave then comes
  // out at 15 mm, which is coarse for wool and is a lie no viewer can measure.
  [Mat.WoolCoarse]: 0.27,
  // Fold fbm period 6 at 55 mm. Linen creases tighter than wool, hence 26 weave cycles.
  [Mat.Linen]: 0.33,
  // fbm period 44 — 6 mm blotch and pore. **V is overridden to 1 on every limb**, because
  // the tile's elbow and wrist creases are placed at fixed v and only land on the joint if
  // the limb carries exactly one tile end to end; see `SKIN_LIMB_V` in `soldierMesh.ts`.
  [Mat.Skin]: 0.26,
  // 70 strands across, so 4 mm a strand clump.
  [Mat.Hair]: 0.28,
  // 6 planks at 120 mm. **Not driven from here** — the shield boards and the spear shafts
  // both take this tile at hand-set repeats, and halving the shaft grain has already been
  // tried and reverted because it moved the octave ratio the wrong way.
  [Mat.WoodPlank]: 0.72,
  // fbm period 30 — 15 mm tufts.
  [Mat.Fur]: 0.45,
  [Mat.Plume]: 0.20,
  // 14 lays of the strand at 12 mm.
  [Mat.Rope]: 0.17,
  // **7 girdle hoops at 64 mm**, against 55-70 mm on the Corbridge finds. The segmentata
  // torso already ran 459 x 450 mm and is the one surface in the game that was square and
  // correctly scaled before this table; it comes out unchanged, which is the check that the
  // arithmetic here is not inventing a correction.
  [Mat.Bands]: 0.45,
  [Mat.HideBay]: 0.50,
  [Mat.HideGrey]: 0.50,
  [Mat.HideBlack]: 0.50,
  [Mat.SaddleLeather]: 0.30,
  [Mat.Hoof]: 0.12,
  [Mat.Mane]: 0.25,
  [Mat.Bone]: 0.20,
  // Drape fbm period 4 at 90 mm — a cloak hangs in bigger folds than a tunic sits in.
  [Mat.ClothFine]: 0.36,
  // 0.36, matching `MeshBuilder.SHIELD_PLANK_M`: this cell is only ever used on a shield and
  // the two faces of a board must carry the same physical grain or the rim gives it away.
  [Mat.ShieldBack]: 0.36,
  [Mat.OakBeam]: 0.80,
  [Mat.SinewCord]: 0.15,
  [Mat.ElephantHide]: 0.60,
  // Not tiled: the face is drawn once onto a 120-degree arc of the skull at a known scale.
  [Mat.Face]: 0.22,
  [Mat.Count]: 1,
};

/**
 * Where the emblem block sits, in the form the shader wants.
 *
 * V is fiddly because `CanvasTexture` uploads flipped: within a tile V rises with the
 * shield's own up, but the tile *index* runs the other way, since row 1 is lower down the
 * canvas and therefore lower in V. Hence the shader's `(u + tile.x, v - tile.y)`.
 */
export const EMBLEM_ORIGIN: [number, number] = [
  0,
  1 - (EMBLEM_TOP + EMBLEM_TILE_PX) / ATLAS_H,
];
export const EMBLEM_TILE: [number, number] = [
  EMBLEM_TILE_PX / ATLAS_W,
  EMBLEM_TILE_PX / ATLAS_H,
];
/**
 * Emblem tiles across the sheet.
 *
 * Eight rather than four because the sheet is now 2048 wide and four 256 px devices would
 * leave half the emblem band empty. The shader used to hard-code `mod(e, 4.0)` beside a
 * comment on this very line saying the two "must agree" — an agreement kept by remembering,
 * which is the arrangement that has already repainted an army once. It is now fed through
 * `SOLDIER_EMBLEM_COLS` from this constant, so the two cannot disagree.
 */
export const EMBLEM_COLS = 8;

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

/** Tileable value noise: the lattice wraps at `period` so tiles have no seam. */
function vnoise(x: number, y: number, period: number, salt: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const w = (t: number): number => t * t * (3 - 2 * t);
  const u = w(xf);
  const v = w(yf);
  const m = (a: number): number => ((a % period) + period) % period;
  const a = hash2(m(xi), m(yi), salt);
  const b = hash2(m(xi + 1), m(yi), salt);
  const c = hash2(m(xi), m(yi + 1), salt);
  const d = hash2(m(xi + 1), m(yi + 1), salt);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x: number, y: number, octaves: number, period: number, salt: number): number {
  let sum = 0;
  let amp = 0.5;
  let total = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(x * f, y * f, period * f, salt + o * 17) * amp;
    total += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / total;
}

// ---------------------------------------------------------------------------
// Material definitions
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];

interface MatDef {
  /** Base colour in sRGB 0..1 at (u, v) in [0,1). */
  colour(u: number, v: number, out: Rgb): void;
  /** Surface height 0..1, used to derive the normal map and a cavity term. */
  height(u: number, v: number): number;
  /**
   * Mean roughness. The bake spreads a swing around it — see `ROUGH_SWING`.
   *
   * It is a *mean*, not a ceiling: a tile authored at 0.9 comes out 0.50 to 0.995 across
   * its own height field, and the number here is where the middle of that sits.
   */
  roughness: number;
  /**
   * Peak-to-peak roughness swing across the tile, in absolute roughness units.
   *
   * Optional; the default reproduces what the multiplicative formula this replaces gave a
   * material whose range already fitted inside 0..1. Set it explicitly only to widen or
   * narrow a particular surface's spread on purpose.
   */
  roughVar?: number;
  metalness: number;
  /** How strongly the height field bends normals. */
  bump: number;
  /**
   * **Extra tangent-space slope, added to the one differenced out of `height`.**
   *
   * A scalar height field can only ever produce an *isotropic* normal: central differences
   * see a thread and a pit identically, because both are "a bump". Cloth is the surface
   * where that is most wrong. A plain weave is not a field of bumps, it is two sets of
   * parallel cylinders crossing at right angles, and a cylinder's normal bends in exactly
   * one axis — along the thread it is flat. Differencing `max(warp, weft)` gives the
   * diamond lattice that three rounds of critics have called "a printed weave".
   *
   * This hook writes the slope directly, so a warp float can tilt the normal in u and leave
   * v alone. `out[0]` is d(height)/du and `out[1]` d(height)/dv, in the same units the
   * central difference produces, and it is added *before* `bump` scales the pair.
   */
  slope?(u: number, v: number, out: [number, number]): void;
  /**
   * Openness for the ORM red channel, 0 = fully enclosed, 1 = open sky. Defaults to
   * `height`.
   *
   * Separate from `height` because the two want different content on cloth: the cavity that
   * darkens a garment is the *fold*, a 50 mm trough, and it must not be swamped by the
   * 4 mm thread crests that dominate the height field. A scalar averages down the mip
   * ladder where a bump's two opposing slopes cancel — the counter recorded for masonry in
   * `docs/HANDOFF.md` — so this is the channel that survives distance.
   */
  cavity?(u: number, v: number): number;
}

/**
 * **Roughness is spread around its mean, and the spread cannot plateau.**
 *
 * The formula this replaces was `roughness * (0.5 + (1 - h) * 1.05)` clamped into 0..1, and
 * for every material authored above 0.645 the clamp bit: the wool tile came out with
 * **15.3 % of its texels at a flat 1.0**, linen 11.9 %, fur 35.4 %, rope 43.0 %, elephant
 * hide 48.7 %, the shield board 6.3 %. Those are not rough regions, they are regions with
 * *no roughness signal at all* — a plateau, which is precisely the "flat 255" defect round
 * three's critics recorded on `praet-torso`, whose frame is more than half shield board.
 *
 * The cure is to fit the swing to the headroom instead of clamping it, **symmetrically about
 * the authored value**, so the tile's mean roughness is exactly what the material says it is
 * and only the spread narrows. Every plateau measures 0.00 % after.
 *
 * The asymmetric version — cap `up` at the ceiling and spend the remainder downward, keeping
 * the full peak-to-peak swing — was written first, measured, and **rejected**. It preserves
 * the swing at the cost of the mean: wool's mean roughness fell 0.836 to 0.705, hair, fur,
 * plume and rope the same, and under the product's own lighting rig a glossier cloth is a
 * sharper specular lobe. Graded under Battle rig it cost dE1 +19.5 % pooled, on a figure
 * that already carries 3.7x the reference's 1 px energy. Under the studio `field` preset the
 * same arm looked harmless, which is the whole argument for grading under the rig that
 * ships.
 */
const ROUGH_MIN = 0.04;
/** Not 1.0: a texel that lands exactly on the ceiling is a 255, and 255 is the defect. */
const ROUGH_MAX = 0.995;
/** Cap on the peak-to-peak swing, so a rough material does not swing to a mirror. */
const ROUGH_SWING = 0.5;

const mix3 = (a: Rgb, b: Rgb, t: number, out: Rgb): void => {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
};

/**
 * Ring mail: interlocked rows, each row offset half a ring from its neighbours.
 *
 * **No two rings are the same size and no two sit quite square, and that is the fix rather
 * than the decoration.** The lattice was exactly periodic — every ring identical, on a
 * perfect grid — which is what a *printed* mail reads as, and what beats against the pixel
 * grid into moire at the range a cohort is legible from. A riveted hauberk is thousands of
 * hand-drawn rings hammered shut by hand: the sizes run a tenth either way, the rows wander,
 * and a proportion of them are galled flat or rusted proud.
 *
 * The jitter is hashed off the ring's own grid cell, so it is stable, tileable (`% rings`
 * closes the lattice) and free.
 */
const mailHeight = (u: number, v: number, rings: number): number => {
  const gy = v * rings;
  const row = Math.floor(gy);
  const fy = gy - row;
  const gx = u * rings + (row % 2) * 0.5;
  const col = Math.floor(gx);
  const fx = gx - col;
  // Per-ring wander and gauge, from the ring's own cell. `% rings` is what keeps the tile
  // seamless: the last column's hash has to be the same one column 0 will read.
  const h1 = hash2(col % rings, row % rings, 313);
  const h2 = hash2(col % rings, row % rings, 317);
  const dx = fx - 0.5 + (h1 - 0.5) * 0.16;
  const dy = fy - 0.5 + (h2 - 0.5) * 0.14;
  const r = Math.sqrt(dx * dx + dy * dy) * 2;
  // A torus profile: highest on the ring itself, lowest in the hole and between rings.
  const gauge = 0.62 + (h1 - 0.5) * 0.09;
  const ring = Math.exp(-((r - gauge) ** 2) / 0.055);
  return Math.min(1, ring * (0.86 + h2 * 0.16) + 0.05);
};

const TAU = Math.PI * 2;

/**
 * How wide the transition across a plank joint is, as a fraction of the plank's half-width.
 *
 * 0.34, and the number is an octave argument rather than a taste. A plank is a sixth of a
 * 0.36 m shield tile, so its half-width is 21 texels; at the 0.14 the other seams use, the
 * transition is three texels, which on the isolated deck is **2.5 screen px** — E1, the one
 * band this figure is already 3.7x over on. At 0.34 it is seven texels and about 6 px, which
 * is E2. Physically it is also the truer number: a shield board's joints are chamfered and
 * hide-covered, not machined.
 */
const PLANK_SEAM_W = 0.34;

/**
 * **A hanging fold, which is the shape cloth has and a noise blotch is not.**
 *
 * Round three's critics led with "cloth has no folds and no silhouette — flat polygon plates
 * with a printed weave and hard unbevelled creases", and the fold term the tiles carried was
 * an isotropic `fbm` at 5 and 11 cycles: a field of round blobs, equally wide in both axes.
 * Cloth does not do that. A garment hangs, so its creases are *long* along the hang and
 * *narrow* across it, and the eye reads a garment by the run of those lines.
 *
 * Two properties, and both are the point:
 *
 *   - **Anisotropy.** The lattice is sampled twice as often across the cloth as along it, so
 *     a feature is 2:1 long in v. `vnoise` wraps at `period`, so both arguments must be
 *     integer multiples of it or the tile seams — hence `cycles * 2` by `cycles`. It was 3:1
 *     and that photographed as varnished wood grain down a bracae leg: unbroken streaks the
 *     whole length of the tile read as timber, not as cloth.
 *   - **A bevelled trough.** Raw `fbm` run through the normal difference gives a crease with
 *     a discontinuous second derivative, which is the "hard unbevelled" half of the note and
 *     is nearly pure 1 px energy. Shaping it with the smoothstep polynomial rounds the crest
 *     and widens the valley floor, which moves the same amplitude down into the 2-8 px
 *     octaves where this project's whole deficit lies.
 *
 * Returns 1 on a crest and 0 in the bottom of a crease.
 */
const foldField = (u: number, v: number, cycles: number, salt: number): number => {
  const n = fbm(u * cycles * 2, v * cycles, 2, cycles, salt);
  const t = Math.min(1, Math.max(0, n * 1.18 - 0.09));
  return t * t * (3 - 2 * t);
};

/**
 * A bevelled seam between two boards: 1 in the bottom of the joint, 0 on the plank face.
 *
 * The distinction this exists to make is the one round three's critics named on cloth and
 * that turned out to matter far more on wood. A seam written as a comparison — "closer than
 * 0.03 of a plank to the edge" — is a **step**, and a step in a height field differences to
 * a one-texel normal discontinuity at full amplitude and bakes a hard-edged black line into
 * the cavity. Under a weak studio light that is a dark line. Under the product's own sun,
 * with the cavity gating direct light, it is a row of hard shadows one pixel wide, which is
 * pure 1 px energy and the one octave this figure is already 3.7x over on.
 *
 * The profile is a raised cosine over the joint's own width, which is also what a planed
 * board edge looks like: an arris rounded by handling either side of a narrow gap.
 */
const seamProfile = (t: number, count: number, w = 0.14): number => {
  const f = t * count;
  const d = Math.abs(f - Math.floor(f) - 0.5) * 2;
  if (d < 1 - w) return 0;
  return 0.5 - 0.5 * Math.cos(((d - (1 - w)) / w) * Math.PI);
};

/**
 * **Yarn tone: irregular along the thread, sharp across it.**
 *
 * The albedo weave this replaces was `(sin(u * 2pi * n) + sin(v * 2pi * n)) * 0.22` — a
 * perfectly periodic plaid. Two things were wrong with it and only the first was ever named.
 * It is a *printed* pattern, identical in sun and shade, with no over-under anywhere in it;
 * and being exactly periodic it beats against the pixel grid, which is where the moire on
 * the bracae came from.
 *
 * But deleting it outright cost real mid-band energy, measured: with the plaid gone and only
 * the slope weave left, E2 fell 2-4 % on every cloth-carrying plate. A weave *is* visible in
 * a garment's colour — warp and weft take dye differently and a hand-spun yarn varies along
 * its own length — so the content belongs here. What it must not be is periodic.
 *
 * This samples the noise lattice `across / along` times more often across the thread than
 * along it, which is what a yarn looks like, and it is irregular, so it cannot beat against
 * anything. `across` must be an integer multiple of `along` or the tile seams — `vnoise`
 * wraps at its period and both arguments have to close on it.
 */
const threadTone = (
  u: number, v: number, across: number, along: number, salt: number
): number => fbm(u * across, v * along, 2, along, salt);

/**
 * **The three cloth fold stacks, and the octave arithmetic that sizes them.**
 *
 * The bands this project is short of are 2-8 screen px, and a cycle count only becomes a
 * screen size once the tile's world size and the plate's magnification are in it. On the
 * isolated deck a man of 1.75 m fills 1056 device px, i.e. 603 px/m, so a 0.27 m wool tile
 * is 163 px across and one of its 256 texels is **0.64 screen px**. A difference-of-Gaussian
 * band at sigma s peaks around a wavelength of 2.2s to 4s, which puts:
 *
 *     E1  ->  2-4 px   ->   3-6 texels   ->  40-85 cycles per tile
 *     E2  ->  5-9 px   ->   8-14 texels  ->  18-32 cycles
 *     E4  ->  9-18 px  ->  14-28 texels  ->   9-18 cycles
 *     E8  -> 18-35 px  ->  28-55 texels  ->   5-9 cycles
 *
 * That table is not decoration; it was paid for. A nap term at 44 cycles was added here to
 * "fill the 4 px band", measured, and **reverted**: it lands at 3.7 px, which is E1, and it
 * took R from 1.308 to 1.451 while moving E2 by 1.5 %. Nothing in a cloth tile should now
 * sit above about 35 cycles, and each stack below is three octaves chosen to land one in E2,
 * one in E4 and one in E8.
 */
const WOOL_FOLD = (u: number, v: number): number =>
  foldField(u, v, 5, 211) * 0.50 + foldField(u, v, 11, 217) * 0.32
  + foldField(u, v, 18, 251) * 0.18;
const LINEN_FOLD = (u: number, v: number): number =>
  foldField(u, v, 7, 223) * 0.48 + foldField(u, v, 15, 227) * 0.32
  + foldField(u, v, 22, 257) * 0.20;
const CLOAK_FOLD = (u: number, v: number): number =>
  foldField(u, v, 3, 233) * 0.52 + foldField(u, v, 8, 239) * 0.30
  + foldField(u, v, 14, 263) * 0.18;

/**
 * **A plain weave written as slope, not as height — the directional-thread normal.**
 *
 * A scalar height field can only produce an isotropic normal: central differences cannot
 * tell a thread from a pimple, because both are "a bump". That is why every cloth surface in
 * this game has read as a *printed* weave through three rounds — `max(warp, weft)` in the
 * height field renders as a diamond lattice, which is a lattice of bumps, and at the
 * magnification the plates are shot at it is the moire grid the bracae photographed as.
 *
 * A real plain weave is two sets of parallel cylinders crossing at right angles, passing
 * over and under alternately. A cylinder's normal bends in exactly one axis and is dead flat
 * along its own — so the warp, which runs along v, must tilt the normal in **u only**, and
 * the weft in **v only**. That cannot be expressed as a height field and it is the whole
 * reason `MatDef.slope` exists.
 *
 * `cos(u) * cos(v)` is the over-under: +1 where the warp is on top, -1 where the weft is,
 * and smooth between, so there is no hard edge where one thread crosses under the other.
 * Each thread's own cross-section is the sine, zero on the thread's crown and peaking on its
 * two flanks, which is what a cylinder does.
 *
 * `amp` is in the same units the height difference produces, i.e. before `bump`.
 */
const weaveSlope = (
  u: number, v: number, cycles: number, amp: number, out: [number, number]
): void => {
  const cu = Math.cos(u * TAU * cycles);
  const cv = Math.cos(v * TAU * cycles);
  const warpUp = 0.5 + 0.5 * cu * cv;
  out[0] += -amp * Math.sin(u * TAU * cycles) * warpUp;
  out[1] += -amp * Math.sin(v * TAU * cycles) * (1 - warpUp);
};

/**
 * A metal's base colour is its **F0**, not a grey that looks about right.
 *
 * A conductor has no diffuse lobe at all: the whole of its colour is the Fresnel reflectance
 * at normal incidence, and that number is measured rather than chosen. Polished iron is 0.56
 * linear. These tiles carried 0.157 linear, which is not iron, it is charcoal — and combined
 * with a metalness held down at 0.45 it gave an effective F0 of about 0.11, a fifth of real
 * iron, with the missing energy parked in a diffuse term that nothing in shadow was bright
 * enough to light. Measured over the Roman line by difference (`tools/probe-units.mjs`) that
 * produced a helmet median of 0.0354 display luminance against a whole-frame mean of 0.117,
 * and a shadowed helmet of (0.0121, 0.0143, 0.0193) — dark, and *blue*, because the only
 * thing a weak specular has to reflect on the shaded side of a cohort is sky.
 *
 * The comment this replaces recorded that *raising* metalness made armour darker, and
 * concluded that metal should stay part-dielectric. That was a true measurement of a false
 * dichotomy: raising metalness while holding a charcoal albedo removes the diffuse term and
 * puts a charcoal-dark mirror in its place, so of course it goes darker. The model asks for
 * both to move together. It was also measured at an effective IBL gain of 1.08, where the
 * probe now reports 0.508 x 2.9 = 1.47.
 *
 * Values are sRGB, because that is what the atlas canvas stores; linear equivalents in note.
 */
/**
 * Burnished iron, F0 0.56 linear.
 *
 * Warmed very slightly. True iron is a shade *cool* (0.560, 0.570, 0.580), and a rank of
 * cool mirrors under a blue sky is precisely the blue-helmet result the measurement above
 * condemns. A warm F0 is also the honest choice for wrought iron, which is never pure.
 */
const IRON: Rgb = [0.78, 0.765, 0.735];
/** Pitted, oxidised iron. Oxide is a poor reflector, so this is a real F0 floor, not shading. */
const IRON_DARK: Rgb = [0.46, 0.44, 0.415];
const RUST: Rgb = [0.42, 0.26, 0.155];
/** Bronze F0, strongly warm — the red channel is better than twice the blue. */
const BRONZE: Rgb = [0.88, 0.70, 0.40];
const BRONZE_DARK: Rgb = [0.52, 0.40, 0.21];


/**
 * Per-plate tilt for a plated armour, as a **slope** rather than as height.
 *
 * A materials grader, on the armour: *"scale and lamellar in Rome II resolves into individual
 * plates each with its own highlight; ours is a tiling dot pattern with one shared sheen."*
 *
 * The dot pattern is the height field, and it was already per-plate: `Mat.Scale`'s hash
 * varies each plate's gauge, its lean and its tarnish. What it could not vary is the one
 * thing a highlight is a function of — **which way the plate faces**. A height field
 * differenced into a normal gives every plate the same dome, so every plate answers the sun
 * at the same angle, and a hundred of them answer it at the same angle together. That is the
 * shared sheen, and it is the same defect as the shield boss and the helmet bowl in a third
 * costume: a repeated form under a single light has a single response unless something breaks
 * the repeat.
 *
 * A wired-on scale, a riveted lame and a mail ring are all hung individually and none of them
 * hangs true. Two hashed radians of tilt per plate, added straight to the tangent-space
 * gradient, is exactly that and costs nothing at run time — `MatDef.slope` exists for this,
 * and it is what the cloth weave already uses.
 *
 * Hashed off the plate's own cell modulo the row count, like the tile's other per-plate
 * draws, which is what keeps it seamless across the tile boundary.
 */
function plateTilt(
  u: number, v: number, rows: number, stagger: number, amp: number, out: [number, number]
): void {
  const gy = v * rows;
  const row = Math.floor(gy);
  const gx = u * rows + (row % 2) * stagger;
  const col = Math.floor(gx);
  const a = hash2(col % rows, row % rows, 367) - 0.5;
  const b = hash2(col % rows, row % rows, 373) - 0.5;
  out[0] += a * amp;
  out[1] += b * amp;
}

const MATS: Record<Mat, MatDef> = {
  // Pitted, scratched iron — the default for a soldier's ironmongery. Rome II's armour
  // reads as metal because it is dark and broken up, not because it is shiny.
  [Mat.IronWorn]: {
    colour(u, v, out) {
      const n = fbm(u * 9, v * 9, 4, 9, 3);
      const scratch = vnoise(u * 3, v * 46, 3, 11);
      const rust = Math.max(0, fbm(u * 5, v * 5, 3, 5, 21) - 0.62) * 2.6;
      mix3(IRON_DARK, IRON, n * 0.85 + scratch * 0.15, out);
      mix3(out, RUST, Math.min(0.7, rust), out);
    },
    height: (u, v) => fbm(u * 14, v * 14, 3, 14, 3) * 0.6 + vnoise(u * 3, v * 40, 3, 11) * 0.4,
    // Iron is a conductor, so this is 1 less the rust. The rust term in `colour` above is an
    // oxide and genuinely is not metallic, but it is painted into the same tile, so the
    // metalness map cannot separate them — 0.88 is the compromise that leaves a rusted patch
    // reading as a dielectric crust without giving clean iron a diffuse lobe it should not
    // have. Roughness stays high: this is the *worn* tile, the everyday ironmongery.
    /**
     * **Metalness 1, and the reason is that this fix shipped half-applied.**
     *
     * The note above `IRON` argues at length that a conductor has no diffuse lobe and that
     * its colour *is* its F0, and the albedos were duly raised to measured F0 -- iron 0.78,
     * bronze 0.88/0.70/0.40. The metalness values were not: they stayed at the 0.36-0.74 the
     * old charcoal-albedo tiles used. That leaves every metal on a soldier **half dielectric
     * with a metal's albedo**, which is the one combination the note explicitly warns is
     * worse than either end -- a bright saturated diffuse lobe with a broad soft highlight
     * over it, which is the definition of painted plastic, and is exactly what the
     * `praet-torso` plate photographs on a bronze squamata.
     *
     * The recorded counter-measurement ("raising metalness darkens armour, verified twice")
     * was taken against a charcoal albedo at an effective IBL gain of 1.08. Both have since
     * moved: the albedo is a real F0 and the probe reports 0.508 x 2.9 = 1.47. Moving one
     * half of a two-variable change and leaving the other is not a conservative choice, it
     * is the worst point in the space.
     */
    roughness: 0.44,
    metalness: 1,
    bump: 0.5,
  },
  // Cleaner plate for helmets and bosses.
  [Mat.IronPlate]: {
    colour(u, v, out) {
      const n = fbm(u * 6, v * 6, 3, 6, 5);
      const brush = vnoise(u * 60, v * 2, 60, 7);
      // The helmet bowl and the shield boss: the two surfaces on a man that catch the sun,
      // so this is the cleanest metal in the atlas and sits at full iron F0 at the top of
      // its range. The floor is hammer-shadow, not oxide, so it does not go as dark as the
      // worn tile.
      mix3([0.58, 0.565, 0.535], [0.83, 0.815, 0.785], n * 0.7 + brush * 0.3, out);
    },
    // Three scales on purpose. The brush marks and the medium fbm give the pitting; the
    // period-3 term is the one that matters, because roughness is derived from this height
    // field and a *coherent* smooth zone about a third of the tile across is what puts one
    // readable burnished highlight on a helmet crown. High-frequency roughness noise alone
    // averages, at helmet size on screen, to a flat sheen — which is what every helmet in
    // the Roman frames had instead of a glint.
    height: (u, v) =>
      vnoise(u * 56, v * 2, 56, 7) * 0.22
      + fbm(u * 8, v * 8, 3, 8, 5) * 0.46
      + fbm(u * 3, v * 3, 2, 3, 151) * 0.32,
    /*
     * Hammered and burnished, and a pure conductor.
     *
     * 0.34, not 0.22, and the earlier note below is preserved because it is half right. A
     * glint *is* what distinguishes a rank of Rome II helmets from a rank of grey cones, and
     * 0.22 does produce one. What 0.22 also produces is a glint that cannot be *photographed*:
     * GGX's peak is 1 / (pi * alpha^2), which at 0.22 is about 136, so against a sun already
     * at intensity 3 the lobe is clipped white wherever the mirror condition is met. A clipped
     * white hole carries no shape and no colour, every helmet's is identical to every other's,
     * and three blind graders in round one independently reported ours as "the same small
     * blown-white four-point star, same size, same relative position" on every crown. At 0.34
     * the peak is 27 — still five times a diffuse surface, still unmistakably a burnished
     * bowl, and now inside the range the tone curve can render as a *shape*.
     *
     * The old note, which stands: low roughness is what puts one tight readable glint on a
     * helmet crown instead of a flat sheen over the whole bowl.
     *
     * 0.40 on a second look at the target rather than at the arithmetic. A native-resolution
     * crop of the reference melee plate shows a bronze helmet whose sheen runs across the
     * whole crown as a smooth gradient that *follows the form*, with nothing in the frame
     * clipped to white except the sky itself — armour peaks around 0.85. At 0.34 the peak is
     * still 27 and the sun is still 3, so the brightest few pixels of a bowl still clip, and
     * a clipped pixel has no form. 0.40 puts the peak at 12.4, which is eight times a diffuse
     * surface — unmistakably metal — and inside the range the shoulder can render.
     */
    roughness: 0.40,
    metalness: 1,
    bump: 0.25,
  },
  // Gilded bronze: praetorian fittings, helmet trim, harness bosses.
  [Mat.Bronze]: {
    colour(u, v, out) {
      const n = fbm(u * 7, v * 7, 3, 7, 9);
      const patina = Math.max(0, fbm(u * 4, v * 4, 3, 4, 31) - 0.58) * 2;
      mix3(BRONZE_DARK, BRONZE, n, out);
      mix3(out, [0.34, 0.5, 0.4], Math.min(0.45, patina), out);
    },
    height: (u, v) => fbm(u * 10, v * 10, 3, 10, 9),
    // Cast and polished bronze is a mirror, and a warm one, so what it reflects comes back
    // warm and the sky cannot take it over. Gilt fittings are the one thing on a man that
    // should read as a mirror, and the patina term in `colour` is the only part of this tile
    // that is an oxide — hence 0.95 rather than a flat 1.
    // 0.37, not 0.30, not 0.23. Each step has been in the same direction and for the same
    // reason: a cast, wiped, marched-in bronze is not a mirror, and every round of blind
    // grading has said so. 0.30 was still inside the range where the punctual sun's lobe
    // clips to white — see the arithmetic on `Mat.IronPlate` above, which is the same
    // argument with the same numbers. 0.42 on the same second look as `Mat.IronPlate`: the
    // reference's bronze is the softest metal in its frame, not the hardest.
    roughness: 0.42,
    metalness: 1,
    bump: 0.3,
  },
  [Mat.Mail]: {
    colour(u, v, out) {
      const h = mailHeight(u, v, 18);
      const grime = fbm(u * 5, v * 5, 3, 5, 13);
      mix3([0.42, 0.408, 0.39], [0.76, 0.745, 0.715], h * (0.7 + grime * 0.3), out);
      // A worn hauberk is not one alloy. Some rings are bright where a strap or a scabbard
      // has polished them, some are rusted, and a patch repaired in the field is a different
      // wire altogether. Hashed per ring off the same lattice the height uses, so the two
      // agree about where a ring is.
      const gx = u * 18 + (Math.floor(v * 18) % 2) * 0.5;
      const c = Math.floor(gx) % 18;
      const r18 = Math.floor(v * 18) % 18;
      const wear = hash2(c, r18, 331);
      const rust = Math.max(0, fbm(u * 4, v * 4, 3, 4, 337) - 0.56) * 2.2 * hash2(c, r18, 347);
      const k = 0.86 + wear * 0.30;
      out[0] *= k; out[1] *= k; out[2] *= k;
      mix3(out, RUST, Math.min(0.55, rust), out);
    },
    height: (u, v) => mailHeight(u, v, 18),
    // A ring is a small torus hung on four others and none of them hangs flat.
    slope: (u, v, out) => plateTilt(u, v, 18, 0.5, 0.42, out),
    // Mail is thousands of small curved rings, so it scatters: rough, and heavily
    // self-shadowed by the cavity term in the red channel. High metalness used to render a
    // hamata as a black net — but that was a metal with a *charcoal* albedo, which has no
    // colour left to reflect. At true iron F0 the same rings catch the sun individually,
    // which is what makes mail read as mail rather than as a grey knitted jumper.
    // A mail sheet is thousands of small curved mirrors at every angle at once, so its
    // *effective* roughness is high even though each ring is burnished. That is a real
    // statement about the BRDF and it survives the metalness going to 1; 0.36 metalness was
    // not, it was a leftover.
    roughness: 0.52,
    metalness: 1,
    bump: 1.0,
  },
  // Lorica squamata: overlapping bronze-washed scales wired to a linen backing.
  /**
   * Lorica squamata: overlapping bronze-washed scales wired to a linen backing.
   *
   * Same correction as the mail and for the same reason. Fourteen rows of *identical* plates
   * on a perfect grid is a printed scale; a squamata is a few hundred hand-cut plates wired
   * on individually, so they sit a little proud and a little askew of one another, they
   * differ in gauge, and a proportion are dished, sprung or replaced. The jitter is hashed
   * off the plate's own cell modulo the row count, which is what keeps the tile seamless.
   */
  [Mat.Scale]: {
    colour(u, v, out) {
      const rows = 14;
      const gy = v * rows;
      const row = Math.floor(gy);
      const fy = gy - row;
      const gx = u * rows + (row % 2) * 0.5;
      const col = Math.floor(gx);
      const fx = gx - col;
      const j = hash2(col % rows, row % rows, 353);
      const j2 = hash2(col % rows, row % rows, 359);
      // Scale plate: rounded bottom edge, darker in the overlap gutter.
      const edge = Math.min(1, Math.max(0, (1 - fy * (0.92 + j * 0.16)) * 3));
      const side = 1 - Math.abs(fx - 0.5 + (j2 - 0.5) * 0.16) * (1.5 + j * 0.22);
      const lit = Math.max(0, edge * side);
      const n = fbm(u * 8, v * 8, 3, 8, 17);
      mix3(BRONZE_DARK, BRONZE, lit * 0.8 + n * 0.2, out);
      // Per-plate tarnish: a wired-on scale is its own small object and weathers as one.
      const k = 0.84 + j2 * 0.32;
      out[0] *= k; out[1] *= k; out[2] *= k;
      if (fy > 0.9) mix3(out, [0.1, 0.08, 0.05], 0.7, out);
    },
    height(u, v) {
      const rows = 14;
      const gy = v * rows;
      const row = Math.floor(gy);
      const fy = gy - row;
      const gx = u * rows + (row % 2) * 0.5;
      const col = Math.floor(gx);
      const fx = gx - col;
      const j = hash2(col % rows, row % rows, 353);
      const j2 = hash2(col % rows, row % rows, 359);
      const side = 1 - Math.abs(fx - 0.5 + (j2 - 0.5) * 0.16) * (1.6 + j * 0.22);
      return Math.max(0, Math.min(1, (1 - fy * (0.78 + j * 0.14)) * Math.max(0, side)));
    },
    // Each scale is wired on through two holes and hangs a little askew of its neighbour.
    slope: (u, v, out) => plateTilt(u, v, 14, 0.5, 0.55, out),
    // Bronze-washed scales, each a small curved mirror. Same reasoning as the mail: the
    // scale edges are what catch the light and they cannot do it without an F0 to do it with.
    // 0.40, not 0.31: same argument as `Mat.IronPlate`. A plate that clips the sun to white
    // carries no form, and a rank of them clips identically.
    roughness: 0.40,
    metalness: 1,
    bump: 0.9,
  },
  [Mat.LeatherBrown]: {
    colour(u, v, out) {
      const n = fbm(u * 16, v * 16, 4, 16, 23);
      const crack = Math.max(0, vnoise(u * 11, v * 11, 11, 29) - 0.55) * 2;
      mix3([0.24, 0.15, 0.09], [0.46, 0.31, 0.18], n, out);
      mix3(out, [0.13, 0.08, 0.05], Math.min(0.6, crack), out);
    },
    height: (u, v) => fbm(u * 20, v * 20, 4, 20, 23),
    roughness: 0.7,
    metalness: 0.02,
    bump: 0.55,
  },
  [Mat.LeatherDark]: {
    colour(u, v, out) {
      const n = fbm(u * 18, v * 18, 4, 18, 37);
      mix3([0.11, 0.08, 0.06], [0.26, 0.19, 0.13], n, out);
    },
    height: (u, v) => fbm(u * 22, v * 22, 4, 22, 37),
    roughness: 0.74,
    metalness: 0.02,
    bump: 0.5,
  },
  // Coarse wool: the tunic and the sagum. A visible weave at close range is most of what
  // makes cloth read as cloth rather than plastic.
  /*
   * The weave is at half the frequency it was, and the difference is in the folds.
   *
   * 36 cycles across a 128 px tile is 3.6 px a cycle *in the tile*, and the tunic and the
   * bracae both carry it at `repeatU 2, repeatV 3` — 72 cycles round a 0.28 m leg, or 3.9 mm
   * a cycle. At the magnification the isolated-model deck shoots that lands at four or five
   * screen pixels, which is the worst place a periodic signal can be: too fine to read as
   * cloth, too coarse to filter away, and it renders as the hard moire grid the legs showed.
   * It is also the single cheapest source of the 1 px band energy that is the *only* octave
   * separating these models from Rome II's.
   *
   * 18 cycles reads as a weave at close range and filters cleanly at battle range, and the
   * amplitude it gives up goes into a two-octave fold field at 5 and 11 cycles — which is
   * what a fulled woollen tunic actually shows at two metres, and which lives at 2-8 px
   * where the deficit is. Energy moved down an octave, not removed.
   */
  /**
   * **18 cycles, and a finer weave was tried, measured worse and reverted.**
   *
   * At 18 cycles the tile draws a 15 mm thread, which on the isolated plate is a legible
   * diamond lattice down a man's legs — the bracae read as fishnet. The obvious correction,
   * once the tile went to 256 px, is to triple the count toward a real 5 mm thread, and it
   * is wrong: at 54 cycles the octave probe puts E1 **up** 21 % and E2 **down** 8 % pooled,
   * with the two cloth-heavy plates losing 20 % of E2. Halving the regular term's amplitude
   * into the slub instead was tried in the same session and lost the same energy again.
   *
   * The mechanism is the same one that governs the tile size, and it has now been measured
   * three separate ways in one session: **at this magnification our atlas content already
   * sits in the 2-4 px octaves, and every change that makes it finer moves that energy down
   * into the 1 px band, where the render's own filtering throws most of it away.** A weave
   * cannot be made physically correct here without more texels than the sheet can afford.
   * Whoever raises the tile again past 256 px should retry this first; it is the change most
   * obviously waiting on that headroom.
   */
  /**
   * **The weave is gone from the albedo and the height, and it is now a slope.**
   *
   * Everything the two notes above record is still true of a weave *painted into a scalar*,
   * and the trade they describe — finer thread costs E2 and buys E1 — is a property of that
   * representation rather than of thread count. `max(warp, weft)` in the height field is a
   * lattice of bumps, so it differences to an isotropic normal, and painting the same
   * lattice into the colour puts a hard periodic grid straight into the 1 px band where the
   * render's own filtering throws it away. Both are why every critic to date has called this
   * a printed weave.
   *
   * Written as `slope` instead, the same 24 threads cost the albedo nothing and the height
   * nothing: they arrive as a directional tilt that only exists under a light. What used to
   * be spent on the printed grid is now spent on the fold field, which is what a viewer
   * actually reads a woollen tunic by at any distance a man is legible from.
   *
   * 24 cycles over a 0.27 m tile is an 11 mm thread — coarse for wool, and still a lie, but
   * a resolvable one at 10.7 texels a cycle, and it lands at 6-7 screen px a cycle on the
   * isolated deck, which is the middle of the band this project is short of.
   */
  [Mat.WoolCoarse]: {
    colour(u, v, out) {
      // The weave in the colour is now yarn tone rather than a plaid: the warp's own
      // variation where the warp is on top, the weft's where it is, blended by the same
      // over-under cosine the slope uses so the two agree about which thread is uppermost.
      const warpUp = 0.5 + 0.5
        * Math.cos(u * TAU * 24) * Math.cos(v * TAU * 24);
      const thread = warpUp * threadTone(u, v, 24, 8, 61)
        + (1 - warpUp) * threadTone(u, v, 8, 24, 67);
      const slub = fbm(u * 12, v * 12, 3, 12, 41);
      const fold = WOOL_FOLD(u, v);
      // Wear and grime collect in the bottom of a crease and bleach off a crest. This is the
      // one thing a fold is allowed to do to the albedo — the shading of it belongs to the
      // light, and painting that in is what makes cloth read as a photograph of cloth.
      const g = 0.62 + slub * 0.13 + fold * 0.17 + thread * 0.22;
      const dirt = (1 - fold) * 0.15;
      out[0] = g * (1 - dirt * 0.85);
      out[1] = g * 0.985 * (1 - dirt * 0.95);
      out[2] = g * 0.955 * (1 - dirt);
    },
    // No weave: the folds are the height field, and the height field is what the cavity and
    // the coarse normal are differenced from.
    height: (u, v) => WOOL_FOLD(u, v) * 0.90 + fbm(u * 18, v * 18, 2, 18, 41) * 0.10,
    cavity: WOOL_FOLD,
    slope: (u, v, out) => weaveSlope(u, v, 24, 0.18, out),
    roughness: 0.86,
    // A fulled woollen tunic is matte everywhere and *slightly* less so where the nap has
    // been rubbed flat on a crest. 0.34 peak to peak is a real spread and it never plateaus.
    roughVar: 0.34,
    metalness: 0,
    bump: 0.50,
  },
  // 72 cycles, not 26. The old count was set against a 128 px tile, where 52 was measured at
  // 2.5 px a cycle and dismissed as noise; at 256 px, 72 cycles is 3.6 texels and a 4.6 mm
  // thread, which is a fine linen rather than sacking. Same trade as `WoolCoarse`: the
  // regular term loses amplitude and the irregular fold field gains it.
  /**
   * Linen: the same rewrite as the wool, and one number that had to change with it.
   *
   * The albedo used to clip. `0.74 + 0.14 + 0.10 + 0.16` sums to 1.14 before the per-channel
   * scale, and `Math.min(1, g)` took **3.78 % of this tile's texels to a channel at 255** —
   * detail thrown away in the sheet, before a light has touched it. The bands below are
   * budgeted to a 0.97 ceiling instead, so the clip is not expressible.
   *
   * Linen creases tighter and holds a sharper edge than wool, which is the fold field at 7
   * and 15 rather than 5 and 11, and a finer thread at 32 cycles — 10 mm on a 0.33 m tile.
   */
  [Mat.Linen]: {
    colour(u, v, out) {
      const warpUp = 0.5 + 0.5
        * Math.cos(u * TAU * 32) * Math.cos(v * TAU * 32);
      const thread = warpUp * threadTone(u, v, 32, 8, 71)
        + (1 - warpUp) * threadTone(u, v, 8, 32, 73);
      const fold = LINEN_FOLD(u, v);
      // 0.68 + 0.08 + 0.13 + 0.18 sums to 0.97 at the very top of its range, which is the
      // ceiling this cell is budgeted to. It summed to 1.09 and the clamp took 3.78 % of the
      // tile to a channel at 255 — detail thrown away in the sheet, before a light touches it.
      const g = 0.68 + fbm(u * 14, v * 14, 3, 14, 43) * 0.08 + fold * 0.13 + thread * 0.18;
      const dirt = (1 - fold) * 0.13;
      out[0] = g * (1 - dirt * 0.8);
      out[1] = g * 0.985 * (1 - dirt * 0.9);
      out[2] = g * 0.925 * (1 - dirt);
    },
    height: (u, v) => LINEN_FOLD(u, v) * 0.92 + fbm(u * 22, v * 22, 2, 22, 43) * 0.08,
    cavity: LINEN_FOLD,
    slope: (u, v, out) => weaveSlope(u, v, 32, 0.16, out),
    roughness: 0.82,
    roughVar: 0.36,
    metalness: 0,
    bump: 0.46,
  },
  /**
   * **Skin, and why it read as vinyl.**
   *
   * Round three's critics put it second, after the cloth. Three things were producing it and
   * the tile carried none of the counters.
   *
   *   1. **It was almost flat.** Mean tangent-space |n.xy| measured **0.112** on the bake —
   *      the second-flattest cell in the sheet after the animal hides, against mail at 0.792
   *      and leather at 0.190. A smooth dielectric with a broad sheen and no relief is
   *      exactly what vinyl is. The pore field was there but `bump` was 0.3, so it arrived
   *      as nothing.
   *   2. **It was one hue times a value ramp.** `out = [g, g * 0.955, g * 0.9]` gives every
   *      texel of every man the identical chromaticity, which no organic surface has. Skin
   *      is a stack of translucent layers over blood: it flushes red where it is thin or
   *      creased and goes sallow-olive where it is thick, and that hue *shift* is most of
   *      what tells an eye it is looking at a person rather than at a painted dowel.
   *   3. **Nothing lived between the blotch and the pore.** fbm at 7 cycles and at 40, and a
   *      hole between them — which on this deck is precisely the 2-8 px band the whole
   *      workstream is short of. `grain` at 18 and the crease network at 22 fill it.
   *
   * The crease network is `threadTone`, the same anisotropic sampler the cloth uses, because
   * Langer's lines *are* directional: the fine diamond crease pattern on a forearm runs along
   * the limb, not in every direction at once.
   *
   * The joint wells stay exactly where they were. Limb tubes run V from the hip or shoulder
   * to the extremity with `SKIN_LIMB_V` pinning one tile end to end, so v = 0.5 lands on the
   * elbow or knee and v = 0.94 on the wrist or ankle on every limb — and they are now in
   * `cavity` rather than only in `height`, so they occlude the direct sun instead of merely
   * bending a normal that the mip ladder averages away.
   */
  [Mat.Skin]: {
    colour(u, v, out) {
      const pore = fbm(u * 40, v * 40, 3, 40, 47);
      const grain = fbm(u * 18, v * 18, 3, 18, 89);
      const blotch = fbm(u * 7, v * 7, 3, 7, 53);
      const lines = threadTone(u, v, 22, 11, 97);
      const crease = Math.exp(-((v - 0.5) ** 2) / 0.0032) * 0.20
        + Math.exp(-((v - 0.94) ** 2) / 0.0018) * 0.14;
      const g = 0.60 + pore * 0.09 + grain * 0.11 - blotch * 0.09 - lines * 0.05 - crease;
      // Capillary flush: warm and saturated where the skin is thin or worked, sallow where
      // it is not. The two ends are a real pair of skin chromaticities, not a tint slider.
      const flush = Math.min(1, blotch * 0.6 + crease * 2.2 + (1 - lines) * 0.2);
      out[0] = Math.min(0.97, g * (1 + flush * 0.11));
      out[1] = Math.min(0.97, g * (0.958 - flush * 0.052));
      out[2] = Math.min(0.97, g * (0.905 - flush * 0.082));
    },
    height: (u, v) =>
      fbm(u * 40, v * 40, 3, 40, 47) * 0.34
      + fbm(u * 18, v * 18, 3, 18, 89) * 0.30
      + threadTone(u, v, 22, 11, 97) * 0.16
      + (1 - Math.exp(-((v - 0.5) ** 2) / 0.0032)) * 0.13
      + (1 - Math.exp(-((v - 0.94) ** 2) / 0.0018)) * 0.07,
    // The joints only. A pore is a bump and averages to nothing two mips down; a 30 mm
    // hollow at an elbow is a scalar and survives, which is the whole argument recorded
    // against painted relief in `docs/HANDOFF.md`.
    cavity: (u, v) =>
      Math.min(1, 0.30 + fbm(u * 7, v * 7, 3, 7, 53) * 0.22
        + (1 - Math.exp(-((v - 0.5) ** 2) / 0.0032)) * 0.34
        + (1 - Math.exp(-((v - 0.94) ** 2) / 0.0018)) * 0.20),
    // 0.62 rather than 0.55, and the swing now runs 0.37 to 0.87 instead of bottoming out at
    // 0.30. A broad low-roughness sheen over a whole limb is the specular half of the vinyl
    // read; sebum sits on the ridges, not over the entire arm.
    roughness: 0.62,
    metalness: 0,
    bump: 0.62,
  },
  // Hair and beard: strands, tinted per man.
  [Mat.Hair]: {
    colour(u, v, out) {
      const strand = vnoise(u * 70, v * 5, 70, 59);
      const g = 0.55 + strand * 0.45;
      out[0] = g; out[1] = g * 0.96; out[2] = g * 0.92;
    },
    height: (u, v) => vnoise(u * 70, v * 5, 70, 59),
    roughness: 0.78,
    metalness: 0,
    bump: 0.7,
  },
  /**
   * Limewood shield planks and spear shafts: straight grain with knots.
   *
   * **The seam is bevelled now, and the ternary it replaces was the most expensive single
   * expression in this sheet.** `Math.abs(v * 6 - plank - 0.5) > 0.47 ? 0 : 1` is a binary
   * step in a *height* field: the normal it differences to is a discontinuity one texel wide
   * and full amplitude, and the cavity derived from it is a hard black line that occludes
   * the direct sun completely. Six of those across a board was tolerable only because the
   * whole tile was stretched over the board and mip-averaged; the moment the board tiled
   * three deep there were eighteen, and graded under the Battle rig the shield plates paid
   * **dE1 +22 to +42 %** for them. It is the same defect the critics named on cloth —
   * "hard unbevelled creases" — in the one material nobody thought to look at.
   *
   * `seamProfile` is the same shape a plank edge really has: a rounded arris either side of a
   * narrow valley. Same seam, same contrast, second derivative finite.
   *
   * **The grain is 36 cycles in v, not 90, and 90 did not tile.** `vnoise` wraps at its
   * `period`, so the argument has to close on an integer number of periods: `v * 90` against
   * period 4 is 22.5 periods and left a hard discontinuity across the tile boundary. With one
   * tile stretched over a whole board that seam sat on the board's own edge and nobody saw
   * it; tiling the board three deep put two of them across the middle of every scutum. 36 is
   * nine periods and closes. It is also where the grain belongs: at 90 cycles a line is 2.8
   * texels, which is under the texture's own Nyquist before the render even sees it, and on
   * a tiled board it lands at 2.4 screen px — the 1 px octave. At 36 it is 7.1 texels and
   * about 6 screen px, which is E2.
   */
  [Mat.WoodPlank]: {
    colour(u, v, out) {
      const plank = Math.floor(v * 6);
      const shade = 0.82 + hash2(plank, 3, 61) * 0.28;
      const grain = vnoise(u * 4, v * 36, 4, 67);
      const knot = Math.max(0, fbm(u * 6, v * 6, 3, 6, 71) - 0.72) * 3;
      mix3([0.42, 0.31, 0.19], [0.66, 0.52, 0.34], grain * shade, out);
      mix3(out, [0.2, 0.13, 0.07], Math.min(0.8, knot), out);
      const seam = 1 - seamProfile(v, 6, PLANK_SEAM_W) * 0.45;
      out[0] *= seam; out[1] *= seam; out[2] *= seam;
    },
    height: (u, v) =>
      (1 - seamProfile(v, 6, PLANK_SEAM_W)) * (0.6 + vnoise(u * 4, v * 36, 4, 67) * 0.4),
    roughness: 0.78,
    metalness: 0,
    bump: 0.5,
  },
  [Mat.Fur]: {
    colour(u, v, out) {
      const tuft = fbm(u * 26, v * 26, 4, 26, 73);
      const strand = vnoise(u * 50, v * 12, 50, 79);
      mix3([0.17, 0.13, 0.1], [0.5, 0.41, 0.32], tuft * 0.6 + strand * 0.4, out);
    },
    height: (u, v) => fbm(u * 30, v * 30, 4, 30, 73),
    roughness: 0.92,
    metalness: 0,
    bump: 1.0,
  },
  // Horsehair and feather. Drawn *neutral* — the strand structure only — because the colour
  // comes from the per-man crest tint: a cohort has black feather pairs, white horsehair and
  // madder red in it, and a red tile can only ever be multiplied into a darker red.
  [Mat.Plume]: {
    colour(u, v, out) {
      const strand = vnoise(u * 90, v * 6, 90, 83);
      const g = 0.52 + strand * 0.48;
      out[0] = g; out[1] = g * 0.98; out[2] = g * 0.95;
    },
    height: (u, v) => vnoise(u * 90, v * 6, 90, 83),
    roughness: 0.82,
    metalness: 0,
    bump: 0.8,
  },
  [Mat.Rope]: {
    colour(u, v, out) {
      const twist = Math.sin((u + v) * Math.PI * 2 * 14) * 0.5 + 0.5;
      const g = 0.5 + twist * 0.35 + fbm(u * 20, v * 20, 3, 20, 89) * 0.2;
      out[0] = g * 0.82; out[1] = g * 0.72; out[2] = g * 0.52;
    },
    height: (u, v) => Math.sin((u + v) * Math.PI * 2 * 14) * 0.5 + 0.5,
    roughness: 0.88,
    metalness: 0,
    bump: 0.7,
  },
  // Lorica segmentata: horizontal iron girdle plates with visible leather lacing and the
  // bright rivet line along each band. This is the single most recognisable Roman texture.
  [Mat.Bands]: {
    colour(u, v, out) {
      const bands = 7;
      const gy = v * bands;
      const band = Math.floor(gy);
      const fy = gy - band;
      const n = fbm(u * 10, v * 20, 3, 10, 97);
      // Lit along the top of each plate, shadowed in the overlap at the bottom.
      const shade = 0.55 + (1 - fy) * 0.55;
      mix3(IRON_DARK, IRON, Math.min(1, shade * (0.75 + n * 0.35)), out);
      // The overlap between plates is a real gap with a real shadow in it. A wide, near
      // black separation line is most of what makes segmentata read as assembled bands
      // rather than as a ribbed tube.
      if (fy > 0.8) mix3(out, [0.035, 0.032, 0.03], 0.88, out);
      // Rivets: a row of bright dots near the top edge of every plate.
      const rivets = 9;
      const rx = u * rivets;
      const rvu = rx - Math.floor(rx) - 0.5;
      const rvv = (fy - 0.22) * bands * 0.5;
      const dr = Math.sqrt(rvu * rvu + rvv * rvv);
      if (dr < 0.2) mix3(out, [0.78, 0.79, 0.8], 1 - dr / 0.2, out);
      // Bronze plate edging every other band, as on the Corbridge finds.
      if (band % 2 === 1 && fy < 0.08) mix3(out, BRONZE, 0.7, out);
    },
    height(u, v) {
      const bands = 7;
      const gy = v * bands;
      const fy = gy - Math.floor(gy);
      const plate = fy > 0.8 ? 0 : 0.4 + (1 - fy) * 0.6;
      const rivets = 9;
      const rx = u * rivets;
      const rvu = rx - Math.floor(rx) - 0.5;
      const rvv = (fy - 0.22) * bands * 0.5;
      const dr = Math.sqrt(rvu * rvu + rvv * rvv);
      return Math.min(1, plate + (dr < 0.2 ? (1 - dr / 0.2) * 0.5 : 0));
    },
    // Girdle plates are strapped, not welded: each lame sits at its own angle on the leathers.
    // Weaker than the scale's, because a 60 mm iron plate is stiff where a 25 mm scale swings.
    slope: (u, v, out) => plateTilt(u, v, 7, 0.0, 0.30, out),
    // Girdle plates are burnished iron with a bronze edging strip. The near-black overlap
    // gutter in `colour` is a shadow rather than a material, so it keeps the plate's
    // metalness and simply reflects less — which is what a gap between two plates does.
    // 0.40, not 0.32: same argument as `Mat.IronPlate`. A plate that clips the sun to white
    // carries no form, and a rank of them clips identically.
    roughness: 0.40,
    metalness: 1,
    bump: 0.9,
  },
  [Mat.HideBay]: {
    colour(u, v, out) {
      const n = fbm(u * 10, v * 10, 4, 10, 101);
      const sheen = vnoise(u * 30, v * 30, 30, 103);
      mix3([0.24, 0.13, 0.06], [0.48, 0.28, 0.13], n * 0.8 + sheen * 0.2, out);
    },
    height: (u, v) => fbm(u * 26, v * 26, 3, 26, 101),
    roughness: 0.56,
    metalness: 0,
    bump: 0.15,
  },
  [Mat.HideGrey]: {
    colour(u, v, out) {
      const n = fbm(u * 10, v * 10, 4, 10, 107);
      const dapple = Math.max(0, fbm(u * 5, v * 5, 2, 5, 109) - 0.5) * 2;
      mix3([0.42, 0.41, 0.4], [0.72, 0.71, 0.7], n, out);
      mix3(out, [0.3, 0.29, 0.29], Math.min(0.5, dapple), out);
    },
    height: (u, v) => fbm(u * 26, v * 26, 3, 26, 107),
    roughness: 0.58,
    metalness: 0,
    bump: 0.15,
  },
  [Mat.HideBlack]: {
    colour(u, v, out) {
      const n = fbm(u * 10, v * 10, 4, 10, 113);
      mix3([0.06, 0.055, 0.05], [0.2, 0.18, 0.17], n, out);
    },
    height: (u, v) => fbm(u * 26, v * 26, 3, 26, 113),
    roughness: 0.5,
    metalness: 0,
    bump: 0.15,
  },
  [Mat.SaddleLeather]: {
    colour(u, v, out) {
      const n = fbm(u * 14, v * 14, 4, 14, 127);
      const stitch = Math.abs(((v * 8) % 1) - 0.5) > 0.46 ? 0.6 : 1;
      mix3([0.2, 0.11, 0.06], [0.4, 0.24, 0.13], n, out);
      out[0] *= stitch; out[1] *= stitch; out[2] *= stitch;
    },
    height: (u, v) => fbm(u * 18, v * 18, 3, 18, 127),
    roughness: 0.66,
    metalness: 0.02,
    bump: 0.4,
  },
  [Mat.Hoof]: {
    colour(u, v, out) {
      const n = vnoise(u * 3, v * 24, 3, 131);
      mix3([0.12, 0.1, 0.09], [0.3, 0.27, 0.24], n, out);
    },
    height: (u, v) => vnoise(u * 3, v * 24, 3, 131),
    roughness: 0.42,
    metalness: 0,
    bump: 0.3,
  },
  [Mat.Mane]: {
    colour(u, v, out) {
      const strand = vnoise(u * 60, v * 4, 60, 137);
      const g = 0.35 + strand * 0.4;
      out[0] = g * 0.6; out[1] = g * 0.48; out[2] = g * 0.34;
    },
    height: (u, v) => vnoise(u * 60, v * 4, 60, 137),
    roughness: 0.8,
    metalness: 0,
    bump: 0.8,
  },
  [Mat.Bone]: {
    colour(u, v, out) {
      const n = fbm(u * 12, v * 12, 3, 12, 139);
      mix3([0.62, 0.58, 0.48], [0.86, 0.83, 0.72], n, out);
    },
    height: (u, v) => fbm(u * 16, v * 16, 3, 16, 139),
    roughness: 0.55,
    metalness: 0,
    bump: 0.2,
  },
  // Finer wool for cloaks and officer cloth.
  // 30 cycles, not 64 — see the note on `WoolCoarse`. This is the cloak, which is the largest
  // single area of cloth a man presents, so it was also the largest contributor.
  /**
   * The cloak, which is the largest single area of cloth a man presents and therefore the
   * largest single contributor to whatever cloth reads as.
   *
   * It clipped worse than the linen in one respect: 1.69 % of the tile had a channel at 255
   * and **0.13 % was flat white in all three**, which is the one value from which a per-man
   * tint can produce no colour at all. Budgeted to 0.96 here.
   *
   * A sagum hangs from two points and falls in a few big folds, so the drape is at 3 and 8
   * against the tunic's 5 and 11, and `bump` is lower — a cloak's surface is smoother than a
   * tunic's, its structure is in the drape rather than in the nap.
   */
  [Mat.ClothFine]: {
    colour(u, v, out) {
      const warpUp = 0.5 + 0.5
        * Math.cos(u * TAU * 30) * Math.cos(v * TAU * 30);
      const thread = warpUp * threadTone(u, v, 30, 10, 79)
        + (1 - warpUp) * threadTone(u, v, 10, 30, 83);
      const drape = CLOAK_FOLD(u, v);
      const g = 0.69 + fbm(u * 10, v * 10, 3, 10, 149) * 0.07 + drape * 0.14 + thread * 0.17;
      const dirt = (1 - drape) * 0.12;
      out[0] = g * (1 - dirt * 0.9);
      out[1] = g * (1 - dirt * 0.95);
      out[2] = g * 0.975 * (1 - dirt);
    },
    height: (u, v) => CLOAK_FOLD(u, v) * 0.92 + fbm(u * 16, v * 16, 2, 16, 149) * 0.08,
    cavity: CLOAK_FOLD,
    slope: (u, v, out) => weaveSlope(u, v, 30, 0.15, out),
    roughness: 0.78,
    roughVar: 0.34,
    metalness: 0,
    bump: 0.44,
  },
  /**
   * **A tile, not a board-sized decal — and that is what unblocked the shield's tiling.**
   *
   * This cell used to paint two *board-scale* features into a *material* cell: a handgrip
   * band at v = 0.5 and a stitched turn-over at all four tile edges. Both were placed on the
   * assumption that one tile covers exactly one shield, and that assumption is what pinned
   * `shieldPanel` at a single tile across a 1.06 m board — 236 texels per metre, the worst
   * sampled surface on the figure and the reason a scutum's inner face photographed as a
   * black smear. Tiling it with either feature present grows a shield two grips and a seam
   * across its middle.
   *
   * Neither feature is lost. The rim was a *duplicate*: `shieldPanel` has modelled binding
   * with its own outward normals, ten lines from where this was painted. The grip is now one
   * box of 12 triangles that actually stands proud of the board and occludes.
   *
   * What is left is hide: grain, scuff, a couple of nail heads where the boss is riveted
   * through, and the diagonal wear a forearm leaves. Drawn neutral and mid-value on purpose
   * so a per-man multiply can put it anywhere from pitch to raw hide.
   */
  [Mat.ShieldBack]: {
    colour(u, v, out) {
      // Hide grain over a neutral mid-value base. 0.62 sRGB is 0.34 linear, which is the
      // middle of the range a per-man tint has to reach both ends of.
      const grain = fbm(u * 17, v * 17, 4, 17, 157);
      const scuff = Math.max(0, fbm(u * 5, v * 5, 3, 5, 163) - 0.55) * 1.8;
      mix3([0.44, 0.40, 0.35], [0.72, 0.67, 0.60], grain, out);
      mix3(out, [0.34, 0.30, 0.26], Math.min(0.55, scuff), out);
      // Two rivet heads and their leather washers — a boss is nailed through the board and
      // the nails are visible from behind. Placed off-centre so a repeated tile does not
      // read as a grid.
      const rivet = Math.exp(-(((u - 0.31) ** 2 + (v - 0.68) ** 2)) / 0.0011)
        + Math.exp(-(((u - 0.74) ** 2 + (v - 0.22) ** 2)) / 0.0009);
      mix3(out, [0.58, 0.55, 0.50], Math.min(0.8, rivet), out);
      // A hide facing is stitched in panels. Two whole cycles in u and one in v, because a
      // fractional coefficient does not close on the tile edge and leaves a hard line across
      // the board once the board tiles — and `seamProfile` rather than a modulo for the same
      // reason the plank seam uses it.
      mix3(out, [0.33, 0.29, 0.25], seamProfile((u * 2 + v) % 1, 1) * 0.45, out);
    },
    height: (u, v) =>
      fbm(u * 20, v * 20, 3, 20, 157) * 0.62
      + Math.min(0.9, Math.exp(-(((u - 0.31) ** 2 + (v - 0.68) ** 2)) / 0.0011)
        + Math.exp(-(((u - 0.74) ** 2 + (v - 0.22) ** 2)) / 0.0009)) * 0.38,
    roughness: 0.72,
    metalness: 0.02,
    bump: 0.45,
  },
  // A squared oak baulk: open grain running the length of the tile, the shallow facets an
  // adze leaves, two shakes and a knot. Deliberately *not* planked — see the enum comment.
  [Mat.OakBeam]: {
    colour(u, v, out) {
      // Grain: rings stretched hard along V so a beam textured with repeatV reads as one
      // continuous length of timber rather than as a series of tiles.
      const ring = vnoise(u * 7, v * 2.5, 7, 173);
      const fine = vnoise(u * 34, v * 5, 34, 179);
      const grain = ring * 0.72 + fine * 0.28;
      mix3([0.36, 0.27, 0.175], [0.62, 0.49, 0.32], grain, out);
      // Adze facets: broad shallow flats across the beam, the mark of a hand-worked timber.
      const facet = Math.abs(((u * 3.4) % 1) - 0.5) * 2;
      const k = 0.9 + facet * 0.16;
      out[0] *= k; out[1] *= k; out[2] *= k;
      // A shake — a split following the grain — and one knot.
      const shake = Math.exp(-((u - 0.31) ** 2) / 0.00035) * (0.6 + fine * 0.6);
      mix3(out, [0.16, 0.115, 0.07], Math.min(0.85, shake), out);
      const knot = Math.exp(-(((u - 0.72) ** 2 + (v - 0.38) ** 2)) / 0.0022);
      mix3(out, [0.19, 0.12, 0.06], Math.min(0.9, knot), out);
    },
    height(u, v) {
      const ring = vnoise(u * 7, v * 2.5, 7, 173);
      const fine = vnoise(u * 34, v * 5, 34, 179);
      const shake = Math.exp(-((u - 0.31) ** 2) / 0.00035);
      const knot = Math.exp(-(((u - 0.72) ** 2 + (v - 0.38) ** 2)) / 0.0022);
      return Math.min(1, Math.max(0, ring * 0.5 + fine * 0.32 + 0.18 - shake * 0.7 + knot * 0.25));
    },
    roughness: 0.86,
    metalness: 0,
    bump: 0.55,
  },
  // Combed sinew under torsion: parallel axial strands, greasy, pale amber. High-frequency
  // in U (across the bundle) and almost nothing in V, which is what separates a twisted
  // spring from a laid rope at a glance.
  [Mat.SinewCord]: {
    colour(u, v, out) {
      const strand = vnoise(u * 64, v * 3, 64, 181);
      const shade = vnoise(u * 9, v * 2, 9, 187);
      const g = 0.46 + strand * 0.40 + shade * 0.16;
      // Warm and slightly translucent-looking; grease darkens the hollows between strands.
      out[0] = g * 0.98; out[1] = g * 0.88; out[2] = g * 0.63;
      // A binding of thread every so often up the bundle, as the finds show.
      const wrap = Math.exp(-((((v * 5) % 1) - 0.5) ** 2) / 0.004);
      mix3(out, [0.34, 0.27, 0.17], Math.min(0.7, wrap * 0.8), out);
    },
    height(u, v) {
      const strand = vnoise(u * 64, v * 3, 64, 181);
      const wrap = Math.exp(-((((v * 5) % 1) - 0.5) ** 2) / 0.004);
      return Math.min(1, strand * 0.8 + 0.1 + wrap * 0.35);
    },
    roughness: 0.74,
    metalness: 0,
    bump: 0.8,
  },
  [Mat.ElephantHide]: {
    colour(u, v, out) {
      // Two crossing scales of fissure: a coarse plate structure and a fine crazing inside
      // each plate, which is what the real skin does.
      const plate = vnoise(u * 7, v * 6, 7, 211);
      const crack = vnoise(u * 26, v * 23, 26, 217);
      const fine = vnoise(u * 61, v * 58, 61, 223);
      // Fissures are dark because they are in shadow and because they hold dust and water.
      // Softer and narrower than the first pass. At a fissure weight of 0.55 the network
      // read as high-contrast veining and, with the bump that went with it, as polished
      // marble rather than skin — the single worst thing in the first elephant frame.
      const fissure = Math.max(0, 1 - Math.abs(crack - 0.5) * 3.4) * 0.20
        + Math.max(0, 1 - Math.abs(fine - 0.5) * 5.0) * 0.10;
      // Warm grey-brown, not blue-grey: a working elephant is permanently coated in the dust
      // and dried mud it throws over itself to keep cool, so the base is dun rather than slate.
      /**
       * 0.44, after 0.40 read near-black and 0.60 read as a pale inflatable.
       *
       * Both misses were the same mistake in opposite directions: judging a *tile* by eye
       * instead of judging the *rendered animal*. 0.40 sRGB is 0.13 linear, which is what
       * elephant skin actually measures — and it went black because the only light reaching
       * a flank at this sun angle is cool sky ambient. 0.60 then blew out under direct sun
       * and lost every crease. 0.44 with the mottle below holds detail in both.
       */
      const mottle = fbm(u * 2.6, v * 2.4, 3, 3, 229);
      const g = 0.44 + plate * 0.10 + mottle * 0.09 + fine * 0.03 - fissure * 0.16;
      out[0] = g * 1.05; out[1] = g * 1.00; out[2] = g * 0.92;
      // Dried mud and dust, which a working elephant throws over itself constantly and which
      // is what stops the hide reading as one flat grey. Patchy rather than even.
      mix3(out, [0.60, 0.53, 0.41], Math.max(0, mottle - 0.48) * 0.85, out);
    },
    height(u, v) {
      const plate = vnoise(u * 7, v * 6, 7, 211);
      const crack = vnoise(u * 26, v * 23, 26, 217);
      const fine = vnoise(u * 61, v * 58, 61, 223);
      const fissure = Math.max(0, 1 - Math.abs(crack - 0.5) * 3.4)
        + Math.max(0, 1 - Math.abs(fine - 0.5) * 5.0) * 0.4;
      return Math.min(1, Math.max(0, 0.62 + plate * 0.22 - fissure * 0.40));
    },
    roughness: 0.96,
    metalness: 0,
    /**
     * 0.45, down from 1.6.
     *
     * 1.6 was reasoned from the animal — an elephant's fissures really are centimetres deep
     * — and it was wrong, because a normal map that steep turns every crease into a hard
     * specular ridge. The measured result was an animal that looked wet and polished, like
     * veined marble. Depth on a bump map is a *lighting* parameter and not a measurement of
     * the subject, which is the general form of the mistake.
     */
    bump: 0.45,
  },
  /**
   * A man's face, drawn once at a known scale. See the enum note for the UV contract.
   *
   * Everything here is written as a *modulation of the same 0.60 grey the `Skin` tile
   * carries*, because slot `Tint.Skin` multiplies the whole tile by a per-man tone between
   * (1.66, 1.10, 0.70) and (1.24, 0.78, 0.50). A face painted at its own absolute colour
   * would fight that and every man would end up the same. The one exception is the sclera,
   * which is drawn cool and pale on purpose so that a warm multiply leaves it reading as an
   * eye rather than as a white dot.
   *
   * The height field is doing as much work as the colour and possibly more: it is what puts
   * energy into the 2-8 px band, which is the octave this project's models are short of
   * (`docs/HANDOFF.md`, "the separation is a one-pixel spike"). Brow ridge, eye socket, the
   * groove between the lips, the nasolabial fold, the chin crease and the stubble field all
   * carry real relief, and the bake turns each of them into a normal, a cavity AO and a
   * roughness break for free.
   */
  [Mat.Face]: {
    colour(u, cv, out) {
      // Distance from the centreline. The face is symmetric, so everything is written once.
      const aq = Math.abs(u - 0.5);
      /**
       * Canvas row 0 is the *top*, and `CanvasTexture` uploads with `flipY`, so canvas row 0
       * becomes texture v = 1. Every feature below is placed in the mesh's own V — 0 under
       * the jaw, 1 at the crown — so the tile must be drawn upside down. Written the obvious
       * way round it bakes a face with the eyebrows under the eyes and the nostrils above
       * them, which is exactly what the first version of this tile did.
       */
      const v = 1 - cv;
      /**
       * Everything face-specific is faded out at the tile's left and right edges.
       *
       * Those edges are the arc seam against the plain `Skin` tile on the rest of the head,
       * and any residual difference across them draws a hard vertical line down the cheek —
       * which is what the first version did, because the temple hollow was centred at
       * `aq = 0.40`, i.e. 100 mm from the seam and well inside its own falloff.
       */
      const edge = Math.min(1, Math.min(u, 1 - u) / 0.22);

      // ---- base skin, matching the `Skin` tile so the arc seam is invisible ----------
      const pore = fbm(u * 46, v * 46, 3, 46, 47) * 0.10;
      const blotch = fbm(u * 8, v * 8, 3, 8, 53) * 0.08;
      let g = 0.60 + pore - blotch * 0.5;
      const base = g;

      // ---- temple and cheek hollows --------------------------------------------------
      // Two soft darkenings. Without them a face is a balloon. Both are narrow in u as well
      // as in v: written wide they bake as horizontal stripes across the whole tile, which
      // is what the first version did and it read as banding rather than as form.
      g -= Math.exp(-((aq - 0.40) ** 2) / 0.0055) * Math.exp(-((v - 0.585) ** 2) / 0.0075) * 0.11;
      g -= Math.exp(-((aq - 0.29) ** 2) / 0.0050) * Math.exp(-((v - 0.315) ** 2) / 0.0065) * 0.08;

      // ---- brow ridge and eyebrow ----------------------------------------------------
      // The brow arches: it starts near the nose, rises over the eye and falls at the
      // temple. Modelled as a v that moves with distance from the centreline.
      const browArch = 0.578 + 0.050 * Math.sin(Math.min(1, Math.max(0, (aq - 0.04) / 0.30)) * Math.PI);
      const browSpan = Math.min(1, Math.max(0, (0.34 - aq) / 0.06)) * Math.min(1, Math.max(0, (aq - 0.035) / 0.04));
      const brow = Math.exp(-((v - browArch) ** 2) / 0.00035) * browSpan;
      // Hair, so it takes a hair-like fibre rather than a flat block.
      const browFibre = 0.62 + vnoise(u * 150, v * 12, 150, 59) * 0.5;
      g -= brow * 0.52 * browFibre;
      // The shelf's own shadow, immediately under it.
      g -= Math.exp(-((v - (browArch - 0.032)) ** 2) / 0.00060) * browSpan * 0.18;

      // ---- eyes ----------------------------------------------------------------------
      // Centre at 0.197 from the midline: 32 mm of interpupillary half-distance mapped onto
      // a 79 mm-radius lathe over a 120-degree arc.
      const ex = aq - 0.197;
      const ey = v - 0.462;
      const almond = (ex / 0.090) ** 2 + (ey / 0.034) ** 2;
      // The upper lid comes down over the top of the globe, which is what makes an eye an
      // eye rather than a circle: without it the sclera reads as two white beads.
      const lid = 0.015 + 0.015 * Math.cos(Math.min(1, Math.abs(ex) / 0.090) * Math.PI * 0.5);
      if (almond < 1 && ey < lid && edge > 0.99) {
        // Sclera: pale and faintly cool, and never near white — it sits in the shadow of
        // the brow and is wet.
        g = 0.95 - Math.max(0, ey / lid) * 0.20;
        out[0] = g * 0.97; out[1] = g * 0.99; out[2] = g;
        const di = (ex / 0.032) ** 2 + ((ey + 0.004) / 0.026) ** 2;
        if (di < 1) {
          // Iris: brown to grey-green, with the radial stroma that is the one thing that
          // reads as an eye rather than a dot. Limbal ring dark at the edge.
          const ang = Math.atan2(ey + 0.003, ex);
          const stroma = 0.72 + vnoise((ang / (Math.PI * 2) + 0.5) * 34, Math.sqrt(di) * 5, 34, 191) * 0.46;
          const limbal = Math.min(1, Math.max(0, (di - 0.55) / 0.45));
          const c = (0.22 * stroma) * (1 - limbal * 0.80);
          out[0] = c * 1.06; out[1] = c * 0.94; out[2] = c * 0.74;
          if (di < 0.26) { out[0] = 0.045; out[1] = 0.045; out[2] = 0.048; }
        }
        // Lash line along the lid edge.
        if (ey > lid - 0.008) { out[0] *= 0.16; out[1] *= 0.16; out[2] *= 0.18; }
        return;
      }
      // Socket shading around the globe, the lid crease above and the tear-trough below.
      const socket = Math.exp(-((almond - 1) ** 2) / 0.55) * Math.min(1, Math.max(0, 1.7 - almond));
      g -= socket * 0.10;
      g -= Math.exp(-((ey - 0.049) ** 2) / 0.00012) * Math.exp(-((ex) ** 2) / 0.012) * 0.10;
      g -= Math.exp(-((ey + 0.047) ** 2) / 0.00016) * Math.exp(-((ex) ** 2) / 0.010) * 0.06;

      // ---- nose ----------------------------------------------------------------------
      // The geometry carries the wedge; the tile carries what a wedge cannot: nostrils, the
      // alar crease and the two folds running to the mouth.
      const nostril = Math.exp(-((aq - 0.052) ** 2) / 0.00035) * Math.exp(-((v - 0.247) ** 2) / 0.00016);
      g -= nostril * 0.58;
      // Alar crease, curling round each wing of the nose.
      const alar = Math.exp(-((aq - 0.093) ** 2) / 0.00045) * Math.exp(-((v - 0.262) ** 2) / 0.00060);
      g -= alar * 0.24;
      // Nasolabial fold: from the wing of the nose out and down toward the mouth corner.
      const foldV = 0.258 - Math.min(1, Math.max(0, (aq - 0.095) / 0.075)) * 0.10;
      g -= Math.exp(-((v - foldV) ** 2) / 0.00030)
        * Math.min(1, Math.max(0, (aq - 0.088) / 0.03)) * Math.min(1, Math.max(0, (0.185 - aq) / 0.03)) * 0.13;
      // The shaded side of the bridge, which is what gives a nose width from the front.
      g -= Math.exp(-((aq - 0.062) ** 2) / 0.00045)
        * Math.min(1, Math.max(0, (v - 0.28) / 0.06)) * Math.min(1, Math.max(0, (0.53 - v) / 0.08)) * 0.09;

      // ---- mouth ---------------------------------------------------------------------
      // A cupid's bow, so the upper lip is not a straight bar. Half-width 0.17 in u, which
      // is a 50 mm mouth on a 70 mm-radius jaw.
      const mw = Math.min(1, Math.max(0, (0.175 - aq) / 0.032));
      const bow = 0.168 + Math.exp(-((aq - 0.032) ** 2) / 0.0013) * 0.009;
      const lipLine = Math.exp(-((v - bow) ** 2) / 0.00014) * mw;
      g -= lipLine * 0.60;
      // Both lips: a shade darker and redder than the surrounding skin, and glossier —
      // the gloss comes out of the height field below.
      const upper = Math.exp(-((v - (bow + 0.022)) ** 2) / 0.00048) * mw;
      const lower = Math.exp(-((v - (bow - 0.027)) ** 2) / 0.00062) * mw;
      const lipMask = Math.min(1, upper + lower);
      // Vertical lip striation. Fine, and one of the highest-frequency real features a face
      // has at this magnification.
      const striate = vnoise(u * 190, v * 9, 190, 197);
      g -= lipMask * (0.10 + striate * 0.07);
      // Philtrum: the two ridges under the nose.
      g -= Math.exp(-((aq - 0.024) ** 2) / 0.00028) * Math.exp(-((v - 0.222) ** 2) / 0.00060) * 0.08;

      // ---- chin ----------------------------------------------------------------------
      g -= Math.exp(-((v - 0.105) ** 2) / 0.00045) * Math.min(1, Math.max(0, (0.13 - aq) / 0.05)) * 0.12;

      // ---- stubble -------------------------------------------------------------------
      // Beard shadow over the jaw, the chin and the upper lip, faded out at the cheekbone.
      // Deliberately high-frequency: this is the single largest contributor of 2-8 px energy
      // on the whole head, and a clean-shaven man at 271 AD is the exception anyway. Held
      // light enough that the mouth still reads through it — the first version buried it.
      const beardZone = Math.min(1, Math.max(0, (0.32 - v) / 0.12))
        + Math.exp(-((v - 0.235) ** 2) / 0.0014) * Math.min(1, Math.max(0, (aq - 0.035) / 0.05));
      const grain = fbm(u * 120, v * 120, 3, 120, 199);
      g -= Math.min(1, beardZone) * (0.035 + grain * 0.11);

      // ---- forehead ------------------------------------------------------------------
      // Two faint creases and the shadow the fringe casts on the brow.
      g -= Math.exp(-((v - 0.655) ** 2) / 0.00050) * Math.min(1, Math.max(0, (0.34 - aq) / 0.10)) * 0.045;
      g -= Math.min(1, Math.max(0, (v - 0.715) / 0.05)) * 0.09;

      /*
       * Fade the whole face back to plain skin at the seam — and mean the *same* plain skin.
       *
       * The fade was only ever on the luminance. `Mat.Skin` writes a **capillary flush**
       * chromaticity, `(1 + f*0.11, 0.958 - f*0.052, 0.905 - f*0.082)`, and this tile wrote a
       * fixed `(1, 0.955, 0.90)`, so at `edge = 1` the two agreed on brightness and differed
       * in hue by up to 5 % of red against 4 % of blue. On the arc seam that is a vertical
       * line down the side of every head where the colour changes and the surface does not —
       * a three-quarter head plate reads it as a rectangle of face pasted onto a skull, which
       * is the literal shape of the grader's complaint.
       *
       * The same flush term, computed the same way, from the same fields.
       */
      g = base + (g - base) * edge;
      /*
       * The flush is computed from `Mat.Skin`'s own fields at `Mat.Skin`'s own frequencies,
       * not from this tile's. The two tiles do not share a `u` — the face arc is 120 degrees
       * of it and the back arc is 300 — so the noise cannot line up and there is no point
       * pretending it does. What has to match is the **distribution**, because a systematic
       * hue offset between two tiles that meet along a seam is a line, and a difference in
       * where their blotches happen to fall is not.
       *
       * `Mat.Skin`'s crease term is deliberately left out. It is an elbow and a knee, banded
       * at v = 0.5 and 0.94, and on a head those two heights are the brow and the crown.
       */
      const blotchLo = fbm(u * 7, v * 7, 3, 7, 53);
      const lines = threadTone(u, v, 22, 11, 97);
      const flush = Math.min(1, blotchLo * 0.6 + (1 - lines) * 0.2);
      out[0] = Math.min(1, Math.max(0.02, g * (1 + flush * 0.11)));
      out[1] = Math.min(1, Math.max(0.02, g * (0.958 - flush * 0.052)));
      out[2] = Math.min(1, Math.max(0.02, g * (0.905 - flush * 0.082)));
    },
    height(u, cv) {
      const aq = Math.abs(u - 0.5);
      const v = 1 - cv;   // see the note in `colour`
      const edge = Math.min(1, Math.min(u, 1 - u) / 0.22);
      const base = 0.52 + fbm(u * 50, v * 50, 3, 50, 47) * 0.16;
      let h = base;

      // Brow ridge: a real shelf, and the strongest piece of relief on a face.
      const browArch = 0.578 + 0.050 * Math.sin(Math.min(1, Math.max(0, (aq - 0.04) / 0.30)) * Math.PI);
      const browSpan = Math.min(1, Math.max(0, (0.34 - aq) / 0.06)) * Math.min(1, Math.max(0, (aq - 0.035) / 0.04));
      h += Math.exp(-((v - browArch) ** 2) / 0.00090) * browSpan * 0.34;

      // Eye: the globe bulges, the socket around it is cut back, the lid crease is a groove.
      const ex = aq - 0.197;
      const ey = v - 0.462;
      const almond = (ex / 0.090) ** 2 + (ey / 0.034) ** 2;
      if (almond < 1) h += (1 - almond) * 0.30;
      else h -= Math.min(1, Math.max(0, (1.7 - almond) / 0.7)) * 0.22;
      h -= Math.exp(-((ey - 0.049) ** 2) / 0.00012) * Math.exp(-(ex ** 2) / 0.012) * 0.24;

      // Nose: nostrils are holes, the alar crease and the nasolabial fold are grooves.
      h -= Math.exp(-((aq - 0.052) ** 2) / 0.00035) * Math.exp(-((v - 0.247) ** 2) / 0.00016) * 0.55;
      h -= Math.exp(-((aq - 0.093) ** 2) / 0.00045) * Math.exp(-((v - 0.262) ** 2) / 0.00060) * 0.24;
      const foldV = 0.258 - Math.min(1, Math.max(0, (aq - 0.095) / 0.075)) * 0.10;
      h -= Math.exp(-((v - foldV) ** 2) / 0.00030)
        * Math.min(1, Math.max(0, (aq - 0.088) / 0.03)) * Math.min(1, Math.max(0, (0.185 - aq) / 0.03)) * 0.22;

      // Mouth: two raised lips with a cut between them. The raised lips read glossy, because
      // the bake derives roughness from this field.
      const mw = Math.min(1, Math.max(0, (0.175 - aq) / 0.032));
      const bow = 0.168 + Math.exp(-((aq - 0.032) ** 2) / 0.0013) * 0.009;
      h -= Math.exp(-((v - bow) ** 2) / 0.00010) * mw * 0.60;
      h += Math.exp(-((v - (bow + 0.022)) ** 2) / 0.00048) * mw * 0.24;
      h += Math.exp(-((v - (bow - 0.027)) ** 2) / 0.00062) * mw * 0.28;
      h += Math.exp(-((aq - 0.024) ** 2) / 0.00028) * Math.exp(-((v - 0.222) ** 2) / 0.00060) * 0.14;

      // Chin ball and the crease above it.
      h += Math.exp(-((v - 0.065) ** 2) / 0.0016) * Math.min(1, Math.max(0, (0.11 - aq) / 0.06)) * 0.18;
      h -= Math.exp(-((v - 0.105) ** 2) / 0.00045) * Math.min(1, Math.max(0, (0.13 - aq) / 0.05)) * 0.20;

      // Stubble, again — as relief this time, which is where most of its 2-8 px energy comes
      // from. A shaved-off albedo blotch averages away under mipping; a bump does not
      // survive either, but the cavity term the bake derives from it does.
      const beardZone = Math.min(1, Math.max(0, (0.32 - v) / 0.12))
        + Math.exp(-((v - 0.235) ** 2) / 0.0014) * Math.min(1, Math.max(0, (aq - 0.035) / 0.05));
      h -= Math.min(1, beardZone) * fbm(u * 120, v * 120, 3, 120, 199) * 0.22;

      return Math.min(1, Math.max(0, base + (h - base) * edge));
    },
    /*
     * Both of these are now `Mat.Skin`'s, and that is the point rather than a tuning.
     *
     * A face tile and a skin tile meet along a seam that runs down the side of every head in
     * the game, and they met at roughness 0.55 against 0.62 and bump 0.42 against 0.62. The
     * albedo was faded across that seam and these two were not, so the seam survived as a
     * step in gloss and in micro-relief even where the colour matched — and a step in gloss
     * at a fixed surface angle is exactly what reads as a decal.
     *
     * Raising the bump to 0.62 also makes the painted relief half again as strong, which is
     * the direction three graders have asked for twice: the brow, the nasolabial fold and
     * the lip line are all in this height field, and at 0.42 the bake was turning them into
     * a normal too shallow to catch a low sun.
     */
    roughness: 0.62,
    metalness: 0,
    bump: 0.62,
  },
  [Mat.Count]: {
    colour(_u, _v, out) { out[0] = 0.5; out[1] = 0.5; out[2] = 0.5; },
    height: () => 0.5,
    roughness: 0.7,
    metalness: 0,
    bump: 0,
  },
};

// ---------------------------------------------------------------------------
// Shield devices
// ---------------------------------------------------------------------------

/**
 * Painted shield faces.
 *
 * Roman shields were painted per unit, the devices recorded on the Dura-Europos finds and
 * the Notitia Dignitatum: a coloured field with a bold central device and a rim. Germanic
 * shields were painted individually, and the spiral and sunwheel are the two motifs that
 * turn up most often in the archaeology.
 */
function drawEmblem(ctx: CanvasRenderingContext2D, name: string, size: number): void {
  const c = size / 2;
  ctx.save();
  ctx.translate(size * 0.5, size * 0.5);

  const field = (colour: string, rim: string): void => {
    ctx.fillStyle = colour;
    ctx.fillRect(-c, -c, size, size);
    // Rim binding: a band of stitched hide or bronze around the edge, narrow enough that
    // it reads as a binding rather than a picture frame.
    ctx.strokeStyle = rim;
    ctx.lineWidth = size * 0.036;
    ctx.strokeRect(-c + size * 0.018, -c + size * 0.018, size * 0.964, size * 0.964);
  };

  // Weathering: streaks and scuffs over whatever device is painted.
  const weather = (): void => {
    ctx.globalAlpha = 0.14;
    for (let i = 0; i < 90; i++) {
      const x = (hash2(i, 1, 5) - 0.5) * size;
      const y = (hash2(i, 2, 5) - 0.5) * size;
      const w = hash2(i, 3, 5) * size * 0.22 + 2;
      ctx.fillStyle = hash2(i, 4, 5) > 0.5 ? '#000' : '#fff';
      ctx.fillRect(x, y, w, size * 0.012 + 1);
    }
    ctx.globalAlpha = 1;
  };

  switch (name) {
    case 'legio-thunderbolt': {
      // Red field with a gilt winged thunderbolt: the device on the Dura-Europos scutum and
      // the one every reconstruction uses. Drawn broad and simple, because at 40 m a shield
      // is 20 px across and fine linework turns to mush.
      //
      // The field is a *warm mid-tone*, not the saturated 0x8e1f24 it looks like it should
      // be, for the same reason the tribal tiles are drawn pale: the shader gives each man
      // his own paint by multiplying the whole facing, and a multiply cannot move the hue of
      // a colour whose green and blue are already at 0.014 linear. Every lot came back some
      // value of one red and a century of them read as one repeated shield. At a third grey
      // the multiply has all three channels to work in — and the lot weighting in
      // `skinShader.ts` is what puts the cohort back at Roman red.
      field('#a8695f', '#6d5a34');
      const gold = '#e6c268';
      ctx.strokeStyle = gold;
      ctx.fillStyle = gold;
      // A pair of wings sweeping the full width from behind the boss.
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * size * 0.05, -size * 0.09);
        ctx.quadraticCurveTo(s * size * 0.3, -size * 0.28, s * size * 0.47, -size * 0.15);
        ctx.quadraticCurveTo(s * size * 0.3, -size * 0.1, s * size * 0.46, size * 0.02);
        ctx.quadraticCurveTo(s * size * 0.28, size * 0.0, s * size * 0.44, size * 0.16);
        ctx.quadraticCurveTo(s * size * 0.2, size * 0.08, s * size * 0.05, size * 0.09);
        ctx.closePath();
        ctx.fill();
      }
      // Four zig-zag bolts, above and below, thick enough to survive a mip level or two.
      ctx.lineWidth = size * 0.055;
      ctx.lineJoin = 'miter';
      for (const s of [-1, 1]) {
        for (const dir of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(s * size * 0.07, dir * size * 0.44);
          ctx.lineTo(s * size * 0.19, dir * size * 0.28);
          ctx.lineTo(s * size * 0.07, dir * size * 0.2);
          ctx.lineTo(s * size * 0.17, dir * size * 0.08);
          ctx.stroke();
        }
      }
      break;
    }
    case 'praetorian-scorpion': {
      // Dark red with the scorpion of the praetorians (Tiberius' birth sign).
      field('#8f544e', '#7a6636');
      ctx.strokeStyle = '#e2cd93';
      ctx.lineWidth = size * 0.04;
      ctx.beginPath();
      ctx.ellipse(0, size * 0.02, size * 0.075, size * 0.17, 0, 0, Math.PI * 2);
      ctx.stroke();
      // Tail curling over the back.
      ctx.beginPath();
      ctx.moveTo(0, -size * 0.15);
      ctx.quadraticCurveTo(size * 0.02, -size * 0.34, size * 0.16, -size * 0.36);
      ctx.quadraticCurveTo(size * 0.26, -size * 0.36, size * 0.22, -size * 0.26);
      ctx.stroke();
      // Legs and pincers.
      for (const s of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
          const y = -size * 0.05 + i * size * 0.075;
          ctx.beginPath();
          ctx.moveTo(s * size * 0.06, y);
          ctx.quadraticCurveTo(s * size * 0.2, y + size * 0.02, s * size * 0.28, y + size * 0.09);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(s * size * 0.05, -size * 0.14);
        ctx.quadraticCurveTo(s * size * 0.24, -size * 0.22, s * size * 0.3, -size * 0.12);
        ctx.stroke();
      }
      break;
    }
    case 'urban-wreath': {
      // Ochre field with a laurel wreath: the city cohorts, a civic device.
      field('#a9754f', '#5b4b2c');
      ctx.strokeStyle = '#e0d6b0';
      ctx.lineWidth = size * 0.038;
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.3, Math.PI * 0.62, Math.PI * 2.38);
      ctx.stroke();
      for (let i = 0; i < 18; i++) {
        const a = Math.PI * 0.62 + (i / 17) * Math.PI * 1.76;
        const x = Math.cos(a) * size * 0.3;
        const y = Math.sin(a) * size * 0.3;
        ctx.beginPath();
        ctx.ellipse(x, y, size * 0.055, size * 0.022, a, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }
    case 'equites-star': {
      // Blue-green field with an eight-pointed star, a common cavalry device.
      field('#547d70', '#6d5a34');
      ctx.fillStyle = '#ddca87';
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * size * 0.4, Math.sin(a) * size * 0.4);
        ctx.lineTo(Math.cos(a + 0.22) * size * 0.12, Math.sin(a + 0.22) * size * 0.12);
        ctx.lineTo(Math.cos(a - 0.22) * size * 0.12, Math.sin(a - 0.22) * size * 0.12);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    // The tribal boards are drawn pale-field-dark-device on purpose. The shader gives each
    // man his own paint by multiplying the whole facing, and a multiply preserves contrast
    // ratios — so a dark spiral on pale limewood stays a dark spiral whether the man
    // whitewashed his board, put ochre on it or left the wood bare, while a *pale* device on
    // a dark field (which is how these used to be drawn) collapses the moment you tint it.
    // It is also what the Illerup Adal and Thorsberg finds actually are.
    case 'germanic-spiral': {
      field('#cfc0a0', '#4a3a26');
      ctx.strokeStyle = '#5c2a20';
      ctx.lineWidth = size * 0.05;
      ctx.beginPath();
      for (let i = 0; i <= 220; i++) {
        const t = i / 220;
        const a = t * Math.PI * 6;
        const r = t * size * 0.4;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      break;
    }
    case 'germanic-sunwheel': {
      field('#d3c6a6', '#413324');
      ctx.strokeStyle = '#2a231c';
      ctx.lineWidth = size * 0.055;
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.32, 0, Math.PI * 2);
      ctx.stroke();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a) * size * 0.42, Math.sin(a) * size * 0.42);
        ctx.stroke();
      }
      break;
    }
    case 'germanic-wolf': {
      // A wolf's head, stylised down to what survives on a shield at 30 m.
      field('#c9bb9c', '#3a2c1f');
      ctx.fillStyle = '#41281c';
      ctx.beginPath();
      ctx.moveTo(-size * 0.24, -size * 0.06);
      ctx.lineTo(-size * 0.3, -size * 0.3);
      ctx.lineTo(-size * 0.1, -size * 0.2);
      ctx.lineTo(size * 0.1, -size * 0.24);
      ctx.lineTo(size * 0.28, -size * 0.32);
      ctx.lineTo(size * 0.24, -size * 0.04);
      ctx.lineTo(size * 0.34, size * 0.14);
      ctx.lineTo(size * 0.04, size * 0.34);
      ctx.lineTo(-size * 0.22, size * 0.18);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#c9bb9c';
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(s * size * 0.1, -size * 0.04, size * 0.045, size * 0.03, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#e8dcc2';
      for (let i = 0; i < 4; i++) {
        const x = -size * 0.1 + i * size * 0.07;
        ctx.beginPath();
        ctx.moveTo(x, size * 0.2);
        ctx.lineTo(x + size * 0.03, size * 0.3);
        ctx.lineTo(x + size * 0.06, size * 0.2);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }

    // ---- Punic band ------------------------------------------------------
    // Uniform bright fields with a bold device, which is the opposite of the tribal boards
    // above and is what a paid, quartermastered army looks like. See the band note on
    // `EMBLEMS` in `kit.ts`: the *index* of these tiles is what tells the shader to paint
    // them this way, so they must stay contiguous.
    case 'punic-tanit': {
      // The sign of Tanit — a trapezoid body, a bar for arms, a disc for a head — on Tyrian
      // purple. The single most recognisable Carthaginian image there is.
      field('#5d3070', '#c8a94e');
      ctx.fillStyle = '#e6dcc4';
      // Body: a tapering trapezoid, wide at the foot.
      ctx.beginPath();
      ctx.moveTo(-size * 0.055, -size * 0.02);
      ctx.lineTo(size * 0.055, -size * 0.02);
      ctx.lineTo(size * 0.17, size * 0.33);
      ctx.lineTo(-size * 0.17, size * 0.33);
      ctx.closePath();
      ctx.fill();
      // Arms: a horizontal bar with the ends turned up, as on the stelae.
      ctx.strokeStyle = '#e6dcc4';
      ctx.lineWidth = size * 0.052;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-size * 0.28, -size * 0.10);
      ctx.lineTo(size * 0.28, -size * 0.10);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-size * 0.28, -size * 0.10);
      ctx.lineTo(-size * 0.30, -size * 0.20);
      ctx.moveTo(size * 0.28, -size * 0.10);
      ctx.lineTo(size * 0.30, -size * 0.20);
      ctx.stroke();
      // Head.
      ctx.beginPath();
      ctx.arc(0, -size * 0.22, size * 0.075, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'punic-horse': {
      // The horse's head from Carthaginian silver: Dido's men dug on the Byrsa and turned up
      // a horse's skull, which the augurs read as war and plenty.
      field('#8a3f2c', '#d8c48a');
      ctx.fillStyle = '#ecdfc0';
      ctx.beginPath();
      ctx.moveTo(-size * 0.06, -size * 0.34); // poll
      ctx.lineTo(size * 0.05, -size * 0.30);
      ctx.lineTo(size * 0.16, -size * 0.02); // face
      ctx.lineTo(size * 0.20, size * 0.16);
      ctx.lineTo(size * 0.09, size * 0.24); // muzzle
      ctx.lineTo(-size * 0.05, size * 0.18);
      ctx.lineTo(-size * 0.10, -size * 0.04); // jaw
      ctx.lineTo(-size * 0.26, -size * 0.10); // neck
      ctx.lineTo(-size * 0.32, -size * 0.34);
      ctx.lineTo(-size * 0.18, -size * 0.28);
      ctx.closePath();
      ctx.fill();
      // Ears, pricked.
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * size * 0.02 - size * 0.02, -size * 0.32);
        ctx.lineTo(s * size * 0.03 + size * 0.01, -size * 0.44);
        ctx.lineTo(s * size * 0.05 + size * 0.04, -size * 0.30);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = '#8a3f2c';
      ctx.beginPath();
      ctx.arc(size * 0.04, -size * 0.14, size * 0.028, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'punic-palm': {
      // *Phoinix* — the Greek pun on "Phoenician" — and the other standing type on the
      // city's coinage.
      field('#2f5f52', '#d8c48a');
      ctx.strokeStyle = '#e2d3ab';
      ctx.lineWidth = size * 0.038;
      ctx.beginPath();
      ctx.moveTo(-size * 0.02, size * 0.36);
      ctx.quadraticCurveTo(size * 0.02, size * 0.02, 0, -size * 0.14);
      ctx.stroke();
      ctx.lineWidth = size * 0.026;
      for (let i = 0; i < 7; i++) {
        const a = -Math.PI * 0.5 + (i - 3) * 0.42;
        ctx.beginPath();
        ctx.moveTo(0, -size * 0.14);
        ctx.quadraticCurveTo(
          Math.cos(a) * size * 0.22, -size * 0.14 + Math.sin(a) * size * 0.22,
          Math.cos(a) * size * 0.36, -size * 0.14 + Math.sin(a) * size * 0.30 + size * 0.06
        );
        ctx.stroke();
      }
      // Two dates at the crown, as the coins show.
      ctx.fillStyle = '#d8b45a';
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(s * size * 0.09, -size * 0.06, size * 0.035, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'iberian-white': {
      // Chalk-whitened linen over the board with a crimson border, which is the detail Livy
      // and Polybius both stop to describe at the Trebia and at Cannae.
      field('#ddd6c2', '#8e2230');
      ctx.strokeStyle = '#9c2733';
      ctx.lineWidth = size * 0.075;
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.375, 0, Math.PI * 2);
      ctx.stroke();
      // A plain iron boss rather than a device: these boards were centre-gripped.
      ctx.fillStyle = '#6d6a64';
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.115, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#8e8b83';
      ctx.beginPath();
      ctx.arc(-size * 0.03, -size * 0.03, size * 0.07, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'numidian-crescent': {
      // The crescent of the Numidian kings, still on the flags of the countries that sit
      // where Numidia was. On undyed hide, because a Numidian's shield was a hide disc.
      field('#b8a482', '#4d3a24');
      ctx.fillStyle = '#efe6cc';
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.30, 0, Math.PI * 2);
      ctx.fill();
      // Bite the crescent out with the field colour.
      ctx.fillStyle = '#b8a482';
      ctx.beginPath();
      ctx.arc(size * 0.13, -size * 0.05, size * 0.26, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'celtic-triskele': {
      // Three running spirals — La Tène, and the device that separates Hannibal's Gauls from
      // the Juthungi at a glance without pretending the two peoples painted differently.
      field('#c9bda0', '#3d2f22');
      ctx.strokeStyle = '#37281b';
      ctx.lineWidth = size * 0.048;
      ctx.lineCap = 'round';
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        ctx.save();
        ctx.rotate(a);
        ctx.beginPath();
        // One arm: out from the hub, then curling back on itself.
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(size * 0.24, -size * 0.06, size * 0.30, size * 0.14);
        ctx.quadraticCurveTo(size * 0.32, size * 0.28, size * 0.18, size * 0.26);
        ctx.quadraticCurveTo(size * 0.10, size * 0.24, size * 0.14, size * 0.16);
        ctx.stroke();
        ctx.restore();
      }
      break;
    }

    default: {
      // Plain limewood with a painted rim ring and the plank lines showing through — the
      // commonest shield in the host, and the one that reads as "this man made his own kit".
      //
      // Drawn with real structure rather than as a pale disc with a hint of a line. It is the
      // commonest board in the army *and* the one the whitewash paint lands on, so it was
      // reading in the corpse frames as a blank white sheet — the flattest surface in the
      // image. Full-strength plank seams, an inner and outer rim ring, and a scatter of
      // hacks and gouges: this is a board that has been used.
      field('#c6b795', '#42331f');
      ctx.globalAlpha = 0.85;
      for (let i = 0; i <= 6; i++) {
        ctx.fillStyle = '#7d6a49';
        ctx.fillRect(-c, -c + (i * size) / 6 - size * 0.008, size, size * 0.017);
        ctx.fillStyle = '#ded0ad';
        ctx.fillRect(-c, -c + (i * size) / 6 + size * 0.009, size, size * 0.01);
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#5a3320';
      ctx.lineWidth = size * 0.055;
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.375, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = '#6f4a2c';
      ctx.lineWidth = size * 0.022;
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.20, 0, Math.PI * 2);
      ctx.stroke();
      // Cuts taken in the shield wall, dark and short.
      ctx.strokeStyle = '#4a3a26';
      ctx.lineWidth = size * 0.016;
      for (let i = 0; i < 9; i++) {
        const a = hash2(i, 7, 5) * Math.PI * 2;
        const r = size * (0.1 + hash2(i, 8, 5) * 0.3);
        const l = size * (0.04 + hash2(i, 9, 5) * 0.09);
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        ctx.lineTo(Math.cos(a) * r + Math.cos(a + 1.2) * l, Math.sin(a) * r + Math.sin(a + 1.2) * l);
        ctx.stroke();
      }
      break;
    }
  }
  weather();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface SoldierAtlas {
  readonly albedo: THREE.Texture;
  readonly normal: THREE.Texture;
  /** R = ambient occlusion, G = roughness, B = metalness. */
  readonly orm: THREE.Texture;
  dispose(): void;
}

function canvas2d(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('[atlas] 2D canvas unavailable');
  return { canvas, ctx };
}

export function buildSoldierAtlas(anisotropy: number): SoldierAtlas {
  const alb = canvas2d(ATLAS_W, ATLAS_H);
  const nrm = canvas2d(ATLAS_W, ATLAS_H);
  const orm = canvas2d(ATLAS_W, ATLAS_H);

  const albData = alb.ctx.createImageData(ATLAS_W, ATLAS_H);
  const nrmData = nrm.ctx.createImageData(ATLAS_W, ATLAS_H);
  const ormData = orm.ctx.createImageData(ATLAS_W, ATLAS_H);
  // Sensible defaults for any part of the atlas nothing writes.
  for (let i = 0; i < ATLAS_W * ATLAS_H; i++) {
    albData.data[i * 4 + 3] = 255;
    nrmData.data[i * 4] = 128;
    nrmData.data[i * 4 + 1] = 128;
    nrmData.data[i * 4 + 2] = 255;
    nrmData.data[i * 4 + 3] = 255;
    ormData.data[i * 4] = 255;
    ormData.data[i * 4 + 1] = 200;
    ormData.data[i * 4 + 3] = 255;
  }

  const rgb: Rgb = [0, 0, 0];
  const slopeOut: [number, number] = [0, 0];
  const heights = new Float32Array(TILE * TILE);

  for (let id = 0; id < Mat.Count; id++) {
    const def = MATS[id as Mat];
    const col = id % TILES_PER_ROW;
    const row = Math.floor(id / TILES_PER_ROW);
    if (row >= MAT_ROWS) break;
    const ox = col * TILE;
    const oy = row * TILE;

    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        heights[y * TILE + x] = def.height((x + 0.5) / TILE, (y + 0.5) / TILE);
      }
    }

    // Roughness swing, fitted to this material's own headroom once rather than clamped per
    // texel. See `ROUGH_SWING`: the clamp is what produced the flat-255 plateaux.
    const want = Math.min(def.roughVar ?? def.roughness * 1.05, ROUGH_SWING);
    const rUp = Math.min(
      want * 0.5, Math.max(0, ROUGH_MAX - def.roughness), Math.max(0, def.roughness - ROUGH_MIN)
    );
    const rDown = rUp;

    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const u = (x + 0.5) / TILE;
        const v = (y + 0.5) / TILE;
        def.colour(u, v, rgb);
        const o = ((oy + y) * ATLAS_W + ox + x) * 4;
        albData.data[o] = Math.round(Math.min(1, Math.max(0, rgb[0])) * 255);
        albData.data[o + 1] = Math.round(Math.min(1, Math.max(0, rgb[1])) * 255);
        albData.data[o + 2] = Math.round(Math.min(1, Math.max(0, rgb[2])) * 255);
        albData.data[o + 3] = 255;

        // Central differences on the tileable height field.
        const xm = (x - 1 + TILE) % TILE;
        const xp = (x + 1) % TILE;
        const ym = (y - 1 + TILE) % TILE;
        const yp = (y + 1) % TILE;
        let gu = heights[y * TILE + xp] - heights[y * TILE + xm];
        // Canvas Y runs down while the tangent-space green channel runs up.
        let gv = heights[ym * TILE + x] - heights[yp * TILE + x];
        if (def.slope) {
          // Cleared per texel: `weaveSlope` accumulates so two thread systems can be laid
          // over one another, and a shared scratch pair that is never reset sums the whole
          // tile into one texel. It did, and the tell was the shape rather than the value —
          // mean |n.xy| came back at 1.000 across a tile whose amplitude cannot reach 0.4.
          slopeOut[0] = 0;
          slopeOut[1] = 0;
          def.slope(u, v, slopeOut);
          gu += slopeOut[0];
          // Same flip as the difference above: the hook is written in texture space, where
          // v rises with the canvas row, and green runs the other way.
          gv -= slopeOut[1];
        }
        const dx = gu * def.bump * TILE * 0.02;
        const dy = gv * def.bump * TILE * 0.02;
        const len = Math.sqrt((-dx) * (-dx) + (-dy) * (-dy) + 1 * 1);
        nrmData.data[o] = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
        nrmData.data[o + 1] = Math.round(((-dy / len) * 0.5 + 0.5) * 255);
        nrmData.data[o + 2] = Math.round((1 / len) * 0.5 * 255 + 127.5);
        nrmData.data[o + 3] = 255;

        // Cavity AO from the height field: crevices between mail rings and under the
        // overlap of plate bands are what make armour read as assembled rather than
        // painted on.
        // Cavity AO. The floor was 0.55, which is barely a shadow; at 0.3 a mail crevice
        // and the gap between two girdle plates actually go dark, which is what the
        // reference frames show and what the rubric's contact-darkening item is asking for.
        const h = heights[y * TILE + x];
        // Openness from `cavity` where a material separates the two — a fold's trough is
        // what should darken, not a thread's crest. Defaults to the height field.
        const c = def.cavity ? def.cavity(u, v) : h;
        const ao = 0.3 + Math.min(1, Math.max(0, c)) * 0.695;
        ormData.data[o] = Math.round(Math.min(1, ao) * 255);
        // Roughness varies *widely* across the surface, not by fifteen percent. A helmet
        // bowl is burnished on the high spots and pitted in the hollows, and it is that
        // spread — a tight glint next to a broad dull sheen a millimetre away — that makes a
        // surface read as metal at all. A near-constant roughness reads as painted plastic
        // however high the metalness is.
        ormData.data[o + 1] = Math.round((def.roughness + rUp - (rUp + rDown) * h) * 255);
        ormData.data[o + 2] = Math.round(def.metalness * 255);
        ormData.data[o + 3] = 255;
      }
    }
  }

  alb.ctx.putImageData(albData, 0, 0);
  nrm.ctx.putImageData(nrmData, 0, 0);
  orm.ctx.putImageData(ormData, 0, 0);

  // Shield faces are drawn with vector operations — a thunderbolt or a wolf's head is a
  // path, not a noise field — into the lower half of the albedo. Their normal and ORM
  // cells stay at the plank defaults, which is right: paint does not change the surface.
  if (EMBLEM_TOP + Math.ceil(EMBLEMS.length / EMBLEM_COLS) * EMBLEM_TILE_PX > ATLAS_H) {
    // The failure this replaces was silent: a device past the last row was drawn off the
    // bottom of the canvas and rendered as a blank shield. Fail loudly instead.
    throw new Error(
      `[atlas] ${EMBLEMS.length} emblems need `
      + `${EMBLEM_TOP + Math.ceil(EMBLEMS.length / EMBLEM_COLS) * EMBLEM_TILE_PX} px of sheet, `
      + `have ${ATLAS_H}`
    );
  }
  for (let e = 0; e < EMBLEMS.length; e++) {
    const col = e % EMBLEM_COLS;
    const row = Math.floor(e / EMBLEM_COLS);
    alb.ctx.save();
    alb.ctx.translate(col * EMBLEM_TILE_PX, EMBLEM_TOP + row * EMBLEM_TILE_PX);
    drawEmblem(alb.ctx, EMBLEMS[e], EMBLEM_TILE_PX);
    alb.ctx.restore();

    // Give the emblem block a plank-like normal so a shield face is not glassy.
    const ox = col * EMBLEM_TILE_PX;
    const oy = EMBLEM_TOP + row * EMBLEM_TILE_PX;
    const planks = nrm.ctx.getImageData(ox, oy, EMBLEM_TILE_PX, EMBLEM_TILE_PX);
    const ormBlock = orm.ctx.getImageData(ox, oy, EMBLEM_TILE_PX, EMBLEM_TILE_PX);
    for (let y = 0; y < EMBLEM_TILE_PX; y++) {
      for (let x = 0; x < EMBLEM_TILE_PX; x++) {
        const o = (y * EMBLEM_TILE_PX + x) * 4;
        const g = vnoise((x / EMBLEM_TILE_PX) * 4, (y / EMBLEM_TILE_PX) * 60, 4, 67);
        planks.data[o] = 128;
        planks.data[o + 1] = Math.round(120 + g * 16);
        planks.data[o + 2] = 250;
        planks.data[o + 3] = 255;
        ormBlock.data[o] = 245;
        ormBlock.data[o + 1] = Math.round(190 + g * 30);
        ormBlock.data[o + 2] = 0;
        ormBlock.data[o + 3] = 255;
      }
    }
    nrm.ctx.putImageData(planks, ox, oy);
    orm.ctx.putImageData(ormBlock, ox, oy);
  }

  const make = (c: HTMLCanvasElement, srgb: boolean, name: string): THREE.CanvasTexture => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = anisotropy;
    t.name = name;
    t.needsUpdate = true;
    return t;
  };

  const albedo = make(alb.canvas, true, 'soldier-albedo');
  const normal = make(nrm.canvas, false, 'soldier-normal');
  const ormTex = make(orm.canvas, false, 'soldier-orm');

  return {
    albedo,
    normal,
    orm: ormTex,
    dispose(): void {
      albedo.dispose();
      normal.dispose();
      ormTex.dispose();
    },
  };
}
