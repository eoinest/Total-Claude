/**
 * **Rome's road network, photographed — phase 3 of the fabric rebuild.**
 *
 * `docs/ROME-FABRIC.md` §5 phase 3 authored the armature off the plates and deleted `deflect`,
 * `monumentRings` and `feeders`. These are the frames that let it be judged by eye rather than
 * by a table: the Via Lata along its length, a junction, and the network from above at a stated
 * scale. Every camera is a world coordinate written down, so a judge can stand in the same
 * place afterwards; `docs/MAP-METHOD.md` §3 lists the same table.
 *
 * **One file, one run, one browser.** `tools/film.mjs` takes a single budget slot and re-aims
 * one page for every shot. Splitting these across invocations burns a slot each and
 * self-deadlocks at cap 4. Do not fan out.
 *
 * Reading the camera fields — the format is `docs/video/SHOT-FORMAT.md` and the notes in
 * `rome-assembled.shot.mjs`. In short: `eye` is metres above the terrain **under the focus**,
 * `aim` the height of the look-at, `dist` the horizontal standoff, `yaw` 0 looks **+Z**, which
 * on this map is south into the city. `dist: 0` is a straight-down plan.
 *
 * The world coordinates that matter here, all from `worldOf` at `KX` 0.443 / `KZ` 0.35:
 *
 *   Porta Flaminia            (72.0, 529.7)   the gate, and the projection's own anchor
 *   Mausoleum of Augustus     (79.1, 720.5)   16 real m off the gate's normal, 148 off the road
 *   Via Lata at the tomb      (143.4, 720.5)  the carriageway, 64 world m east of the tomb
 *   Via Lata x Via Recta      (221.8, 928.8)  the Campus Martius's own crossroads
 *   Via Lata terminus         (292.2, 1117.1) the Capitol's north foot, Piazza Venezia
 */
