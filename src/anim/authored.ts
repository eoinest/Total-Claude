import { MB, HB } from './rig';
import type { OverlayDef, BoneTrack } from './pose';

/**
 * Hand-authored animation content.
 *
 * Every clip is an overlay on a retargeted base clip. The base supplies the legs, hips and
 * spine — the retargeted weight and secondary motion that is genuinely hard to hand-key —
 * and the tracks here supply everything Roman about it.
 *
 * ## Two kinds of track
 * *Relative* tracks give a rotation in degrees about the world axes of the rest pose, and
 * accumulate down the bone chain: leaning the chest carries the arms with it. Used for the
 * spine, hips and legs, where the base clip already has the motion and only needs shaping.
 *
 * *Absolute* tracks (`absTr`) set a bone's world orientation outright, ignoring the base.
 * Every arm pose is absolute, and that is not a stylistic choice: the rest pose is a T-pose,
 * so a relative arm delta means whatever the base clip's arm happened to be doing, and any
 * attempt to damp an arm's swing drags it back toward sticking out sideways — which lays a
 * 10 kg scutum flat like a tea tray. Absolute poses also mean the shield and the weapons
 * sit in the same place in every clip, which is what makes one socket per item work.
 *
 * ## Axes
 * The model faces +Z with +Y up, so its own right hand is at -X. Euler is applied Z, then
 * Y, then X (THREE's 'XYZ' quaternion order), and for an arm the useful reading is:
 *   left arm  rest +X:  Z lowers it to the side, Y swings it forward, X rolls it
 *   right arm rest -X:  Z raises it,             Y swings it forward
 * Downward-pointing limbs (thighs, hanging arms) go backwards on +X and forwards on -X.
 */

const tr = (
  bone: number,
  keys: readonly (readonly [number, number, number, number])[]
): BoneTrack => ({ bone, keys });

/** An absolute world orientation for a bone, measured from the rest T-pose. */
const absTr = (
  bone: number,
  keys: readonly (readonly [number, number, number, number])[]
): BoneTrack => ({ bone, keys, abs: true });

/** Hold this bone's base world orientation whatever the parents do. */
const hold = (bone: number): BoneTrack => ({ bone, keys: [], stab: true });

/** Feet flat on the ground whatever the legs do above them. */
const FEET_FLAT: BoneTrack[] = [hold(MB.footL), hold(MB.footR)];

// ---------------------------------------------------------------------------
// Arm pose library
// ---------------------------------------------------------------------------
// Reusable absolute arm poses. Every clip picks one for each arm, so a shield is in the
// same place relative to the forearm everywhere and the attachment sockets solved against
// `march` hold for the whole set.

/** Scutum across the body, rim from thigh to chin, elbow tucked. The default carry. */
const SHIELD_CARRY: BoneTrack[] = [
  absTr(MB.upperArmL, [[0, 0, -55, -68]]),
  absTr(MB.lowerArmL, [[0, 0, -117, 3]]),
];

/** Shield up and forward: receiving a charge, or covering the head from above. */
const SHIELD_HIGH: BoneTrack[] = [
  absTr(MB.upperArmL, [[0, -8, -62, -50]]),
  absTr(MB.lowerArmL, [[0, 0, -122, 6]]),
];

/** Shield driven ahead as a battering surface. */
const SHIELD_PUNCH: BoneTrack[] = [
  absTr(MB.upperArmL, [[0, 0, -78, -58]]),
  absTr(MB.lowerArmL, [[0, 0, -104, 0]]),
];

/** Shield slung low and loose: relaxed, resting on the ground beside the foot. */
const SHIELD_REST: BoneTrack[] = [
  absTr(MB.upperArmL, [[0, 0, -22, -82]]),
  absTr(MB.lowerArmL, [[0, 0, -96, -12]]),
];

/** Shield dropped to the ribs — the carry of a man who has been standing a while. */
const SHIELD_MID: BoneTrack[] = [
  absTr(MB.upperArmL, [[0, 0, -44, -78]]),
  absTr(MB.lowerArmL, [[0, 0, -110, -4]]),
];

/** Right hand at the hip, pilum or spear shouldered. The default carry. */
const HAND_CARRY: BoneTrack[] = [
  absTr(MB.upperArmR, [[0, 0, -20, 72]]),
  absTr(MB.lowerArmR, [[0, 0, 97, 33]]),
];

/** Right hand hanging lower and looser, weapon butt near the knee. */
const HAND_SLACK: BoneTrack[] = [
  absTr(MB.upperArmR, [[0, 0, -12, 81]]),
  absTr(MB.lowerArmR, [[0, 0, 86, 24]]),
];

/** Weapon carried up by the shoulder, ready but not aimed. */
const HAND_SHOULDERED: BoneTrack[] = [
  absTr(MB.upperArmR, [[0, 0, -32, 56]]),
  absTr(MB.lowerArmR, [[0, 0, 108, 46]]),
];

/** Sword hand drawn back past the hip, coiled for the thrust. */
const HAND_COCKED: BoneTrack[] = [
  absTr(MB.upperArmR, [[0, 0, -44, 66]]),
  absTr(MB.lowerArmR, [[0, 0, 62, 40]]),
];

/** Full extension, blade level and forward. */
const HAND_THRUST: BoneTrack[] = [
  absTr(MB.upperArmR, [[0, 0, 74, 20]]),
  absTr(MB.lowerArmR, [[0, 0, 87, 3]]),
];

/** Weapon up and behind the head, ready to come down. */
const HAND_OVERHEAD: BoneTrack[] = [
  absTr(MB.upperArmR, [[0, 0, -54, -58]]),
  absTr(MB.lowerArmR, [[0, 0, -77, -17]]),
];

/** Follow-through of a downward blow: arm across the body, low. */
const HAND_FOLLOW: BoneTrack[] = [
  absTr(MB.upperArmR, [[0, 0, 52, 34]]),
  absTr(MB.lowerArmR, [[0, 0, 96, 14]]),
];

const BOW_HOLD: BoneTrack[] = [
  absTr(MB.upperArmL, [[0, 0, -90, -4]]),
  absTr(MB.lowerArmL, [[0, 0, -92, 0]]),
];
const BOW_DRAWN: BoneTrack[] = [
  absTr(MB.upperArmR, [[0, 0, -60, 6]]),
  absTr(MB.lowerArmR, [[0, 0, 128, -27]]),
];
const BOW_LOOSED: BoneTrack[] = [
  absTr(MB.upperArmR, [[0, 0, -74, 2]]),
  absTr(MB.lowerArmR, [[0, 0, 146, -34]]),
];

/**
 * Marching arm swing. The shield arm barely moves — a scutum weighs 7 to 10 kg and nobody
 * swings it — while the free arm swings a few degrees opposed to the legs. Two keys plus a
 * closing key so the loop meets.
 */
const MARCH_ARMS: BoneTrack[] = [
  absTr(MB.upperArmL, [[0, 0, -53, -68], [0.5, 0, -57, -68], [1, 0, -53, -68]]),
  absTr(MB.lowerArmL, [[0, 0, -117, 3]]),
  absTr(MB.upperArmR, [[0, 0, -34, 72], [0.5, 0, -4, 72], [1, 0, -34, 72]]),
  absTr(MB.lowerArmR, [[0, 0, 106, 33], [0.5, 0, 86, 33], [1, 0, 106, 33]]),
];

// ---------------------------------------------------------------------------
// Locomotion
// ---------------------------------------------------------------------------

/**
 * The Roman march.
 *
 * A century marching in step is the single most recognisable thing about a Roman army.
 * Cadence is 120 paces a minute over a 1.55 m stride: Vegetius times the *gradus militaris*
 * at twenty Roman miles in five summer hours, which is exactly this pace. The legs come
 * from the retargeted walk, amplitude-tuned in the baker to that stride.
 */
const march: OverlayDef = {
  name: 'march',
  frames: 30,
  duration: 1.0,
  loop: true,
  tracks: [
    tr(MB.spineLow, [[0, -3, 0, 0]]),
    tr(MB.chest, [[0, -2, 0, 0]]),
    hold(MB.head),
    ...MARCH_ARMS,
    ...FEET_FLAT,
  ],
};

/** A looser walk for troops not keeping step. */
const walkLoose: OverlayDef = {
  name: 'walkLoose',
  frames: 30,
  duration: 1.15,
  loop: true,
  tracks: [
    hold(MB.head),
    absTr(MB.upperArmL, [[0, 0, -34, -76], [0.5, 0, -44, -74], [1, 0, -34, -76]]),
    absTr(MB.lowerArmL, [[0, 0, -108, -4]]),
    absTr(MB.upperArmR, [[0, 0, -30, 74], [0.5, 0, -2, 74], [1, 0, -30, 74]]),
    absTr(MB.lowerArmR, [[0, 0, 102, 30], [0.5, 0, 84, 30], [1, 0, 102, 30]]),
    ...FEET_FLAT,
  ],
};

/** Run: shield up, weapon cocked, torso forward over the hips. */
const run: OverlayDef = {
  name: 'runReady',
  frames: 26,
  duration: 0.71,
  loop: true,
  tracks: [
    tr(MB.spineLow, [[0, -9, 0, 0]]),
    tr(MB.spineUp, [[0, -5, 0, 0]]),
    hold(MB.head),
    ...SHIELD_HIGH,
    absTr(MB.upperArmR, [[0, 0, -50, 62], [0.5, 0, -22, 66], [1, 0, -50, 62]]),
    absTr(MB.lowerArmR, [[0, 0, 74, 42], [0.5, 0, 96, 36], [1, 0, 74, 42]]),
    ...FEET_FLAT,
  ],
};

/**
 * Charge: committed and asymmetric. Deeper lean, longer reach, shield driven ahead of the
 * body, sword hand drawn back past the hip ready to come through on contact. The right
 * shoulder leads, because that is the arm that will strike.
 */
const charge: OverlayDef = {
  name: 'charge',
  frames: 26,
  duration: 0.68,
  loop: true,
  amp: [[MB.thighL, 1.1], [MB.thighR, 1.1]],
  tracks: [
    tr(MB.pelvis, [[0, -4, -6, 0]]),
    tr(MB.spineLow, [[0, -13, 8, 0]]),
    tr(MB.spineUp, [[0, -7, 6, 0]]),
    hold(MB.head),
    ...SHIELD_PUNCH,
    ...HAND_COCKED,
    ...FEET_FLAT,
  ],
};

/**
 * Flight. Arms up and flailing, shield abandoned (the piece mask drops it), torso twisted
 * with the head thrown over the shoulder to see the pursuit. A routing man is not running,
 * he is escaping, and the asymmetry is the whole difference.
 */
const flee: OverlayDef = {
  name: 'flee',
  frames: 26,
  duration: 0.66,
  loop: true,
  amp: [[MB.thighL, 1.06], [MB.thighR, 1.06]],
  tracks: [
    tr(MB.pelvis, [[0, -3, 6, 0]]),
    tr(MB.spineLow, [[0, -8, -14, 4]]),
    tr(MB.chest, [[0, 0, -16, -3]]),
    tr(MB.neck, [[0, -4, -34, 0], [0.5, -2, -42, 0], [1, -4, -34, 0]]),
    absTr(MB.upperArmL, [[0, 0, -33, 49], [0.5, 0, -20, 62], [1, 0, -33, 49]]),
    absTr(MB.lowerArmL, [[0, 0, -58, 44]]),
    absTr(MB.upperArmR, [[0, 0, 33, -49], [0.5, 0, 20, -62], [1, 0, 33, -49]]),
    absTr(MB.lowerArmR, [[0, 0, 58, -44]]),
    ...FEET_FLAT,
  ],
};

