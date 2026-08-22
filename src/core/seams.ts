/**
 * The cross-subsystem seams, checked against the real objects once the world is built.
 *
 * ## The bug class this exists to close
 *
 * Subsystems find each other through `EngineContext.tryGet(name)`, which returns
 * `Subsystem | undefined` — a type with no members on it. Every consumer therefore casts,
 * and the honest way to cast is to write down the shape you are going to use:
 *
 * ```ts
 * const city = ctx.tryGet('city') as unknown as CityView | undefined;
 * ```
 *
 * That local `CityView` is written by the *consumer*, against a provider that does not
 * import it and does not `implements` it. Nothing in the language compares the two. The cast
 * is `as unknown as`, so it is not even a widening the compiler could object to — it is a
 * declaration that the two agree, made by one side, believed by `tsc`, and checked by
 * nobody. When it is wrong the consumer reads `undefined`, the guard clause it is wrapped in
 * passes, and the feature is silently inert.
 *
 * It has happened, and it is what this file is for. `Siege`'s `CityView` declared
 * `getGateBlock?(): { x, z, hw, hd, rot, topY }`. `CitySystem`'s gate-block accessor returns a
 * `GateBlockOut`, whose plan fields are `nx, nz, dx, dz, halfRun, halfDepth`. There is no
 * `hw`, no `hd` and no `rot` on it and there never was. `insideBlock` compared
 * `Math.abs(...) <= undefined`, which is `false` for every point on the map, so the gatehouse
 * clip returned "not inside the gatehouse" for the inside of the gatehouse. Measured on Rome:
 * 22 of bay 19's 36 garrison stations stood inside the footprint at x 59.89–77.94, 6.574 m
 * below the crown, and 0 of them were clipped. Two agents each wrote a correct half and an
 * accurate commit message; one said the clip was "inert until that accessor lands", and the
 * accessor had landed 48 minutes earlier under different names.
 *
 * ## The mechanism
 *
 * One list, one pass, run once at wiring time against the live objects. For each seam:
 *
 *  - `required` members must exist and be functions or properties as declared. A missing one
 *    is a violation even though the consumer would have thrown anyway, because throwing at
 *    the first click is worse than failing at boot with the field name in the message.
 *  - `optional` members may be absent — a battle on open ground has no city, and a city that
 *    has not built a feature yet is a real state the consumers handle. Absent is fine.
 *  - `returns` is the half `tsc` cannot see and the half that was wrong. It names, per
 *    accessor, the fields the consumer actually reads off the returned value. The accessor is
 *    called once and the fields are looked for on what comes back. **An optional accessor
 *    that is present but returns the wrong shape is the worst case in this file** — the
 *    consumer's `typeof x === 'function'` guard passes and it then reads `undefined` — so
 *    that is reported at the same severity as a missing required member.
 *
 * Every accessor listed under `returns` is a pure getter; several are called with sample
 * coordinates taken from the provider's own published geometry rather than from constants,
 * so a moved wall does not turn into a false negative. Everything is wrapped, so a throwing
 * accessor is a reported violation and not a failed boot.
 *
 * ## Why this and not a shared type
 *
 * A shared type is better where it is available and three of these seams should get one. It
 * is not available everywhere: `src/city/` imports `src/sim/types` for `Faction`, so a
 * `src/sim/` module that imported a city type would close a cycle, and the interfaces the
 * consumers declare are deliberately *narrower* than the provider's real record — `Siege`
 * wants six fields off a seventeen-field `GateBlockOut` and should not be made to depend on
 * the other eleven. What every one of these seams does have in common is that both sides are
 * alive in the same process at boot. So the check is one mechanism applied to all of them
 * rather than a clever one applied to the one that broke.
 *
 * Results are also published on `globalThis.__seams` so a headless probe can assert on them;
 * see `tools/probe-seams.mjs`, which boots both maps and fails on any violation.
 */

import type { EngineContext } from './Engine';
import { ALL_UNITS } from '../units/roster';
import type { UnitClass } from '../sim/types';

