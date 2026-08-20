# Rendering

How the renderer actually works, for a graphics developer new to this codebase.

`docs/ARCHITECTURE.md` is the contract document — budgets and invariants that coding agents
must not break. `docs/VISUAL-RUBRIC.md` is the grading standard. Neither explains mechanism.
This does.

**Everything numeric here was measured or read at `6698e196ed84f0e456b13cf1ab04c90eeea07d55`.**
Where a number in this file disagrees with a number in the source comments or in
`ARCHITECTURE.md`, the disagreement is called out and the older figure named, because both
have been wrong before and a silent correction teaches nothing. Where a claim could not be
verified it is marked **[unverified]** and says why. Measurements were taken on a dev server
of my own on port 5311 at 1920x1080, `deviceScaleFactor: 1`, Chromium under
`--use-gl=angle --use-angle=metal`.

---

## 1. Shape of a frame

The engine is a flat list of `Subsystem`s sorted by `order` (`src/core/Engine.ts:325`). One
frame runs, in `Engine.frame` (`src/core/Engine.ts:390-470`):

1. Zero or more `fixedUpdate` passes at 30 Hz. **Not measured by the adaptive controller** —
   see §8.3.
2. `update(scaledDt)` on every system, ascending `order`.
3. `rig.update(...)` then `camera.updateMatrixWorld()` — the camera is final after this.
4. `preRender(ctx)` on every system. This is where the unit renderer fills its instance
   buffers and the lighting system refits its cascades.
5. `renderer.info.reset()`, then `renderOverride(ctx)` — which `src/main.ts:240-241` wires to
   `PostFXSystem.render`.

The rendering-relevant orders:

| order | system | file |
|---|---|---|
| −200 | `adaptive` | `src/core/AdaptiveQuality.ts` |
| −90 | `sky` | `src/render/SkySystem.ts` |
| −80 | `lighting` | `src/render/LightingSystem.ts` |
| −50 | `terrain` | `src/terrain/TerrainSystem.ts` |
| −20 | `city` | `src/city/CitySystem.ts` |
| 110 / 120 | `vfx` / `ragdoll` | `src/vfx/`, `src/sim/Ragdoll.ts` |
| **200** | **`unitRender`** | **`src/units/UnitRenderSystem.ts`** |
| 700 | `hud` | `src/ui/` |
| **900** | **`postfx`** — owns the present | **`src/render/PostFX.ts`** |

Renderer configuration is in the `Engine` constructor (`src/core/Engine.ts:216-252`):
`antialias: false` (the post chain does AA), `alpha: false`, `stencil: false`,
`outputColorSpace = SRGBColorSpace`, `shadowMap.enabled = true`, and
**`info.autoReset = false`** — the counters accumulate over every `render()` call in a frame
and are reset once, which is what makes the shadow/colour/post split in §3 exact rather than
inferred.

Two settings the engine makes and something else overrides, both deliberate:

- `renderer.toneMapping = AgXToneMapping` (`Engine.ts:247`) is set to `NoToneMapping` by
  `PostFX.init` (`PostFX.ts:432`). The post chain tone maps itself; leaving three's on would
  apply the display transform twice.
- `renderer.shadowMap.type = PCFSoftShadowMap` (`Engine.ts:250`) is set to `PCFShadowMap` by
  `LightingSystem.init` (`LightingSystem.ts:209`). `PCFSoftShadowMap` is a fixed 3x3 that
  ignores `shadow.radius`, so it cannot give a distance-varying penumbra; `PCFShadowMap` is a
  5-tap Vogel disc on a hardware comparison sampler and it honours the radius. §6.3 depends on
  this.

---

## 2. Drawing nine thousand men

`src/units/UnitRenderSystem.ts` (2,935 lines) is the centre of this. Measured on the field
battle at `ultra`, **8,632 soldiers** are deployed (35 units, into a pool sized by
`quality.maxSoldiers = 12,000`). That figure is independently quoted by
`AdaptiveQuality.ts:232` as the headcount at which `fixedUpdate` costs 3.657 ms, so the two
agree.

The whole army is drawn by, at most, **sixteen meshes**, of which the measured worst case
across the cameras probed was **four visible at once** (§3).

### 2.1 Skinning: a bone texture, not a position VAT, and never `SkinnedMesh`

`src/anim/animTexture.ts` bakes, for every (frame, bone) pair, the skinning transform

```
M = W(frame) · Wrest⁻¹
```

Both terms are rigid, so `M` is rigid, so it is a unit quaternion plus a translation: **two
RGBA texels, not three matrix rows.**

```
width  = boneCount * 2      (quaternion texel, translation texel)
height = sum of every packed clip's frame count
format = RGBA16F, NearestFilter both ways, no mipmaps
```

Clips occupy contiguous row ranges. The renderer computes absolute rows on the CPU and hands
them to the shader as instance attributes, so the shader needs no lookup table.

Measured at this SHA (by running the real `bakeAnimTexture` in the browser):

| rig | bones | clips | rows | texture | bytes |
|---|---|---|---|---|---|
| man | 24 | 44 | 1,138 | 48 x 1138 | 436,992 |
| horse | 29 | 7 | 188 | 58 x 188 | 87,232 |
| elephant | 31 | 6 | 148 | 62 x 148 | 73,408 |

**598 KB for every animation in the game.** The docblock in `animTexture.ts:36-38` says "two
textures, 350 KB total" — that predates the war elephant and half the man's clip set. The
argument it makes is unaffected: the point is that a bone texture is *per rig*, so every LOD,
every faction and every kit variant reads the same one, where a position VAT would be per
mesh and would need nine bakes for the soldier alone.

Shader cost per vertex is **2 influences x 2 frames x 2 texels = 8 fetches** on the common
path and 16 while cross-fading (`skinShader.ts:139-158`). A stock `SkinnedMesh` does 16
unconditionally. Two influences is enough because most of an armoured man is rigid plate,
mail and leather bound to one bone; only elbow, knee, shoulder and waist need a second.

Half float carries ~0.0005 of angular error on a quaternion component and about a millimetre
of translation at these magnitudes, both an order of magnitude below what a 1600 px frame
resolves.

### 2.2 Instancing

`InstancedBufferGeometry` with hand-rolled attributes, **not `InstancedMesh`** — a per-instance
matrix would be 16 floats of upload per man for a transform the shader rebuilds from a yaw and
a scale in four instructions.

The layout, from `Stride` (`UnitRenderSystem.ts:93-102`) and the declarations in
`skinShader.ts:96-108`, which must agree:

