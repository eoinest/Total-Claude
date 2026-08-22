/**
 * War Machine — the second trailer. Short, fast, and cut to a piece of music.
 *
 * The brief was four words long: **short, high-action, exciting, with music.** The shipped
 * trailer is eighty-six seconds and stately; this is twenty-eight and it is not. Eleven shots,
 * no dissolves, no fade up at the head, and every cut placed on a *measured* accent in the
 * score rather than on a round number.
 *
 * ## The cut is timed to the music, and the music was measured rather than guessed
 *
 * The bed is 28.267 s of **'Song Of The Forge' by Scott Buckley, CC BY 4.0**
 * (`www.scottbuckley.com.au`) — the track's finale, 166.240 s to 194.507 s. It was not
 * beat-gridded off a published BPM. `tools/scratch/trailer2-music.mjs` decodes the file in a
 * page, builds a 100 Hz spectral-flux onset envelope, and reports the strongest transients;
 * every cut below sits on one of them, and each shot's `len` is the gap between the two
 * transients it spans, quantised to whole frames at 30 fps. Cumulative drift against the audio
 * is under half a frame end to end.
 *
 * The finale has a shape, and the picture is hung on it:
 *
 * ```
 *   166.2 .. 172.1   percussive, accelerating          four shots in 5.9 s
 *   172.1            the loudest transient (18.3)      -> the crane over Carthage
 *   174.7 .. 179.9   drive                             -> the Punic wall, then Rome's
 *   180.0 .. 183.2   a sustained swell, no percussion   \  ONE take on the gate: the push in
 *   184.2 .. 188.5   the drive returns, four accents    /  under the swell, the break on 185.5
 *   188.9 .. 191.0   swell                             -> the road, after
 *   191.0            accent (14.1)                     -> the card
 *   192.3            the last accent (17.5)            -> inside the card
 *   193   .. 194.5   the resolution, decaying          -> the fade
 * ```
 *
 * ```
 *   #   shot            in       out    frames   music (s into the track)
 *   1   ele-charge    0.000    1.733      52     166.240 -> 167.973
 *   2   ele-arrest    1.733    2.833      33     167.973 -> 169.073
 *   3   line-crash    2.833    4.133      39     169.073 -> 170.373
 *   4   the-charge    4.133    5.900      53     170.373 -> 172.140
 *   5   the-city      5.900    8.467      77     172.140 -> 174.707
 *   6   punic-towers  8.467   11.233      83     174.707 -> 177.473
 *   7   rome-host    11.233   12.800      47     177.473 -> 179.040
 *   8   escalade     12.800   13.733      28     179.040 -> 179.973
 *   9   the-gate     13.733   22.600     266     179.973 -> 188.840
 *   10  the-road     22.600   24.767      65     188.840 -> 191.007
 *   11  endcard      24.767   28.267     105     191.007 -> 194.507
 * ```
 *
 * ## Four notes from the last trailer are binding, and all four are honoured
 *
 *   - **One escalade shot, not two.** `escalade` is the only shot of men on ladders in the film
 *     and it is twenty-eight frames long. `punic-towers` is men walking across a docked siege
 *     tower's bridge, which is not a ladder; `rome-host` is timed so the ladders are still being
 *     *carried*; `the-city` looks down into Carthage's ditch rather than up its face.
 *   - **Carthage is in it twice** — the elephants open the film, and the crane over the city
 *     takes the loudest transient in the score.
 *   - **The elephants earned their place**, so they are the cold open.
 *   - **Nothing is shot from inside the walls after the door goes**, and there is no `rome-arch`:
 *     the break reads as a black void at feed size, so the film stays on the road and outside.
 *
 * ## What is emergent, and what is arranged
 *
 * **Nothing is staged.** `film.json` stamps `emergent: true` and `stagedScenes: []`. The one
 * temptation was Carthage's elephants — `carthage-elephants.shot.mjs` doubles the contingent to
 * four units to fill a frame — and it was refused: a trailer that says "this is the game" should
 * photograph the army the game deploys, and the shipped Punic order of battle's two units are
 * enough at a 28 m standoff. The only staging in the film is `shakeScale` and one `shake`, both
 * of which move the camera and nothing else.
 *
 * ## Every cut against a resolved cue, except one, and that one says why
 *
 * `the-city` is a fixed sim time because there is no event in it: it is a crane over a city, and
 * the city is finished being built before the first tick. Writing `find: 'corpses', n: 1` there
 * to satisfy a convention would be a cue that means nothing, which is worse than a number that
 * admits what it is. Everything else — including the end card — hangs off an event.
 *
 * **The gate does break at quality `ultra` on this tree, and that is new.** The video studio
 * measured the ram being cut to pieces sixteen metres short of the door at `ultra`, with zero
 * blows landed in nine minutes. Rome's circuit has since been re-surveyed — 36 bays, three
 * gates, the curtain 157 m from where it was, and the assault's determinism pin moved with it —
 * and the ram now reaches the leaves. Scouted on this tree at seed 4265438264, unit size ultra,
 * difficulty hard: **first blow at t+103.000, `gateOpen` after t+103**. So the two cues the
 * previous pass could not resolve both resolve, and the trailer's climax is the real one.
 *
 * One hazard found while shooting this, and worked around in `endcard` below: **the scouting
 * pass resolves a scene's cues on one forward-running clock, so a predicate scouted second can
 * be answered "already true, now" by the clock the first one left behind.** Cues are
 * deduplicated per *predicate*, which handles three shots on one `contact`, but not two shots on
 * two different predicates. Sharing one predicate between the gate, the road and the card is
 * what avoids it here; the general fix is the runner's.
 *
 * ## Lighting, and the one thing that decided half the framings
 *
 * `sunAngle` in `film.json` is the angle between where the lens is pointed and where the sun is.
 * Inside about 45 degrees of it, every surface in this renderer goes to one flat cream. Two
 * things were lost to it on the way to this cut and both are worth writing down:
 *
 *   - **Pydna is not in this film.** Its field battle was shot at hour 8.2 from three angles and
 *     the plain came back as a pale gold wash with the hosts barely reading; the whole-engagement
 *     shot from 190 m was the same failure the shipped trailer's `field-scale` measured at 400 px.
 *     The Campus Martius field battle at the same hour has trees, hedgerows and a river valley to
 *     give the light something to model, so the two field beats moved there. Pydna is a good map
 *     and a bad photograph at dawn; an hour nearer noon would probably fix it and was not
 *     available for a fourth scouting pass.
 *   - **Rome's gate is shot from the negative side.** With `yaw: 'in'` on the gate bay,
 *     `sunAngle ≈ 41.5 + 57.3 · yawAdd` degrees, measured across two shots — so `yawAdd: -0.36`
 *     is 21 degrees off the sun and a silhouette. Positive `yawAdd` walks out of the sun but into
 *     a cypress that stands 10 m off the road, so the gate beats sit at `yawAdd ≈ -0.12`, which
 *     is the shipped poster's own angle and reads because the *top* of the towers is lit even
 *     when the face is not.
 *
 * Hours are otherwise the proven ones: 10.4 over Carthage's field, 16.2 over its wall, 14.3 over
 * Rome's, 8.2 over the Campus Martius.
 */