// ---------------------------------------------------------------------------
// Idles
// ---------------------------------------------------------------------------

/** At ease: shield grounded, weight on one hip. Breathing comes from the base clip. */
const idleRelaxed: OverlayDef = {
  name: 'idleRelaxedReady',
  frames: 26,
  duration: 3.6,
  loop: true,
  tracks: [hold(MB.head), ...SHIELD_REST, ...HAND_CARRY, ...FEET_FLAT],
};

/** Formed up and watching: shield across the body, weapon ready. */
const idleAlert: OverlayDef = {
  name: 'idleAlertReady',
  frames: 26,
  duration: 3.1,
  loop: true,
  tracks: [hold(MB.head), ...SHIELD_CARRY, ...HAND_CARRY, ...FEET_FLAT],
};

/**
 * Braced. The testudo, and the pose for receiving a charge: knees bent with the weight low
 * over the front foot, shield rim at eye level, shoulder behind the boss so the impact goes
 * into the ground rather than into the arm.
 */
const idleBrace: OverlayDef = {
  name: 'idleBrace',
  frames: 24,
  duration: 3.0,
  loop: true,
  root: [[0, 0, -0.075, 0.02], [0.5, 0, -0.09, 0.02], [1, 0, -0.075, 0.02]],
  tracks: [
    tr(MB.thighL, [[0, -24, 4, 0]]),
    tr(MB.shinL, [[0, 44, 0, 0]]),
    tr(MB.thighR, [[0, -12, -4, 0], [0.5, -11, -4, 0], [1, -12, -4, 0]]),
    tr(MB.shinR, [[0, 28, 0, 0]]),
    tr(MB.pelvis, [[0, 0, 14, 0]]),
    tr(MB.spineLow, [[0, -14, 6, 0]]),
    tr(MB.chest, [[0, -8, 4, 0]]),
    tr(MB.neck, [[0, 6, -8, 0]]),
    ...SHIELD_HIGH,
    ...HAND_COCKED,
    ...FEET_FLAT,
  ],
};

// ---------------------------------------------------------------------------
// Pose variants
// ---------------------------------------------------------------------------
/**
 * Shape variants of the clips a formation actually spends its time in.
 *
 * A per-man phase offset decorrelates *when* a man is in a pose. It cannot stop two
 * hundred men from being in the *same* pose at different moments — scan a rank and every
 * silhouette is still the one silhouette. So each of the standing and walking clips ships
 * in two or three versions and the renderer picks one per man from his stable hash.
 *
 * The differences are chosen to be the ones an eye picks up at twenty metres:
 *
 *   - where his weight is (hips rolled, a lateral sway in the root, one knee soft),
 *   - how high he carries the shield and the weapon,
 *   - whether he is looking straight ahead or over the rim,
 *   - and for locomotion, **stride length** — because the renderer divides ground speed
 *     by the clip's measured stride to get playback rate, a longer-strided variant walks
 *     at a genuinely slower cadence next to a shorter-strided one. That is cadence
 *     variation with the feet still planted, which rate jitter cannot give you.
 */

/**
 * Standing at ease with the weight over one hip and slowly transferring it back.
 *
 * Contrapposto: the loaded hip rides high, the spine counter-curves to bring the
 * shoulders back to level, and the free knee goes soft. The root sways 1.8 cm across the
 * cycle, which is what actually reads as a man shifting his weight rather than a statue.
 */
const idleAlertShift: OverlayDef = {
  name: 'idleAlertShift',
  frames: 26,
  duration: 3.45,
  loop: true,
  root: [[0, 0.014, 0, 0], [0.5, -0.008, -0.004, 0], [1, 0.014, 0, 0]],
  tracks: [
    tr(MB.pelvis, [[0, 0, 0, -6], [0.5, 0, 0, -2], [1, 0, 0, -6]]),
    tr(MB.spineLow, [[0, -2, 0, 5], [0.5, -2, 0, 2], [1, -2, 0, 5]]),
    tr(MB.chest, [[0, 0, 0, 2]]),
    tr(MB.thighL, [[0, -5, 3, 5]]),
    tr(MB.shinL, [[0, 6, 0, -3]]),
    tr(MB.thighR, [[0, 1, -2, 0]]),
    hold(MB.head),
    ...SHIELD_MID,
    ...HAND_SLACK,
    ...FEET_FLAT,
  ],
};

/**
 * Watching the enemy over the shield rim: chest and head turned to his own left, shield
 * hoisted, weapon hand up by the shoulder. The head yaw drifts across the cycle so he is
 * visibly glancing rather than frozen mid-turn.
 */
const idleAlertWatch: OverlayDef = {
  name: 'idleAlertWatch',
  frames: 26,
  duration: 2.9,
  loop: true,
  tracks: [
    tr(MB.pelvis, [[0, 0, 4, 3]]),
    tr(MB.spineLow, [[0, -4, 5, -2]]),
    tr(MB.chest, [[0, -2, 7, 0]]),
    tr(MB.neck, [[0, 2, 12, 0], [0.35, 3, 23, 0], [0.7, 1, 19, 0], [1, 2, 12, 0]]),
    tr(MB.thighR, [[0, -4, -4, -4]]),
    tr(MB.shinR, [[0, 5, 0, 3]]),
    ...SHIELD_HIGH,
    ...HAND_SHOULDERED,
    ...FEET_FLAT,
  ],
};

/** At ease, leaning into the grounded shield with the head down. */
const idleRelaxedLean: OverlayDef = {
  name: 'idleRelaxedLean',
  frames: 26,
  duration: 4.1,
  loop: true,
  root: [[0, -0.012, -0.006, 0], [0.5, 0.006, -0.002, 0], [1, -0.012, -0.006, 0]],
  tracks: [
    tr(MB.pelvis, [[0, 0, -3, 7]]),
    tr(MB.spineLow, [[0, 3, -4, -6]]),
    tr(MB.chest, [[0, 5, -2, -3]]),
    tr(MB.neck, [[0, 9, -10, 0], [0.5, 7, -14, 0], [1, 9, -10, 0]]),
    tr(MB.thighR, [[0, -6, -3, -6]]),
    tr(MB.shinR, [[0, 7, 0, 4]]),
    absTr(MB.upperArmL, [[0, 0, -18, -86]]),
    absTr(MB.lowerArmL, [[0, 0, -88, -18]]),
    ...HAND_SLACK,
    ...FEET_FLAT,
  ],
};

/** Braced lower and tighter, head tucked right behind the rim. */
const idleBraceLow: OverlayDef = {
  name: 'idleBraceLow',
  frames: 24,
  duration: 2.7,
  loop: true,
  root: [[0, 0, -0.1, 0.03], [0.5, 0, -0.115, 0.03], [1, 0, -0.1, 0.03]],
  tracks: [
    tr(MB.thighL, [[0, -31, 5, 0]]),
    tr(MB.shinL, [[0, 55, 0, 0]]),
    tr(MB.thighR, [[0, -17, -5, 0], [0.5, -16, -5, 0], [1, -17, -5, 0]]),
    tr(MB.shinR, [[0, 36, 0, 0]]),
    tr(MB.pelvis, [[0, 0, 18, 0]]),
    tr(MB.spineLow, [[0, -19, 8, 0]]),
    tr(MB.chest, [[0, -11, 5, 0]]),
    tr(MB.neck, [[0, 12, -6, 0]]),
    absTr(MB.upperArmL, [[0, -10, -66, -44]]),
    absTr(MB.lowerArmL, [[0, 0, -126, 8]]),
    ...HAND_COCKED,
    ...FEET_FLAT,
  ],
};

// ---------------------------------------------------------------------------
// The testudo
// ---------------------------------------------------------------------------
/**
 * Five poses that build one roof, and the arithmetic that produced them.
 *
 * A testudo is the only formation in this game whose quality is a *surface* rather than a
 * crowd. `idleBrace` — which is what `formations.ts` asked for and what a testudo used to
 * get — is a man with his shield up in front of him, and two hundred of those is two
 * hundred men holding shields, not a tortoise. What makes it read is that the boards stop
 * belonging to the men: one unbroken armoured shell with legs under it.
 *
 * **Every arm angle below was solved, not authored.** The chain is closed-form and
 * `tools/scratch/testudo-solve.mjs` inverts it: the scutum is skinned rigidly to
 * `lowerArmL` through `socket('march', 0, …)`, an `absTr` track sets that bone's world
 * orientation outright, so `delta = Qboard · R12⁻¹ · Qmarch · restQ⁻¹` puts the board at any
 * chosen attitude *exactly*; the upper arm then places the elbow, and with it the board's
 * centre, on a sphere the shoulder decides. Hand-keying that to a tenth of a degree over
 * five poses is not a thing an eye can do, and the eye is very good at seeing a roof that
 * is nearly level.
 *
 * The reach is what shapes the whole design, and it is worth knowing before touching any
 * number here: the socket sits 0.285 m from the elbow and the upper arm is 0.30 m, so the
 * board's centre can only be within 0.585 m of the shoulder. Crouch a man to a 1.24 m
 * shoulder and his board will not go above 1.70 m — below the crown of a standing man's own
 * helmet. **That is why the interior of this testudo is hunched and not crouched.** The men
 * stand, soften the knees, round the back and pull the head in; only the front rank goes
 * down, because only the front rank has a board in front of it to go down behind.
 *
 * What the five do, at the 0.63 m rank interval the formation asks for:
 *
 * | pose | board covers | closes |
 * |---|---|---|
 * | `testudoFace` | 0.30–1.35 m, upright | the front rank's own frontage, down to the ankles |
 * | `testudoNose` | 1.16–1.81 m, 52° back-slope reaching 0.85 m forward | the band across the front at head height — the gap that makes a testudo look like a crowd wearing hats |
 * | `testudoRoofA` | 1.66–1.81 m, 8° nose-down, 1.06 m of board over a 0.63 m interval | the roof, course one |
 * | `testudoRoofB` | 1.63–1.85 m, 12° nose-down | the roof, course two: alternate ranks take it, so the boards lap rather than butt and the surface has a grain |
 * | `testudoFlank` | 0.55–1.60 m, upright, rim 0.05 m over the man's own helmet | the flanks and the rear, with the man turned outward by the renderer |
 *
 * Each roof board laps the one in front by 0.43 m, which is what leaves no hole when a man
 * is 0.1 m out of his place. The face's top at 1.35 m sits above the nose's bottom at
 * 1.19 m, so no horizontal ray at any height between the grass and the roof reaches a man.
 *
 * Both hands are on the board, and that is only possible because `TESTUDO_STOW_HI` in
 * `kit.ts` takes the pilum out of the right hand for the duration. It has to: a 2.1 m pilum
 * carried at the shoulder goes straight through the roof, and a rank of them is the single
 * loudest thing wrong with the frame this work started from.
 */

