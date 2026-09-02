import * as THREE from 'three';
import { lerp } from '../../util/math';
import { Rng, hash2 } from '../../util/rand';
import {
  archPanel,
  arcade,
  box,
  column,
  cone,
  crenellation,
  cylinder,
  dome,
  ellipseCavea,
  gableRoof,
  hipRoof,
  pavedEllipse,
  pavedField,
  pediment,
  quadPrism,
  seatingBank,
  straightCavea,
  statue,
  steps,
  type Batch,
  type ColumnOrder,
  type GeoStream,
} from '../build';
// See the note in `circuit.ts`: `TerrainSystem` imports `activeMap`, so taking HALF_EXTENT
// from there would close an ESM cycle once a map declares its city.
import { crestZAt, HALF_EXTENT, roadCentreX, WATER_LEVEL } from '../../terrain/topography';
import { CITY_MAT_KEYS, type CityMatKey } from '../materials';
import { GATE_X } from './apertures';
import { AQUEDUCTS, LANDMARKS, PRECINCT, type LandmarkPlacement } from './layout';
import { PAL } from '../palette';
import { cylinderBetween, type CityChunkSpec, type TreeRequest } from '../wall';

/**
 * Rome's monuments, at true scale.
 *
 * Every dimension below is the real one, cited where it is not obvious. The city's
 * *positions* are compressed (see `layout.ts`) but nothing is scaled, because the
 * whole point of a skyline is that the Pantheon's dome is 43 m across and the
 * Colosseum is 48 m tall, and a man beside them is 1.75 m.
 */

export interface LandmarkOutput {
  chunks: CityChunkSpec[];
  trees: TreeRequest[];
  /**
   * Oriented rectangular footprints, for `blocksMovement` and for the insula generator.
   * Rectangles, not circles: a circle sized to the Circus Maximus's *width* leaves five
   * sixths of its 621 m length free for the fabric to grow through, and a circle sized to
   * its length swallows the Palatine and the Aventine whole.
   */
  footprints: { x: number; z: number; hw: number; hd: number; rot: number }[];
}

type Ground = (x: number, z: number) => number;

/**
 * Mausoleum of Augustus: 87 m across and about 42 m tall, built as concentric
 * travertine drums retaining planted earth terraces (Strabo V.3.8 describes the
 * evergreens and the bronze Augustus above them). Shared between the geometry and
 * the planting planner so the cypresses land on the terraces, not on the ground.
 */
/**
 * The substructure plinth's wall thickness, and the wet bays' pier thickness.
 *
 * Named because `buildSubstructure` has to inset its own ring by half of the larger one to
 * keep the drawn face on the monument's collision box — see the note there. They were two
 * literals in two `quadPrism` calls, which is how the overhang stayed invisible.
 */
const PLINTH_T = 0.9;
const PIER_T = 1.15;

const MAUS_R = 43.5;
const MAUS_DRUMS = [
  { r: MAUS_R, h: 13.0 },
  { r: MAUS_R * 0.72, h: 11.5 },
  { r: MAUS_R * 0.42, h: 9.5 },
];

function mausoleumTerraces(g: number): { rOut: number; rIn: number; y: number }[] {
  const out: { rOut: number; rIn: number; y: number }[] = [];
  let y = g + 0.3;
  for (let d = 0; d < MAUS_DRUMS.length; d++) {
    y = y + MAUS_DRUMS[d].h + 1.35;
    out.push({ rOut: MAUS_DRUMS[d].r + 0.5, rIn: d + 1 < MAUS_DRUMS.length ? MAUS_DRUMS[d + 1].r : 0, y });
  }
  return out;
}

/**
 * All planting that belongs to a monument. Kept out of the geometry builders because
 * those run once per detail level.
 */
function planLandmarkTrees(l: LandmarkPlacement, heightAt: Ground, rng: Rng, out: TreeRequest[]): void {
  // **This function is outside the placement matrix and emits WORLD positions**, so anything
  // it takes from the monument's own frame has to be scaled by hand: plan offsets by
  // `planScale`, heights by `heightScale`. The mound is an authored height in the building's
  // metres and now shrinks with the building, so the top of the hill the trees stand on is
  // `mound * heightScale` above the ground and not `mound`.
  const g = heightAt(l.x, l.z) + (l.mound ?? 0) * l.heightScale;
  const cs = Math.cos(l.rot);
  const sn = Math.sin(l.rot);
  const push = (lx: number, lz: number, kind: TreeRequest['kind'], scale: number, y?: number): void => {
    out.push({ x: l.x + lx * cs - lz * sn, z: l.z + lx * sn + lz * cs, kind, scale, y });
  };

  if (l.id === 'mausoleum-augustus') {
    // `mausoleumTerraces` works in the tomb's own frame, so it is asked for pure offsets
    // from zero and they are carried out to world here, radius through `planScale` and
    // height through `heightScale`. Both are 1 for this row — it declares no `draw` — so
    // every cypress lands exactly where it did; what changes is that the grove now follows
    // the drums if the Mausoleum is ever authored smaller, which it did not before.
    const gw = heightAt(l.x, l.z);
    const terraces = mausoleumTerraces(0);
    for (let d = 0; d < terraces.length; d++) {
      const t = terraces[d];
      // Sparse and irregular: a perfect ring of cones on a terrace reads as a
      // hedgehog, and Strabo's evergreens were a grove, not a colonnade.
      if (d > 1) continue;
      const mid = (t.rOut + t.rIn) * 0.5;
      const n = Math.max(5, Math.round(mid * 0.34));
      for (let i = 0; i < n; i++) {
        const a = (Math.PI * 2 * (i + rng.range(-0.35, 0.35))) / n;
        const r = lerp(t.rIn + 2.5, t.rOut - 2.5, rng.next()) * l.planScale;
        push(Math.cos(a) * r, Math.sin(a) * r, 'cypress', (1.0 + d * 0.1) * rng.range(0.85, 1.2), gw + t.y * l.heightScale);
      }
    }
    return;
  }
  // The hilltops: planted throughout, because that is what made them desirable
  // addresses. Trees go on the mound top, hence the explicit `g`.
  if (l.id === 'palatine' || l.id === 'aventine-temples' || l.id === 'caelian-villas') {
    const n = l.id === 'palatine' ? 26 : 34;
    for (let i = 0; i < n; i++) {
      push(rng.range(-l.hw * 0.8, l.hw * 0.8), rng.range(-l.hd * 0.8, l.hd * 0.8), rng.bool(0.5) ? 'cypress' : 'pine', rng.range(0.9, 1.4), g);
    }
    return;
  }
  if (l.id === 'forum-romanum' || l.id === 'imperial-fora') {
    for (let i = 0; i < 9; i++) push(rng.range(-l.hw * 0.7, l.hw * 0.7), rng.range(-l.hd * 0.6, l.hd * 0.6), 'umbrella', rng.range(0.9, 1.3), g);
    return;
  }
  if (l.id === 'gardens-sallust' || l.id === 'janiculum') {
    const R = Math.max(l.hw, l.hd) * 0.95;
    const n = Math.round(R * 0.75);
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = R * Math.sqrt(rng.next());
      push(Math.cos(a) * r, Math.sin(a) * r * (l.hd / Math.max(1, l.hw)), rng.pick(['cypress', 'pine', 'umbrella'] as const), rng.range(0.85, 1.5), l.mound ? g : undefined);
    }
    return;
  }
  if (l.id === 'tiber-island') return; // an island of stone, not of trees
  // Temples, theatres and baths get a light scatter round their precinct wall.
  const n = Math.max(3, Math.round(l.clear * 0.1));
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2);
    const rr = rng.range(1.0, 1.22);
    push(Math.cos(a) * l.hw * rr, Math.sin(a) * l.hd * rr, rng.bool(0.55) ? 'cypress' : 'pine', rng.range(0.8, 1.25));
  }
}

export function buildLandmarks(heightAt: Ground, seed: string): LandmarkOutput {
  const rng = new Rng(seed);
  const footprints: { x: number; z: number; hw: number; hd: number; rot: number }[] = [];
  for (const l of LANDMARKS) {
    // Landscape is not masonry. The Janiculum ridge is a 245 × 113 m *hill*, the Horti
    // Sallustiani a garden and Tiber Island an island; publishing them as solid boxes put
    // 150,000 m² of walkable ground behind an invisible wall and was the reason a unit
    // ordered onto the Janiculum stopped at its foot. They stay in the keep-out map, so
    // nobody builds houses on them, but they do not stop a man.
    if (l.soft) continue;
    // **The collision box is exactly the published building; the precinct apron stays
    // walkable.** `l.hw`/`l.hd` are the *reserved* footprint — the building times `PRECINCT`
    // — and the precinct is the steps and the paved area round it, which a man may walk on.
    // So divide the precinct back out and what is left is the building itself.
    //
    // It used to read `* 0.88`, an unexplained magic number that did the same job by eye and
    // did it too hard: 0.88 against `PRECINCT` 1.07 makes the box 0.9416 of the surveyed
    // rectangle, so a builder that honestly draws its own published dimensions already
    // measures 1.062 against its own collision box and has 8 % of `probe-fabric` G14's 15 %
    // tolerance left for a cornice, a flight of steps or a podium moulding. Every builder in
    // this file was therefore spending its whole budget before it drew a stone. Dividing by
    // `PRECINCT` states the intent the old comment already claimed — box = building — and
    // hands the tolerance back to the geometry.
    footprints.push({ x: l.x, z: l.z, hw: l.hw / PRECINCT, hd: l.hd / PRECINCT, rot: l.rot });
  }

  // Planting and tomb layout are *planned* here, not emitted from the geometry
  // builders. Chunk builders run once per detail level, so anything that appends to a
  // shared list from inside one would be duplicated — and the tree chunks are
  // partitioned before any baking happens, so it would never render at all.
  const tombs = planRoadTombs(heightAt, rng.fork('tombs'));
  const trees: TreeRequest[] = [...tombs.trees];
  for (const l of LANDMARKS) planLandmarkTrees(l, heightAt, rng.fork(`plant-${l.id}`), trees);

  // Group monuments into depth bands so a whole band shares one LOD and one set of
  // merged meshes. Individual LODs per monument would triple the draw count. The cuts
  // are derived from the plan rather than hardcoded, because the projection in `survey.ts`
  // decides where the monuments actually land: a fixed band edge silently produced an
  // empty chunk and a 500 m-radius one the last time the plan moved.
  const zs = LANDMARKS.map((l) => l.z).sort((a, b) => a - b);
  const q = (t: number): number => zs[Math.min(zs.length - 1, Math.floor(t * zs.length))];
  // Three bands, not four. A band carries one mesh per material it touches — `monuments-d`
  // reaches seven — so four bands is up to 22 draw calls for 31 monuments, and the frame was
  // 231 against a 220 cap. Merging the two northern bands costs the union of their materials
  // rather than the sum, and the culling loss is small: the Campus Martius monuments are a
  // single group in every city camera. The cuts stay derived from the plan rather than
  // hardcoded, because the projection decides where the monuments land and a fixed band edge
  // silently produced an empty chunk the last time the plan moved.
  const bands: { name: string; from: number; to: number }[] = [
    { name: 'monuments-a', from: -1e9, to: q(0.5) },
    { name: 'monuments-c', from: q(0.5), to: q(0.75) },
    { name: 'monuments-d', from: q(0.75), to: 1e9 },
  ];

  const chunks: CityChunkSpec[] = [];
  for (const band of bands) {
    const members = LANDMARKS.filter((l) => l.z >= band.from && l.z < band.to);
    if (!members.length) continue;
    let cx = 0;
    let cz = 0;
    for (const m of members) {
      cx += m.x;
      cz += m.z;
    }
    cx /= members.length;
    cz /= members.length;
    let radius = 60;
    for (const m of members) radius = Math.max(radius, Math.sqrt((m.x - cx) * (m.x - cx) + (m.z - cz) * (m.z - cz)) + m.clear + 40);
    chunks.push({
      name: band.name,
      cx,
      cz,
      radius,
      castShadow: band.from < 600,
      // 560 was never reached from any city camera: the switch distance is measured to the
      // chunk's *surface* and a monument band is 500 m across, so a 560 m nominal switch
      // fires at a kilometre of centre distance and every band resolved at full detail —
      // seven materials for `monuments-d`, seven draw calls, plus their shadow passes. At
      // the mid tier `TRIM_MERGE` folds road, metal and concrete into stone and the same
      // band is four. Together with the districts this is what brought the `city` camera
      // back under the 220-call cap.
      lodSwitch: [400, 1e9],
      build: (batch, detail) => {
        for (const m of members) {
          batch.setUvOrigin(m.x, 0, m.z);
          /*
           * The band merges these monuments into one mesh per material for the draw budget,
           * which is right and which destroys the only thing that said whose stone is whose.
           * `setProvenance` writes the boundary the merge removes — see `Batch.setProvenance`
           * for the 1.0 % of Rome's monument vertices that `probe-fabric` G15 was crediting
           * to the wrong building without it. A declaration of WHO, never of whether.
           */
          batch.setProvenance(m.id);
          buildLandmark(batch, detail, m, heightAt, rng.fork(m.id));
        }
        // Closed, so nothing built after this band inherits the last monument's name.
        batch.setProvenance(null);
      },
    });
  }

  /**
   * **All the aqueducts in one chunk.**
   *
   * They had one each on the argument that they are long and thin and therefore cull well,
   * which is true and was still the wrong trade. Each one is two materials — brick piers and
   * a stone specus — so two aqueducts is four draw calls, and they cull well *individually*
   * while being visible *together* from every camera that looks at the city, because they
   * both converge on the same eastern hills. Merged they are two calls whenever any of them
   * is in frame, which is the case that actually costs.
   */
  {
    let cx = 0;
    let cz = 0;
    let n = 0;
    for (const aq of AQUEDUCTS) for (const p of aq.path) { cx += p.x; cz += p.z; n++; }
    if (n > 0) {
      cx /= n;
      cz /= n;
      let radius = 60;
      for (const aq of AQUEDUCTS) for (const p of aq.path) radius = Math.max(radius, Math.sqrt((p.x - cx) * (p.x - cx) + (p.z - cz) * (p.z - cz)) + 30);
      chunks.push({
        name: 'aqueducts',
        cx,
        cz,
        radius,
        castShadow: false,
        lodSwitch: [700, 1e9],
        build: (batch, detail) => {
          batch.setUvOrigin(cx, 0, cz);
          for (const aq of AQUEDUCTS) buildAqueduct(batch, detail, aq, heightAt);
        },
      });
    }
  }

  // Tombs lining the Via Flaminia outside the gate. Roman law barred burial inside
  // the walls, so every approach road ran through a corridor of monuments — and in
  // this battle they are the only cover on the plain in front of the wall.
  chunks.push({
    name: 'road-tombs',
    cx: GATE_X,
    cz: crestZAt(GATE_X) - 110,
    radius: 340,
    castShadow: true,
    lodSwitch: [420, 1200],
    build: (batch, detail) => {
      batch.setUvOrigin(GATE_X, 0, crestZAt(GATE_X) - 110);
      buildRoadTombs(batch, detail, heightAt, tombs.sites);
    },
  });

  // The far horizon: the Alban hills and the campagna, closing the view beyond the
  // terrain's edge so the city does not end against empty sky.
  // A ring about the world origin, so that is where its bounding volume has to be: the
  // declared centre used to be (0, 1900) with radius 2600, which does not enclose the
  // geometry at all and put the LOD and shadow distance out by up to 1.9 km.
  chunks.push({
    name: 'far-hills',
    cx: 0,
    cz: 0,
    radius: FAR_HILLS_RADIUS,
    castShadow: false,
    lodSwitch: [1e9, 1e9],
    scenery: true,
    build: (batch) => {
      batch.setUvOrigin(0, 0, 0);
      buildFarHills(batch, heightAt);
    },
  });

  return { chunks, trees, footprints };
}

function buildLandmark(batch: Batch, detail: number, world: LandmarkPlacement, heightAt: Ground, rng: Rng): void {
  /**
   * **A monument is a smaller model of the real building, not a squashed one.**
   *
   * This matrix used to read `(planScale, 1, planScale)`, and the comment that stood here
   * defended it: monuments were "authored at true scale and compressed **in plan only** ...
   * so the Colosseum keeps its 48 m attic while its footprint takes the share of the ground
   * the projection can actually spare." That is a description of the fault. A plan squeezed
   * to 0.445 at full height is not a smaller Colosseum, it is a tower: a ground-level judge
   * measured Rome's monuments at **1.54x too tall for their width**, and at the floor the
   * Pantheon came out 37 × 26 m under a 43 m dome — 1.65 taller than wide, against a real
   * building that is 0.74. Twenty-two rows carry a `draw` and every one of them was drawn
   * that way; the rows with no `draw` were the only correct ones, because 1.0 on all three
   * axes is isotropic by accident. This generalises those rows rather than the others.
   *
   * So Y takes `LandmarkPlacement.heightScale`, which `layout.ts` defaults to the same
   * number as the plan scale. A row that genuinely should keep its height says so with
   * `survey.ts:RomeMonument.drawY` and states why — **no row does today.**
   *
   * The scale is still, formally, non-uniform (any row that sets `drawY` makes it so), and
   * that is safe here only because normals are recomputed from the transformed edges in
   * `GeoStream.prepare` rather than being transformed directly. That sentence used to be a
   * footnote about the plan squeeze; with an authored Y it is load-bearing.
   */
  const mat = new THREE.Matrix4()
    .makeRotationY(world.rot)
    .setPosition(world.x, 0, world.z)
    .scale(SCALE_V.set(world.planScale, world.heightScale, world.planScale));
  /**
   * **Terrain height is a WORLD height, and everything below this line is inside a matrix
   * that now scales Y.** Divide it back out here and the monument sits on the ground; leave
   * it and a monument at `heightScale` 0.445 is buried to 55 % of the local elevation.
   *
   * This is the same idiom `localExtents` applies to X and Z, and the boundary is the same
   * one: `heightAt`, `g`, `podium` and every `heightAt` sample taken inside a builder are
   * the only Y values here that come from the world. `mound` is not one of them — it is an
   * authored height in the building's own metres, so it scales with the building.
   */
  const g = heightAt(world.x, world.z) / world.heightScale;
  // Everything below works in the monument's own frame, so it needs the *unscaled* extents.
  const m = localExtents(world);
  // Every stream the monument builders might touch has to share the placement
  // transform. Unused streams cost nothing: empty ones are dropped when baking.
  // EVERY material key, not a hand-kept subset. A builder that reaches for a stream missing
  // from this list gets an *untransformed* stream and emits its geometry at the world
  // origin — which is in the middle of the battlefield. That is exactly what happened when
  // `buildMound` began using `concrete` for the natural hills: the Janiculum's 230 m earth
  // bank was drawn at (0, 0), a 40 m tan mass across the whole approach that occluded the
  // Roman line in every establishing shot. Enumerate the union, not the guess.
  //
  // And push through `pushAll`, never by iterating the keys: at mid and far detail several
  // of these keys resolve to the *same* stream, and pushing per key composed the
  // placement matrix up to four times. See `Batch.distinct`. That is what put the Mausoleum
  // of Augustus, the Horologium, the Iseum Campense and Trajan's Column at exactly (0, 0)
  // whenever the camera was more than 560 m from them.
  const streams = batch.pushAll(LANDMARK_KEYS, mat);

  let podium = g;
  if (!m.mound) podium = buildSubstructure(batch, detail, m, heightAt, g);
  if (m.mound) {
    // The Capitol and the Palatine stood on monumental substructures and read as
    // masonry; the Aventine, the Caelian and the Janiculum are natural hills and read
    // as earth and planting.
    const built = m.id === 'temple-jupiter' || m.id === 'palatine';
    /**
     * **One survey radius, two semi-axes.**
     *
     * `moundRadius` is a *circumradius* — `layout.ts` documents it as "the footprint's
     * circumradius plus a margin" and `m.clear`, the value used when a row states none, is
     * literally `sqrt(hw² + hd²)`. So the ellipse that carries the same reach with the
     * building's own aspect is that radius split in the ratio `hw : hd : clear`, and the
     * default collapses to exactly `(hw, hd)`: the ellipse inscribed in the reserved
     * rectangle, which is what "follows the footprint" should mean when a row says nothing.
     *
     * On the Capitol this turns a 192 × 192 m disc into a 124 × 147 m hill — the drawn
     * short axis falls from 3.85 of the collision box to 2.33, and the two axes now agree
     * instead of the short one being 26 % worse than the long. It still reads as a hill and
     * not as a plinth, and that is not luck: a *built* mound's deck is `0.66` of its base,
     * so carrying a 63 × 53 m podium needs `k ≥ √2 / 0.66 = 2.14`, and the survey's own
     * 96 m gives `k = 2.18`. The residual over G14's 1.15 is a fact about the survey and
     * not about this builder — the Capitoline hill really is more than twice the temple on
     * it, while the collision box is only ever the temple.
     */
    const k = (m.moundRadius ?? m.clear) / m.clear;
    /*
     * **The platform is labelled apart from the building standing on it, and that is the whole
     * of `probe-fabric` G13a's Capitoline row.**
     *
     * The paragraph above says the residual is a fact about the survey; it is, and until the
     * scene could say which vertices were hill and which were temple, every gate that measures
     * a monument's drawn plan had to take the two together. G13a then read the Temple of
     * Jupiter at 90.8 m against Platner & Ashby's 62.25 m podium — 1.46 of published, over the
     * ceiling — for a temple drawn at exactly its own box. `Batch.setProvenance` costs nothing
     * and lets a reader ask the two questions separately: is the temple its published size, and
     * is the platform the size the survey says.
     */
    batch.setProvenance(`${m.id}#mound`);
    buildMound(batch, detail, m.hw * k, m.hd * k, m.mound, g, heightAt, m.x, m.z, m.rot, built, m.planScale, m.heightScale);
    batch.setProvenance(m.id);
    podium = g + m.mound;
  }

  switch (m.id) {
    case 'pantheon':
      buildPantheon(batch, detail, podium);
      break;
    case 'colosseum':
      buildColosseum(batch, detail, podium);
      break;
    case 'circus-maximus':
      buildCircusMaximus(batch, detail, podium, rng);
      break;
    case 'ludus-magnus':
      buildLudus(batch, detail, podium, 135, 100, rng);
      break;
    case 'tabularium':
      buildTabularium(batch, detail, podium, 73, 34);
      break;
    case 'trajan-market':
      buildMarket(batch, detail, podium, 120, 70);
      break;
    case 'imperial-fora':
      // 250 × 100, from the placement rather than typed: the width used to read 130, which
      // is not a figure the survey has anywhere — the row is `len: 250, wid: 100` — so the
      // precinct was drawn 30 m wider than the ground reserved for it on every side but its
      // own. Derived so the two cannot part company again.
      buildPrecinct(batch, detail, podium, (m.hw * 2) / PRECINCT, (m.hd * 2) / PRECINCT, rng, { temples: 2, colH: 9.2, wall: false });
      break;
    case 'porticus-octaviae':
      buildPrecinct(batch, detail, podium, 132, 119, rng, { temples: 2, colH: 10.5, wall: true });
      break;
    case 'largo-argentina':
      buildPrecinct(batch, detail, podium, 90, 60, rng, { temples: 3, colH: 7.4, wall: false });
      break;
    /**
     * The Porticus Pompei: the quadriporticus behind Pompey's stage, and the other half of a
     * monument the survey used to carry as one 300 × 180 box on the theatre's own coordinate.
     *
     * A precinct with **no temples in it**, which is the one thing that distinguishes it from
     * the three above. The Severan Marble Plan shows four rows of columns round an open court
     * planted as a double grove of plane trees — the trees are `planLandmarkTrees`' business,
     * and the default scatter it gives an unnamed row is a ring round the precinct wall, which
     * is wrong here and is left for phase 3 rather than special-cased now. `wall: true` because
     * the porticus was enclosed: its back range is what the Curia Pompeia was cut into.
     *
     * Extents derived from the placement rather than typed, for the reason the `imperial-fora`
     * case above gives: a literal here is a number free to part company with the survey row.
     */
    case 'porticus-pompei':
      buildPrecinct(batch, detail, podium, (m.hw * 2) / PRECINCT, (m.hd * 2) / PRECINCT, rng, {
        temples: 0,
        colH: 9.0,
        wall: true,
      });
      break;
    case 'aventine-temples':
    case 'caelian-villas':
      buildHillQuarter(batch, detail, podium, m.hw * 1.6, m.hd * 1.6, rng, m.id === 'aventine-temples');
      break;
    case 'tiber-island':
      buildTiberIsland(batch, detail, podium, heightAt, m);
      break;
    case 'mausoleum-hadrian':
      buildHadrianeum(batch, detail, podium, rng);
      break;
    case 'temple-jupiter':
      // Podium 63 × 53 m, hexastyle with a three-deep Etruscan porch, columns of
      // Pentelic marble ~17 m tall, and the gilded bronze roof tiles Domitian paid
      // 12,000 talents for (Plutarch, *Publicola* 15).
      buildTemple(batch, detail, podium, {
        w: 53,
        d: 63,
        podiumH: 5.2,
        colH: 17,
        colR: 0.95,
        colsFront: 6,
        colsSide: 4,
        porchRows: 3,
        order: 'corinthian',
        roofCol: PAL.gilt,
        // Gilded *tiles*, not sheet: the tile material's normal and roughness maps give the
        // pan-and-cover relief, and the gold comes from the vertex colour. The metal material
        // is a near-mirror at metalness 1, and on 3,300 m² of upward-facing roof it reflected
        // the whole sky dome and clipped to a blank white sheet — no amount of tilting the
        // course normals helps, because every upward direction sees bright sky.
        roofMat: 'roof',
        wallCol: PAL.marble,
        cellae: 3,
      });
      break;
    case 'mausoleum-augustus':
      buildMausoleum(batch, detail, podium, rng);
      break;
    case 'trajan-column':
      buildTrajansColumn(batch, detail, podium);
      break;
    /**
     * The two theatres, with their cavea radius taken FROM THE PLACEMENT rather than typed.
     *
     * The literals were `55.5` and `75` — a 111 m and a 150 m cavea — against reserved
     * footprints of 115 and 140 m. The Theatre of Pompey therefore drew a semicircle 150 m
     * across inside a box 140 m across, and the arcade and attic bays stand
     * `THEATRE_FACADE_PROJ` beyond `radius` on top of that, so its stone reached 78.6 m from
     * its own centre against a published half-width of 70. Same fault as `baths-trajan`,
     * `baths-caracalla`, `castra-praetoria`, `imperial-fora` and `porticus-pompei` before it,
     * and the same repair: a literal here is a number free to part company with the survey
     * row, so derive it and the two cannot drift again.
     *
     * `min(hw, hd)` because a semicircular cavea is 2R across and R deep plus its scaena, so
     * the diameter binds on whichever half-extent is smaller — on both of Rome's theatres
     * that is the `hw` axis.
     */
    case 'theatre-marcellus':
      // 32.6 m tall, 41 arcade bays per storey, seated ~15,000.
      buildTheatre(batch, detail, podium, caveaRadius(m), 32.6, 41, 2, m.hd / PRECINCT);
      break;
    case 'theatre-pompey':
      // Rome's first stone theatre, and the largest in the city.
      buildTheatre(batch, detail, podium, caveaRadius(m), 33, 48, 3, m.hd / PRECINCT);
      break;
    case 'stadium-domitian':
      // 275 × 106 m; the plan survives as the Piazza Navona.
      buildStadium(batch, detail, podium, 275, 106, rng);
      break;
    case 'basilica-ulpia':
      buildBasilica(batch, detail, podium, 130, 55);
      break;
    case 'forum-romanum':
      buildForum(batch, detail, podium, rng);
      break;
    // Every bath block is the same plan at a different size: precinct wall, vaulted
    // frigidarium, domed caldarium on the sunny side, palaestrae either flank. The
    // dimensions are each monument's real precinct, from `ROME`.
    case 'baths-trajan':
      // 230 × 170, from the placement. It used to read `330, 215`, and 330 × 215 is the
      // *platform* on the Oppian — gardens, cisterns, the lot — while the row this monument
      // is projected from is `len: 230, wid: 170` and its own cite says "the bathing block
      // is c. 230 × 190 and that is what is modelled, the gardens being district fabric".
      // The builder drew the platform and the sim collided with the block, which made this
      // the worst offender in `probe-fabric` G14: 1.524 of its own footprint, 34.8 m of
      // stone per side standing on ground the insula generator was free to build houses on.
      buildBaths(batch, detail, podium, (m.hw * 2) / PRECINCT, (m.hd * 2) / PRECINCT, rng);
      break;
    // **There is deliberately no `baths-diocletian` case, and there was one.**
    //
    // The Baths of Diocletian were begun in 298 and dedicated in 305–306, which is 27 to 35
    // years after this map. `survey.ts` has recorded the omission for as long as the survey has
    // existed — and this switch still carried a working 376 × 361 m builder for them, keyed on
    // an id no survey row supplies. A dead builder for a monument that must never be drawn is
    // not harmless: it is the one line that turns "somebody adds a row" into "the map is wrong
    // by thirty years", with nothing in between to object. Removed, and the reason left here so
    // it is not helpfully restored.
    //
    // The same date filter applies to anything traced off the Shepherd plate, which is dated
    // c. 350 AD and therefore draws these baths at full size on the Viminal. A reference can be
    // authentic and still wrong for your date. Same for the Baths of Constantine, the Basilica
    // of Maxentius and the Arch of Constantine, none of which is in the survey.
    case 'baths-caracalla':
      // 218 × 112, from the placement — the same fault as Trajan's, found beside it. The
      // literals were `337, 328`, which is the *precinct* on the Via Nova, while the row is
      // `len: 218, wid: 112` and its cite says in as many words "the block is what is
      // modelled". Corrected even though this case is currently unreachable — the Baths of
      // Caracalla project south of the heightfield and `offMapSouth` drops them before
      // `LANDMARKS` is built — because a dead builder holding a wrong number is exactly how
      // it comes back wrong the day the frame changes. See the note on `baths-diocletian`.
      buildBaths(batch, detail, podium, (m.hw * 2) / PRECINCT, (m.hd * 2) / PRECINCT, rng);
      break;
    case 'baths-titus':
      buildBaths(batch, detail, podium, 120, 105, rng);
      break;
    case 'baths-nero':
      buildBaths(batch, detail, podium, 190, 120, rng);
      break;
    case 'baths-agrippa':
      buildBaths(batch, detail, podium, 120, 100, rng);
      break;
    case 'castra-praetoria':
      // 400 × 377 m, from the placement, with a brick curtain about 4.7 m high in its
      // original phase. The literals used to be `440, 380`: 440 × 380 is the camp as
      // Platner-Ashby gives it, but the row deliberately does not draw it at that size —
      // its cite reads "Modelled 400 × 377 and pushed hard against the east edge of the
      // heightfield", because at true size the camp is a tenth of the buildable city. The
      // builder was drawing the published camp inside a footprint reserved for the modelled
      // one, which is 20 m of curtain per side standing outside its own collision box.
      buildCastra(batch, detail, podium, (m.hw * 2) / PRECINCT, (m.hd * 2) / PRECINCT, heightAt, m);
      break;
    case 'horologium':
      // The obelisk of Psammetichus II, 21.8 m of red granite on a 5 m base.
      buildObelisk(batch, detail, podium, 21.8, 1.9);
      break;
    case 'ara-pacis':
      buildAltarEnclosure(batch, detail, podium, 11.6, 10.6);
      break;
    case 'temple-isis':
      buildTemple(batch, detail, podium, {
        w: 22,
        d: 34,
        podiumH: 2.6,
        colH: 10.5,
        colR: 0.58,
        colsFront: 4,
        colsSide: 6,
        porchRows: 2,
        order: 'corinthian',
        roofCol: PAL.roofTile,
        roofMat: 'roof',
        wallCol: PAL.marbleShadow,
        cellae: 1,
      });
      buildObelisk(batch, detail, podium, 9.2, 0.85);
      break;
    case 'temple-serapis':
      // Caracalla's temple on the Quirinal summit: a 98 m-wide podium carrying a
      // hexastyle front with the largest columns in Rome after the Pantheon's.
      buildTemple(batch, detail, podium, {
        w: 62,
        d: 92,
        podiumH: 7.5,
        colH: 21,
        colR: 1.05,
        colsFront: 8,
        colsSide: 6,
        porchRows: 2,
        order: 'corinthian',
        roofCol: PAL.bronze,
        roofMat: 'roof',
        wallCol: PAL.marble,
        cellae: 1,
      });
      break;
    case 'palatine':
      buildPalatine(batch, detail, podium, rng);
      break;
    case 'gardens-sallust':
      buildGardens(batch, detail, podium, rng, m.clear);
      break;
    case 'janiculum':
      buildGardens(batch, detail, podium, rng, m.clear);
      break;
    default:
      break;
  }

  batch.popAll(streams);
}

