import { ELEPHANT_RIG, ELEPHANT_CONTACTS, EB } from './rig';
import { buildOverlay, measureRootSpeed, restClip, type BoneTrack, type PoseClip } from './pose';
import type { ClipSet } from './clips';

/**
 * War-elephant animation, authored from first principles.
 *
 * ## What an elephant does that a horse does not
 * Three facts drive everything below, and getting any of them wrong makes the animal read as
 * a grey horse:
 *
 * 1. **There is no suspension phase at any speed.** A horse gallops by throwing itself
 *    through the air; an elephant never has fewer than two feet on the ground, at any speed,
 *    ever. It has no trot and no gallop — the fast gait is just the walk with a longer stride
 *    and a shorter stance, which is why "running" elephants look like they are hurrying
 *    rather than sprinting.
 * 2. **The footfall is a lateral sequence**: left hind, left fore, right hind, right fore,
 *    evenly quartered through the cycle. Not the diagonal couplets of a trot.
 * 3. **The limbs are columnar.** Joint excursions are small and the leg stays close to
 *    vertical. An elephant lifts its feet about 0.12 m clear of the ground when walking.
 *
 * ## Rate matching, and the bug this file is written to avoid
 * `horseMesh.ts` and `UnitRenderSystem` record a defect worth repeating: the gallop never
 * took its rate-matched branch, because the playback rate was taken from the *rider's* clip
 * — and every ride clip is an overlay whose `rootSpeed` is zero — while the animal's real
 * measured stride was 5.362 m. The hooves skated at 2.7 to 4.1 m/s.
 *
 * The defence here is structural rather than careful. Nothing in this file writes a stride
 * length by hand. Each locomotion clip is authored, and then `measureRootSpeed` reads the
 * true stride back off the backward drift of a planted foot, exactly as `clips.ts` does for
 * the man and the horse. `ELEPHANT_GAIT_STRIDE` is therefore *measured output*, not input,
 * and if an amplitude below is edited the stride follows it automatically.
 * `tools/probe-elephant.mjs` then checks the loop is closed by measuring residual foot slip
 * in the running game.
 */

/** Frames per locomotion cycle. 24 at 30 Hz is 0.8 s of unique pose, resampled by phase. */
const GAIT_FRAMES = 24;

/**
 * Fraction of the cycle each foot spends planted.
 *
 * Above 0.5 at every gait, which is the formal definition of a walk and the reason an
 * elephant can never be airborne: with four feet quartered in phase and each down for more
 * than half the cycle, at least two overlap at all times. Measured duty factors for
 * *Loxodonta* run about 0.62 at a normal walk and drop to about 0.55 at their fastest, which
 * is exactly the range used here — and it is why the fast gait is authored as the same walk
 * with a longer reach rather than as a different gait.
 */
const DUTY_WALK = 0.62;
const DUTY_CHARGE = 0.55;

/** Phase offset of each limb within the cycle: left hind, left fore, right hind, right fore. */
const LATERAL_SEQUENCE = {
  bL: 0.0,
  fL: 0.25,
  bR: 0.5,
  fR: 0.75,
} as const;

type Key = readonly [number, number, number, number];

/**
 * Sample a per-limb function over one loop, with the limb's phase folded in.
 *
 * Keys must span 0 and 1 with equal endpoints or `sampleKeys` clamps at the ends and the
 * loop visibly hitches once a cycle.
 */
function cycle(
  phase: number,
  n: number,
  fn: (tau: number, t: number) => [number, number, number]
): Key[] {
  const keys: Key[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const tau = (t + phase) % 1;
    const [rx, ry, rz] = fn(tau, t);
    keys.push([t, rx, ry, rz]);
  }
  return keys;
}