export default {
  id: 'rome-roads',
  title: 'Rome, 271 AD — the road network, authored off the plates',
  width: 1920,
  height: 1080,
  quality: 'ultra',

  scenes: {
    rome: {
      map: 'campus-martius',
      scenario: 'assault',
      enemy: 'juthungi',
      hour: 9.5,
      seed: 4265438264,
      unitSize: 'ultra',
      difficulty: 'hard',
      weather: 'clear',
    },
  },

  shots: [
    // ---------------------------------------------------------------------------------
    // 1. THE VIA LATA ALONG ITS LENGTH. The picture the whole phase is about.
    // ---------------------------------------------------------------------------------
    {
      id: 'vialata-length',
      scene: 'rome',
      desc: 'On the Via Lata 200 m inside the Porta Flaminia at a standing man\'s eye, a 30 '
        + 'degree lens 420 m down the carriageway. The street is now dead straight from the '
        + 'gate to the foot of the Capitol; before this pass it bowed 360 real metres off its '
        + 'own line between n 1080 and n 1650 to avoid a tomb that stands 148 m to the west.',
      start: 10, len: 0.1, speed: 1,
      track: { kind: 'world', x: 249, z: 1000 },
      rail: [{ lift: 0, eye: 1.75, aim: 24, dist: 420, fov: 32, yaw: 0.362 }],
    },
    {
      id: 'vialata-length-low',
      scene: 'rome',
      desc: 'The same run from 620 m inside the gate, looking back north up the carriageway at '
        + 'the Aurelian curtain — the length of the street read the other way, and the frame '
        + 'that shows whether the kerb line holds over half a kilometre.',
      start: 10.5, len: 0.1, speed: 1,
      track: { kind: 'world', x: 100, z: 606 },
      rail: [{ lift: 0, eye: 1.75, aim: 24, dist: 400, fov: 34, yaw: 3.5036 }],
    },
    {
      id: 'vialata-oblique',
      scene: 'rome',
      desc: 'The whole Via Lata from 300 m up over the Capitol end, looking north-north-west '
        + 'along the axis to the Porta Flaminia 1.1 km away. Focus (200, 1000). This is the '
        + 'frame that shows the street as one line rather than as a sequence of blocks.',
      start: 11, len: 0.1, speed: 1,
      track: { kind: 'world', x: 150, z: 800 },
      rail: [{ lift: 0, eye: 260, aim: 30, dist: 480, fov: 40, yaw: 3.5036 }],
    },

    // ---------------------------------------------------------------------------------
    // 2. THE MAUSOLEUM. The conflict, and the two lines it is not on.
    // ---------------------------------------------------------------------------------
    {
      id: 'gate-axis-tomb',
      scene: 'rome',
      desc: 'Standing 30 m inside the breached Porta Flaminia on the gate\'s own outward '
        + 'normal, looking straight south. The Mausoleum of Augustus closes the view 190 m on '
        + 'because it stands 16 real metres off that normal — it always did, on the plate and '
        + 'in the ground — and the Via Lata is the other line, peeling away to the left. The '
        + 'terminus and the obstruction are the same object seen from two different lines.',
      start: 12, len: 0.1, speed: 1,
      track: { kind: 'world', x: 79, z: 720 },
      rail: [{ lift: 0, eye: 1.75, aim: 30, dist: 165, fov: 46, yaw: 0 }],
    },
    {
      id: 'mausoleum-kerb',
      scene: 'rome',
      desc: 'On the Via Lata\'s west kerb at the tomb\'s own latitude — world (143, 720) — '
        + 'looking west across 64 world metres of open ground at the Mausoleum. In survey '
        + 'metres that is 148 m from centre to centre and 53 m of clear ground from masonry to '
        + 'kerb; in world metres the drawn tomb is 93 m across and overlaps the carriageway by '
        + '19, and both numbers are correct. This is what MAP-METHOD rule 4 looks like.',
      start: 12.5, len: 0.1, speed: 1,
      track: { kind: 'world', x: 60, z: 720 },
      rail: [{ lift: 0, eye: 2, aim: 18, dist: 85, fov: 46, yaw: 4.7124 }],
    },

    // ---------------------------------------------------------------------------------
    // 3. A JUNCTION. Where two authored ways meet at a shared node.
    // ---------------------------------------------------------------------------------
    {
      id: 'junction-recta',
      scene: 'rome',
      desc: 'The Via Lata crossing the Via Recta at world (222, 929), at eye level from 60 m '
        + 'south-east. The Via Recta moved 300 real metres north this pass, onto the line of '
        + 'the Via dei Coronari that the orthophoto puts it on; the old row ran straight '
        + 'through the Pantheon and the Stadium of Domitian at 27 per cent of its length.',
      start: 13, len: 0.1, speed: 1,
      track: { kind: 'world', x: 222, z: 929 },
      rail: [{ lift: 0, eye: 1.75, aim: 14, dist: 60, fov: 44, yaw: 3.9270 }],
    },
    {
      id: 'junction-recta-above',
      scene: 'rome',
      desc: 'The same junction from 130 m up, so the two carriageways and the frontages that '
        + 'front them read as one crossroads rather than as two roads passing.',
      start: 13.5, len: 0.1, speed: 1,
      track: { kind: 'world', x: 222, z: 929 },
      rail: [{ lift: 0, eye: 130, aim: 6, dist: 150, fov: 42, yaw: 3.6 }],
    },
    {
      id: 'junction-capitol',
      scene: 'rome',
      desc: 'The Via Lata\'s southern terminus at the Capitol\'s north foot, world (292, 1117), '
        + 'where the Clivus Argentarius and the Alta Semita both start. This junction is why '
        + 'the armature is one connected component: without the Clivus Argentarius the Via Lata '
        + 'stops 350 real metres short of the Forum and the graph is in two pieces.',
      start: 14, len: 0.1, speed: 1,
      track: { kind: 'world', x: 292, z: 1117 },
      rail: [{ lift: 0, eye: 90, aim: 8, dist: 170, fov: 44, yaw: 5.5 }],
    },

    // ---------------------------------------------------------------------------------
    // 4. THE NETWORK FROM ABOVE, AT A STATED SCALE.
    // ---------------------------------------------------------------------------------
    {
      id: 'network-plan',
      scene: 'rome',
      desc: 'Straight down over the walled city from 2,400 m, NORTH UP (yaw = PI, because yaw '
        + '0 looks +Z and +Z is south). Centre (450, 950). At 1920x1080 and fov 40 the frame '
        + 'covers about 1,746 m north-south and 3,104 m east-west, so 1 px = 1.617 world m. '
        + 'Twenty-three ways and 11.6 km of armature, and no ring roads or feeders: every line '
        + 'in this frame was authored in survey metres off a plate.',
      start: 15, len: 0.1, speed: 1,
      track: { kind: 'world', x: 450, z: 950 },
      rail: [{ lift: 0, eye: 2400, aim: 0, dist: 0, fov: 40, yaw: 3.14159 }],
    },
    {
      id: 'network-plan-campus',
      scene: 'rome',
      desc: 'Straight down over the Campus Martius alone from 900 m, NORTH UP. Centre '
        + '(100, 950). 1 px = 0.606 world m. The Via Lata down the right, the Via Recta across '
        + 'the top of the monumental core, the Via Tecta and the Via Triumphalis on the river '
        + 'frontage — and the grain of the fabric between them, which now comes from those '
        + 'lines rather than from a hash.',
      start: 15.5, len: 0.1, speed: 1,
      track: { kind: 'world', x: 100, z: 950 },
      rail: [{ lift: 0, eye: 900, aim: 0, dist: 0, fov: 40, yaw: 3.14159 }],
    },
    {
      id: 'network-plan-east',
      scene: 'rome',
      desc: 'Straight down over the Quirinal, the Viminal and the Subura from 1,100 m, NORTH '
        + 'UP. Centre (700, 1000). 1 px = 0.741 world m. The Alta Semita along the ridge, the '
        + 'Vicus Longus and the Vicus Patricius climbing out of the Subura beside it, and the '
        + 'Clivus Suburanus running east — six of the ways this pass added or re-authored.',
      start: 16, len: 0.1, speed: 1,
      track: { kind: 'world', x: 700, z: 1000 },
      rail: [{ lift: 0, eye: 1100, aim: 0, dist: 0, fov: 40, yaw: 3.14159 }],
    },
    {
      id: 'network-approach',
      scene: 'rome',
      desc: 'The Via Flaminia OUTSIDE the wall: focus 200 m inside the Porta Flaminia, eye '
        + '420 m back along the axis and therefore 220 m out on the attacker\'s ground, 25 m '
        + 'up. Until this pass no way could leave the city at all — every node was clamped to '
        + '18 world metres outside the curtain — so the ground the assault forms up on had no '
        + 'road on it, and this is the first frame in which it does.',
      start: 16.5, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -200, eye: 25, aim: 24, dist: 420, fov: 30, yaw: 'in' }],
    },
  ],
};
