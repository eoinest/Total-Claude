/**
 * The menu plates — one slow flyover per battlefield, for the screens in front of the game.
 *
 * This is not a film. It is the source of the three looping backdrops that live behind the
 * main menu and the loading screen, and every constraint on it comes from that:
 *
 *   - **One shot per map, and it is the whole loop.** The cut is never played as a cut; each
 *     shot is encoded to its own WebM by `tools/menu-plates.mjs` and looped forever behind a
 *     menu sheet. So there are no captions, no end card and no fades — it is shot with
 *     `--nooverlay`, which `menu-plates.mjs` passes for you.
 *
 *   - **Slow.** A backdrop a player stares at for a minute while they build an order of
 *     battle is not a trailer beat. Every rail here moves less in ten seconds than the
 *     trailer's moves do in two, and every one is `catmull`, so there is no change of
 *     velocity anywhere in the loop for the eye to catch.
 *
 *   - **It ends near where it began.** `menu-plates.mjs` makes the loop seamless by dissolving
 *     the last second into the first: output frame `i < 30` is `lerp(tail[i], head[i], i/30)`,
 *     and the output is 30 frames shorter than the capture. A dissolve between two framings
 *     that are close reads as nothing at all; a dissolve between a wide and a close-up reads
 *     as a dissolve. That is why each rail travels perhaps a fifth of the way it wants to and
 *     then stops, instead of craning from 158 m to 44 m the way `carthage-elephants` does.
 *
 *   - **The subject has to be recognisable in one glance, off-centre.** The menu sheet is
 *     `min(1180px, 94vw)` wide and sits in the middle, so on a 1920-wide screen the player
 *     sees roughly 370 px down each side plus whatever is above and below. Each composition is
 *     built around the *edges*: the Aurelian Wall runs out of the left, the Byrsa stands in
 *     the upper right, the Roman line fills the lower left.
 *
 * ---------------------------------------------------------------------------
 * The yaws are a measurement, not a taste
 * ---------------------------------------------------------------------------
 *
 * The first pass of this script was written by eye and came back with two of its three plates
 * unusable, and `film.json` named the fault outright before anybody looked at a pixel:
 *
 * | plate | `sunAngle` | what the frame looked like |
 * |---|---:|---|
 * | Rome | 15.2 deg | one flat cream wash; the brick had no relief at all |
 * | Carthage | 69.5 deg | correct — lit face and shadowed face on the same curtain |
 * | Pydna | 168.0 deg | sun behind the camera, so frontal light and no modelling anywhere |
 *
 * `SHOT-FORMAT.md` states the rule this rediscovered — *inside about 45 degrees of a low sun
 * every surface goes to one flat cream* — and the far side is just as bad: at 168 deg the sun
 * is over the camera's shoulder and every shadow in the frame is hidden behind the thing
 * casting it. The plates below are all swung to **70-115 deg**, which is broadside, and that
 * single change is the difference between the two contact sheets. **If a plate ever comes back
 * washed out, read `sunAngle` out of `film.json` before touching a light.**
 *
 * Every frame is this project's own render, out of the real simulation on the real terrain.
 * Nothing here is third-party art, and the plates are regenerated rather than retouched — see
 * the header of `tools/menu-plates.mjs` for the one command that does it.
 *
 * The seed is `DEFAULT_CONFIG.seed`, which is the battle every measurement in `docs/` was
 * taken from, so a plate is a picture of the shipped battle and not of a special one.
 */