/**
 * Fore-and-aft swing of a limb's root, in degrees about world X.
 *
 * Sign convention: the bones hang below their pivot, so a **positive** X rotation carries the
 * foot backward and a negative one forward. Stance therefore runs from -A to +A at a constant
 * rate — the body passing at a steady speed over a planted foot — and swing returns from +A
 * to -A over the shorter remainder, which is what makes the recovery visibly quicker than the
 * push.
 */
const swingAngle = (tau: number, amp: number, duty: number): number => {
  if (tau < duty) return -amp + 2 * amp * (tau / duty);
  const s = (tau - duty) / (1 - duty);
  return amp - 2 * amp * s;
};

/**
 * How high the foot should be above the stance plane at this point in the cycle, in metres.
 *
 * Zero throughout stance, and a smooth hump through swing that returns to zero exactly at
 * the plant. Expressed as a *height* rather than as a joint angle because height is the
 * thing that matters and the thing the probe measures: "clear the ground by 0.13 m" is a
 * statement about an elephant, where "flex the carpus 17 degrees" is a statement about a
 * rig, and the second only accidentally implies the first.
 */
const liftProfile = (tau: number, lift: number, duty: number): number => {
  if (tau < duty) return 0;
  const s = (tau - duty) / (1 - duty);
  return lift * Math.sin(Math.PI * s);
};

const RAD = Math.PI / 180;

/** One segment of a limb: the offset from its parent joint, in the rest pose. */
interface Segment {
  dy: number;
  dz: number;
}

interface LegSpec {
  root: number;
  mid: number;
  knee: number;
  foot: number;
  phase: number;
  /** root->mid, mid->knee, knee->foot. */
  segs: [Segment, Segment, Segment];
  /** World height of the limb's root pivot in the rest pose. */
  rootY: number;
  /** World x of the limb's root pivot, for the roll compensation. */
  rootX: number;
}

/**
 * A segment's rest offset, taken from the rig rather than written down, so editing a bone
 * position in `elephantSkeleton.ts` cannot silently invalidate the stance solve below.
 *
 * **Both components, not just the vertical.** The first version of this took only the
 * difference in height and treated each segment as a plumb line. That is wrong by the amount
 * the bone leans, and the error is not small once the leg swings: rotating a segment about X
 * mixes its z offset into its height as `-dz * sin(theta)`, so at 30 degrees of swing the
 * front leg's 40 mm of z lean moved the foot 30 mm. The probe saw it as the front feet
 * resting 33 mm above the hind feet — four feet on two different ground planes, on an animal
 * whose whole job is to look heavy.
 */
const segOf = (p: number, q: number): Segment => ({
  dy: ELEPHANT_RIG.restT[q * 3 + 1] - ELEPHANT_RIG.restT[p * 3 + 1],
  dz: ELEPHANT_RIG.restT[q * 3 + 2] - ELEPHANT_RIG.restT[p * 3 + 2],
});

const legOf = (
  root: number, mid: number, knee: number, foot: number, phase: number
): LegSpec => ({
  root, mid, knee, foot, phase,
  segs: [segOf(root, mid), segOf(mid, knee), segOf(knee, foot)],
  rootY: ELEPHANT_RIG.restT[root * 3 + 1],
  rootX: ELEPHANT_RIG.restT[root * 3],
});

const LEGS: readonly LegSpec[] = [
  legOf(EB.bHipL, EB.bFemurL, EB.bHockL, EB.bFootL, LATERAL_SEQUENCE.bL),
  legOf(EB.fShoulderL, EB.fUpperL, EB.fKneeL, EB.fFootL, LATERAL_SEQUENCE.fL),
  legOf(EB.bHipR, EB.bFemurR, EB.bHockR, EB.bFootR, LATERAL_SEQUENCE.bR),
  legOf(EB.fShoulderR, EB.fUpperR, EB.fKneeR, EB.fFootR, LATERAL_SEQUENCE.fR),
];

