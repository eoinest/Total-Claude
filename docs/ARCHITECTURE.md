# TOTAL CLAUDE — Architecture & Contracts

Read this before touching code. It is the contract between subsystems so that
independently-developed modules integrate without a rewrite.

**Target:** a Three.js battle simulator that stands comparison with Total War: Rome II.
The Siege of Rome, 271 AD — a Juthungi/Alemannic host assaulting the city from the
Campus Martius against a late-third-century Roman field army.

---

## 1. Project shape

```
src/
  core/      Engine, Time, Input, EventBus, RTSCamera, events   (owned by integrator)
  util/      math, rand                                          (owned by integrator)
  render/    SkySystem, LightingSystem, PostFX                    → RENDER agent
  terrain/   TerrainSystem, vegetation, ground materials          → TERRAIN agent
  city/      Rome: walls, landmarks, insulae, streets             → CITY agent
  units/     roster, soldier meshes, LOD, atlases                 → UNITS agent
  anim/      rig, clip authoring, VAT baking, GPU skinning        → UNITS agent
  sim/       types, formations, BattleSystem, scenario            (shared, see below)
             Combat, Morale, Projectiles, Ragdoll                 → COMBAT agent
  ai/        general AI, tactical AI, pathfinding                 → AI agent
  ui/        HUD, unit cards, minimap, banners, orders            → UI agent
  vfx/       particles, dust, blood, decals, weather              → VFX agent
  audio/     mixer, positional sound, music                       → AUDIO agent
tools/       shoot.mjs (screenshot harness), fetch-assets.mjs
public/assets/  hdri, textures, models + manifest.json
```

**File ownership is exclusive.** Do not edit files outside your assigned directory.
If you need a change in `src/core/`, `src/util/`, `src/sim/types.ts`,
`src/sim/formations.ts`, `src/sim/BattleSystem.ts`, `src/sim/scenario.ts`, `src/main.ts`
or `index.html`, **report it in your final message** and the integrator applies it.
Two agents editing one file loses work.

---

## 2. The subsystem interface

Everything plugs into the engine as a `Subsystem` (`src/core/Engine.ts`):

```ts
interface Subsystem {
  readonly name: string;          // unique; how others resolve you
  readonly order?: number;        // lower updates earlier
  init?(ctx: EngineContext): void | Promise<void>;
  fixedUpdate?(dt: number, ctx: EngineContext): void;  // 30 Hz, deterministic
  update?(dt: number, ctx: EngineContext): void;       // per frame, visual only
  preRender?(ctx: EngineContext): void;                // camera is final here
  resize?(w: number, h: number, ctx: EngineContext): void;
  dispose?(): void;
}
```

`EngineContext` exposes `scene, camera, rig, renderer, time, input, events, quality,
viewW, viewH, get(name), tryGet(name)`.

**Order budget** — keep to these bands so update order stays predictable:

| Band | Systems |
|---|---|
| −100…−60 | sky, lighting |
| −50…−10 | terrain, city (static world) |
| 0…50 | battle sim, combat, morale, projectiles, AI |
| 100…150 | vfx, ragdoll |
| 200…300 | unit rendering, animation upload |
| 400…500 | audio |
| 600…800 | UI / HUD |
| 900+ | post-processing (owns the final present) |

**Determinism rule.** Anything in `fixedUpdate` must be deterministic: no
`Math.random()`, no `Date.now()`, no reads of frame time. Use `Rng` from
`src/util/rand.ts` (`rng.fork('my-system')`). Visual-only jitter in `update`/`preRender`
may use `hash01(index, salt)`.

---

## 3. Cross-subsystem contracts

### TerrainSystem (`name: 'terrain'`)
Other systems depend on these and they must not change signature:
```ts
heightAt(x: number, z: number): number             // metres above datum, bilinear
normalAt(x: number, z: number, out: Vector3): Vector3
slopeAt(x: number, z: number): number              // 0 flat .. 1 vertical
get heightField(): { data: Float32Array; res: number; spacing: number; halfExtent: number }
export const HALF_EXTENT = 1400                    // battlefield half-size, metres
```
Terrain must install `ctx.rig.heightAt` in `init` so the camera rides the ground.

### SkySystem (`name: 'sky'`)
```ts
readonly sunDirection: Vector3   // unit, ground → sun
readonly sunColour: Color        // linear
readonly ambientColour: Color    // linear
timeOfDay: number                // 0..24
setTimeOfDay(hours: number): void
```
Also expose, for anyone who needs IBL or fog matching:
```ts
environmentTexture: THREE.Texture | null   // the PMREM-processed HDRI
```