// ---------------------------------------------------------------------------
// The spec language
// ---------------------------------------------------------------------------

/** What the consumer expects a member to be. `prop` means "present and not undefined". */
export type MemberKind = 'fn' | 'prop';

export interface ReturnSpec {
  /** Field names the consumer reads off the value this accessor returns. */
  fields: readonly string[];
  /**
   * Call the accessor. Defaults to a no-argument call. Given the provider so a spec can take
   * its sample coordinates off the provider's own geometry.
   */
  call?: (provider: Record<string, unknown>) => unknown;
  /**
   * The accessor returns a list and the fields belong to an element. An empty list is not a
   * violation — an empty circuit is a real state — it simply cannot be checked.
   */
  element?: boolean;
  /**
   * `null` is a legitimate answer (no gate on this circuit, no embrasure at this point) and
   * is not a violation. Default true; set false where a null would itself be a fault.
   */
  nullable?: boolean;
}

export interface Seam {
  /** The file and interface that declares this shape, for the message. */
  consumer: string;
  /**
   * Where the provider lives: a registry key, optionally with a dotted path to a field on
   * it, e.g. `battle.siege`. A provider that is not registered is skipped, not failed.
   */
  provider: string;
  required?: Readonly<Record<string, MemberKind>>;
  optional?: Readonly<Record<string, MemberKind>>;
  returns?: Readonly<Record<string, ReturnSpec>>;
}

export type SeamFaultKind =
  /** A required member is not on the provider at all. */
  | 'missing'
  /** A member is present but is not the kind the consumer declared (property vs method). */
  | 'kind'
  /** The accessor is present and the value it returns is missing fields the consumer reads. */
  | 'drift'
  /** The accessor threw when called with the sample arguments. */
  | 'threw';

export interface SeamFault {
  kind: SeamFaultKind;
  consumer: string;
  provider: string;
  member: string;
  /** Field names that were absent, for a `drift`. */
  missingFields?: string[];
  /** Field names that were present, so a message can name the real ones. */
  presentFields?: string[];
  detail?: string;
}

export interface SeamReport {
  checked: number;
  skipped: string[];
  faults: SeamFault[];
  /**
   * Optional members a consumer declares that the provider does not have. Not faults — an
   * unbuilt feature is a real state and every one of these call sites is `?.`-guarded — but
   * recorded, because "declared, called, and nobody implements it" is how a feature comes to
   * be believed in. `CityView.breachWall` is the standing example: `Siege.breachBay` calls it
   * so the city can cut the passage out of its own occupancy raster, and no circuit has one.
   */
  absent: string[];
  /**
   * Accessors whose fields could not be compared because the list they returned was empty.
   *
   * Recorded rather than passed over in silence: "no fault" and "nothing to check" are
   * different answers and a check that conflates them is the kind of green tick this whole
   * file exists to distrust. `towerReport` is empty until a siege tower is built.
   */
  unchecked: string[];
}

// ---------------------------------------------------------------------------
// The seams
// ---------------------------------------------------------------------------

/** First finite coordinate pair on the circuit, for the accessors that take a point. */
function sampleWallPoint(city: Record<string, unknown>): [number, number] | null {
  const get = city['getGarrisonBays'];
  if (typeof get !== 'function') return null;
  const bays = (get as () => readonly Record<string, number>[]).call(city);
  if (!bays || bays.length === 0) return null;
  const b = bays[Math.floor(bays.length / 2)] ?? bays[0];
  const t = (b.length ?? 0) * 0.5;
  const x = (b.x0 ?? 0) + (b.dx ?? 0) * t;
  const z = (b.z0 ?? 0) + (b.dz ?? 0) * t;
  return Number.isFinite(x) && Number.isFinite(z) ? [x, z] : null;
}