/**
 * How far the foot hangs below the limb's root pivot, for a swing angle and a joint flex.
 *
 * Models what `frameGlobals` will actually do: each segment is carried by its parent's
 * accumulated world rotation, which here is a rotation about X of theta, theta+k and
 * theta+2k down the chain. Rotating an offset (dy, dz) about X gives a height of
 * `dy*cos - dz*sin`, and the sum of the three is the drop.
 */
function footDrop(L: LegSpec, theta: number, k: number): number {
  let drop = 0;
  for (let i = 0; i < 3; i++) {
    const a = (theta + k * i) * RAD;
    drop -= L.segs[i].dy * Math.cos(a) - L.segs[i].dz * Math.sin(a);
  }
  return drop;
}

/**
 * Joint flexion that puts the foot at a wanted height, solved per frame.
 *
 * **This is the correction the first two passes of this file were missing, and the probe
 * caught both rather than the eye.**
 *
 * *Pass one* rotated a rigid limb at a fixed hip. That does not move a foot along the
 * ground, it moves it along an **arc**: at 18 degrees of swing on a 2.16 m leg the "planted"
 * foot rises 2.16 x (1 - cos 18) = 0.106 m at mid-stance. `probe-elephant` reported the walk
 * as having *no feet on the ground at all* for part of the cycle, and the body bobbed ten
 * centimetres a step like a hobby horse.
 *
 * *Pass two* cancelled the arc during stance but lifted the swing foot with a half-sine in
 * degrees. That is wrong on the forward half of the swing, and quietly so: with the leg 9
 * degrees ahead of vertical and 12 degrees of flex, the three segments sit at -9, +3 and +15
 * — all *closer* to vertical than the leg itself, so the leg gets vertically longer and the
 * foot passes **72 mm below the stance plane**. It scuffed through the ground once per step
 * per leg, which is exactly the class of defect a still frame cannot show.
 *
 * The fix for both is to stop specifying an angle at all. `footDrop` is monotone in nothing
 * useful — it rises and then falls as flex increases, because each segment swings through
 * vertical in turn — so this scans upward from straight and takes the **first** flexion that
 * reaches the wanted drop. Continuous by construction: at the stance extremes the wanted
 * drop is what a straight leg already gives, so the scan returns zero and the leg is a
 * column at the moment of plant, which is what an elephant's leg is for.
 *
 * The correction is split equally across the middle and lower joints rather than loaded onto
 * one, so neither bends far — at a walk the solve peaks around 14 degrees a joint. That
 * matters: this animal's entire silhouette is that its legs are pillars.
 */
function solveFlex(L: LegSpec, theta: number, wantDrop: number): number {
  const STEP = 0.25;
  for (let k = 0; k <= 80; k += STEP) {
    if (footDrop(L, theta, k) <= wantDrop) return k;
  }
  return 80;
}

/**
 * How the body itself moves through a gait cycle, in metres and degrees of roll.
 *
 * Declared alongside the legs rather than written straight into the clip because the legs
 * have to *know* about it. See `legTracks`.
 */
interface BodyMotion {
  /** Vertical rise of the whole animal at clip time `t`, metres. */
  bob: (t: number) => number;
  /** Roll about the fore-aft axis at clip time `t`, degrees. Positive lifts the left side. */
  roll: (t: number) => number;
}

/**
 * Leg tracks for one gait.
 *
 * `swing` is the peak fore-and-aft amplitude at the limb root, in degrees; `lift` is how far
 * the foot clears the ground at mid-swing, **in metres**. Flexion is not a parameter — it is
 * solved from those two, plus the body motion.
 *
 * **The body motion has to be part of the solve, and that was the third thing the probe
 * caught.** With the stance plane flat and the swing lift correct, the walk still reported
 * feet leaving the ground: the animal's own 22 mm bob and 1.8 degrees of roll were moving
 * every planted foot with the body, because a rigid leg bolted to a body that rises takes
 * its foot up with it. A real leg absorbs that at the joints. So the wanted drop for each
 * leg is the stance plane *plus* however far that leg's root has been carried up this frame
 * — which is the bob, plus the roll's contribution at that leg's own lateral offset. The
 * foot then stays exactly where it was put while the animal breathes and sways over it.
 */
