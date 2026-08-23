import { clamp } from '../../util/math';
import type { WayClass } from '../layout';
import { worldOf } from './survey';

/**
 * Rome's road armature, authored in **survey metres, off the plates, and never deflected.**
 *
 * This file is phase 3 of `docs/ROME-FABRIC.md` §5, and it exists because of the fault that
 * document's §2.4 names: *"roads are drawn, then bent around the buildings."* The old
 * `STREET_PLAN` lived inside `layout.ts` beneath the monument placement, and every way it
 * produced was passed through `deflect()` — resampled every 30 m and pushed out of whatever
 * the overlap resolver had left in the way. The order was inverted, and the symptom was
 * measurable: **24 % of ranked street length inside a monument**, and the Via Lata — the
 * straightest street in Europe and the axis of the assault — drawn as a bow.
 *
 * So the table moved out of `layout.ts` into its own file, above the fabric rather than below
 * the monuments, and three rules govern it:
 *
 *  1. **Every row is authored in survey metres and projected once.** No row is a function of
 *     any monument's position. `deflect`, `monumentRings` and `feeders` are deleted, so there
 *     is no code path anywhere that can move a way after it is drawn.
 *  2. **If a way meets a monument, the way wins.** The way keeps its line; the *paving* skips
 *     the cells that stand on masonry (`onMonument`), and the residual is reported by name,
 *     per way and per monument, at every boot (`assertWaysClearOfMonuments`). A way is only
 *     re-authored when the **plate** says the real street went somewhere else — which, for the
 *     one case everybody expected to be a trade, turned out to be the whole answer. See
 *     `via-lata` below.
 *  3. **Every row cites the plate it came off**, in the format `MAP-METHOD.md` rule 2 asks for.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE COORDINATES COME FROM, AND HOW GOOD THEY ARE
 * ---------------------------------------------------------------------------
 *
 * Three sources, used for three different things, because no single plate in the pool can do
 * all three (`ASSETS.md` items 5, 8, 9, 11):
 *
 *  - **Shepherd, *Historical Atlas* pl. 22 (1911/1923) — identification.** The only plate in
 *    the pool that *names* the streets: Flaminian Way, Via Lata ("Broad Way"), Alta Semita
 *    ("High Path"), Vicus Longus ("Long Street"), Vicus Patricius ("Patrician Street"),
 *    Clivus Suburanus, Argiletum, Via Tecta, and every gate. It is **not georeferenced**;
 *    `tools/scratch/rome-roads.mjs --fit` fits a plain 6-parameter affine from its pixels to
 *    this survey frame by least squares **on eight monuments whose coordinates come out of
 *    `survey.ts`**, and prints the residual: **RMS 28.5 real metres, worst 56.7 m (the
 *    Colosseum)**, at a plate scale of 2.147 m/px and a plate rotation of −1.58° off survey
 *    north. So a line read off Shepherd is good to about 30 m and no better, and rows that
 *    say `[PLATE Shepherd]` carry that error.
 *  - **AGEA 2012 orthophoto / Lanciani georectified — geometry.** Both carry the same affine
 *    as `src/city/overlay.ts`, fitted to 1.26 m over 7 km. Where an ancient way survives as a
 *    modern street the coordinates are read off these instead, and the row says
 *    `[PLATE AGEA]`. This is the accurate source and it is used for the way that matters.
 *  - **ColdEel 2006 — topology.** Which consular road enters which gate, which street links
 *    which two regions. No metric use; `ASSETS.md` item 11 forbids it.
 *
 * And one rule that is not a plate at all, stated because it decides several rows:
 *
 *  - **Where a way must meet a feature the engine has already fixed — a gate mouth, the
 *    Capitol, the river bank — the endpoint is pinned to the engine's value and the plate
 *    supplies only the bearing.** Marked `[PIN]`. The Porta Salaria is the loud case: the
 *    engine puts it at `e 1036`, the geodesy of Piazza Fiume puts it at `e ~1190`, and
 *    Shepherd's own ink puts it at `e ~1390`. Three answers 350 m apart. The gate is built,
 *    the road is not, so the road moves.
 *
 * ---------------------------------------------------------------------------
 * THE RANKS
 * ---------------------------------------------------------------------------
 *
 * `docs/ROME-FABRIC.md` §4.2 names six ranks; `WayClass` in `src/city/layout.ts` has four and
 * is **shared with Carthage**, which is this pass's control and must not move. The map is:
 *
 * | §4.2 rank | `WayClass` | width | membership here |
 * |---|---|---:|---|
 * | processional | `artery` | 42 m | **`via-lata` alone**, plus the `via-sagularis` behind the curtain |
 * | consular | `secondary` | 24 m | 11 ways: the four gate roads, the Alta Semita, the Via Recta, the Via Sacra, the Labicana, the Tiburtina, the Appia, the Triumphalis |
 * | local | `local` | 14 m | 12 *vici* and *clivi* |
 * | vicus | `vicus` | 8 m | the grid's own cross-lanes — **phase 4**, not authored here |
 * | pomerium way | `artery` | 42 m | `via-sagularis`, unchanged, still built in `layout.ts` |
 * | clivus (stepped) | — | — | **owed.** The stepped treatment is Carthage's `streets.ts` and is not wired here; the four *clivi* carry `local` rank and ordinary paving, and `docs/MAP-METHOD.md` §3 records the debt. A flag nothing reads is worse than no flag (`ROME-FABRIC.md` §9.9 on `maxDrawAt`). |
 *
 * **The four demotions §4.2 asked for are done:** `via-appia`, `via-triumphalis` and
 * `via-sacra` drop from `artery` to `consular`, and the fourth — the `feeder-*` links, which
 * were `artery` and are 17 more 42 m corridors nobody authored — is a deletion rather than a
 * demotion. That is 3 × 18 m of carriageway width over 5.6 km of named way, plus 3.4 km of
 * feeder at 42 m, handed back to the fabric.
 *
 * **Six additions §4.2 asked for, all present:** `clivus-suburanus`, `argiletum`, `via-tecta`,
 * `clivus-capitolinus`, `subura`, `via-pinciana`. Plus `clivus-argentarius`, which is not on
 * §4.2's list and had to be added anyway: without it the Via Lata's southern end dies 350 m
 * short of the Forum and the armature is in two pieces.
 */