export const SEAMS: readonly Seam[] = [
  // -- the one that was wrong ------------------------------------------------
  {
    consumer: 'sim/Siege.ts CityView',
    provider: 'city',
    required: { getGarrisonBays: 'fn', getGates: 'fn', setGateOpen: 'fn' },
    optional: {
      setGateDoorBroken: 'fn', isGateDoorBroken: 'fn', getGateBlocks: 'fn',
      getWallStairs: 'fn', breachWall: 'fn',
    },
    returns: {
      /**
       * The six fields `buildSpine` and `insideBlock` read. `hw`/`hd`/`rot` used to be three
       * of them and were never on the record; the plan footprint is published as an
       * along-run/across-run frame, so these are the names that exist.
       *
       * A **list** since Rome gained its other two attested gates (§5.1, §15 task 5): one
       * record meant `buildSpine` clipped one block and laid a rank inside the other two,
       * which is §5.4's twenty-two stations-in-masonry defect reinstated twice.
       */
      getGateBlocks: {
        element: true,
        fields: ['x', 'z', 'nx', 'nz', 'dx', 'dz', 'halfRun', 'halfDepth', 'topY'],
      },
      getGarrisonBays: {
        element: true,
        fields: [
          'index', 'x0', 'z0', 'x1', 'z1', 'nx', 'nz', 'dx', 'dz', 'length',
          'walkY', 'groundY', 'crestY', 'sillY', 'parapetInner', 'parapetOuter',
          'innerOff', 'outerOff', 'garrisonable', 'towerHalf', 'isGate', 'stage',
        ],
      },
      getGates: { element: true, fields: ['id', 'x', 'z', 'facing', 'open'] },
      getWallStairs: {
        element: true,
        fields: ['footX', 'footZ', 'footY', 'topX', 'topZ', 'topY'],
      },
    },
  },

  // -- the wall, as the shots and the paths see it ---------------------------
  {
    consumer: 'sim/Projectiles.ts masonry + EmbrasureView',
    provider: 'city',
    optional: { masonryTopAt: 'fn', embrasureAt: 'fn' },
    returns: {
      embrasureAt: {
        fields: ['walkY', 'crestY', 'sillY', 'parapetInner', 'parapetOuter', 'nx', 'nz'],
        call: (city) => {
          const p = sampleWallPoint(city);
          const fn = city['embrasureAt'] as (x: number, z: number) => unknown;
          return p ? fn.call(city, p[0], p[1]) : null;
        },
      },
    },
  },
  // -- the wall, as the camera stands on it -----------------------------------
  {
    consumer: 'core/RTSCamera.ts CameraSurfaceView',
    provider: 'city',
    optional: { walkableTopAt: 'fn' },
    returns: {
      /**
       * The one seam in this file whose accessor returns a **number**, and the check is not
       * about its shape.
       *
       * `walkableTopAt` answers `-Infinity` for "no masonry here", which is a legitimate
       * answer over most of the map and is indistinguishable — to a type, to a
       * `typeof === 'function'` guard, and to the camera's own `top > ground` test — from a
       * query that has quietly stopped finding the wall. That is the exact failure this file
       * exists for: present, called, guarded, and inert. So the call asks it about a point on
       * the circuit's own wall-walk, taken off `getGarrisonBays()` rather than from a
       * constant, and reports the answer as a field only when it is finite. A city that
       * cannot find its own walkway fails here at boot instead of at the first time somebody
       * tries to walk it.
       */
      walkableTopAt: {
        fields: ['standable'],
        call: (city) => {
          const p = sampleWallPoint(city);
          if (!p) return null;
          const fn = city['walkableTopAt'] as (x: number, z: number) => number;
          const y = fn.call(city, p[0], p[1]);
          return Number.isFinite(y) ? { standable: y } : {};
        },
      },
    },
  },
  {
    consumer: 'ai/Pathfinding.ts CityNavProvider',
    provider: 'city',
    optional: {
      getWallSegments: 'fn', getObstacles: 'fn', getGates: 'fn', getRoughGround: 'fn',
      blocksMovement: 'fn', obstacleGeneration: 'prop',
    },
    returns: {
      /**
       * `stampWallSegments` reads `gate` and `halfThickness` off each segment, and
       * `CitySystem.getWallSegments()`'s own declared return type names neither. The values
       * are there — the declaration is what drifted narrow — and this is the check that says
       * so out loud rather than after somebody honours the declaration.
       */
      getWallSegments: {
        element: true,
        fields: ['x1', 'z1', 'x2', 'z2', 'height', 'gate', 'rough', 'halfThickness'],
      },
      /**
       * The third state a piece of wall can be in, and the seam that carries it.
       *
       * `stampRough` reads `x`, `z`, `hw`, `hd`, `rot` and `rise`, and it degrades on every
       * one of them the same silent way `openGates` degrades on `facing`: a missing or
       * renamed `rise` fails `Number.isFinite` and the bay is skipped, which restores
       * exactly the behaviour this workstream was sent to fix — a half-built rampart that
       * costs a galloping horse nothing. There is no loud failure available, because
       * charging nothing is what the grid did before and looks like nothing at all.
       *
       * `rise` in particular is checked as a *number* rather than as a present key, because
       * the wrong answer here is not absence but zero: `worstRiseOf` returning 0 for a bay
       * whose stage stopped being `footing` would publish a record that stamps no cost.
       */
      getRoughGround: {
        element: true,
        fields: ['x', 'z', 'hw', 'hd', 'rot', 'rise', 'crestY'],
      },
      getObstacles: { element: true, fields: ['x', 'z', 'hw', 'hd', 'rot', 'topY'] },
      /**
       * `openGates` reads all four, and this is the seam a broken gate actually runs through.
       *
       * It is listed under `Siege`'s seam above and was not listed here, which left the more
       * dangerous of the two readers unchecked. `Siege` reads `open` off the record and a
       * drift there is loud. `openGates` reads `facing` through
       * `Number.isFinite(facing) ? Math.sin(facing) : 0` and **degrades silently** — a rename
       * to `bearing` or `rot` takes the fallback branch, cuts the carriageway along `(0, -1)`
       * instead of along the gate's own normal, and leaves the passage stamped shut on any
       * circuit whose runs are not north-facing. The ram would land its twenty-six blows,
       * `CitySystem` would clear its own raster, and A\* would still route round the city.
       *
       * That failure is indistinguishable from the one this workstream was sent to find, so
       * it is worth writing down that on the shipped maps it is **not** what is happening.
       * Measured at the Porta Flaminia as the leaves gave way: `blocksMovement` across the
       * door plane goes true → false, the grid's `blocked` and `tight` masks both open at the
       * axis, and A\* returns a complete route 45 m into the city for every footprint radius
       * up to 5 m. This entry is here to keep that true, not because it had come apart.
       */
      getGates: { element: true, fields: ['id', 'x', 'z', 'facing', 'open'] },
    },
  },
  {
    consumer: 'sim/BattleSystem.ts ObstacleSource',
    provider: 'city',
    optional: { getObstacles: 'fn', getRoughGround: 'fn', obstacleGeneration: 'prop' },
    returns: {
      /**
       * The integrator's half of the same seam the pathfinder reads above.
       *
       * Two consumers, one provider, and the whole point of both entries is that the mover
       * and the planner charge the *same* number for the same piece of ground —
       * `roughTraverseCost` is one function precisely so they cannot disagree. If this list
       * and the nav one ever come apart, a body will be slowed across work a route was
       * planned over for free, or the reverse.
       */
      getRoughGround: {
        element: true,
        fields: ['x', 'z', 'hw', 'hd', 'rot', 'rise'],
      },
    },
  },
  {
    consumer: 'ai/WallDoctrine.ts CityShape',
    provider: 'city',
    optional: { getWallStairs: 'fn', getLanes: 'fn' },
    returns: {
      getLanes: { element: true, fields: ['path', 'width'] },
    },
  },
  {
    consumer: 'ui/SelectionController.ts + ui/Minimap.ts',
    provider: 'city',
    optional: { getObstacles: 'fn', getWallSegments: 'fn', obstacleGeneration: 'prop' },
  },

  // -- the siege train, reached through the battle ---------------------------
  {
    consumer: 'ui/HudSystem.ts wallProbe',
    provider: 'battle.siege',
    required: { wallTargetAt: 'fn', isGarrisoned: 'fn', wallSideAt: 'fn' },
    /**
     * `escaladeOfferAt` reaches the wall probe as `stormOfferAt`.
     *
     * The wall cursor stops promising "Storm the wall here" when the sim would drop the
     * order, and it decides that from the same function `SiegeOrders` builds the sentence
     * from. If this ever stops answering, the cursor quietly goes back to promising every
     * storm — which is the state it shipped in — so it is named here rather than left to be
     * an implementation detail of one install block.
     */
    optional: {
      cancelWallPlan: 'fn', releaseEscalade: 'fn',
      escaladeOfferAt: 'fn', traverseOfferAt: 'fn',
    },
  },
  {
    consumer: 'ui/HudSystem.ts + ui/SiegeOrders.ts machine orders',
    provider: 'battle.siege',
    optional: {
      machineOrderAt: 'fn', machineDestinationOf: 'fn',
      requestMachineOrder: 'fn', escaladeOfferAt: 'fn', towerReport: 'fn',
      crewStatusOf: 'fn',
    },
    returns: {
      towerReport: { element: true, fields: ['x', 'z', 'baseY', 'deckY'] },
      /**
       * The predicate that decides whether the men under the cursor are a crew.
       *
       * Checked by field and not merely by existence, because the whole of the defect it
       * fixes was a boolean read off the wrong question: `SiegeOrders` inferred "crew" from
       * `machineDestinationOf` returning something, and a tower's `unitId` is never cleared,
       * so eighty men standing on a parapet were answered "Too late — the ramp is down" for
       * the rest of the battle. If `commands` ever went missing the read would be
       * `undefined`, every crew would fall through as infantry, and the tower would silently
       * stop being aimable — the same class of silent shape drift as `hw/hd/rot`.
       */
      crewStatusOf: {
        fields: ['crew', 'commands', 'kind', 'done'],
        /*
         * Asked about a unit id no army has, on purpose. All four fields are written on
         * every path through `crewStatusOf` — the "this man is nobody's gang" answer fills
         * them in exactly as the crew answer does — so the shape is checkable at boot,
         * before a machine has been built, without this file needing a handle on a unit.
         */
        call: (s) => (s['crewStatusOf'] as (u: number) => unknown).call(s, -1),
      },
    },
  },
  {
    consumer: 'ai/WallDoctrine.ts WallView',
    provider: 'battle.siege',
    required: { ownsUnit: 'fn', isGarrisoned: 'fn', unitWallState: 'fn', wallTargetAt: 'fn' },
  },
  /**
   * The four reports the gate's sound is derived from.
   *
   * `Siege` announces a collapse with a `cameraShake` and nothing else, so `BattleAudio`
   * watches these instead of subscribing to an event — which is why they are a seam rather
   * than an internal detail, and why they are checked here. `broken` is the one that matters:
   * it is the field that goes false → true on the tick the leaves come down, and if it were
   * ever renamed the watch would read `undefined`, never see a transition, and the climax
   * would go quiet again with every line of the audio subsystem still looking correct.
   *
   * `element: true` on all three lists, so an assault that has not built a machine yet is
   * reported `unchecked` rather than passed in silence.
   */
  {
    consumer: 'audio/BattleAudio.ts SiegeView',
    provider: 'battle.siege',
    required: { gateReport: 'fn', towerReport: 'fn', ramReport: 'fn', breachReport: 'fn' },
    returns: {
      gateReport: { fields: ['open', 'breached', 'x', 'z', 'gates'] },
      breachReport: { fields: ['bays'] },
      ramReport: { element: true, fields: ['id', 'kind', 'x', 'z', 'wreck', 'bay'] },
      towerReport: { element: true, fields: ['id', 'state', 'x', 'z', 'deckY'] },
    },
  },
  /**
   * The gate rows, separately, because `broken` is the field the collapse actually turns on
   * and `returns` takes one spec per accessor. The scalar half is checked above; this reaches
   * one row deeper, into `gates[]`, which is where the watch reads.
   */
  {
    consumer: 'audio/BattleAudio.ts SiegeView gates[]',
    provider: 'battle.siege',
    returns: {
      gateReport: {
        element: true,
        fields: ['id', 'x', 'z', 'open', 'broken', 'blows', 'hp'],
        call: (s) => (s['gateReport'] as () => { gates: unknown[] }).call(s).gates,
      },
    },
  },

  // -- audio, which is where the other two live drifts were ------------------
  {
    consumer: 'audio/BattleAudio.ts ProjectileView',
    provider: 'projectiles',
    required: { projectileFeed: 'fn' },
    returns: {
      projectileFeed: {
        fields: ['count', 'alive', 'px', 'py', 'pz', 'vx', 'vy', 'vz'],
      },
    },
  },
  {
    consumer: 'audio/AudioEngine.ts weather() <- sky',
    provider: 'sky',
    optional: { timeOfDay: 'prop', preset: 'prop' },
    returns: {
      preset: { fields: ['cloudCoverage'], call: (sky) => sky['preset'] },
    },
  },
  {
    consumer: 'audio/AudioEngine.ts weather() <- vfx',
    provider: 'vfx',
    optional: { wind: 'prop', weatherKind: 'prop' },
  },

  // -- the two lifetime seams in the water -----------------------------------
  {
    consumer: 'terrain/WaterSurface.ts scene depth',
    provider: 'postfx',
    optional: { depthTexture: 'prop' },
  },
  {
    consumer: 'terrain/WaterSurface.ts sky tint',
    provider: 'sky',
    optional: { ambientColour: 'prop' },
  },
  {
    consumer: 'audio/BattleAudio.ts BattleView',
    provider: 'battle',
    required: { units: 'prop', pool: 'prop' },
    optional: { groundAt: 'fn' },
    returns: {
      pool: {
        fields: ['count', 'x', 'y', 'z', 'state'],
        call: (b) => b['pool'],
      },
    },
  },

  // -- the rest of the HUD's optional integrations ---------------------------
  {
    consumer: 'ui/HudSystem.ts TerrainLike',
    provider: 'terrain',
    optional: { heightAt: 'fn', heightField: 'prop' },
    returns: {
      heightField: {
        fields: ['data', 'res', 'spacing', 'halfExtent'],
        call: (t) => t['heightField'],
      },
    },
  },
  {
    consumer: 'ui/SettingsPanel.ts SkyLike',
    provider: 'sky',
    optional: { setTimeOfDay: 'fn', timeOfDay: 'prop' },
  },
  {
    consumer: 'ui/HudSystem.ts morale + abilities',
    provider: 'morale',
    optional: { moraleTerms: 'fn' },
  },
  {
    consumer: 'ui/HudSystem.ts abilities',
    provider: 'abilities',
    optional: { cooldownFraction: 'fn', activeOn: 'fn' },
  },
  {
    consumer: 'ui/siege.ts FlowView + ui/BattleFlow.ts',
    provider: 'battleFlow',
    optional: { objective: 'prop', result: 'prop' },
  },

  /**
   * Registered here so the gap is on the record every run.
   *
   * `Combat.resolveClipInfo` resolves `ctx.tryGet<AnimationProvider>('animation')` and nothing
   * in the tree ever registers that name — it is the one resolved subsystem key with no
   * `readonly name` to match it. Harmless today: the guard falls through to a dynamic
   * `import('../anim/clips')`, which exports a matching `clipInfo` and always wins. It is
   * listed because the branch reads as one of two live options and is in fact unreachable, and
   * a probe that prints "skipped: provider not registered" says that once a run instead of
   * waiting for somebody to grep for it.
   */
  {
    consumer: 'sim/Combat.ts AnimationProvider',
    provider: 'animation',
    required: { clipInfo: 'fn' },
  },
];

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