function legTracks(
  swing: number,
  lift: number,
  duty: number,
  body: BodyMotion,
  samples = 24
): BoneTrack[] {
  /**
   * The one ground plane all four feet stand on, in world height.
   *
   * A straight leg's reach varies across the swing sweep, and it varies *differently* for the
   * fore and hind limbs because their segments are not the same lengths or leans. So the
   * plane cannot be per-leg: it is the lowest height every leg can still reach with its
   * joints straight at the worst point of its own sweep. Solving each limb against a private
   * plane is what put the front feet 33 mm above the hind ones — an elephant standing on a
   * staircase.
   */
  const groundY = Math.min(...LEGS.map((leg) => {
    let worst = -Infinity;
    for (let s = 0; s <= 32; s++) {
      const theta = -swing + (2 * swing * s) / 32;
      worst = Math.max(worst, leg.rootY - footDrop(leg, theta, 0));
    }
    return worst;
  }));

  const out: BoneTrack[] = [];
  for (const leg of LEGS) {
    const flexAt = (tau: number, t: number): number => {
      const theta = swingAngle(tau, swing, duty);
      // Roll about +Z lifts a bone at +x by x*sin(roll); the leg must lengthen by as much or
      // the planted foot is carried up with the body.
      const carried = body.bob(t) + leg.rootX * Math.sin(body.roll(t) * RAD);
      const wantY = groundY + liftProfile(tau, lift, duty);
      return solveFlex(leg, theta, leg.rootY + carried - wantY);
    };
    out.push({
      bone: leg.root,
      keys: cycle(leg.phase, samples, (tau) => [swingAngle(tau, swing, duty), 0, 0]),
    });
    out.push({ bone: leg.mid, keys: cycle(leg.phase, samples, flexAt2(flexAt)) });
    out.push({ bone: leg.knee, keys: cycle(leg.phase, samples, flexAt2(flexAt)) });
    // The pad stays flat to the ground instead of rotating with the shank. Without this the
    // sole tips up through the whole of stance and the animal appears to walk on its toes,
    // which is the one thing an elephant — which walks on a fat fibrous heel pad — does not do.
    out.push({ bone: leg.foot, keys: [[0, 0, 0, 0]], stab: true });
  }
  return out;
}

/** Adapt a scalar flex solve to the `[rx, ry, rz]` shape `cycle` expects. */
const flexAt2 = (f: (tau: number, t: number) => number) =>
  (tau: number, t: number): [number, number, number] => [f(tau, t), 0, 0];

/**
 * Ear flap, in degrees about world Y.
 *
 * `beats` must be a whole number so the clip loops. Elephant ears are thermoregulators and
 * move constantly and independently of the gait, so the two sides are given different beat
 * counts and opposite signs — synchronised ears read as a mechanism.
 */
const earTracks = (amp: number, beats: number, bias = 0): BoneTrack[] => [
  {
    bone: EB.earL,
    keys: cycle(0, 12, (t) => [0, bias + amp * Math.sin(t * Math.PI * 2 * beats), 0]),
  },
  {
    bone: EB.earR,
    keys: cycle(0.37, 12, (t) => [0, -bias - amp * Math.sin(t * Math.PI * 2 * beats), 0]),
  },
];

/** Trunk curl, applied as a progressive rotation down the four segments. */
const trunkCurl = (a1: number, a2: number, a3: number, a4: number): BoneTrack[] => [
  { bone: EB.trunk1, keys: [[0, a1, 0, 0]] },
  { bone: EB.trunk2, keys: [[0, a2, 0, 0]] },
  { bone: EB.trunk3, keys: [[0, a3, 0, 0]] },
  { bone: EB.trunk4, keys: [[0, a4, 0, 0]] },
];