/** Interior and flanks: knees soft, back rounded, head tucked. Shoulder at 1.32 m. */
const TESTUDO_HUNCH: BoneTrack[] = [
  tr(MB.thighL, [[0, -15, 4, 0]]),
  tr(MB.shinL, [[0, 26, 0, 0]]),
  tr(MB.thighR, [[0, -9, -4, 0]]),
  tr(MB.shinR, [[0, 18, 0, 0]]),
  tr(MB.pelvis, [[0, 0, 9, 0]]),
  tr(MB.spineLow, [[0, -9, 4, 0]]),
  tr(MB.chest, [[0, -5, 2, 0]]),
  tr(MB.neck, [[0, 14, -5, 0]]),
];
const TESTUDO_HUNCH_ROOT: readonly (readonly [number, number, number, number])[] =
  [[0, 0, -0.045, 0.03]];

/**
 * Front rank: right down behind the board, weight over the front foot. Shoulder at 1.10 m.
 *
 * Deeper than it looks like it should be, and the depth is doing two jobs. The board's
 * centre can only be 0.585 m from the shoulder, so the *only* way to get its lower rim near
 * the ground is to put the shoulder near the ground: at a 1.20 m shoulder the board bottoms
 * out at 0.42 m and the frame is a rank of shields on a rank of bare legs. At 1.10 m it
 * reaches 0.30 m, which is where a scutum's rim actually sits on a man who has set himself.
 * And it takes his head down to 1.33 m, which is 20 mm under the top of his own board.
 */
const TESTUDO_DEEP: BoneTrack[] = [
  tr(MB.thighL, [[0, -56, 7, 0]]),
  tr(MB.shinL, [[0, 98, 0, 0]]),
  tr(MB.thighR, [[0, -34, -7, 0]]),
  tr(MB.shinR, [[0, 70, 0, 0]]),
  tr(MB.pelvis, [[0, 0, 26, 0]]),
  tr(MB.spineLow, [[0, -19, 8, 0]]),
  tr(MB.chest, [[0, -10, 4, 0]]),
  tr(MB.neck, [[0, 18, -7, 0]]),
];
const TESTUDO_DEEP_ROOT: readonly (readonly [number, number, number, number])[] =
  [[0, 0, -0.244, 0.05]];

/**
 * The same two stances, walking.
 *
 * The legs keep the march base's own stride and take a constant flexion on top, with the
 * root dropped to match so the feet stay on the ground: measured, the lowest either foot
 * reaches is 0.069 m against the base march clip's 0.075 m, which is 6 mm and invisible.
 * Authoring the halted stance's thigh angles over a stride instead produces a limp.
 *
 * The shoulder lands within 19 mm of the halted stance for the hunch and 42 mm for the
 * deep crouch, which is the number that matters: the arm tracks are shared between halted
 * and marching, so a shoulder that moved would step the whole roof the instant a cohort
 * came to a stop.
 */
const TESTUDO_HUNCH_MARCH: BoneTrack[] = [
  tr(MB.thighL, [[0, -10, 0, 0]]),
  tr(MB.shinL, [[0, 18, 0, 0]]),
  tr(MB.thighR, [[0, -10, 0, 0]]),
  tr(MB.shinR, [[0, 18, 0, 0]]),
  tr(MB.pelvis, [[0, 0, 9, 0]]),
  tr(MB.spineLow, [[0, -9, 4, 0]]),
  tr(MB.chest, [[0, -5, 2, 0]]),
  tr(MB.neck, [[0, 14, -5, 0]]),
];
const TESTUDO_HUNCH_MARCH_ROOT: readonly (readonly [number, number, number, number])[] =
  [[0, 0, -0.03, 0.03]];

const TESTUDO_DEEP_MARCH: BoneTrack[] = [
  tr(MB.thighL, [[0, -36, 0, 0]]),
  tr(MB.shinL, [[0, 62, 0, 0]]),
  tr(MB.thighR, [[0, -36, 0, 0]]),
  tr(MB.shinR, [[0, 62, 0, 0]]),
  tr(MB.pelvis, [[0, 0, 26, 0]]),
  tr(MB.spineLow, [[0, -19, 8, 0]]),
  tr(MB.chest, [[0, -10, 4, 0]]),
  tr(MB.neck, [[0, 18, -7, 0]]),
];
const TESTUDO_DEEP_MARCH_ROOT: readonly (readonly [number, number, number, number])[] =
  [[0, 0, -0.21, 0.05]];

/**
 * Front rank: the board upright and planted, covering 0.30-1.35 m. Both hands behind it.
 *
 * The right hand's target was pulled 0.14 m back after a critic found knuckles coming
 * through the painted face of the board in four places in one eye-level crop. A hand
 * "on the back of the shield" has to be behind the *back* of the shield, and the scutum
 * is 0.135 m of curve plus 0.022 m of plywood in front of where the arm is.
 */
const ARMS_FACE: BoneTrack[] = [
  absTr(MB.upperArmL, [[0, 150.4, 67.3, 55.3]]),
  absTr(MB.lowerArmL, [[0, 173, -51, -177]]),
  absTr(MB.upperArmR, [[0, 18.1, -11.1, 70.5]]),
  absTr(MB.lowerArmR, [[0, -51.9, -49.8, 151.4]]),
];

/**
 * Second rank: the glacis, 52° back from vertical, covering 1.16-1.81 m.
 *
 * It was 46° and 1.19-1.92 m, and its top edge therefore stood up to 0.26 m **above** the
 * roof line all the way across the front. Seen from any camera behind the formation that is
 * a row of eight to ten hide backs, unlit, standing proud of the shell — a critic measured
 * them at luminance 33-40 against the roof's 94-103 and called them "flat unlit near-black
 * rectangles that shred the silhouette at every range". They were the *front* of the
 * formation seen from behind. Laid back six more degrees and dropped 0.10 m, the glacis now
 * tops out level with the roof's own trailing edge and there is nothing to see over.
 */
const ARMS_NOSE: BoneTrack[] = [
  absTr(MB.upperArmL, [[0, 151.5, 88.7, 3.5]]),
  absTr(MB.lowerArmL, [[0, 128, -51, -177]]),
  absTr(MB.upperArmR, [[0, 91.4, 40.8, -1.4]]),
  absTr(MB.lowerArmR, [[0, -74.5, -42.7, 167.2]]),
];

/**
 * Roof, course one: 8 degrees nose-down, 1.66 m at the leading edge and 1.81 m at the
 * trailing one.
 *
 * **It was dead level and that was worse.** A horizontal board sees the whole sky
 * hemisphere, so it takes about twice the ambient a vertical one does, and a critic scored
 * the roof two to three stops brighter than the *same asset* on the wall — "a flat pink
 * quilt", with no occlusion anywhere the boards lap because coplanar boards cannot shade
 * each other. Eight degrees costs 2% of the fore-and-aft coverage, tips the normal off the
 * zenith, and puts a real 0.15 m step at every lap, so the roof shades itself with shadow
 * rather than needing an AO term it cannot have. It is also the correct way round: the
 * leading edge is the low one, so the front board sheds over the one behind it.
 */
const ARMS_ROOF_A: BoneTrack[] = [
  absTr(MB.upperArmL, [[0, 106.3, 84.6, 10.5]]),
  absTr(MB.lowerArmL, [[0, 98, -51, -177]]),
  absTr(MB.upperArmR, [[0, 90.8, 5, -0.8]]),
  absTr(MB.lowerArmR, [[0, -74.2, -27.7, 166.3]]),
];

/** Roof, course two: 12 degrees and 10 mm higher, so the two courses lap and disagree. */
const ARMS_ROOF_B: BoneTrack[] = [
  absTr(MB.upperArmL, [[0, 99, 85, 5.5]]),
  absTr(MB.lowerArmL, [[0, 102, -51, -177]]),
  absTr(MB.upperArmR, [[0, 90.8, 5, -0.8]]),
  absTr(MB.lowerArmR, [[0, -78.2, -28.7, 169.5]]),
];

/**
 * Flank and rear: the board upright, covering 0.55-1.60 m. **This height is a solved
 * three-way trade and it is worth understanding before moving it.**
 *
 * One 1.06 m board cannot cover a 1.75 m man, so wherever it is put, something is out. Two
 * critics moved it in opposite directions and between them fixed the number:
 *
 *   - **0.72-1.77 m** — the first attempt, chosen so the rim stood on the roof line and
 *     sealed every horizontal sightline. It put 0.72 m of bare leg along both flanks and
 *     the whole of the back; a critic named it in five of nine frames and called it the
 *     single highest-leverage fix in the build.
 *   - **0.42-1.47 m** — the answer to that, and it made the *other* end worse: the hunched
 *     man's head is at 1.55 m, so a rim at 1.47 leaves his helmet, face and both raised
 *     forearms above it. The next critic counted twenty-six in one unbroken band across the
 *     back and scored it as the same fault the legs were.
 *   - **0.55-1.60 m**, here. The rim is 0.05 m *over* the head, so nothing of the man shows
 *     above it, and the gap to the roof's own leading edge at 1.66 m is 0.06 m — closed for
 *     any practical sightline. The leg band is 0.55 m of which the grass takes about 0.2 m.
 *
 * Dropping it also took the "black fins" with it: at 1.60 m the far wall no longer stands
 * above the roof, so the unlit hide backs a tactical camera used to see over the top of the
 * shell are hidden behind the roof they used to stick through.
 */
const ARMS_FLANK: BoneTrack[] = [
  absTr(MB.upperArmL, [[0, -172.1, 88.7, 6.2]]),
  absTr(MB.lowerArmL, [[0, -174, -51, -177]]),
  absTr(MB.upperArmR, [[0, 22.1, 26.6, 67.2]]),
  absTr(MB.lowerArmR, [[0, -52, -46.8, 150.8]]),
];

/**
 * Ten clips: five poses, halted and marching.
 *
 * The halted ones are 20 frames over 3.2 s, which is long and slow on purpose. A testudo
 * is a formation of men *not moving*, and the only motion in it should be the base clip's
 * breathing coming through the spine — the arms are absolute, so the boards do not move
 * with it at all and the roof stays where it was put.
 */
const testudoFace: OverlayDef = {
  name: 'testudoFace',
  frames: 20,
  duration: 3.2,
  loop: true,
  root: TESTUDO_DEEP_ROOT,
  tracks: [...TESTUDO_DEEP, ...ARMS_FACE, ...FEET_FLAT],
};

const testudoNose: OverlayDef = {
  name: 'testudoNose',
  frames: 20,
  duration: 3.4,
  loop: true,
  root: TESTUDO_HUNCH_ROOT,
  tracks: [...TESTUDO_HUNCH, ...ARMS_NOSE, ...FEET_FLAT],
};

const testudoRoofA: OverlayDef = {
  name: 'testudoRoofA',
  frames: 20,
  duration: 3.6,
  loop: true,
  root: TESTUDO_HUNCH_ROOT,
  tracks: [...TESTUDO_HUNCH, ...ARMS_ROOF_A, ...FEET_FLAT],
};

const testudoRoofB: OverlayDef = {
  name: 'testudoRoofB',
  frames: 20,
  duration: 3.3,
  loop: true,
  root: TESTUDO_HUNCH_ROOT,
  tracks: [...TESTUDO_HUNCH, ...ARMS_ROOF_B, ...FEET_FLAT],
};

const testudoFlank: OverlayDef = {
  name: 'testudoFlank',
  frames: 20,
  duration: 3.5,
  loop: true,
  root: TESTUDO_HUNCH_ROOT,
  tracks: [...TESTUDO_HUNCH, ...ARMS_FLANK, ...FEET_FLAT],
};