export interface RomeWay {
  id: string;
  /** Rank. See the table above for the mapping onto `docs/ROME-FABRIC.md` §4.2's six. */
  cls: WayClass;
  /** Survey metres, `[e, n]`. Projected once by `worldOf`; never resampled, never deflected. */
  path: [number, number][];
  /** Polygonal basalt (true) or beaten earth (false). */
  paved: boolean;
  /** Colonnaded footway and marble kerbs. Rome's processional ways were porticoed. */
  porticoed?: boolean;
  /**
   * This way runs **outside the curtain** and must not be clamped to the city side of it.
   *
   * `NAMED_WAYS` clamps every node to `[CITY_Z_MIN(x) − 18, CITY_Z_MAX]`, which is 18 world
   * metres of slack outside the wall and no more — so before this flag existed *no way could
   * leave the city*, and the four consular roads the assault forms up on could not be drawn
   * at all. A way that carries it is clamped to the map instead.
   */
  outside?: boolean;
  /**
   * This way passes through a named aperture, and the node nearest it is **pinned to the
   * gate's own world position** by `layout.ts`.
   *
   * It has to be, and the reason is a 150-metre disagreement nobody had measured. A gate's
   * `x` comes from the survey (`worldOf(e, n).x`) but its `z` comes from the **terrain**: the
   * circuit is drawn on `romeWallZ(x)`, the crest the heightfield actually has. Those two
   * agree exactly at the Porta Flaminia, because the projection is anchored on it — and
   * nowhere else. At the Porta Salaria `worldOf(1036, 1784).z` is 621 and the crest is 469;
   * at the Porta Nomentana, 621 against 484. So a road authored to arrive at the gate's
   * surveyed northing stops **137–152 world metres inside the city**, short of the mouth, and
   * `ROME-FABRIC.md` §4.2's third membership rule — every gate's inner mouth on a consular
   * way — silently cannot be satisfied by authoring alone. The Via Lata has had a hand-written
   * version of this pin since phase 1; this generalises it and names the four rows that use it.
   */
  gate?: 'porta-flaminia' | 'posterula-pinciana' | 'porta-salaria' | 'porta-nomentana';
  /** The plate, and what was read off it. `MAP-METHOD.md` rule 2. */
  cite: string;
}