const SCALE_V = new THREE.Vector3();

/**
 * How far the arcaded façade and the attic bays stand outside a theatre's `radius`.
 *
 * It is the `depth: 3.6` the arcade and the attic boxes are drawn with, named once so that
 * `caveaRadius` can subtract it. A theatre's published width is the outside of its façade,
 * not the line the seating is set out from.
 */
const THEATRE_FACADE_PROJ = 3.6;

/**
 * The cavea radius that puts a theatre's drawn façade on its own collision box.
 *
 * `m` is already in the monument's own frame (`localExtents`), so `hw`/`hd` here are the
 * reserved footprint; dividing `PRECINCT` back out gives the box `buildLandmarks` publishes,
 * which is what `probe-fabric` G14 measures against.
 */
function caveaRadius(m: LandmarkPlacement): number {
  return Math.max(8, Math.min(m.hw, m.hd) / PRECINCT - THEATRE_FACADE_PROJ);
}

/**
 * A monument's footprint in its own, uncompressed frame.
 *
 * `LandmarkPlacement` carries *world* extents, because the keep-out map, the overlap solver,
 * the movement grid and the plan diagnostic all measure ground. The geometry builders are
 * inside the placement matrix, which compresses plan by `planScale`, so they need the
 * extents divided back out or the compression is applied twice.
 *
 * Plan only. Nothing on a placement is a *height* except `mound`, and `mound` is already in
 * the building's own metres — it is an authored podium, not a measurement of the world — so
 * it passes through and the matrix's `heightScale` scales it with everything else. The Y
 * values that *do* cross the boundary all come from `heightAt`, and they are divided out at
 * each call site rather than here, because this function never sees them.
 */
function localExtents(m: LandmarkPlacement): LandmarkPlacement {
  if (m.planScale === 1) return m;
  const k = 1 / m.planScale;
  return {
    ...m,
    hw: m.hw * k,
    hd: m.hd * k,
    clear: m.clear * k,
    moundRadius: m.moundRadius === undefined ? undefined : m.moundRadius * k,
  };
}

/**
 * Every material stream a monument builder can reach for: the whole key set, read off the
 * material table rather than listed here.
 *
 * A hand-kept list drifts and nothing stops it. The day a key is added to `SPECS` — marble
 * and granite are the obvious next two — every monument that reaches for it emits its
 * geometry in the monument's *local* frame, and that lands stacked over the world origin,
 * up to 110 m above the middle of the battlefield. Silently, and **only at full detail**,
 * because `TRIM_MERGE` folds an unknown key onto `stone` past the mid switch and `stone` is
 * pushed. An empty stream is dropped when baking, so naming a key no monument uses costs
 * nothing.
 *
 * Identical to the nine keys this listed by hand, at the time it replaced them.
 */
const LANDMARK_KEYS: readonly CityMatKey[] = CITY_MAT_KEYS;

/**
 * The substructure under a large flat monument.
 *
 * A Roman public building has a level floor, and the ground it stands on does not. The
 * Circus Maximus is 621 m long across a valley whose floor moves several metres, the Baths
 * of Trajan are a 330 m platform on a hillside, and every one of them was built up on
 * vaulted substructures for exactly this reason. Without one, the geometry is a flat plane
 * at the height sampled at the monument's centre and the terrain simply comes up through
 * it: the racetrack had grass growing through the sand at both ends.
 *
 * So sample `heightAt` across the footprint, put the floor a little *above* the highest
 * point in it, and fill down to the lowest with a battered masonry plinth. Both halves
 * matter: taking the floor from the centre sample instead of the maximum is what left grass
 * growing through the middle of the racetrack. Returns the floor level. Cost is a couple of
 * hundred triangles; the alternative is a building that either floats or leaks.
 *
 * ## The wet bays are piers on piles, and the plinth stops there
 *
 * A row that declares `survey.ts:RomeMonument.overWater` stands over the channel on purpose,
 * and the plinth above is the wrong statement about it: a solid battered wall running down
 * into the Tiber reads as a building that the river has flooded, which is precisely the thing
 * the owner reported. What the Theatre of Marcellus actually had on its river flank is
 * **substructures over the foreshore** — piers with water between them.
 *
 * So a bay whose foot is at or below the drawn water surface is built as a run of piers with
 * daylight between them, standing on a pile field that fills the wet part of the footprint
 * (`buildRipaPiles`). The floor plate at the top is unchanged, so nothing shows through from
 * below; what changes is that at water level you can see under the building, which is what
 * "over the water" is supposed to look like.
 *
 * `WATER_LEVEL` is Rome's drawn surface and comes in through the vertical scale for the same
 * reason every other terrain sample in this function does — see `sample`.
 */
function buildSubstructure(
  batch: Batch,
  detail: number,
  m: LandmarkPlacement,
  heightAt: Ground,
  ground: number
): number {
  // Only things with a real floor plate. A column, an obelisk or an altar sits on its own
  // steps and needs nothing.
  const area = m.hw * m.hd * 4;
  if (area < 2600 || m.farBank || m.onRiver || m.soft) return ground;

  const st = batch.s('stone');
  const cs = Math.cos(m.rot);
  const sn = Math.sin(m.rot);
  // The building, not the precinct: the plinth should not swallow the paved area around it.
  // `PRECINCT` rather than the 1.07 that used to be typed here, so this cannot drift from
  // the constant `layout.ts` actually multiplies the surveyed rectangle by.
  const hw = m.hw / PRECINCT;
  const hd = m.hd / PRECINCT;
  // `m` is in the monument's own frame; the terrain is not, in either plan or height.
  // Sampling *offsets* go back out through the plan compression (`planScale`, authored as
  // `survey.ts:RomeMonument.draw`) or the plinth follows ground `1 / planScale` too far out;
  // the sampled *height* comes back through the vertical one (`heightScale`) or every
  // number below — `low`, `high`, `podium`, the per-bay `g0` — is a world metre being
  // compared against a local one, and the plinth foot leaves the ground.
  const k = m.planScale;
  const hk = m.heightScale;
  const sample = (u: number, v: number): number =>
    heightAt(m.x + (u * cs - v * sn) * k, m.z + (u * sn + v * cs) * k) / hk;
  const nu = Math.max(2, Math.round(hw / 24));
  const nv = Math.max(2, Math.round(hd / 24));
  let low = Infinity;
  let high = -Infinity;
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const u = -hw + (hw * 2 * i) / nu;
      const v = -hd + (hd * 2 * j) / nv;
      const h = sample(u, v);
      low = Math.min(low, h);
      high = Math.max(high, h);
    }
  }
  // The floor clears the highest ground in the footprint. Capped so a monument that happens
  // to straddle a spur does not end up on a ten-metre pedestal.
  const podium = Math.min(high + 0.35, ground + 6.5);
  if (podium - (low - 1.1) < 0.6) return podium;

  /**
   * The drawn waterline, in the monument's own frame — or `-Infinity` for every row that has
   * not declared itself over the water, which is all of them but one, so the branch below
   * never fires and the plinth is byte-identical to what it was.
   */
  const waterY = m.overWater === undefined ? -Infinity : WATER_LEVEL / hk;
  if (m.overWater !== undefined) buildRipaPiles(batch, detail, m, sample, hw, hd, podium, waterY);

  /**
   * Walk the four sides as segments so the face can be toned per bay and, at close range,
   * carry the blind arcading a real substructure has.
   *
   * **The ring is inset by half the thickest prism drawn on it, and that is worth a
   * paragraph because it was `probe-fabric` G14 on twenty rows at once.**
   *
   * `quadPrism` centres its wall on the line it is given — `const t = thickness * 0.5` and
   * the outer face sits at `-t` along the normal — so a plinth built on the ring `[±hw, ±hd]`
   * puts **half its thickness outside the monument's own collision box**, on every side, on
   * every monument that has a substructure. Measured with `tools/scratch/mon-extents.mjs`:
   * a uniform **+0.45 m** overhang on twenty of the thirty rows, and +0.575 where the wet
   * bays' 1.15 m piers are drawn instead. `buildLandmarks` publishes `hw / PRECINCT` as the
   * box and its comment says in as many words that the box IS the building; the outer face
   * of the substructure is the building's outer face, so that is where it belongs.
   *
   * Inset by the *thickest* of the two prisms, not each by its own, so the dry plinth and the
   * wet piers stand on one line and a bay does not step in and out where the water begins.
   * The dry face therefore lands `(PIER_T - PLINTH_T) / 2` = 0.125 m inside the box, which is
   * a tenth of a course and is the right direction to be wrong in.
   */
  const inset = PIER_T * 0.5;
  const rw = Math.max(0, hw - inset);
  const rd = Math.max(0, hd - inset);
  const corners: [number, number][] = [
    [-rw, -rd],
    [rw, -rd],
    [rw, rd],
    [-rw, rd],
  ];
  const col = new THREE.Color();
  for (let c = 0; c < 4; c++) {
    const [x0, z0] = corners[c];
    const [x1, z1] = corners[(c + 1) % 4];
    const len = Math.sqrt((x1 - x0) * (x1 - x0) + (z1 - z0) * (z1 - z0));
    const segs = Math.max(1, Math.round(len / 26));
    const dx = (x1 - x0) / len;
    const dz = (z1 - z0) / len;
    for (let i = 0; i < segs; i++) {
      const ax = x0 + (x1 - x0) * (i / segs);
      const az = z0 + (z1 - z0) * (i / segs);
      const bx = x0 + (x1 - x0) * ((i + 1) / segs);
      const bz = z0 + (z1 - z0) * ((i + 1) / segs);
      // Foot of this bay follows the ground, so the plinth is only as deep as it must be.
      const g0 = Math.min(sample(ax, az), sample(bx, bz)) - 1.1;
      col.copy(PAL.peperino).multiplyScalar(0.9 + hash2(c, i, 0x5f1) * 0.2);
      /*
       * A bay standing in the water is piers with daylight between them, not a wall. See the
       * header: five piers across the bay, each a sixth of it, so the run is half solid and
       * half open and the water is visibly continuous under the building. The pile field
       * behind them was laid before this loop.
       */
      if (g0 <= waterY) {
        const piers = 5;
        for (let p = 0; p < piers; p++) {
          const t0 = (p + 0.17) / piers;
          const t1 = (p + 0.83) / piers;
          quadPrism(st, ax + (bx - ax) * t0, az + (bz - az) * t0,
            ax + (bx - ax) * t1, az + (bz - az) * t1,
            -dz, dx, PIER_T, g0 - 0.9, podium, col, PAL.travertineDirty, { top: false });
        }
        continue;
      }
      quadPrism(st, ax, az, bx, bz, -dz, dx, PLINTH_T, g0, podium, col, PAL.travertineDirty, {
        top: false,
        ends: false,
      });
      // A substructure more than four metres tall was arcaded, and its arches held shops —
      // the Circus Maximus's own outer vaults were famously let to tradesmen. Without them
      // a monument on falling ground presents fifteen metres of blank ashlar to anyone in
      // the street beside it, which is what the low camera found.
      const h = podium - g0;
      if (detail >= 1 && h > 4.2) {
        const bays = Math.max(1, Math.round((len / segs) / 7.2));
        const bw = (len / segs) / bays;
        for (let b = 0; b < bays; b++) {
          const t = (b + 0.5) / bays;
          const px = ax + (bx - ax) * t;
          const pz = az + (bz - az) * t;
          st.push(new THREE.Matrix4().makeRotationY(Math.atan2(-dz, dx) + Math.PI * 0.5).setPosition(px, g0, pz));
          archPanel(st, bw + 0.04, h, col, {
            depth: 1.1,
            spring: Math.min(h * 0.52, bw * 0.66),
            openWidth: Math.min(bw * 0.58, h * 0.42),
            segments: detail >= 2 ? 7 : 4,
            voidCol: PAL.voidDark,
          });
          st.pop();
        }
      }
    }
  }
  // Cap: the floor plate itself, so nothing can show through from below.
  UP.set(0, 1, 0);
  const q0 = new THREE.Vector3(-hw, podium - 0.06, -hd);
  const q1 = new THREE.Vector3(hw, podium - 0.06, -hd);
  const q2 = new THREE.Vector3(hw, podium - 0.06, hd);
  const q3 = new THREE.Vector3(-hw, podium - 0.06, hd);
  st.quadN(UP, q0, q1, q2, q3, PAL.dust);
  void detail;
  return podium;
}

/**
 * **The piles under a building that stands over the water.**
 *
 * The owner, on the frame that opened this pass: *"there are some big buildings still in the
 * river."* Two answers were available and only one of them is honest for the Theatre of
 * Marcellus. The Mausoleum of Hadrian was drawn smaller until its footprint left the channel;
 * the Theatre cannot be, because **no plan scale takes it out** — swept against `probe-fabric`
 * G22's own wet-area measure it is still 95 m² wet at `draw` 0.30 — and it should not be,
 * because the theatre stands on the Ripa with its stage flank toward the Tiber. `survey.ts`
 * declares that with `RomeMonument.overWater` and `layout.ts` publishes the declaration for
 * the external check to grade. This is the half that makes it true of the geometry rather
 * than only of the data.
 *
 * A grid of piles, in the monument's own frame, wherever the ground under the plan is at or
 * below the drawn water surface: a travertine footing block on the bed, a timber pile up to
 * the floor plate, and a capping beam every other row. The wet perimeter bays above are built
 * as open piers rather than as a battered wall, so this is visible from the water — which is
 * the whole point, and is the difference between a building on a wharf and a building the
 * Tiber has flooded.
 *
 * The pitch is authored in the monument's own (true) metres, so it comes out through
 * `planScale` like every other dimension a builder writes: 5.4 m of real spacing is 2.2 m of
 * drawn spacing at the Theatre's 0.407. The lattice is clamped to `PILE_MAX` posts so a row
 * with a large wet plan cannot cost an unbounded number of triangles, and the pitch grows
 * rather than the field being truncated, for the same reason `probe-fabric`'s raster does it
 * that way: a coarse measurement of the whole thing beats a fine measurement of part of it.
 */