export default {
  id: 'war-machine',
  title: 'Total Claude — War Machine',
  width: 1920,
  height: 1080,
  quality: 'ultra',

  scenes: {
    /*
     * Carthage in the field. The elephants are the shipped Punic contingent — two units, not the
     * four `carthage-elephants.shot.mjs` stages — so this scene is emergent.
     */
    'carth-field': {
      map: 'carthage',
      scenario: 'field',
      enemy: 'carthage',
      hour: 10.4,
      seed: 4265438264,
      unitSize: 'ultra',
      difficulty: 'hard',
    },
    'rome-field': {
      map: 'campus-martius',
      scenario: 'field',
      enemy: 'juthungi',
      hour: 8.2,
      seed: 4265438264,
      unitSize: 'ultra',
      difficulty: 'hard',
    },
    'carth-assault': {
      map: 'carthage',
      scenario: 'assault',
      enemy: 'carthage',
      hour: 16.2,
      seed: 4265438264,
      unitSize: 'ultra',
      difficulty: 'hard',
    },
    'rome-assault': {
      map: 'campus-martius',
      scenario: 'assault',
      enemy: 'juthungi',
      hour: 14.3,
      seed: 4265438264,
      unitSize: 'ultra',
      difficulty: 'hard',
    },
  },

  shots: [
    {
      /*
       * Cold open on the elephants, at a stride and close.
       *
       * `fadeIn: 0`. A trailer that opens on black has spent its first second on nothing, and a
       * feed player that autoplays muted freezes on frame one — so frame one is a Punic shield
       * wall with two tonnes of animal behind it, not a dip to black.
       *
       * This line did nothing until `film.mjs` was fixed on this branch: the runner tested
       * `!sh.fadeIn` before applying its 0.8 s default, so an explicit zero and an absent field
       * were the same value and the film was shot with the fade it had asked not to have. If a
       * future first frame comes back as a 13 kB JPEG next to 700 kB neighbours, that is this.
       *
       * `contact` is the first tick anybody on the field is in melee, so `offset: -3.2` is "the
       * last three seconds of the advance" whatever the deployment does. `mode: 'follow'` is not
       * a flourish at this standoff: the elephants make about 3 m/s and a pinned anchor would
       * open on the animal and close on the grass behind it.
       *
       * The elephants are *behind* the Punic line rather than in front of it, which is where the
       * scenario puts them, and the frame is better for it: a wall of painted oval shields in the
       * near field and the howdahs coming on over the top of it.
       */
      id: 'ele-charge',
      scene: 'carth-field',
      desc: 'The war elephants coming on behind the Punic line, tracked and close.',
      start: { find: 'contact', offset: -3.2, before: 240 },
      len: 1.7333,
      track: { kind: 'unitType', id: 'war-elephants', mode: 'follow', lag: 0.45 },
      rail: [
        { at: 0, eye: 4.4, aim: 2.6, dist: 40, fov: 32, yawAdd: 0.52 },
        { at: 1, eye: 3.5, aim: 2.7, dist: 28, fov: 31, yawAdd: 0.66, ease: 'easeIn' },
      ],
      fadeIn: 0,
      caption: { text: 'CARTHAGE', sub: 'Spring, 146 BC', in: 0.06, out: 0.9 },
    },
    {
      /*
       * The impact, arrested.
       *
       * `speed: 0` fires no tick at all: thirty-three frames of the same simulation state with
       * the camera arcing across it. The mechanism is `Time.paused`, so the accumulator is
       * untouched and the shot after this one fires exactly the ticks it would have fired without
       * it. The `shake` is camera-only and decays across the hold, which is what stops a frozen
       * picture reading as a dropped connection.
       *
       * 1.1 s. Long enough to register as a deliberate arrest, short enough that the montage does
       * not stall in it.
       *
       * **The camera barely moves, and that is a correction.** The first pass arced 4 m of
       * standoff and 18 degrees of yaw across these thirty-three frames, and the shot came back
       * with every man in it smeared: `speed: 0` freezes the *world*, and camera motion blur
       * does not care that the world is frozen — it reprojects depth through the previous
       * frame's matrix, so a fast camera over a held frame blurs the held frame. Measured at
       * 400 px, mean |Δluma| between frames was 20.4, the highest of any shot in the film,
       * which is a whip pan and not an arrest. Re-shot at a quarter of that travel: the frozen
       * pose is sharp and the creep still reads as a move. The `shake` blurs the first few
       * frames, which is what an impact should do.
       */
      id: 'ele-arrest',
      scene: 'carth-field',
      desc: 'The moment the lines meet, held, while the camera swings across it.',
      start: { find: 'contact', offset: 0.25, before: 240 },
      len: 1.1,
      speed: 0,
      stage: [{ do: 'shake', amplitude: 1.0, decay: 2.4 }],
      track: { kind: 'unitType', id: 'war-elephants' },
      rail: [
        { at: 0, eye: 3.5, aim: 2.7, dist: 26, fov: 31, yawAdd: 0.66 },
        { at: 1, eye: 3.7, aim: 2.6, dist: 24, fov: 30, yawAdd: 0.74, ease: 'linear' },
      ],
    },
    {
      /*
       * The Campus Martius: the last stride, and the crash.
       *
       * `frontGap` is the midpoint of the two front *lines*, not of the two hosts — a host's
       * centroid carries its reserves and sits tens of metres behind where the lines are about to
       * touch. The shipped trailer opened its equivalent at a 96 m standoff over seven seconds;
       * this has 1.3 s, so it opens at 70 m and closes to 56. A shot is exactly as long as the
       * thing in it, and a 1.3 s shot cannot afford to arrive.
       *
       * `yawAdd: 0.9` and not `-0.8`. Both were shot: at hour 8.2 the negative side is 8 degrees
       * off a low sun and the left half of the frame is a blown-out cream field with the line
       * lost in it. Same battle, same second, same lens — the only difference is which way the
       * camera faces.
       */
      id: 'line-crash',
      scene: 'rome-field',
      desc: 'Dawn on the Campus Martius: the lines meet.',
      start: { find: 'contact', offset: -0.7, before: 200 },
      len: 1.3,
      stage: [{ do: 'shakeScale', value: 0.6 }],
      track: { kind: 'frontGap' },
      rail: [
        { at: 0, eye: 12.0, aim: 2.2, dist: 70, fov: 32, yawAdd: 0.90 },
        { at: 1, eye: 10.0, aim: 2.0, dist: 56, fov: 31, yawAdd: 0.82, ease: 'easeIn' },
      ],
    },
    {
      /*
       * The cavalry wing at the gallop, and the one place in the film where the renderer's own
       * motion blur is the point.
       *
       * A wing crosses about 9 m/s, so over 1.77 s the subject moves sixteen metres — half the
       * frame at this standoff — and the anchor has to follow. `lag: 0.4` is a critically damped
       * filter over the resolved positions; unfiltered, the frame twitches every time a file dies
       * and the unit's centroid jumps. The filter is a pure function of the resolved positions
       * and the frame index, so a re-shoot reproduces it exactly.
       *
       * At 30 fps the shutter is 1/30 s, which is twice the interval a player at 60 fps gets, so
       * the horses and the infantry in the near field smear about twice as much here as they do
       * in the game. On this shot that reads as speed and it is kept; it is the reason the two
       * shots either side of it are of things that move more slowly.
       */
      id: 'the-charge',
      scene: 'rome-field',
      desc: 'The cavalry wing coming round the flank at the gallop, tracked.',
      start: { find: 'contact', offset: 7.6, before: 240 },
      len: 1.7667,
      track: { kind: 'cavalryUnit', mode: 'follow', lag: 0.4 },
      rail: [
        { at: 0, eye: 5.8, aim: 1.9, dist: 38, fov: 31, yawAdd: 0.48 },
        { at: 1, eye: 5.0, aim: 1.9, dist: 30, fov: 30, yawAdd: 0.62, ease: 'easeOut' },
      ],
    },
    {
      /*
       * Carthage from above, on the loudest transient in the score.
       *
       * The film's one wide, and it earns the 18.3-strength hit at its head because it is the
       * only frame that says the game has cities in it: the great wall and its ditch across the
       * middle, four siege towers on the plain below, the white city behind and the Byrsa on the
       * skyline.
       *
       * The example film's Byrsa crane takes six seconds to fall from 158 m to 44 m. This has
       * 2.57 s and falls from 96 m to 58 m in it — 15 m/s of descent — and both stations were
       * photographed before being written down. Below about 60 m the ditch and the towers start
       * to resolve, and that is the frame it lands on.
       *
       * The travel is 38 m rather than the 22 m of the first pass, and the reason is measured:
       * at 400 px this shot's mean |Δluma| between frames was **1.68, the lowest in the film
       * apart from the end card**, which is the wrong property for the beat carrying the loudest
       * transient in the score. At 250 m the men are too small to contribute motion, so the only
       * lever is the crane itself.
       */
      id: 'the-city',
      scene: 'carth-assault',
      desc: 'A crane over Carthage: the great wall, its ditch, the city and the Byrsa.',
      start: 12,
      len: 2.5667,
      track: { kind: 'gate' },
      rail: [
        { at: 0, lift: 0, stand: 34, eye: 96, aim: 16, dist: 278, fov: 34, yaw: 'in', yawAdd: -0.26 },
        { at: 1, lift: 0, stand: 48, eye: 58, aim: 10, dist: 206, fov: 34, yawAdd: -0.14, ease: 'smootherstep' },
      ],
    },
    {
      /*
       * Carthage's wall, and the men walking onto it.
       *
       * The anchor is `contact` — the densest forty-metre cell of men actually in melee — rather
       * than a numbered bay, and that is deliberate: which bay the towers dock against is a
       * property of the assault's pathing and of the curtain's survey, and Rome's survey has
       * already moved once this month. The fight is where the fight is. `contact` also yields an
       * axis, so with no `yaw` named the base heading is the melee's own and `yawAdd` is a pan
       * off it.
       *
       * `corpses n: 660` is the cue, and it is a proxy for a clock this format cannot name. What
       * the shot wants is "the towers have docked and the columns are queuing up into them",
       * which happens between t+180 and t+300 in this battle; there is no `towerDocked` finder,
       * and `climbing` fires at t+40 on the *ladders* instead, which would have made this a
       * second escalade beat and broken the one binding note in the brief. Corpses cross 660
       * somewhere after t+200, and every framing shot at t+180, 240, 252, 300 and 301 has docked
       * towers with men crossing in it, so the cue is safe across its whole uncertainty.
       *
       * `speed: 2` for the same reason `the-city`'s crane was lengthened. At 1x this shot and the
       * two either side of it measured 1.68, 3.35 and 3.65 mean |Δluma| at 400 px — the three
       * lowest-motion shots in the film, all in its middle, which is the wrong shape for the
       * brief. Two ticks per photograph is free: the extra tick runs with `{ render: false }`,
       * which `qa-determinism` asserts is bit-identical, so this is the same battle with every
       * other frame not photographed and a column that climbs twice as fast.
       */
      id: 'punic-towers',
      scene: 'carth-assault',
      desc: 'Siege towers docked on the Punic parapet, columns crossing onto the wall, at 2x.',
      start: { find: 'corpses', n: 660, offset: 8, before: 400 },
      len: 2.7667,
      speed: 2,
      stage: [{ do: 'shakeScale', value: 0.55 }],
      track: { kind: 'contact' },
      rail: [
        { at: 0, eye: 26, aim: 12, dist: 60, fov: 32, yawAdd: 0.30 },
        { at: 1, eye: 21, aim: 11, dist: 46, fov: 31, yawAdd: 0.16, ease: 'smootherstep' },
      ],
    },
    {
      /*
       * Rome: the towers still crossing the tomb field.
       *
       * `climbing n: 80, offset: -12` is "twelve seconds before eighty men are on the rungs at
       * once" — the last moment the ladders are still being carried and the towers are still in
       * the open. That is what keeps this from being a second escalade shot, and it is a cue
       * rather than a clock precisely so that it stays true when the approach gets faster or
       * slower.
       *
       * `yaw: 'in'` against bay 4, four bays up the curtain from the gate: the base heading is
       * this wall's own inward normal, so it cannot go stale the next time the circuit is
       * re-surveyed. `yawAdd: 0.58` is 75 degrees off the sun, which is why the brick reads as
       * brick here and as a silhouette in the gate beats.
       *
       * `speed: 2`, for the reason given on `punic-towers`: this is the third of the film's three
       * low-motion shots and the tower has to look like it is being *pushed*.
       */
      id: 'rome-host',
      scene: 'rome-assault',
      desc: 'Siege towers crossing the tomb field toward the Aurelian Wall, Rome behind it, at 2x.',
      start: { find: 'climbing', n: 80, offset: -8, before: 240 },
      len: 1.5667,
      speed: 2,
      track: { kind: 'bay', k: 4 },
      rail: [
        { at: 0, lift: 0, stand: 44, eye: 33, aim: 10, dist: 165, fov: 35, yaw: 'in', yawAdd: 0.58 },
        { at: 1, lift: 0, stand: 38, eye: 28, aim: 9, dist: 142, fov: 34, yawAdd: 0.52, ease: 'smootherstep' },
      ],
      caption: { text: 'THE AURELIAN WALL', sub: 'Rome, 271 AD', in: 0.06, out: 0.9 },
    },
    {
      /*
       * The escalade. **The only shot of men on ladders in this film**, by instruction, and it is
       * twenty-eight frames long.
       *
       * Of the two escalade beats in the shipped trailer, the owner kept one and the measurement
       * that chose between them chose the *closer*: at 400 px the wide one is mid-brown wall on
       * mid-green grass with two faint diagonals in it (gradient 10.07, frame contrast 32.0) and
       * the close one is hard sky against dark brick with men on the rungs (10.86 and 59.4). So
       * this is a close one, and it is closer still than that.
       *
       * The anchor is `contact` and not a bay, and that took three scouting passes to arrive at.
       * `bay k: -3` — the unfinished stretch the example film uses — no longer exists on the
       * re-surveyed circuit: negative `k` clamps to bay 0, and bays 2 and 3 put the camera inside
       * the city looking out over a garden wall. The men in melee *are* the escalade, so
       * `melee n: 140` finds the moment the first ladder parties reach the walk and `contact`
       * puts the camera where the densest of them is, whichever bay that turns out to be. The
       * frame it gives is the wall face in raking perspective with the ladders and the shields on
       * them down the right-hand side and the Campus Martius behind.
       */
      id: 'escalade',
      scene: 'rome-assault',
      desc: 'The wall face in raking light: ladders, men on the rungs, the garrison above.',
      start: { find: 'melee', n: 140, offset: 8, before: 240 },
      len: 0.9333,
      stage: [{ do: 'shakeScale', value: 0.7 }],
      track: { kind: 'contact' },
      rail: [
        { at: 0, eye: 17, aim: 9.5, dist: 46, fov: 34, yawAdd: 0.46 },
        { at: 1, eye: 15, aim: 8.5, dist: 37, fov: 33, yawAdd: 0.38, ease: 'easeIn' },
      ],
    },
    {
      /*
       * The gate. **One take, 8.867 s** — a third of the film on one shot, and the longest thing
       * in it by a factor of two and a half.
       *
       * The one editorial note the shipped trailer got right was that its climax should not be
       * spliced. Playing the ram and the break as two shots put a two-second hole in sim time and
       * stepped the camera backwards across it; re-shot as a single eased move, the mean |Δluma|
       * discontinuity at the old splice measured z = −0.11 — that is, none, because there was no
       * longer anything there. So this is one continuous move: eye, standoff, aim and lens all
       * monotonic, on a Catmull-Rom rail through three stations, the first of which is a framing
       * that was photographed at t+104 and the last of which is the shipped trailer's own poster.
       *
       * **The ramp is placed so the leaves give way inside the slow part, and the arithmetic is
       * written down because it is not obvious.** `speed` is sim seconds per footage second, so a
       * ramp makes the map from footage time to sim time nonlinear:
       *
       * ```
       *   u 0.00..0.55   v = 1               sim +4.877   (footage 0.00..4.88)
       *   u 0.55..0.63   v = 1 -> 0.45       sim +0.514   (footage 4.88..5.59)
       *   u 0.63..1.00   v = 0.45            sim +1.476   (footage 5.59..8.87)
       *                                      sim +6.867 total
       * ```
       *
       * With `offset: -5.39` the gate opens at sim +5.39, which is u = 0.63 — 5.59 s into a
       * 8.867 s shot, on the film's 19.32 s mark, which is the score's 185.54 s accent to within
       * two hundredths of a second. The last 3.28 s of footage then spends 1.48 s of battle on the
       * leaves coming apart. **Change the ramp and this offset has to be recomputed**; that is the
       * price of putting an event inside a ramp and it is worth paying once.
       *
       * **Nothing after this looks through the arch.** The break is a pale panel leaving an
       * already dark opening, so the frame's contrast *falls* across the aftermath (28.6 → 23.3
       * measured at 400 px) and its motion decays monotonically. The shipped social cut ended its
       * equivalent on the last frame where it was still doing something for exactly that reason,
       * and the owner cut `rome-arch` for it.
       */
      id: 'the-gate',
      scene: 'rome-assault',
      desc: 'One take: the ram at the Porta Flaminia, the push in, and the leaves giving way.',
      start: { find: 'gateOpen', offset: -5.39, before: 520 },
      len: 8.8667,
      speed: [
        { at: 0, v: 1 },
        { at: 0.55, v: 1 },
        { at: 0.63, v: 0.45 },
        { at: 1, v: 0.45 },
      ],
      // Camera only. `RTSCamera.shakeScale` defaults to 0.35 because a battle fires `cameraShake`
      // continuously and they never cancel, only ever raise; this shot is about what is landing
      // on the shed, so it is opened up for its duration and put back afterwards.
      stage: [{ do: 'shakeScale', value: 0.95 }],
      track: { kind: 'gate' },
      interp: 'catmull',
      rail: [
        { at: 0, lift: 0, stand: 30, eye: 8.0, aim: 3.8, dist: 46, fov: 35, yaw: 'in', yawAdd: -0.14 },
        { at: 0.5, lift: 0, stand: 18, eye: 7.0, aim: 3.6, dist: 38, fov: 33, yawAdd: -0.12 },
        { at: 1, lift: 0, stand: 6, eye: 6.0, aim: 3.4, dist: 30, fov: 32, yawAdd: -0.10, ease: 'smootherstep' },
      ],
    },
    {
      /*
       * The road, two and a half seconds after the leaves go — from above the road rather than on
       * it, so the cut reads as a cut and not as a stutter in the push, and at 0.7× so the column
       * still has weight after eleven cuts.
       *
       * **There is no flood, and this beat is the honest version of that.** The shipped trailer
       * ended on the same finding — 26 blows, the gate open, and zero attackers cityward of the
       * door plane at every sample from t+200 to t+300 — and on this circuit it is worse: by
       * t+216 there are between one and seven men in melee *anywhere on the field*. The assault
       * has been destroyed by the time the door gives way. So what this shot has in it is the
       * column that was massed at the gate, on the road, under the arch, which is what is there.
       *
       * **Ten framings were shot at this second before this one was chosen**, and the ones that
       * lost are worth listing because they are the shapes this beat naturally wants to take. A
       * bay-1 wide from up the curtain put the gate in the middle distance behind two tombs and
       * a cypress, with the grass doing most of the work. A long lens from down the road did the
       * same thing with a longer lens. The `corpses` anchor found its densest cell in deep shadow
       * at the foot of the wall and came back almost black. A crest-height look along the walk
       * above the arch found a statue. A low, wide, oblique one at 18 m was the most dramatic and
       * the darkest: mean luma 45.7 at 400 px against 62.5 for the shot before it, and frame
       * contrast 26.3, the lowest of any picture in the film — because at hour 14.3 the *south*
       * face of Rome's curtain is in shadow and every tight framing of the gate is a dark one.
       *
       * What is left is elevated and pulled back far enough to get the lit surfaces in: the tomb
       * and the road on the right, the tops of the towers, the city between them, the shed still
       * under the arch and the column on the road.
       *
       * Sharing `gateOpen` with the shot before and the card after means all three are one scouted
       * cue and there is no second predicate to be contaminated by the first.
       */
      id: 'the-road',
      scene: 'rome-assault',
      desc: 'The road at the broken gate: the column under the arch, from above.',
      start: { find: 'gateOpen', offset: 2.5, before: 520 },
      len: 2.1667,
      speed: 0.7,
      stage: [{ do: 'shakeScale', value: 0.6 }],
      track: { kind: 'gate' },
      rail: [
        { at: 0, lift: 0, stand: 18, eye: 19.0, aim: 6.5, dist: 48, fov: 34, yaw: 'in', yawAdd: -0.36 },
        { at: 1, lift: 0, stand: 15, eye: 17.4, aim: 5.9, dist: 42, fov: 33, yawAdd: -0.32, ease: 'smootherstep' },
      ],
    },
    {
      /*
       * The card.
       *
       * `gateOpen + 14` rather than a clock, and rather than the `corpses n: 700` this was first
       * written with. **That is not a stylistic change, it is a bug workaround, and it belongs in
       * a comment because the next author will hit it.** The runner scouts all of a scene's cues
       * on one forward-running clock, deduplicating by predicate — but a *different* predicate is
       * still evaluated from wherever the previous one left off, and a simulation cannot be
       * rewound. `corpses(700)` has a `before` of 420 and `gateOpen` has 520, so corpses was
       * scouted first, resolved at t+260.3667, and `gateOpen` was then asked from there and
       * answered "already true, now" — the same t+260.36666666665815. Two unrelated predicates
       * firing on the same tick to fourteen decimal places is the tell.
       *
       * Hanging the card off the *same* predicate as the gate removes the second cue entirely.
       * It is also the better edit: "fourteen seconds after the gate goes" is a statement about
       * the film, and "the seven hundredth corpse" was a statement about a counter.
       *
       * The caption carries the music credit, because **CC BY 4.0 requires it and the end card
       * has no field for it.** `endcard` takes a title, a tagline and a URL and nothing else, so
       * the attribution goes in the caption slot with an empty title — which works, and reads as
       * a credit line bottom left, but is a workaround. `docs/video/TRAILER-2.md` records it as
       * the one thing the shot format was missing for this film.
       */
      id: 'endcard',
      scene: 'rome-assault',
      desc: 'The Aurelian Wall with Rome behind it, and the title.',
      start: { find: 'gateOpen', offset: 14, before: 520 },
      len: 3.5,
      track: { kind: 'bay', k: 4 },
      rail: [
        { at: 0, lift: 0, stand: 46, eye: 36, aim: 11, dist: 176, fov: 34, yaw: 'in', yawAdd: 0.56 },
        { at: 1, lift: 0, stand: 44, eye: 34, aim: 11, dist: 166, fov: 34, yawAdd: 0.52 },
      ],
      caption: {
        text: '',
        sub: "Music: 'Song Of The Forge' by Scott Buckley — CC BY 4.0 — scottbuckley.com.au",
        in: 0.1,
        out: 0.96,
      },
      endcard: { title: 'TOTAL CLAUDE', tagline: 'ONE BROWSER TAB', url: 'total-claude.vercel.app' },
      fadeOut: 0.9,
    },
  ],
};