### CitySystem (`name: 'city'`) — and there is exactly one of it

**A map owns a city, or owns none.** `MapDefinition.city` is a `CityPlan | null`, and
`main.ts` registers `CitySystem` only when the map hands it one:

```ts
const plan = getMap(config.map).city;
if (plan) engine.add(new CitySystem(plan));
```

This replaces the old `hidesCity: boolean`. That flag's failure mode was invisible and it
was paid for once already: Rome's wall was built onto the plain of Pydna and merely made
invisible, so **it blocked movement across a map where it was nowhere on screen**. A flag
you must remember to set repeats that on the next map; the absence of data cannot.

**There is one `CitySystem` and it builds whichever city its plan describes.** Do not add a
sibling subsystem for a second city. The accessors the siege system reads —
`getWallStairs()`, `getGateDoor()`, `getWallSegments()`, `getGarrisonBays()`,
`getObstacles()`, `blocksMovement()`, `setGateOpen()`, `bayAt()`, `masonryTopAt()` — contain
no city-specific knowledge; they are derived from a `WallBuildOutput` and two lists of
footprints. A second implementation would fork the occupancy raster, the obstacle boxes and
the stair solids, all three of which have already shipped a bug and been fixed separately.

The contract is `src/city/cityPlan.ts`, and it is the **only** module a new city imports
from. It re-exports the wall types as `export type`, so a city's own `wall.ts` gets the
whole interface without pulling Rome's 135 KB of Aurelian geometry into the module graph.

```ts
interface CityPlan {
  id, name, siegeGateId
  garrison: Faction       // whose city it is; the storming side is derived, not named
  battlefieldZ            // no city geometry below this z, at ANY detail level
  towerWidth, towerChamberHeight
  merlonLength, crenelLength   // must match the wall's own crenellation() exactly
  gateOpenWidth
  build(heightAt): CityBuild   // { wall, chunks, footprints, lanes, landmarks, checks }
}
```

`scenario.ts` reads `name`, `siegeGateId` and `garrison` through a narrow structural view, so
`src/sim/` still does not import `src/city/`. `deployBattle` (was `deploySiegeOfRome`) puts
`garrison` on the parapet and whichever belligerent is not `garrison` in the field.

Three constraints on any city, all load-bearing in files the city workstream does not own:

- **The wall runs broadly along x and the city is at +Z.** `bayAt` indexes bays
  arithmetically in x because it runs once per projectile per tick; `scenario.ts` deploys at
  z −190 and z +130; `Siege.ts` reads `GarrisonBay.nx/nz` as the outward normal.
  `CitySystem` asserts a uniform bay pitch at build time.
- **Nothing at z < `battlefieldZ`**, checked per vertex per LOD by `assertNoStrayGeometry`.
- **220 draw calls whole-frame, and it is already exceeded.** Measured at `fbcfe65 + this
  work`: the Rome *assault* camera renders **268** at high and ultra, 227 at medium, 184 at
  low. The city's own upper bound is 89 of that (wall 37, monuments 21, fabric 20, printed by
  `CitySystem` at every boot as `[city:<id>] N draws … by family`). So the overage is mostly
  not the city — but a second city has the same ceiling as the first, not a share of it, and
  **any commit that adds city geometry must quote the ledger line.**

Directory layout: `src/city/*.ts` is shared machinery; `src/city/<cityname>/` is one city's
own geometry. Ownership is per-city-directory, so two cities can be built in parallel.

### Water is a map's to declare, and the heightfield says where it is

`MapDefinition.terrain.water` is a `WaterProfile | null` and `TerrainSystem` builds
`WaterSurface` only when a map hands it one. This replaced `hasRiver: boolean`, for the
reason `city: CityPlan | null` replaced `hidesCity`: under the flag there was exactly one
water surface in the engine — a ribbon of geometry built along the Tiber's own meander
train — so Carthage, which is a peninsula, had to answer "no". Its gulf, its lagoon and its
harbours shipped as terrain under the datum painted by the splat, and the owner's report on
the finished map was *"I see the ocean but no lagoon, it's just the beach."* A flat
desaturated plate with no specular, no animation and no depth cue reads as wet sand, and a
17:00 sun 20 degrees up is the case that reads worst.

Two properties are load-bearing and a new map should rely on both:

- **The wetted extent comes out of the heightfield, not out of an authored polygon.** Water
  is wherever the bed is under `waterLevel`, tested per pixel against the same height texture
  and the same edge-drift `TerrainMaterial` uses, so a coast cannot disagree with its own
  bathymetry and a sand bar comes out as a bar. It also means **a map cannot flood a salt
  flat**: the Sebkhet Ariana is built at +0.54 to +0.64 m and stays dry by construction.