const testudoFaceMarch: OverlayDef = {
  name: 'testudoFaceMarch',
  frames: 30,
  duration: 1.0,
  loop: true,
  root: TESTUDO_DEEP_MARCH_ROOT,
  tracks: [...TESTUDO_DEEP_MARCH, ...ARMS_FACE, ...FEET_FLAT],
};

const testudoNoseMarch: OverlayDef = {
  name: 'testudoNoseMarch',
  frames: 30,
  duration: 1.0,
  loop: true,
  root: TESTUDO_HUNCH_MARCH_ROOT,
  tracks: [...TESTUDO_HUNCH_MARCH, ...ARMS_NOSE, ...FEET_FLAT],
};

const testudoRoofAMarch: OverlayDef = {
  name: 'testudoRoofAMarch',
  frames: 30,
  duration: 1.0,
  loop: true,
  root: TESTUDO_HUNCH_MARCH_ROOT,
  tracks: [...TESTUDO_HUNCH_MARCH, ...ARMS_ROOF_A, ...FEET_FLAT],
};

const testudoRoofBMarch: OverlayDef = {
  name: 'testudoRoofBMarch',
  frames: 30,
  duration: 1.0,
  loop: true,
  root: TESTUDO_HUNCH_MARCH_ROOT,
  tracks: [...TESTUDO_HUNCH_MARCH, ...ARMS_ROOF_B, ...FEET_FLAT],
};

const testudoFlankMarch: OverlayDef = {
  name: 'testudoFlankMarch',
  frames: 30,
  duration: 1.0,
  loop: true,
  root: TESTUDO_HUNCH_MARCH_ROOT,
  tracks: [...TESTUDO_HUNCH_MARCH, ...ARMS_FLANK, ...FEET_FLAT],
};

/**
 * A shorter, quicker pace. Stride amplitude 0.92 of the base, so at the same ground speed
 * this man takes about 9% more steps a minute than his neighbour on `march`.
 */
const marchShort: OverlayDef = {
  name: 'marchShort',
  frames: 30,
  duration: 0.96,
  loop: true,
  amp: [[MB.thighL, 0.92], [MB.thighR, 0.92], [MB.shinL, 0.94], [MB.shinR, 0.94]],
  tracks: [
    tr(MB.spineLow, [[0, -1, 0, 2]]),
    tr(MB.chest, [[0, -1, 0, -2]]),
    hold(MB.head),
    absTr(MB.upperArmL, [[0, 0, -46, -75], [0.5, 0, -49, -74], [1, 0, -46, -75]]),
    absTr(MB.lowerArmL, [[0, 0, -112, -2]]),
    absTr(MB.upperArmR, [[0, 0, -28, 76], [0.5, 0, -10, 76], [1, 0, -28, 76]]),
    absTr(MB.lowerArmR, [[0, 0, 98, 30], [0.5, 0, 84, 30], [1, 0, 98, 30]]),
    ...FEET_FLAT,
  ],
};

/** A long, heavy pace: stride amplitude 1.09, shield up, more weight forward. */
const marchLong: OverlayDef = {
  name: 'marchLong',
  frames: 30,
  duration: 1.06,
  loop: true,
  amp: [[MB.thighL, 1.09], [MB.thighR, 1.09], [MB.shinL, 1.05], [MB.shinR, 1.05]],
  tracks: [
    tr(MB.spineLow, [[0, -5, 0, -2]]),
    tr(MB.chest, [[0, -3, 0, 2]]),
    tr(MB.neck, [[0, -2, -6, 0]]),
    absTr(MB.upperArmL, [[0, -6, -60, -60], [0.5, -6, -63, -60], [1, -6, -60, -60]]),
    absTr(MB.lowerArmL, [[0, 0, -120, 6]]),
    absTr(MB.upperArmR, [[0, 0, -40, 66], [0.5, 0, -6, 68], [1, 0, -40, 66]]),
    absTr(MB.lowerArmR, [[0, 0, 110, 38], [0.5, 0, 88, 34], [1, 0, 110, 38]]),
    ...FEET_FLAT,
  ],
};

/** A walk with more shoulder roll and a shorter step — a man not keeping anyone's time. */
const walkLooseRoll: OverlayDef = {
  name: 'walkLooseRoll',
  frames: 30,
  duration: 1.08,
  loop: true,
  amp: [[MB.thighL, 0.93], [MB.thighR, 0.93]],
  tracks: [
    tr(MB.pelvis, [[0, 0, 5, 0], [0.5, 0, -5, 0], [1, 0, 5, 0]]),
    tr(MB.spineLow, [[0, 0, -4, 3], [0.5, 0, 4, -3], [1, 0, -4, 3]]),
    hold(MB.head),
    absTr(MB.upperArmL, [[0, 0, -28, -82], [0.5, 0, -40, -78], [1, 0, -28, -82]]),
    absTr(MB.lowerArmL, [[0, 0, -102, -8]]),
    absTr(MB.upperArmR, [[0, 0, -24, 78], [0.5, 0, 4, 78], [1, 0, -24, 78]]),
    absTr(MB.lowerArmR, [[0, 0, 96, 26], [0.5, 0, 78, 26], [1, 0, 96, 26]]),
    ...FEET_FLAT,
  ],
};

/** Running with the shield low across the hips instead of up under the chin. */
const runLow: OverlayDef = {
  name: 'runLow',
  frames: 26,
  duration: 0.75,
  loop: true,
  amp: [[MB.thighL, 0.94], [MB.thighR, 0.94]],
  tracks: [
    tr(MB.spineLow, [[0, -7, 0, 3]]),
    tr(MB.spineUp, [[0, -4, 0, -3]]),
    hold(MB.head),
    ...SHIELD_MID,
    absTr(MB.upperArmR, [[0, 0, -42, 70], [0.5, 0, -14, 74], [1, 0, -42, 70]]),
    absTr(MB.lowerArmR, [[0, 0, 80, 38], [0.5, 0, 100, 32], [1, 0, 80, 38]]),
    ...FEET_FLAT,
  ],
};

/**
 * A long-legged run: stride amplitude 1.13, torso further over the hips.
 *
 * The third bucket of `Clip.Run` used to be `runReady` again, so two thirds of a running
 * cohort shared one silhouette *and* one cadence — and cadence is what makes a rank read as
 * a machine, because the renderer sets playback from ground speed over measured stride and
 * two men on the same clip get the same number. A 13% longer stride is 13% fewer steps a
 * minute at the same speed, with the foot still planted where the ground is.
 */
const runLong: OverlayDef = {
  name: 'runLong',
  frames: 26,
  duration: 0.79,
  loop: true,
  amp: [[MB.thighL, 1.13], [MB.thighR, 1.13], [MB.shinL, 1.06], [MB.shinR, 1.06]],
  tracks: [
    tr(MB.spineLow, [[0, -11, 0, -2]]),
    tr(MB.spineUp, [[0, -6, 0, 2]]),
    tr(MB.neck, [[0, -3, 4, 0]]),
    ...SHIELD_CARRY,
    absTr(MB.upperArmR, [[0, 0, -56, 56], [0.5, 0, -26, 60], [1, 0, -56, 56]]),
    absTr(MB.lowerArmR, [[0, 0, 70, 46], [0.5, 0, 92, 40], [1, 0, 70, 46]]),
    ...FEET_FLAT,
  ],
};

/** Charging with the weapon already overhead rather than cocked at the hip. */
const chargeHigh: OverlayDef = {
  name: 'chargeHigh',
  frames: 26,
  duration: 0.72,
  loop: true,
  amp: [[MB.thighL, 1.14], [MB.thighR, 1.14]],
  tracks: [
    tr(MB.pelvis, [[0, -5, -4, 0]]),
    tr(MB.spineLow, [[0, -11, 10, 0]]),
    tr(MB.spineUp, [[0, -6, 7, 0]]),
    hold(MB.head),
    ...SHIELD_HIGH,
    absTr(MB.upperArmR, [[0, 0, -50, -46], [0.5, 0, -58, -54], [1, 0, -50, -46]]),
    absTr(MB.lowerArmR, [[0, 0, -70, -14]]),
    ...FEET_FLAT,
  ],
};

/** Charging low and short: knees under him, shield up, weapon already coming across. */
const chargeLow: OverlayDef = {
  name: 'chargeLow',
  frames: 26,
  duration: 0.64,
  loop: true,
  amp: [[MB.thighL, 0.94], [MB.thighR, 0.94]],
  root: [[0, 0, -0.05, 0], [0.5, 0, -0.065, 0], [1, 0, -0.05, 0]],
  tracks: [
    tr(MB.pelvis, [[0, -2, -8, 0]]),
    tr(MB.spineLow, [[0, -16, 6, 0]]),
    tr(MB.spineUp, [[0, -9, 4, 0]]),
    tr(MB.neck, [[0, 8, -4, 0]]),
    ...SHIELD_HIGH,
    absTr(MB.upperArmR, [[0, 0, -34, 48], [0.5, 0, -20, 40], [1, 0, -34, 48]]),
    absTr(MB.lowerArmR, [[0, 0, 74, 30], [0.5, 0, 66, 22], [1, 0, 74, 30]]),
    ...FEET_FLAT,
  ],
};

/** Fleeing with the head thrown over the other shoulder. */
const fleeOther: OverlayDef = {
  name: 'fleeOther',
  frames: 26,
  duration: 0.7,
  loop: true,
  amp: [[MB.thighL, 1.02], [MB.thighR, 1.02]],
  tracks: [
    tr(MB.pelvis, [[0, -3, -6, 0]]),
    tr(MB.spineLow, [[0, -8, 12, -4]]),
    tr(MB.chest, [[0, 0, 15, 3]]),
    tr(MB.neck, [[0, -4, 30, 0], [0.5, -2, 38, 0], [1, -4, 30, 0]]),
    absTr(MB.upperArmL, [[0, 0, -20, 62], [0.5, 0, -33, 49], [1, 0, -20, 62]]),
    absTr(MB.lowerArmL, [[0, 0, -50, 50]]),
    absTr(MB.upperArmR, [[0, 0, 20, -62], [0.5, 0, 33, -49], [1, 0, 20, -62]]),
    absTr(MB.lowerArmR, [[0, 0, 50, -50]]),
    ...FEET_FLAT,
  ],
};

/** Outright panic: short choppy steps, both arms up, no thought of the pursuit behind. */
const fleePanic: OverlayDef = {
  name: 'fleePanic',
  frames: 26,
  duration: 0.61,
  loop: true,
  amp: [[MB.thighL, 0.9], [MB.thighR, 0.9], [MB.shinL, 0.95], [MB.shinR, 0.95]],
  tracks: [
    tr(MB.pelvis, [[0, -2, 0, 0]]),
    tr(MB.spineLow, [[0, -12, 4, 0], [0.5, -14, -4, 0], [1, -12, 4, 0]]),
    tr(MB.chest, [[0, -4, 3, 0]]),
    tr(MB.neck, [[0, -10, 6, 0], [0.5, -12, -6, 0], [1, -10, 6, 0]]),
    absTr(MB.upperArmL, [[0, 0, -12, 78], [0.5, 0, -8, 90], [1, 0, -12, 78]]),
    absTr(MB.lowerArmL, [[0, 0, -26, 74]]),
    absTr(MB.upperArmR, [[0, 0, 12, -78], [0.5, 0, 8, -90], [1, 0, 12, -78]]),
    absTr(MB.lowerArmR, [[0, 0, 26, -74]]),
    ...FEET_FLAT,
  ],
};