/** A trunk that sways rather than hanging rigid. `beats` whole so the clip loops. */
const trunkSway = (amp: number, beats: number, droop = 0): BoneTrack[] => [
  {
    bone: EB.trunk1,
    keys: cycle(0, 12, (t) => [droop, amp * 0.5 * Math.sin(t * Math.PI * 2 * beats), 0]),
  },
  {
    bone: EB.trunk2,
    keys: cycle(0.1, 12, (t) => [droop * 0.6, amp * Math.sin(t * Math.PI * 2 * beats), 0]),
  },
  {
    bone: EB.trunk3,
    keys: cycle(0.2, 12, (t) => [droop * 0.4, amp * 1.4 * Math.sin(t * Math.PI * 2 * beats), 0]),
  },
  {
    bone: EB.trunk4,
    keys: cycle(0.3, 12, (t) => [droop * 0.2, amp * 1.8 * Math.sin(t * Math.PI * 2 * beats), 0]),
  },
];

const tailSwish = (amp: number, beats: number): BoneTrack[] => [
  { bone: EB.tail1, keys: cycle(0, 12, (t) => [0, amp * Math.sin(t * Math.PI * 2 * beats), 0]) },
  { bone: EB.tail2, keys: cycle(0.15, 12, (t) => [0, amp * 1.5 * Math.sin(t * Math.PI * 2 * beats), 0]) },
];

const base = restClip(ELEPHANT_RIG, 'elephant-rest', 1);

const clips = new Map<string, PoseClip>();

/**
 * Body motion for a gait, declared once so the legs and the root cannot disagree.
 *
 * `bobM` is the peak vertical rise in metres and `rollDeg` the peak roll. Both are small on
 * purpose: measured centre-of-mass oscillation for a walking *Loxodonta* is 2 to 4 cm total,
 * which is why an elephant's back is steady enough to sit on unheld and why overdoing it is
 * the fastest way to turn four tonnes into a bouncing toy. The bob runs at twice the stride
 * frequency because four quartered footfalls produce two support exchanges per cycle.
 */
const bodyOf = (bobM: number, rollDeg: number): BodyMotion => ({
  bob: (t) => bobM * Math.sin(t * Math.PI * 4),
  roll: (t) => rollDeg * Math.sin(t * Math.PI * 2),
});

const WALK_BODY = bodyOf(0.012, 1.1);
const CHARGE_BODY = bodyOf(0.022, 1.8);
const PANIC_BODY = bodyOf(0.026, 6.0);

// ---------------------------------------------------------------------------
// Idle
// ---------------------------------------------------------------------------
// Standing about. No footfall at all — an elephant at rest genuinely does not shift its feet
// much — so all the life is in the ears, the trunk and a slow weight roll.
clips.set('idle', buildOverlay(ELEPHANT_RIG, base, {
  name: 'idle',
  frames: 30,
  duration: 4.2,
  loop: true,
  rootSpeed: 0,
  tracks: [
    // A very slow roll as weight moves from one side to the other.
    { bone: EB.root, keys: cycle(0, 8, (t) => [0, 0, 1.6 * Math.sin(t * Math.PI * 2)]) },
    { bone: EB.head, keys: cycle(0.2, 8, (t) => [2 * Math.sin(t * Math.PI * 2), 0, 0]) },
    ...trunkSway(16, 1, 6),
    ...earTracks(13, 2),
    ...tailSwish(9, 2),
  ],
}));

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------
// 18 degrees of swing on a 2.16 m leg is about 1.34 m of stance excursion; `measureRootSpeed`
// reports the real figure below and that is the one the renderer divides by.
clips.set('walk', buildOverlay(ELEPHANT_RIG, base, {
  name: 'walk',
  frames: GAIT_FRAMES,
  duration: 1.35,
  loop: true,
  tracks: [
    ...legTracks(14, 0.13, DUTY_WALK, WALK_BODY),
    { bone: EB.root, keys: cycle(0, 16, (_tau, t) => [0, 0, WALK_BODY.roll(t)]) },
    { bone: EB.head, keys: cycle(0.5, 12, (t) => [2.5 * Math.sin(t * Math.PI * 2), 0, 0]) },
    ...trunkSway(13, 1, 4),
    ...earTracks(9, 2),
    ...tailSwish(7, 1),
  ],
  root: cycle(0, 16, (_tau, t) => [0, WALK_BODY.bob(t), 0]),
}));

