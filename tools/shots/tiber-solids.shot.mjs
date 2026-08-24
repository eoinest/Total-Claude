/**
 * **The Tiber, from the water — the owner's report, photographed.**
 *
 * *"there are some big buildings still in the river."* `probe-fabric` G22 answered
 * *"PASS — no structure stands below the water surface"*, so one of the two was wrong and the
 * first job was to find out which. This film is the reproduction: five shots, all of them low
 * over the channel, framed on the two structures an offline footprint scan
 * (`tools/scratch/riversolids.mjs`) says have a quarter and a seventh of their plan under
 * 4.6 m of Tiber while their **centres** stand dry at 7.80 m.
 *
 * ```
 *   id                  footprint   wet m2   wet%   in channel%   worst ground   centre
 *   mausoleum-hadrian     9 069      2 232    25%       16%           0.40 m     7.80 m
 *   theatre-marcellus     2 835        405    14%        5%           0.53 m     7.80 m
 *   tiber-island         20 711      3 504    17%        9%           0.40 m     5.01 m   (licensed)
 * ```
 *
 * Water is drawn at 5.0 m, so 0.40 m of ground is **4.6 metres under the surface**, and both
 * rows pass a check that samples the centre of an 89 m podium.
 *
 * **Why every camera is over the water and none of them is above 30 m.** `MAP-METHOD.md`
 * rule 15 — grade from 1.75 m before grading from 150 m. From a tactical camera a monument
 * standing in the river reads as a monument standing near the river, which is exactly why this
 * survived four passes of plan diagnostics. The waterline against a wall is a **profile**
 * feature: it needs the eye near the surface and roughly along it.
 *
 * `track: { kind: 'world' }` is the format's declared escape hatch and it is the right anchor
 * here for once: the subject is a fixed piece of ground, not a unit or a bay, and the whole
 * point of the film is that this particular ground does not move. The coordinates are the
 * survey rows' own projected centres, printed by `assertRomeFrame` at every boot, so they go
 * stale only if the monument moves — which is the event this film exists to detect.
 *
 * `scenario: 'field'` rather than `'assault'`: the assault is on the north front, three
 * quarters of a kilometre from here, and men and dust in the frame would only be something to
 * argue about. `speed: 0` freezes the simulation and lets the camera move, so every frame is
 * the same world at the same tick.
 *
 * Hour 9.4 puts the sun in the east, low enough to rake the west faces of the far bank and to
 * keep a specular path on the water — the waterline is the subject and a flat noon sun hides
 * exactly it.
 *
 *   node tools/film.mjs tools/shots/tiber-solids.shot.mjs --stills --nooverlay --port=5943
 */
export default {
  id: 'tiber-solids',
  title: 'The Tiber — what is standing in it',
  width: 1920,
  height: 1080,
  quality: 'high',

  scenes: {
    'rome-river': {
      map: 'campus-martius',
      scenario: 'field',
      enemy: 'juthungi',
      hour: 9.4,
      seed: 4265438264,
      unitSize: 'normal',
      difficulty: 'hard',
      weather: 'clear',
    },
  },

  shots: [
    {
      /*
       * The Mausoleum of Hadrian from downstream, at the height of a boat.
       *
       * 2 232 of its 9 069 m2 stand on ground at or below 5.0 m and 16 % of the podium is
       * inside the modelled channel itself. The camera sits 158 m downstream and 12 m up,
       * looking up the reach, so the podium's west flank and the water in front of it are in
       * the same frame — which is the composition a waterline needs and a plan view cannot
       * give.
       */
      id: 'hadrian-from-the-water',
      scene: 'rome-river',
      desc: 'The Mausoleum of Hadrian from the channel downstream: the podium and the waterline.',
      start: 2,
      len: 3,
      speed: 0,
      track: { kind: 'world', x: -295.25, z: 833.2 },
      rail: [
        { at: 0, lift: 0, eye: 14, aim: 9, dist: 175, fov: 38, yaw: 2.5 },
        { at: 1, lift: 0, eye: 9, aim: 7, dist: 130, fov: 38, yaw: 2.5, ease: 'smootherstep' },
      ],
    },
    {
      /*
       * The same podium from the opposite bank, across the channel. Two views of one waterline
       * from opposite sides, because a single oblique can always be argued to be a trick of the
       * angle and two cannot.
       */
      id: 'hadrian-across',
      scene: 'rome-river',
      desc: 'The Mausoleum of Hadrian across the channel from the east bank.',
      start: 2,
      len: 3,
      speed: 0,
      track: { kind: 'world', x: -295.25, z: 833.2 },
      rail: [
        { at: 0, lift: 0, eye: 11, aim: 8, dist: 210, fov: 34, yaw: -1.35 },
        { at: 1, lift: 0, eye: 8, aim: 7, dist: 165, fov: 34, yaw: -1.35, ease: 'smootherstep' },
      ],
    },
    {
      /*
       * Eye level on the bank beside it — 1.75 m, `MAP-METHOD.md` rule 15's altitude. This is
       * the frame a man standing on the Ripa would have, and the one every tactical-camera
       * instrument on this project has never taken.
       */
      id: 'hadrian-eye',
      scene: 'rome-river',
      desc: "A standing man's eye on the bank: the podium going into the water.",
      start: 2,
      len: 3,
      speed: 0,
      track: { kind: 'world', x: -295.25, z: 833.2 },
      rail: [
        { at: 0, lift: 0, eye: 1.75, aim: 4, dist: 118, fov: 42, yaw: 2.15 },
        { at: 1, lift: 0, eye: 1.75, aim: 4, dist: 92, fov: 42, yaw: 2.15, ease: 'smootherstep' },
      ],
    },
    {
      /*
       * The Theatre of Marcellus, whose cavea front stands on ground at 0.53 m. 405 of
       * 2 835 m2. Smaller than the Mausoleum in area and more visible, because the cavea is
       * a curved wall and a curved wall meeting flat water reads instantly.
       */
      id: 'marcellus-from-the-water',
      scene: 'rome-river',
      desc: 'The Theatre of Marcellus from the channel: the cavea front in the water.',
      start: 2,
      len: 3,
      speed: 0,
      track: { kind: 'world', x: 180.53, z: 1277.35 },
      rail: [
        { at: 0, lift: 0, eye: 12, aim: 8, dist: 150, fov: 38, yaw: 1.1 },
        { at: 1, lift: 0, eye: 8, aim: 6, dist: 105, fov: 38, yaw: 1.1, ease: 'smootherstep' },
      ],
    },
    {
      /*
       * The reach itself, from 55 m: the Transtiberim bank, the island and both offenders in
       * one frame, so the two close shots can be located. Still not a plan view — 55 m is low
       * enough that a waterline is a line and not a colour change.
       */
      id: 'the-reach',
      scene: 'rome-river',
      desc: 'The whole Transtiberim reach: the island, the Mausoleum and the Theatre.',
      start: 2,
      len: 3,
      speed: 0,
      track: { kind: 'world', x: -60, z: 1060 },
      rail: [
        { at: 0, lift: 0, eye: 62, aim: 12, dist: 470, fov: 40, yaw: 2.0 },
        { at: 1, lift: 0, eye: 52, aim: 10, dist: 415, fov: 40, yaw: 2.0, ease: 'smootherstep' },
      ],
    },
  ],
};