function resolve(ctx: EngineContext, path: string): Record<string, unknown> | null {
  const parts = path.split('.');
  let cur: unknown = ctx.tryGet(parts[0]);
  for (let i = 1; i < parts.length && cur; i++) {
    cur = (cur as Record<string, unknown>)[parts[i]];
  }
  return cur && typeof cur === 'object' ? (cur as Record<string, unknown>) : null;
}

function checkMembers(
  seam: Seam, obj: Record<string, unknown>,
  members: Readonly<Record<string, MemberKind>> | undefined, requiredHere: boolean,
  faults: SeamFault[], absent: string[]
): void {
  if (!members) return;
  for (const [name, kind] of Object.entries(members)) {
    const v = obj[name];
    // A declared property that exists and currently holds `null` is *present* — `battleFlow`
    // has no `result` until somebody wins. Absence is the name not being there at all.
    const there = kind === 'fn' ? typeof v === 'function' : name in obj;
    if (!there) {
      if (requiredHere) {
        faults.push({
          kind: 'missing', consumer: seam.consumer, provider: seam.provider, member: name,
          presentFields: Object.keys(obj).filter((k) => !k.startsWith('_')).sort(),
          detail: `required ${kind === 'fn' ? 'method' : 'property'} is absent`,
        });
      } else absent.push(`${seam.consumer} -> '${seam.provider}'.${name}`);
      continue;
    }
    const isFn = typeof v === 'function';
    if (kind === 'prop' && isFn) {
      faults.push({
        kind: 'kind', consumer: seam.consumer, provider: seam.provider, member: name,
        detail: 'declared a property, provider has a method',
      });
    }
  }
}