// ---------------------------------------------------------------------------
// Melee
// ---------------------------------------------------------------------------

/**
 * The gladius thrust — the blow the legions actually killed with.
 *
 * Not a fencing lunge: the shield stays up and the point comes out low under its rim,
 * driven by the hips and a short step, with the elbow finishing barely past the ribs.
 * Beats: guard, loaded at 0.30, impact at 0.46, point held, recover.
 */
const attackThrust: OverlayDef = {
  name: 'attackThrust',
  frames: 26,
  duration: 1.0,
  loop: true,
  hitFrame: 0.46,
  root: [
    [0, 0, -0.03, 0], [0.3, 0, -0.05, -0.05], [0.46, 0, -0.04, 0.14],
    [0.62, 0, -0.04, 0.12], [1, 0, -0.03, 0],
  ],
  tracks: [
    tr(MB.pelvis, [
      [0, 0, 12, 0], [0.3, 0, 26, 0], [0.46, 0, -12, 0], [0.62, 0, -10, 0], [1, 0, 12, 0],
    ]),
    tr(MB.spineLow, [
      [0, -8, 8, 0], [0.3, -4, 20, 0], [0.46, -14, -14, 0], [0.62, -12, -12, 0], [1, -8, 8, 0],
    ]),
    tr(MB.chest, [[0, -4, 6, 0], [0.3, -2, 16, 0], [0.46, -8, -12, 0], [1, -4, 6, 0]]),
    hold(MB.head),
    // The shield holds station across the body throughout. That is the point of a scutum.
    absTr(MB.upperArmL, [[0, 0, -55, -68], [0.46, 0, -62, -62], [1, 0, -55, -68]]),
    absTr(MB.lowerArmL, [[0, 0, -117, 3], [0.46, 0, -112, 6], [1, 0, -117, 3]]),
    absTr(MB.upperArmR, [
      [0, 0, -20, 72], [0.3, 0, -44, 66], [0.46, 0, 74, 20], [0.62, 0, 70, 22], [1, 0, -20, 72],
    ]),
    absTr(MB.lowerArmR, [
      [0, 0, 97, 33], [0.3, 0, 62, 40], [0.46, 0, 87, 3], [0.62, 0, 86, 5], [1, 0, 97, 33],
    ]),
    tr(MB.thighL, [[0, -10, 0, 0], [0.3, -4, 0, 0], [0.46, -30, 0, 0], [1, -10, 0, 0]]),
    tr(MB.shinL, [[0, 18, 0, 0], [0.3, 10, 0, 0], [0.46, 44, 0, 0], [1, 18, 0, 0]]),
    tr(MB.thighR, [[0, 6, 0, 0], [0.3, 14, 0, 0], [0.46, 20, 0, 0], [1, 6, 0, 0]]),
    tr(MB.shinR, [[0, 12, 0, 0], [0.46, 26, 0, 0], [1, 12, 0, 0]]),
    ...FEET_FLAT,
  ],
};

/**
 * The same thrust delivered over the rim at throat height, off a shorter step.
 *
 * Every beat time is identical to `attackThrust` — guard, load at 0.30, impact at 0.46 —
 * because the combat system times the blow against `hitFrame` and a variant that landed
 * at a different moment would put damage and weapon out of agreement.
 */
const attackThrustHigh: OverlayDef = {
  name: 'attackThrustHigh',
  frames: 26,
  duration: 1.0,
  loop: true,
  hitFrame: 0.46,
  root: [
    [0, 0, -0.02, 0], [0.3, 0, -0.035, -0.03], [0.46, 0, -0.03, 0.1],
    [0.62, 0, -0.03, 0.09], [1, 0, -0.02, 0],
  ],
  tracks: [
    tr(MB.pelvis, [
      [0, 0, 10, 0], [0.3, 0, 22, 0], [0.46, 0, -14, 0], [0.62, 0, -11, 0], [1, 0, 10, 0],
    ]),
    tr(MB.spineLow, [
      [0, -4, 7, -2], [0.3, 0, 18, -3], [0.46, -8, -16, 3], [0.62, -7, -13, 2], [1, -4, 7, -2],
    ]),
    tr(MB.chest, [[0, -2, 5, 0], [0.3, 0, 14, 0], [0.46, -4, -13, 0], [1, -2, 5, 0]]),
    hold(MB.head),
    absTr(MB.upperArmL, [[0, -8, -60, -56], [0.46, -10, -68, -50], [1, -8, -60, -56]]),
    absTr(MB.lowerArmL, [[0, 0, -122, 6], [0.46, 0, -118, 9], [1, 0, -122, 6]]),
    absTr(MB.upperArmR, [
      [0, 0, -14, 66], [0.3, 0, -36, 58], [0.46, 0, 66, -8], [0.62, 0, 62, -6], [1, 0, -14, 66],
    ]),
    absTr(MB.lowerArmR, [
      [0, 0, 92, 38], [0.3, 0, 58, 44], [0.46, 0, 80, -6], [0.62, 0, 79, -4], [1, 0, 92, 38],
    ]),
    tr(MB.thighL, [[0, -6, 0, 0], [0.3, -2, 0, 0], [0.46, -20, 0, 0], [1, -6, 0, 0]]),
    tr(MB.shinL, [[0, 12, 0, 0], [0.3, 6, 0, 0], [0.46, 30, 0, 0], [1, 12, 0, 0]]),
    tr(MB.thighR, [[0, 8, 0, 0], [0.3, 15, 0, 0], [0.46, 16, 0, 0], [1, 8, 0, 0]]),
    tr(MB.shinR, [[0, 15, 0, 0], [0.46, 22, 0, 0], [1, 15, 0, 0]]),
    ...FEET_FLAT,
  ],
};

/**
 * Overhead chop — the Germanic axe and the cavalry spatha. Full commitment: the weapon goes
 * up past vertical, the whole trunk uncoils, and the follow-through carries the shoulder
 * down and across.
 */
const attackOverhead: OverlayDef = {
  name: 'attackOverhead',
  frames: 26,
  duration: 1.0,
  loop: true,
  hitFrame: 0.44,
  root: [[0, 0, -0.02, 0], [0.28, 0, 0.03, -0.04], [0.44, 0, -0.07, 0.12], [1, 0, -0.02, 0]],
  tracks: [
    tr(MB.pelvis, [[0, 0, 8, 0], [0.28, 0, 22, 0], [0.44, 0, -16, 0], [1, 0, 8, 0]]),
    tr(MB.spineLow, [
      [0, -6, 6, 0], [0.28, 10, 18, -6], [0.44, -26, -14, 6], [0.7, -18, -8, 4], [1, -6, 6, 0],
    ]),
    tr(MB.chest, [[0, -4, 4, 0], [0.28, 8, 14, -4], [0.44, -18, -10, 4], [1, -4, 4, 0]]),
    hold(MB.head),
    absTr(MB.upperArmL, [[0, 0, -52, -66], [0.28, 0, -40, -74], [0.44, 0, -66, -56], [1, 0, -52, -66]]),
    absTr(MB.lowerArmL, [[0, 0, -114, 2]]),
    absTr(MB.upperArmR, [
      [0, 0, -26, 60], [0.28, 0, -54, -58], [0.44, 0, 52, 34], [0.68, 0, 46, 40], [1, 0, -26, 60],
    ]),
    absTr(MB.lowerArmR, [
      [0, 0, 88, 30], [0.28, 0, -77, -17], [0.44, 0, 96, 14], [1, 0, 88, 30],
    ]),
    tr(MB.thighL, [[0, -8, 0, 0], [0.44, -26, 0, 0], [1, -8, 0, 0]]),
    tr(MB.shinL, [[0, 14, 0, 0], [0.44, 40, 0, 0], [1, 14, 0, 0]]),
    tr(MB.thighR, [[0, 6, 0, 0], [0.44, 18, 0, 0], [1, 6, 0, 0]]),
    ...FEET_FLAT,
  ],
};

/**
 * The chop brought down diagonally from the far shoulder instead of straight overhead —
 * how a man who has a shield on his left and an enemy on his right actually swings. Beats
 * match `attackOverhead` exactly.
 */
const attackOverheadCross: OverlayDef = {
  name: 'attackOverheadCross',
  frames: 26,
  duration: 1.0,
  loop: true,
  hitFrame: 0.44,
  root: [[0, 0, -0.02, 0], [0.28, 0.03, 0.02, -0.03], [0.44, -0.02, -0.06, 0.11], [1, 0, -0.02, 0]],
  tracks: [
    tr(MB.pelvis, [[0, 0, 12, 0], [0.28, 0, 26, 0], [0.44, 0, -20, 0], [1, 0, 12, 0]]),
    tr(MB.spineLow, [
      [0, -6, 9, 4], [0.28, 8, 22, 12], [0.44, -22, -18, -8], [0.7, -16, -10, -5], [1, -6, 9, 4],
    ]),
    tr(MB.chest, [[0, -3, 6, 3], [0.28, 6, 17, 8], [0.44, -15, -13, -6], [1, -3, 6, 3]]),
    hold(MB.head),
    absTr(MB.upperArmL, [[0, 0, -48, -70], [0.28, 0, -36, -78], [0.44, 0, -62, -60], [1, 0, -48, -70]]),
    absTr(MB.lowerArmL, [[0, 0, -110, 0]]),
    absTr(MB.upperArmR, [
      [0, 0, -22, 56], [0.28, 0, -34, -72], [0.44, 0, 62, 20], [0.68, 0, 56, 26], [1, 0, -22, 56],
    ]),
    absTr(MB.lowerArmR, [
      [0, 0, 84, 34], [0.28, 0, -58, -34], [0.44, 0, 104, 4], [1, 0, 84, 34],
    ]),
    tr(MB.thighL, [[0, -10, 0, 0], [0.44, -22, 0, 0], [1, -10, 0, 0]]),
    tr(MB.shinL, [[0, 16, 0, 0], [0.44, 34, 0, 0], [1, 16, 0, 0]]),
    tr(MB.thighR, [[0, 4, 0, 0], [0.44, 21, 0, 0], [1, 4, 0, 0]]),
    ...FEET_FLAT,
  ],
};

/** Horizontal cut across the body, shield pinned. */
const attackSlash: OverlayDef = {
  name: 'attackSlash',
  frames: 24,
  duration: 1.0,
  loop: true,
  hitFrame: 0.42,
  tracks: [
    tr(MB.pelvis, [[0, 0, 18, 0], [0.42, 0, -20, 0], [1, 0, 18, 0]]),
    tr(MB.spineLow, [[0, -6, 14, 0], [0.42, -10, -16, 0], [1, -6, 14, 0]]),
    hold(MB.head),
    ...SHIELD_CARRY,
    absTr(MB.upperArmR, [
      [0, 0, -56, 40], [0.24, 0, -70, 22], [0.42, 0, 40, 40], [0.62, 0, 66, 44], [1, 0, -56, 40],
    ]),
    absTr(MB.lowerArmR, [
      [0, 0, 46, 46], [0.24, 0, 18, 44], [0.42, 0, 92, 22], [1, 0, 46, 46],
    ]),
    tr(MB.thighL, [[0, -8, 0, 0], [0.42, -22, 0, 0], [1, -8, 0, 0]]),
    tr(MB.shinL, [[0, 14, 0, 0], [0.42, 34, 0, 0], [1, 14, 0, 0]]),
    ...FEET_FLAT,
  ],
};