export const ROME_WAYS: readonly RomeWay[] = [
  // -------------------------------------------------------------------------
  // PROCESSIONAL — one way, and it is the reason this phase exists
  // -------------------------------------------------------------------------
  {
    id: 'via-lata',
    cls: 'artery',
    /**
     * **The Via Lata is dead straight, and the Mausoleum of Augustus is not on it.**
     *
     * This row is the answer to the one conflict phase 3 was told to resolve rather than
     * dodge, so the working is here in full.
     *
     * *The conflict as it was posed.* The Mausoleum, at its surveyed position `e −481 /
     * n 1500` — measured to zero displacement against the Lanciani plate in phase 2 — put
     * **85 unbroken metres of masonry across the carriageway**, and took the gate axis from
     * 18 % solid to 32 %. Phase 3 of the landmark work (`ROME-FABRIC.md` §9.6) treated that
     * as a genuine trade and bent the last hundred metres of the street round the tomb's
     * eastern flank, on a ground judge's advice. The bow is 360 real metres off the line at
     * its worst.
     *
     * *What the plates actually say.* **The tomb was never on the street.** Three independent
     * sources put the Via Lata 140–160 real metres east of the Mausoleum's centre:
     *
     *  - **[PLATE AGEA]** Via del Corso is the Via Lata; the georectified orthophoto puts its
     *    centreline at `e ≈ −338` on the Mausoleum's own northing.
     *  - **[PLATE Shepherd]** the road carrying the labels "Flaminian Way" and "Via Lata
     *    (Broad Way)" reads `e ≈ −341` at `n 1500` through the fitted affine, and is dead
     *    straight from the Flaminian Gate to the plate's south edge — the two readings agree
     *    to **3 metres**, which is a tenth of the Shepherd fit's own RMS.
     *  - **[DER]** the two termini as coordinates: Piazza del Popolo (the Porta Flaminia, and
     *    this projection's own anchor) and Piazza Venezia (the Capitol's north foot) are
     *    `e −497 / n 2045` and `e 0 / n 367` in this frame. The straight line between them
     *    passes `e −336` at `n 1500`.
     *
     * The tomb's masonry is 87 m across, so its east face stands at `e −437`. **The
     * carriageway's west kerb, at `e −357`, clears it by 80 real metres.** There is no
     * conflict to trade: the old armature ran `[−470, 1560] → [−440, 1080]`, which is
     * 100–150 m *west* of the real street and straight through a tomb that stands beside it.
     * **The obstruction was a survey error in the road, and the bow was a fix for a fault
     * that did not exist.** Both are gone.
     *
     * *What does not change, and is the good half of the finding.* The **gate's own outward
     * normal** is not the road. The circuit runs east–west at the Porta Flaminia, so the
     * normal is due south in world terms; the Via Lata leaves at 16.4° off it. The Mausoleum
     * stands **16 real metres** off that normal, 545 m in. So the frame the ground judge
     * called the best view the map has produced is untouched — the tomb still closes the view
     * straight out of the breach — and the street is now visibly the *other* line, peeling
     * away east round it. The terminus and the obstruction are still the same object; they
     * are simply on two different lines, which is what the plate has said all along.
     * `assertGateAxisClear` measures the normal and `assertWaysClearOfMonuments` measures the
     * carriageway, both at every boot, and neither is reported as the other.
     *
     * The six nodes below are collinear to under a metre. They exist so the keep-out capsule
     * chain and the paving have vertices to work with, not because the road bends anywhere.
     */
    path: [
      [-497, 2045],
      [-395, 1700],
      [-291, 1350],
      [-187, 1000],
      [-84, 650],
      [0, 367],
    ],
    paved: true,
    porticoed: true,
    gate: 'porta-flaminia',
    cite: '[PLATE AGEA] Via del Corso centreline; [PLATE Shepherd] "Via Lata (Broad Way)"; '
      + '[PIN] north end on PORTA_FLAMINIA (−497, 2045), the projection anchor',
  },

  // -------------------------------------------------------------------------
  // CONSULAR — the four gate roads, drawn THROUGH their gates
  // -------------------------------------------------------------------------
  /**
   * Each of the four is one way that crosses its own gate, rather than an outer road and an
   * inner road that happen to meet there. That is not tidiness: `ROME-FABRIC.md` §4.2's third
   * membership rule is that **every gate's inner mouth lands on a way of rank consular or
   * better**, and a way that passes through the mouth satisfies it by construction and cannot
   * drift out of it later. One of four did before this pass; four of four do now, and
   * `assertGateMouths` fails the boot if that stops being true.
   */
  {
    id: 'via-flaminia',
    cls: 'secondary',
    // North out of the Porta Flaminia to the Milvian Bridge. Shepherd's "Flaminian Way" runs
    // NNW from the gate at about de/dn −0.09; the first node is the gate itself, which is the
    // projection's anchor, so the join to `via-lata` is exact rather than near.
    path: [
      [-497, 2045],
      [-530, 2500],
      [-580, 3100],
      [-640, 3750],
      [-690, 4150],
    ],
    paved: true,
    outside: true,
    gate: 'porta-flaminia',
    cite: '[PLATE Shepherd] "Flaminian Way"; [PIN] south end on the Porta Flaminia',
  },
  {
    id: 'via-pinciana',
    cls: 'secondary',
    // Through the Posterula Pinciana, which the engine fixes at (530, 1789) — 25 m from the
    // real Porta Pinciana at Piazza Fiume's western neighbour, so no pin conflict here. North
    // of the wall it climbs into the Horti; south of it, it drops off the Pincian scarp to the
    // Alta Semita, and that inner leg is what puts a consular way in the posterula's mouth.
    path: [
      [830, 3600],
      [760, 3100],
      [680, 2600],
      [600, 2150],
      [530, 1789],
      [560, 1500],
      [650, 1200],
      [778, 1002],
    ],
    paved: true,
    outside: true,
    gate: 'posterula-pinciana',
    cite: '[PLATE Shepherd] "Pincian Way"; [PIN] mid node on the Posterula Pinciana (530, 1789); '
      + 'inner leg joins alta-semita at (778, 1002)',
  },
  {
    id: 'via-salaria',
    cls: 'secondary',
    // Through the Porta Salaria. The three sources disagree by 350 m about where that gate is
    // (see the header) and the engine's answer wins because the engine has already built it.
    // South of the gate the road runs down to the Alta Semita at the Colline Gate's old
    // position, which is what it really did.
    path: [
      [1400, 3900],
      [1330, 3400],
      [1250, 2900],
      [1160, 2400],
      [1036, 1784],
      [1120, 1580],
      [1250, 1420],
    ],
    paved: true,
    outside: true,
    gate: 'porta-salaria',
    cite: '[PLATE Shepherd] "Salarian Gate" and its road; [PIN] gate node on SALARIA_X (1036, 1784)',
  },
  {
    id: 'via-nomentana',
    cls: 'secondary',
    // Through the Porta Nomentana, north-east past the Castra Praetoria's west flank. The
    // outer nodes stop at e 2430 because e 2450 projects to x 1377 and the heightfield ends
    // at 1400.
    path: [
      [2430, 3300],
      [2300, 2900],
      [2120, 2450],
      [1900, 2250],
      [1831, 1784],
      [1780, 1650],
    ],
    paved: true,
    outside: true,
    gate: 'porta-nomentana',
    cite: '[PLATE Shepherd] "Nomentan Way"; [PIN] gate node on NOMENTANA_X (1831, 1784)',
  },

  // -------------------------------------------------------------------------
  // CONSULAR — inside the wall
  // -------------------------------------------------------------------------
  {
    id: 'alta-semita',
    cls: 'secondary',
    /**
     * The Quirinal ridge road, and the spine of everything east of the Via Lata.
     *
     * Shepherd labels it twice — "Alta Semita" and, further north-east, its own translation
     * "(High Path)" — and both labels sit on the same line, which reads through the fitted
     * affine as a gentle curve from the head of the Forum valley up onto the ridge and away
     * north-east. Nodes 4–8 are that reading. Nodes 1–3 are the climb from the Forum, routed
     * to pass 96 m north of Trajan's Market and 35 m north of the Basilica Ulpia; node 9 is
     * the Porta Nomentana's mouth, pinned.
     *
     * It passes 34 m east of the Temple of Serapis on the Quirinal's brow, which is the side
     * the plate puts it on: the Serapeum faced the Campus Martius and the ridge road ran
     * behind it.
     */
    path: [
      [0, 367],
      [150, 470],
      [300, 540],
      [480, 600],
      [600, 740],
      [700, 890],
      [800, 1020],
      [1000, 1190],
      [1250, 1420],
      [1560, 1620],
      [1750, 1700],
      [1831, 1784],
    ],
    paved: true,
    gate: 'porta-nomentana',
    cite: '[PLATE Shepherd] "Alta Semita" / "(High Path)"; [PIN] north end on the Porta Nomentana',
  },
  {
    id: 'via-recta',
    cls: 'secondary',
    /**
     * **Moved 300 metres north, which is most of the reason G4 was red.**
     *
     * The old row ran `n 520–600` across the Campus Martius, which is straight through the
     * Pantheon, the Baths of Agrippa, the Iseum and the Stadium of Domitian — 27 % of its
     * length inside masonry, the worst named way on the map. The real Via Recta is the line
     * of the Via dei Coronari and the Via delle Coppelle, which the georectified orthophoto
     * puts at `n 900–980`: **north** of the Stadium, not through it. On this line the whole
     * monumental core of the Campus Martius is south of the street, which is what the plate
     * shows and what makes the quarter read.
     *
     * West end on the Via Tecta at the Pons Neronianus's bridgehead; east end on the Via Lata
     * at `n 905`, computed from the Via Lata's own line so the junction is exact — the Column
     * of Marcus Aurelius stands at that junction on the plate, 51 m off, which is a check
     * rather than a coincidence.
     */
    path: [
      [-1290, 980],
      [-1050, 945],
      [-800, 940],
      [-500, 930],
      [-159, 905],
    ],
    paved: true,
    cite: '[PLATE AGEA] Via dei Coronari / Via delle Coppelle; [DER] east end on the via-lata line at n 905',
  },
  {
    id: 'via-sacra',
    cls: 'secondary',
    // Demoted from `artery` per §4.2: forty-two metres of processional way through the Forum
    // is four cohort-widths where the history has one, and the Forum's own floor is a plaza
    // rather than a street. Out of the Capitol foot, across the Forum, over the Velia past
    // the Arch of Titus, and stopping short of the Colosseum's precinct — the Via Labicana
    // picks it up on the far side.
    path: [
      [170, 40],
      [240, -20],
      [340, -45],
      [470, -190],
      [560, -230],
      [610, -240],
    ],
    paved: true,
    porticoed: true,
    cite: '[PLATE Shepherd] the Forum spine and the Arch of Titus (23) at (488, −206)',
  },
  {
    id: 'via-labicana',
    cls: 'secondary',
    // Round the Colosseum's north side and out east through the 50 m gap between the Baths of
    // Titus and the Ludus Magnus — which is a real corridor, not a compromise: that gap is
    // where the Via Labicana ran and it is why the Ludus was built where it was.
    path: [
      [610, -240],
      [720, -160],
      [900, -140],
      [1100, -145],
      [1400, -145],
      [1750, -150],
      [2100, -155],
      [2450, -160],
    ],
    paved: true,
    cite: '[PLATE Shepherd] "Labican Way" east of the Flavian Amphitheatre',
  },
  {
    id: 'via-tiburtina',
    cls: 'secondary',
    // The Clivus Suburanus's continuation out over the Esquiline. Starts on a
    // `clivus-suburanus` node so the junction is exact; runs to the map's east edge.
    path: [
      [1780, 345],
      [1980, 470],
      [2200, 600],
      [2450, 720],
    ],
    paved: true,
    cite: '[PLATE Shepherd] "Tiburtine Way" out of the Esquiline gate',
  },
  {
    id: 'via-appia',
    cls: 'secondary',
    // Demoted from `artery` per §4.2. South out of the city between the Palatine and the
    // Caelian, down the Vallis Murcia with the Circus Maximus's whole flank beside it.
    path: [
      [430, -180],
      [440, -300],
      [450, -365],
    ],
    paved: true,
    cite: '[PLATE Shepherd] "Appian Way"; unchanged from phase 2 except in rank',
  },
  {
    id: 'via-triumphalis',
    cls: 'secondary',
    // Demoted from `artery`, and moved 80–120 m west off the Stadium of Domitian's west flank,
    // which the old line ran 38 m inside. Up the west side of the Campus Martius from the
    // Pons Neronianus.
    path: [
      [-1290, 980],
      [-1120, 900],
      [-990, 800],
      [-950, 620],
      [-930, 380],
      [-880, 120],
      [-790, -160],
      [-620, -330],
      [-562, -365],
    ],
    paved: true,
    cite: '[PLATE Shepherd] the road inside the Tiber bend; [DER] shifted west clear of stadium-domitian',
  },

  // -------------------------------------------------------------------------
  // LOCAL — the vici and the clivi
  // -------------------------------------------------------------------------
  {
    id: 'via-tecta',
    cls: 'local',
    // ADDED (§4.2). The covered way along the Campus Martius river frontage, from the
    // Pons Neronianus's bridgehead down past the Navalia to the Circus Flaminius. Shepherd
    // labels it in the Tiber bend; the south end is set on a `via-triumphalis` node.
    path: [
      [-1290, 980],
      [-1210, 830],
      [-1140, 680],
      [-1080, 530],
      [-1010, 430],
      [-930, 380],
    ],
    paved: true,
    cite: '[PLATE Shepherd] "Via tecta" inside the Tiber bend',
  },
  {
    id: 'clivus-argentarius',
    cls: 'local',
    // ADDED, and not on §4.2's list. Without it the Via Lata's southern end stops at Piazza
    // Venezia 350 m from the Forum and the armature is in two pieces. The Clivus Argentarius
    // is the real street that closes that gap — up between the Capitol and the Quirinal from
    // the Forum to the Campus Martius — so the graph is connected by a road that existed.
    path: [
      [0, 367],
      [40, 280],
      [80, 170],
      [120, 60],
      [160, -30],
      [185, -55],
    ],
    paved: true,
    cite: '[PLATE Shepherd] the road between the Arx and Trajan\'s Forum; [DER] north end on the via-lata terminus',
  },
  {
    id: 'argiletum',
    cls: 'local',
    // ADDED (§4.2). Out of the Forum's north-east corner past the Curia into the Subura.
    path: [
      [340, -45],
      [450, 60],
      [600, 135],
      [800, 205],
    ],
    paved: true,
    cite: '[PLATE Shepherd] "Argiletum", labelled along its own line',
  },
  {
    id: 'subura',
    cls: 'local',
    // ADDED (§4.2, "the Subura's own line"). The valley street that ties the Vicus Longus,
    // the Vicus Patricius and the Clivus Suburanus into one junction, which is what the
    // Subura was.
    path: [
      [570, 300],
      [700, 275],
      [880, 250],
      [1030, 240],
    ],
    paved: true,
    cite: '[PLATE Shepherd] the streets drawn under the "Subura" label',
  },
  {
    id: 'clivus-suburanus',
    cls: 'local',
    // ADDED (§4.2). The climb east out of the Subura to the Porta Esquilina. Owed: it is one
    // of the four ways §4.2 wants stepped, and nothing here steps it yet.
    path: [
      [800, 205],
      [1030, 240],
      [1290, 280],
      [1560, 315],
      [1780, 345],
    ],
    paved: true,
    cite: '[PLATE Shepherd] "Clivus Suburanus", labelled along its own line',
  },
  {
    id: 'vicus-longus',
    cls: 'local',
    // "The long street", up the valley floor between the Quirinal and the Viminal. Shepherd
    // labels it twice, "Vicus Longus" and "(Long Street)", along one line at de/dn 0.556; the
    // last node is set on the Alta Semita so the north end is a junction, not a stub.
    path: [
      [453, 90],
      [520, 210],
      [637, 420],
      [754, 630],
      [871, 840],
      [987, 1050],
      [1056, 1250],
    ],
    paved: true,
    cite: '[PLATE Shepherd] "Vicus Longus (Long Street)"; [DER] north end on the alta-semita line at n 1250',
  },
  {
    id: 'vicus-patricius',
    cls: 'local',
    // Up the Viminal's flank from the Subura. Shepherd's "Vicus Patricius (Patrician Street)"
    // reads de/dn 0.747, which is NNE and about 40° off the line this way used to carry. The
    // last two nodes are the run on to the agger, and they are [DER] rather than read.
    path: [
      [880, 250],
      [1017, 434],
      [1156, 620],
      [1290, 800],
      [1410, 960],
      [1500, 1290],
      [1560, 1620],
    ],
    paved: true,
    cite: '[PLATE Shepherd] "Vicus Patricius (Patrician Street)"; [DER] north end on an alta-semita node',
  },
  {
    id: 'vicus-iugarius',
    cls: 'local',
    // Round the foot of the Capitol from the Forum to the Forum Boarium and the river gate.
    path: [
      [185, -55],
      [60, -140],
      [-100, -230],
      [-300, -330],
      [-366, -365],
    ],
    paved: true,
    cite: '[PLATE Shepherd] "Vic. Iugarius" and "Velabrum"',
  },
  {
    id: 'vicus-tuscus',
    cls: 'local',
    // The other way out of the Forum's south-west corner, past the Basilica Julia to the
    // Velabrum. Paired with the Iugarius round the Capitol's foot.
    path: [
      [215, -70],
      [150, -250],
      [80, -365],
    ],
    paved: true,
    cite: '[PLATE Shepherd] the street south of the Basilica Julia (20)',
  },
  {
    id: 'clivus-capitolinus',
    cls: 'local',
    // ADDED (§4.2). The ramp up the Capitol from the Forum, round the Tabularium to the Area
    // Capitolina. Stops short of the Temple of Jupiter's precinct, which is where it stopped.
    path: [
      [185, -55],
      [120, -30],
      [75, 5],
      [45, 35],
    ],
    paved: true,
    cite: '[PLATE Shepherd] the ramp between the Tabularium and the Arx',
  },
  /**
   * **`via-ostiensis` and `clivus-aventinus` are deleted, and the reason is the frame's south
   * edge rather than the plate.**
   *
   * `CITY_Z_MAX` is 1374 world metres, which is survey northing **−367**. Both ways were
   * authored entirely south of it — the Ostiensis ran `n −420 … −1520`, the Clivus Aventinus
   * `n −700 … −1200` — so every node clamped to the same `z`, and what the map actually drew
   * was two carriageways lying flat along the map's own southern boundary. The same edge
   * already takes five monuments out of the survey by name (`offMapSouth`: the Palatine, the
   * Circus Maximus, the Aventine temples, the Baths of Caracalla, the Caelian villas), and a
   * way is no different from a monument in that respect: a row whose whole length is off the
   * frame is not a street, it is a line on the border.
   *
   * The two ways that *cross* the edge — `via-appia`, `vicus-iugarius`, `vicus-tuscus`, and the
   * southern tail of `via-triumphalis` — are truncated at `n −365` instead, which is the last
   * northing the frame can draw. Before this the Via Appia's four southern nodes all collapsed
   * onto `z 1374` and the pile-up landed inside the Colosseum's drawn footprint, which is where
   * 15 % of that way's reported intrusion came from.
   *
   * If the +Z cap is ever lifted, both rows come back; their coordinates are in this comment
   * and in the git history rather than in the table, so nothing draws them meanwhile.
   *
   *   via-ostiensis  local  [-470,-420] [-520,-800] [-560,-1180] [-580,-1520]
   *   clivus-aventinus local [-40,-700] [-180,-950] [-320,-1200]
   */
];

