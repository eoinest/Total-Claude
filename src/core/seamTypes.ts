/**
 * Compile-time witnesses that each consumer's declared view really is a view of its provider.
 *
 * ## Why this file can exist, which is the finding it is built on
 *
 * The reason every one of these seams was written as a duck-typed cast is an import cycle:
 * `src/city/` imports `src/sim/types` for `Faction`, so — the argument goes — a `src/sim/`
 * module cannot import a city type back. **For a type-only import that argument is false.**
 * This project sets `verbatimModuleSyntax: false`, so `import type` is erased entirely; it
 * adds an edge to TypeScript's module graph, where circularity between *types* is legal and
 * ordinary, and no edge at all to the emitted bundle. There is no runtime cycle to create.
 *
 * So a shared type is available for every seam in the tree at zero runtime cost, and the
 * barrier is architectural policy rather than the module graph. This file takes the policy
 * seriously — no consumer is made to import a provider — and gets the check anyway, by being
 * the one module that imports *both* sides and asserts they agree. It exports nothing, is
 * imported by nothing, contains no runtime code, and exists only to be typechecked.
 *
 * ## What each line does
 *
 * `Implements<Provider, View>` fails to compile unless the real class is assignable to the
 * shape its consumer declared. Applied to the seam that started this pass:
 *
 *     Siege's CityView declared  getGateBlock?(): { x, z, hw, hd, rot, topY } | null
 *     CitySystem returns         GateBlockOut  { x, z, nx, nz, dx, dz, halfRun, halfDepth, … }
 *
 * One line here would have made that a build error the minute the accessor landed. It did not
 * exist, so instead `insideBlock` compared `Math.abs(...) <= undefined`, `false` came back for
 * every point on the map, and 22 of Rome's bay-19 garrison stations stood inside the
 * gatehouse for the whole life of the feature.
 *
 * ## What it does not cover, and why `src/core/seams.ts` also exists
 *
 * Three of the four faults this pass found are invisible to a type:
 *
 *  - **Lifetime.** `WaterSurface` read `postfx.depthTexture` in `init`, before PostFX had
 *    allocated one. Every name matched; the value was `null` on every boot.
 *  - **A registry name nothing answers to.** `Combat` resolves `tryGet('animation')` and no
 *    subsystem is registered under it. There is no type to compare.
 *  - **Convention.** The projectile pool is sparse and the audio side iterated it as dense.
 *
 * So this file is the cheap half and the runtime check is the general half, and neither
 * replaces the other. This one is free and catches shape drift before the app boots; that one
 * catches everything that only exists once the objects are alive.
 */

import type { CitySystem } from '../city/CitySystem';
import type { CameraSurfaceView } from './RTSCamera';
import type { Embrasure } from '../city/CitySystem';
import type { GarrisonBay, GateBlockOut, GateOut, RoughGround, WallStair } from '../city/wall';
import type { CityBayView, CityGateBlockView, CityStairView, CityView } from '../sim/Siege';
import type { EmbrasureView, MasonryView } from '../sim/Projectiles';
import type { CityNavProvider, PathfindingSystem } from '../ai/Pathfinding';
import type { NavProvider, ObstacleSource } from '../sim/BattleSystem';
import type { RoughBox } from '../sim/Obstacles';
import type { BattleSystem } from '../sim/BattleSystem';
import type { BattleView, SiegeView } from '../audio/BattleAudio';
import type { Siege } from '../sim/Siege';
import type { TerrainLike } from '../ui/HudSystem';
import type { SkyLike } from '../ui/SettingsPanel';
import type { FlowView } from '../ui/siege';
import type { SiegeCommandProbe } from '../ui/SiegeOrders';
import type { CityShape } from '../ai/WallDoctrine';
import type {
  CityView as DeployCityView, TerrainView as DeployTerrainView,
} from '../sim/deployment';
import type { TerrainSystem } from '../terrain/TerrainSystem';
import type { SkySystem } from '../render/SkySystem';
import type { BattleFlowSystem } from '../sim/BattleFlow';

/** Fails to compile unless `P` — the real implementation — satisfies the declared view `V`. */
type Implements<P extends V, V> = P;

/* eslint-disable @typescript-eslint/no-unused-vars */

// -- the seam that was broken ------------------------------------------------
type _GateBlock = Implements<GateBlockOut, CityGateBlockView>;

// -- and its neighbours on the same accessor set -----------------------------
type _Bay = Implements<GarrisonBay, CityBayView>;
type _Stair = Implements<WallStair, CityStairView>;
type _Gate = Implements<GateOut, { id: string; x: number; z: number; facing: number; open: boolean }>;