function buildRipaPiles(
  batch: Batch,
  detail: number,
  m: LandmarkPlacement,
  /** Local ground under a local (u, v). Supplied by `buildSubstructure`; see its `sample`. */
  sample: (u: number, v: number) => number,
  hw: number,
  hd: number,
  podium: number,
  /** The drawn water surface in the monument's own frame. */
  waterY: number
): void {
  // Half the posts past the mid LOD switch. A pile field is a texture at 340 m, and the piers
  // in front of it are what carries the read; the count is what costs.
  const PITCH = detail >= 1 ? 5.4 : 10.8;
  const PILE_MAX = 26;
  const st = batch.s('stone');
  const tim = batch.s('timber');
  const nu = Math.min(PILE_MAX, Math.max(1, Math.round((hw * 2) / PITCH)));
  const nv = Math.min(PILE_MAX, Math.max(1, Math.round((hd * 2) / PITCH)));
  const du = (hw * 2) / nu;
  const dv = (hd * 2) / nv;
  const r = Math.min(1.05, du * 0.16);
  const col = new THREE.Color();
  for (let iu = 0; iu < nu; iu++) {
    const u = -hw + (iu + 0.5) * du;
    for (let iv = 0; iv < nv; iv++) {
      const v = -hd + (iv + 0.5) * dv;
      const g0 = sample(u, v);
      if (g0 > waterY) continue;
      // Footing on the bed, then the pile. `g0 - 1.4` is driven in, not resting on it.
      box(st, u - r * 1.5, g0 - 1.4, v - r * 1.5, u + r * 1.5, g0 + 0.6, v + r * 1.5,
        PAL.travertineDirty, { bottom: false });
      col.copy(PAL.timber).multiplyScalar(0.86 + hash2(iu, iv, 0x5f3) * 0.24);
      box(tim, u - r, g0 + 0.4, v - r, u + r, podium, v + r, col, { bottom: false });
      // A capping beam every other row, spanning the pitch: a pile field is braced or it is
      // a row of sticks. Cheap, and it is what stops the field reading as scaffolding.
      if (detail >= 1 && iv % 2 === 0) {
        box(tim, u - r * 0.8, podium - 1.5, v - dv * 0.5, u + r * 0.8, podium - 0.5, v + dv * 0.5,
          PAL.timberDark, { bottom: false });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Artificial hills. The Capitol and the Palatine stood on massive substructures;
// where the battlefield terrain is smooth, the mound *is* the substructure.
// ---------------------------------------------------------------------------

/**
 * An artificial hill under a monument — **an ellipse on the footprint's own proportions.**
 *
 * It took a single `radius` and drew a disc, and a disc round a rectangle circumscribes it:
 * the Capitol's `moundRadius: 96` against a 63 × 53 m temple podium drew 192 m of earth
 * across a 53 m axis, 3.85 of the footprint the sim collides with, and because
 * `probe-fabric` attributes a drawn vertex to the nearest owner, most of the overshoot was
 * charged to the Tabularium next door rather than to the Capitol that emitted it. The same
 * shape of error is waiting in the Palatine (132), the Aventine (120) and the Caelian (120),
 * all three currently off the south edge of the map.
 *
 * Taking `rx` and `rz` separately lets the caller give the hill the plan the building has.
 * See the call in `buildLandmark` for how the survey's one number becomes two.
 */
function buildMound(
  batch: Batch,
  detail: number,
  rx: number,
  rz: number,
  height: number,
  g: number,
  heightAt: Ground,
  wx: number,
  wz: number,
  rot: number,
  built: boolean,
  /**
   * Plan compression the placement matrix applies, for terrain sampling. Authored per
   * monument as `survey.ts:RomeMonument.draw` and carried here as
   * `LandmarkPlacement.planScale`.
   */
  planScale: number,
  /**
   * Vertical compression the same matrix applies. `heightAt` hands back a world metre and
   * this function runs inside the matrix, so the sample has to come back through it or the
   * bank's foot chases a ground line it is no longer standing on.
   */
  heightScale: number
): void {
  const st = batch.s(built ? 'stone' : 'concrete');
  const seg = detail >= 1 ? 30 : 14;
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  // A *built* substructure is one tall battered retaining wall with a broad platform on
  // top, as on the Capitol and the Palatine. Three concentric rings, which is what this
  // used to emit, reads from above as a stepped cavea — the Capitol was being mistaken
  // for a theatre in the plan-view diagnostic.
  const rings = built ? 2 : 4;
  const groundCol = built ? PAL.peperino : PAL.terraDirty;
  const deckCol = built ? PAL.dust : PAL.terraDirty;

  for (let r = 0; r < rings; r++) {
    const t0 = r / rings;
    const t1 = (r + 1) / rings;
    // Built: nearly all of the rise in the first ring, so the profile is a wall.
    // Natural: a smooth convex bank, most of the *shrink* near the top.
    const shrink = built
      ? (t: number): number => 1 - (0.2 * t + 0.14 * t * t)
      : (t: number): number => Math.cos((t * Math.PI) / 2) * 0.42 + (1 - t) * 0.58;
    const lift = built
      ? (t: number): number => Math.min(1, t * 1.9)
      : (t: number): number => Math.sin((t * Math.PI) / 2);
    // Both semi-axes shrink by the same factor, so every ring is the same ellipse and the
    // hill keeps the footprint's aspect all the way to its deck.
    const ax0 = rx * shrink(t0);
    const az0 = rz * shrink(t0);
    const ax1 = rx * shrink(t1);
    const az1 = rz * shrink(t1);
    const y0 = g + height * lift(t0);
    const y1 = g + height * lift(t1);
    const face = new THREE.Color()
      .copy(built ? (r % 2 === 0 ? PAL.peperino : PAL.tufa) : groundCol)
      .multiplyScalar(built ? 0.94 : 0.82 + r * 0.05);
    for (let i = 0; i < seg; i++) {
      const a0 = (Math.PI * 2 * i) / seg;
      const a1 = (Math.PI * 2 * (i + 1)) / seg;
      // The base of the outermost ring must follow the terrain or it floats.
      const groundAt = (a: number): number => {
        if (r > 0) return y0;
        const lx = Math.cos(a) * ax0;
        const lz = Math.sin(a) * az0;
        return Math.min(
          y0,
          heightAt(wx + (lx * cs - lz * sn) * planScale, wz + (lx * sn + lz * cs) * planScale) / heightScale - 1.5
        );
      };
      // Per-facet tone so a 130 m bank is not one flat plate of colour.
      const shade = new THREE.Color().copy(face).multiplyScalar(0.93 + hash2(i, r, 0x71a) * 0.14);
      // Outward normal of the *ellipse* at the middle of this facet, which is not the radial
      // direction once the two axes differ: `(cos a / ax, sin a / az)`, normalised. Only the
      // shading reads it — the prism is 10 mm thick — but on a bank a hundred metres across
      // the wrong normal is a visible seam down every facet on the flatter flanks.
      const am = (a0 + a1) / 2;
      const nx = Math.cos(am) / ax0;
      const nz = Math.sin(am) / az0;
      const nl = Math.sqrt(nx * nx + nz * nz);
      quadPrism(
        st,
        Math.cos(a0) * ax0,
        Math.sin(a0) * az0,
        Math.cos(a1) * ax0,
        Math.sin(a1) * az0,
        nx / nl,
        nz / nl,
        0.01,
        Math.min(groundAt(a0), groundAt(a1)),
        y1,
        shade,
        shade,
        { top: false, ends: false }
      );
      // Terrace deck.
      const c0 = Math.cos(a0);
      const s0 = Math.sin(a0);
      const c1 = Math.cos(a1);
      const s1 = Math.sin(a1);
      const p0 = new THREE.Vector3(c0 * ax0, y1, s0 * az0);
      const p1 = new THREE.Vector3(c1 * ax0, y1, s1 * az0);
      const p2 = new THREE.Vector3(c1 * ax1, y1, s1 * az1);
      const p3 = new THREE.Vector3(c0 * ax1, y1, s0 * az1);
      UP.set(0, 1, 0);
      st.quadN(UP, p0, p1, p2, p3, new THREE.Color().copy(deckCol).multiplyScalar(0.92 + hash2(i, r, 0x4d3) * 0.16));
    }
  }
  // Ramped approach on the north face so the hill reads as accessible. It runs along −Z, so
  // its width comes off `rx` and everything measured along the flight comes off `rz`.
  if (detail >= 1 && built) {
    const w = Math.min(18, rx * 0.24);
    st.pushTranslate(0, 0, -rz * 0.34);
    steps(st, w, g, -rz * 0.66 + rz * 0.34, Math.round(height / 0.34), 0.34, (rz * 0.32) / Math.max(1, Math.round(height / 0.34)), PAL.travertineDirty);
    st.pop();
  }
}

const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// The Pantheon — Hadrian's rotunda, complete since about 126 AD
// ---------------------------------------------------------------------------

/**
 * External diameter 58 m, internal 43.3 m, wall 6 m thick; the dome's apex is
 * 43.3 m above the floor, exactly its internal span, and the oculus is 8.8 m across.
 * The pronaos is 33.1 m wide and 15.5 m deep with eight granite columns 11.8 m tall
 * and 1.48 m in diameter, and the roof tiles were gilded bronze until 655.
 */
function buildPantheon(batch: Batch, detail: number, g: number): void {
  const stone = batch.s('stone');
  const metal = batch.s('metal');
  const brick = batch.s('brick');
  const rOut = 29;
  const drumH = 30;
  const seg = detail >= 1 ? 40 : 18;

  // Stepped travertine platform.
  cylinder(stone, 0, g - 1.2, 0, rOut + 2.4, rOut + 2.2, 1.4, seg, PAL.travertineDirty, { top: true });
  // Drum, brick-faced with travertine string courses, in three external stages.
  const stages = [
    { h: drumH * 0.46, r: rOut, col: PAL.brick },
    { h: drumH * 0.3, r: rOut - 0.55, col: PAL.brick },
    { h: drumH * 0.24, r: rOut - 1.1, col: PAL.brickPale },
  ];
  let y = g + 0.2;
  for (const s of stages) {
    cylinder(brick, 0, y, 0, s.r, s.r, s.h, seg, s.col, { shadeLow: 0.12 });
    cylinder(stone, 0, y + s.h - 0.42, 0, s.r + 0.28, s.r + 0.28, 0.42, seg, PAL.travertine, { top: true });
    y += s.h;
  }
  // Relieving arches in the drum face — visible on the real building.
  if (detail >= 1) {
    for (let i = 0; i < 14; i++) {
      const a = (Math.PI * 2 * i) / 14 + 0.22;
      const px = Math.cos(a) * (rOut - 0.2);
      const pz = Math.sin(a) * (rOut - 0.2);
      brick.push(new THREE.Matrix4().makeRotationY(-a + Math.PI * 0.5).setPosition(px, g + 3.5, pz));
      archPanel(brick, 5.4, 8.4, PAL.brickDark, { depth: 0.5, spring: 4.6, openWidth: 3.0, segments: 7 });
      brick.pop();
    }
  }

  // The dome: a shallow external shell over stepped rings, in gilded bronze tile.
  const domeBase = g + 0.2 + drumH;
  const rings = detail >= 1 ? 7 : 3;
  for (let i = 0; i < rings; i++) {
    const t0 = i / rings;
    const t1 = (i + 1) / rings;
    const r0 = lerp(rOut - 1.1, rOut - 8.5, t0);
    const r1 = lerp(rOut - 1.1, rOut - 8.5, t1);
    const h = 1.05;
    cylinder(stone, 0, domeBase + i * h, 0, r0, r1, h, seg, PAL.travertine, { top: true });
  }
  const shellBase = domeBase + rings * 1.05;
  const shellR = rOut - 8.5;
  // Apex 43.3 m above the floor; the shell above the stepped rings makes up the rest.
  const apex = g + 43.5;
  dome(metal, 0, shellBase, 0, shellR, seg, detail >= 1 ? 9 : 4, PAL.bronze, {
    heightScale: (apex - shellBase) / shellR,
    oculus: 4.4,
  });
  // Oculus rim.
  cylinder(stone, 0, apex - 0.6, 0, 4.9, 4.9, 0.9, detail >= 1 ? 18 : 8, PAL.marble, { top: true });

  // ---- pronaos -------------------------------------------------------------
  const porchW = 33.1;
  const porchD = 15.5;
  const colH = 11.8;
  const colR = 0.74;
  const zFront = -(rOut + porchD);
  // Podium and the five steps up to it.
  box(stone, -porchW / 2 - 1, g - 1.2, zFront - 1, porchW / 2 + 1, g + 1.5, -rOut + 2, PAL.travertine, { topGain: 1.08 });
  stone.pushTranslate(0, 0, zFront - 1);
  steps(stone, porchW * 0.8, g - 1.2, 0, 5, 0.3, 0.36, PAL.travertineDirty);
  stone.pop();

  // Eight columns across the front, three rows deep (8 + 4 + 4).
  const rows = [
    { z: zFront + 1.6, n: 8 },
    { z: zFront + 6.4, n: 4 },
    { z: zFront + 11.0, n: 4 },
  ];
  for (const row of rows) {
    for (let i = 0; i < row.n; i++) {
      const cx = row.n === 8 ? lerp(-porchW / 2 + 2.4, porchW / 2 - 2.4, i / 7) : lerp(-porchW / 2 + 2.4, porchW / 2 - 2.4, i / 3) * (i < 2 ? 1 : 1);
      const x = row.n === 8 ? cx : (i < 2 ? -1 : 1) * (porchW / 2 - 2.4 - (i % 2) * 4.6);
      column(stone, x, g + 1.5, row.z, colR, colH, 'corinthian', PAL.marbleShadow, detail);
    }
  }
  // Entablature and pediment. Roman pediment pitch here is about 1:4.
  const entY = g + 1.5 + colH;
  box(stone, -porchW / 2 - 0.6, entY, zFront - 0.6, porchW / 2 + 0.6, entY + 2.6, -rOut + 1, PAL.marble, { topGain: 1.12 });
  stone.pushTranslate(0, 0, (zFront + (-rOut + 1)) / 2);
  pediment(stone, porchW + 1.2, entY + 2.6, Math.abs(-rOut + 1 - zFront), PAL.marble, 0.22);
  stone.pop();
  // Bronze-tiled porch roof behind the pediment.
  const roofSt = batch.s('metal');
  gableRoof(
    metal,
    roofSt,
    porchW,
    porchD,
    entY + 2.6,
    (porchW / 2) * 0.22,
    0.4,
    PAL.bronze,
    false
  );
  // The intermediate block joining the porch to the rotunda.
  box(brick, -porchW / 2 + 3, g + 1.5, -rOut - 3.5, porchW / 2 - 3, entY + 8.5, -rOut + 4, PAL.brickPale, { topGain: 1.1 });
}

// ---------------------------------------------------------------------------
// The Flavian Amphitheatre
// ---------------------------------------------------------------------------

/**
 * 189 × 156 m at the ground, 48 m to the top of the attic, 80 arcade bays per storey
 * on the three lower orders. Storey heights 10.5, 11.85 and 11.6 m with a 13.6 m
 * attic; ground-storey arches 4.2 m wide and 7.05 m tall. Engaged half-columns run
 * Tuscan, Ionic, Corinthian up the façade, with Corinthian pilasters on the attic.
 */
function buildColosseum(batch: Batch, detail: number, g: number): void {
  const stone = batch.s('stone');
  const concrete = batch.s('stone');
  const a = 94.5;
  const b = 78;
  const bays = detail >= 1 ? 80 : 40;
  const storeys = [
    { h: 10.5, order: 'tuscan' as ColumnOrder, spring: 4.2, open: 4.2 },
    { h: 11.85, order: 'ionic' as ColumnOrder, spring: 4.4, open: 4.2 },
    { h: 11.6, order: 'corinthian' as ColumnOrder, spring: 4.3, open: 4.2 },
  ];
  const wallT = 5.5;

  // Stepped travertine platform (the two-step *crepidines*).
  ellipseRing(stone, a + 3.2, b + 3.2, a - wallT - 2, b - wallT - 2, g - 0.9, 0.9, bays, PAL.travertineDirty);

  let y = g;
  for (let s = 0; s < storeys.length; s++) {
    const st = storeys[s];
    const scale = 1 - s * 0.008;
    for (let i = 0; i < bays; i++) {
      const t0 = (Math.PI * 2 * i) / bays;
      const t1 = (Math.PI * 2 * (i + 1)) / bays;
      const tm = (t0 + t1) / 2;
      const px = Math.cos(tm) * a * scale;
      const pz = Math.sin(tm) * b * scale;
      // Bay width from the chord between successive division points.
      const chordX = Math.cos(t1) * a - Math.cos(t0) * a;
      const chordZ = Math.sin(t1) * b - Math.sin(t0) * b;
      const bw = Math.sqrt(chordX * chordX + chordZ * chordZ);
      // Tangent angle of the ellipse, so panels sit square to the façade.
      const ang = Math.atan2(Math.cos(tm) * a, -Math.sin(tm) * b);
      stone.push(new THREE.Matrix4().makeRotationY(ang).setPosition(px, y, pz));
      archPanel(stone, bw + 0.06, st.h, PAL.travertine, {
        depth: wallT,
        spring: st.spring,
        openWidth: Math.min(st.open, bw * 0.62),
        segments: detail >= 2 ? 9 : detail === 1 ? 6 : 4,
        archivolt: detail >= 2 ? 0.2 : 0,
        voidCol: new THREE.Color(0.05, 0.045, 0.04),
      });
      if (detail >= 1) {
        // Engaged half-column between bays, and the order changes each storey.
        column(stone, bw / 2, 0, -0.55, 0.62, st.h - 1.4, st.order, PAL.travertine, detail - 1);
      }
      stone.pop();
    }
    // Entablature ring capping the storey.
    ellipseRing(stone, a * scale + 0.7, b * scale + 0.7, a * scale - wallT, b * scale - wallT, y + st.h - 1.5, 1.5, bays, PAL.travertine);
    y += st.h;
  }

  // Attic: solid wall with Corinthian pilasters and small square windows, plus the
  // corbels that carried the *velarium* masts.
  const atticH = 13.6;
  for (let i = 0; i < bays; i++) {
    const t0 = (Math.PI * 2 * i) / bays;
    const t1 = (Math.PI * 2 * (i + 1)) / bays;
    const tm = (t0 + t1) / 2;
    const px = Math.cos(tm) * a * 0.976;
    const pz = Math.sin(tm) * b * 0.976;
    const chordX = Math.cos(t1) * a - Math.cos(t0) * a;
    const chordZ = Math.sin(t1) * b - Math.sin(t0) * b;
    const bw = Math.sqrt(chordX * chordX + chordZ * chordZ);
    const ang = Math.atan2(Math.cos(tm) * a, -Math.sin(tm) * b);
    stone.push(new THREE.Matrix4().makeRotationY(ang).setPosition(px, y, pz));
    box(stone, -bw / 2 - 0.04, 0, 0, bw / 2 + 0.04, atticH, wallT, PAL.travertine, { topGain: 1.1 });
    if (detail >= 1) {
      if (i % 2 === 0) {
        // Square window, alternating bays.
        box(stone, -1.1, atticH * 0.42, -0.06, 1.1, atticH * 0.42 + 2.2, 0.3, new THREE.Color(0.05, 0.045, 0.04));
      } else if (detail >= 2) {
        // Gilded bronze shield (*clipeus*) between the windows.
        cylinder(batch.s('metal'), 0, atticH * 0.44, -0.2, 1.2, 1.2, 0.16, 12, PAL.gilt, { top: true });
      }
      // Pilaster.
      box(stone, bw / 2 - 0.42, 0, -0.34, bw / 2 + 0.42, atticH - 1.4, 0, PAL.travertine);
      // Mast corbels: three per bay at the top.
      if (detail >= 2) {
        for (let k = 0; k < 2; k++) {
          const ox = (k - 0.5) * bw * 0.5;
          box(stone, ox - 0.24, atticH - 2.6, -0.9, ox + 0.24, atticH - 1.9, 0, PAL.travertineDirty);
          box(stone, ox - 0.3, atticH - 0.9, -0.8, ox + 0.3, atticH - 0.2, 0, PAL.travertineDirty);
        }
      }
    }
    stone.pop();
  }
  ellipseRing(stone, a * 0.976 + 0.9, b * 0.976 + 0.9, a * 0.976 - wallT, b * 0.976 - wallT, y + atticH, 1.1, bays, PAL.travertine);

  // ---- interior: cavea and arena ------------------------------------------
  //
  // The arena is 83 × 48 m (a/b = 1.73) inside a building that is 189 × 156 (a/b = 1.21),
  // so the cavea's semi-axes have to *interpolate* between the two ellipses. The previous
  // revision scaled one radius by a single b/a factor, which left a crescent of open
  // ground between the arena wall and the first row — you could see the fields and a
  // cypress through the middle of the amphitheatre.
  const caveaOuterA = a - wallT - 1;
  const caveaOuterB = b - wallT - 1;
  // Arena 86 × 54 m.
  const arenaA = 43;
  const arenaB = 27;
  const podiumH = 3.6;
  const arenaY = g + 2.4;
  const caveaY = arenaY + podiumH;
  // Arena floor: sand over the hypogeum, cell-varied so it is not a flat tan plate.
  // Warm sand, not the grey-olive of the generic dust: the arena floor is 3,100 m² of the
  // brightest surface in the building and it read as a lawn.
  const sand = new THREE.Color().copy(PAL.dust).lerp(PAL.ochrePale, 0.42);
  pavedEllipse(concrete, arenaA, arenaB, arenaY, detail >= 1 ? 5 : 2, detail >= 1 ? 32 : 14, sand, 0x0c05, 0.18);
  if (detail >= 1) {
    // The hypogeum's service corridors showing through the boards, as they do today.
    for (let i = -3; i <= 3; i++) {
      const zz = (i / 3.4) * arenaB * 0.78;
      box(concrete, -arenaA * 0.82, arenaY, zz - 0.55, arenaA * 0.82, arenaY + 0.28, zz + 0.55, PAL.peperino);
    }
    box(concrete, -1.1, arenaY, -arenaB * 0.8, 1.1, arenaY + 0.28, arenaB * 0.8, PAL.peperino);
  }
  // Arena wall (*podium*): the 3.6 m barrier protecting the front rows, on the arena
  // ellipse exactly, which is also the cavea's inner edge.
  ellipseRing(concrete, arenaA + 1.6, arenaB + 1.6, arenaA, arenaB, arenaY, podiumH, bays, PAL.marbleShadow);
  ellipseCavea(
    concrete,
    arenaA + 1.6,
    arenaB + 1.6,
    caveaOuterA,
    caveaOuterB,
    caveaY,
    g + 38.5,
    0,
    Math.PI * 2,
    {
      // Maenianum *steps*, not seat rows. Thirty-four 1.2 m rings resolve to a
      // one-pixel light/dark pair at any strategic camera distance, which is textbook
      // moiré and shimmers as the camera moves; the real cavea was built as deep
      // concrete steps in three blocks divided by walled walkways, and emitting those
      // is both cheaper and closer to the archaeology.
      rows: detail >= 1 ? 18 : 7,
      seg: detail >= 1 ? 48 : 20,
      breaks: detail >= 1 ? [6, 13] : [],
      balteus: 1.7,
      scalaria: detail >= 2 ? 16 : 0,
      tread: PAL.travertineDirty,
      riser: new THREE.Color().copy(PAL.travertineDirty).multiplyScalar(0.68),
      salt: 0x21a,
    }
  );
}

/** Elliptical annulus prism — platforms and entablature rings. */
function ellipseRing(
  st: GeoStream,
  aOut: number,
  bOut: number,
  aIn: number,
  bIn: number,
  y0: number,
  h: number,
  seg: number,
  col: THREE.Color
): void {
  const bright = new THREE.Color().copy(col).multiplyScalar(1.14);
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const p3 = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  for (let i = 0; i < seg; i++) {
    const t0 = (Math.PI * 2 * i) / seg;
    const t1 = (Math.PI * 2 * (i + 1)) / seg;
    const tm = (t0 + t1) / 2;
    // Outer face.
    p0.set(Math.cos(t0) * aOut, y0, Math.sin(t0) * bOut);
    p1.set(Math.cos(t1) * aOut, y0, Math.sin(t1) * bOut);
    p2.set(Math.cos(t1) * aOut, y0 + h, Math.sin(t1) * bOut);
    p3.set(Math.cos(t0) * aOut, y0 + h, Math.sin(t0) * bOut);
    nrm.set(Math.cos(tm) * bOut, 0, Math.sin(tm) * aOut).normalize();
    st.quadN(nrm, p0, p1, p2, p3, col, col, bright, bright);
    // Top.
    p0.set(Math.cos(t0) * aOut, y0 + h, Math.sin(t0) * bOut);
    p1.set(Math.cos(t1) * aOut, y0 + h, Math.sin(t1) * bOut);
    p2.set(Math.cos(t1) * aIn, y0 + h, Math.sin(t1) * bIn);
    p3.set(Math.cos(t0) * aIn, y0 + h, Math.sin(t0) * bIn);
    nrm.set(0, 1, 0);
    st.quadN(nrm, p0, p1, p2, p3, bright);
  }
}

/** Flat elliptical disc — arena floors, pools, paved plazas. */
function ellipseDisc(st: GeoStream, a: number, b: number, y: number, seg: number, col: THREE.Color): void {
  const c = new THREE.Vector3(0, y, 0);
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const nrm = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < seg; i++) {
    const t0 = (Math.PI * 2 * i) / seg;
    const t1 = (Math.PI * 2 * (i + 1)) / seg;
    p1.set(Math.cos(t0) * a, y, Math.sin(t0) * b);
    p2.set(Math.cos(t1) * a, y, Math.sin(t1) * b);
    st.triN(nrm, c, p1, p2, col);
  }
}

// ---------------------------------------------------------------------------
// Circus Maximus
// ---------------------------------------------------------------------------

/**
 * 621 × 118 m, seating around 150,000. The *spina* runs some 340 m down the middle
 * carrying the obelisk Augustus brought from Heliopolis (23.5 m of red granite),
 * the two *metae* turning posts, and the seven lap-counting eggs and dolphins.
 * Twelve *carceres* close the flat north-west end.
 */
function buildCircusMaximus(batch: Batch, detail: number, g: number, rng: Rng): void {
  const stone = batch.s('stone');
  const concrete = batch.s('stone');
  const brick = batch.s('brick');
  // 621 × 118 m is the *track* — the sanded arena between the seating. The survey's `wid`
  // of 190 is the whole structure including the banks and the outer arcade, which is what
  // the reserved footprint has to cover; the builder needs the track. Confusing the two put
  // a 264 m-wide circus on the ground with a 190 m track, which from above read as a flat
  // corrugated ramp rather than a racecourse.
  const L = 621;
  const W = 118;
  const seatDepth = 34;
  const facadeH = 28;
  // Three storeys of arcaded travertine, as on the Severan plan and as reconstructed in
  // the Gismondi model: the lower two arcaded, the third a colonnaded gallery.
  const STOREYS = [
    { h: 9.6, order: 'tuscan' as ColumnOrder },
    { h: 9.4, order: 'ionic' as ColumnOrder },
    { h: 9.0, order: 'corinthian' as ColumnOrder },
  ];
  // The straight run of the seating: the sphendone takes the eastern end.
  const straightHalf = L / 2 - W / 2 - 10;

  // Arena floor, sanded and rutted: from the face of the carceres to the inner edge of
  // the sphendone's seating.
  const arenaX0 = -L / 2 + 15;
  const arenaX1 = straightHalf + W / 2;
  concrete.pushTranslate((arenaX0 + arenaX1) / 2, 0, 0);
  pavedField(concrete, (arenaX1 - arenaX0) / 2, W / 2, g + 0.08, 17, new THREE.Color().copy(PAL.dust).lerp(PAL.ochrePale, 0.38), 0x3b71, 0.2);
  concrete.pop();

  const bayW = 6.9;
  const facade = (
    st: GeoStream,
    x0: number,
    x1: number,
    zf: number,
    faceRot: number
  ): void => {
    const len = x1 - x0;
    const bays = Math.max(2, Math.round(len / bayW / (detail >= 1 ? 1 : 3)));
    const bw = len / bays;
    let y = 0;
    for (let s = 0; s < STOREYS.length; s++) {
      const sto = STOREYS[s];
      st.push(new THREE.Matrix4().makeRotationY(faceRot).setPosition((x0 + x1) / 2, g + y, zf));
      if (s < 2) {
        arcade(st, bays, bw, sto.h, s === 0 ? PAL.travertine : PAL.travertineDirty, {
          depth: 3.2,
          spring: sto.h * 0.5,
          openWidth: Math.min(bw * 0.62, sto.h * 0.46),
          segments: detail >= 2 ? 8 : 4,
          archivolt: detail >= 2 ? 0.18 : 0,
          voidCol: PAL.voidDark,
        });
      } else {
        // Top gallery: a colonnade under a flat roof rather than a third arcade, which
        // is what the fragments of the Circus's own façade show.
        box(st, -len / 2, 0, 0, len / 2, sto.h * 0.28, 3.2, PAL.travertineDirty, { topGain: 1.08 });
        if (detail >= 1) {
          for (let i = 0; i <= bays; i++) {
            column(st, -len / 2 + bw * i, sto.h * 0.28, 1.4, 0.42, sto.h * 0.66, sto.order, PAL.travertine, detail - 1);
          }
        }
        box(st, -len / 2, sto.h * 0.94, -0.3, len / 2, sto.h, 3.5, PAL.travertine, { topGain: 1.14 });
      }
      // Engaged half-columns between the bays give the façade its vertical rhythm.
      if (detail >= 1 && s < 2) {
        for (let i = 0; i <= bays; i++) {
          column(st, -len / 2 + bw * i, 0, -0.5, 0.44, sto.h - 1.1, sto.order, PAL.travertine, detail - 1);
        }
      }
      st.pop();
      y += sto.h;
    }
  };

  // Seating banks either side of the track, with the arcaded façade behind them.
  for (const s of [-1, 1] as const) {
    straightCavea(concrete, straightHalf, (s * W) / 2, seatDepth, g + 2.2, g + facadeH - 2, s, {
      rows: detail >= 1 ? 11 : 5,
      seg: 0,
      breaks: detail >= 1 ? [4, 8] : [],
      balteus: 1.5,
      tread: PAL.travertineDirty,
      riser: new THREE.Color().copy(PAL.travertineDirty).multiplyScalar(0.7),
      salt: s > 0 ? 0x51 : 0x52,
    });
    facade(brick, -straightHalf, straightHalf, (s * W) / 2 + s * (seatDepth + 3), s > 0 ? Math.PI : 0);
  }

  // ---- the *sphendone*: the curved end, at the END of the track ------------
  //
  // This used to be emitted at the monument's own origin — the `pushTranslate(endX)`
  // that was meant to place it was applied *after* the call and popped immediately — so
  // a 91 m half-disc of seating stood in the middle of the racetrack. From the air it
  // read as a second amphitheatre, which is a large part of why the city appeared to
  // have several Colosseums.
  const endX = straightHalf;
  concrete.pushTranslate(endX, 0, 0);
  brick.pushTranslate(endX, 0, 0);
  ellipseCavea(
    concrete,
    W / 2,
    W / 2,
    W / 2 + seatDepth,
    W / 2 + seatDepth,
    g + 2.2,
    g + facadeH - 2,
    -Math.PI / 2,
    Math.PI / 2,
    {
      rows: detail >= 1 ? 11 : 5,
      seg: detail >= 1 ? 22 : 10,
      breaks: detail >= 1 ? [4, 8] : [],
      balteus: 1.5,
      scalaria: detail >= 2 ? 7 : 0,
      tread: PAL.travertineDirty,
      riser: new THREE.Color().copy(PAL.travertineDirty).multiplyScalar(0.7),
      salt: 0x53,
    }
  );
  // Arcaded curve outside it, in the same three storeys as the straights.
  {
    const rr = W / 2 + seatDepth + 3;
    const nb = detail >= 1 ? 26 : 11;
    for (let i = 0; i < nb; i++) {
      const a0 = -Math.PI / 2 + (Math.PI * i) / nb;
      const a1 = -Math.PI / 2 + (Math.PI * (i + 1)) / nb;
      const am = (a0 + a1) / 2;
      const bw = 2 * rr * Math.sin(Math.PI / (2 * nb));
      let y = 0;
      for (let s = 0; s < STOREYS.length; s++) {
        const sto = STOREYS[s];
        brick.push(new THREE.Matrix4().makeRotationY(-am - Math.PI * 0.5).setPosition(Math.cos(am) * rr, g + y, Math.sin(am) * rr));
        if (s < 2) {
          archPanel(brick, bw + 0.05, sto.h, s === 0 ? PAL.travertine : PAL.travertineDirty, {
            depth: 3.2,
            spring: sto.h * 0.5,
            openWidth: Math.min(bw * 0.6, sto.h * 0.46),
            segments: detail >= 2 ? 7 : 4,
            archivolt: detail >= 2 ? 0.16 : 0,
            voidCol: PAL.voidDark,
          });
        } else {
          box(brick, -bw / 2, 0, 0, bw / 2, sto.h, 3.2, PAL.travertineDirty, { topGain: 1.12 });
        }
        brick.pop();
        y += sto.h;
      }
    }
  }
  brick.pop();
  concrete.pop();

  // ---- spina --------------------------------------------------------------
  const spinaL = 340;
  box(stone, -spinaL / 2, g + 0.1, -3.2, spinaL / 2, g + 2.6, 3.2, PAL.marbleShadow, { topGain: 1.1 });
  // Obelisk at the centre.
  buildObelisk(batch, detail, g + 2.6, 23.5, 1.15);
  // Metae: three conical turning posts at each end of the spina.
  for (const s of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const px = s * (spinaL / 2 - 3) - s * 0 + (k - 1) * 2.6;
      box(stone, px - 1.2, g + 2.6, -1.2, px + 1.2, g + 3.4, 1.2, PAL.marble);
      cone(stone, px, g + 3.4, 0, 1.05, 6.4, detail >= 1 ? 10 : 6, PAL.marble, PAL.gilt);
    }
  }
  // Lap counters: seven bronze dolphins on a rail.
  if (detail >= 1) {
    const metal = batch.s('metal');
    for (let k = 0; k < 7; k++) {
      const px = lerp(-spinaL * 0.28, spinaL * 0.28, k / 6);
      cylinder(metal, px, g + 2.6, 1.6, 0.16, 0.16, 3.4, 6, PAL.bronze);
      cylinder(metal, px, g + 6.0, 1.6, 0.55, 0.15, 1.5, 7, PAL.bronze, { top: true });
    }
  }
  // Small shrines and honorific columns along the spina.
  if (detail >= 1) {
    for (let k = 0; k < 6; k++) {
      const px = rng.range(-spinaL * 0.45, spinaL * 0.45);
      if (Math.abs(px) < 18) continue;
      column(stone, px, g + 2.6, rng.jitter(1.6), 0.42, 7.5, 'corinthian', PAL.marble, detail - 1);
    }
  }

  // ---- carceres: twelve starting gates at the flat end ---------------------
  const cx0 = -L / 2 + 6;
  brick.pushTranslate(cx0, 0, 0);
  box(brick, 0, g, -W / 2 - 4, 9, g + 14, W / 2 + 4, PAL.brick, { topGain: 1.08 });
  for (let k = 0; k < 12; k++) {
    const zz = lerp(-W / 2 + 4, W / 2 - 4, k / 11);
    brick.pushTranslate(9, g, zz);
    brick.push(new THREE.Matrix4().makeRotationY(Math.PI / 2));
    archPanel(brick, (W - 8) / 12, 8.5, PAL.travertine, { depth: 3, spring: 4.0, openWidth: 3.2, segments: detail >= 1 ? 7 : 4 });
    brick.pop();
    brick.pop();
  }
  // Towers flanking the carceres. The roof stream needs the same translation as the
  // brick one or every tower cap piles up at the monument's origin.
  const roofSt = batch.s('roof');
  roofSt.pushTranslate(cx0, 0, 0);
  for (const s of [-1, 1]) {
    box(brick, -1, g, s * (W / 2 + 2) - 3, 11, g + 20, s * (W / 2 + 2) + 3, PAL.brick, { topGain: 1.1 });
    roofSt.pushTranslate(5, 0, s * (W / 2 + 2));
    hipRoof(roofSt, 12, 6, g + 20, 2.4, 0.4, PAL.roofTile);
    roofSt.pop();
  }
  roofSt.pop();
  brick.pop();
}

// ---------------------------------------------------------------------------
// Temples
// ---------------------------------------------------------------------------

interface TempleOpts {
  w: number;
  d: number;
  podiumH: number;
  colH: number;
  colR: number;
  colsFront: number;
  colsSide: number;
  porchRows: number;
  order: ColumnOrder;
  roofCol: THREE.Color;
  roofMat: 'roof' | 'metal';
  wallCol: THREE.Color;
  cellae: number;
}

/**
 * A temple roof emitted in tile courses instead of as one plane, with a ridge cap.
 *
 * The Capitoline temple's roof is 53 × 63 m. As a single quad per slope that is 3,300 m² of
 * unmodulated surface, and with gilded bronze's high environment intensity it resolved to a
 * blank cream sheet sitting on the Capitol — the one obviously broken building on the
 * skyline, visible from every city camera. A Roman roof of any material reads as *rows*:
 * banding the slope gives the eye tile courses, a ridge and eaves to hold onto, and the
 * per-course tone variation is what stops a specular surface reading as a mirror. Ridge runs
 * along Z, matching the Italic temple's axial plan.
 *
 * Costs `courses * 4 + 6` triangles — a few dozen — against four for the flat version.
 */
function tiledGable(
  st: GeoStream,
  roofSt: GeoStream,
  w: number,
  d: number,
  baseY: number,
  ridgeH: number,
  overhang: number,
  col: THREE.Color,
  detail: number
): void {
  const ow = w / 2 + overhang;
  const od = d / 2 + overhang;
  // Roman pan-and-cover tiling runs about 0.55 m to a course; below three metres per band
  // the courses stop resolving from any camera that can see the whole roof at once.
  const courses = detail >= 1 ? Math.max(4, Math.min(20, Math.round(ow / 1.9))) : 3;
  const slope = ridgeH / Math.max(0.01, ow);
  const cLo = new THREE.Color();
  const cHi = new THREE.Color();
  for (const sx of [-1, 1]) {
    for (let k = 0; k < courses; k++) {
      const x0 = sx * ow * (1 - k / courses);
      const x1 = sx * ow * (1 - (k + 1) / courses);
      const y0 = baseY + ridgeH * (k / courses);
      const y1 = baseY + ridgeH * ((k + 1) / courses);
      // Alternating courses, plus a gentle darkening toward the eaves where rain and dust
      // collect. Both are small: this is a roof, not a chequerboard.
      const alt = k % 2 === 0 ? 1.0 : 0.93;
      cLo.copy(col).multiplyScalar(alt * (0.9 + 0.1 * (k / courses)));
      cHi.copy(col).multiplyScalar(alt * (1.0 + 0.1 * (k / courses)));
      // Alternate courses are shaded as if tilted 8° toward the eave and toward the ridge.
      // Roman roofing is pan-and-cover: flat *tegulae* with raised semicircular *imbrices*
      // over the joints, so the surface is a sawtooth, not a plane, and shading it as one
      // gives the eye the rows without any extra geometry.
      const tilt = k % 2 === 0 ? 0.14 : -0.14;
      NH.set(sx * (slope + tilt), 1, 0).normalize();
      P0.set(x0, y0, -od);
      P1.set(x0, y0, od);
      P2.set(x1, y1, od);
      P3.set(x1, y1, -od);
      roofSt.quadN(NH, P0, P1, P2, P3, cLo, cLo, cHi, cHi);
    }
    // Gable end, in stone: the tympanum face behind the pediment.
    P0.set(sx * ow, baseY, sx * od);
    P1.set(0, baseY + ridgeH, sx * od);
    P2.set(-sx * ow, baseY, sx * od);
    st.triN(sx > 0 ? PZ : NZ, P0, P1, P2, col);
  }
  // Ridge cap: a run of *imbrices* over the joint, and the strongest line on the roof.
  const cap = new THREE.Color().copy(col).multiplyScalar(1.14);
  box(roofSt, -ow * 0.045, baseY + ridgeH - 0.12, -od, ow * 0.045, baseY + ridgeH + 0.26, od, cap, {
    bottom: false,
  });
}

/**
 * A band of weather staining on the four faces of a square monument.
 *
 * Emitted 30 mm proud of the face it sits on so it needs no z-fight tolerance, and graded
 * from dirty at the wet end to clean at the dry end. `wetAtTop` picks which end that is:
 * true under a cornice, where the water sheds off the overhang and runs back down the wall,
 * false at a plinth, where the road splashes up it.
 */
function dripStain(
  st: GeoStream,
  half: number,
  y0: number,
  height: number,
  base: THREE.Color,
  strength: number,
  wetAtTop: boolean
): void {
  const wet = new THREE.Color().copy(base).multiplyScalar(1 - strength).lerp(PAL.voidWarm, 0.16);
  const dry = new THREE.Color().copy(base).multiplyScalar(1 - strength * 0.16);
  const h = half + 0.03;
  for (const [nx, nz] of [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ]) {
    const ax = nz !== 0 ? -h : nx * h;
    const az = nx !== 0 ? -h : nz * h;
    const bx = nz !== 0 ? h : nx * h;
    const bz = nx !== 0 ? h : nz * h;
    STAIN_N.set(nx, 0, nz);
    P0.set(ax, y0, az);
    P1.set(bx, y0, bz);
    P2.set(bx, y0 + height, bz);
    P3.set(ax, y0 + height, az);
    const lo = wetAtTop ? dry : wet;
    const hi = wetAtTop ? wet : dry;
    st.quadN(STAIN_N, P0, P1, P2, P3, lo, lo, hi, hi);
  }
}

const STAIN_N = new THREE.Vector3();
const PZ = new THREE.Vector3(0, 0, 1);
const NZ = new THREE.Vector3(0, 0, -1);
const P0 = new THREE.Vector3();
const P1 = new THREE.Vector3();
const P2 = new THREE.Vector3();
const P3 = new THREE.Vector3();
const NH = new THREE.Vector3();

/** Italic temple: high podium, frontal steps, deep porch, walled cella. */
function buildTemple(batch: Batch, detail: number, g: number, o: TempleOpts): void {
  const stone = batch.s('stone');
  const roofSt = batch.s(o.roofMat);
  const { w, d, podiumH, colH, colR } = o;

  // Podium with a moulded base and cap.
  box(stone, -w / 2 - 1.4, g - 1.0, -d / 2 - 1.4, w / 2 + 1.4, g + 0.7, d / 2 + 1.4, PAL.travertineDirty, { topGain: 1.06 });
  box(stone, -w / 2 - 0.7, g + 0.7, -d / 2 - 0.7, w / 2 + 0.7, g + podiumH - 0.5, d / 2 + 0.7, PAL.travertine, { topGain: 1.06 });
  box(stone, -w / 2 - 1.2, g + podiumH - 0.5, -d / 2 - 1.2, w / 2 + 1.2, g + podiumH, d / 2 + 1.2, PAL.marbleShadow, { topGain: 1.14 });
  // Frontal steps only — the Italic temple is emphatically axial.
  stone.pushTranslate(0, 0, -d / 2 - 1.4);
  steps(stone, w * 0.72, g - 1.0, 0, Math.max(3, Math.round(podiumH / 0.32)), 0.32, 0.4, PAL.travertineDirty);
  stone.pop();

  const colY = g + podiumH;
  const halfW = w / 2 - colR * 2.2;
  const zFront = -d / 2 + colR * 2.4;
  const spacing = (halfW * 2) / (o.colsFront - 1);
  // Porch colonnade.
  for (let r = 0; r < o.porchRows; r++) {
    for (let i = 0; i < o.colsFront; i++) {
      column(stone, -halfW + spacing * i, colY, zFront + r * spacing * 0.92, colR, colH, o.order, PAL.marble, detail);
    }
  }
  // Cella walls behind the porch.
  const cellaZ0 = zFront + (o.porchRows - 0.5) * spacing * 0.92 + 1.2;
  const cellaZ1 = d / 2 - colR * 1.6;
  box(stone, -halfW - colR, colY, cellaZ0, halfW + colR, colY + colH + 0.6, cellaZ1, o.wallCol, { topGain: 1.06 });
  if (o.cellae === 3 && detail >= 1) {
    // The Capitoline temple's triple cella: two dividing walls read as deep shadow.
    for (const s of [-1, 1]) {
      box(stone, (s * halfW) / 3 - 0.5, colY, cellaZ0 - 0.4, (s * halfW) / 3 + 0.5, colY + colH + 0.7, cellaZ0 + 0.4, PAL.marbleShadow);
    }
    // Three doorways.
    for (const s of [-1, 0, 1]) {
      box(stone, (s * halfW) / 1.6 - 1.6, colY, cellaZ0 - 0.1, (s * halfW) / 1.6 + 1.6, colY + colH * 0.62, cellaZ0 + 0.2, new THREE.Color(0.03, 0.026, 0.02));
    }
  } else if (detail >= 1) {
    box(stone, -2.0, colY, cellaZ0 - 0.1, 2.0, colY + colH * 0.6, cellaZ0 + 0.2, new THREE.Color(0.03, 0.026, 0.02));
  }
  // Engaged pilasters along the cella flanks.
  if (detail >= 1 && o.colsSide > 0) {
    for (let i = 0; i < o.colsSide; i++) {
      const zz = lerp(cellaZ0 + 1.5, cellaZ1 - 1.5, i / Math.max(1, o.colsSide - 1));
      for (const s of [-1, 1]) {
        column(stone, s * (halfW + colR * 0.4), colY, zz, colR * 0.72, colH, o.order, PAL.marbleShadow, detail - 1);
      }
    }
  }

  // Entablature: architrave, frieze, cornice.
  const entY = colY + colH;
  box(stone, -w / 2 - 0.2, entY, -d / 2 - 0.2, w / 2 + 0.2, entY + colR * 1.1, d / 2 + 0.2, PAL.marble, { topGain: 1.1 });
  box(stone, -w / 2 - 0.5, entY + colR * 1.1, -d / 2 - 0.5, w / 2 + 0.5, entY + colR * 2.4, d / 2 + 0.5, PAL.marbleShadow, { topGain: 1.14 });
  box(stone, -w / 2 - 1.1, entY + colR * 2.4, -d / 2 - 1.1, w / 2 + 1.1, entY + colR * 3.0, d / 2 + 1.1, PAL.marble, { topGain: 1.2 });

  const roofBase = entY + colR * 3.0;
  pediment(stone, w + 2.2, roofBase, d + 2.2, PAL.marble, 0.24);
  tiledGable(stone, roofSt, w + 1.0, d + 1.0, roofBase, ((w + 2.2) / 2) * 0.24, 0.5, o.roofCol, detail);
  // Acroteria on the ridge and the pediment corners.
  if (detail >= 1) {
    const metal = batch.s('metal');
    const apex = roofBase + ((w + 2.2) / 2) * 0.24;
    // A quadriga on the Capitoline; a simple finial elsewhere.
    if (o.cellae === 3) {
      for (let k = 0; k < 4; k++) {
        const hx = (k - 1.5) * 1.7;
        box(metal, hx - 0.55, apex, -d / 2 - 1.0, hx + 0.55, apex + 2.1, -d / 2 + 1.4, PAL.gilt);
        box(metal, hx - 0.4, apex + 2.1, -d / 2 - 0.5, hx + 0.4, apex + 3.0, -d / 2 + 0.9, PAL.gilt);
      }
      box(metal, -1.6, apex + 1.2, -d / 2 + 1.6, 1.6, apex + 3.4, -d / 2 + 3.4, PAL.gilt);
    } else {
      cone(metal, 0, apex, -d / 2 - 0.4, 0.7, 2.0, 8, PAL.bronze, PAL.gilt);
    }
  }
}

// ---------------------------------------------------------------------------
// Mausoleum of Augustus
// ---------------------------------------------------------------------------

/**
 * 87 m in diameter and about 42 m tall: concentric travertine drums retaining an
 * earth tumulus planted with evergreens, a bronze statue of Augustus on the summit,
 * and a pair of obelisks flanking the entrance on the south side.
 */
function buildMausoleum(batch: Batch, detail: number, g: number, rng: Rng): void {
  const stone = batch.s('stone');
  const metal = batch.s('metal');
  const rOut = MAUS_R;
  const seg = detail >= 1 ? 36 : 16;
  const drums = MAUS_DRUMS;
  const terraces = mausoleumTerraces(g);
  cylinder(stone, 0, g - 1.4, 0, rOut + 2.4, rOut + 1.9, 1.7, seg, PAL.travertineDirty, { top: true });
  let y = g + 0.3;
  for (let d = 0; d < drums.length; d++) {
    const dr = drums[d];
    // Ashlar drum, battered slightly, with pilaster strips breaking the curve.
    cylinder(stone, 0, y, 0, dr.r, dr.r * 0.99, dr.h, seg, PAL.travertineDirty, { shadeLow: 0.24 });
    if (detail >= 1) {
      // Shallow blind pilasters, recessed rather than applied: a ring of projecting
      // half-columns on an 87 m drum reads as gear teeth from above.
      const nP = Math.max(10, Math.round(dr.r * 0.5));
      for (let i = 0; i < nP; i++) {
        const a = (Math.PI * 2 * i) / nP;
        cylinder(stone, 0, y + dr.h * 0.12, 0, dr.r * 0.985, dr.r * 0.985, dr.h * 0.76, 3, PAL.travertineDirty, {
          arcFrom: a - 0.055,
          arcTo: a + 0.055,
        });
      }
    }
    // Heavy projecting cornice: without it a drum this big reads as a silo.
    cylinder(stone, 0, y + dr.h, 0, dr.r + 0.85, dr.r + 0.85, 1.0, seg, PAL.travertine, { top: true });
    cylinder(stone, 0, y + dr.h + 1.0, 0, dr.r + 0.5, dr.r + 0.5, 0.35, seg, PAL.travertine, { top: true });
    // Planted earth terrace behind it.
    const t = terraces[d];
    // Planted earth, not paving: the terraces of the Mausoleum were a grove.
    ringDisc(stone, t.rOut, t.rIn, t.y, seg, new THREE.Color().copy(PAL.dust).multiplyScalar(0.62).lerp(PAL.vine, 0.34));
    y = t.y;
  }
  // Summit tumulus over the innermost drum, then the pillar and the bronze statue.
  const summit = y;
  dome(stone, 0, summit, 0, drums[2].r * 0.94, seg, detail >= 1 ? 6 : 3, new THREE.Color().copy(PAL.dust).multiplyScalar(0.66).lerp(PAL.vine, 0.3), { heightScale: 0.24 });
  const pillarY = summit + drums[2].r * 0.94 * 0.24 - 0.5;
  cylinder(stone, 0, pillarY, 0, 4.6, 4.2, 5.2, detail >= 1 ? 18 : 8, PAL.marble, { top: true });
  cylinder(stone, 0, pillarY + 5.2, 0, 5.1, 5.1, 0.6, detail >= 1 ? 18 : 8, PAL.marbleShadow, { top: true });
  // 42 m overall to the head of the colossal bronze Augustus.
  statue(metal, 0, pillarY + 5.8, 0, 4.6, PAL.bronze, Math.PI, detail >= 1 ? 8 : 5);

  // Entrance on the south, flanked by the pair of red granite obelisks.
  stone.pushTranslate(0, g + 0.3, rOut - 0.4);
  stone.push(new THREE.Matrix4().makeRotationY(Math.PI));
  archPanel(stone, 13, 10.5, PAL.travertine, {
    depth: 4.0,
    spring: 3.8,
    openWidth: 3.6,
    segments: detail >= 1 ? 10 : 5,
    archivolt: 0.34,
    voidCol: new THREE.Color(0.03, 0.028, 0.024),
  });
  stone.pop();
  stone.pop();
  // The pair of red granite obelisks flanking that entrance.
  //
  // They stood at `rOut + 9` on a plinth `0.8 * 2.4` half-wide, i.e. 54.4 m from the centre
  // of an 87 m tomb: 1.25 of the footprint the sim reserves, and the two of them were the
  // only stone this monument drew outside its own plot. They are brought in so the outer
  // face of each plinth lands exactly on the tumulus's own 43.5 m radius — and moved out
  // along the façade from ±12 to ±18, because at ±12 the drum's own curve is at z = 41.8 and
  // an obelisk pulled back to 41.6 would be buried in it. At ±18 the drum is at 39.6 and the
  // plinth clears it by a few centimetres, so the pair still stands free on the socle and
  // still reads as flanking the door, only a little wider apart.
  const obBase = 0.8;
  for (const s2 of [-1, 1]) {
    stone.pushTranslate(s2 * 18, 0, rOut - obBase * 2.4);
    buildObelisk(batch, detail, g, 9.2, obBase);
    stone.pop();
  }
}

/** Flat annulus — planted terraces, colonnade floors, tomb platforms. */
function ringDisc(st: GeoStream, rOut: number, rIn: number, y: number, seg: number, col: THREE.Color): void {
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const p3 = new THREE.Vector3();
  const nrm = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Vector3();
  for (let i = 0; i < seg; i++) {
    const a0 = (Math.PI * 2 * i) / seg;
    const a1 = (Math.PI * 2 * (i + 1)) / seg;
    if (rIn <= 0.01) {
      c.set(0, y, 0);
      p1.set(Math.cos(a0) * rOut, y, Math.sin(a0) * rOut);
      p2.set(Math.cos(a1) * rOut, y, Math.sin(a1) * rOut);
      st.triN(nrm, c, p1, p2, col);
      continue;
    }
    p0.set(Math.cos(a0) * rOut, y, Math.sin(a0) * rOut);
    p1.set(Math.cos(a1) * rOut, y, Math.sin(a1) * rOut);
    p2.set(Math.cos(a1) * rIn, y, Math.sin(a1) * rIn);
    p3.set(Math.cos(a0) * rIn, y, Math.sin(a0) * rIn);
    st.quadN(nrm, p0, p1, p2, p3, col);
  }
}

// ---------------------------------------------------------------------------
// Trajan's Column
// ---------------------------------------------------------------------------

/**
 * The shaft with base and capital is 29.78 m — exactly 100 Roman feet, which is what
 * the inscription's *ad declarandum quantae altitudinis* refers to — 3.7 m in
 * diameter, on a 5.4 m pedestal, with a gilt-bronze statue on top: 35.07 m overall.
 */
function buildTrajansColumn(batch: Batch, detail: number, g: number): void {
  const stone = batch.s('stone');
  const metal = batch.s('metal');
  const seg = detail >= 1 ? 20 : 10;
  const r = 1.85;

  box(stone, -3.4, g, -3.4, 3.4, g + 4.4, 3.4, PAL.marble, { topGain: 1.08 });
  box(stone, -3.9, g + 4.4, -3.9, 3.9, g + 5.4, 3.9, PAL.marbleShadow, { topGain: 1.16 });
  cylinder(stone, 0, g + 5.4, 0, r * 1.24, r * 1.1, 1.0, seg, PAL.marble);
  // Shaft. The helical relief is suggested by a shallow spiral step, which is all
  // that survives the distance anyway.
  const shaftH = 26.5;
  const turns = 23;
  const bands = detail >= 2 ? turns * 3 : detail === 1 ? turns : 4;
  for (let i = 0; i < bands; i++) {
    const y0 = g + 6.4 + (shaftH * i) / bands;
    const h = shaftH / bands;
    const rr = r * (1 - (i / bands) * 0.05) * (i % 3 === 1 ? 0.985 : 1);
    cylinder(stone, 0, y0, 0, rr, rr, h, seg, i % 3 === 1 ? PAL.marbleShadow : PAL.marble);
  }
  cylinder(stone, 0, g + 6.4 + shaftH, 0, r * 1.05, r * 1.3, 1.6, seg, PAL.marble);
  box(stone, -2.7, g + 8.0 + shaftH, -2.7, 2.7, g + 8.8 + shaftH, 2.7, PAL.marble, { topGain: 1.18 });
  // Gilt bronze Trajan: 35.07 m to the top of the head.
  statue(metal, 0, g + 8.8 + shaftH, 0, 3.5, PAL.gilt, Math.PI, seg);
}

// ---------------------------------------------------------------------------
// Theatres and the Stadium
// ---------------------------------------------------------------------------

/**
 * Roman theatre: semicircular cavea, arcaded exterior, scaenae frons, and the scaena building
 * behind it.
 *
 * `backZ` is the theatre's own rear face in its local frame — the far side of the published
 * footprint. Without it this builder drew a cavea and a screen and stopped: for the Theatre of
 * Marcellus that is 115 x 77 m inside a published 130 x 115, so the drawn ASPECT came out 1.48
 * against a published 1.13 and `probe-fabric` G12 — a scale-free check that no plan compression
 * can flatter — had nothing to hold on to. The depth was previously made up by a quadriporticus
 * this builder had no business drawing (see the note where it used to be), which is the worst
 * way for a number to be right.
 */
function buildTheatre(batch: Batch, detail: number, g: number, radius: number, height: number, bays: number, storeys: number, backZ: number): void {
  const stone = batch.s('stone');
  const concrete = batch.s('stone');
  const brick = batch.s('brick');
  const nb = detail >= 1 ? bays : Math.round(bays / 2);
  const storeyH = height / (storeys + 0.5);

  // Arcaded curved façade. The convex back of the cavea faces −Z, toward the viewer.
  for (let s = 0; s < storeys; s++) {
    const y = g + storeyH * s;
    const rr = radius - s * 0.5;
    for (let i = 0; i < nb; i++) {
      const a0 = Math.PI + (Math.PI * i) / nb;
      const a1 = Math.PI + (Math.PI * (i + 1)) / nb;
      const am = (a0 + a1) / 2;
      const bw = 2 * rr * Math.sin(Math.PI / (2 * nb));
      const px = Math.cos(am) * rr;
      const pz = Math.sin(am) * rr;
      stone.push(new THREE.Matrix4().makeRotationY(-am + Math.PI * 0.5).setPosition(px, y, pz));
      if (s < storeys - 1 || storeys === 1) {
        archPanel(stone, bw + 0.05, storeyH, PAL.travertineDirty, {
          depth: 3.6,
          spring: storeyH * 0.42,
          openWidth: Math.min(bw * 0.6, storeyH * 0.5),
          segments: detail >= 2 ? 8 : 4,
          archivolt: detail >= 2 ? 0.16 : 0,
        });
        if (detail >= 1) column(stone, bw / 2, 0, -0.5, 0.5, storeyH - 1.1, s === 0 ? 'tuscan' : s === 1 ? 'ionic' : 'corinthian', PAL.travertine, detail - 1);
      } else {
        box(stone, -bw / 2, 0, 0, bw / 2, storeyH, 3.6, PAL.travertine, { topGain: 1.1 });
      }
      stone.pop();
    }
  }
  // Attic and cornice.
  const atticY = g + storeyH * storeys;
  for (let i = 0; i < nb; i++) {
    const a0 = Math.PI + (Math.PI * i) / nb;
    const a1 = Math.PI + (Math.PI * (i + 1)) / nb;
    const am = (a0 + a1) / 2;
    const bw = 2 * radius * Math.sin(Math.PI / (2 * nb));
    brick.push(new THREE.Matrix4().makeRotationY(-am + Math.PI * 0.5).setPosition(Math.cos(am) * radius, atticY, Math.sin(am) * radius));
    box(brick, -bw / 2, 0, 0, bw / 2, storeyH * 0.5, 3.6, PAL.brick, { topGain: 1.14 });
    brick.pop();
  }

  // Cavea seating inside. Deep maenianum steps with two praecinctiones, for the same
  // reason as the amphitheatre's: 28 thin rings alias into shimmering corduroy at any
  // distance from which the whole cavea is in frame.
  const orchR = radius * 0.3;
  ellipseCavea(concrete, orchR + 2.5, orchR + 2.5, radius - 4.5, radius - 4.5, g + 3.4, g + height - 4, Math.PI, Math.PI * 2, {
    rows: detail >= 1 ? 12 : 5,
    seg: detail >= 1 ? 30 : 14,
    breaks: detail >= 1 ? [4, 8] : [],
    balteus: 1.5,
    scalaria: detail >= 2 ? 11 : 0,
    tread: new THREE.Color().copy(PAL.travertineDirty).multiplyScalar(1.06),
    riser: new THREE.Color().copy(PAL.travertineDirty).multiplyScalar(0.72),
    salt: Math.round(radius),
  });
  // The *balteus* wall round the orchestra, and the orchestra's own marble paving.
  ellipseRing(concrete, orchR + 2.5, orchR + 2.5, orchR, orchR, g + 2.4, 1.4, detail >= 1 ? 24 : 12, PAL.marble);
  concrete.pushTranslate(0, 0, 0);
  pavedEllipse(concrete, orchR, orchR, g + 2.4, detail >= 1 ? 3 : 1, detail >= 1 ? 22 : 10, PAL.marbleShadow, Math.round(radius) * 7, 0.12);
  concrete.pop();
  // *Pulpitum*: the raised stage platform.
  box(concrete, -radius * 0.72, g + 2.4, 0, radius * 0.72, g + 4.0, radius * 0.2, PAL.marbleShadow, { topGain: 1.1 });

  // ---- scaenae frons -------------------------------------------------------
  //
  // Not a slab. A Roman stage building is an articulated screen: three storeys of
  // projecting and receding *aediculae* with columns in front of them, and a roof over
  // the stage. The previous revision emitted one 117 × 30 × 4.5 m box, which from any
  // aerial camera read as a grey concrete bridge dropped across the theatre and was the
  // ugliest object in the city.
  const sfY = g + 4.0;
  const sfTop = g + height * 0.94;
  const sfZ = radius * 0.2;
  const sfHalf = radius * 0.78;
  const bays2 = Math.max(5, Math.round(sfHalf / 7));
  const roofSt = batch.s('roof');
  for (let i = 0; i < bays2; i++) {
    const x0 = lerp(-sfHalf, sfHalf, i / bays2);
    const x1 = lerp(-sfHalf, sfHalf, (i + 1) / bays2);
    // Alternating projection: the three great doorways (*valva regia* and *hospitalia*)
    // sit in recesses, the piers between them come forward.
    const isDoor = i === Math.floor(bays2 / 2) || i === 1 || i === bays2 - 2;
    const proj = isDoor ? 0 : 2.6;
    const h = isDoor ? sfTop - sfY - 3.5 : sfTop - sfY;
    box(stone, x0, sfY, sfZ, x1, sfY + h, sfZ + 4.6 + proj, PAL.marbleShadow, { topGain: 1.08 });
    if (isDoor && detail >= 1) {
      stone.push(new THREE.Matrix4().makeRotationY(Math.PI).setPosition((x0 + x1) / 2, sfY, sfZ + 0.1));
      archPanel(stone, x1 - x0 - 0.4, h, PAL.marble, {
        depth: 1.4,
        spring: h * 0.44,
        openWidth: Math.min((x1 - x0) * 0.52, h * 0.4),
        segments: detail >= 2 ? 8 : 4,
        voidCol: PAL.voidDark,
      });
      stone.pop();
    }
    // Columnar orders in front, two storeys, as at Orange and Sabratha.
    if (detail >= 1) {
      for (const px of [x0 + (x1 - x0) * 0.22, x0 + (x1 - x0) * 0.78]) {
        column(stone, px, sfY, sfZ + 4.6 + proj + 0.7, 0.52, 10.5, 'corinthian', PAL.marble, detail - 1);
        column(stone, px, sfY + 11.6, sfZ + 4.6 + proj + 0.7, 0.44, 9.0, 'corinthian', PAL.marble, detail - 1);
      }
      box(stone, x0, sfY + 10.5, sfZ + 4.6 + proj, x1, sfY + 11.6, sfZ + 6.4 + proj, PAL.marble, { topGain: 1.14 });
    }
  }
  // Tiled roof over the stage, sloping back over the scene building.
  box(roofSt, -sfHalf - 1, sfTop, sfZ - 1, sfHalf + 1, sfTop + 1.1, sfZ + 9, PAL.roofTile, { topGain: 1.12 });

  /**
   * The *postscaenium*: the scaena building behind the frons, out to the published rear face.
   *
   * This is the half of a Roman theatre that a plan of one is mostly made of and that this
   * builder did not have — the dressing rooms, the corridors and the buttressed back wall that
   * closed the building against the street. It carries the difference between the frons and
   * `backZ`, so the drawn footprint fills the published rectangle instead of ending at the
   * screen. Brick with a tiled roof, deliberately plain: the articulation is all on the frons,
   * facing the audience, and the back of a scaena is a wall.
   *
   * Guarded rather than assumed: a row whose published depth barely clears the frons gets
   * nothing, and cannot get a block of negative depth.
   */
  const scaenaFront = sfZ + 4.6 + 2.6;
  if (backZ > scaenaFront + 5) {
    const psHalf = radius * 0.92;
    const psH = height * 0.68;
    box(brick, -psHalf, g, scaenaFront, psHalf, g + psH, backZ, PAL.brick, {
      topGain: 1.05,
      groundShade: 0.15,
    });
    // The buttress piers that took the thrust of the frons, and the one thing that stops a
    // 50 m wall reading as a slab from the air.
    if (detail >= 1) {
      const n = Math.max(4, Math.round((psHalf * 2) / 11));
      for (let i = 0; i <= n; i++) {
        const px = lerp(-psHalf, psHalf, i / n);
        box(brick, px - 1.1, g, backZ - 2.2, px + 1.1, g + psH * 0.92, backZ, PAL.brickPale, { topGain: 1.08 });
      }
    }
    box(roofSt, -psHalf - 0.8, g + psH, scaenaFront, psHalf + 0.8, g + psH + 1.2, backZ, PAL.roofTile, { topGain: 1.1 });
  }

  /**
   * **There is deliberately no porticus post scaenam here, and there was one.**
   *
   * This builder used to draw the *quadriporticus* behind the stage unconditionally: a
   * colonnade at `sfZ + 11` running back `radius * 0.9`, with a planted court inside it.
   * Both of Rome's theatres are the wrong place for it, and for the same reason — **the
   * survey already carries the porticus as its own row.**
   *
   *  - The Theatre of Pompey's porticus post scaenam is `porticus-pompei`, 180 x 135 m,
   *    drawn by `buildPrecinct`. `ROME-FABRIC.md` §8.2 split that row off the theatre on
   *    purpose: *"Now the theatre proper, with `porticus-pompei` as its other half."* So the
   *    map was drawing the Porticus Pompei **twice**, once as a monument and once inside the
   *    theatre's own footprint, and the second copy reached 94.1 m from the theatre's centre
   *    against a published half-depth of 80 — `probe-fabric` G14, and the largest single
   *    overhang on the map after the Capitoline mound.
   *  - The Theatre of Marcellus never had one. It stood hemmed in between the Forum
   *    Holitorium and the Porticus Octaviae, which is `porticus-octaviae`, also its own row.
   *
   * A builder that draws its neighbour is worse than one that draws too much: the stone is
   * correct architecture standing in a place the plan has already allocated to the thing it
   * is a copy of. Deleted rather than parameterised, because no row in this survey wants it —
   * and the note stays so it is not helpfully restored. If a third theatre ever needs one, it
   * belongs in the survey as a row with a published dimension, like the other two.
   */
}

/** Domitian's stadium: a U-plan arcaded track for Greek athletics. */
function buildStadium(batch: Batch, detail: number, g: number, L: number, W: number, rng: Rng): void {
  const stone = batch.s('stone');
  const concrete = batch.s('stone');
  const seatDepth = 22;
  const facadeH = 22;
  const tiers = detail >= 1 ? 18 : 8;

  /**
   * **The U is not symmetric about its own centre, and it used to be drawn as if it were.**
   *
   * A stadium is a straight run closed at one end by a semicircular *sphendone*. The straight
   * arcade was drawn symmetric about `x = 0` with half-length `(L - 60) / 2`, and then the
   * sphendone was pushed to `-bankLen` and given its own outer radius on top — so the drawn
   * envelope ran from `-(bankLen + sphR)` to `+bankLen`, which for the Stadium of Domitian is
   * **-157.5 to +107.5 against a published half-length of 137.5**. Twenty metres of cavea
   * outside the footprint at one end, twenty metres of unused ground at the other, and the
   * whole 265 m mass sitting 25 m north of the rectangle the sim collides with.
   *
   * So the sphendone's radius comes out of the straight run rather than being added to it,
   * and the whole plan is shifted by half of it, which puts the envelope on the box: the
   * closed end lands on `-L/2` and the open end on `+L/2` exactly.
   */
  const sphR = W / 2 - 3;
  const bankLen = (L - sphR) / 2;
  stone.pushTranslate(sphR / 2, 0, 0);
  concrete.pushTranslate(0, 0, 0);
  pavedField(concrete, bankLen, W / 2 - seatDepth, g + 0.08, 12, PAL.dust, 0x71c3, 0.18);
  concrete.pop();
  for (const s of [-1, 1] as const) {
    const bays = detail >= 1 ? 34 : 14;
    const bw = (bankLen * 2) / bays;
    stone.push(new THREE.Matrix4().makeRotationY(s > 0 ? Math.PI : 0).setPosition(0, g, (s * W) / 2));
    arcade(stone, bays, bw, facadeH * 0.55, PAL.travertine, {
      depth: 3.2,
      spring: 4.4,
      openWidth: Math.min(3.8, bw * 0.6),
      segments: detail >= 2 ? 8 : 4,
      archivolt: detail >= 2 ? 0.18 : 0,
    });
    // Second storey: a colonnaded gallery, which is how the Severan plan's fragment of
    // the stadium shows it, rather than a blank attic.
    box(stone, -bankLen, facadeH * 0.55, 0, bankLen, facadeH * 0.66, 3.2, PAL.travertineDirty, { topGain: 1.1 });
    if (detail >= 1) {
      for (let i = 0; i <= bays; i++) {
        column(stone, -bankLen + bw * i, facadeH * 0.66, 1.4, 0.4, facadeH * 0.28, 'ionic', PAL.travertine, detail - 1);
      }
    }
    box(stone, -bankLen, facadeH * 0.94, -0.3, bankLen, facadeH, 3.5, PAL.travertine, { topGain: 1.14 });
    stone.pop();

    // Straight-side seating. A stadium's long sides are straight; they need steps, not
    // an arc — an earlier revision called the annular `seatingBank` here with two
    // angular segments and drew a single 200 m wedge across the arena, which is why the
    // Stadium of Domitian read as a grey circus tent on the skyline.
    straightCavea(concrete, bankLen, s * (W / 2 - seatDepth), seatDepth - 3, g + 2, g + facadeH - 4, s, {
      rows: detail >= 1 ? 9 : 4,
      seg: 0,
      breaks: detail >= 1 ? [4] : [],
      balteus: 1.3,
      tread: PAL.travertineDirty,
      riser: new THREE.Color().copy(PAL.travertineDirty).multiplyScalar(0.72),
      salt: s > 0 ? 0x81 : 0x82,
    });
  }
  // The *sphendone*: the semicircular closed end, at the north end of the track rather
  // than wrapped round the middle of it.
  concrete.pushTranslate(-bankLen, 0, 0);
  ellipseCavea(
    concrete,
    W / 2 - seatDepth,
    W / 2 - seatDepth,
    sphR,
    sphR,
    g + 2,
    g + facadeH - 4,
    Math.PI / 2,
    Math.PI * 1.5,
    {
      rows: detail >= 1 ? 9 : 4,
      seg: detail >= 1 ? 18 : 8,
      breaks: detail >= 1 ? [4] : [],
      balteus: 1.3,
      scalaria: detail >= 2 ? 6 : 0,
      tread: PAL.travertineDirty,
      riser: new THREE.Color().copy(PAL.travertineDirty).multiplyScalar(0.72),
      salt: 0x83,
    }
  );
  concrete.pop();
  stone.pop();
  void tiers;
}

// ---------------------------------------------------------------------------
// Basilica, Forum, Baths, Castra
// ---------------------------------------------------------------------------

/**
 * Basilica Ulpia: a 130 × 55 m hall with apses at both ends and a bronze roof.
 *
 * **`L` is the outer extent, apses included, and that is a change.** The two apses are
 * half-cylinders of radius `W * 0.36` — 19.8 m on a 55 m hall — and they used to be centred
 * *on* the end walls at `±L/2`, so they added their whole radius to each end and the
 * building drew 169.6 m in a 130 m footprint: 1.386 of the box the sim collides with, and
 * 19.8 m per end of marble standing in the street. The survey's own cite is unambiguous
 * that this is not what the number means — "130 × 55 m **with apses at both ends**" — so the
 * hall proper is `L - 2 * W * 0.36` and the apses fill the difference.
 */
function buildBasilica(batch: Batch, detail: number, g: number, L: number, W: number): void {
  const stone = batch.s('stone');
  const metal = batch.s('metal');
  const navH = 26;
  // The apse radius, and what is left for the hall between the two of them.
  const apseR = W * 0.36;
  const hl = L / 2 - apseR;

  // The stylobate is the full published rectangle: it is the platform both the hall and the
  // apses stand on, and its corners are the plinth either side of each apse's curve.
  box(stone, -L / 2, g - 0.6, -W / 2, L / 2, g + 1.4, W / 2, PAL.travertineDirty, { topGain: 1.06 });
  // Aisle walls with engaged columns; the nave rises above them.
  box(stone, -hl, g + 1.4, -W / 2, hl, g + 13.5, W / 2, PAL.marbleShadow, { topGain: 1.06 });
  box(stone, -hl + 6, g + 13.5, -W / 2 + 9, hl - 6, g + navH, W / 2 - 9, PAL.marble, { topGain: 1.06 });
  if (detail >= 1) {
    const n = Math.round((hl * 2) / 7);
    for (let i = 0; i < n; i++) {
      const px = lerp(-hl + 4, hl - 4, i / (n - 1));
      for (const s of [-1, 1]) column(stone, px, g + 1.4, (s * W) / 2 + s * 0.4, 0.62, 11.5, 'corinthian', PAL.marble, detail - 1);
      // Clerestory windows above the aisle roofs.
      box(stone, px - 1.4, g + 16, -W / 2 + 8.8, px + 1.4, g + 21, -W / 2 + 9.2, new THREE.Color(0.05, 0.045, 0.04));
      box(stone, px - 1.4, g + 16, W / 2 - 9.2, px + 1.4, g + 21, W / 2 - 8.8, new THREE.Color(0.05, 0.045, 0.04));
    }
  }
  // Apses, standing off the ends of the hall and reaching exactly ±L/2.
  for (const s of [-1, 1]) {
    cylinder(stone, s * hl, g + 1.4, 0, apseR, apseR, 15, detail >= 1 ? 16 : 8, PAL.marbleShadow, {
      arcFrom: s < 0 ? Math.PI * 0.5 : -Math.PI * 0.5,
      arcTo: s < 0 ? Math.PI * 1.5 : Math.PI * 0.5,
    });
    dome(metal, s * hl, g + 16.4, 0, apseR, detail >= 1 ? 16 : 8, 5, PAL.bronze, { heightScale: 0.55 });
  }
  // Gilt-bronze tiled roofs: the aisles low, the nave high.
  gableRoof(stone, metal, hl * 2 - 12, W - 18, g + navH, 4.5, 1.0, PAL.bronze, true);
  for (const s of [-1, 1]) {
    const z0 = (s * (W / 2 + W / 2 - 9)) / 2;
    box(metal, -hl, g + 13.5, Math.min(z0, (s * W) / 2), hl, g + 14.0, Math.max(z0, (s * W) / 2), PAL.bronze);
  }
}

/**
 * The Forum Romanum: a paved square 200 × 90 m running NW–SE between the Capitoline and
 * the Velia, closed by porticoes on the long sides, with the Rostra and the Arch of
 * Septimius Severus at the Capitoline end and a temple at the other.
 *
 * `L` runs along local +X, which is the monument's long axis — the same convention every
 * other builder here uses, and the axis `worldRot` orients.
 */
function buildForum(batch: Batch, detail: number, g: number, rng: Rng): void {
  const stone = batch.s('stone');
  const road = batch.s('road');
  const L = 200;
  const W = 90;
  // **`W` is the outer face of the built edge, and it used not to be.**
  //
  // The square was drawn outward from `W`: the colonnade stood *on* `±W/2` with 9 m of
  // lean-to roof beyond it, and the two basilica ranges were then hung a further 20 m
  // outside that, at `±(W/2 + 20)` with a hipped roof on top, reaching ±75.9 against a
  // half-width of 45. That is 1.79 of the footprint the sim collides with — the widest
  // mismatch in the city and about 12,000 m² of marble hall standing on ground the insula
  // generator was free to build on. So the 90 m is now everything: the ranges' outer walls
  // land on it, the portico stands in front of them, and the open square is what is left.
  // The square loses width (44 m between the colonnades against 90) and that is the honest
  // reading of the row, whose cite gives 200 × 90 for "the open square ... from the Rostra
  // to the Regia" and reserves no ground at all for the halls that walled it.
  const rangeD = 14; // depth of the basilica ranges, the outermost thing here
  const porticoD = 9; // colonnade line to the range's front wall, i.e. the lean-to's span
  const rangeZ = W / 2 - rangeD / 2; // range centre
  const colZ = W / 2 - rangeD - porticoD; // colonnade line

  // Paved piazza, in slabs. As one quad it was 18,000 m² of unmodulated tan and the
  // largest featureless region in any strategic frame. Still the full rectangle: the
  // ranges and the porticoes stand *on* the paving, as they did.
  pavedField(road, L / 2, W / 2, g + 0.12, 5.5, PAL.marbleShadow, 0x40c1, 0.2);

  // Porticoes down both long sides, two columns deep with a tiled lean-to roof that runs
  // back from the colonnade to the basilica wall behind it.
  const colH = 8.6;
  for (const side of [-1, 1] as const) {
    const n = Math.round(L / 5.4);
    for (let i = 0; i < n; i++) {
      const px = lerp(-L / 2 + 3, L / 2 - 3, i / (n - 1));
      column(stone, px, g + 0.7, side * colZ, 0.5, colH, 'corinthian', PAL.marble, detail - 1);
      if (detail >= 1) column(stone, px, g + 0.7, side * (colZ + 7), 0.5, colH, 'corinthian', PAL.marbleShadow, detail - 1);
    }
    box(stone, -L / 2, g + 0.7 + colH, side * (colZ - 0.9), L / 2, g + 0.7 + colH + 1.9, side * (colZ + 8.2), PAL.marble, {
      topGain: 1.12,
    });
    box(batch.s('roof'), -L / 2, g + 0.7 + colH + 1.9, side * (colZ - 1.2), L / 2, g + 0.7 + colH + 3.4, side * (colZ + porticoD), PAL.roofTile, {
      topGain: 1.1,
    });
  }

  // The Temple of Divus Iulius closing the south-east end, facing back down the square.
  stone.pushTranslate(L / 2 - 26, 0, 0);
  stone.push(new THREE.Matrix4().makeRotationY(Math.PI / 2));
  buildTemple(batch, detail, g, {
    w: 30,
    d: 44,
    podiumH: 3.6,
    colH: 12.5,
    colR: 0.68,
    colsFront: 6,
    colsSide: 5,
    porchRows: 2,
    order: 'corinthian',
    roofCol: PAL.bronze,
    roofMat: 'roof',
    wallCol: PAL.marble,
    cellae: 1,
  });
  stone.pop();
  stone.pop();

  // The Rostra, the honorific columns of the Comitium end, and the triumphal arch.
  box(stone, -L / 2 + 8, g + 0.12, -18, -L / 2 + 17, g + 3.2, 18, PAL.marbleShadow, { topGain: 1.1 });
  if (detail >= 1) {
    for (let i = 0; i < 7; i++) {
      const pz = lerp(-colZ + 3, colZ - 3, i / 6);
      column(stone, -L / 2 + 26, g + 0.12, pz, 0.55, 11.5, 'corinthian', PAL.marble, detail - 1);
      statue(batch.s('metal'), -L / 2 + 26, g + 12.5, pz, 3.0, PAL.gilt, Math.PI * 0.5, detail >= 1 ? 7 : 5);
    }
    // Triumphal arch on the axis, at the foot of the Capitol.
    stone.pushTranslate(-L / 2 - 4, 0, 0);
    stone.push(new THREE.Matrix4().makeRotationY(Math.PI / 2));
    archPanel(stone, 22, 18, PAL.marble, { depth: 7, spring: 7.5, openWidth: 6.6, segments: detail >= 2 ? 12 : 6, backFace: true, archivolt: 0.4 });
    box(stone, -11.6, g + 18, -0.7, 11.6, g + 22, 7.7, PAL.marble, { topGain: 1.14 });
    for (let k = 0; k < 4; k++) {
      const hx = (k - 1.5) * 2.0;
      box(batch.s('metal'), hx - 0.7, g + 22, 2.2, hx + 0.7, g + 24.6, 4.4, PAL.gilt);
    }
    stone.pop();
    stone.pop();
  }
  // The Basilica Aemilia and the Basilica Iulia, the two long halls that actually walled
  // the square in; without them the forum reads as a bare slab with a colonnade. They are
  // now the square's outer wall rather than a pair of blocks hung outside it: the hipped
  // roof is given `rangeD - 1.8` so that with its 0.9 m eaves it lands exactly on `±W/2`.
  // Fifteen metres tall against the portico's 12.7, so the hall still rises behind it.
  for (const side of [-1, 1] as const) {
    const bz = side * rangeZ;
    box(stone, -L / 2 + 20, g, bz - side * (rangeD / 2), L / 2 - 40, g + 15, bz + side * (rangeD / 2), PAL.marbleShadow, { topGain: 1.06 });
    const roof = batch.s('roof');
    roof.pushTranslate((-L / 2 + 20 + L / 2 - 40) / 2, 0, bz);
    hipRoof(roof, L - 60, rangeD - 1.8, g + 15, 3.4, 0.9, PAL.roofTileOld);
    roof.pop();
  }
  void rng;
}

/**
 * Imperial baths: a vaulted block in a walled precinct.
 *
 * `W` runs along local X (the long axis of the precinct), `D` across it. The plan is the
 * one every great *thermae* shares, and it is what makes them recognisable from the air:
 *
 *  - a rectangular precinct wall carrying exedrae and a monumental entrance, with the
 *    *cisterns* along the back;
 *  - inside it, the bathing block on the cross axis — *natatio* (open-air pool) at the cool
 *    end, *frigidarium* under three great cross-vaults in the middle, *tepidarium*, then the
 *    domed *caldarium* projecting on the sunny side;
 *  - a colonnaded *palaestra* either flank of the block;
 *  - the whole precinct paved, with gardens between the wall and the block.
 *
 * An earlier revision emitted a plain 165 × 95 × 22 m brick box with three bare half-cylinders
 * on top inside a thin 8.5 m fence, standing on unpaved terrain. From a strategic camera that
 * is a farmyard with three sheds in it, and it was the single ugliest object in the city.
 */
function buildBaths(batch: Batch, detail: number, g: number, wOuter: number, dOuter: number, rng: Rng): void {
  /**
   * **`wOuter` / `dOuter` are the OUTER envelope, and the precinct wall has to stand inside
   * them by whatever projects past it.**
   *
   * Two things do. The exedrae on the short ends are semicircles of radius `dOuter * 0.16`
   * centred 2 m inside the wall, so they bulge `radius - 2` beyond it; and the entrance
   * pavilion on the long side stands 3 m proud. Drawn on a wall line at the published
   * dimension, that put every bath block in Rome outside its own collision box — measured
   * with `tools/scratch/mon-extents.mjs`, **+25.2 m per end on the Baths of Trajan**, +17.2
   * on Nero's, +14.8 on Titus's, +14.0 on Agrippa's, and +3.2 on the short axis of all four.
   * That is `probe-fabric` G14 on four rows, and it is thousands of square metres of thermae
   * standing on ground the insula generator was told it could build on.
   *
   * The exedra radius stays proportioned to the PUBLISHED short dimension, so the arithmetic
   * closes exactly: reach = `W/2 - 2 + exR` = `(wOuter - 2(exR - 2))/2 - 2 + exR` = `wOuter/2`.
   */
  const exR = dOuter * 0.16;
  const ENTRANCE_PROJ = 3;
  const W = Math.max(20, wOuter - 2 * Math.max(0, exR - 2));
  const D = Math.max(20, dOuter - 2 * ENTRANCE_PROJ);
  const brick = batch.s('brick');
  const concrete = batch.s('concrete');
  const stone = batch.s('stone');
  const roof = batch.s('roof');
  const road = batch.s('road');
  const wallH = Math.min(13, 8 + W * 0.012);
  const t = 2.4;

  // Paved precinct. Bare ground inside a bath enclosure was what made it read as a yard.
  pavedField(road, W / 2 - t, D / 2 - t, g + 0.1, 6.5, PAL.dust, Math.round(W * 3), 0.2);

  // ---- precinct wall, with exedrae and a monumental entrance ---------------
  for (const s of [-1, 1] as const) {
    box(brick, -W / 2, g, (s * D) / 2 - s * t, W / 2, g + wallH, (s * D) / 2, PAL.brick, { topGain: 1.08, groundShade: 0.16 });
    box(brick, (s * W) / 2 - s * t, g, -D / 2, (s * W) / 2, g + wallH, D / 2, PAL.brick, { topGain: 1.08, groundShade: 0.16 });
    // Blind arcading on the inner face: every surviving thermae precinct has it, and it is
    // what stops 300 m of wall reading as a fence.
    if (detail >= 1) {
      const n = Math.max(6, Math.round(W / 9));
      for (let i = 0; i < n; i++) {
        const px = lerp(-W / 2 + 6, W / 2 - 6, i / (n - 1));
        brick.push(new THREE.Matrix4().makeRotationY(s > 0 ? 0 : Math.PI).setPosition(px, g, (s * D) / 2 - s * t));
        archPanel(brick, W / n - 0.4, wallH - 1.2, PAL.brickPale, {
          depth: 0.7,
          spring: (wallH - 1.2) * 0.5,
          openWidth: Math.min((W / n) * 0.6, 4.2),
          segments: detail >= 2 ? 7 : 4,
          voidCol: PAL.voidDark,
          blockTo: wallH,
        });
        brick.pop();
      }
    }
    // Semicircular exedrae on the short ends — lecture halls and nymphaea.
    cylinder(brick, (s * W) / 2 - s * 2, g, 0, exR, exR, wallH + 3, detail >= 1 ? 16 : 8, PAL.brickPale, {
      arcFrom: s < 0 ? -Math.PI / 2 : Math.PI / 2,
      arcTo: s < 0 ? Math.PI / 2 : Math.PI * 1.5,
      shadeLow: 0.14,
    });
    dome(concrete, (s * W) / 2 - s * 2, g + wallH + 3, 0, exR, detail >= 1 ? 16 : 8, 4, PAL.concrete, { heightScale: 0.5 });
  }
  // Monumental entrance on the long side facing the city.
  box(brick, -W * 0.09, g, -D / 2 - ENTRANCE_PROJ, W * 0.09, g + wallH + 6, -D / 2 + t, PAL.brickPale, { topGain: 1.1 });
  brick.pushTranslate(0, 0, -D / 2 - ENTRANCE_PROJ);
  archPanel(brick, W * 0.18, wallH + 6, PAL.travertine, {
    depth: 3 + t,
    spring: (wallH + 6) * 0.44,
    openWidth: Math.min(W * 0.1, 9),
    segments: detail >= 2 ? 10 : 5,
    backFace: true,
    archivolt: detail >= 2 ? 0.3 : 0,
    voidCol: PAL.voidDark,
  });
  brick.pop();

  // ---- the bathing block, on the cross axis -------------------------------
  const bw = W * 0.52; // along X: natatio .. frigidarium .. caldarium
  const bd = D * 0.4; // across
  const blockH = 24 + W * 0.012;
  // Substructure and the block's brick mass, in three stepped masses rather than one box.
  box(brick, -bw / 2, g, -bd / 2, bw / 2, g + 3, bd / 2, PAL.brickDark, { topGain: 1.04 });
  box(brick, -bw / 2, g + 3, -bd / 2, bw / 2, g + blockH * 0.62, bd / 2, PAL.brick, { topGain: 1.04, groundShade: 0.1 });
  // The frigidarium hall rises above the aisles: a clerestory band with big windows.
  const hallHalf = bd * 0.3;
  box(brick, -bw * 0.3, g + blockH * 0.62, -hallHalf, bw * 0.3, g + blockH, hallHalf, PAL.brickPale, { topGain: 1.06 });
  if (detail >= 1) {
    // Great thermal windows in the clerestory, and the aisle windows below.
    const n = 3;
    for (let i = 0; i < n; i++) {
      const px = lerp(-bw * 0.24, bw * 0.24, i / (n - 1));
      for (const s of [-1, 1] as const) {
        box(brick, px - bw * 0.06, g + blockH * 0.7, s * hallHalf - s * 0.15, px + bw * 0.06, g + blockH * 0.93, s * hallHalf + s * 0.1, PAL.voidDark);
      }
    }
    const m = Math.max(4, Math.round(bw / 11));
    for (let i = 0; i < m; i++) {
      const px = lerp(-bw / 2 + 5, bw / 2 - 5, i / (m - 1));
      for (const s of [-1, 1] as const) {
        box(brick, px - 2.2, g + blockH * 0.3, s * (bd / 2) - s * 0.15, px + 2.2, g + blockH * 0.55, s * (bd / 2) + s * 0.1, PAL.voidDark);
      }
    }
  }
  // Tiled lean-to roofs over the aisles, so the block's shoulders are roof and not a flat
  // plate of brick the size of the building.
  for (const s of [-1, 1] as const) {
    const z0 = s * hallHalf;
    const z1 = s * (bd / 2);
    box(roof, -bw / 2, g + blockH * 0.62 - 0.3, Math.min(z0, z1), bw / 2, g + blockH * 0.62 + 0.5, Math.max(z0, z1), PAL.roofTileOld, {
      topGain: 1.1,
    });
  }
  // Three cross-vaults over the frigidarium, spanning the hall. Pale concrete, not brick:
  // the vaults were rendered and they are the one part of a thermae that reads from a
  // distance. No ribs — an earlier revision drew them as full-height boxes from the vault
  // springing to its crown, which is a solid 22 m wall standing across the roof.
  const vaultSeg = detail >= 1 ? 18 : 8;
  const bayLen = (bw * 0.62) / 3;
  for (let i = 0; i < 3; i++) {
    const px = (i - 1) * bayLen;
    const vm = new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(px, g + blockH, 0);
    concrete.push(vm);
    cylinder(concrete, 0, -hallHalf * 0.98, 0, hallHalf, hallHalf, hallHalf * 1.96, vaultSeg, PAL.mortar, {
      arcFrom: 0,
      arcTo: Math.PI,
    });
    concrete.pop();
    // A transverse arch band between bays, standing barely proud of the vault surface.
    if (detail >= 1) {
      const bm = new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(px + bayLen * 0.5, g + blockH, 0);
      concrete.push(bm);
      cylinder(concrete, 0, -0.45, 0, hallHalf + 0.5, hallHalf + 0.5, 0.9, vaultSeg, PAL.concrete, { arcFrom: 0, arcTo: Math.PI });
      concrete.pop();
    }
  }
  // Natatio: the open-air swimming pool at the cool end, walled and columned.
  const npx = -bw / 2 - W * 0.11;
  box(stone, npx - W * 0.09, g + 0.2, -bd * 0.42, npx + W * 0.09, g + 1.0, bd * 0.42, PAL.marbleShadow, { topGain: 1.08 });
  box(stone, npx - W * 0.075, g + 0.4, -bd * 0.36, npx + W * 0.075, g + 0.9, bd * 0.36, new THREE.Color(0.09, 0.19, 0.22), { topGain: 1.0 });
  if (detail >= 1) {
    for (let i = 0; i < 7; i++) {
      const pz = lerp(-bd * 0.4, bd * 0.4, i / 6);
      column(stone, npx - W * 0.1, g + 1.0, pz, 0.5, 9.5, 'corinthian', PAL.marble, detail - 1);
    }
  }
  // Caldarium: the domed rotunda projecting on the sunny (south) side.
  const cr = Math.min(24, bd * 0.34);
  const cpx = bw / 2 + cr * 0.55;
  cylinder(brick, cpx, g, 0, cr, cr, blockH * 0.68, detail >= 1 ? 22 : 10, PAL.brick, { shadeLow: 0.16 });
  cylinder(stone, cpx, g + blockH * 0.68 - 0.6, 0, cr + 0.5, cr + 0.5, 0.9, detail >= 1 ? 22 : 10, PAL.travertine, { top: true });
  dome(concrete, cpx, g + blockH * 0.68, 0, cr, detail >= 1 ? 22 : 10, detail >= 1 ? 8 : 3, PAL.concrete, { heightScale: 0.78 });

  // ---- palaestrae: colonnaded courts either flank --------------------------
  if (detail >= 1) {
    for (const s of [-1, 1] as const) {
      const pz = (s * (bd / 2 + D * 0.5)) / 2;
      const phw = bw * 0.42;
      const phd = Math.abs(pz - s * bd / 2) * 0.7;
      road.pushTranslate(0, 0, pz);
      // Sanded, not basalt: a palaestra is an exercise ground. Paved dark it read as tarmac.
      pavedField(road, phw, phd, g + 0.18, 5.5, new THREE.Color().copy(PAL.dust).lerp(PAL.terraDirty, 0.4), Math.round(W * 5) + (s > 0 ? 1 : 0), 0.26);
      road.pop();
      const n = Math.max(6, Math.round(phw / 5));
      for (let i = 0; i < n; i++) {
        const px = lerp(-phw, phw, i / (n - 1));
        column(stone, px, g + 0.3, pz - phd, 0.46, 8.5, 'corinthian', PAL.marble, detail - 1);
        column(stone, px, g + 0.3, pz + phd, 0.46, 8.5, 'corinthian', PAL.marble, detail - 1);
      }
      for (const zz of [pz - phd, pz + phd]) {
        box(stone, -phw - 1, g + 8.8, zz - 1.4, phw + 1, g + 10.2, zz + 1.4, PAL.marble, { topGain: 1.12 });
        box(roof, -phw - 1.6, g + 10.2, zz - 2.2, phw + 1.6, g + 11.4, zz + 2.2, PAL.roofTile, { topGain: 1.1 });
      }
    }
  }
  void rng;
}

/**
 * The Ludus Magnus: the gladiatorial school east of the Colosseum across the Via
 * Labicana.
 *
 * Deliberately *not* amphitheatre-shaped in its envelope. It is a rectangular
 * porticoed block four storeys high with a small practice arena in its courtyard —
 * an oval of sand 62 × 45 m with three shallow ranks of seating, not an arcaded
 * ellipse. Rome had exactly one Flavian Amphitheatre and the reading of the skyline
 * depends on nothing else looking like it.
 */
function buildLudus(batch: Batch, detail: number, g: number, L: number, W: number, rng: Rng): void {
  const brick = batch.s('brick');
  const stucco = batch.s('stucco');
  const roof = batch.s('roof');
  const concrete = batch.s('concrete');
  const wing = 15;
  const h = 15.5;

  for (const [x0, z0, x1, z1] of [
    [-L / 2, -W / 2, L / 2, -W / 2 + wing],
    [-L / 2, W / 2 - wing, L / 2, W / 2],
    [-L / 2, -W / 2 + wing, -L / 2 + wing, W / 2 - wing],
    [L / 2 - wing, -W / 2 + wing, L / 2, W / 2 - wing],
  ] as const) {
    box(brick, x0, g, z0, x1, g + h, z1, PAL.brick, { topGain: 1.06, groundShade: 0.18 });
    roof.pushTranslate((x0 + x1) / 2, 0, (z0 + z1) / 2);
    hipRoof(roof, x1 - x0 + 1.4, z1 - z0 + 1.4, g + h, Math.min(x1 - x0, z1 - z0) * 0.16, 0.8, PAL.roofTileOld);
    roof.pop();
    if (detail >= 1) {
      // Arched cells along the inner face: the gladiators' quarters.
      const along = x1 - x0 > z1 - z0;
      const n = Math.max(3, Math.round((along ? x1 - x0 : z1 - z0) / 4.2));
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const px = along ? lerp(x0, x1, t) : (x0 + x1) / 2;
        const pz = along ? (z0 + z1) / 2 : lerp(z0, z1, t);
        const faceZ = along ? (z0 < 0 ? z1 : z0) : pz;
        const faceX = along ? px : x0 < 0 ? x1 : x0;
        stucco.push(
          new THREE.Matrix4()
            .makeRotationY(along ? (z0 < 0 ? Math.PI : 0) : z0 < 0 ? Math.PI / 2 : -Math.PI / 2)
            .setPosition(along ? faceX : faceX, g, along ? faceZ : faceZ)
        );
        archPanel(stucco, (along ? (x1 - x0) / n : (z1 - z0) / n) + 0.04, 4.6, PAL.terraDirty, {
          depth: 0.5,
          spring: 2.6,
          openWidth: 1.9,
          segments: detail >= 2 ? 6 : 3,
          voidCol: PAL.voidDark,
        });
        stucco.pop();
      }
    }
  }
  // The practice arena: sand, a low podium wall and three ranks of seating.
  pavedEllipse(concrete, 31, 22.5, g + 0.3, detail >= 1 ? 3 : 1, detail >= 1 ? 22 : 10, PAL.dust, 0x9a12, 0.2);
  ellipseRing(concrete, 32.4, 23.9, 31, 22.5, g + 0.3, 1.9, detail >= 1 ? 22 : 10, PAL.marbleShadow);
  ellipseCavea(concrete, 32.4, 23.9, 40, 31, g + 2.2, g + 5.4, 0, Math.PI * 2, {
    rows: detail >= 1 ? 4 : 2,
    seg: detail >= 1 ? 22 : 10,
    tread: PAL.travertineDirty,
    riser: new THREE.Color().copy(PAL.travertineDirty).multiplyScalar(0.72),
    salt: 0x9b,
  });
  void rng;
}

/**
 * The Tabularium: the record office of 78 BC closing the west end of the Forum, a
 * two-storey arcaded façade on a battered tufa substructure. Still the base of the
 * Palazzo Senatorio.
 */
function buildTabularium(batch: Batch, detail: number, g: number, L: number, W: number): void {
  const stone = batch.s('stone');
  const bays = detail >= 1 ? 11 : 5;
  const bw = L / bays;
  // Substructure, battered, in blocks of Gabine stone.
  box(stone, -L / 2, g - 8, -W / 2, L / 2, g + 1.2, W / 2, PAL.peperino, { batter: 0.05, topGain: 1.05 });
  for (let s = 0; s < 2; s++) {
    const y = g + 1.2 + s * 7.6;
    stone.push(new THREE.Matrix4().setPosition(0, y, -W / 2));
    arcade(stone, bays, bw, 7.6, s === 0 ? PAL.travertine : PAL.travertineDirty, {
      depth: 4.5,
      spring: 3.9,
      openWidth: Math.min(bw * 0.6, 3.6),
      segments: detail >= 2 ? 8 : 4,
      voidCol: PAL.voidDark,
    });
    if (detail >= 1) {
      for (let i = 0; i <= bays; i++) {
        column(stone, -L / 2 + bw * i, 0, -0.6, 0.46, 6.6, s === 0 ? 'tuscan' : 'ionic', PAL.travertine, detail - 1);
      }
    }
    stone.pop();
  }
  box(stone, -L / 2, g + 16.4, -W / 2, L / 2, g + 18.4, W / 2, PAL.travertineDirty, { topGain: 1.14 });
  box(batch.s('roof'), -L / 2 - 0.8, g + 18.4, -W / 2 - 0.8, L / 2 + 0.8, g + 19.2, W / 2 + 0.8, PAL.roofTile, { topGain: 1.1 });
}

/**
 * Trajan's Market: a hemicycle of *tabernae* cut into the flank of the Quirinal above
 * the Forum of Trajan, stepping up the hillside in six storeys. The curve faces the
 * forum, so it opens along local −Z.
 */
function buildMarket(batch: Batch, detail: number, g: number, L: number, W: number): void {
  const brick = batch.s('brick');
  const roof = batch.s('roof');
  /**
   * **The hemicycle is an ellipse, and its short axis is the depth the plan actually has.**
   *
   * It was a circle of radius `L * 0.5` — the half-*length* used as a *radius* — so a curve
   * whose chord is 120 m also went 120 m deep, in a box 70 m deep: 1.563 of the footprint
   * the sim collides with, and the curve alone reached 25 m past the back of its own plot.
   * The 120 is a chord and `survey.ts` says so ("the 120 m dimension runs along the
   * hemicycle's chord, which is the forum's own axis"), so the long axis keeps it and the
   * short axis becomes `W * 0.5`. Nothing about the reading changes: from the forum this is
   * still a 120 m curved brick façade stepping up the Quirinal.
   */
  const rx = L * 0.5;
  const rz = W * 0.5;
  const tiers = 3;
  for (let t = 0; t < tiers; t++) {
    // Each tier steps in by a third of the plan and up by a storey. Both semi-axes shrink
    // together, which is what keeps the tiers concentric now that they are not circles; the
    // old `rr - t * (W / tiers) * 0.86` was a setback tuned to the old radius and goes
    // negative the moment the radius is anything smaller.
    const k = 1 - t / tiers;
    const ax = rx * k;
    const az = rz * k;
    const y = g + t * 8.2;
    const n = detail >= 1 ? 20 : 9;
    for (let i = 0; i < n; i++) {
      const a0 = Math.PI + (Math.PI * i) / n;
      const a1 = Math.PI + (Math.PI * (i + 1)) / n;
      const am = (a0 + a1) / 2;
      // Chord between the two ends of this bay's arc, which on an ellipse is not a constant.
      const cw = (Math.cos(a1) - Math.cos(a0)) * ax;
      const cd = (Math.sin(a1) - Math.sin(a0)) * az;
      const bw = Math.sqrt(cw * cw + cd * cd);
      // The ellipse's outward normal, and the bay turned so its FACE looks along it and its
      // eight metres of *tabernae* run back into the hill. They used to run the other way —
      // `archPanel` builds from its face at local z = 0 toward +z, and the bay was placed
      // with +z pointing radially *outward* — so every bay added its whole depth outside the
      // curve. Facing out is also the right building: the market's storeys look down over
      // the Forum of Trajan, they are not a courtyard.
      // `atan2` is invariant under a positive scale, so the normal needs no normalising here.
      const nx = Math.cos(am) / ax;
      const nz = Math.sin(am) / az;
      brick.push(
        new THREE.Matrix4()
          .makeRotationY(Math.atan2(-nx, -nz))
          .setPosition(Math.cos(am) * ax, y, Math.sin(am) * az)
      );
      archPanel(brick, bw + 0.05, 8.2, t === 0 ? PAL.brick : PAL.brickPale, {
        depth: 8,
        spring: 4.2,
        openWidth: Math.min(bw * 0.56, 3.4),
        segments: detail >= 2 ? 7 : 4,
        voidCol: PAL.voidDark,
      });
      brick.pop();
    }
    // The terrace behind each tier.
    if (t === tiers - 1) {
      roof.pushTranslate(0, 0, (L * 0.5 - W) * 0.5);
      hipRoof(roof, L * 0.6, W * 0.5, y + 8.2, 3.0, 0.8, PAL.roofTileOld);
      roof.pop();
    }
  }
  // The tall market hall behind the hemicycle.
  box(brick, -L * 0.22, g + 8.2, -W * 0.1, L * 0.22, g + 30, W * 0.42, PAL.brickPale, { topGain: 1.08 });
  box(roof, -L * 0.23, g + 30, -W * 0.11, L * 0.23, g + 31, W * 0.43, PAL.roofTileOld, { topGain: 1.1 });
}

export interface PrecinctOpts {
  /** Number of temples inside, side by side facing along −Z. */
  temples: number;
  colH: number;
  /** A closed precinct wall behind the colonnade (Porticus Octaviae) or an open one. */
  wall: boolean;
}

/**
 * A colonnaded precinct with temples in it: the Imperial Fora, the Porticus Octaviae,
 * the Area Sacra at Largo Argentina. One builder because that *is* one Roman building
 * type — a walled rectangle of paving with a colonnade round it and podium temples
 * standing in the middle.
 */
function buildPrecinct(batch: Batch, detail: number, g: number, L: number, W: number, rng: Rng, o: PrecinctOpts): void {
  const stone = batch.s('stone');
  const road = batch.s('road');
  const roof = batch.s('roof');
  pavedField(road, L / 2, W / 2, g + 0.14, 5.5, PAL.marbleShadow, Math.round(L * 7), 0.2);

  /**
   * **`L × W` is the precinct's outer face, so everything here is built inward from it.**
   *
   * It used not to be. The colonnade stood *on* `±L/2, ±W/2` and its entablature and roof
   * were then drawn outward from that line — `+7.5` for the architrave, `+8.2` for the
   * eaves — and where `o.wall` is set the enclosing wall was hung a further metre outside
   * *that*, at `+9.0`, with its corner returns run out to `±(L/2 + 8)`. So the three
   * monuments this builds all drew 8 to 9 m of marble on every side of a footprint the sim
   * had already reserved to the millimetre, which is what `probe-fabric` G14 sees.
   *
   * The fix is only a change of datum, not of architecture. A quadriportico's lean-to roof
   * genuinely does run *outward*, from the columns back to the enclosure — that is what a
   * portico is — so the roof still runs outward and the colonnade simply stands where it
   * belongs relative to the published rectangle: `eave` in from the wall's inner face.
   */
  const wallT = o.wall ? 1.5 : 0; // the closed precinct wall's own thickness
  const eave = 8.2; // colonnade line to the outer edge of its lean-to roof
  const hx = L / 2 - wallT; // inner face of the enclosure, or the published line itself
  const hz = W / 2 - wallT;
  const cx = hx - eave; // the colonnade
  const cz = hz - eave;

  // Colonnade all the way round, on a low stylobate.
  const colH = o.colH;
  const pitch = 5.0;
  const along = (n: number, fx: (t: number) => [number, number]): void => {
    for (let i = 0; i < n; i++) {
      const [px, pz] = fx(n === 1 ? 0.5 : i / (n - 1));
      column(stone, px, g + 0.8, pz, 0.5, colH, 'corinthian', PAL.marble, detail - 1);
    }
  };
  const nx = Math.max(2, Math.round((cx * 2) / pitch));
  const nz = Math.max(2, Math.round((cz * 2) / pitch));
  for (const s of [-1, 1] as const) {
    along(nx, (t) => [lerp(-cx, cx, t), s * cz]);
    along(nz, (t) => [s * cx, lerp(-cz, cz, t)]);
    box(stone, -cx - 1, g + 0.8 + colH, s * (cz - 1.0), cx + 1, g + 0.8 + colH + 1.8, s * (cz + 7.5), PAL.marble, { topGain: 1.12 });
    box(roof, -cx - 1.4, g + 0.8 + colH + 1.8, s * (cz - 1.3), cx + 1.4, g + 0.8 + colH + 3.2, s * (cz + eave), PAL.roofTile, { topGain: 1.1 });
    box(stone, s * (cx - 1.0), g + 0.8 + colH, -cz, s * (cx + 7.5), g + 0.8 + colH + 1.8, cz, PAL.marble, { topGain: 1.12 });
    box(roof, s * (cx - 1.3), g + 0.8 + colH + 1.8, -cz - 1.4, s * (cx + eave), g + 0.8 + colH + 3.2, cz + 1.4, PAL.roofTileOld, { topGain: 1.1 });
    if (o.wall) {
      // The wall IS the outer extent, and the colonnade is inboard of it — the Porticus
      // Octaviae's quadriportico stands inside its own precinct wall, not beside it.
      box(stone, -L / 2, g, s * hz, L / 2, g + colH + 5.0, s * (W / 2), PAL.marbleShadow, { topGain: 1.1 });
      box(stone, s * hx, g, -W / 2, s * (L / 2), g + colH + 5.0, W / 2, PAL.marbleShadow, { topGain: 1.1 });
    }
  }

  // Temples on podia, standing in a row along the long axis. `temples: 0` is a legitimate
  // precinct — the Porticus Pompei enclosed a planted court and nothing else — and the guard is
  // here rather than left to `L / 0` evaluating to Infinity and being clamped by the `min`,
  // which is true today and is not a thing to rely on.
  const tw = o.temples === 0 ? 0 : Math.min(30, (L / o.temples) * 0.62);
  for (let i = 0; i < o.temples; i++) {
    const px = o.temples === 1 ? 0 : lerp(-cx + tw * 0.9, cx - tw * 0.9, i / (o.temples - 1));
    stone.pushTranslate(px, 0, W * 0.1);
    buildTemple(batch, detail, g, {
      w: tw,
      d: tw * 1.4,
      podiumH: 3.0 + (i % 2) * 0.8,
      colH: colH * 1.25,
      colR: 0.6,
      colsFront: tw > 22 ? 6 : 4,
      colsSide: 5,
      porchRows: 2,
      order: 'corinthian',
      roofCol: i % 2 === 0 ? PAL.roofTile : PAL.bronze,
      roofMat: 'roof',
      wallCol: PAL.marble,
      cellae: 1,
    });
    stone.pop();
  }
  void rng;
}

/**
 * A hilltop quarter: the Aventine and the Caelian. By the third century both were
 * quiet, grand and green — great courtyard houses and a temple or two among gardens,
 * not tenements. Built here rather than in `fabric.ts` because the whole hill is
 * reserved as one landmark footprint.
 */
function buildHillQuarter(batch: Batch, detail: number, g: number, L: number, W: number, rng: Rng, temple: boolean): void {
  const stucco = batch.s('stucco');
  const roof = batch.s('roof');
  const stone = batch.s('stone');
  const road = batch.s('road');
  // A paved terrace under the whole quarter, so the houses do not stand on grass.
  pavedField(road, L * 0.5, W * 0.5, g + 0.08, 14, PAL.dust, Math.round(L * 11), 0.22);

  const cols = Math.max(2, Math.round(L / 62));
  const rows = Math.max(2, Math.round(W / 58));
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const cx = lerp(-L / 2 + L / cols / 2, L / 2 - L / cols / 2, cols === 1 ? 0.5 : i / (cols - 1));
      const cz = lerp(-W / 2 + W / rows / 2, W / 2 - W / rows / 2, rows === 1 ? 0.5 : j / (rows - 1));
      if (rng.bool(0.18)) continue; // a garden instead
      const hw = rng.range(16, 24);
      const hd = rng.range(13, 20);
      const h = rng.range(6.5, 11);
      const paint = rng.pickWeighted([PAL.limeWhite, PAL.ochrePale, PAL.terraDirty], [0.5, 0.32, 0.18]);
      const tile = rng.pickWeighted([PAL.roofTile, PAL.roofTileOld], [0.6, 0.4]);
      // A courtyard house: four wings round a peristyle.
      const wing = Math.min(7.5, Math.min(hw, hd) * 0.42);
      for (const [x0, z0, x1, z1] of [
        [-hw, -hd, hw, -hd + wing],
        [-hw, hd - wing, hw, hd],
        [-hw, -hd + wing, -hw + wing, hd - wing],
        [hw - wing, -hd + wing, hw, hd - wing],
      ] as const) {
        box(stucco, cx + x0, g, cz + z0, cx + x1, g + h, cz + z1, new THREE.Color().copy(paint).multiplyScalar(rng.range(0.86, 1.1)), {
          groundShade: 0.2,
        });
        roof.pushTranslate(cx + (x0 + x1) / 2, 0, cz + (z0 + z1) / 2);
        hipRoof(roof, x1 - x0 + 1.4, z1 - z0 + 1.4, g + h, Math.min(x1 - x0, z1 - z0) * 0.2, 0.8, tile);
        roof.pop();
      }
      if (detail >= 1) {
        const cw = hw - wing;
        const cd = hd - wing;
        box(stone, cx - cw, g + 0.12, cz - cd, cx + cw, g + 0.2, cz + cd, PAL.marbleShadow, { bottom: false });
        for (let k = 0; k < 6; k++) {
          const t = k / 5;
          column(stone, cx + lerp(-cw + 1, cw - 1, t), g + 0.2, cz - cd + 1, 0.26, 3.6, 'corinthian', PAL.marble, detail - 1);
          column(stone, cx + lerp(-cw + 1, cw - 1, t), g + 0.2, cz + cd - 1, 0.26, 3.6, 'corinthian', PAL.marble, detail - 1);
        }
      }
    }
  }
  if (temple) {
    // The Aventine's temples: Juno Regina and Diana on the ridge.
    stone.pushTranslate(0, 0, -W * 0.36);
    buildTemple(batch, detail, g, {
      w: 26,
      d: 40,
      podiumH: 3.4,
      colH: 11.5,
      colR: 0.64,
      colsFront: 6,
      colsSide: 5,
      porchRows: 2,
      order: 'corinthian',
      roofCol: PAL.roofTile,
      roofMat: 'roof',
      wallCol: PAL.marble,
      cellae: 1,
    });
    stone.pop();
  }
}