- **One draw call for all of a map's water.** A 16 m grid with the dry cells left out, a
  coarse ring outside the battlefield so the sea runs to the horizon, and any authored basin
  welded into the same buffers with its surface height and depth per vertex. Measured at ten
  cameras on Carthage: +1 draw at every one, byrsa 281 → 282.

A basin whose bed is *built geometry* — a harbour cut into level ground — is the one thing
the bathymetric test cannot see, because the heightfield there is at quay level. Those are
declared as `basins` on the profile with their own `y` and `depth`; import the quay builder's
own `BASIN_WATER_Y`/`BASIN_DEPTH` rather than copying the numbers.

**A basin's surface is absolute and it is not a function of the bed under it.** `WaterBasin.y`
was `dy`, an offset from `heightAt(centre)`, and that put Carthage's two basins at −1.46 and
−0.04 while the gulf they both join through 21 m channels sat at 0 — because the ground
sample at the cothon's centre is +0.34 and the merchant basin's is +1.76, and neither number
has anything to do with the sea. Connected water is at one height by definition. The quay's
freeboard is then an *output* of the ground, measured by the city's own build checks, not an
input the water is derived from.

**Nothing in the simulation knows what water is**, and rendering a surface did not change
that. A man walks into the sea unless something stops him, and only two things can:

1. **A slope the pathfinder refuses.** `SLOPE_IMPASSABLE = 0.62` measured over its 7 m cell,
   so a 9 m fall in 14 m. Carthage's open coast plunges 9.5 m in 12 for exactly this reason
   and for no bathymetric one.
2. **An obstacle box from the city plan.** This is the only option for a harbour basin, whose
   quays are level with the town and whose water is two metres down: there is no scarp to
   build. **Whoever builds the quays must publish the basins through `getObstacles()` with
   `topY` at quay level, or units will march across the naval harbour.**

Both are still the only two. A rendered surface is not a collider and must never be mistaken
for one.

**But the pathfinder had a third opinion and it was the Tiber's.** `Pathfinding.ts` carried
`WATER_LEVEL = 1.5` and `MARSH_LEVEL = 3.0` as module constants described as heights above
datum. They are not: the Tiber's surface is 5.0, so they are **depths** — 3.5 m of water
drowns a man, 2.0–3.5 m is waded at 2.6× cost — and on the Campus Martius every one of the
8,205 cells the "marsh" band charges is river bed. Written as absolute heights they followed
the pathfinder onto every map and called **122,847 cells of dry Carthage water**: 110.6 ha,
14.1 % of the battlefield, the isthmus approach at the lagoon margin, the Sebkhet Ariana and
the strand. Read as depths below `terrain.waterLevel` they generalise exactly and the Campus
Martius does not move a cell.

`isWater` reads the same datum, and **a map that declares no water answers false everywhere**
— the absence of a `WaterProfile` is the absence of water, the same rule `city: CityPlan |
null` follows. Pydna's floor is +8.07 m so nothing there is affected today; the rule is there
so the next map to cut a dry gully below its own sea datum does not find a river in it.

**Rendering the water found two map bugs that painting them had hidden, and both are fixed.**
Two connected water bodies exist on Carthage — the gulf at 60.0 ha and the lake channel
behind the Taenia at 3.08 ha, x −1094..−954, z 482..842, mean depth 5.63 m. **22 building
footprints stood under the datum inside the second**, 6,689 m² of the fabric's 357,376, plus
the wall's south-anchor tower on ground at −0.75 m. The cause was that the fabric had a
coastline test in *z* — `shoreZAt`, the gulf — and none in *x*, which is where the lake is.
It tests the bed now, for the same reason the wetted extent comes out of the heightfield: a
city and a coast planned against two different curves is one bug seen from two sides.

**What is left there and is the map workstream's, not the city's: the heightfield does not
excavate the harbours.** Measured against the built basins, 51 % of the cothon's water area
and 84 % of the merchant basin's stand under terrain that is above their surface, so those
parts render as dry ground with a basin buried beneath them. The cothon's quay also clears
its own water by only 0.34 m against §6.2's 1.8, because the ground at its centre is 0.34 m
where §3.3 puts the harbour district at 2–6. Building the quay up to the design figure is not
the fix: men stand at terrain height, so a quay raised 1.5 m is a quay they walk under.