// -- the whole city, against every view declared of it -----------------------
type _CityForSiege = Implements<CitySystem, CityView>;
type _CityForNav = Implements<CitySystem, CityNavProvider>;

// -- the battlement the projectile system aims through -----------------------
type _Embrasure = Implements<Embrasure, EmbrasureView>;

/**
 * -- the surface the camera stands on ----------------------------------------
 *
 * The rig resolved every height it needed from `heightAt`, which is the bare-earth
 * heightfield, so the eye-level camera the whole game is sold on could not be walked along a
 * wall: on Carthage it sat 12.1 m *under* the walkway, inside the masonry, aimed at a look-at
 * point twelve metres over its own head. `CitySystem.walkableTopAt` is the query that fixes
 * it, and this is the line that says the rig and the city mean the same thing by it.
 *
 * Worth one line for the same reason `_GateBlock` was: the rig reaches this through a
 * function pointer `CitySystem.init` assigns, `(x, z) => this.walkableTopAt(x, z)`, which is
 * a shape nothing else compares. A rename on the city side would leave a null pointer and a
 * camera that silently went back to bare earth.
 */
type _CityForCamera = Implements<CitySystem, CameraSurfaceView>;

/*
 * -- the masonry every projectile is tested against --------------------------
 *
 * `Projectiles.init` probes `masonryTopAt` with `typeof ... === 'function'` and stores `null`
 * when it does not answer. That is correct — a battle on open ground has no city — and it is
 * also the failure mode with no symptom: if the method were renamed, every shot in the game
 * would pass through every wall and nothing would throw, warn, or fail to compile. This line
 * is what makes that a build error. The runtime seam in `src/core/seams.ts` covers the other
 * half, that a city registered under `'city'` actually answers to it at boot.
 */
type _MasonryForProjectiles = Implements<CitySystem, MasonryView>;

/*
 * -- standing work that is crossed rather than stopped at --------------------
 *
 * The city publishes `RoughGround`; both the integrator and the nav raster consume it as
 * `RoughBox`. This line is what stops the two coming apart, and the failure it guards
 * against is a silent one in both directions: `stampRough` and `setRough` each read `rise`
 * through a finite test and skip a record that does not answer, so a rename here does not
 * throw and does not warn — it restores, exactly, the behaviour that let a squadron of
 * horse cross a half-built rampart at a gallop for free.
 */
type _RoughForSim = Implements<RoughGround, RoughBox>;

// -- everything else that reaches a subsystem through a shape it wrote itself -
type _CityForObstacles = Implements<CitySystem, ObstacleSource>;
type _CityForDeploy = Implements<CitySystem, DeployCityView>;
type _CityForDoctrine = Implements<CitySystem, CityShape>;
type _NavForBattle = Implements<PathfindingSystem, NavProvider>;
type _BattleForAudio = Implements<BattleSystem, BattleView>;
/**
 * The siege watch that gives the gate its sound.
 *
 * `SiegeView` is `Pick<Siege, 'gateReport' | 'towerReport' | 'ramReport' | 'breachReport'>`,
 * so a rename on the simulation side is a compile error in the `Pick` itself and the field
 * names inside each report cannot drift at all — they *are* `Siege`'s own return types. This
 * line is what says the audio side is allowed to reach the reports through `BattleSystem.siege`
 * rather than through an event, which is the whole reason `src/sim/Siege.ts` needed no change.
 */
type _SiegeForAudio = Implements<Siege, SiegeView>;
/**
 * The order layer's view of the siege train.
 *
 * `SiegeCommandProbe` is five accessors `HudSystem` installs duck-typed, behind five
 * `typeof x === 'function'` guards — which is the exact arrangement that let `hw/hd/rot`
 * ship against `halfRun/halfDepth` for two releases. Four of the five predate this line and
 * happened to agree; `crewStatusOf` is the one this session added, and it carries the
 * boolean the whole HUD now uses to tell a machine's gang from infantry standing on a wall.
 * A rename of `commands` would read `undefined`, every crew would fall through as infantry,
 * and the siege tower would silently stop being aimable at all — with `tsc` green, because
 * the guard would still pass. This line is what makes that a build error.
 */
type _SiegeForCommand = Implements<Siege, SiegeCommandProbe>;
type _TerrainForHud = Implements<TerrainSystem, TerrainLike>;
type _TerrainForDeploy = Implements<TerrainSystem, DeployTerrainView>;
type _SkyForSettings = Implements<SkySystem, SkyLike>;
type _FlowForUi = Implements<BattleFlowSystem, FlowView>;