// ---------------------------------------------------------------------------
// The orientation field — the road network, published as a bearing
// ---------------------------------------------------------------------------

/**
 * **A block's orientation is a property of the streets that bound it.**
 *
 * `MAP-METHOD.md` rule 9, and the single measured fault this phase is graded on. Rome seeded
 * every quarter's whole lattice from `hash2(round(d.e), round(d.n), 0x5c1)` at ±20°, so two
 * blocks either side of an invisible district boundary sat at different angles with a random
 * offset. `probe-fabric` G20 measured the result at a **median 9.17° off the nearest street**
 * against Carthage's 0.00°, and G21 at **17–21 % of neighbouring blocks rotating more than 15°
 * across a 40 m gap**. That is the quilt, and no amount of texture hides it.
 *
 * §4.3's answer is to make blocks the *faces* of the road graph, which is phase 4. This is the
 * half of it phase 3 owns and can deliver honestly: **the road network publishes a bearing
 * field, and the fabric reads its orientation out of it instead of out of a hash.** The faces
 * are still cut by the lattice; what has changed is that the lattice is now aligned to the
 * streets everywhere rather than to a random number per quarter.
 *
 * **The field, and why it is defined the way it is.**
 *
 *  - It is built from the **authored** ways only — `ROME_WAYS` plus the pomerium road — not
 *    from the generated lanes. The generated lanes are downstream of this field, so reading
 *    them would be the self-consistency fault `MAP-METHOD.md` rule 6 is about: the fabric
 *    would be agreeing with itself about its own grain.
 *  - It is a **rank-weighted, distance-weighted circular mean** over segments within
 *    `FIELD_RADIUS`, doubled in angle so that a street and its perpendicular vote together —
 *    a block fronting a street and a block gable-end to it are both aligned to it, which is
 *    exactly the fold `probe-fabric` G20 applies when it grades the answer.
 *  - Where no ranked way is within the radius — the far bank, the Vatican fields — it returns
 *    the bearing of the *nearest* segment at any distance, so the field is total. A quarter
 *    with no street near it still takes its grain from the nearest one rather than from a
 *    hash, which is what a real fringe does.
 */