### BattleSystem (`name: 'battle'`)
The single source of truth for army state. Read freely; write only via its methods.
```ts
pool: SoldierPool          // structure-of-arrays, see src/sim/types.ts
units: UnitGroupState[]
hash: SpatialHash          // rebuilt at the top of every fixedUpdate
rng: Rng
strength: Record<Faction, number>

spawnUnit(typeId, x, z, facing, formationId?): number
unitById(id): UnitGroupState | undefined
typeOf(u): UnitTypeDef
groundAt(x, z): number
damage(i, amount, fromX, fromZ, attackerUnitId): boolean   // the ONLY way a man dies
rout(u): void
activeUnits(faction?): UnitGroupState[]
renderPos(i, alpha, out): void       // interpolated; renderers must use this
renderFacing(i, alpha): number
setFormation(u, formationId): void
```

`SoldierPool` is parallel typed arrays indexed by soldier. Key fields:
`x/y/z`, `px/py/pz` (previous tick), `vx/vy/vz`, `facing`, `prevFacing`, `lean`,
`unitId`, `faction`, `slot`, `rank`, `file`, `hp`, `maxHp`, `state`, `stateTime`,
`target`, `attackCooldown`, `fatigue`, `ammo`, `animClip`, `animTime`, `animPrevClip`,
`animPrevTime`, `animBlend`, `animRate`, `scale`, `variant`, `grime`,
`deathDirX/Z`, `deathVariant`. `count` is the high-water mark — iterate `0..count`.

`variant[i]` is a stable 0..1 hash per man. **Use it for every appearance choice**
(skin tone, beard, shield emblem, kit variant, cloak yes/no) so a man's look never
changes frame to frame.

### Animation clip table
`enum Clip` in `src/sim/types.ts` defines 24 clips (`Clip.Count`). `BattleSystem`
already selects `animClip`/`animTime` per soldier every tick. The animation system
must provide, for exactly those enum values:
```ts
clipInfo(clip: Clip): ClipInfo   // { duration, loop, hitFrame?, rootSpeed? }
```
`animTime` is **normalised 0..1 within the clip**, not seconds.

### Events
All cross-system signals are declared in `src/core/events.ts` (`GameEvents`).
Add new ones there — report the addition, don't edit the file yourself.
Notable ones you should emit or consume:
`meleeHit`, `volleyFired`, `projectileImpact`, `linesClashed`, `cavalryCharge`,
`soldierDied`, `unitRouted`, `unitDestroyed`, `unitMoraleChanged`, `orderIssued`,
`selectionChanged`, `cameraShake`, `playSound`, `musicCue`, `battleEnded`.

---

## 4. Performance budget

Non-negotiable: **60 fps at 1920×1080 on an Apple M4 Max with 6,000+ animated men
on screen.** Measured by `tools/shoot.mjs`, which prints fps, draw calls and triangles.

**Frame time is the binding constraint; the rest are proxies for it.** The triangle
figure was originally 14 M, chosen as a guess. Measured across all 15 shots at 1080p with
8,964 men, the two heaviest — the establishing shot at 14.75 M and the cavalry wing at
15.65 M — run at 174 and 70 fps respectively. So 14 M was mis-calibrated rather than the
geometry being wrong, and it is now 16 M. If a change pushes triangles up while frame time
stays inside 16.7 ms, that is fine. If frame time regresses, no triangle count excuses it.

**`renderer.info.render.triangles` counts every pass, not unique geometry.** Measured at
the cavalry camera, unique visible geometry was 10.6 M while the counter reported 35.5 M —
roughly 3.3x, because shadow cascades and the depth prepass each re-draw the scene. So the
budget above is a budget on the *reported* figure, which is the honest way to read it: it
is a proxy for total vertex work, not a model complexity count.

**The `rout` shot exceeds the triangle proxy on purpose, and that is not a bug to fix.**
It reports 18.3 M against the 16 M line while carrying only 6.97 M of unique geometry
(soldiers 2.47 M, city 2.31 M, grass 1.30 M, terrain 0.41 M) and running at 13.65 ms — 73
fps, inside the binding constraint with room to spare. The multiplier is not a constant:
it ranges from ~2.3x to ~3.3x with how much of the scene the cascades happen to span, so a
fixed absolute line on the reported figure cannot mean the same thing in two frames.
`tools/perfdiff.mjs` therefore treats an absolute triangle overage as a reported warning
rather than a failure, while still failing a triangle *regression* against a baseline —
a 25% jump means LOD selection, a culling test or a cascade bound broke, even when frame
time absorbs it. Proxies are trustworthy as derivatives, not as absolutes.