| attribute | floats | contents |
|---|---|---|
| `iPos` | 3 | world position |
| `iOrient` | 4 | yaw, scale, lean (or corpse settle), grime |
| `iAnimA` | 4 | row0, row1, frac, blend — current clip |
| `iAnimB` | 4 | row0, row1, frac, **variant** (the man's stable hash) — outgoing clip |
| `iKit` | 2 | piece mask, bits 0–23 and 24–47 |
| `iCol0` | 4 | tunic rgb, shield emblem index |
| `iCol1` | 4 | leg rgb, metal class + polish packed in one float |
| `iQuat` | 4 | full-body orientation for a corpse; zero for the living |

29 floats = **116 bytes per instance**. Every attribute is `DynamicDrawUsage`.

`iKit` is a 48-bit mask across two floats and there are **46** `Piece` ids, so it fits with two
to spare. A piece the man does not wear collapses to `vec3(0.0)`: all three corners of such a
triangle land on the same vertex, so it has zero area and never reaches the rasteriser
(`skinShader.ts:170-176`).

Buffers are allocated at `cap = quality.maxSoldiers` for soldiers, `max(256, cap * 0.25)` for
horses, 64 for elephants and 64 for each engine kind. At ultra:

```
soldiers   9 tiers x 12,000 x 116 B = 12,528,000
horses     3 tiers x  3,000 x 116 B =  1,044,000
impostor   1 tier  x 12,000 x  44 B =    528,000
elephants  1 tier  x     64 x 116 B =      7,424
engines    2 tiers x     64 x  44 B =      5,632
                                     -----------
                                      14,113,056 B  (~13.5 MiB)
```

Texture side: three atlas sheets (albedo, normal, packed ORM) at **2048 x 1536** — about 50 MB
resident with mips, per the measured note at `atlas.ts:46-47`, against the 220 MB budget.
(The header comment at `atlas.ts:8` still says "One 1024x1024 albedo" and `atlas.ts:13` says
"1024 x 1536"; `ATLAS_W` is 2048. Both lines are stale.)

### 2.3 What the vertex shader does, in order

`src/anim/skinShader.ts`, `body()` at line 1055 onward:

1. **Weapon jitter** on the *rest* pose, about the rest position of the hand
   (`soldierWeaponJitter`, line 200). Pole arms get `k = 0.30`, blades `k = 0.13`. Conjugating
   a rotation by the bone transform preserves its angle, so a fan authored in rest space is
   the same fan in the posed frame and it costs no extra bone fetches.
2. **Skin** — two bones, two frames, cross-fade (`soldierSkin`, line 138).
3. **Pose micro-variation** (`soldierPoseVary`, line 234), skipped for corpses because the
   ragdoll solver owns every joint of a fallen body. Ten decorrelated hashes drive build,
   two arm carriages, three head axes, torso yaw, shoulder roll and plumb. See §9.1 — the
   head's third axis is the fix this release shipped and the shield did not get.
4. **Kit mask** collapse.
5. **Cloak sway** — two incommensurate sine waves in body space, ramped from the shoulder line
   (1.50 m) to the hem over 0.76 m and squared, plus a lean-driven drag. Phase from the man's
   stable hash, and the whole term is a function of `uTime` only, so it lives outside the fixed
   step and cannot perturb the simulation hash.
6. **Scale**, then either the corpse branch (rigid quaternion from the ragdoll plus a world-Y
   squash whose factor rides in `iOrient.z`) or the living branch (**lean as a bend**, ramped
   `(y / leanHeight)²` so the feet stay planted, then yaw).

Every one of those is first-order: `SOLDIER_TILT(a, b, k)` is a rotation with the cosine
dropped, which at the under-12-degree angles used here costs 2% of scale — a third of a
millimetre on a forearm — and saves two transcendentals per axis in what is by a wide margin
the busiest vertex shader in the frame.

### 2.4 LODs, the impostor, and where the transitions sit

Three mesh LODs per faction plus a billboard. **Measured triangle counts** (running the real
`buildSoldierGeometry` etc. in the browser at this SHA):

| geometry | LOD0 | LOD1 | LOD2 |
|---|---|---|---|
| soldier, Rome | 4,972 | 2,794 | 313 |
| soldier, Germanic | 4,029 | 2,278 | 313 |
| soldier, Carthage | 6,406 | 3,748 | 313 |
| horse | 1,021 | 582 | 472 |
| war elephant | 3,457 (no LOD chain) | | |
| impostor quad | 2 | | |
| scorpio / onager | 7,635 / 4,734 (no LOD chain) | | |

> **Correction.** The docblock at `UnitRenderSystem.ts:107-121` says "LOD1 is 2,012-2,314
> triangles against LOD2's 313". That range is stale: LOD1 now runs 2,278–3,748. Its
> conclusion holds and gets stronger — the LOD1→LOD2 step is **7.3x to 12x**, not "seven
> times". The corpse-promotion note at `UnitRenderSystem.ts:2138-2141` ("4,135 triangles down
> to 2,314") is near-right for the Germanic mesh and wrong for the other two.
>
> Likewise `UnitRenderSystem.ts:836-843` quotes "8.2 k triangles for a scorpio and 4.7 k for
> an onager"; the onager is right, the scorpio is **7,635**. A four-gun battery is 30.5 k, not
> 33 k, and the 64-machine ceiling is 489 k, not 525 k.

Band edges are fractions of the quality tier's `lodFarDistance`
(`UnitRenderSystem.ts:1475-1502`):

```ts
export const LOD_FRACTION = [0.14, 0.4, 2.0];
const impostorEdge = this.distanceForPixelHeight(ctx, IMPOSTOR_MIN_PX);   // 4.5 px
this.lodDist = [far * 0.14, far * 0.4, Math.max(far * 2.0, impostorEdge)];
```

`distanceForPixelHeight` inverts the perspective projection for a 1.75 m man:
`d = viewH * 1.75 / (2 * px * tan(fov/2))`. It is derived rather than tabulated because the
quantity is a *legibility* threshold — it depends on the player's pixel count and lens and on
nothing else.

**Measured at 1920x1080, all four tiers:**

| tier | `lodFarDistance` | LOD0→1 | LOD1→2 | LOD2→impostor |
|---|---|---|---|---|
| low | 90 | 12.6 m | 36 m | **500.4 m** |
| medium | 140 | 19.6 m | 56 m | **500.4 m** |
| high | 220 | 30.8 m | 88 m | **500.4 m** |
| ultra | 320 | 44.8 m | 128 m | **640 m** |

So the 4.5 px floor binds at low, medium and high; at ultra `2.0 x far` is further out and
wins. That asymmetry is the whole point of the `max`: before it, the billboard edge was
`far * 2.0` everywhere, which put a man at 13.2 / 8.5 / 5.4 / 3.7 px at the four tiers — only
ultra met the criterion the design was written against, and **89% of visible men were
billboards at `high`**, which is why a player reported that most of their army was invisible
under its own banners.

> **Correction.** `UnitRenderSystem.ts:130-134` says 4.5 px "at 1080p and a 43 degree lens
> puts the edge at 526 m". The measured value is **500.4 m**, which corresponds to a 45.5°
> vertical FOV. `RTSCamera.fovForZoom` is `lerp(32, 52, smoothstep(zoom))`, so the number
> depends on where the camera happens to be — and note that **it does not track zoom**:
> `applyQuality` is called only from `init` and `resize` (`UnitRenderSystem.ts:877, 1504`), so
> the impostor edge is fixed at whatever the FOV was at boot, and moves again only on a window
> resize or a tier switch. That is defensible for a legibility floor and is not documented
> anywhere in the source.

Selection, per man, in `preRender` (`UnitRenderSystem.ts:2093-2160`):

- **Hysteresis.** `LOD_HYSTERESIS = 0.12`: a man coarsens only once he is 12% past an edge and
  refines only once he is 12% inside it, so a slow camera pan cannot pop a whole rank back and
  forth.
- **Cull** against the camera frustum with a per-instance sphere. Radius is 1.25 m standing,
  1.5 m for a corpse, 1.9 m for cavalry, 3.6 m for an elephant, **plus
  `SHADOW_CULL_MARGIN = 4.5 m`** — a culled man is absent from the shadow cascades as well as
  the colour pass, and with the sun at 27° a 1.8 m man throws 3.5 m of shadow, so a man that
  far outside the frustum still owns pixels inside it. A bigger bound costs instances, never
  draw calls.
- **A settled corpse is drawn one tier coarser**, but only out of LOD0, and never as far as
  the billboard — that quad is a standing man and a corpse promoted into it would get up off
  the ground. The tier he *would* have had stays in `lodOf`, so a corpse the camera walks up to
  refines exactly as a living man does.
- **A mounted man never reaches the billboard tier** (`lod === 3 && cav → lod = 2`): the sheet
  is a standing infantryman and no horse is drawn behind it.

The billboard itself (`src/units/impostor.ts`): at load, LOD1 is rendered from **8 yaws x 3
factions** into a `1024 x 768` atlas of `128 x 256` tiles, in a mid-march pose, using the real
skinned material — so the impostor is literally the same shape, kit and shading as the mesh it
replaces, just pre-rasterised. The runtime material is `MeshBasicMaterial` *on purpose*,
because the atlas already carries baked sun and sky; re-lighting it would double the light.
Fog still applies, which matters, because the far tier is exactly where aerial perspective does
its work. Mipmaps are generated and `LinearMipmapLinearFilter` is mandatory: point-sampling a
128x256 tile at four pixels makes most fragments miss the man and fail the alpha test, and a
whole army fades to nothing.

### 2.5 Upload

`flush()` (`UnitRenderSystem.ts:2873-2918`) does two things per tier:

```ts
t.geometry.instanceCount = n;
t.mesh.visible = n > 0;
```

and then, for each attribute, `clearUpdateRanges()` / `addUpdateRange(0, n * stride)` /
`needsUpdate = true` — one contiguous block, not a scattered dirty set. The impostor tier
skips the animation, kit, col1 and quat attributes entirely (`push(t, /* full */ false)`),
because a billboard has no skinning.

`mesh.frustumCulled = false` on every tier: culling is per instance on the CPU, and three's
object-level test would either cull the whole army or never cull anything.

Each tier carries `customDepthMaterial` and `customDistanceMaterial` from the same
`SoldierMaterialSet`, patched with the same injection minus the normal path. Without them,
8,632 men would cast T-posed shadows from wherever the mesh origin happens to be.

---

## 3. The draw-call budget

**The cap is 220 whole-frame** (`ARCHITECTURE.md`, "Resource / Budget" table), with a
sub-budget of "≤ 12 soldier draw calls".

`tools/probe-budget.mjs` instruments `WebGLShadowMap.render` and `WebGLRenderer.render`
separately and differences `renderer.info.render.calls` across each. Because
`info.autoReset = false`, that split is exact. Draw counts are deterministic and
load-independent, which is why they and not frame time are the right thing to gate on.

### 3.1 Measured at `6698e19`

Rome, `scenario=assault`, 1920x1080, t+72 s:

| camera | tier | colour | shadow | post | **total** |
|---|---|---|---|---|---|
| assault (boot framing) | ultra | 100 | 81 | 23 | **204** |
| | high | 100 | 81 | 23 | **204** |
| | medium | 100 | 60 | 23 | **183** |
| | low | 100 | 41 | 15 | **156** |
| city | ultra | 102 | 80 | 23 | **205** |
| wall | ultra | 92 | 87 | 23 | **202** |

Campus Martius field battle, 1920x1080, t+72 s:

| camera | tier | colour | shadow | post | **total** |
|---|---|---|---|---|---|
| clash | ultra | 43 | 62 | 23 | **128** |
| | high | 45 | 70 | 23 | **138** |
| | medium | 45 | 53 | 23 | **121** |
| | low | 45 | 35 | 15 | **95** |
| romanline | ultra | 39 | 45 | 23 | **107** |
| | medium | 39 | 34 | 23 | **96** |
| | low | 39 | 23 | 15 | **77** |
| wide | ultra | 47 | 50 | 23 | **120** |

Carthage, `scenario=assault`, boot camera, ultra: **186** = 88 colour + 75 shadow + 23 post,
12.27 M triangles.

Three structural facts fall straight out of that table.

**The colour pass is tier-invariant.** 100 at every tier at the assault camera, 39 at every
tier at romanline. A quality tier changes nothing about which meshes are submitted; it changes
the cascade count, the shadow map size, and which post passes run.

**The post chain is a fixed cost per tier**: 23 at ultra/high/medium, 15 at low. Low turns off
SSAO, which takes the AO pass, its two blur passes, the contact-shadow pass and its two blurs
out of the chain, along with DoF, motion blur and god rays.

**The shadow pass is very nearly cascade-invariant.** Divide it by the cascade count:

| camera | shadow / cascade |
|---|---|
| Rome assault | 81/4 = 20.3 · 60/3 = 20.0 · 41/2 = 20.5 |
| field romanline | 45/4 = 11.3 · 34/3 = 11.3 · 23/2 = 11.5 |

Cascade 0 covers a few tens of metres and cascade 3 covers hundreds, and they draw the same
objects, because every caster in these scenes is a merged mesh whose bounding sphere straddles
all four. So:

> **A shadow-casting mesh costs one draw call in the colour pass and one more in every
> cascade.** On ultra that is five. Splitting a chunk into one mesh per material saves nothing
> in the shadow pass, because every one of them resolves to the same opaque depth material —
> see `buildShadowProxy` in `CitySystem.ts`, which merges them back into one.

### 3.2 Where the soldier calls go

The soldier group allocates **sixteen meshes**: 3 factions x 3 mesh LODs = 9, plus 3 horse
LODs, plus 1 elephant, plus 1 impostor sheet, plus 2 engine kinds. `flush` sets
`mesh.visible = count > 0` every frame, so **the budget is spent on what is on screen and not
on what exists**. Measured, at 1920x1080 ultra t+72 s:

| scenario / camera | soldier meshes drawn | instances | tiers occupied |
|---|---|---|---|
| field, boot (orbit 323 m) | **3** | 9,202 | Rome LOD2 3,727 · Germanic LOD2 4,860 · horse LOD2 615 |
| field, wide | **3** | 7,294 | Rome LOD2 3,282 · Germanic LOD2 3,572 · horse LOD2 440 |
| field, clash | **4** | 1,223 | Rome LOD0 320 / LOD1 320 · Germanic LOD0 250 / LOD1 333 |
| field, cavalry | **3** | 864 | Rome LOD0 15 / LOD1 338 · Germanic LOD1 511 |
| field, romanline | **1** | 182 | Rome LOD2 182 |
| Rome assault, boot | **3** | 2,029 | Rome LOD2 1,150 · Germanic LOD2 782 · horse LOD2 97 |
| Carthage assault, boot | **4** | 3,180 | Rome LOD1 307 / LOD2 1,212 · Carthage LOD2 1,550 · horse LOD2 111 |

Nine thousand men, three draw calls. The ≤ 12 sub-budget is not close to binding: the worst
case observed was four, and a scenario cannot field three factions at once. Note that
instances exceed men — a rider is two instances that have to agree to the centimetre, and an
elephant is one instance for the animal plus four for the tower crew and mahout, none of which
exist in the simulation.

### 3.3 Which levers move it

In descending order of what they are worth, and ascending order of what they cost to operate:

1. **Cascade count.** At the Rome assault camera, one cascade is worth **~20 draws**; at the
   field cameras, ~11. It is also the most expensive lever to *operate*: it changes
   `NUM_DIR_LIGHT_SHADOWS`, which is compiled into every lit material, so a change is several
   hundred milliseconds of link time. `AdaptiveQuality` deliberately excludes it
   (`AdaptiveQuality.ts:191`); it is a settings-menu decision.
2. **Chunk count in the city.** The colour pass is almost entirely city geometry: 62 of 100 at
   Rome's assault camera, 51 of 88 at Carthage's. Small chunks give real LOD and real frustum
   culling; large chunks give few calls.
3. **The post chain**, but only in the 23 → 15 step at `ssao: false`.
4. **Nothing the soldier renderer does.** Three to four calls is not where a frame goes.

> **Corrections to `ARCHITECTURE.md` §4.** All three of these are worth carrying into the next
> revision of that file:
>
> - The **219** figure for the Rome assault camera at ultra (98 colour + 98 shadow + 23 post)
>   was measured at `a974a28`. At `6698e19` it is **204** (100 + 81 + 23). The interactive
>   panning figure of 226 was not re-measured. **[unverified]**
> - "one cascade off ultra is worth about 39 draws" does not reproduce. Measured
>   per-cascade cost at that camera is **~20**.
> - "**Carthage is now the over-budget map** … renders **242** at ultra: 134 colour + 85 shadow
>   + 23 post" no longer holds. At `6698e19` its assault camera renders **186** = 88 + 75 + 23,
>   with the whole city accounting for 51 colour calls rather than the 157-call `fabric` family
>   that section describes. Whatever fixed it, the section now describes a problem that is not
>   there.
> - The explanation of the ~3.3x gap between `renderer.info.render.triangles` and unique
>   geometry — "because shadow cascades **and the depth prepass** each re-draw the scene" — is
>   wrong about the prepass. **There is no depth prepass** (`PostFX.ts:14-16`): the depth
>   texture is the scene target's own attachment, and view normals are reconstructed from it.
>   The multiplier is the cascades alone, which is why it is not a constant: casters are drawn
>   1 + cascades times and non-casters (terrain, grass) exactly once.

---

## 4. Materials: the house rule

> **Patch `MeshStandardMaterial` through `onBeforeCompile`. Never write a raw
> `ShaderMaterial` for a lit surface.**

This is stated in four places in the source independently
(`skinShader.ts:5-20`, `TerrainMaterial.ts:13-16`, `engineMaterial.ts:11`,
`city/materials.ts:391-394`) and it is not a style preference. It is enforced by what
`LightingSystem` can and cannot see.

### 4.1 The mechanism

`LightingSystem.discoverMaterials` traverses the scene every 16 frames and calls
`setupMaterial` on everything `affectedByLights` returns true for
(`LightingSystem.ts:430-446`):

```ts
private affectedByLights(m: THREE.Material): boolean {
  switch (m.type) {
    case 'MeshStandardMaterial':
    case 'MeshPhysicalMaterial':
    case 'MeshPhongMaterial':
    case 'MeshLambertMaterial':
    case 'MeshToonMaterial':
      return true;
    default: break;
  }
  // A hand-written ShaderMaterial that pulls in the lighting template still
  // needs the cascade uniforms, and there is no flag for that any more.
  const fs = (m as THREE.ShaderMaterial).fragmentShader;
  return typeof fs === 'string' && fs.includes('lights_fragment_begin');
}
```

`setupMaterial` is what grants `USE_CSM`, `CSM_CASCADES`, `CSM_FADE`, the soft-shadow define,
the cloud-shadow define, and the four shared uniform objects. **A material it does not reach
gets none of them.** And a material that misses it does not fail loudly: it renders, it just
renders wrong. A `MeshStandardMaterial` that somehow escaped discovery would render *four times
too bright*, because CSM's non-CSM branch sums all directional lights and there are `cascades`
of them. A raw `ShaderMaterial` with its own lighting simply carries on with its own lighting.

Everything `setupMaterial` does is chained, not replaced: the material's original
`onBeforeCompile` is stashed in a `WeakMap` and re-wrapped from the *original* on every
rebuild, so cycling the quality tier six times does not stack six closures.

### 4.2 What it cost, and where the bill arrived

Round one of the paired blind instrument came back **14 of 14 for three independent graders**,
and all three named the unit standard as the single most decisive tell. Their words were "an
emissive sticker in front of the frame rather than dyed wool under the same sun". That turned
out to be literal.

> Round two closed the loop the only way a blind instrument can: a grader told nothing about
> this fix **volunteered the cloth as good**. Recorded in `tools/ab-results.json`. The deck
> still came back 14/14 — see §9 for why those two facts are not in tension.

The cloth was a raw `ShaderMaterial` with a hand-written sun-plus-ambient term — a second,
undocumented lighting rig that nobody updated when the first one changed. It had drifted in
four ways at once (`BannerSystem.ts:129-162`, and commit `bf75fb0`):

1. **It never received a shadow.** `affectedByLights` accepts a `ShaderMaterial` only if its
   source mentions `lights_fragment_begin`, and this one did not. So it never got `USE_CSM`,
   never sampled a cascade, and **a standard stood in full sun inside the shadow of the wall it
   was assaulting.**
2. **It never cast one.** No custom depth material, so `castShadow` could not be turned on, so
   nothing was ever thrown down onto the bearer.
3. **It ignored the sun's intensity.** `VFXSystem` fed it `sky.sunColour`, which is a
   *chromaticity* — the magnitude lives in `sky.sunIntensity` and was dropped on the floor. So
   the cloth was lit at full noon strength at every hour of the day while everything around it
   tracked the real sun. That is precisely "the reds refuse the scene's dusk grade", and it is
   worst at the low sun the grading deck is mostly shot under. See §5.3.
4. **It took no `scene.environment`, no `envMapIntensity` and no aerial perspective.**

The fix is not four fixes. It is one: be a `MeshStandardMaterial`. All four come back and
cannot drift again, because there is only one lighting rig left.

What stays hand-written is only what the standard model genuinely lacks — transmission through
thin dyed wool, and the UV-space fold field:

```glsl
float tcBack = clamp( dot( - normal, uSunDir ), 0.0, 1.0 );
reflectedLight.directDiffuse += material.diffuseColor * uSun_E * RECIPROCAL_PI
  * pow( tcBack, 1.6 ) * 0.62;
```

Note `uSun_E` — irradiance, `sunColour * sunIntensity`, tagged per §5 — so unlike the term it
replaced, it goes out when the sun does.

The same commit fixed the helmet highlight (§9.1). Both are the same class of bug: a symmetry
nobody had noticed, and a second copy of something that should only exist once.

### 4.3 Where a raw `ShaderMaterial` is still correct

A census of the whole of `src/`:

```
16  new THREE.MeshStandardMaterial      7  new THREE.MeshBasicMaterial
 5  new THREE.MeshDepthMaterial         2  new THREE.MeshDistanceMaterial
 1  new THREE.MeshLambertMaterial       0  new THREE.MeshPhysicalMaterial
10  new THREE.ShaderMaterial
```

Every one of the ten `ShaderMaterial`s is a legitimate exception, and the pattern is that none
of them is a lit surface in the scene:

| file | what it is |
|---|---|
| `render/PostFX.ts:580` | the factory for every fullscreen post pass — unlit by definition |
| `render/SkySystem.ts:450, 502` | the atmosphere cube bake and the sky background quad — this *is* the light source |
| `vfx/ParticleSystem.ts:428`, `vfx/DecalPool.ts:159`, `vfx/BirdFlock.ts:238` | unlit or hand-shaded VFX |
| `vfx/GroundDamage.ts:299` | the offscreen splat that accumulates the damage field into a render target. The *visible* trampled ground at `:369` is a patched `MeshStandardMaterial` |
| `ui/WorldOverlay.ts:218, 231` | unlit world-space UI markers |
| `viewer/grade.ts:78` | the model viewer's copy of the tone-grade pass |

`GroundDamage` is the cautionary case: it used to be the other way round. A raw
`ShaderMaterial` with no shadow term, drawn *over* shadow-receiving terrain at up to 0.96
alpha, painted the terrain's shadow back out wherever men had churned the ground. A blind
critic reading `romanline` found a hard vertical boundary through the crowd, long crisp
shadows on one side and none on the other, and called it the most damning artefact in the set
(`GroundDamage.ts:76-100`).

### 4.4 Injection hygiene

Anything patching a material must:

- **Chain, never replace.** `LightingSystem` does; `partsDebug.ts:98` does; so must you.
- **Set `customProgramCacheKey`.** Two patched materials with different injected source and the
  same key will share a compiled program and one will silently get the other's shader.
  Examples: `soldier-skin-v7metal-${variant}-${rig}` (the pose-variation flag is in the key
  because the man has it and the horse does not), `terrain-clipmap-splat-v3-...`,
  `soldier-impostor-v1`.
- **Patch the depth and distance materials too**, or the shadow pass will not deform the way
  the colour pass does.
- **Not fail silently.** A shader that fails to compile draws nothing at all, which is an
  expensive way to find out. `skinShader.ts:161-166` declares `SOLDIER_CLOTH_TILT` outside the
  `SOLDIER_POSE_VARY` block for exactly this reason — the horse compiles without that define
  and would otherwise reference an undeclared identifier. `LightingSystem.installShaderChunks`
  goes further and `throw`s if CSM's `getShadow` call text is not found, rather than shipping a
  chunk it failed to patch.

---

## 5. Colour space and radiometric units

### 5.1 The rule

The canonical statement is a doc block in `src/shaders/common.glsl.ts:115-144`. It exists
because **three separate display-versus-linear confusions were found in one session, in three
systems, by three authors**:

- `probe-units.mjs` compared a display-referred threshold against a linear readback, and
  reported soldiers rendering at "2-4% of display luminance" when the true figure was
  0.157–0.207 display. That misdirected three rounds of work: three successive fixes each
  measured a real gain and each still felt like nothing, because they were sized against a
  target eight times too far away (`CHANGELOG.md:1034-1043`).
- The hemisphere fill was handed a *radiance* where three.js consumes an *irradiance*, losing
  a factor of π and putting the two ambient paths in different units, so tuning either
  silently disagreed with the other (commit `95b7f5d`).
- `PostFX`'s `uSplit` held display-referred numbers and was tested against linear luminance.
  The frame's median is 0.30 display, which is 0.073 linear, and `smoothstep(0.05, 0.48,
  0.073)` is **0.008** — so every pixel in the frame took the shadow tint, the highlight tint
  was never applied, and a grade built to deliver 1.887 delivered 1.107 (commit `93c30c6`).

Each was invisible on inspection, because `0.48` and `float l` look equally plausible next to
each other whichever space either is in. So:

> **Any identifier holding a quantity whose space or unit is not forced by its type carries a
> suffix, and the only way to cross a boundary is a function named for the crossing.**
>
> | suffix | meaning |
> |---|---|
> | `_disp` | display-referred, sRGB-encoded — what a screenshot measures |
> | `_lin` | linear-light, working space — what shading maths wants |
> | `_L` | radiance (per steradian) — what a sky integral returns |
> | `_E` | irradiance (already integrated over the hemisphere; `E = π · L` for uniform `L`) |

The two axes are orthogonal: `_disp`/`_lin` is about *encoding*, `_L`/`_E` is about *physical
quantity*. In practice they are never combined, because radiometric quantities in this renderer
are linear by construction.

A comparison, a mix or an add between two differently-suffixed names is then a visible error in
the diff rather than a plausible-looking line, and the reviewer does not have to trace
provenance to check it.

### 5.2 The rule as practised, which is not quite the rule as written

This matters if you are about to follow it, so it is worth being exact.

**What is tagged, exhaustively:**

| suffix | identifier | where | what it holds |
|---|---|---|---|
| `_disp` | `uSplit_disp` | `PostFX.ts:148, 224, 268` | grade split thresholds, display sRGB |
| `_disp` | `luma_disp`, `chroma_disp` | `tools/probe-water.mjs:267` | 8-bit readback statistics |
| `_lin` | `shallow_lin`, `deep_lin`, `foam_lin` | `WaterSurface.ts:94-97`, `maps/carthage.ts:67-69`, `maps/campusMartius.ts:41-43` | linear-light water colours |
| `_lin` | `sky_lin` | `WaterSurface.ts:537` | GLSL local |
| `_E` | `uSun_E` | `BannerSystem.ts:228, 318, 365, 1311` | `sunColour * sunIntensity` |
| `_L` | — | — | **never used on a real identifier** |

Four caveats:

1. **Three of the doc block's four worked examples do not exist.** `lumaLin`, `skyFill_L` and
   `groundBounce_E` appear only in the comment. The real identifiers are `skyFillColour`
   (`SkySystem.ts:116`) and `groundBounceAlbedo` (`SkySystem.ts:123`), both untagged — and
   `skyFillColour` is precisely the mean-radiance value `skyFill_L` was naming.
2. **The separator is always `_lin`, never `Lin`,** despite the doc block's own `lumaLin`.
3. **Nothing in `SkySystem.ts` carries a suffix at all,** including the value at the centre of
   the π bug. Its space and unit are carried in prose.
4. **Enforcement is code review and nothing else.** Verified negative: there is no ESLint
   config in the repo, no test framework (`package.json` has no `test` script), no type brand,
   no tool in `tools/` that greps for the suffixes, and no `.github/`. The only automated gate
   is `tsc --noEmit`, which is blind to naming. The doc block's own closing line concedes this
   — "the rest is worth doing as files are touched rather than in one sweep."

The convention paid for itself immediately regardless: renaming `uSplit` surfaced a stale
`uniforms.uSplit` lookup in `probe-lighting.mjs` that would have silently skipped its arm and
reported a no-op.

**As a contributor, do this:** if you introduce a colour, a luminance or a light quantity whose
space is not obvious from its type, tag it. If you consume one that is not tagged, read the
prose at its declaration before you use it — particularly anything from `SkySystem`.

### 5.3 The `sunColour` / `sunIntensity` contract

The single most misused pair in the renderer, and the one with no doc comment at its
declaration.

```ts
readonly sunColour = new THREE.Color(1, 0.94, 0.82);        // SkySystem.ts:111 — no comment
/** Perpendicular sun irradiance in render units — the directional intensity. */
sunIntensity = 3;                                            // SkySystem.ts:113-114
```

`sunColour` is **a chromaticity normalised to unit Rec.709 luminance**. That is not documented
where it is declared; it is only establishable by following the write to
`atmosphere.ts:443-455`:

```ts
const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
out.setRGB(r / lum, g / lum, b / lum);
return lum;
```

So `0.2126·r + 0.7152·g + 0.0722·b = 1` by construction, individual channels routinely exceed
1.0, and **the magnitude lives entirely in `sunIntensity`.** Two exceptions: the literal at
line 111 has luminance 0.9441 and is only normalised after the first `applyTime()`; and the
below-horizon branch returns `(0.4, 0.5, 0.8)` with intensity 0, so the value is scaled away.

`sunColour * sunIntensity` is the sun's perpendicular irradiance vector. That product is
exactly what goes into `uSun_E`, and dropping the second factor is what lit a banner at noon
strength at every hour of the day.

`ambientColour` (`SkySystem.ts:112`) is a pure alias of `skyFillColour`, kept as "the
historical contract name". It is a **cosine-weighted mean sky radiance** and does not carry the
π. Exactly one of its five consumers applies the π: `LightingSystem.ts:473-476`, for the
hemisphere fill. `VFXSystem.ts:531`, `UnitRenderSystem.ts:1416` and `WaterSurface.ts:383`
consume it raw. Those three are hand-tuned art paths rather than physical solves, so this is
not necessarily wrong — but it is the exact shape of the π bug, on an untagged value.
**[unverified: whether the three raw consumers are intentional. No comment anywhere says.]**

---

## 6. Lighting and shadows

`src/render/LightingSystem.ts` (675 lines). The rig is four lights and a probe:

| term | object | what it is |
|---|---|---|
| sun | `CSM.lights[0..n]` | cascaded directional, `color = sky.sunColour`, `intensity = sky.sunIntensity` |
| sky fill | `HemisphereLight` | upper half from the atmosphere integral, lower half a Lambertian ground bounce |
| warm bounce | `DirectionalLight`, unshadowed | the sun mirrored through a near-horizontal plane |
| IBL | `scene.environment` | PMREM of the same atmosphere cube the player is looking at |

### 6.1 Cascades

Built on `three/addons/csm/CSM.js`, extended rather than reimplemented
(`LightingSystem.ts:212-240`):

```ts
cascades:        clamp(round(q.shadowCascades), 1, 4)     // 2 / 3 / 4 / 4 by tier
shadowMapSize:   Math.min(q.shadowMapSize, 2048)
mode:            'custom'
lightIntensity:  3
lightNear: 1,  lightFar: 6000,  lightMargin: 400
fade:            true
```

Note the **`Math.min(..., 2048)`**: ultra's `shadowMapSize: 4096` is clamped. Four cascades at
4096 would be 268 MB of shadow memory for no visible gain once the splits are this tight; 2048
gives ~2.4 cm/texel in cascade 0.

Four things are added on top of the addon:

**Custom split distribution.** The addon's `practical` mode derives its logarithmic term from
`camera.near`, and `RTSCamera` swings near from 0.08 m to 4 m with zoom, which makes the split
distances jump as the player zooms. `computeSplits` blends uniform and logarithmic against a
*fixed* nominal near of 1.5 m with `SPLIT_LAMBDA = 0.82`, so the boundaries are stable.

**A cascade range that follows the camera.** `maxFar` is not a constant:

```ts
const want = clamp(220 + ctx.rig.orbitRadius * 1.5, SHADOW_FAR_MIN /*460*/, SHADOW_FAR_MAX /*2100*/);
```

A fixed 460 m put *every* pixel outside the cascades at strategic zoom, where the eye is past
1 km, and the whole battlefield went shadowless — the one view where a raking sun should be at
its most legible, because from above a long shadow is the only thing that gives the ground
relief.

**Per-cascade bias, recomputed every frame from the fitted ortho extents.** The addon applies
one `shadowBias` to every cascade, and depth bias has to scale with the texel footprint or the
near cascade peter-pans while the far one still acnes:

```ts
const texel = (cam.right - cam.left) / csm.shadowMapSize;
l.shadow.bias       = -(texel * 0.6) / (cam.far - cam.near);
l.shadow.normalBias = Math.min(texel * 1.6, MAX_NORMAL_BIAS /* 0.09 */);
```

The `MAX_NORMAL_BIAS` cap is load-bearing. The outer cascade's texel is a quarter of a metre and
1.6 of them is 0.4 m — wider than a man — so **every shadow past ~140 m was being pushed off
its caster and vanishing**, which is most of the crowd in any shot wide enough to see a battle
line. 0.09 m is under a boot length, so it still cannot lift a contact shadow visibly, and the
depth bias plus PCF absorbs the acne the shortfall lets through.

**Cloud shading.** `lights_fragment_begin` is re-patched so
`directLight.color *= tcCloudShadow(geometryPosition)` runs right after
`getDirectionalLightInfo`, which means a cloud dims direct sun only and never the ambient —
exactly like the real thing.

The chunk surgery in `installShaderChunks` (`LightingSystem.ts:306-360`) is worth reading before
you touch it. CSM's chunk ends with a `!defined(USE_CSM)` fallback loop for materials that never
opted in, and `tcSoftShadow` is declared only under `USE_CSM`; rewriting the call text *there*
took out every such material with `'tcSoftShadow' : no matching overloaded function found`. So
the rewrite is confined to the text before that guard.

### 6.2 Rebuilding on a tier switch

`resize` returns early unless the cascade count changed; if it did, `rebuild` tears the whole
rig down and re-inits. The order matters and there is a scar here:

```ts
this.csm?.remove();    // detaches the cascade lights from the scene
this.csm?.dispose();   // frees GPU resources only
```

Disposing without removing left every previous cascade set parented to the world. Measured on
ultra → medium: shadow-casting directional lights went **4 → 7**, so the shader unrolled the
cascade loop `NUM_DIR_LIGHT_SHADOWS = 7` times while `CSM_CASCADES` had been rewritten to 3,
every lit material failed to link with `'[]' : array index out of range`, and the entire world
rendered empty — no terrain, no city, no men, only the DOM HUD floating over grey. That is the
whole of the bug report "the banners only work on ultra": ultra is the tier the game boots at,
so it is the only one a player ever saw with the world still drawn. `ultra → high` never broke
because both carry 4 cascades, which is why it looked tier-specific rather than
switch-specific. `tools/probe-tiers.mjs` walks every transition that changes the cascade count.

The same section is why every define is set *and cleared*. `TC_SOFT_OFF` was added on the way
down to low and not deleted on the way back up, leaving ultra rendering with the cheap
fixed-texel PCF: a round trip ultra → low → ultra came back **1.34/255** away from a cold boot
at ultra, all of it the missing penumbra, and every further switch preserved the wrong state.

### 6.3 PCSS: the penumbra grows with the caster's throw, not with the camera's distance

`src/render/softShadow.glsl.ts` replaces three's directional `getShadow` inside
`ShaderChunk.shadowmap_pars_fragment`.

The bug it fixes is instructive. three's PCF takes one radius **in shadow-map texels**, and
`LightingSystem` ramped it 2.2 → 4.0 across the cascades on the reasoning that a constant texel
count widens the penumbra as the cascades coarsen. Measured, that reasoning inverts, because
the texel footprint grows ~20x from cascade 0 to cascade 3:

| cascade | extent | texel | radius | blur |
|---|---|---|---|---|
| 0 | 33 m | 0.026 m | 2.2 | 0.058 m |
| 1 | 76 m | 0.065 m | 2.8 | 0.182 m |
| 2 | 182 m | 0.160 m | 3.4 | 0.544 m |
| 3 | 560 m | 0.503 m | 4.0 | **2.012 m** |

A man is about 0.45 m across, so past ~60 m his shadow was blurred wider than his own body and
past ~150 m smeared over four times it. That is why every blind critic reported that soldiers
cast no shadow: at the distances a battle line is actually photographed from, they genuinely
did not. Meanwhile the near shadows had the opposite problem — 0.058 m is under two pixels at
any close camera, so a tower throwing its shadow 30 m across the ground had an edge as hard as
one thrown 30 cm. Both faults are the same mistake: the filter width was a function of how far
the *camera* is, when it is physically a function of how far the *occluder* is.

The replacement derives the radius per pixel:

1. **One 5-tap probe at the widest radius the cascade allows.** Over most of a frame this
   returns fully lit or fully occluded and the function returns immediately, at exactly the
   cost of three's own filter. Only pixels genuinely inside a penumbra pay for the rest.
2. **A bounded 4-step binary search for the blocker depth**, on a narrow disc rather than the
   centre tap. Orthographic light depth is linear, so `shadowCoord.z` is a plain fraction of
   the near..far range; the hardware comparison sampler cannot return a depth, but it can
   answer "is anything in front of this plane", which is all a binary search needs.
3. **An 8-tap Vogel filter at the radius that implies.**

The physical constant is the sun's angular diameter: 0.53°, so
`SUN_PENUMBRA_RATIO = 0.00925` metres of penumbra per metre of throw — 0.3 mm at a boot sole,
28 cm at 30 m. Bounds are `PEN_MIN = 0.025 m` (below which a single-tap test stair-steps along
the shadow-map grid), `PEN_MAX = 0.42 m`, `THROW_MAX = 45 m`, and a cost bound of
`RADIUS_MAX_TEXELS = 9.0`.

`softShadows` is on at `high` and `ultra` only — the blocker search costs a measured **0.46 ms
of an 8.22 ms frame** at the `clash` camera on ultra, and it is not worth it on tiers that ship
2 cascades into a 1024 map, where the near cascade's texel is already wider than the penumbra
being searched for. `TC_SOFT_OFF` compiles the fixed-texel PCF back in as a reference arm so
the cost can be measured against it rather than estimated.

One negative result recorded in that file is worth keeping, because it is a model for how to
kill a plausible hypothesis. A blind critic found that a formation drops one merged grey wedge
in which you cannot count men, while grass a metre away casts crisp shadows. The obvious
explanation was that the blocker-search disc — up to 9 texels, about the gap between two men in
a rank — straddles a neighbour at every depth, so the search never narrows and every pixel of a
crowd's shadow gets the widest filter in the shader. It fits the symptom exactly, including why
an isolated grass tuft stays sharp. Measured in-session, narrowing the search to 3 texels moved
the frame by **0.009/255 at `romanline` and 0.017/255 at `raking`, over 0.00% of the frame**,
against a crowd-shadow signal of 9.8/255. Hypothesis dead. It had to be measured *in-session*
because two runs of `probe-shadow.mjs` at identical configuration differ on 50–70% of pixels
with a mean of 17–27/255 — the dust and particle VFX reseed per session even with the sim clock
paused, so a cross-session before/after of a shadow filter is pure noise.

### 6.4 The ambient stack

Four terms, four separate trims, all of them measured against the Rome II plates rather than
chosen. They interact, so changing one without the others is how this rig has drifted before.

**`AMBIENT_TRIM = 0.82`** (`SkySystem.ts:93`) — `scene.environmentIntensity`, the IBL level.
Deliberately below the physically correct 1.0. The original argument was that a clear sky's
diffuse irradiance really is about a quarter of the sun's, and rendering it at that level
produces flat milky frames; trimming it and paying with exposure buys back a stop of shadow
contrast, and physically half the sky hemisphere is occluded by the man in front of you and
none of this pipeline knows that. That argument was then partly overtaken by measurement: round
one of the paired blind instrument put first-percentile luma at **ours 0.029, theirs 0.061**, so
our shadows were more than a stop *past* the target rather than one short of it. 0.82 keeps the
half of the argument that survives.

It is scaled per map by ground albedo — `ambientTrimFor(a) = 0.82 * clamp(a / 0.13, 0.8, 1.55)`
— because a map whose ground is brighter genuinely does return more light to everything in
shadow, and a fixed trim silently becomes a much deeper cut on a bright map.

**`envMapIntensity: 2.2`** on the soldier material (`UnitRenderSystem.ts:783`). Above 1 on
purpose, and the single number that decides whether an army reads as men or as silhouettes.
Measured by reading the framebuffer back over a rectangle of Roman ranks at the `melee` camera:

| `envMapIntensity` | 0.9 | 1.8 | 3.2 | 5.0 |
|---|---|---|---|---|
| median display luminance | 0.014 | 0.042 | 0.051 | 0.075 |
| mean R | 0.063 | 0.165 | 0.183 | 0.204 |

At 0.9 half of every soldier was below 1.4% display luminance — black. `probe-units.mjs`
settled the remaining question (was the probe reaching the material at all?) by zeroing
`scene.environmentIntensity` and re-rendering: mean frame luminance fell 0.0662 → 0.0471, so
the environment is bound and supplies **29% of the frame**. It is not the wiring, it is the
level. The pairing with the trim is the point: `2.2 x 0.82 = 1.80` against the previous
`2.9 x 0.60 = 1.74`, so the soldier stays where he was while the ground, the masonry and the
grass come up to meet him. Change one, change both.

**`SKY_FILL_TRIM = 0.42 / Math.PI`** (`LightingSystem.ts:143`) — the hemisphere fill. The π is
written at the point of use rather than absorbed into a bare constant, and that is the fix for
the second of the three colour-space bugs: `getHemisphereLightIrradiance` returns
`mix(ground, sky, w)` and uses it as irradiance **with no π**, unlike `getIBLIrradiance` which
returns `PI * probe * envMapIntensity`. `skyFillColour` is a mean *radiance*, so the fill was
short by π: measured `E(up)` came to 0.0494 against the integral's own `π·L = 0.4529`, i.e.
**10.9% of what the sky model says it emits**. The two ambient paths were quoted in different
units, so tuning either silently disagreed with the other. Correcting the units alone would
have multiplied the term by 9.2 — units and level are one fix; either on its own is a
regression.

The ground half is derived, not patched:

```ts
const eSunGround = sky.sunIntensity * Math.max(0, sky.sunDirection.y);
fill.groundColor.setRGB(
  gb.x * (sky.sunColour.r * eSunGround + fill.color.r), /* g, b likewise */ );