const FIELD_RADIUS = 420;
const RANK_WEIGHT: Readonly<Record<WayClass, number>> = {
  artery: 4,
  secondary: 3,
  local: 1.6,
  vicus: 1,
};

interface FieldSeg {
  x: number;
  z: number;
  len: number;
  /** Doubled-angle unit vector, weighted by rank and length. */
  c: number;
  s: number;
  w: number;
  bearing: number;
}

let SEGS: FieldSeg[] | null = null;

/**
 * **The pomerium road is deliberately not in the field, and the reason is order.**
 *
 * `via-sagularis` is generated in `layout.ts` from the wall crest, which is downstream of this
 * module. A `register`-style back-door would make the field's contents depend on whether
 * `DISTRICTS` or `WAYS` evaluated first — a cache that answers differently to two callers is
 * the shape of bug that costs a week, and this project has already paid for one. The field is
 * a pure function of `ROME_WAYS` and nothing else, so it gives the same answer to everybody.
 * The cost is that fabric immediately behind the curtain takes its grain from the nearest
 * authored way rather than from the military road; the pomerium is 60 m of reserved ground
 * there anyway, so the affected band is thin.
 */
function segments(): FieldSeg[] {
  if (SEGS) return SEGS;
  const out: FieldSeg[] = [];
  const add = (path: readonly { x: number; z: number }[], cls: WayClass): void => {
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const b = path[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      // `sqrt` and not `hypot`: `tools/check-determinism.mjs` measures the two disagreeing on
      // 37 % of inputs across engines, and src/city was cleared of `hypot` deliberately.
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 1e-3) continue;
      const bearing = Math.atan2(dz, dx);
      const w = RANK_WEIGHT[cls] * len;
      out.push({
        x: (a.x + b.x) * 0.5,
        z: (a.z + b.z) * 0.5,
        len,
        bearing,
        w,
        c: Math.cos(4 * bearing) * w,
        s: Math.sin(4 * bearing) * w,
      });
    }
  };
  for (const w of ROME_WAYS) {
    add(
      w.path.map(([e, n]) => worldOf(e, n)),
      w.cls
    );
  }
  SEGS = out;
  return out;
}