/**
 * Insula Tiberina: the boat-shaped island between the Capitoline and the Aventine,
 * revetted in travertine, with the Temple of Aesculapius on it and a bridge to each
 * bank. Placed on the terrain's own river centreline, so the water is the datum.
 */
function buildTiberIsland(batch: Batch, detail: number, g: number, heightAt: Ground, m: LandmarkPlacement): void {
  const stone = batch.s('stone');
  const road = batch.s('road');
  const L = m.hw * 0.9;
  const W = m.hd * 0.82;
  // `WATER` is a WORLD height and `g` is a local one, and mixing them is only safe because
  // the island is `soft`: `layout.ts:drawScaleOf`/`drawHeightOf` return 1 for landscape on
  // both axes, so this monument's frame and the world's are the same frame. If a soft row
  // ever gains a `draw`, this line and the two `WATER` references below are the first
  // things that break — the revetment would meet the river at the wrong level.
  const deck = Math.max(g, WATER + 4.2);

  // The travertine revetment, cut to a point at each end like a ship's prow.
  const seg = detail >= 1 ? 22 : 10;
  for (let i = 0; i < seg; i++) {
    const a0 = (Math.PI * 2 * i) / seg;
    const a1 = (Math.PI * 2 * (i + 1)) / seg;
    // A superellipse: blunt-sided and sharp-ended, which is the island's actual plan.
    const px = (a: number): number => Math.sign(Math.cos(a)) * Math.pow(Math.abs(Math.cos(a)), 0.72) * L;
    const pz = (a: number): number => Math.sign(Math.sin(a)) * Math.pow(Math.abs(Math.sin(a)), 1.5) * W;
    quadPrism(stone, px(a0), pz(a0), px(a1), pz(a1), Math.cos((a0 + a1) / 2), Math.sin((a0 + a1) / 2), 0.01, WATER - 1.5, deck, PAL.travertineDirty, PAL.travertine, {
      top: false,
      ends: false,
    });
    const p0 = new THREE.Vector3(px(a0), deck, pz(a0));
    const p1 = new THREE.Vector3(px(a1), deck, pz(a1));
    const p2 = new THREE.Vector3(0, deck, 0);
    UP.set(0, 1, 0);
    stone.triN(UP, p0, p1, p2, PAL.dust);
  }
  pavedField(road, L * 0.6, W * 0.55, deck + 0.1, 6, PAL.basalt, 0x1b1a, 0.24);
  // The Temple of Aesculapius at the downstream end.
  stone.pushTranslate(L * 0.34, 0, 0);
  stone.push(new THREE.Matrix4().makeRotationY(Math.PI / 2));
  buildTemple(batch, detail, deck, {
    w: 18,
    d: 28,
    podiumH: 2.6,
    colH: 9.0,
    colR: 0.52,
    colsFront: 4,
    colsSide: 5,
    porchRows: 2,
    order: 'corinthian',
    roofCol: PAL.roofTile,
    roofMat: 'roof',
    wallCol: PAL.marble,
    cellae: 1,
  });
  stone.pop();
  stone.pop();
  // Pons Fabricius to the east bank and Pons Cestius to the west: four arches each.
  for (const s of [-1, 1] as const) {
    const span = 62;
    const n = 4;
    for (let i = 0; i < n; i++) {
      const zz = s * (W + 6 + (span * (i + 0.5)) / n);
      const wx = m.x;
      const wz = m.z + zz;
      const gg = heightAt(wx, wz);
      stone.push(new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(0, Math.max(gg, WATER - 1.0), zz));
      archPanel(stone, span / n + 0.05, deck - Math.max(gg, WATER - 1.0), PAL.travertine, {
        depth: 7.4,
        spring: Math.max(2.2, deck - Math.max(gg, WATER - 1.0) - span / n * 0.5),
        openWidth: (span / n) * 0.78,
        segments: detail >= 2 ? 9 : 5,
        backFace: true,
        archivolt: detail >= 2 ? 0.2 : 0,
      });
      stone.pop();
    }
  }
}