This shot exists because the other fifteen could not see the frame: `wide` is wide but
fires at t+2 before anyone has routed, and `aftermath` is late but sits at zoom 0.34 on the
corpse pile. Neither puts thousands of scattered men on screen at once. The frame also gets
*heavier as men die* — 7,879 men at t+130 render 15.03 M, 7,010 at t+171 render 18.30 M —
because a rout spreads a unit over ~120 m and pushes men who were a tight LOD2 clump across
the LOD1 boundary. Headcount is the wrong thing to reason from.

| Resource | Budget |
|---|---|
| Draw calls, whole frame | ≤ 220 |
| Triangles, whole frame | ≤ 16 M as reported by `renderer.info` |
| Soldier draw calls | ≤ 12 (instanced, one per faction × LOD) |
| Unique materials | ≤ 40 |
| Textures resident | ≤ 220 MB |
| `fixedUpdate` for 6k men | ≤ 4 ms |
| Shadow passes | ≤ 4 cascades |

Techniques that are expected, not optional: GPU instancing for every repeated object,
vertex-animation textures for soldier skinning (never `SkinnedMesh` per man), shared
materials and texture atlases, 3 mesh LODs plus a billboard impostor tier, frustum and
distance culling, and `DynamicDrawUsage` on instance buffers.

---

## 5. Assets

`public/assets/manifest.json` indexes everything downloaded, with author and licence:
```jsonc
{
  "hdris":    [{ "id", "name", "path", "author", "license", "timeOfDay", "weather" }],
  "textures": [{ "id", "name", "author", "license",
                 "maps": { "albedo", "normal", "roughness", "ao", "displacement" },
                 "resolutionPx", "tiling" }],
  "models":   [{ "id", "name", "path", "author", "license", ... }]
}
```
Everything shipped is CC0 or CC-BY with attribution recorded in `ASSETS.md`.
**Never** use assets ripped from Total War or any commercial game.
Load via `fetch('/assets/manifest.json')`; treat a missing file as non-fatal and fall
back to a procedural substitute — the game must still run with an empty asset folder.

---

## 6. Visual direction

Rome II's look, in the specifics that matter:

- **Palette.** Sun-bleached, dusty, slightly desaturated. Warm sunlight against cool
  shadow. Roman red (`#a8202a`) and gold read as the only saturated notes on the field.
- **Lighting.** Strong directional sun with long shadows, a visible warm/cool split
  between lit and shadowed surfaces, and aerial perspective that fades distant hills
  to sky colour. Never flat ambient.
- **Scale.** A man is 1.75 m. Formations are dense — men nearly shoulder to shoulder,
  0.86 m lateral spacing. Rome's walls are 6–8 m of masonry; buildings tower.
- **Ground.** Never a single tiled texture. Blend dry grass, trampled dirt, gravel,
  mud and stone by slope, height and trampling, with a detail normal that survives
  a close camera.
- **Crowds.** Variety is everything: height, kit, skin tone, shield emblem, cloak,
  beard, animation phase. Identical repeated men is the single biggest tell of a
  hobby project.
- **Atmosphere.** Dust kicked up by movement, haze with distance, god rays, birds,
  smoke. A still frame of an empty field should still look like a place.
- **Post.** Filmic tone map, bloom on highlights only, subtle vignette, fine grain,
  sharpening after AA. No crushed blacks, no orange-teal, no lens flare spam.

---

## 7. Verification — you are graded on rendered frames

```bash
npx tsc --noEmit                              # must be clean
node tools/shoot.mjs --list                   # available shots
node tools/shoot.mjs --shots=wide,romanline   # render specific frames
node tools/shoot.mjs --out=screenshots/mypass  # to a scratch directory
```
Screenshots land as PNGs plus a `report.json` with fps/draws/tris per shot.
**Read your own screenshots with the Read tool and iterate.** Text that compiles is
not the deliverable; a frame that looks like Rome II is.

The harness exposes `window.__game = { engine, battle, ready, advance(s), setCamera(x,z,zoom,yaw), simTime() }`.
Add a shot to `tools/shoot.mjs`'s `SHOTS` map only via the integrator.

---

## 8. Code standards

- TypeScript strict. No `any` without a comment explaining why.
- Comment the *why*, not the *what*. Explain a magic constant's origin; don't narrate
  `i++`. Historical or physical justifications are welcome and useful.
- No dead code, no commented-out blocks, no `console.log` left in hot paths.
- Dispose GPU resources in `dispose()`.
- Match the surrounding style: named exports, `readonly` where it holds, no default
  exports, no classes-as-namespaces.
