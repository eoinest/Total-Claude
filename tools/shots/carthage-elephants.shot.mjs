/**
 * Carthage — the elephants, and the wall.
 *
 * **This film is staged, and it says so.** The Punic order of battle carries two units of war
 * elephants; this script fields four, and `film.json` records `emergent: false` with the scene
 * named in `stagedScenes` for exactly that reason. The owner asked for staged setups to be
 * possible, and they are — but a frame that was arranged has to be labelled, or none of the
 * unlabelled ones can be trusted either. The trailer's README ends on the one shot it could
 * not have, "It was not staged, because it does not happen"; that sentence only means anything
 * while the staged frames are marked.
 *
 * What this script is here to prove:
 *   - **A staged order of battle.** `scenes.*.armies` is merged into the `?battle=` token, so
 *     the composition is fixed before `Engine` is constructed and the whole battle is a
 *     different — but equally seeded, equally reproducible — one.
 *   - **Two scenes in one film**, which is two page loads, captured in scene order and cut in
 *     declaration order.
 *   - **A freeze**: `speed: 0` holds the simulation still while the camera keeps moving. The
 *     mechanism is `Time.paused`, so no tick fires and the accumulator is untouched.
 *   - **`stage: shake`** — a scripted camera kick on the frame the freeze releases.
 *   - **An end card.**
 */
export default {
  id: 'carthage-elephants',
  title: 'Carthage — the elephants',
  width: 1920,
  height: 1080,
  quality: 'ultra',

  scenes: {
    'carth-field': {
      map: 'carthage',
      scenario: 'field',
      enemy: 'carthage',
      hour: 10.4,
      seed: 4265438264,
      unitSize: 'ultra',
      difficulty: 'hard',
      /*
       * The staged order of battle.
       *
       * Hannibal's proportions with the elephant contingent doubled: four units instead of two,
       * paid for out of the Gallic mercenaries so the army's total frontage is roughly what it
       * was. This is the whole of "place units" in this format — the composition is a
       * `BattleConfig` field, it goes through `?battle=`, `sanitiseConfig` has the last word on
       * it, and the deployment is then the scenario's own. Nothing reaches into the running
       * simulation to put a unit somewhere it would not have stood.
       */
      armies: {
        carthage: {
          'libyan-spearmen': 4,
          'iberian-scutarii': 3,
          'gallic-mercenaries': 1,
          'sacred-band': 1,
          'iberian-caetrati': 2,
          'balearic-slingers': 2,
          'numidian-cavalry': 3,
          'war-elephants': 4,
        },
      },
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
  },

  shots: [
    {
      /*
       * The elephants coming on, tracked.
       *
       * `unitType` picks the largest surviving unit of the type, and `mode: 'follow'` keeps the
       * aim point on it as it advances. The elephants walk at about 3 m/s and the shot is five
       * seconds, so a pinned anchor would drift fifteen metres — not fatal at this standoff,
       * which is why the trailer got away with pinning it, but the frame closes on 32 m and
       * fifteen metres of drift at 32 m is half the subject.
       */
      id: 'eles',
      scene: 'carth-field',
      desc: 'Four units of war elephants coming on in front of the Punic centre.',
      start: { find: 'contact', offset: -9, before: 240 },
      len: 5,
      track: { kind: 'unitType', id: 'war-elephants', mode: 'follow', lag: 0.6 },
      rail: [
        { at: 0, eye: 5.0, aim: 2.4, dist: 52, fov: 32, yawAdd: 0.45 },
        { at: 1, eye: 3.6, aim: 2.8, dist: 32, fov: 32, yawAdd: 0.72, ease: 'easeIn' },
      ],
      caption: { text: 'CARTHAGE', sub: 'Spring, 146 BC', in: 0.12, out: 0.88 },
    },
    {
      /*
       * A freeze, and a camera that keeps moving through it.
       *
       * `speed: 0` fires no ticks at all: every one of these frames renders the same simulation
       * state with the camera at a different station on the rail. `Time.paused` makes
       * `beginFrame` return zero steps and hands every visual system a `scaledDt` of zero, so
       * the men, the dust and the animation phase are all held while `rig.update` still gets
       * the real frame delta and re-places the eye. It is the arrest at the top of a Rome II
       * trailer beat, and it costs the simulation nothing — the accumulator is not touched, so
       * the shot that follows fires exactly the ticks it would have fired without this one.
       *
       * The `shake` on the first frame is camera-only and decays across the hold, which is what
       * keeps a frozen picture from reading as a dropped connection.
       */
      id: 'eles-arrest',
      scene: 'carth-field',
      desc: 'The moment of impact, held, while the camera arcs across it.',
      start: { find: 'contact', offset: 0.5, before: 240 },
      len: 1.6,
      speed: 0,
      stage: [{ do: 'shake', amplitude: 0.9, decay: 2.2 }],
      track: { kind: 'unitType', id: 'war-elephants' },
      rail: [
        { at: 0, eye: 3.6, aim: 2.8, dist: 30, fov: 32, yawAdd: 0.72 },
        { at: 1, eye: 4.4, aim: 2.6, dist: 26, fov: 30, yawAdd: 1.14, ease: 'linear' },
      ],
      fadeOut: 0.35,
    },
    {
      /*
       * A descending crane onto the great wall and its ditch.
       *
       * The second scene, and therefore the second page load. Capture order is scene order and
       * the cut is rebuilt in declaration order afterwards, so putting Carthage's wall after
       * Carthage's field costs nothing even though the two are different battles.
       *
       * 158 m down to 44 m over five seconds is 23 m/s of descent, which is fast for a crane
       * and is why the rail is Catmull rather than a two-key ease: with three stations the
       * middle of the move never changes direction and the arrival is the only place the
       * velocity goes to zero.
       */
      id: 'byrsa',
      scene: 'carth-assault',
      desc: 'A descending crane: the city and the Byrsa, then down onto the great wall.',
      start: 12,
      len: 6,
      track: { kind: 'gate' },
      interp: 'catmull',
      rail: [
        { at: 0, lift: 0, stand: 20, eye: 158, aim: 22, dist: 380, fov: 34, yaw: 'in', yawAdd: -0.30 },
        { at: 0.55, stand: 38, eye: 84, aim: 14, dist: 268, fov: 34, yawAdd: -0.20 },
        { at: 1, stand: 52, eye: 44, aim: 9, dist: 196, fov: 34, yawAdd: -0.10, ease: 'smootherstep' },
      ],
      fadeIn: 0.5,
    },
    {
      id: 'endcard',
      scene: 'carth-assault',
      desc: 'The Punic curtain from the ditch, and the title.',
      start: 30,
      len: 4,
      track: { kind: 'bay', k: 1 },
      rail: [
        { at: 0, lift: 0, stand: 30, eye: 28, aim: 15, dist: 66, fov: 32, yaw: 'in', yawAdd: 0.62 },
        { at: 1, lift: 0, stand: 24, eye: 23, aim: 14, dist: 50, fov: 32, yawAdd: 0.44 },
      ],
      endcard: { title: 'TOTAL CLAUDE', tagline: 'ONE BROWSER TAB', url: 'total-claude.vercel.app' },
    },
  ],
};