/** Tiber low-water surface, from the terrain contract. */
const WATER = 5.0;

/**
 * The Mausoleum of Hadrian on the far bank: a 64 m drum on an 89 m square podium,
 * planted on top with a quadriga above. The imperial mausoleum in 271.
 */
function buildHadrianeum(batch: Batch, detail: number, g: number, rng: Rng): void {
  const stone = batch.s('stone');
  const metal = batch.s('metal');
  const seg = detail >= 1 ? 30 : 14;
  box(stone, -44.5, g - 1, -44.5, 44.5, g + 10.5, 44.5, PAL.travertineDirty, { topGain: 1.06, batter: 0.01 });
  if (detail >= 1) {
    // Pilasters and garlands round the podium.
    for (let i = 0; i < 32; i++) {
      const t = (i % 8) / 7;
      const s = Math.floor(i / 8);
      const px = s === 0 ? lerp(-42, 42, t) : s === 1 ? 44.6 : s === 2 ? lerp(42, -42, t) : -44.6;
      const pz = s === 0 ? -44.6 : s === 1 ? lerp(-42, 42, t) : s === 2 ? 44.6 : lerp(42, -42, t);
      box(stone, px - 1.1, g, pz - 1.1, px + 1.1, g + 10.5, pz + 1.1, PAL.travertine);
    }
  }
  cylinder(stone, 0, g + 10.5, 0, 32, 32, 21, seg, PAL.travertine, { shadeLow: 0.1, top: true });
  cylinder(stone, 0, g + 31.5, 0, 32.8, 32.8, 1.4, seg, PAL.travertineDirty, { top: true });
  cylinder(stone, 0, g + 32.9, 0, 15, 15, 8.5, seg, PAL.marbleShadow, { top: true });
  statue(metal, 0, g + 41.4, 0, 5.5, PAL.gilt, Math.PI, seg);
  void rng;
}

