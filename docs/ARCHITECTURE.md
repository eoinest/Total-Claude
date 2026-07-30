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