// ---------------------------------------------------------------------------
// Charge
// ---------------------------------------------------------------------------
/**
 * The fast amble, and the pose the whole unit is bought for.
 *
 * Still a walk by gait definition — duty 0.55, so two feet are always down — but with a much
 * longer reach and a shorter stance. On top of that, three things that are specifically what
 * a charging elephant looks like and are the difference between "fast elephant" and
 * "terrifying":
 *
 *  - **The trunk is curled up and tucked in.** This is not stylisation. The trunk is the
 *    animal's most vulnerable part and it rolls it up out of harm's way before contact; every
 *    depiction from the Pompeii mosaics onward shows it. It also clears the tusks, which is
 *    what a player needs to see coming at them.
 *  - **The head is down and the tusks are levelled** at the height of a man's chest.
 *  - **The ears are flared wide**, which nearly doubles the animal's apparent frontal area.
 */
clips.set('charge', buildOverlay(ELEPHANT_RIG, base, {
  name: 'charge',
  frames: GAIT_FRAMES,
  duration: 0.72,
  loop: true,
  tracks: [
    ...legTracks(25, 0.19, DUTY_CHARGE, CHARGE_BODY),
    // Roll only. A constant forward *pitch* on the root was tried and removed: at 3.5 degrees
    // it raises a leg root 1.3 m behind the pelvis by 79 mm, which lifts both hind feet clean
    // off the stance plane for the whole clip. The aggression has to come from the neck, the
    // trunk and the stride — all of which are below — and not from tipping the animal, because
    // nothing tips a walking elephant.
    { bone: EB.root, keys: cycle(0, 16, (_tau, t) => [0, 0, CHARGE_BODY.roll(t)]) },
    // Head and neck down, so the tusks come level rather than pointing at the sky.
    { bone: EB.neck, keys: [[0, 11, 0, 0]] },
    { bone: EB.head, keys: cycle(0.5, 12, (t) => [8 + 4 * Math.sin(t * Math.PI * 2), 0, 0]) },
    ...trunkCurl(38, 52, 62, 46),
    ...earTracks(11, 2, 26),
    ...tailSwish(14, 2),
  ],
  root: cycle(0, 16, (_tau, t) => [0, CHARGE_BODY.bob(t), 0]),
}));

// ---------------------------------------------------------------------------
// Attack — the tusk sweep
// ---------------------------------------------------------------------------
// One-shot. The head drops, then throws upward and to one side: an elephant kills by goring
// and by tossing, not by biting, and the upward sweep is what puts a man over the front rank.
clips.set('attack', buildOverlay(ELEPHANT_RIG, base, {
  name: 'attack',
  frames: 20,
  duration: 1.25,
  loop: false,
  hitFrame: 0.45,
  tracks: [
    {
      bone: EB.neck,
      keys: [[0, 4, 0, 0], [0.3, 16, 0, 0], [0.5, -22, 0, 0], [0.72, -6, 0, 0], [1, 4, 0, 0]],
    },
    {
      bone: EB.head,
      keys: [[0, 0, 0, 0], [0.3, 10, -14, 0], [0.5, -18, 16, 0], [0.75, -4, 4, 0], [1, 0, 0, 0]],
    },
    { bone: EB.root, keys: [[0, 0, 0, 0], [0.34, 3, 0, 0], [0.52, -4, 0, 0], [1, 0, 0, 0]] },
    ...trunkCurl(46, 60, 68, 50),
    ...earTracks(10, 1, 22),
  ],
}));