/** Castra Praetoria: the Praetorian barracks, a fortified brick camp. */
function buildCastra(batch: Batch, detail: number, g: number, W: number, D: number, heightAt: Ground, m: LandmarkPlacement): void {
  const brick = batch.s('brick');
  const roof = batch.s('roof');
  const H = 4.7; // original height; Aurelian later incorporated it into the circuit
  const t = 1.4;

  const sides: [number, number, number, number][] = [
    [-W / 2, -D / 2, W / 2, -D / 2],
    [-W / 2, D / 2, W / 2, D / 2],
    [-W / 2, -D / 2, -W / 2, D / 2],
    [W / 2, -D / 2, W / 2, D / 2],
  ];
  for (const [x0, z0, x1, z1] of sides) {
    const len = Math.sqrt((x1 - x0) * (x1 - x0) + (z1 - z0) * (z1 - z0));
    const dx = (x1 - x0) / len;
    const dz = (z1 - z0) / len;
    // World height in, local height out: `g` is already inside the placement matrix's
    // vertical scale, so the terrain sample has to come through it before the difference
    // means anything. `heightScale` is 1 for this monument — the row states no `draw` — so
    // the arithmetic is unchanged today and correct if that ever stops being true.
    const g0 = heightAt(m.x + x0, m.z + z0) / m.heightScale - g;
    quadPrism(brick, x0, z0, x1, z1, -dz, dx, t, g + g0 - 1.2, g + H, PAL.brick, PAL.travertine, { ends: false });
    crenellation(brick, x0, z0, x1, z1, g + H, 1.5, t, PAL.brick, 1.3, 0.7, detail >= 1);
    // Square interval towers.
    const nT = Math.max(2, Math.round(len / 30));
    for (let i = 0; i <= nT; i++) {
      const px = lerp(x0, x1, i / nT);
      const pz = lerp(z0, z1, i / nT);
      quadPrism(brick, px - dx * 2.2, pz - dz * 2.2, px + dx * 2.2, pz + dz * 2.2, -dz, dx, t + 2.4, g - 1.2, g + H + 3.2, PAL.brick, PAL.brickPale);
      if (detail >= 1) {
        roof.pushTranslate(px, 0, pz);
        hipRoof(roof, 5.6, 5.6, g + H + 3.2, 1.4, 0.3, PAL.roofTile);
        roof.pop();
      }
    }
  }
  // Barrack ranges inside.
  if (detail >= 1) {
    for (let r = 0; r < 6; r++) {
      const zz = lerp(-D / 2 + 26, D / 2 - 26, r / 5);
      box(brick, -W / 2 + 20, g, zz - 5, W / 2 - 20, g + 6.2, zz + 5, PAL.ochreDeep, { topGain: 1.06 });
      brick.pushTranslate(0, 0, zz);
      roof.pushTranslate(0, 0, zz);
      gableRoof(brick, roof, W - 40, 10, g + 6.2, 2.6, 0.6, PAL.roofTileOld, true);
      brick.pop();
      roof.pop();
    }
    // Principia on the axis.
    box(brick, -22, g, -6, 22, g + 11, 10, PAL.brickPale, { topGain: 1.08 });
    gableRoof(brick, roof, 44, 16, g + 11, 4.5, 0.8, PAL.roofTile, true);
  }
}