/**
 * Shield bash. The boss of a scutum is an iron dome designed to break faces; the blow is a
 * step and a shoulder drive, not an arm swing, so the hips and the front leg carry it.
 */
const shieldBash: OverlayDef = {
  name: 'shieldBash',
  frames: 22,
  duration: 0.86,
  loop: true,
  hitFrame: 0.4,
  root: [[0, 0, -0.03, -0.04], [0.24, 0, -0.05, -0.1], [0.4, 0, -0.03, 0.2], [1, 0, -0.03, -0.04]],
  tracks: [
    tr(MB.pelvis, [[0, 0, -18, 0], [0.24, 0, -30, 0], [0.4, 0, 16, 0], [1, 0, -18, 0]]),
    tr(MB.spineLow, [[0, -8, -14, 0], [0.24, -2, -26, 0], [0.4, -18, 18, 0], [1, -8, -14, 0]]),
    tr(MB.chest, [[0, -4, -10, 0], [0.4, -10, 14, 0], [1, -4, -10, 0]]),
    hold(MB.head),
    absTr(MB.upperArmL, [
      [0, 0, -48, -70], [0.24, 0, -38, -74], [0.4, 0, -78, -58], [1, 0, -48, -70],
    ]),
    absTr(MB.lowerArmL, [[0, 0, -122, 0], [0.4, 0, -100, 2], [1, 0, -122, 0]]),
    ...HAND_COCKED,
    tr(MB.thighL, [[0, -6, 0, 0], [0.4, -32, 0, 0], [1, -6, 0, 0]]),
    tr(MB.shinL, [[0, 12, 0, 0], [0.4, 48, 0, 0], [1, 12, 0, 0]]),
    tr(MB.thighR, [[0, 8, 0, 0], [0.4, 24, 0, 0], [1, 8, 0, 0]]),
    ...FEET_FLAT,
  ],
};

/** Shield up into the blow, head tucked behind the rim, weight settling back. */
const block: OverlayDef = {
  name: 'block',
  frames: 20,
  duration: 0.8,
  loop: true,
  root: [[0, 0, -0.05, -0.03], [0.25, 0, -0.09, -0.07], [1, 0, -0.05, -0.03]],
  tracks: [
    tr(MB.pelvis, [[0, 0, 16, 0]]),
    tr(MB.spineLow, [[0, -16, 10, 0], [0.25, -22, 12, 0], [1, -16, 10, 0]]),
    tr(MB.chest, [[0, -10, 6, 0]]),
    tr(MB.neck, [[0, 12, -10, 0]]),
    absTr(MB.upperArmL, [[0, -12, -66, -42], [0.25, -16, -70, -36], [1, -12, -66, -42]]),
    absTr(MB.lowerArmL, [[0, 0, -126, 8]]),
    ...HAND_COCKED,
    tr(MB.thighL, [[0, -20, 0, 0]]),
    tr(MB.shinL, [[0, 36, 0, 0]]),
    tr(MB.thighR, [[0, -10, 0, 0]]),
    tr(MB.shinR, [[0, 24, 0, 0]]),
    ...FEET_FLAT,
  ],
};

/** Parry: the blade sweeps across to turn a strike aside, weight rocking back. */
const parry: OverlayDef = {
  name: 'parry',
  frames: 20,
  duration: 0.72,
  loop: true,
  root: [[0, 0, -0.03, 0], [0.3, 0, -0.04, -0.06], [1, 0, -0.03, 0]],
  tracks: [
    tr(MB.pelvis, [[0, 0, 10, 0], [0.3, 0, -8, 0], [1, 0, 10, 0]]),
    tr(MB.spineLow, [[0, -8, 8, 0], [0.3, -6, -12, 0], [1, -8, 8, 0]]),
    hold(MB.head),
    ...SHIELD_CARRY,
    absTr(MB.upperArmR, [[0, 0, -20, 72], [0.3, 0, 34, -6], [0.55, 0, 28, 0], [1, 0, -20, 72]]),
    absTr(MB.lowerArmR, [[0, 0, 97, 33], [0.3, 0, 118, -10], [1, 0, 97, 33]]),
    ...FEET_FLAT,
  ],
};

/** Knocked off balance: the base clip's hit reaction with the kit still where it belongs. */
const stagger: OverlayDef = {
  name: 'stagger',
  frames: 18,
  duration: 0.62,
  loop: false,
  hitFrame: 0.18,
  tracks: [
    absTr(MB.upperArmL, [[0, 0, -55, -68], [0.3, 0, -34, -78], [1, 0, -50, -70]]),
    absTr(MB.lowerArmL, [[0, 0, -117, 3], [0.3, 0, -96, -8], [1, 0, -112, 0]]),
    absTr(MB.upperArmR, [[0, 0, -20, 72], [0.3, 0, -6, 84], [1, 0, -18, 74]]),
    absTr(MB.lowerArmR, [[0, 0, 97, 33], [0.3, 0, 78, 46], [1, 0, 94, 36]]),
    ...FEET_FLAT,
  ],
};

// ---------------------------------------------------------------------------
// Missiles
// ---------------------------------------------------------------------------

/**
 * Pilum throw.
 *
 * The sequence runs from the ground up: cross-step onto the left foot, hips open, trunk
 * rotates, and only then does the arm come through. That lag is what makes a throw look
 * like a throw. A pilum weighs about 2 kg and was thrown 25 to 30 m, so the whole body is
 * in it. Release at 0.52, as the hand passes the head.
 */
const throwPilum: OverlayDef = {
  name: 'throwPilum',
  frames: 30,
  duration: 1.15,
  loop: true,
  hitFrame: 0.52,
  root: [
    [0, 0, -0.02, 0], [0.34, 0.03, -0.05, -0.12], [0.52, -0.02, -0.02, 0.14],
    [0.72, 0, -0.03, 0.1], [1, 0, -0.02, 0],
  ],
  tracks: [
    tr(MB.pelvis, [
      [0, 0, 6, 0], [0.34, 0, 42, 0], [0.52, 0, -22, 0], [0.72, 0, -18, 0], [1, 0, 6, 0],
    ]),
    tr(MB.spineLow, [
      [0, -4, 6, 0], [0.34, 6, 40, -8], [0.52, -18, -26, 8], [0.72, -14, -20, 6], [1, -4, 6, 0],
    ]),
    tr(MB.chest, [[0, -2, 4, 0], [0.34, 4, 34, -6], [0.52, -12, -24, 6], [1, -2, 4, 0]]),
    tr(MB.neck, [[0, 0, -4, 0], [0.34, -4, -26, 0], [0.52, -6, 12, 0], [1, 0, -4, 0]]),
    // Left arm points out at the target for aim, then drops as the right comes through.
    absTr(MB.upperArmL, [
      [0, 0, -55, -60], [0.34, 0, -84, -30], [0.52, 0, -40, -72], [1, 0, -55, -60],
    ]),
    absTr(MB.lowerArmL, [[0, 0, -110, 0], [0.34, 0, -90, -6], [1, 0, -110, 0]]),
    // Right arm: cocked back behind the shoulder with the elbow high, then whipped through.
    absTr(MB.upperArmR, [
      [0, 0, -34, 56], [0.34, 0, -96, -34], [0.52, 0, 22, -44], [0.72, 0, 56, 18],
      [1, 0, -34, 56],
    ]),
    absTr(MB.lowerArmR, [
      [0, 0, 92, 34], [0.34, 0, -46, -30], [0.52, 0, 74, -10], [0.72, 0, 92, 18], [1, 0, 92, 34],
    ]),
    tr(MB.thighL, [[0, -8, 0, 0], [0.34, -4, 8, 0], [0.52, -34, 4, 0], [1, -8, 0, 0]]),
    tr(MB.shinL, [[0, 14, 0, 0], [0.52, 46, 0, 0], [1, 14, 0, 0]]),
    tr(MB.thighR, [[0, 6, 0, 0], [0.34, -18, -6, 0], [0.52, 26, 0, 0], [1, 6, 0, 0]]),
    tr(MB.shinR, [[0, 10, 0, 0], [0.34, 34, 0, 0], [0.52, 20, 0, 0], [1, 10, 0, 0]]),
    ...FEET_FLAT,
  ],
};

/**
 * Archery form for a composite recurve: side-on stance, bow arm locked out at shoulder
 * height, draw hand to the corner of the mouth. Sagittarii drew 60 to 80 lb, so the back
 * does the work and the elbow finishes behind the line of the arrow.
 */
const drawBow: OverlayDef = {
  name: 'drawBow',
  frames: 26,
  duration: 1.1,
  loop: true,
  tracks: [
    tr(MB.pelvis, [[0, 0, 48, 0]]),
    tr(MB.spineLow, [[0, -2, -12, 0], [0.6, -4, -16, 0], [1, -2, -12, 0]]),
    tr(MB.chest, [[0, 0, -14, 0], [0.6, 2, -20, 0], [1, 0, -14, 0]]),
    tr(MB.neck, [[0, -2, -16, 0]]),
    ...BOW_HOLD,
    absTr(MB.upperArmR, [[0, 0, -44, 22], [0.35, 0, -56, 10], [0.6, 0, -60, 6], [1, 0, -44, 22]]),
    absTr(MB.lowerArmR, [[0, 0, 96, 6], [0.35, 0, 118, -18], [0.6, 0, 128, -27], [1, 0, 96, 6]]),
    tr(MB.thighL, [[0, -6, 14, 0]]),
    tr(MB.thighR, [[0, 4, -14, 0]]),
    ...FEET_FLAT,
  ],
};

const releaseBow: OverlayDef = {
  name: 'releaseBow',
  frames: 22,
  duration: 0.9,
  loop: true,
  hitFrame: 0.34,
  tracks: [
    tr(MB.pelvis, [[0, 0, 48, 0]]),
    tr(MB.spineLow, [[0, -4, -16, 0], [0.34, -2, -10, 0], [1, -4, -16, 0]]),
    tr(MB.chest, [[0, 2, -20, 0], [0.34, 0, -12, 0], [1, 2, -20, 0]]),
    tr(MB.neck, [[0, -2, -16, 0]]),
    ...BOW_HOLD,
    absTr(MB.upperArmR, [
      [0, 0, -60, 6], [0.34, 0, -74, 2], [0.6, 0, -70, 4], [1, 0, -60, 6],
    ]),
    absTr(MB.lowerArmR, [[0, 0, 128, -27], [0.34, 0, 146, -34], [1, 0, 128, -27]]),
    tr(MB.thighL, [[0, -6, 14, 0]]),
    tr(MB.thighR, [[0, 4, -14, 0]]),
    ...FEET_FLAT,
  ],
};

// ---------------------------------------------------------------------------
// Deaths
// ---------------------------------------------------------------------------

/**
 * Falls collapse rather than rotate: the knees go first, the spine folds, and only then
 * does the body reach the ground. Each variant ends flat, because the corpse holds the
 * last frame for the rest of the battle.
 */