```

— the Lambertian identity and nothing else: the plain's own albedo times the irradiance it
receives, with the colour coming from the terrain's real splat albedo so it cannot drift from
the ground being drawn. The hand-rolled warm tint it replaced added *half the sky's blue
radiance* on top, which supplied 72% of the term's blue channel against 26% of its red and
landed a "warm ground bounce" at b/r 1.35 — bluer than neutral, and exactly what collapsed the
warm lower hemisphere and the cool upper one into the same middling blue.

**`FILL_CHROMA_GAIN = 1.55`** (`LightingSystem.ts:117`) — stretch the fill's chroma about its
own luminance, so it costs no contrast and moves colour only:

```ts
const l = src.r * 0.2126 + src.g * 0.7152 + src.b * 0.0722;
out.setRGB(l + (src.r - l) * k, l + (src.g - l) * k, l + (src.b - l) * k);
```

The Rayleigh integral's cosine-weighted hemisphere mean is genuinely a desaturated pale blue —
it averages the deep zenith with the near-white horizon — and used raw it puts almost no blue
into a shadow. Twelve real Rome II frames average a shadow chromaticity of 1.06/0.90/1.02, i.e.
blue at 0.96 of red; ours measured blue at 0.79 of red at the midcrowd camera. It went to 1.55
after round one on a different statistic: chroma-weighted hue spread over the deck came back at
**25.3° for us against 42.2° for the reference**, and all three graders said the same thing in
words — shaded faces go inert, a green tunic does not stay green on its shaded side. Hue spread
has to be bought in the *fill*, because the sun is one colour and everything a hue can differ
from it by has to come from the other illuminant.

**`bounce.intensity = sunIntensity * 0.11 * bounceGain`** — a weak, unshadowed, sun-opposed
directional aimed nearly horizontally (`-0.2`, not a physical mirror's `-0.45`) because the
surfaces that need it are *vertical*: a cohort seen from the shaded side is a wall of anti-sun
normals. Its comment records a measurement that reads as an argument against itself and is
kept anyway: switching this one light off raises the darkest quartile's blue-to-red separation
from 1.23 to 1.346, the largest single gain available from any term in the rig (Rome II scores
1.968). Cutting it to 0.03 and buying the energy back on the cool sky half did raise the
separation 1.228 → 1.336 — and took soldier luminance from 0.1666 to 0.1524 and pushed the
crowd 1.178 → 1.259 on the crowd-versus-field temperature index. A colder slab and a darker
army. The two criteria are not independent: the men and the shadows are the same pixels.
Reverted deliberately, not overlooked.

All the ambient terms are additionally scaled by
`bounceGain = clamp(sky.preset.groundAlbedo / 0.13, 0.7, 1.9)`, for the same reason
`ambientTrimFor` exists.

---

## 7. Terrain

`src/terrain/` — the ground is one draw call, and it does not cast a shadow.

### 7.1 The geo-clipmap

`src/terrain/clipmap.ts`, 98 lines:

```ts
export const CLIP_CELLS = 192;        // must be divisible by four so the ring hole is exact
export const CLIP_LEVELS = 7;         // including the solid centre block
export const CLIP_BASE_SPACING = 0.5; // metres
export const CLIP_SNAP = 2 * 0.5 * 2 ** 6;  // 64 m
```

Level `n` has spacing `0.5 · 2ⁿ` and half-extent `96 · spacing`:

| level | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|---|
| spacing (m) | 0.5 | 1 | 2 | 4 | 8 | 16 | 32 |
| half-extent (m) | 48 | 96 | 192 | 384 | 768 | 1536 | **3072** |

Level 0 is solid; every level above it is a hollow square whose hole is exactly the extent of
the level inside it (`holeLo = 48`, `holeHi = 144`).

**The vertices carry no positions.** `positions[o..o+2]` are `(gridI, level, gridJ)`, and the
vertex shader reconstructs the world position and samples the height texture. That is what
makes the entire terrain — every level — **one static geometry and one draw call**, with
recentring a two-float uniform update rather than a buffer upload. The bounding sphere is faked
to radius `1e5` and `frustumCulled = false` so it can never be culled.

Exact totals, from `clipmapTriangles()`:

```
solid = 192 · 192 · 2                      =  73,728
ring  = (192² − 96²) · 2                   =  55,296
total = 73,728 + 55,296 · 6                = 405,504 triangles
vertices = 193² · 7                        = 260,743
```

which matches `ARCHITECTURE.md:332`'s independently measured "terrain 0.41 M".

There are no fixup strips. Instead the outer 20% band of each level (`CLIP_MORPH_BAND = 0.2`)
morphs its vertices onto the coarser grid, so the seam is continuous by construction.

### 7.2 The heightfield

```ts
export const HALF_EXTENT = 1400;                              // topography.ts:26
export const FIELD_RES = 2049;                                // heightfield.ts:48
export const FIELD_SPACING = 2800 / 2048 = 1.3671875;         // heightfield.ts:49
```

**2049² over 2800 m, 1.367 m per sample**, 4,198,401 `Float32` = 16.8 MB on the CPU. `2049` is
`2¹¹ + 1`, so the mip chain is `2049 >> 1 = 1024` and everything below halves cleanly.

`HALF_EXTENT` is not per-map and cannot be: `src/maps/types.ts:15-17` records that it is read at
module-evaluation time by `src/city/*`, `src/ai/Pathfinding.ts` and `src/ui/Minimap.ts`.

The GPU side (`src/terrain/fieldTextures.ts`) is an **R16F** `DataTexture` with a **CPU-built**
mip chain — R16F is only colour-renderable in WebGL2 when a float-buffer extension happens to be
enabled, and `generateMipmap` requires colour-renderability, so relying on the driver is a coin
toss. Filtering is `LinearMipmapLinearFilter` / `LinearFilter`, and the vertex shader fetches
with an **explicit LOD** chosen per clipmap level:

```glsl
float s   = uBaseSpacing * exp2(lvl);
float lod = max(0.0, log2(s / uHeightSpacing));
```

Levels 0 and 1 clamp to LOD 0; levels 2–6 use 0.549, 1.549, 2.549, 3.549, 4.549. The vertex
stage takes **four** vertex texture fetches: the height, plus three more for a cheap per-level
vertex normal.

The CPU accessors (`TerrainSystem.ts:190-231`) are deliberately dumb, because `heightAt` is
called tens of thousands of times per tick by the battle sim: flat bilinear, no allocation, no
branches beyond the edge clamp. `normalAt` is central differences at one spacing. `slopeAt`
returns `min(|∇h|, 1)` — **note that its docstring at `TerrainSystem.ts:37` says "0 (flat) .. 1
(vertical)", which is wrong: 1 is a 45° slope.**

### 7.3 How a map's heightfield is built

`MapDefinition.terrain.build(seedLabel)` (`maps/types.ts:125`), called once at
`TerrainSystem.ts:71`. Three implementations — `buildTerrain` (Campus Martius),
`buildPydnaTerrain`, `buildCarthageTerrain` — all sharing one pipeline and one seeded `Rng`.
**No DEM is imported anywhere**; everything is analytic plus noise plus erosion.

For the Campus Martius (`src/terrain/heightfield.ts:120-494`):

1. **Analytic macro form on a 1025² working grid.** `baseHeight` composes a regional plain, the
   rise toe and amplitude, a back-slope, a north bluff, a battle-core flattening mask, then
   relief: warped fBm at 1/540, fBm at 1/150 and 1/46, ridged noise at 1/560 and 1/420, and
   finally the Tiber cross-section weighted by river influence.
2. **Droplet hydraulic erosion** (`src/terrain/erosion.ts`): 110,000 droplets, lifetime 44,
   inertia 0.055, capacity 3.4, erode 0.34, deposit 0.32, evaporation 0.021, gravity 5.2, brush
   radius 2, hill bias 0.62. Returns flow, eroded and deposited maps.
3. **Separable Catmull-Rom upsample 1025² → 2049²** (weights −1/16, 9/16), then slope-weighted
   fine detail so the added grain lands on slopes rather than on flat ground.
4. **Human marks, at full resolution, in order**: the Tiber cross-section re-imposed; deployment
   zones flattened; hillside terraces at a 1.15 m riser; two quarries with spoil tips; the
   Petronia Amnis stream trench and berm; centuriated field boundaries at 0.213 rad and 94 m
   period; and the Via Flaminia, whose profile is smoothed twice along its length before camber,
   shoulders and ditches are cut.
5. **The control texture**: the three erosion maps blurred, normalised and packed RGBA8 at 1025²
   — R wetness, G bedrock, B trampling, A silt — which is what the splat shader scores against.

Pydna and Carthage run the same stage order with different tuning, "two of them inverted
outright". **[unverified: I read Pydna's header and constants but not Carthage's 65 KB
`heightfield.ts` in full.]**

### 7.4 Why the clipmap does not cast a shadow

```ts
this.mesh.customDepthMaterial = this.matSet.depthMaterial;   // TerrainSystem.ts:103
this.mesh.receiveShadow = true;                              // :104
// Deliberately *not* casting. The clipmap's coarse outer levels have 8–32 m
// triangles, and the outer shadow cascades cannot bias that against a fragment
// normal computed at heightfield resolution: the far half of every frame breaks out
// in a lattice of self-shadowing acne. A correct depth material exists
// (`matSet.depthMaterial`) so this is one flag to flip once the lighting system has
// slope-scaled bias per cascade — see the hand-off notes.
this.mesh.castShadow = false;                                // :111
```

The depth material is built and assigned and never exercised. It is one flag, and it is blocked
on slope-scaled bias per cascade, which the rig does not have — `normalBias` is capped at
`MAX_NORMAL_BIAS = 0.09 m` (§6.1) for reasons that have nothing to do with terrain and cannot
absorb a 32 m triangle.

A second comment depends on this one: `TerrainMaterial.ts:135-141` weights the level-spacing
term of the normal filter down to 0.6, and can only do so *because* the mesh cannot self-shadow.
At full weight the term steps by a factor of two across every clipmap ring boundary, and since
those boundaries are axis-aligned squares centred on the camera the result is a visible straight
seam across the middle distance.

So **there are no hill shadows.** Nor grass shadows (`GrassField.ts:772` sets
`castShadow = false`). `probe-shadow.mjs`'s "all shadows" and "crowd shadows" arms return
identical figures at both close cameras — 9.768/255 over 22.80% at `romanline`, 9.851/255 over
17.73% at `raking` — so only men, horses, engines, trees and some city meshes cast anything.
What darkens the ground instead is baked per-layer AO in the texture array's alpha channel, a
view-independent light-and-shade multiply from the detail height field, and the screen-space
HBAO + contact shadows in the post chain (§8) — all of which are centimetre-to-metre scale and
none of which can produce a landform shadow.

### 7.5 The terrain material

`MeshStandardMaterial` + `onBeforeCompile` (`TerrainMaterial.ts:513-522`), per the house rule,
so it inherits lights, cascades, IBL, fog and tone mapping. Eight declared splat layers
(`LAYER_COUNT = 8`, asserted at load), of which the shader samples **the three strongest** —
sampling all eight would need 24 fetches, three needs nine. Blending is by surface height, not
lerp, with a per-layer height bias. Triplanar projection is slope-gated at
`smoothstep(0.10, 0.32, slope)`, so a triplanar pixel costs 3x the fetches and a flat one costs
none.

Two incommensurate tile scales per layer (a ratio near 3.7, never an integer) plus macro colour
bands at 430 m, 96 m, 23 m and 11.3 m are what hide the repeat; stretching the texture is not.

One scar preserved in-shader, and it is the classic three.js injection mistake
(`TerrainMaterial.ts:706-714`): the fragment stage computes a world-space normal, and assigning
it directly to `normal` leaves every `dotNL` comparing mismatched bases. Measured, that cost the
terrain **essentially all of its direct sunlight — 17x darker than a plain
`MeshStandardMaterial`, and darker than that same material lit by ambient alone.** The fix is
one `viewMatrix` multiply on each of `normal` and `nonPerturbedNormal`.

---

## 8. PostFX

`src/render/PostFX.ts` (1,689 lines), order 900, owns the present via `engine.renderOverride`.

**There is no `EffectComposer`.** `grep -rn "EffectComposer\|RenderPass\|ShaderPass" src/`
returns nothing. The chain is hand-rolled around a single `FullScreenQuad` and a `blit()`
helper; the only imported pass object is `SMAAPass`, driven directly.

### 8.1 The chain

| # | pass | gate | src → dst | dst scale |
|---|---|---|---|---|
| 1 | scene raster | always | scene → `sceneRT` | 1.0, HDR, MSAA |
| 2 | HBAO + 2 depth-aware blurs | `q.ssao` | depth → `aoRT` | 0.5, LDR |
| 2b | screen-space contact shadows + 2 blurs | `contactShadows && q.ssao && sunIntensity > 0.001` | depth → `contactRT` | **1.0** |
| 3 | composite: AO ∧ contact ∧ aerial perspective | always | `sceneRT` → `mainA` | 1.0, HDR |
| 4 | god rays, 28-step march | `q.volumetricLight && sunOnScreen > 0.01` | depth → `godRT` | 0.5, HDR |
| 5 | DoF, 22-tap Vogel + mix | `q.depthOfField && dofAmount > 0.02` | ping-pong | 0.5 / 1.0 |
| 6 | camera motion blur, 7-tap reprojection | `q.motionBlur && historyValid` | ping-pong | 1.0, HDR |
| 7 | bloom: threshold → 6-level pyramid | `q.bloom` | `bloomRT[0..5]` | 0.5 → 0.015625 |
| 8 | **`TC_TONE_GRADE_FRAG`** | always | → `ldrRT` | 1.0, **8-bit** |
| 9 | TAA / SMAA / FXAA | by `q.antialias` | → `histB` / `aaRT` | 1.0, 8-bit |
| 10 | **`TC_FINAL_FRAG`** — CAS + vignette + grain | always | → **`null`** | canvas |

Nineteen render targets, all `RGBAFormat` / `NoColorSpace` / `LinearFilter` / no mipmaps, HDR
ones `HalfFloatType`. Only `sceneRT` carries a depth attachment (`UnsignedIntType` +
`DepthFormat`, `NearestFilter`). Allocation is guarded on `(w, h, samples)` so a no-op resize
costs nothing.

**There is no depth or normal prepass** (`PostFX.ts:14-16`): a second geometry pass over
thousands of animated men costs more than reconstructing view normals from depth, and the
reconstruction (`tcNormalFromDepth`, the "best of 4 taps" trick) is exact except across
silhouettes.

**MSAA is `WebGLRenderTarget({ samples })` on the scene target only** —
`MSAA_SAMPLES = { low: 0, medium: 0, high: 4, ultra: 4 }`, clamped to
`renderer.capabilities.maxSamples`. It is a **binary 0-or-4 lever worth 1.18 ms**: measured over
eight camera-measurements in two interleaved sessions, 4x against none is a median of 1.18 ms
while 4x against 2x is 0.07 ms — 2x pays 94% of 4x's price for half the samples, so **never 2**.
It is not in the adaptive ladder because moving it reallocates the scene target.

Aerial perspective samples `SkySystem.skyCubeTexture` directly, so an object at infinity fades
to exactly the radiance of the sky behind it. That is the cue that makes distance read, and it
is why this is not a `FogExp2`.

### 8.2 The two grade shaders

**`TC_TONE_GRADE_FRAG`** (`PostFX.ts:133-241`) takes scene-linear HDR and emits
display-referred sRGB. In order:

1. add bloom (`* uBloom`) and god rays (`* uGodRays`);
2. **scene-linear contrast on luminance**, before the tone map:
   `y1 = pivot · (y0 / pivot)^exponent`, then `hdr *= y1 / y0`, with
   `uContrast = (1.8, 0.16, 0.0026)`;
3. add the veiling-glare pedestal `uContrast.z`;
4. **AgX** — `tcAgX(hdr, uExposure)`, lifted from three's own
   `tonemapping_pars_fragment` so taking over the present does not change the curve. Rec.2020
   working space, `minEv = -12.47393`, `maxEv = 4.026069`, 6th-order contrast polynomial;
5. black point `uGrade.y = 0.006`, renormalised;
6. mid-tone S-curve blend `uGrade.x = 0.42`;
7. **the warm/cool split**, and this is the line the third colour-space bug lived on:
   ```glsl
   float split = smoothstep( uSplit_disp.x, uSplit_disp.y, tcLinearToSRGB( vec3( l ) ).r );
   c *= mix( uShadowTint, uHighlightTint, split );
   ```
   `uSplit_disp = (0.05, 0.48)`, `uShadowTint = (0.9, 0.96, 1.18)`,
   `uHighlightTint = (1.18, 0.985, 0.82)`. The `tcLinearToSRGB` is the crossing the suffix
   exists to make visible;
8. split saturation, `mix(0.42→shadow 1.02, highlight 1.3)`;
9. a per-channel hyperbolic shoulder at knee 0.92, strength 1.7;
10. **sRGB OETF encode.**

`uExposure` is the only uniform written per frame besides the textures, from
`sky.preset.exposure`. Everything else keeps its factory default at runtime.

**`TC_FINAL_FRAG`** (`PostFX.ts:273-312`) runs entirely in display space, on the encoded 8-bit
output. Encoding at pass 8 rather than at the end is deliberate: **AA and sharpening run in
perceptual space, which is where FXAA and CAS are designed to run**, and it removes the shadow
banding an 8-bit *linear* intermediate would have. It does AMD CAS (cross-only, peak weight
−1/8 to −1/5), a vignette (`0.2 · clamp(r · 0.72)^2.6`) and shadow-weighted film grain
(`0.006 · (1 − luma · 0.75)`).

The grain figure is measured, not chosen: at 0.016 the frame had **0.00%** smooth region
anywhere; at 0.006, 2.21%; at 0, 69.67% — against Rome II crops at a mean of 7.09%.

`uSharpen`'s declared default of `0.32` is dead at runtime; `render()` writes `0.42` under TAA
and `0.28` otherwise, and no stock tier uses TAA.

**TAA exists and no tier enables it.** `QUALITY_PRESETS` is `fxaa` at low and `smaa` at the
other three, with the reason recorded at `Engine.ts:137-141`: soldiers are GPU-skinned instances
animated entirely in the vertex shader, so there are no per-object motion vectors to reproject
with, and TAA's history clamp cannot distinguish a moving man from a disoccluded background — it
smears a dense melee into mush. TAA can come back once the unit renderer emits a velocity
buffer.

> **A live consequence of that, worth flagging.** `historyValid` is set to `true` in exactly one
> place — inside the `q.antialias === 'taa'` branch (`PostFX.ts:1621`) — and camera motion blur
> is gated on `q.motionBlur && this.mMotion && this.historyValid` (`PostFX.ts:1552`). Since no
> shipped tier selects TAA, **the motion-blur pass is unreachable on every stock tier**, and the
> `motionBlur` flag in `QUALITY_PRESETS` and the `dropMotionBlur` rungs in `AdaptiveQuality`'s
> envelopes are gating a pass that never fires. The coupling looks unintended. Not fixed here —
> this is a documentation pass and a release is in flight.

### 8.3 Adaptive quality

`src/core/AdaptiveQuality.ts`, order −200. A closed loop: measure the frame, take a high
percentile of a rolling window, move a single scalar `pressure ∈ [0,1]` that a table of ramps
turns into render settings. `pressure = 0` is exactly the player's tier; `pressure = 1` is that
tier's *floor*. **The tier is therefore a ceiling and a floor, not a fixed setting** — a player
who picks `ultra` on a weak machine gets an honest low frame rate at ultra's floor rather than a
silent demotion to `low`.

**What it measures.** The render half of the frame only: `update` + camera + `preRender` +
submit, clocked by `Engine` into `lastRenderMs`. Not the whole frame, and the distinction is
load-bearing. `Time` runs the sim at a fixed 30 Hz off an accumulator, so at a 60 Hz display
`ticksThisFrame` alternates 1, 0, 1, 0 and `fixedUpdate` costs 3.657 ms at 8,632 men. Whole-frame
time therefore carries a **±3.7 ms square wave at the display's Nyquist frequency** — larger than
every render lever in the file put together. Feed that to a controller and the sim-heavy frames
read as a render problem: the loop drops resolution, the next frame runs no tick and looks fine,
the loop recovers, and the accumulator's beat has become an oscillator. That would present as bad
hysteresis and would in fact be a measurement error.

Wall clock, not `EXT_disjoint_timer_query_webgl2` — that extension is available here and reports
**51.2 ms of GPU inside a drained 16.1 ms block**. Its sign is usable; its milliseconds are not.

**The statistic.**

```ts
const WINDOW = 90;                      // 1.5 s at 60 Hz
this.p90 = percentile(sorted, n, 0.9);  // the ninth-worst frame
```

A mean cannot see a p50 of 9 with a p99 of 60, and the complaint is the tail. p99 over 90 samples
is a single frame and pure noise, so it is reported and never controlled on.

**The thresholds.**

```
DEFAULT_TARGET_MS = 16.667      SIM_RESERVE_MS = 4.0
dropMs  = targetMs - 4.0        = 12.67 ms
raiseMs = dropMs - deadBand     = 10.17 ms at zero reversals
DEAD_BAND_MS = 2.5, widening by FLIP_WIDEN_MS = 1.0 per reversal to a max of 6.5
```

The 4 ms reserve is the sim time the controller deliberately cannot see, paid back in the
threshold instead.

**Two arms**, because no single clock on this stack sees both bottlenecks. The **CPU arm** is
`renderMs`; it catches a CPU-bound frame before any frame is missed and it works headless, but
it cannot see the GPU — measured on Rome assault at dpr 2, dropping the scale 1.00 → 0.50 shrinks
the scene target from 3200x1800 to 1600x900 and takes the drained frame cost from 41 ms to 29 ms
**while `renderMs` sits flat at 4–5 ms across every scale**. The **presented arm** is the rAF
interval: `ivP90 > refreshMs * 1.2`, gated on the sim not dominating (`simP90 < targetMs * 0.5`).
It sees both bottlenecks but can only ever say "drop", never "raise", because a comfortable frame
and a barely-comfortable one both present at exactly the refresh period. It switches itself off
entirely unless it can detect a real refresh period, since headless Chromium has no display and
measures p50 41–65 ms.

**Steps and dwell.** Drop step `clamp((over − 1) · 1.2, 0.04, 0.2)`, minimum 250 ms apart. Raise
step a fixed 0.05, minimum 2 s apart — which **must** exceed the 1.5 s window, or the second
decision is taken on samples the first change has not yet reached. A drop is allowed to violate
that deliberately: a premature drop can only make the frame faster, while a premature raise is
how pumping starts. Six reversals inside 8 s latches the loop, releasable after 60 s in band.

**The ladder is ordered by what a lever costs to operate, not by what it looks like** — which
inverts the obvious design and is the main thing this engine's measurements teach. Grass density
is one uniform write; the four post flags are booleans `PostFX.render` reads off `ctx.quality`
every frame. All five are free, instant and reversible. Resolution is not: it must free and
rebuild nineteen render targets plus `SMAAPass.setSize`, measured at **~4.1 ms best-of-blocks
with an observed worst case of 668 ms**. A lever whose worst case is two-thirds of a second can
produce, in the act of trying to fix the lag, exactly the freeze it was reaching for. So it is
coarse-runged (`[1.0, 0.92, 0.85, 0.78, 0.71, 0.65, 0.59, 0.54, 0.5]`, spaced so each step is a
roughly equal *fraction* of the remaining pixel count) and dwell-gated underneath the free ones.

800 warm-up frames or 12 s are discarded, and any frame that linked a shader program is thrown
away outright — measured over a 1,079-frame session, the two worst frames were the only two that
linked a program (151.0 ms and 65.1 ms) against a p50 of 10.8 ms.

**Explicitly excluded**, each for a stated reason: `shadowCascades` (recompiles every lit
material), `shadowMapSize` (`LightingSystem.resize` returns early unless the cascade count
changed, so writing it does nothing — "a lever that is wired and silently inert, this project's
most common failure mode"), `antialias`, `lodFarDistance` (a legibility threshold, not a cost
knob — see §2.4), `bloom`, and `maxSoldiers` (simulation state; not expressible in
`RenderQualityPatch`).

---

## 9. Known gaps

The paired blind instrument shows **fourteen matched pairs per round** to three independent
graders — `tools/ab-pairs-round1.json` and `tools/ab-pairs-round2.json`, 14 pairs each, our
frame against one of the twenty-two official Rome II store screenshots, subject matched inside
each pair and (from round two) camera height, standoff and field of view matched as well. Every
grader sorted every pair correctly: **14 of 14 for three graders in round one**, which is the
figure commit `bf75fb0` records, and the same in round two. So the renderer is still separable
from the reference at a glance, and the interesting output is not the score but *why* each
grader said they sorted it.

Both rounds are now recorded in **`tools/ab-results.json`**, which is the citable source. Round
two: deck `round-2`, seed 173, three graders on three lenses, 14/14 each with identical picks,
41 of 42 calls at confidence 5. It closed six of the eight `pictureStats` fields — the `edge`
gap by 82%, `halo` by 46% — and moved the score not at all, which is the whole argument of §9.
Two of its fixes were confirmed **blind** by a grader told nothing about them: aerial
perspective, and cloth.

Their converged findings are below, each checked against the code. Two are confirmed. One is
not, and saying so is the point of this section.

Aerial perspective and cloth were confirmed **good** blind, which is worth recording because
both are recent work: the aerial term samples the real sky cube (§8.1) and the standard is no
longer a second lighting rig (§4.2).

### 9.1 Shields: the specular highlight does not track the surface normal — *confirmed, closed in round three*

A shield boss is built by `b.revolve(...)` (`soldierMesh.ts:1463-1468`) under
`makeRotationX(PI/2)`, which maps the lathe's axial coordinate onto the shield panel's Z. **It is
a body of revolution about the board's face normal.** So any rotation about that normal leaves
its mirror point exactly where it was.

The shield is skinned to `MB.lowerArmL`, and the only per-man rotation it receives is the
left-arm carriage (`skinShader.ts:262-271`):

```glsl
float wL = soldierChain( SOLDIER_ARM_L0, SOLDIER_ARM_L1 );
vec3 d = sp - SOLDIER_SHOULDER_L;
SOLDIER_TILT( d.x, d.y, hArmL * 0.19 * wL )   // in the XY plane, i.e. about body Z
SOLDIER_TILT( d.z, d.x, hArmL * 0.17 * wL )   // in the ZX plane, i.e. about body Y
```

Two things follow, both verifiable from that snippet:

- **Both terms are driven by the same hash, `hArmL`.** Every other varied part of the man draws
  two independent hashes (the right arm takes `hArmR` and `hLift`; the head takes three). So the
  left arm's orientation lies on a one-parameter family across the whole army.
- For a board presented to the front, body Z is very nearly the boss's own axis of revolution, so
  **the first term moves the highlight not at all**, and the second is `±0.085 rad = ±4.9°`.

The same bug was diagnosed and fixed for helmets in this release, in the same commit as the
banner (`bf75fb0`), and its comment is the clearest statement of the geometry
(`skinShader.ts:300-312`):

> a helmet bowl is a surface of revolution about the vertical, so its mirror point is invariant
> under yaw. Rotating a man's head about Y moves his face and does not move his highlight by one
> pixel, which is exactly why a rank of three hundred men carried three hundred identical glints
> in the same relative place on the crown — the one finding all three graders put in their top
> three. A roll breaks the symmetry and the glint moves with it.

The head now gets three decorrelated axes: yaw `±17.8°`, pitch `±8.6°` and the new roll
`±7.4°`. The shield got nothing. That is the gap.

**Closed in round three, and it took two changes rather than one.** Giving the shield arm three
decorrelated axes — roll `±6.9°`, yaw `±6.3°` and a pitch `±5.7°` that was absent entirely — is
only half of it, because tipping a 75 mm dome's axis by six degrees moves its mirror point about
6 mm, which at battle range is under a pixel. The other half is that **the boss is no longer a
body of revolution**: `soldierMesh.ts`'s `bossWarp` makes an umbo 8.5 % oval with three shallow
hammer planes, through `revolve`'s new `warp` hook, which is what a raised umbo is and what makes
the roll visible at all. Either change alone is inert; the pair is what moves the highlight.

Measured by `tools/scratch/r3-specvar.mjs`, which crops each of twelve men's shields to its own
bounding box (throwing away translation and scale) and takes the mean pairwise absolute
difference over the brightest decile of the mean image: **6.11 → 7.41** on a legionary scutum,
with the shield's on-screen aspect spread going **0.0027 → 0.0036**. That is a real move and it
is a modest one; the honest reading is that the mechanism is now present rather than that the
defect is gone.

### 9.2 One BRDF serves every material — *confirmed, and split three ways in round three*

The census in §4.3 is the proof: **16 `MeshStandardMaterial` and zero `MeshPhysicalMaterial`**.
Every lit surface in the game — flesh, wool, linen, plywood, hide, iron, bronze, limestone,
paving, bark, water, grass — runs three's `physical` shading model: GGX specular over Lambert
diffuse, with no sheen, no clearcoat, no transmission and no subsurface term.

The injected extensions are all *modulations of that one model*, not alternatives to it: cavity
occlusion on the direct term, geometric specular anti-aliasing, per-man roughness and metal
mottle (soldiers); horizon gating of direct light per texel (masonry); height-blended splats
(terrain). The only genuine addition anywhere is the banner's wool transmission term (§4.2), and
it is four lines.

Skin in particular is nothing but an albedo tint on the shared material
(`skinShader.ts`, `TINT_BODY`, slot 3): a mid-grey atlas tile multiplied by a two-endpoint tone
ramp with a ruddy/olive hue shift, landing between 0.22 and 0.35 linear luminance with R about
three times B. There is no wrap term, no red-channel bleed at grazing N·L, and nothing that
distinguishes a forearm from a painted board. Lambert falls to zero linearly at the terminator
and takes all three channels with it in the same ratio, which is exactly the "greying" the
graders described. Real flesh reddens there because red light scatters furthest under the skin,
and nothing in this pipeline models that.

**Round three splits it three ways, in the one place the pipeline already overrides `RE_Direct`.**
`vSoldierSurf` widens from `vec3` to `vec4` — free, because a `vec3` varying already occupies a
whole `vec4` interpolator — and its `.w` carries a material class derived from the tint slot in
the vertex shader: 0 stock, 1 flesh, 2 cloth.

- **Flesh** takes a per-channel diffuse wrap, `W = (0.38, 0.16, 0.08)`, as
  `clamp((N·L + W) / (1 + W), 0, 1)`. At `N·L = 1` every channel returns exactly 1, so full sun
  is bit-for-bit Lambert and this cannot move an exposure; at the terminator it returns
  `(0.28, 0.14, 0.07)`, which is the colour of blood at a third of the sun's strength. Past the
  terminator only red survives. The **specular is deliberately not wrapped** — sebum reflects off
  the surface and obeys the true geometric `N·L` — so the lobe is taken by calling three's own
  `RE_Direct_Physical` with `diffuseColor` zeroed rather than by scaling the whole result, which
  would drag a sheen round onto the shadowed side of every face. A grazing transmission term,
  gated on back-lighting and tinted hard to red, lights ear rims, nostrils and fingers, with
  `1 - |N·V|` standing in for a thickness map the atlas has no slot for.
- **Cloth** loses GGX entirely. A microfacet lobe assumes a locally flat surface with a
  distribution of slopes about its normal, which is true of a hammered plate and false of a nap;
  linen's highlight is at grazing, round the silhouette, and broad. So GGX is *replaced* by
  Ashikhmin's inverted-Gaussian velvet distribution in Estévez and Kulla's form, which peaks
  exactly where GGX is zero, with Ashikhmin's own visibility term to keep the grazing peak
  finite. Its diffuse takes a wide achromatic wrap of 0.30, because a fibre scatters by geometry
  rather than by absorption.
- **Metal** was already F0-tinted through albedo (§4), and this round only fixes *which* metal
  gets the round-two per-man treatment. That was gated on tint slot 7, which is helmets and
  bosses; mail, squamata and segmentata are slot 0 and got none of it, so the two smallest metal
  surfaces on a man were varied and the largest was not. The gate is now the ORM's own
  metalness — `texelRoughness.b` in the roughness chunk, `metalnessFactor` in the normal chunk —
  so wood, rope and leather, which share slot 0 with the armour, still do not get it.

### 9.3 Shadows: no contact darkening, no penumbra growth, no coloured bounce — *does not reproduce as stated*

This is the finding I cannot confirm, and I am recording the contradiction rather than repeating
the claim.

| grader finding | what the code at `6698e19` does |
|---|---|
| no contact darkening | `PostFX` runs a **full-resolution** screen-space contact-shadow pass (`PostFX.ts:714-779, 1442-1470`) that marches the depth buffer toward the sun over ~1.3 m, plus half-res HBAO at 1.1 m radius. Both are on at `medium`, `high` and `ultra` (gated on `q.ssao`) and composite as `min(ao, contact)`. The pass is at full res specifically because at half res "the contact darkening under a distant man lands between texels and the effect disappears at exactly the distances the critics complained about". |
| no penumbra growth with caster distance | `tcSoftShadow` (§6.3) is a PCSS blocker search whose entire purpose is to derive the filter radius from the occluder's throw distance, physically, from the sun's 0.53° angular diameter. On at `high` and `ultra`. |
| no coloured bounce | The shadowed side of every surface is lit by a chroma-boosted sky-blue hemisphere (`FILL_CHROMA_GAIN = 1.55`), a Lambertian warm ground half derived from the terrain's real albedo, an unshadowed warm sun-opposed directional, and a PMREM of the physical sky — and the grade then multiplies everything below the split by `uShadowTint = (0.9, 0.96, 1.18)`. |

Three readings are possible and I cannot choose between them from the code alone:

1. **The mechanisms are there and are too weak to read.** Plausible for the penumbra. The
   radius is clamped to `[rMin, rMax]` with `rMin = max(PEN_MIN / mPerTexel, 0.85)` and
   `rMax = clamp(PEN_MAX / mPerTexel, rMin, 9.0)`. Taking the file's own measured cascade-0
   texel of 0.026 m, that is a floor of 0.025 m and a ceiling of `9 × 0.026 = 0.23 m` — the
   texel cost bound binds long before `PEN_MAX = 0.42 m` does. So the *available* range of
   penumbra widths in the near cascade is 2.5 cm to 23 cm, and a grader looking for a tower's
   shadow softening over 30 m of throw (physically 28 cm) would not see the physical answer.
2. **"No coloured bounce" means colour *bleeding*, not coloured ambient** — a red cloak does not
   tint the ground beside it. That reading is **true and verifiable**: there is no GI, no
   radiosity and no per-surface bounce anywhere. The warm bounce is one global directional
   carrying the sun's own chromaticity.
3. **The findings are stale**, recorded before `tcSoftShadow` and the contact pass landed.

What is unambiguously true, and is the real shadow gap:

- **Terrain casts nothing and grass casts nothing** (§7.4), so there are no hill shadows and no
  tuft shadows at all. `probe-shadow.mjs` measures the crowd's shadows and all shadows as
  identical.
- **Ultra's 4096 shadow map is clamped to 2048** (§6.1), so the top tier's texel density is
  `high`'s.
- **No contact hardening from the shadow map itself.** `PEN_MIN = 0.025 m` is a floor, so a
  boot sole's shadow is never sharper than 2.5 cm — the contact-shadow pass is what supplies
  anything tighter, and it is screen-space and therefore view-dependent.

**Recommended next step: re-run the finding as a measurement before acting on it.** The
apparatus exists (`tools/probe-shadow.mjs`), and §6.3 records both how to use it and the trap —
two runs at identical configuration differ on 50–70% of pixels because the VFX reseed per
session, so any shadow A/B must be taken **in-session**.

---

## 10. Re-measuring anything in this document

Every figure above came from one of these. None of them is allowed to borrow a dev server; start
your own on your own port.

| tool | what it answers |
|---|---|
| `tools/probe-budget.mjs --port=P --tiers=... --cams=... --at=72` | draw calls split colour / shadow / post, per camera per tier, with per-family attribution |
| `tools/probe-draws.mjs` | what *should* draw, by rebuilding the frustum in JS — attribution, not budget |
| `tools/shoot.mjs` | the graded shot deck: fps, draw calls, triangles |
| `tools/perfdiff.mjs` | regression against a baseline; treats an absolute triangle overage as a warning and a 25% jump as a failure |
| `tools/probe-shadow.mjs` | shadow coverage and depth — **in-session pairs only** |
| `tools/probe-lighting.mjs` | per-term attribution of a pixel's light budget |
| `tools/probe-units.mjs` | display-luminance percentiles over a rectangle of ranks |
| `tools/probe-soldiermesh.mjs` | geometry sanity: normals versus winding, piece placement |
| `tools/probe-adaptive.mjs` | the closed loop's behaviour under synthetic load |
| `tools/probe-tiers.mjs` | the cascade-count rebuild, every transition that changes it |
| `tools/probe-terrain.mjs`, `probe-msaa.mjs`, `probe-water.mjs`, `probe-crowd.mjs` | as named |

Two standing rules from the source, both learned the hard way:

- **`renderer.info.render.triangles` counts every pass.** At the cavalry camera unique visible
  geometry was 10.6 M while the counter reported 35.5 M. The multiplier is not a constant — it
  ranges ~2.3x to ~3.3x with how much of the scene the cascades happen to span — so a fixed
  absolute line on the reported figure cannot mean the same thing in two frames. Proxies are
  trustworthy as derivatives, not as absolutes.
- **Frame time is the binding constraint; everything else is a proxy for it.** Draw calls are the
  exception worth gating on, because they are deterministic and load-independent.