// ---------------------------------------------------------------------------
// Small monuments
// ---------------------------------------------------------------------------

/** Egyptian obelisk on a plinth. Roman obelisks taper about 1 : 10 and are pyramidal-tipped. */
function buildObelisk(batch: Batch, detail: number, g: number, height: number, baseHalf: number): void {
  const stone = batch.s('stone');
  const metal = batch.s('metal');
  const plinth = height * 0.14;
  box(stone, -baseHalf * 2.4, g, -baseHalf * 2.4, baseHalf * 2.4, g + plinth, baseHalf * 2.4, PAL.peperino, { topGain: 1.08 });
  const shaftH = height * 0.9;
  const top = baseHalf * 0.66;
  box(stone, -baseHalf, g + plinth, -baseHalf, baseHalf, g + plinth + shaftH, baseHalf, PAL.brickDark, {
    batter: (baseHalf - top) / shaftH,
    topGain: 1.1,
  });
  // Pyramidion, sheathed in bronze on the Augustan obelisks.
  cone(metal, 0, g + plinth + shaftH, 0, top * 1.42, height * 0.1, 4, PAL.bronze, PAL.gilt);
}

/** Walled altar enclosure — the Ara Pacis and its many imitators. */
function buildAltarEnclosure(batch: Batch, detail: number, g: number, w: number, d: number): void {
  const stone = batch.s('stone');
  const t = 0.6;
  // The travertine apron under the enclosure, as a *fraction* of the enclosure and not the
  // flat 1 m it used to be. The Ara Pacis is 11.6 × 10.6 m, so a fixed metre is 17 % of the
  // half-width and drew the smallest monument in the city at 1.245 of its own footprint —
  // the constant was written for a building an order of magnitude larger. 3 % is a kerb.
  const apronW = w * 0.03;
  const apronD = d * 0.03;
  box(stone, -w / 2 - apronW, g - 0.4, -d / 2 - apronD, w / 2 + apronW, g + 0.5, d / 2 + apronD, PAL.travertineDirty, { topGain: 1.06 });
  box(stone, -w / 2, g + 0.5, -d / 2, w / 2, g + 4.8, -d / 2 + t, PAL.marble, { topGain: 1.14 });
  box(stone, -w / 2, g + 0.5, d / 2 - t, w / 2, g + 4.8, d / 2, PAL.marble, { topGain: 1.14 });
  box(stone, -w / 2, g + 0.5, -d / 2, -w / 2 + t, g + 4.8, d / 2, PAL.marble, { topGain: 1.14 });
  box(stone, w / 2 - t, g + 0.5, -d / 2, w / 2, g + 4.8, d / 2, PAL.marble, { topGain: 1.14 });
  // The altar itself, on its steps.
  stone.pushTranslate(0, 0, 1.5);
  steps(stone, w * 0.5, g + 0.5, -1.5, 5, 0.28, 0.34, PAL.marble);
  stone.pop();
  box(stone, -w * 0.22, g + 1.9, -1.2, w * 0.22, g + 3.1, 1.6, PAL.marble, { topGain: 1.16 });
}

/** Palace terraces on the Palatine: long substructure arcades and roof gardens. */
function buildPalatine(batch: Batch, detail: number, g: number, rng: Rng): void {
  const brick = batch.s('brick');
  const stone = batch.s('stone');
  const roof = batch.s('roof');

  // The great façade of the Domus Augustana, arcaded over its substructures.
  brick.pushTranslate(0, 0, -104);
  arcade(brick, detail >= 1 ? 22 : 10, 9.5, 18, PAL.brick, {
    depth: 5,
    spring: 5.5,
    openWidth: 5.0,
    segments: detail >= 2 ? 9 : 5,
    archivolt: detail >= 2 ? 0.24 : 0,
  });
  box(brick, -105, g + 18, 0, 105, g + 24, 5, PAL.brickPale, { topGain: 1.1 });
  brick.pop();

  // Blocks of palace above, in painted stucco with tiled roofs.
  const blocks: [number, number, number, number, number][] = [
    [-60, -50, 70, 44, 15],
    [30, -34, 62, 50, 18],
    [-10, 40, 96, 46, 13],
    [-72, 34, 44, 40, 11],
  ];
  for (const [bx, bz, bw, bd, bh] of blocks) {
    const st = batch.s('stucco');
    st.pushTranslate(bx, 0, bz);
    roof.pushTranslate(bx, 0, bz);
    box(st, -bw / 2, g, -bd / 2, bw / 2, g + bh, bd / 2, PAL.limeWhite, { topGain: 1.05 });
    hipRoof(roof, bw + 1.6, bd + 1.6, g + bh, Math.min(bw, bd) * 0.16, 0.9, PAL.roofTile);
    st.pop();
    roof.pop();
  }
  // A colonnaded peristyle court with a pool.
  box(stone, -34, g + 0.1, -6, 34, g + 0.2, 26, PAL.marbleShadow, { topGain: 1.05 });
  if (detail >= 1) {
    for (let i = 0; i < 12; i++) {
      const px = lerp(-32, 32, i / 11);
      column(stone, px, g + 0.2, -6, 0.44, 7.5, 'corinthian', PAL.marble, detail - 1);
      column(stone, px, g + 0.2, 26, 0.44, 7.5, 'corinthian', PAL.marble, detail - 1);
    }
  }
}