const deathBack: OverlayDef = {
  name: 'deathBack',
  frames: 30,
  duration: 1.15,
  loop: false,
  tracks: [
    // Arms let go of everything on the way down.
    absTr(MB.upperArmL, [[0, 0, -55, -68], [0.4, 0, -20, -96], [1, 0, 14, -104]]),
    absTr(MB.lowerArmL, [[0, 0, -117, 3], [0.4, 0, -80, -20], [1, 0, -30, -40]]),
    absTr(MB.upperArmR, [[0, 0, -20, 72], [0.4, 0, 10, 98], [1, 0, -14, 106]]),
    absTr(MB.lowerArmR, [[0, 0, 97, 33], [0.4, 0, 70, 22], [1, 0, 26, 44]]),
  ],
};

const deathForward: OverlayDef = {
  name: 'deathForward',
  frames: 28,
  duration: 1.2,
  loop: false,
  root: [
    [0, 0, 0, 0], [0.22, 0, -0.16, 0.06], [0.5, 0, -0.5, 0.3],
    [0.78, 0, -0.78, 0.5], [1, 0, -0.82, 0.55],
  ],
  tracks: [
    tr(MB.thighL, [[0, 0, 0, 0], [0.22, -32, 0, 0], [0.5, -6, 6, 0], [1, 14, 8, 0]]),
    tr(MB.shinL, [[0, 0, 0, 0], [0.22, 58, 0, 0], [0.5, 30, 0, 0], [1, 4, 0, 0]]),
    tr(MB.thighR, [[0, 0, 0, 0], [0.22, -26, 0, 0], [0.5, -2, -8, 0], [1, 18, -10, 0]]),
    tr(MB.shinR, [[0, 0, 0, 0], [0.22, 48, 0, 0], [1, 10, 0, 0]]),
    tr(MB.pelvis, [[0, 0, 0, 0], [0.22, -18, 0, 0], [0.5, -52, 4, 0], [0.78, -84, 6, 0], [1, -88, 6, 0]]),
    tr(MB.spineLow, [[0, 0, 0, 0], [0.5, -14, 0, 0], [1, -6, 0, 0]]),
    tr(MB.chest, [[0, 0, 0, 0], [0.5, -10, 0, 0], [1, 8, 0, 0]]),
    tr(MB.neck, [[0, 0, 0, 0], [0.4, 14, 0, 0], [1, 22, 0, 6]]),
    absTr(MB.upperArmL, [[0, 0, -55, -68], [0.4, 0, -84, -34], [1, 0, -104, -8]]),
    absTr(MB.lowerArmL, [[0, 0, -117, 3], [0.4, 0, -94, -6], [1, 0, -86, 6]]),
    absTr(MB.upperArmR, [[0, 0, -20, 72], [0.4, 0, 84, 34], [1, 0, 104, 8]]),
    absTr(MB.lowerArmR, [[0, 0, 97, 33], [0.4, 0, 94, 6], [1, 0, 86, -6]]),
    ...FEET_FLAT,
  ],
};

const deathKneel: OverlayDef = {
  name: 'deathKneel',
  frames: 30,
  duration: 1.35,
  loop: false,
  root: [
    [0, 0, 0, 0], [0.3, 0, -0.28, 0.04], [0.55, 0, -0.55, 0.08],
    [0.85, 0, -0.7, 0.26], [1, 0, -0.74, 0.32],
  ],
  tracks: [
    tr(MB.thighL, [[0, 0, 0, 0], [0.3, -48, 4, 0], [0.55, -74, 6, 0], [1, -70, 8, 0]]),
    tr(MB.shinL, [[0, 0, 0, 0], [0.3, 84, 0, 0], [0.55, 128, 0, 0], [1, 126, 0, 0]]),
    tr(MB.thighR, [[0, 0, 0, 0], [0.3, -40, -4, 0], [0.55, -70, -6, 0], [1, -66, -8, 0]]),
    tr(MB.shinR, [[0, 0, 0, 0], [0.3, 76, 0, 0], [0.55, 124, 0, 0], [1, 122, 0, 0]]),
    tr(MB.pelvis, [[0, 0, 0, 0], [0.3, 8, 0, 0], [0.55, -6, 4, 0], [0.85, -44, 8, 0], [1, -56, 10, 0]]),
    tr(MB.spineLow, [[0, 0, 0, 0], [0.3, 6, 0, 0], [0.85, -22, 0, 0], [1, -28, 0, 0]]),
    tr(MB.chest, [[0, 0, 0, 0], [0.55, -8, 0, 0], [1, -20, 0, 0]]),
    tr(MB.neck, [[0, 0, 0, 0], [0.3, -14, 0, 0], [1, -34, 0, 0]]),
    absTr(MB.upperArmL, [[0, 0, -55, -68], [0.55, 0, -32, -84], [1, 0, -14, -92]]),
    absTr(MB.lowerArmL, [[0, 0, -117, 3], [1, 0, -74, -14]]),
    absTr(MB.upperArmR, [[0, 0, -20, 72], [0.55, 0, -6, 86], [1, 0, 4, 92]]),
    absTr(MB.lowerArmR, [[0, 0, 97, 33], [1, 0, 74, 18]]),
    ...FEET_FLAT,
  ],
};

/** Sideways collapse: the base backward fall twisted onto one shoulder. */
const deathSide: OverlayDef = {
  name: 'deathSide',
  frames: 30,
  duration: 1.25,
  loop: false,
  root: [[0, 0, 0, 0], [0.4, -0.14, 0, 0], [1, -0.42, 0, -0.08]],
  tracks: [
    tr(MB.pelvis, [[0, 0, 0, 0], [0.35, 0, -22, -20], [1, 0, -58, -46]]),
    tr(MB.spineLow, [[0, 0, 0, 0], [1, 0, -8, -12]]),
    absTr(MB.upperArmL, [[0, 0, -55, -68], [1, 0, -30, -96]]),
    absTr(MB.lowerArmL, [[0, 0, -117, 3], [1, 0, -70, -22]]),
    absTr(MB.upperArmR, [[0, 0, -20, 72], [0.5, 0, 30, 90], [1, 0, 56, 100]]),
    absTr(MB.lowerArmR, [[0, 0, 97, 33], [1, 0, 52, 40]]),
  ],
};

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Weapon and shield raised, shouting. */
const cheer: OverlayDef = {
  name: 'cheer',
  frames: 28,
  duration: 1.4,
  loop: true,
  tracks: [
    tr(MB.spineLow, [[0, 4, 0, 0], [0.5, 7, 0, 0], [1, 4, 0, 0]]),
    tr(MB.neck, [[0, -14, 0, 0]]),
    absTr(MB.upperArmL, [[0, 0, -14, 74], [0.5, 0, -10, 86], [1, 0, -14, 74]]),
    absTr(MB.lowerArmL, [[0, 0, -30, 70]]),
    absTr(MB.upperArmR, [[0, 0, 14, -74], [0.5, 0, 10, -86], [1, 0, 14, -74]]),
    absTr(MB.lowerArmR, [[0, 0, 30, -70]]),
    ...FEET_FLAT,
  ],
};

/** Ladder climb: opposed reach, weight hanging from the arms. */
const climbLadder: OverlayDef = {
  name: 'climbLadder',
  frames: 26,
  duration: 1.3,
  loop: true,
  root: [[0, 0, -0.03, 0.16], [0.5, 0, 0.03, 0.16], [1, 0, -0.03, 0.16]],
  tracks: [
    tr(MB.pelvis, [[0, -14, 0, 0]]),
    tr(MB.spineLow, [[0, -8, 0, 0]]),
    tr(MB.neck, [[0, -16, 0, 0]]),
    absTr(MB.upperArmL, [[0, 0, -20, 76], [0.5, 0, -34, 22], [1, 0, -20, 76]]),
    absTr(MB.lowerArmL, [[0, 0, -46, 68], [0.5, 0, -60, 18], [1, 0, -46, 68]]),
    absTr(MB.upperArmR, [[0, 0, 34, -22], [0.5, 0, 20, -76], [1, 0, 34, -22]]),
    absTr(MB.lowerArmR, [[0, 0, 60, -18], [0.5, 0, 46, -68], [1, 0, 60, -18]]),
    tr(MB.thighL, [[0, -78, 6, 0], [0.5, -30, 4, 0], [1, -78, 6, 0]]),
    tr(MB.shinL, [[0, 66, 0, 0], [0.5, 34, 0, 0], [1, 66, 0, 0]]),
    tr(MB.thighR, [[0, -30, -4, 0], [0.5, -78, -6, 0], [1, -30, -4, 0]]),
    tr(MB.shinR, [[0, 34, 0, 0], [0.5, 66, 0, 0], [1, 34, 0, 0]]),
  ],
};

// ---------------------------------------------------------------------------
// Mounted
// ---------------------------------------------------------------------------

/**
 * Seated on a horse with no stirrups — which Rome did not have. The rider grips with the
 * thighs against the four horns of the saddle, so the legs sit further forward and less
 * bent than a modern seat, with the heel driven down for purchase.
 *
 * `abduct` opens the legs across the barrel and the sign of it matters more than the size.
 * It used to be negative on the left thigh and positive on the right, which *adducted* both
 * legs: measured on the rig, the boots ended up 0.12 m apart — closer together than the hip
 * joints, i.e. crossed inside a barrel 0.52 m wide, so both legs were buried in the horse.
 *
 * Sign the other way round, the size follows from the barrel. The knee inevitably ends up
 * level with the rib cage's widest station, which on this animal is 0.26 m from the spine, so
 * 20 degrees puts it at 0.32 m — clear by 6 cm, a leg lying on the horse's side rather than
 * one inside it. More than that and the man does the splits: at 26 degrees the thigh reads as
 * horizontal from behind.
 *
 * The shin then counter-rotates by slightly more than the thigh's flexion, so the lower leg
 * hangs a few degrees behind vertical and the heel finishes just below the belly line. That
 * long straight leg is the giveaway of a stirrupless seat and it is what the reliefs show;
 * a shin left 14 degrees forward of vertical, as it was, is a modern jumping seat.
 */
const rideLegs = (flex: number, abduct: number): BoneTrack[] => [
  tr(MB.thighL, [[0, -48 - flex, 6, abduct]]),
  tr(MB.shinL, [[0, 52 + flex, -4, -abduct * 0.35]]),
  tr(MB.thighR, [[0, -48 - flex, -6, -abduct]]),
  tr(MB.shinR, [[0, 52 + flex, 4, abduct * 0.35]]),
  tr(MB.footL, [[0, -14, 0, 0]]),
  tr(MB.footR, [[0, -14, 0, 0]]),
];

/** Reins in the shield hand, weapon hand low. */
const RIDE_ARMS: BoneTrack[] = [
  absTr(MB.upperArmL, [[0, 0, -46, -62]]),
  absTr(MB.lowerArmL, [[0, 0, -102, 8]]),
  absTr(MB.upperArmR, [[0, 0, -24, 68]]),
  absTr(MB.lowerArmR, [[0, 0, 104, 26]]),
];

const rideIdle: OverlayDef = {
  name: 'rideIdle',
  frames: 24,
  duration: 3.2,
  loop: true,
  root: [[0, 0, 0.02, -0.02]],
  tracks: [...rideLegs(0, 20), tr(MB.spineLow, [[0, 2, 0, 0]]), ...RIDE_ARMS],
};