// ---------------------------------------------------------------------------
// Death
// ---------------------------------------------------------------------------
// The legs buckle and it goes down on one side. Slow — four tonnes does not drop quickly —
// and the root sinks 1.5 m, which is most of the way from a standing shoulder to a lying one.
clips.set('death', buildOverlay(ELEPHANT_RIG, base, {
  name: 'death',
  frames: 26,
  duration: 2.6,
  loop: false,
  tracks: [
    { bone: EB.root, keys: [[0, 0, 0, 0], [0.25, -6, 0, 8], [0.6, 4, 0, 46], [1, 6, 0, 78]] },
    { bone: EB.neck, keys: [[0, 0, 0, 0], [0.4, -14, 0, 0], [1, 18, 0, 0]] },
    { bone: EB.head, keys: [[0, 0, 0, 0], [0.45, -10, 0, 0], [1, 22, 0, -12]] },
    // The forelegs fold first, which is how a collapsing elephant actually goes down.
    { bone: EB.fShoulderL, keys: [[0, 0, 0, 0], [0.3, -26, 0, 0], [1, -46, 0, 0]] },
    { bone: EB.fShoulderR, keys: [[0, 0, 0, 0], [0.34, -22, 0, 0], [1, -42, 0, 0]] },
    { bone: EB.fKneeL, keys: [[0, 0, 0, 0], [0.3, 54, 0, 0], [1, 86, 0, 0]] },
    { bone: EB.fKneeR, keys: [[0, 0, 0, 0], [0.34, 48, 0, 0], [1, 82, 0, 0]] },
    { bone: EB.bHipL, keys: [[0, 0, 0, 0], [0.55, 18, 0, 0], [1, 34, 0, 0]] },
    { bone: EB.bHipR, keys: [[0, 0, 0, 0], [0.6, 14, 0, 0], [1, 30, 0, 0]] },
    { bone: EB.bHockL, keys: [[0, 0, 0, 0], [0.55, -30, 0, 0], [1, -58, 0, 0]] },
    { bone: EB.bHockR, keys: [[0, 0, 0, 0], [0.6, -26, 0, 0], [1, -54, 0, 0]] },
    ...trunkSway(6, 1, -18),
    ...earTracks(4, 1),
  ],
  root: [[0, 0, 0, 0], [0.3, 0, -0.35, 0], [0.65, 0, -1.05, 0], [1, 0, -1.5, 0]],
}));

// ---------------------------------------------------------------------------
// Panic
// ---------------------------------------------------------------------------
/**
 * The animal has broken, and this is the pose that sells why an elephant unit is a liability.
 *
 * Head thrown up, trunk raised and straight — an elephant trumpets with the trunk extended
 * and lifted, the opposite of the charge's tuck — ears fully flared, and a heavy lurching
 * stride. Played whenever the sim has the unit routing, so a player watching their own line
 * can see the animals turn before the damage starts.
 */
clips.set('panic', buildOverlay(ELEPHANT_RIG, base, {
  name: 'panic',
  frames: GAIT_FRAMES,
  duration: 0.78,
  loop: true,
  tracks: [
    ...legTracks(22, 0.21, 0.56, PANIC_BODY),
    // A hard roll and a yaw wobble, because a panicking elephant does not run straight. No
    // pitch, for the reason given in the charge.
    {
      bone: EB.root,
      keys: cycle(0, 16, (_tau, t) => [0, 4 * Math.sin(t * Math.PI * 2), PANIC_BODY.roll(t)]),
    },
    { bone: EB.neck, keys: [[0, -18, 0, 0]] },
    { bone: EB.head, keys: cycle(0.4, 12, (t) => [-14 + 6 * Math.sin(t * Math.PI * 2), 8 * Math.sin(t * Math.PI * 2), 0]) },
    // Trunk up and out, not curled: this is the trumpet, and it must not be confused at a
    // glance with the charge.
    ...trunkCurl(-52, -46, -34, -18),
    ...earTracks(16, 3, 30),
    ...tailSwish(22, 3),
  ],
  root: cycle(0, 16, (_tau, t) => [0, PANIC_BODY.bob(t), 0]),
}));