/**
 * Run every seam against the live objects.
 *
 * Safe to call more than once and safe to call on a world with half the subsystems missing —
 * an unregistered provider is `skipped`, not a fault. A battle on open ground registers no
 * `city` and must not fail this.
 */
export function verifySeams(ctx: EngineContext): SeamReport {
  const faults: SeamFault[] = [];
  const skipped: string[] = [];
  const absent: string[] = [];
  const unchecked: string[] = [];
  let checked = 0;

  for (const seam of SEAMS) {
    const obj = resolve(ctx, seam.provider);
    if (!obj) { skipped.push(`${seam.consumer} -> ${seam.provider}`); continue; }
    checked++;

    checkMembers(seam, obj, seam.required, true, faults, absent);
    checkMembers(seam, obj, seam.optional, false, faults, absent);

    for (const [name, spec] of Object.entries(seam.returns ?? {})) {
      const member = obj[name];
      // An optional accessor that is simply absent is a legitimate state; it is an accessor
      // that is *present and disagrees* this whole file exists for.
      if (member === undefined || member === null) continue;
      let value: unknown;
      try {
        value = spec.call
          ? spec.call(obj)
          : typeof member === 'function'
            ? (member as () => unknown).call(obj)
            : member;
      } catch (err) {
        faults.push({
          kind: 'threw', consumer: seam.consumer, provider: seam.provider, member: name,
          detail: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (value === null || value === undefined) {
        if (spec.nullable === false) {
          faults.push({
            kind: 'drift', consumer: seam.consumer, provider: seam.provider, member: name,
            detail: 'returned null where the consumer requires a value',
          });
        }
        continue;
      }
      let target: unknown = value;
      if (spec.element) {
        const arr = value as ArrayLike<unknown>;
        if (typeof arr.length !== 'number') {
          faults.push({
            kind: 'drift', consumer: seam.consumer, provider: seam.provider, member: name,
            detail: `consumer iterates this; provider returned ${typeof value}`,
          });
          continue;
        }
        if (arr.length === 0) {
          // An empty circuit is a real state; say so rather than counting it as agreement.
          unchecked.push(`${seam.consumer} -> '${seam.provider}'.${name} (empty list)`);
          continue;
        }
        target = arr[0];
      }
      if (typeof target !== 'object' || target === null) {
        faults.push({
          kind: 'drift', consumer: seam.consumer, provider: seam.provider, member: name,
          detail: `consumer reads fields off this; provider returned ${typeof target}`,
        });
        continue;
      }
      const t = target as Record<string, unknown>;
      const missing = spec.fields.filter((f) => t[f] === undefined);
      if (missing.length > 0) {
        faults.push({
          kind: 'drift', consumer: seam.consumer, provider: seam.provider, member: name,
          missingFields: missing,
          presentFields: Object.keys(t).sort(),
        });
      }
    }
  }

  checkRosterBranches(absent);

  return { checked, skipped, faults, absent, unchecked };
}

/**
 * Branches taken on a *value* the data never produces.
 *
 * The seams above ask whether a provider has the member a consumer named. This asks the other
 * half of the same question: a consumer can name a member that exists, read it correctly, and
 * still be unreachable because nothing in the data ever puts the value there. No type catches
 * it — `ROMAN_UNITS: UnitTypeDef[]` widens every `unitClass` to the whole union the moment it
 * is annotated, so `'general'` is a legal member of a union that no entry inhabits.
 *
 * Found by measurement, not by reading: `MoraleSystem.auraBonus` walks every friendly unit
 * looking for `typeOf(o).unitClass === 'general'` and adds up to 9 morale points to the
 * baseline of everyone within 110 m. **No entry in `ROMAN_UNITS`, `GERMANIC_UNITS`,
 * `CARTHAGINIAN_UNITS` or `SIEGE_UNITS` declares that class**, so the function has returned 0
 * for every unit of every battle in every shipped build, and the morale model's leadership
 * term has never once fired. `BannerSystem` tests the same class and has never seen it either.
 *
 * Recorded through `absent` rather than as a fault, for the same reason `CityView.breachWall`
 * is: a general nobody has built is a real state and the reader degrades correctly. What is
 * not acceptable is that it degrade *silently*, because "declared, read, and nothing produces
 * it" is precisely how a feature comes to be believed in. Adding a general to a roster is a
 * balance decision and is deliberately not made here.
 */
function checkRosterBranches(absent: string[]): void {
  const present = new Set(ALL_UNITS.map((u) => u.unitClass));
  for (const [cls, readers] of Object.entries(CLASS_READERS)) {
    if (present.has(cls as UnitClass)) continue;
    for (const r of readers) absent.push(`${r} -> no roster entry has unitClass '${cls}'`);
  }
}

/** Unit classes the simulation branches on, and who branches on them. */
const CLASS_READERS: Readonly<Record<string, readonly string[]>> = {
  general: [
    'sim/Morale.ts auraBonus (the general\'s steadying aura, worth up to +9 baseline)',
    'vfx/BannerSystem.ts (standard selection)',
  ],
};

/**
 * Format one fault as the sentence somebody reading a console needs.
 *
 * Both field lists are printed, because the fix is almost always "the provider calls it
 * something else" and the reader cannot guess which of seventeen names that is.
 */
export function describeSeamFault(f: SeamFault): string {
  const head = `[seam] ${f.consumer} -> '${f.provider}'.${f.member}`;
  switch (f.kind) {
    case 'missing':
      return `${head}: ${f.detail}. Provider has: ${(f.presentFields ?? []).join(', ')}`;
    case 'kind':
      return `${head}: ${f.detail}`;
    case 'threw':
      return `${head}: threw when called — ${f.detail}`;
    case 'drift':
      return f.missingFields
        ? `${head}: returns an object with no ${f.missingFields.join(', ')}. `
          + `It actually has: ${(f.presentFields ?? []).join(', ')}`
        : `${head}: ${f.detail}`;
  }
}

/**
 * Check every seam, shout about any that is broken, and publish the report.
 *
 * Called from `main.ts` once the world is built and the armies are on the field, which is the
 * first moment every provider is bound. It is a read of already-built state and costs under a
 * millisecond, so it runs in every build rather than only in the harness — a check that only
 * runs where somebody remembers to run it is the arrangement that produced the bug.
 */
export function installSeamCheck(ctx: EngineContext): SeamReport {
  const report = verifySeams(ctx);
  for (const f of report.faults) console.error(describeSeamFault(f));
  if (report.faults.length > 0) {
    console.error(`[seam] ${report.faults.length} broken seam(s) of ${report.checked} checked.`
      + ' Each one is a feature that compiles and does nothing.');
  }
  (globalThis as unknown as { __seams?: SeamReport }).__seams = report;
  return report;
}