/** Gardens: terraces, pergolas, fountains and heavy planting. */
function buildGardens(batch: Batch, detail: number, g: number, rng: Rng, clear: number): void {
  const stone = batch.s('stone');
  const timber = batch.s('timber');
  const R = clear * 0.9;

  // A garden pavilion and a long pergola walk.
  box(stone, -9, g, -7, 9, g + 5.5, 7, PAL.limeWhite, { topGain: 1.06 });
  hipRoof(batch.s('roof'), 20, 16, g + 5.5, 3.2, 1.0, PAL.roofTile);
  if (detail >= 1) {
    for (let i = 0; i < 14; i++) {
      const px = lerp(-R * 0.7, R * 0.7, i / 13);
      for (const s of [-1, 1]) {
        cylinder(stone, px, g, s * 3.2 + 26, 0.24, 0.22, 3.0, 7, PAL.marbleShadow);
      }
      cylinderBetween(timber, px, g + 3.1, 22.8, px, g + 3.1, 29.2, 0.09, PAL.timber);
    }
    for (const s of [-1, 1]) {
      cylinderBetween(timber, -R * 0.7, g + 3.15, s * 3.2 + 26, R * 0.7, g + 3.15, s * 3.2 + 26, 0.1, PAL.timberDark);
    }
    // Fountain basin.
    cylinder(stone, 0, g, -24, 6.5, 6.5, 0.9, 16, PAL.marble, { top: true });
    cylinder(stone, 0, g + 0.9, -24, 1.2, 0.5, 2.4, 10, PAL.marble, { top: true });
  }

}

// ---------------------------------------------------------------------------
// Aqueducts
// ---------------------------------------------------------------------------

/**
 * An arcade carrying a water channel. The Aqua Claudia reached 28 m on piers about
 * 2.4 m wide with spans of some 5.5 m; the Aqua Virgo crossed the Campus Martius on
 * a much lower arcade to reach the Baths of Agrippa.
 */
function buildAqueduct(
  batch: Batch,
  detail: number,
  aq: (typeof AQUEDUCTS)[number],
  heightAt: Ground
): void {
  const stone = batch.s('stone');
  const brick = batch.s('brick');
  const bay = aq.bayWidth;

  for (let seg = 0; seg + 1 < aq.path.length; seg++) {
    const a = aq.path[seg];
    const b = aq.path[seg + 1];
    const len = Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.z - a.z) * (b.z - a.z));
    const n = Math.max(1, Math.round(len / bay));
    const dirY = Math.atan2(b.x - a.x, b.z - a.z);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const px = lerp(a.x, b.x, t);
      const pz = lerp(a.z, b.z, t);
      const g = heightAt(px, pz);
      // The channel must fall continuously, so its soffit is set from the run's ends
      // and the piers take up the difference — exactly the real engineering problem.
      const chY = lerp(heightAt(a.x, a.z) + aq.height, heightAt(b.x, b.z) + aq.height * 0.94, t);
      const h = chY - g;
      if (h < 3) continue;
      const m = new THREE.Matrix4().makeRotationY(dirY).setPosition(px, g, pz);
      // Safe today only because an aqueduct chunk never builds its far level, where
      // `collapseTo` would make these one stream; through `pushAll` it stays safe if that
      // changes. See `Batch.distinct`.
      const pushed = batch.pushAll(AQUEDUCT_KEYS, m);
      const spring = Math.max(2.5, h - bay * 0.5 - 1.6);
      const open = Math.min(bay - aq.pierWidth, (h - spring) * 2);
      archPanel(stone, bay + 0.05, h, PAL.travertineDirty, {
        depth: 2.6,
        spring,
        openWidth: Math.max(2.0, open),
        segments: detail >= 2 ? 10 : detail === 1 ? 6 : 3,
        backFace: true,
        archivolt: detail >= 2 ? 0.16 : 0,
      });
      // The *specus*: the covered channel on top, with its cover slabs.
      box(brick, -bay / 2 - 0.03, h, -1.6, bay / 2 + 0.03, h + 1.9, 1.6, PAL.brick, { topGain: 1.14 });
      box(stone, -bay / 2 - 0.03, h + 1.9, -1.85, bay / 2 + 0.03, h + 2.25, 1.85, PAL.travertine, { topGain: 1.2 });
      // A second, taller tier on the tallest runs, as at the Porta Maggiore.
      if (aq.height > 20 && h > 18) {
        archPanel(stone, bay + 0.05, spring, PAL.travertineDirty, {
          depth: 2.6,
          spring: Math.max(2.2, spring * 0.5),
          openWidth: Math.max(1.8, bay - aq.pierWidth - 0.6),
          segments: detail >= 2 ? 8 : 4,
          backFace: true,
        });
      }
      batch.popAll(pushed);
    }
  }
}

/** Both streams `buildAqueduct` touches. See `Batch.distinct`. */
const AQUEDUCT_KEYS: readonly CityMatKey[] = ['stone', 'brick'];

// ---------------------------------------------------------------------------
// Far horizon
// ---------------------------------------------------------------------------

/**
 * A ring of low hills beyond the terrain's edge, so the city does not end against
 * bare sky. From the battlefield these sit 1.5–2.5 km out and read as the Alban
 * hills through the aerial haze — cheap, and the frame collapses without them.
 */
/** Outer radius of the horizon ring; the far-hills chunk's declared bounding radius. */
export const FAR_HILLS_RADIUS = (HALF_EXTENT * Math.SQRT2 + 60) * (2600 / 1560) + 200;

function buildFarHills(batch: Batch, heightAt: Ground): void {
  const st = batch.s('stone');
  const ridge = new THREE.Color().copy(PAL.peperino).multiplyScalar(0.85);
  const far = new THREE.Color().copy(PAL.peperino).multiplyScalar(0.62);
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const p3 = new THREE.Vector3();
  const nrm = new THREE.Vector3();

  // Three concentric ridges of increasing distance and decreasing contrast.
  //
  // The innermost radius is `HALF_EXTENT · √2 + 60`: the heightfield is a *square*, so its
  // circumradius is 1,980 m and a ring inside that cuts the corners of the map. The first
  // version put the near ridge at 1,560 m, which drove a 62 m vertical curtain of hill
  // straight across the plain at x ≈ ±1,200, z ≈ ±1,000 — inside the battlefield, standing
  // on flat ground behind both armies, and always at full detail. Radii are scaled together
  // so each ridge keeps the angular height it had from the centre of the map and the horizon
  // reads exactly as before.
  const R0 = HALF_EXTENT * Math.SQRT2 + 60;
  const k = R0 / 1560;
  const layers = [
    { r: R0, h: 62 * k, freq: 5.5, tint: ridge },
    { r: 2050 * k, h: 108 * k, freq: 3.5, tint: new THREE.Color().lerpColors(ridge, far, 0.5) },
    { r: 2600 * k, h: 168 * k, freq: 2.5, tint: far },
  ];
  for (const L of layers) {
    const seg = 96;
    for (let i = 0; i < seg; i++) {
      const a0 = (Math.PI * 2 * i) / seg;
      const a1 = (Math.PI * 2 * (i + 1)) / seg;
      const hAt = (a: number): number =>
        L.h *
        (0.35 +
          0.4 * (0.5 + 0.5 * Math.sin(a * L.freq + L.r * 0.001)) +
          0.25 * (0.5 + 0.5 * Math.sin(a * L.freq * 2.7 + 1.3)));
      const base = heightAt(0, 1200) - 30;
      p0.set(Math.cos(a0) * L.r, base, Math.sin(a0) * L.r);
      p1.set(Math.cos(a1) * L.r, base, Math.sin(a1) * L.r);
      p2.set(Math.cos(a1) * L.r, base + hAt(a1), Math.sin(a1) * L.r);
      p3.set(Math.cos(a0) * L.r, base + hAt(a0), Math.sin(a0) * L.r);
      nrm.set(-Math.cos((a0 + a1) / 2), 0.25, -Math.sin((a0 + a1) / 2)).normalize();
      st.quadN(nrm, p0, p1, p2, p3, L.tint, L.tint, L.tint, L.tint);
    }
  }
}

// ---------------------------------------------------------------------------
// Tombs along the Via Flaminia
// ---------------------------------------------------------------------------

/**
 * Roadside tombs. Burial inside the walls was forbidden from the Twelve Tables on, so
 * the approaches to every Roman city ran through a street of monuments: drum tombs on
 * square podia after the fashion of Caecilia Metella, altar tombs, brick columbaria,
 * aedicula tombs and plain cippi, with cypress planted between them.
 */
export type TombKind = 'drum' | 'altar' | 'columbarium' | 'aedicula' | 'tumulus' | 'cippus';

export interface TombSite {
  x: number;
  z: number;
  kind: TombKind;
  rot: number;
  /** Governing dimension: drum radius, altar half-width, block half-width. */
  size: number;
  tone: number;
}

/**
 * Choose the tomb sites. Split out from the geometry so the planting that goes with
 * them is known before any chunk is baked, and so a tomb never changes type when its
 * chunk swaps detail level.
 */
function planRoadTombs(heightAt: Ground, rng: Rng): { sites: TombSite[]; trees: TreeRequest[] } {
  const sites: TombSite[] = [];
  const trees: TreeRequest[] = [];
  // Fixed pairs flanking the carriageway: the grandest tombs always stood closest to
  // the gate, and they are also the foreground of the establishing shot.
  // Positions are given as (metres back from the gate along the road, lateral offset)
  // and resolved against the road centreline and the crest, so the whole necropolis
  // follows the terrain instead of sitting at fixed coordinates.
  const gateZ = crestZAt(GATE_X);
  const onRoad = (back: number, lateral: number): { x: number; z: number } => {
    const z = gateZ - back;
    return { x: roadCentreX(z) + lateral, z };
  };
  const fixedSpec: [number, number, TombKind, number, number, number][] = [
    [26, -20, 'drum', 6.4, 0.1, 1.0],
    [30, 25, 'altar', 3.5, -0.08, 0.94],
    [62, -27, 'aedicula', 4.4, 0.06, 1.06],
    [66, 30, 'drum', 5.2, -0.14, 0.9],
    [104, -33, 'columbarium', 4.6, 0.12, 1.02],
    [112, 36, 'tumulus', 7.4, 0, 0.96],
    [150, -26, 'altar', 4.0, 0.2, 1.1],
    [158, 31, 'aedicula', 4.6, -0.2, 0.88],
  ];
  const fixed: TombSite[] = fixedSpec.map(([back, lat, kind, size, rot, tone]) => {
    const p = onRoad(back, lat);
    return { x: p.x, z: p.z, kind, rot, size, tone };
  });
  for (const t of fixed) {
    sites.push(t);
    if (t.kind === 'tumulus') trees.push({ x: t.x, z: t.z, kind: 'cypress', scale: 0.85, y: heightAt(t.x, t.z) + 2.2 + t.size * 0.4 });
    trees.push({ x: t.x + (t.x < 0 ? -8 : 8), z: t.z + 5, kind: 'cypress', scale: 1.05 });
    trees.push({ x: t.x + (t.x < 0 ? -6 : 6), z: t.z - 7, kind: 'cypress', scale: 0.92 });
  }
  for (let i = 0; i < 34; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    // The belt ran a couple of hundred metres out from the gate and crowded the road:
    // frontage on the Flaminia was the whole point of the monument.
    const z = gateZ - rng.range(14, 205);
    const x = roadCentreX(z) + side * (14 + rng.next() ** 1.7 * 62);
    const kind = rng.pickWeighted(
      ['drum', 'altar', 'columbarium', 'aedicula', 'tumulus', 'cippus'] as const,
      [0.18, 0.24, 0.14, 0.14, 0.14, 0.16]
    );
    const size = kind === 'drum' ? rng.range(4.2, 7.5) : kind === 'tumulus' ? rng.range(6, 11) : rng.range(2.6, 5.4);
    const rot = rng.jitter(0.5);
    const tone = rng.range(0.6, 1.05);
    const plantIt = rng.bool(0.6);
    const pa = rng.range(0, Math.PI * 2);
    const pr = rng.range(8, 13);
    const ps = rng.range(0.75, 1.1);
    // Keep the carriageway clear and stop tombs growing into one another.
    if (Math.abs(x - roadCentreX(z)) < 13) continue;
    let tooClose = false;
    for (const p of sites) if (Math.sqrt((p.x - x) * (p.x - x) + (p.z - z) * (p.z - z)) < size + p.size + 12) tooClose = true;
    if (tooClose) continue;
    sites.push({ x, z, kind, rot, size, tone });
    if (kind === 'tumulus') {
      trees.push({ x, z, kind: 'cypress', scale: 0.8, y: heightAt(x, z) + 2.2 + size * 0.4 });
    }
    // Cypress beside most tombs: the funerary tree, and it breaks the skyline of the
    // plain in front of the wall.
    if (plantIt) trees.push({ x: x + Math.cos(pa) * pr, z: z + Math.sin(pa) * pr, kind: 'cypress', scale: ps });
  }
  return { sites, trees };
}

function buildRoadTombs(batch: Batch, detail: number, heightAt: Ground, sites: TombSite[]): void {
  // Every stream this builder can touch, resolved up front and pushed together — the same
  // rule `buildLandmark` follows, and for the same reason.
  //
  // The aedicula branch used to reach for `batch.s('roof')` inline, inside the pushed region
  // but without ever pushing it, so its gable was emitted in *unshifted local coordinates*:
  // both aedicula roofs ended up stacked at the world origin at 20–30 m altitude, which is
  // dead centre of the battlefield. That is the pair of terracotta planes floating in mid-air
  // over open ground in every strategic frame. An unpushed stream fails silently and puts the
  // geometry somewhere plausible-looking, which is why it survived several passes.
  //
  // The keys are pushed through `batch.pushAll`, which resolves aliases: at far detail all
  // four of these are one stream, and pushing per key composed the placement matrix four
  // times — a duplicate necropolis at 4× its coordinates, 1.5 km out on the plain.
  const TOMB_KEYS: readonly CityMatKey[] = ['stone', 'brick', 'metal', 'roof'];
  const stone = batch.s('stone');
  const brick = batch.s('brick');
  const metal = batch.s('metal');
  const roof = batch.s('roof');

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    const g = heightAt(site.x, site.z);
    const m = new THREE.Matrix4().makeRotationY(site.rot).setPosition(site.x, 0, site.z);
    const pushed = batch.pushAll(TOMB_KEYS, m);
    const kind = site.kind;
    // Roadside tombs are tufa, travertine and brick, and half of them were rendered and
    // painted. Marble was for the very rich, and a whole necropolis of it reads as snow.
    const stock = hash2(i, 3, 617);
    // Tufa and peperino were cheap and got rendered; the render got painted. Ostia and the
    // Isola Sacra necropolis are full of ochre and red-washed tombs, and a street of bare
    // grey stone — which is what the first pass of this necropolis was — is both wrong and
    // the dullest possible frame.
    const base =
      stock < 0.30 ? PAL.travertineDirty
      : stock < 0.50 ? PAL.tufa
      : stock < 0.62 ? PAL.peperino
      : stock < 0.74 ? PAL.limeWhite
      : stock < 0.86 ? PAL.ochrePale
      : stock < 0.95 ? PAL.terraDirty
      : PAL.pompeianRed;
    const weathered = new THREE.Color().copy(base).multiplyScalar(site.tone * 0.86);

    if (kind === 'drum') {
      // Caecilia Metella is 29.5 m across; the ordinary roadside version is a third
      // of that on a square podium two courses high.
      const r = site.size;
      const podium = r * 1.35;
      box(stone, -podium, g - 0.5, -podium, podium, g + r * 0.55, podium, new THREE.Color().copy(weathered).multiplyScalar(0.82), { topGain: 1.06, groundShade: 0.22 });
      cylinder(stone, 0, g + r * 0.55, 0, r, r * 0.98, r * 1.5, detail >= 1 ? 16 : 8, weathered, { shadeLow: 0.26 });
      cylinder(stone, 0, g + r * 0.55 + r * 1.5, 0, r + 0.5, r + 0.5, 0.6, detail >= 1 ? 16 : 8, new THREE.Color().copy(PAL.travertine).multiplyScalar(0.9), { top: true });
      if (detail >= 1) {
        // Frieze of bucrania and garlands, read as a band of blocks at this distance.
        const n = detail >= 2 ? 18 : 10;
        for (let k = 0; k < n; k++) {
          const a = (Math.PI * 2 * k) / n;
          box(stone, Math.cos(a) * r - 0.34, g + r * 0.55 + r * 1.18, Math.sin(a) * r - 0.34, Math.cos(a) * r + 0.34, g + r * 0.55 + r * 1.42, Math.sin(a) * r + 0.34, new THREE.Color().copy(PAL.travertine).multiplyScalar(0.96));
        }
      }
      // Conical earth cap, as on Caecilia Metella before the medieval crenellations.
      cylinder(stone, 0, g + r * 0.55 + r * 1.5 + 0.6, 0, r * 0.92, 0, r * 0.8, detail >= 1 ? 14 : 7, new THREE.Color().copy(PAL.dust).multiplyScalar(0.7).lerp(PAL.vine, 0.28));
    } else if (kind === 'altar') {
      const w = site.size * 0.8;
      const h = site.size * 1.35;
      box(stone, -w * 1.25, g - 0.4, -w * 1.25, w * 1.25, g + 0.7, w * 1.25, weathered, { topGain: 1.1 });
      box(stone, -w, g + 0.7, -w, w, g + h, w, new THREE.Color().copy(weathered).multiplyScalar(1.12), { topGain: 1.12 });
      // Drip staining under the cornice, and dirt splashed up off the road onto the plinth.
      // Water sheds off a projecting cornice and runs back onto the face below it, so a
      // monument is dark in a band immediately under its overhang and dark again at its
      // foot, and pale and sun-bleached in between. Nothing sells cut stone as *old* faster.
      dripStain(stone, w, g + h - w * 0.42, w * 0.42, weathered, 0.60, true);
      dripStain(stone, w * 1.25, g - 0.3, 0.85, weathered, 0.52, false);
      box(stone, -w * 1.16, g + h, -w * 1.16, w * 1.16, g + h + 0.55, w * 1.16, new THREE.Color().copy(PAL.travertine).multiplyScalar(0.92), { topGain: 1.2 });
      if (detail >= 1) {
        // Inscription panel and a portrait niche.
        box(stone, -w * 0.66, g + h * 0.52, -w - 0.07, w * 0.66, g + h * 0.86, -w + 0.06, PAL.marbleShadow);
        box(stone, -w * 0.34, g + h * 0.14, -w - 0.04, w * 0.34, g + h * 0.46, -w + 0.22, new THREE.Color(0.05, 0.045, 0.04));
        // Corner *pulvini*: horizontal bolsters lying along the top, which is the
        // detail that makes an altar tomb read as an altar.
        for (const sx of [-1, 1]) {
          const bm = new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(sx * w * 0.78, g + h + 0.86, -w * 0.9);
          stone.push(bm);
          cylinder(stone, 0, 0, 0, 0.3, 0.3, w * 1.8, 8, new THREE.Color().copy(PAL.travertine).multiplyScalar(0.94), { top: true, bottom: true });
          stone.pop();
        }
      }
    } else if (kind === 'columbarium') {
      const w = site.size * 1.15;
      const d = site.size * 0.92;
      const h = site.size * 1.5;
      box(brick, -w, g - 0.5, -d, w, g + h, d, new THREE.Color().copy(PAL.brick).multiplyScalar(site.tone * 0.92), { groundShade: 0.26, topGain: 1.06 });
      // Brick stains harder than stone: the whole top third under the cornice goes dark.
      dripStain(brick, Math.min(w, d), g + h - h * 0.3, h * 0.3, new THREE.Color().copy(PAL.brick).multiplyScalar(site.tone * 0.92), 0.44, true);
      box(stone, -w - 0.3, g + h, -d - 0.3, w + 0.3, g + h + 0.4, d + 0.3, new THREE.Color().copy(PAL.travertine).multiplyScalar(0.9), { topGain: 1.18 });
      if (detail >= 1) {
        brick.pushTranslate(0, g, -d);
        archPanel(brick, w * 2, h, PAL.brick, { depth: 0.5, spring: 2.3, openWidth: 1.4, segments: detail >= 2 ? 7 : 4, voidCol: new THREE.Color(0.03, 0.026, 0.02) });
        brick.pop();
        // Rows of niche arches down the flank.
        for (let r2 = 0; r2 < 2; r2++) {
          for (let k = 0; k < 3; k++) {
            const px = -w * 0.6 + (k * w * 1.2) / 2;
            box(brick, px - 0.34, g + 1.2 + r2 * 1.9, d - 0.06, px + 0.34, g + 2.2 + r2 * 1.9, d + 0.18, new THREE.Color(0.04, 0.035, 0.03));
          }
        }
      }
    } else if (kind === 'aedicula') {
      const w = site.size * 0.9;
      box(stone, -w, g - 0.4, -w * 0.8, w, g + 2.2, w * 0.8, weathered, { topGain: 1.1 });
      for (const sx of [-1, 1]) column(stone, sx * (w - 0.55), g + 2.2, -w * 0.6, 0.34, 4.4, 'corinthian', new THREE.Color().copy(PAL.travertine).multiplyScalar(0.94), detail - 1);
      box(stone, -w, g + 2.2, w * 0.1, w, g + 6.8, w * 0.8, weathered, { topGain: 1.08 });
      box(stone, -w - 0.25, g + 6.6, -w * 0.85, w + 0.25, g + 7.3, w * 0.85, new THREE.Color().copy(PAL.travertine).multiplyScalar(0.94), { topGain: 1.16 });
      pediment(stone, (w + 0.25) * 2, g + 7.3, w * 1.7, new THREE.Color().copy(PAL.travertine).multiplyScalar(0.94), 0.26);
      // A pediment with nothing behind it is a flat-topped box with a triangle on it.
      gableRoof(stone, roof, (w + 0.25) * 2 - 0.4, w * 1.7 - 0.4, g + 7.3, (w + 0.25) * 0.26, 0.3, PAL.roofTileOld, false);
      if (detail >= 1) box(stone, -0.5, g + 2.4, -w * 0.2, 0.5, g + 5.4, w * 0.3, new THREE.Color(0.04, 0.036, 0.03));
    } else if (kind === 'tumulus') {
      const r = site.size;
      cylinder(stone, 0, g - 0.6, 0, r, r * 0.98, 2.4, detail >= 1 ? 14 : 7, weathered, { shadeLow: 0.2 });
      cylinder(stone, 0, g + 1.8, 0, r + 0.4, r + 0.4, 0.4, detail >= 1 ? 14 : 7, PAL.travertine, { top: true });
      dome(stone, 0, g + 2.2, 0, r * 0.95, detail >= 1 ? 14 : 7, detail >= 1 ? 5 : 2, new THREE.Color().copy(PAL.dust).multiplyScalar(0.68).lerp(PAL.vine, 0.36), { heightScale: 0.42 });
    } else {
      // A plain *cippus* and a bench: the poor man's frontage on the great road.
      const h = 0.55 + site.size * 0.4;
      box(stone, -0.55, g - 0.3, -0.5, 0.55, g + h, 0.5, weathered, { topGain: 1.14 });
      box(stone, -0.75, g + h, -0.68, 0.75, g + h + 0.28, 0.68, new THREE.Color().copy(PAL.travertine).multiplyScalar(0.9), { topGain: 1.2 });
      if (detail >= 1) {
        box(stone, -0.42, g + h * 0.45, -0.56, 0.42, g + h * 0.82, -0.46, PAL.marble);
        box(stone, 1.3, g, -0.8, 3.4, g + 0.45, 0.8, weathered, { topGain: 1.12 });
      }
      if (detail >= 2) box(metal, -0.3, g + h + 0.28, -0.3, 0.3, g + h + 1.1, 0.3, PAL.bronze);
    }

    batch.popAll(pushed);
  }
}