const rideMove: OverlayDef = {
  name: 'rideMove',
  frames: 24,
  duration: 1.05,
  loop: true,
  // Rising and falling with the horse's back, a beat behind it.
  root: [
    [0, 0, 0.02, -0.02], [0.25, 0, 0.055, -0.01], [0.5, 0, 0.02, -0.02],
    [0.75, 0, 0.055, -0.01], [1, 0, 0.02, -0.02],
  ],
  tracks: [
    ...rideLegs(2, 20),
    tr(MB.spineLow, [[0, -4, 0, 0], [0.5, 0, 0, 0], [1, -4, 0, 0]]),
    ...RIDE_ARMS,
  ],
};

const rideGallop: OverlayDef = {
  name: 'rideGallop',
  frames: 22,
  duration: 0.62,
  loop: true,
  root: [[0, 0, 0.03, 0.0], [0.3, 0, 0.075, 0.03], [0.6, 0, 0.02, -0.01], [1, 0, 0.03, 0.0]],
  tracks: [
    ...rideLegs(6, 21),
    // Up out of the saddle and forward over the withers.
    tr(MB.pelvis, [[0, -14, 0, 0], [0.3, -20, 0, 0], [1, -14, 0, 0]]),
    tr(MB.spineLow, [[0, -12, 0, 0]]),
    hold(MB.head),
    ...RIDE_ARMS,
  ],
};

/** Spear couched under the arm, body low over the neck. */
const rideCharge: OverlayDef = {
  name: 'rideCharge',
  frames: 22,
  duration: 0.6,
  loop: true,
  hitFrame: 0.5,
  root: [[0, 0, 0.02, 0.04], [0.3, 0, 0.06, 0.07], [1, 0, 0.02, 0.04]],
  tracks: [
    ...rideLegs(8, 22),
    tr(MB.pelvis, [[0, -20, -8, 0], [0.3, -26, -8, 0], [1, -20, -8, 0]]),
    tr(MB.spineLow, [[0, -18, 6, 0]]),
    hold(MB.head),
    absTr(MB.upperArmL, [[0, 0, -52, -60]]),
    absTr(MB.lowerArmL, [[0, 0, -108, 6]]),
    // Spear arm forward and level, hand at chest height.
    absTr(MB.upperArmR, [[0, 0, 44, 34]]),
    absTr(MB.lowerArmR, [[0, 0, 84, 8]]),
  ],
};

const rideDeath: OverlayDef = {
  name: 'rideDeath',
  frames: 26,
  duration: 1.1,
  loop: false,
  root: [[0, 0, 0.02, 0], [0.35, 0.18, -0.1, -0.05], [1, 0.9, -0.85, -0.2]],
  tracks: [
    ...rideLegs(4, 19),
    tr(MB.pelvis, [[0, 0, 0, 0], [0.35, 6, -20, -34], [1, 20, -66, -96]]),
    tr(MB.spineLow, [[0, 0, 0, 0], [1, 10, -14, -20]]),
    absTr(MB.upperArmL, [[0, 0, -46, -62], [1, 0, -12, -100]]),
    absTr(MB.upperArmR, [[0, 0, -24, 68], [1, 0, 40, 98]]),
  ],
};

// ---------------------------------------------------------------------------
// Horse
// ---------------------------------------------------------------------------

const htr = (
  bone: number,
  keys: readonly (readonly [number, number, number, number])[]
): BoneTrack => ({ bone, keys });

/**
 * Trot, made from the walk by re-phasing the limbs.
 *
 * A walk is four-beat (LH, LF, RH, RF); a trot is two-beat with the diagonal pairs moving
 * together. Shifting the left fore and the right hind half a cycle turns one into the
 * other, which is far more reliable than hand-keying a gait and keeps the source's weight
 * and hoof trajectory intact.
 */
const horseTrot: OverlayDef = {
  name: 'trot',
  frames: 26,
  duration: 0.78,
  loop: true,
  phase: [
    [HB.fShoulderL, 0.5], [HB.fUpperL, 0.5], [HB.fLowerL, 0.5], [HB.fHoofL, 0.5],
    [HB.bHipR, 0.5], [HB.bFemurR, 0.5], [HB.bTibiaR, 0.5], [HB.bCannonR, 0.5], [HB.bHoofR, 0.5],
  ],
  amp: [
    [HB.fUpperL, 1.25], [HB.fUpperR, 1.25], [HB.fLowerL, 1.15], [HB.fLowerR, 1.15],
    [HB.bFemurL, 1.2], [HB.bFemurR, 1.2],
  ],
  root: [
    [0, 0, 0.02, 0], [0.25, 0, 0.055, 0], [0.5, 0, 0.02, 0], [0.75, 0, 0.055, 0], [1, 0, 0.02, 0],
  ],
  tracks: [
    htr(HB.neck1, [[0, -6, 0, 0]]),
    htr(HB.head, [[0, 4, 0, 0]]),
    htr(HB.tail1, [[0, -10, 0, 0]]),
  ],
};

/**
 * The gallop, opened up — and this is the clip the cavalry actually gallops on.
 *
 * Playback rate is ground speed over measured stride, so a short-strided clip does not
 * slide, it *sprints*: the legs cycle at whatever frequency it takes to cover the ground.
 * The retargeted source covers 4.27 m per cycle (measured: `tools/probe-gait.mjs`), which at
 * the roster's 9.6 m/s charge is 2.25 strides a second. A real horse at a hand gallop does
 * 1.6 to 2.0 strides a second over 5 to 6 m, so the source runs a third too fast and reads
 * as a wind-up toy.
 *
 * Stride is a purely geometric property of a clip — the backward drift of a planted hoof
 * divided by the fraction of the cycle it is down — so the only honest way to lengthen it is
 * to swing the limbs further. Amplifying the shoulders and hips (not the whole leg: amplifying
 * the cannon and pastern folds the hoof up past the belly without reaching any further
 * forward) was swept from 1.0 to 1.8 and measured:
 *
 *     amp      1.00   1.10   1.20   1.30   1.40   1.60   1.80
 *     stride   4.27   4.85   5.36   4.58   4.98   5.79   6.59
 *     hoof up  0.55   0.66   0.78   0.90   1.02   1.24   1.41
 *
 * 1.20 is the knee of that curve: 5.36 m, 1.79 strides a second at charge speed — playback
 * rate 1.07, i.e. very nearly the clip's own tempo — with the hoof folding to 0.78 m, which
 * is a galloping horse's tuck and not a cartwheel. The dip at 1.30 is the stride measurement
 * latching onto a different hoof's contact window, which is a good reason not to sit there.
 */
const horseGallopOpen: OverlayDef = {
  name: 'gallopOpen',
  frames: 22,
  duration: 0.6,
  loop: true,
  amp: [
    [HB.fShoulderL, 1.2], [HB.fShoulderR, 1.2], [HB.fUpperL, 1.2], [HB.fUpperR, 1.2],
    [HB.bHipL, 1.2], [HB.bHipR, 1.2], [HB.bFemurL, 1.2], [HB.bFemurR, 1.2],
  ],
  tracks: [
    htr(HB.neck1, [[0, 8, 0, 0]]),
    htr(HB.head, [[0, -8, 0, 0]]),
    htr(HB.tail1, [[0, -20, 0, 0]]),
  ],
};

/**
 * Charge: the opened gallop with the neck stretched right out and the tail streaming.
 *
 * The legs are left exactly as `gallopOpen` left them — amplifying on top of it lands on
 * the 1.30 dip above and shortens the stride — so the difference between a horse running
 * and a horse charging is carriage, which is where it is on a real animal.
 */
const horseCharge: OverlayDef = {
  name: 'charge',
  frames: 22,
  duration: 0.6,
  loop: true,
  tracks: [
    htr(HB.neck1, [[0, 16, 0, 0]]),
    htr(HB.neck2, [[0, 10, 0, 0]]),
    htr(HB.head, [[0, -18, 0, 0]]),
    htr(HB.tail1, [[0, -30, 0, 0]]),
  ],
};

export const MAN_OVERLAYS: { base: string; def: OverlayDef }[] = [
  { base: 'walk', def: march },
  { base: 'walk', def: walkLoose },
  { base: 'run', def: run },
  { base: 'run', def: charge },
  { base: 'run', def: flee },
  { base: 'idleRelaxed', def: idleRelaxed },
  { base: 'idleAlert', def: idleAlert },
  { base: 'idleAlert', def: idleBrace },
  // Shape variants; see "Pose variants" above.
  { base: 'idleAlert', def: idleAlertShift },
  { base: 'idleAlert', def: idleAlertWatch },
  { base: 'idleRelaxed', def: idleRelaxedLean },
  { base: 'idleAlert', def: idleBraceLow },
  // The testudo. The marching half is built on `march`, which is the first entry in this
  // list for that reason — `buildSet` walks it in order and an overlay's base has to exist.
  { base: 'idleAlert', def: testudoFace },
  { base: 'idleAlert', def: testudoNose },
  { base: 'idleAlert', def: testudoRoofA },
  { base: 'idleAlert', def: testudoRoofB },
  { base: 'idleAlert', def: testudoFlank },
  { base: 'march', def: testudoFaceMarch },
  { base: 'march', def: testudoNoseMarch },
  { base: 'march', def: testudoRoofAMarch },
  { base: 'march', def: testudoRoofBMarch },
  { base: 'march', def: testudoFlankMarch },
  { base: 'walk', def: marchShort },
  { base: 'walk', def: marchLong },
  { base: 'walk', def: walkLooseRoll },
  { base: 'run', def: runLow },
  { base: 'run', def: runLong },
  { base: 'run', def: chargeHigh },
  { base: 'run', def: chargeLow },
  { base: 'run', def: fleeOther },
  { base: 'run', def: fleePanic },
  { base: 'idleAlert', def: attackThrust },
  { base: 'idleAlert', def: attackThrustHigh },
  { base: 'idleAlert', def: attackOverhead },
  { base: 'idleAlert', def: attackOverheadCross },
  { base: 'slash', def: attackSlash },
  { base: 'punch', def: shieldBash },
  { base: 'idleAlert', def: block },
  { base: 'idleAlert', def: parry },
  { base: 'hitReact', def: stagger },
  { base: 'idleAlert', def: throwPilum },
  { base: 'idleAlert', def: drawBow },
  { base: 'idleAlert', def: releaseBow },
  { base: 'death', def: deathBack },
  { base: 'idleAlert', def: deathForward },
  { base: 'idleAlert', def: deathKneel },
  { base: 'death', def: deathSide },
  { base: 'wave', def: cheer },
  { base: 'idleAlert', def: climbLadder },
  { base: 'idleAlert', def: rideIdle },
  { base: 'idleAlert', def: rideMove },
  { base: 'idleAlert', def: rideGallop },
  { base: 'idleAlert', def: rideCharge },
  { base: 'idleAlert', def: rideDeath },
];

export const HORSE_OVERLAYS: { base: string; def: OverlayDef }[] = [
  { base: 'walk', def: horseTrot },
  // Order matters: `charge` is built on the opened gallop, so that has to exist first.
  { base: 'gallop', def: horseGallopOpen },
  { base: 'gallopOpen', def: horseCharge },
];

/** Bones whose ground contact defines a clip's stride, per rig. */
export const MAN_CONTACTS = [MB.footL, MB.footR];
export const HORSE_CONTACTS = [HB.fHoofL, HB.fHoofR, HB.bHoofL, HB.bHoofR];