/**
 * Re-measure every locomotion clip's true stride.
 *
 * This is the whole defence against the skating-hoof defect described at the top of the file.
 * `buildOverlay` cannot know what stride the tracks it was handed produce — the swing
 * amplitude, the knee flex and the duty factor all feed into it — so the authored
 * `rootSpeed` would be a guess. `measureRootSpeed` instead finds the longest run of frames
 * in which a foot is at its lowest, and divides how far that foot travelled backward by how
 * long it took. That is the ground speed the clip depicts, by construction.
 */
for (const clip of clips.values()) {
  if (!clip.loop || clip.name === 'idle') continue;
  const measured = measureRootSpeed(ELEPHANT_RIG, clip, ELEPHANT_CONTACTS);
  if (measured > 0.05) clip.rootSpeed = measured;
}

/**
 * The gait ladder, slowest first.
 *
 * Two rungs and not four, because an elephant has two gaits and not four. `idle` is not on
 * the ladder: it is selected below `ELEPHANT_IDLE_EDGE` and has no stride to match.
 */
export const ELEPHANT_GAIT_NAMES = ['walk', 'charge'] as const;

/** Below this ground speed the animal is standing rather than walking, m/s. */
export const ELEPHANT_IDLE_EDGE = 0.35;

const NAMES = ['idle', 'walk', 'charge', 'attack', 'death', 'panic'] as const;

const rows = new Int32Array(NAMES.length);
const packed: PoseClip[] = [];
const nameIndex = new Map<string, number>();
{
  let row = 0;
  NAMES.forEach((name, i) => {
    const c = clips.get(name);
    if (!c) throw new Error(`[elephantClips] missing "${name}"`);
    packed.push(c);
    rows[i] = row;
    row += c.frames;
    nameIndex.set(name, i);
  });
}

export const ELEPHANT_CLIP_SET: ClipSet = {
  rig: ELEPHANT_RIG,
  clips: packed,
  rows,
  totalRows: rows[rows.length - 1] + packed[packed.length - 1].frames,
  index(name: string): number {
    const i = nameIndex.get(name);
    if (i === undefined) throw new Error(`[elephantClips] "${name}" is not packed`);
    return i;
  },
};

export const ELEPHANT_CLIP = {
  idle: ELEPHANT_CLIP_SET.index('idle'),
  walk: ELEPHANT_CLIP_SET.index('walk'),
  charge: ELEPHANT_CLIP_SET.index('charge'),
  attack: ELEPHANT_CLIP_SET.index('attack'),
  death: ELEPHANT_CLIP_SET.index('death'),
  panic: ELEPHANT_CLIP_SET.index('panic'),
} as const;

/**
 * Measured stride of each ladder rung, metres per cycle — **output, never input**.
 *
 * Read off the authored clips above rather than written down. The renderer divides ground
 * speed by these to get a playback rate, so any hand-typed value here would be the horse's
 * skating bug reintroduced by hand. `tools/probe-elephant.mjs` prints them.
 */
export const ELEPHANT_GAIT_STRIDE: readonly number[] = ELEPHANT_GAIT_NAMES.map((n) => {
  const c = packed[ELEPHANT_CLIP_SET.index(n)];
  return c.rootSpeed * c.duration;
});

/** Ladder rung -> row in `ELEPHANT_CLIP_SET`. */
export const ELEPHANT_GAIT_LADDER: readonly number[] =
  ELEPHANT_GAIT_NAMES.map((n) => ELEPHANT_CLIP_SET.index(n));