/**
 * The street bearing at a point, in the same convention `Obb.rot` uses.
 *
 * Quadrupled angle rather than doubled: `probe-fabric` folds the block/street angle modulo 90°
 * because a block parallel and a block perpendicular to its street are both aligned to it, and
 * a mean that does not fold the same way will average a street and its own cross-lane into the
 * 45° between them — which is the worst possible answer and is what the first version of this
 * function did. Averaging `4θ` and dividing by four makes the mean respect the same symmetry
 * the question has.
 */
export function wayBearingAt(x: number, z: number): number {
  const segs = segments();
  let c = 0;
  let s = 0;
  let bestD = Infinity;
  let bestB = 0;
  const r2 = FIELD_RADIUS * FIELD_RADIUS;
  for (const g of segs) {
    const dx = g.x - x;
    const dz = g.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD) {
      bestD = d2;
      bestB = g.bearing;
    }
    if (d2 > r2) continue;
    // Inverse-square-ish falloff with a 60 m core, so a way the block actually fronts
    // dominates one four hundred metres away without going singular on top of it.
    const f = 1 / (1 + d2 / 3600);
    c += g.c * f;
    s += g.s * f;
  }
  if (c === 0 && s === 0) return bestB;
  return Math.atan2(s, c) / 4;
}

/**
 * The nearest ranked way's bearing and distance, for the reports. Not used by the field.
 */
export function nearestWay(x: number, z: number): { bearing: number; distM: number } {
  const segs = segments();
  let bestD = Infinity;
  let bestB = 0;
  for (const g of segs) {
    const d2 = (g.x - x) ** 2 + (g.z - z) ** 2;
    if (d2 < bestD) {
      bestD = d2;
      bestB = g.bearing;
    }
  }
  return { bearing: bestB, distM: Math.sqrt(bestD) };
}

/** Smallest signed angle from `a` to `b`, folded into [−45°, +45°] under the 90° symmetry. */
export function foldToAxis(a: number, b: number): number {
  let d = (b - a) % (Math.PI / 2);
  if (d > Math.PI / 4) d -= Math.PI / 2;
  if (d < -Math.PI / 4) d += Math.PI / 2;
  return clamp(d, -Math.PI / 4, Math.PI / 4);
}