export default {
  id: 'menu-plates',
  title: 'Menu plates',
  // 16:9. The poster ships at this size; the WebM is downscaled to 1280x720 on the way out,
  // because it plays under a scrim behind a menu sheet and nobody has ever read a backdrop
  // for its texel density.
  width: 1600,
  height: 900,
  // The tier the game is judged at, so the backdrop is a picture of the game the player is
  // about to get rather than of a cheaper one. It also fixes the soldier pool, which fixes the
  // fitted unit scale — a plate shot at `medium` is a different battle, not a smaller picture
  // of the same one.
  quality: 'ultra',

  scenes: {
    /*
     * Rome, and the only hour that works.
     *
     * 14.3 is `aurelian-gate`'s hour and it is here for the reason that film gives: the Campus
     * Martius' declination caps the sun at 34 deg even at local noon, so the choice is between
     * a flat overhead wash and a raking afternoon, and the wall's whole subject is the relief
     * in its brick.
     */
    'rome-wall': {
      map: 'campus-martius',
      scenario: 'assault',
      enemy: 'juthungi',
      hour: 14.3,
      seed: 4265438264,
      unitSize: 'ultra',
      difficulty: 'hard',
    },
    /*
     * Carthage at 16.2 — the hour `carthage-elephants` shot its Byrsa crane at, an hour before
     * the map's own 17:00 default. At 17:00 the sun is 20 deg up and 273 deg round, which is
     * very nearly straight down the barrel of a camera looking west at the wall; 16.2 keeps it
     * broadside enough that the triple curtain has a lit face and a shadowed one, which is the
     * whole of what makes it read as three walls and not one.
     */
    'carthage-wall': {
      map: 'carthage',
      scenario: 'assault',
      enemy: 'carthage',
      hour: 16.2,
      seed: 4265438264,
      unitSize: 'ultra',
      difficulty: 'hard',
    },
    /*
     * Pydna at its own default hour. 17:00 is 26 deg of elevation and 279.5 deg of bearing,
     * which the map's header defends at length against 16:00 with a measurement: at 26 deg a
     * man's shadow runs 3.6 m instead of 2.3, and on a map whose terrain casts none it is the
     * only deep tone in the frame.
     */
    'pydna-plain': {
      map: 'pydna',
      scenario: 'field',
      enemy: 'juthungi',
      hour: 17,
      seed: 4265438264,
      unitSize: 'ultra',
      difficulty: 'hard',
    },
  },

  shots: [
    {
      /*
       * ROME — the Aurelian Wall, oblique, with the city rising behind it.
       *
       * Four bays north of the Porta Flaminia. The frame is built so that the curtain and its
       * brick towers cross the lower third from left to right and the *city* fills everything
       * above them — the drum of the Pantheon, the temple fronts, the cypresses, the insulae
       * in ochre and oxblood. The wall alone is a wall; the wall with Rome behind it is the
       * only picture this map can make that no other map could.
       *
       * `yawAdd` around +1.0 rather than the -0.6 the first draft had. That is the 15.2 deg
       * fault above: swung this way the sun is 80-90 deg off the view axis, the brick has a lit
       * face and a shadowed one, and the frame gets the ochres and reds the rubric asks for
       * instead of the beige it had.
       *
       * The cue rather than a clock. `climbing >= 80` is eighty men on ladders or ramps at
       * once, which on this seed happens at t+19.2; `offset: 60` puts the camera a minute into
       * the assault, when the storm columns are up against the foot of the curtain. Written as
       * `start: 79` this shot would empty itself the day somebody changes how fast a ladder
       * party forms up, and nothing would say so.
       */
      id: 'campus-martius',
      scene: 'rome-wall',
      desc: 'The Aurelian Wall from the plain, oblique, with the city behind it and the storm columns at its foot.',
      start: { find: 'climbing', n: 80, offset: 60, before: 260 },
      len: 10,
      interp: 'catmull',
      track: { kind: 'bay', k: -4 },
      rail: [
        { at: 0, lift: 0, along: -26, stand: 24, eye: 28.0, aim: 8.5, dist: 120, fov: 34, yaw: 'in', yawAdd: 1.10 },
        { at: 0.34, along: -14, stand: 22.5, eye: 26.6, aim: 8.5, dist: 116, fov: 34, yawAdd: 1.04 },
        { at: 0.7, along: 0, stand: 21.0, eye: 25.0, aim: 8.4, dist: 111, fov: 34, yawAdd: 0.97 },
        { at: 1, along: 12, stand: 20.0, eye: 24.0, aim: 8.3, dist: 107, fov: 34, yawAdd: 0.92 },
      ],
    },
    {
      /*
       * CARTHAGE — the great wall across the isthmus, the Byrsa behind it.
       *
       * The one image that can only be this city: a citadel hill with a temple on it standing
       * over a curtain that runs across an isthmus with the gulf on both sides, and four siege
       * towers docked against the parapet with columns queuing into them.
       *
       * Two bays south of the gate and swung to `yawAdd +0.34`, which is 108.6 deg off the sun
       * — the wall runs away to the right instead of standing square to the lens, so it reads
       * as a solid thickness rather than as an elevation drawing, and the towers throw their
       * shadows across the red earth toward the camera.
       *
       * **A clock and not a cue, and the reason is a gap in the finder set.** None of the seven
       * finders describes the state this frame wants. `climbing` counts men on ladders and
       * ramps and is flatly **0 for the whole Punic assault** — Carthage storms up docked siege
       * towers, which the predicate does not see — and `melee` is in single figures at the same
       * instant, because the towers are still filling. So there is no predicate for "the towers
       * are docked and the columns are queuing", which is the picture. t+150 is where that is
       * on this seed, and `menu-plates.mjs` re-shoots all three plates in one command whenever
       * the map changes, which is the mitigation.
       */
      id: 'carthage',
      scene: 'carthage-wall',
      desc: 'The great wall across the isthmus with four siege towers docked, the Byrsa citadel and the gulf behind.',
      start: 150,
      len: 10,
      interp: 'catmull',
      track: { kind: 'bay', k: -2 },
      rail: [
        { at: 0, lift: 0, stand: 38, eye: 58, aim: 14.0, dist: 186, fov: 34, yaw: 'in', yawAdd: 0.28 },
        { at: 0.34, stand: 36, eye: 54, aim: 13.5, dist: 176, fov: 34, yawAdd: 0.32 },
        { at: 0.7, stand: 34, eye: 49, aim: 13.0, dist: 165, fov: 34, yawAdd: 0.36 },
        { at: 1, stand: 32, eye: 45, aim: 12.6, dist: 156, fov: 34, yawAdd: 0.40 },
      ],
    },
    {
      /*
       * PYDNA — the Roman line on the Pierian plain, and the host beyond it.
       *
       * `unitClass … pick: 'frontmost'` rather than `frontGap`: the midpoint of the two lines
       * puts the camera above the field and turns eight and a half thousand men into a map of
       * rectangles, which is a fine strategic view and a poor photograph. The frontmost Roman
       * cohort is a *subject* — a block of shields and standards in the near field with the
       * whole plain and the far host behind it, which is what the rubric's G1 asks a still to
       * have.
       *
       * `along` on a unit anchor slides down that unit's own frontage, so this is a dolly
       * beside the line whichever way the line is drawn up. In world metres it would be a
       * diagonal the day somebody changes the deployment.
       *
       * `contact` + 12 s, so the lines have met and the first dust is up.
       */
      id: 'pydna',
      scene: 'pydna-plain',
      desc: 'The frontmost Roman cohort on the plain under Olocrus, twelve seconds after the lines met.',
      start: { find: 'contact', offset: 12, before: 300 },
      len: 10,
      interp: 'catmull',
      track: { kind: 'unitClass', faction: 0, cls: 'heavy-infantry', pick: 'frontmost' },
      rail: [
        { at: 0, along: -22, eye: 17.0, aim: 3.0, dist: 76, fov: 34, yawAdd: 2.26 },
        { at: 0.34, along: -12, eye: 15.6, aim: 2.9, dist: 71, fov: 34, yawAdd: 2.20 },
        { at: 0.7, along: 0, eye: 14.2, aim: 2.8, dist: 66, fov: 34, yawAdd: 2.13 },
        { at: 1, along: 10, eye: 13.0, aim: 2.7, dist: 62, fov: 34, yawAdd: 2.07 },
      ],
    },
  ],
};
