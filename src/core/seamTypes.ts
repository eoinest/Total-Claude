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
import type { Embrasure } from '../city/CitySystem';
import type { GarrisonBay, GateBlockOut, GateOut, WallStair } from '../city/wall';
import type { CityBayView, CityGateBlockView, CityStairView, CityView } from '../sim/Siege';
import type { EmbrasureView } from '../sim/Projectiles';
import type { CityNavProvider, PathfindingSystem } from '../ai/Pathfinding';
import type { NavProvider, ObstacleSource } from '../sim/BattleSystem';
import type { BattleSystem } from '../sim/BattleSystem';
import type { BattleView } from '../audio/BattleAudio';
import type { TerrainLike } from '../ui/HudSystem';
import type { SkyLike } from '../ui/SettingsPanel';
import type { FlowView } from '../ui/siege';
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

// -- everything else that reaches a subsystem through a shape it wrote itself -
type _CityForObstacles = Implements<CitySystem, ObstacleSource>;
type _CityForDeploy = Implements<CitySystem, DeployCityView>;
type _CityForDoctrine = Implements<CitySystem, CityShape>;
type _NavForBattle = Implements<PathfindingSystem, NavProvider>;
type _BattleForAudio = Implements<BattleSystem, BattleView>;
type _TerrainForHud = Implements<TerrainSystem, TerrainLike>;
type _TerrainForDeploy = Implements<TerrainSystem, DeployTerrainView>;
type _SkyForSettings = Implements<SkySystem, SkyLike>;
type _FlowForUi = Implements<BattleFlowSystem, FlowView>;
