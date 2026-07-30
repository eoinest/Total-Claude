# Asset provenance and licensing

Every binary under `public/assets/` is listed here with its author, upstream URL,
license and SHA-256. Nothing in this directory was extracted from a commercial game,
and nothing was obtained from a source whose license could not be read directly from
the publisher.

| | |
| --- | --- |
| Files tracked | **172** (4 HDRI, 72 texture maps across 18 sets, 96 models) |
| Total on disk | **213.4 MB** |
| Poly Haven subtotal | 184.0 MB |
| Quaternius subtotal | 29.5 MB |
| Licenses in use | CC0 1.0 Universal only |
| Attribution required | No (credited anyway - see [Credits](#credits)) |
| Machine-readable index | `public/assets/manifest.json` |
| Reproducible fetcher | `tools/fetch-assets.mjs` |

## Re-fetching

```sh
node tools/fetch-assets.mjs            # download anything missing, repair anything corrupt
node tools/fetch-assets.mjs --verify   # integrity-check what is on disk, download nothing
node tools/fetch-assets.mjs --force    # re-download everything
```

Every one of the 172 entries has its SHA-256 inlined in that script. A file is
only promoted into `public/assets/` after its hash matches, its magic bytes match the
declared format, and it matches none of the executable/script signatures. This means the
binaries do not strictly need to be committed - a clean checkout plus one command
reproduces byte-identical assets.

---

## Licenses

### Poly Haven -- CC0 1.0 Universal

License text: **<https://polyhaven.com/license>**

Summary, quoting the operative points from that page verbatim:

> All assets (HDRIs, textures and 3D models) on this site are the original work of
> Poly Haven staff, or artists who willingly and directly donate/sell their work to
> Poly Haven. Our assets are all licensed as CC0, which is effectively Public Domain
> even in jurisdictions that do not support the Public Domain.
>
> - **You can use our assets for any purpose**, including commercial work.
> - **You do not need to give credit** or attribution when using them (although it is appreciated).
> - **You can redistribute them**, share them around, include them when sharing your own
>   work, or even in a product you sell.

Poly Haven's Terms of Service prohibit "web scraping or data mining without express
permission". No scraping was performed: all Poly Haven metadata and download URLs in
this repo came from Poly Haven's **public, documented, key-less JSON API**
(`api.polyhaven.com`, the same API their own Blender add-on uses), and every binary was
pulled from the `url` field that API returned, on `dl.polyhaven.org`.

### Quaternius -- CC0 1.0 Universal

License text: **<https://creativecommons.org/publicdomain/zero/1.0/>**

Each Quaternius pack page states CC0 in its metadata table, and each distribution folder
ships a `License.txt`. Verbatim contents of that file (read, not copied into this repo,
because `.txt` is outside this task's download allowlist):

```text
------------------------------------------------------
LowPoly Models by @Quaternius
Consider supporting me on Patreon, even $1 helps me a lot!

https://www.patreon.com/quaternius
-------------------------------------------------------

License:
CC0 1.0 Universal (CC0 1.0)
Public Domain Dedication
https://creativecommons.org/publicdomain/zero/1.0/
```

### What CC0 actually means

CC0 1.0 is a **public domain dedication**, not a permissive license with conditions. The
rights holder waives copyright and neighbouring rights worldwide, as far as the law
allows, and where a full waiver is not possible grants an unconditional, irrevocable,
royalty-free license to the same effect. Practically, for this project:

- Commercial use, modification, remixing and redistribution are all permitted.
- **No attribution, notice, or share-alike obligation attaches.** Nothing has to ship
  with the built game, and there is no "license header" to preserve.
- No patent or trademark rights are granted, and no warranty is given - CC0 disclaims
  all warranties. Personality/publicity rights of any people depicted are not waived
  (not relevant here: no assets depict real people).
- Because there is no copyleft clause, CC0 assets can sit alongside proprietary code
  without licensing the project itself.

This repo therefore has **zero runtime license obligations** from its assets. Credit is
given below purely because it is the decent thing to do.

### Credits

- **Poly Haven** and the individual photographers/artists named in the tables below:
  Greg Zaal, Jarod Guest, Rob Tuytel, Amal Kumar, Charlotte Baglioni, Dario Barresi,
  Dimitrios Savva, Rico Cilliers, colormass. <https://polyhaven.com>
- **Quaternius** (Tom, @quaternius) for all 3D models. <https://quaternius.com>

---

## HDRIs -- sky domes and image-based lighting

2K equirectangular Radiance (`.hdr`), unclipped, `open_sky: true` confirmed via
`api.polyhaven.com/assets?t=hdris&c=skies` for all four. Three of the four are Poly
Haven "Pure Sky" variants, meaning the lower hemisphere is sky/gradient rather than
photographed ground - the correct choice here because the simulator renders its own
terrain and only needs the upper hemisphere plus a clean IBL.

| Asset | Creator/Author | Source URL | License | Local path | SHA-256 (first 16) | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `midday-partly-cloudy` | Greg Zaal, Jarod Guest | [kloofendal_48d_partly_cloudy_puresky](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky) | CC0-1.0 | `public/assets/hdri/midday-partly-cloudy-2k.hdr` | `5244534e9cf5b606` | midday / partly-cloudy; 5.20 MB; open_sky |
| `golden-hour-sunset` | Greg Zaal, Jarod Guest | [kloppenheim_06_puresky](https://polyhaven.com/a/kloppenheim_06_puresky) | CC0-1.0 | `public/assets/hdri/golden-hour-sunset-2k.hdr` | `99451201586489ef` | sunset / partly-cloudy; 4.23 MB; open_sky |
| `overcast-afternoon` | Greg Zaal | [kloofendal_overcast_puresky](https://polyhaven.com/a/kloofendal_overcast_puresky) | CC0-1.0 | `public/assets/hdri/overcast-afternoon-2k.hdr` | `312b1b04b7f10057` | afternoon / overcast; 4.13 MB; open_sky |
| `dawn-sunrise` | Greg Zaal | [kiara_1_dawn](https://polyhaven.com/a/kiara_1_dawn) | CC0-1.0 | `public/assets/hdri/dawn-sunrise-2k.hdr` | `7261c613b35a9b76` | dawn / partly-cloudy; 5.86 MB; open_sky |

Verified attributes straight from the API (`attributes.time_of_day` / `attributes.weather` /
`attributes.open_sky`):

| manifest id | Poly Haven `time_of_day` | `weather` | `open_sky` | source resolution |
| --- | --- | --- | --- | --- |
| `midday-partly-cloudy` | midday | partly_cloudy | true | 16K |
| `golden-hour-sunset` | sunset | partly_cloudy | true | 24K |
| `overcast-afternoon` | afternoon | overcast | true | 24K |
| `dawn-sunrise` | sunrise | partly_cloudy | true | 16K |

---

## Textures -- 2K PBR sets

All Poly Haven, all CC0, all 2048 px JPG. Normal maps are the **OpenGL** (`nor_gl`)
variant, which is what Three.js expects - do **not** substitute the `nor_dx` files.
`displacement` is only fetched for ground/terrain sets, where it is actually useful for
parallax or vertex displacement; wall, metal and cloth sets have `displacement: null` in
the manifest to keep the payload down.

The SHA-256 column below is the **albedo** map. Hashes for all 72 individual map
files are pinned in `tools/fetch-assets.mjs` and mirrored per-map in
`manifest.json` under `textures[].sha256`.

| Asset | Creator/Author | Source URL | License | Local path | SHA-256 (first 16) | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `roman-travertine-blocks` | Rob Tuytel | [sandstone_blocks_08](https://polyhaven.com/a/sandstone_blocks_08) | CC0-1.0 | `public/assets/textures/roman-travertine-blocks/` | `da2f453c7c3683f5` | albedo+normal+roughness+ao; 2048px; 3.5 MB |
| `white-marble` | Rob Tuytel | [marble_01](https://polyhaven.com/a/marble_01) | CC0-1.0 | `public/assets/textures/white-marble/` | `d403786171716f86` | albedo+normal+roughness+ao; 2048px; 2.8 MB |
| `limestone-wall-blocks` | Rob Tuytel | [large_sandstone_blocks_01](https://polyhaven.com/a/large_sandstone_blocks_01) | CC0-1.0 | `public/assets/textures/limestone-wall-blocks/` | `87e5f9404e8aa572` | albedo+normal+roughness+ao; 2048px; 8.9 MB |
| `terracotta-roof-tiles` | Amal Kumar | [clay_roof_tiles_02](https://polyhaven.com/a/clay_roof_tiles_02) | CC0-1.0 | `public/assets/textures/terracotta-roof-tiles/` | `570e1878985993bf` | albedo+normal+roughness+ao; 2048px; 9.9 MB |
| `painted-plaster` | Amal Kumar | [painted_plaster_wall](https://polyhaven.com/a/painted_plaster_wall) | CC0-1.0 | `public/assets/textures/painted-plaster/` | `6fd812ed8dd5be18` | albedo+normal+roughness+ao; 2048px; 10.4 MB |
| `cobblestone-road` | Rob Tuytel | [cobblestone_floor_08](https://polyhaven.com/a/cobblestone_floor_08) | CC0-1.0 | `public/assets/textures/cobblestone-road/` | `9aaf7db7f660f03d` | albedo+normal+roughness+ao+displacement; 2048px; 8.9 MB |
| `dry-grass` | Charlotte Baglioni | [withered_grass](https://polyhaven.com/a/withered_grass) | CC0-1.0 | `public/assets/textures/dry-grass/` | `0cf0fca68cbf4277` | albedo+normal+roughness+ao+displacement; 2048px; 20.0 MB |
| `meadow-grass` | Charlotte Baglioni | [leafy_grass](https://polyhaven.com/a/leafy_grass) | CC0-1.0 | `public/assets/textures/meadow-grass/` | `8e1c6d21365d4b89` | albedo+normal+roughness+ao+displacement; 2048px; 18.9 MB |
| `mud` | Rob Tuytel | [brown_mud_03](https://polyhaven.com/a/brown_mud_03) | CC0-1.0 | `public/assets/textures/mud/` | `57a87dae26769677` | albedo+normal+roughness+ao+displacement; 2048px; 8.3 MB |
| `dirt-gravel` | Dario Barresi | [gravelly_sand](https://polyhaven.com/a/gravelly_sand) | CC0-1.0 | `public/assets/textures/dirt-gravel/` | `cdab7130a67bc70f` | albedo+normal+roughness+ao+displacement; 2048px; 16.2 MB |
| `sand` | Rob Tuytel | [sand_01](https://polyhaven.com/a/sand_01) | CC0-1.0 | `public/assets/textures/sand/` | `f311767ab68e132c` | albedo+normal+roughness+ao+displacement; 2048px; 6.4 MB |
| `weathered-wood-planks` | Dimitrios Savva, Rico Cilliers | [weathered_brown_planks](https://polyhaven.com/a/weathered_brown_planks) | CC0-1.0 | `public/assets/textures/weathered-wood-planks/` | `070ebc4c56a6729c` | albedo+normal+roughness+ao; 2048px; 3.3 MB |
| `worn-iron` | Dimitrios Savva, Rico Cilliers | [rust_coarse_01](https://polyhaven.com/a/rust_coarse_01) | CC0-1.0 | `public/assets/textures/worn-iron/` | `5b8801674fa53ff1` | albedo+normal+roughness+ao; 2048px; 12.3 MB |
| `steel-plate` | Rob Tuytel | [metal_plate](https://polyhaven.com/a/metal_plate) | CC0-1.0 | `public/assets/textures/steel-plate/` | `864c9a653acd1f50` | albedo+normal+roughness+ao; 2048px; 10.1 MB |
| `rough-linen` | colormass, Rico Cilliers | [rough_linen](https://polyhaven.com/a/rough_linen) | CC0-1.0 | `public/assets/textures/rough-linen/` | `e71016e08dfebea1` | albedo+normal+roughness+ao; 2048px; 15.3 MB |
| `brown-leather` | Rob Tuytel | [brown_leather](https://polyhaven.com/a/brown_leather) | CC0-1.0 | `public/assets/textures/brown-leather/` | `b0de2403a31efa31` | albedo+normal+roughness+ao; 2048px; 9.1 MB |
| `ruins-bark-albedo` | Quaternius | [ruins pack](https://quaternius.com/packs/ultimatemodularruins.html) | CC0-1.0 | `public/assets/models/ruins/` | `d6fdb3cbf6df624b` | albedo; 768px; 0.2 MB |
| `ruins-leaf-albedo` | Quaternius | [ruins pack](https://quaternius.com/packs/ultimatemodularruins.html) | CC0-1.0 | `public/assets/models/ruins/` | `34649aec779adde6` | albedo; 512px; 0.1 MB |

### Coverage against the brief

| Requested material | Delivered | Poly Haven asset |
| --- | --- | --- |
| Roman travertine | `roman-travertine-blocks` (substitute) | `sandstone_blocks_08` - tan, large uneven blocks with soft rounded edges and tool marks |
| White marble | `white-marble` | `marble_01` |
| Terracotta roof tiles | `terracotta-roof-tiles` | `clay_roof_tiles_02` |
| Painted plaster / stucco | `painted-plaster` | `painted_plaster_wall` |
| Cobblestone / Roman road paving | `cobblestone-road` | `cobblestone_floor_08` |
| Dry grass | `dry-grass` | `withered_grass` |
| Meadow grass | `meadow-grass` | `leafy_grass` |
| Mud | `mud` | `brown_mud_03` |
| Dirt / gravel | `dirt-gravel` | `gravelly_sand` |
| Sand | `sand` | `sand_01` |
| Rough limestone blocks (city walls) | `limestone-wall-blocks` (substitute) | `large_sandstone_blocks_01` - large weathered ashlar, warm beige/ochre |
| Weathered wood planks | `weathered-wood-planks` | `weathered_brown_planks` |
| Bronze / brass metal | **not delivered** | no bronze, brass, copper, gold or patina PBR set exists in the Poly Haven library (searched `brass`, `bronze`, `copper`, `gold`, `patina`, `oxid` across all 787 textures and the full 25-asset `metal` category - zero hits). Not substituted, because labelling a ferrous texture "bronze" would be a false provenance claim. Tint `steel-plate` in-shader instead. |
| Worn iron / steel | `worn-iron` + `steel-plate` | `rust_coarse_01`, `metal_plate` |
| Leather | `brown-leather` | `brown_leather` |
| Fabric / linen / wool | `rough-linen` | `rough_linen` (linen/hessian weave) |

"Substitute" rows mean the exact material name in the brief does not exist upstream and
the closest genuine match was taken. The `name` field in `manifest.json` describes what
the texture actually is, and `sourceId` always points at the real upstream asset.

---

## Models

All Quaternius, all CC0. `upAxis: "Y"` and `unitScaleFactor: 1` verified by reading the
FBX header `GlobalSettings` (`UnitScaleFactor = 1.0`, `UpAxis = 1`) and, for glTF, from
the spec-mandated metre/Y-up convention.

### Rigged animals -- `public/assets/models/animals/`

Self-contained `.gltf` (base64-embedded buffers, no `.bin` sidecars, no external
images - verified by parsing every file and confirming zero non-`data:` URIs). 13
animation clips each: `Attack_Headbutt, Attack_Kick, Death, Eating, Gallop, Gallop_Jump,
Idle, Idle_2, Idle_Headlow, Idle_HitReact1, Idle_HitReact2, Jump_toIdle, Walk`.

| Asset | Creator/Author | Source URL | License | Local path | SHA-256 (first 16) | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `animal-horse` | Quaternius | [Ultimate Animated Animals](https://quaternius.com/packs/ultimateanimatedanimals.html) | CC0-1.0 | `public/assets/models/animals/Horse.gltf` | `3deb61550dff1d27` | rigged, 13 clips, 8 materials, 3.44 MB |
| `animal-horse-white` | Quaternius | [Ultimate Animated Animals](https://quaternius.com/packs/ultimateanimatedanimals.html) | CC0-1.0 | `public/assets/models/animals/Horse_White.gltf` | `f137ee67bd565244` | rigged, 13 clips, 7 materials, 3.44 MB |
| `animal-donkey` | Quaternius | [Ultimate Animated Animals](https://quaternius.com/packs/ultimateanimatedanimals.html) | CC0-1.0 | `public/assets/models/animals/Donkey.gltf` | `4cbb2eb7d057789c` | rigged, 13 clips, 8 materials, 3.40 MB |
| `animal-bull` | Quaternius | [Ultimate Animated Animals](https://quaternius.com/packs/ultimateanimatedanimals.html) | CC0-1.0 | `public/assets/models/animals/Bull.gltf` | `535da2992eb125d5` | rigged, 13 clips, 7 materials, 2.97 MB |

### Humanoid character bases -- `public/assets/models/characters/`

Self-contained `.gltf`, all on the same Quaternius humanoid rig, so clips are
interchangeable between them. 24 clips each, including the combat-relevant
`Idle, Idle_Neutral, Idle_Sword, Sword_Slash, Punch_Left, Punch_Right, Kick_Left,
Kick_Right, HitRecieve, HitRecieve_2, Death, Walk, Run, Run_Back, Run_Left, Run_Right,
Roll, Interact, Wave` (the remaining five are firearm clips, irrelevant here).

Untextured - every material is a flat colour, so they are designed to be re-materialised.
That is convenient for this project: re-tint them for Roman tunics, mail and segmentata.

| Asset | Creator/Author | Source URL | License | Local path | SHA-256 (first 16) | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `character-adventurer` | Quaternius | [Ultimate Modular Characters](https://quaternius.com/packs/ultimatemodularcharacters.html) | CC0-1.0 | `public/assets/models/characters/Adventurer.gltf` | `21f7a61afb6bd6ce` | rigged, 24 clips, 11 materials, 3.50 MB |
| `character-farmer` | Quaternius | [Ultimate Modular Characters](https://quaternius.com/packs/ultimatemodularcharacters.html) | CC0-1.0 | `public/assets/models/characters/Farmer.gltf` | `46d3e85fa8d848ee` | rigged, 24 clips, 8 materials, 2.86 MB |
| `character-worker` | Quaternius | [Ultimate Modular Characters](https://quaternius.com/packs/ultimatemodularcharacters.html) | CC0-1.0 | `public/assets/models/characters/Worker.gltf` | `e49f8ec0f8a7de72` | rigged, 24 clips, 11 materials, 2.83 MB |
| `character-king` | Quaternius | [Ultimate Modular Characters](https://quaternius.com/packs/ultimatemodularcharacters.html) | CC0-1.0 | `public/assets/models/characters/King.gltf` | `659c7d84dcea8c63` | rigged, 24 clips, 9 materials, 3.61 MB |

### Vegetation and terrain scatter -- `public/assets/models/nature/` (46 files)

Binary FBX (`Kaydara FBX model, version 7400`), untextured flat-colour materials.
Curated subset of the 150-model Ultimate Nature Pack. Everything climatically or
historically wrong for a Mediterranean/Roman setting was deliberately left behind -
see [Skipped assets](#skipped-assets-and-why).

| Group | Files | Ids |
| --- | --- | --- |
| Broadleaf trees | 5 | `nature-common-tree-1` .. `-5` |
| Dead broadleaf trees | 3 | `nature-common-tree-dead-1` .. `-3` |
| Pines | 5 | `nature-pine-tree-1` .. `-5` |
| Willows (riverbank) | 3 | `nature-willow-1` .. `-3` |
| Palms (North Africa / Egypt theatres) | 2 | `nature-palm-tree-1`, `-2` |
| Rocks | 7 | `nature-rock-1` .. `-7` |
| Mossy rocks | 3 | `nature-rock-moss-1` .. `-3` |
| Bushes | 4 | `nature-bush-1`, `-2`, `nature-bush-berries-1`, `-2` |
| Grass / groundcover | 4 | `nature-grass`, `nature-grass-2`, `nature-grass-short`, `nature-flowers` |
| Small plants | 5 | `nature-plant-1` .. `-5` |
| Battlefield debris | 4 | `nature-tree-stump`, `-moss`, `nature-wood-log`, `-moss` |
| Crop | 1 | `nature-wheat` (Roman farmland) |

Pack source: <https://quaternius.com/packs/ultimatenature.html> - Creator: Quaternius -
License: CC0-1.0 - Total 1.5 MB.
Per-file SHA-256 in [Appendix A](#appendix-a--complete-sha-256-index).

### Modular ruins / architecture -- `public/assets/models/ruins/` (42 files)

Binary FBX. Curated subset of the 92-model Ultimate Modular Ruins pack, keeping the
**round-arch** (Roman) forms and dropping the Gothic ones and the fantasy-dungeon props.
Architectural pieces sit on a **2-unit grid**: `ruins-wall` measures 2.00 x 2.00 units
with 0.29 thickness and `ruins-column-round` is 4.00 units tall (measured by parsing the
FBX `Vertices` arrays directly).

| Group | Files | Ids |
| --- | --- | --- |
| Round arches | 2 | `ruins-arch-round`, `ruins-arch-round-round-column` |
| Columns | 4 | `ruins-column-round`, `-round-short`, `ruins-column-square`, `ruins-column-bridge-support` |
| Walls (intact / half / broken / holed / overgrown) | 8 | `ruins-wall`, `-half`, `-broken`, `-hole`, `-double-broken`, `-arch-round`, `-arch-round-broken`, `-overgrown` |
| Floors | 5 | `ruins-floor-standard`, `-half`, `ruins-floor-square-large`, `ruins-floor-squares`, `ruins-floor-diamond` |
| Stairs / bridge / masonry | 5 | `ruins-stairs`, `ruins-stairs-2`, `ruins-bridge-section`, `ruins-brick`, `ruins-bricks` |
| Structural supports and rails | 6 | `ruins-support-center`, `-left`, `-right`, `-tall`, `ruins-rail-straight`, `ruins-rail-corner` |
| Openings | 3 | `ruins-doors-round-arch`, `ruins-window-open`, `ruins-window-bars` |
| Baggage-train props | 9 | `ruins-barrel`, `ruins-crate`, `ruins-cart`, `ruins-pot1`..`pot3`, `ruins-pot1-broken`, `ruins-pot2-broken`, `ruins-torch` |

Pack source: <https://quaternius.com/packs/ultimatemodularruins.html> - Creator:
Quaternius - License: CC0-1.0 - Total 1.6 MB (plus the two shared
albedo maps listed in the textures table). Per-file SHA-256 in
[Appendix A](#appendix-a--complete-sha-256-index).

> `Bark_Texture.jpg` and `Leaf_Texture.png` must stay in `public/assets/models/ruins/`.
> The FBX materials resolve them by relative filename; moving them breaks the overgrown
> wall and tree pieces.

---

## `manifest.json` contract

`public/assets/manifest.json` is the runtime index. Top-level shape is exactly
`{ "hdris": [...], "textures": [...], "models": [...] }`. Every `path` is root-relative
(`/assets/...`), served directly by Vite from `public/`, and every one has been verified
to exist on disk.

Field semantics that are not self-evident:

| Field | Meaning |
| --- | --- |
| `textures[].tiling` | Recommended UV repeats **per 1 world metre**. For a Three.js plane of `size` metres: `texture.repeat.set(size * tiling, size * tiling)` with `wrapS/wrapT = RepeatWrapping`. `0.5` means the texture covers 2 m. |
| `textures[].maps.*` | Either a root-relative path or `null`. `null` means that map was deliberately not fetched; do not construct the path yourself. |
| `textures[].colorSpace` | Per-map colour space. Only `albedo` is `srgb`; set `texture.colorSpace = THREE.SRGBColorSpace` on it and leave the rest linear (`NoColorSpace`). |
| `textures[].normalMapConvention` | Always `"opengl"` for the Poly Haven sets - +Y green channel, matching Three.js. No channel flip needed. |
| `textures[].resolutionPx` | Nominal square resolution. Two sets are actually 2048x2052 upstream (`limestone-wall-blocks`, `cobblestone-road`); non-power-of-two height is fine for `RepeatWrapping` in WebGL2. |
| `hdris[].timeOfDay` | One of `dawn`, `midday`, `afternoon`, `sunset` - normalised from Poly Haven's `attributes.time_of_day`. |
| `hdris[].weather` | One of `partly-cloudy`, `overcast` - normalised from `attributes.weather`. |
| `models[].format` | `"gltf"` -> `GLTFLoader`; `"fbx"` -> `FBXLoader` from `three/examples/jsm/loaders/FBXLoader.js`. |
| `models[].animations` | Clip names in load order, so `gltf.animations[i].name` matches. glTF only. |
| `models[].upAxis` / `unitScaleFactor` | `"Y"` / `1` for everything here - no import rotation or rescale needed. |
| `models[].embeddedBuffers` | `true` for all glTF: geometry and animation are base64 in the `.gltf`, so a single request loads the whole model. |
| `models[].texturesEmbedded` | `false` for all FBX - they carry flat-colour materials only, except the ruins pieces that reference the two shared albedo maps. |

### Scale caveat, stated honestly

Characters measure **1.86-1.90 m tall** in bind pose (computed by walking the glTF node
hierarchy and transforming accessor min/max), i.e. correct human scale at 1 unit = 1 m.

The **animals are not** at real-world scale in bind pose: `animal-horse` measures
1.41 x 4.82 x 5.68 m and `animal-bull` 2.51 x 4.59 x 8.07 m. A real horse is roughly
1.6 m at the withers and 2.4 m long, so expect to scale animals down by roughly 0.3-0.4.
These numbers are the bind-pose bounding box, not the animated silhouette - measure with
`new THREE.Box3().setFromObject(model)` after the first animation update and derive the
factor rather than trusting this note.

FBX bounds are deliberately **not** published in the manifest. The raw `Vertices` arrays
are in Blender's Z-up local space and several props (e.g. `ruins-barrel`, whose mesh is
only 0.16 units across) carry their real size in a node-level scale that FBXLoader
applies at load time. Measure with `Box3.setFromObject` after loading.

---

## Skipped assets and why

| Skipped | Where it would have come from | Precise reason |
| --- | --- | --- |
| **All Sketchfab models** | sketchfab.com | Downloading any model requires an authenticated account. The task forbids logging in, and without the download it is impossible to confirm that the file actually carries the license shown on the page, or that the upload is not itself a re-upload of copyrighted game content (Sketchfab is a common destination for Total War / Rome II mesh rips). No Sketchfab asset was fetched and no Sketchfab license was assumed. |
| **Universal Animation Library 1** | quaternius.com -> `quaternius.itch.io/universal-animation-library` | The quaternius.com download button points at itch.io, not a direct file. The free "Standard" tier (15 MB, 45 clips, CC0) sits behind itch.io's *name-your-own-price* checkout widget: the form's `csrf_token` is empty in the served HTML and the `direct_download_btn` `href` is empty, both filled in by JavaScript. Getting the file means executing their JS, POSTing a CSRF token through a purchase flow, and following a session-bound `/download/<key>` URL that expires. That is neither a stable URL for `fetch-assets.mjs` nor something to fake, so it was skipped. |
| **Universal Animation Library 2** | `quaternius.itch.io/universal-animation-library-2` | Same itch.io checkout gate as above. |
| **Universal Base Characters** | `quaternius.itch.io/universal-base-characters` | Same itch.io checkout gate as above. Partially compensated for: `Ultimate Modular Characters` ships four rigged humanoid bases with 24 clips each from Quaternius' Google Drive, and those **were** fetched. |
| **Ultimate Stylized Nature (glTF)** | Quaternius Google Drive | Its glTF export is split into `.gltf` + sidecar `.bin` pairs, and `.bin` is outside this task's extension allowlist. Fetching the `.gltf` without its buffer would produce 63 broken files, so the whole pack was skipped rather than half-fetched. Its FBX variant was skipped too, as `Ultimate Nature Pack` already covers vegetation. |
| **Ultimate Nature Pack glTF/GLB** | quaternius.com | Does not exist. The pack page lists FBX, OBJ and Blend only - confirmed in the pack page's own formats table. FBX was taken (it preserves the per-part flat-colour materials that OBJ would drop). |
| **Bronze / brass PBR texture** | Poly Haven | No such asset in the library - see the coverage table above. Deliberately not substituted. |
| **Poly Haven `.exr` HDRIs** | Poly Haven | `.hdr` at 2K is 4-6 MB where the same `.exr` is 20 MB, and Three.js `RGBELoader` handles `.hdr` natively. Pure size decision. |
| **Poly Haven `nor_dx` normal maps** | Poly Haven | DirectX green-channel convention; wrong for Three.js. Only `nor_gl` was taken. |
| **`.blend` source files** | Quaternius Google Drive | Allowed by the extension allowlist but useless at runtime and 10-20x larger than the FBX. Not fetched. |
| **`Preview.mp4` / `Preview.jpg` / `AllModels.blend`** | Quaternius Google Drive | Marketing material, not game assets. |
| **Snow, autumn, cactus, corn and lilypad nature variants** | Ultimate Nature Pack | Climatically or historically wrong for a Mediterranean Roman setting. Cactus and maize are New World plants and would be an anachronism on a Roman battlefield. |
| **Birch trees** | Ultimate Nature Pack | Northern/boreal species; excluded on the same grounds. All 25 birch variants skipped. |
| **Gothic arches, bear traps, bookcases, chests, candles, trapdoors, fox/stag statues** | Ultimate Modular Ruins | Medieval-fantasy dungeon dressing, not Roman architecture. |
| **Modern character bases** (`Punk`, `Swat`, `Spacesuit`, `Beach`, `Suit`, `Casual_Hoodie`, `Casual_2`) | Ultimate Modular Characters | Wrong period. Only `Adventurer`, `Farmer`, `Worker` and `King` were taken as generic humanoid bases to re-material. |
| **Anything from Total War / Rome II or any commercial game** | - | Never sought, never fetched. Not licensable. |

---

## Safety verification performed

**`clamscan` is not installed on this machine and no scanner was installed.** There is
therefore **no signature-based anti-malware result** for these files. What follows is the
layered structural verification that was run instead, described exactly as executed so
the gap is not papered over.

1. **Source allowlisting.** Bytes came from exactly three hosts:
   `api.polyhaven.com` (metadata), `dl.polyhaven.org` (Poly Haven binaries), and
   `drive.google.com` (Quaternius binaries). The Google Drive folders are the targets
   the download buttons on `quaternius.com` pack pages themselves point at - verified by
   fetching each pack page and reading the `window.open(...)` URL out of its download
   modal. No mirrors, no URL shorteners, no re-upload sites, no third-party asset
   aggregators. `fetch-assets.mjs` enforces this allowlist on the *final* URL after
   redirects, so an off-allowlist redirect aborts the download.

2. **Extension allowlisting.** Only `.hdr`, `.jpg`, `.png`, `.gltf` and `.fbx` were
   written. `fetch-assets.mjs` refuses to write any path whose extension is outside
   `.glb .gltf .fbx .obj .blend .png .jpg .jpeg .webp .hdr .exr .wav .mp3 .zip`.

3. **Archive handling: not applicable, and that is a result, not an omission.** The final
   asset set contains **zero archives**. Poly Haven serves individual files through its
   API, and the Quaternius Drive folders hold loose per-model files rather than pack
   zips, so nothing was ever extracted. Confirmed after the fact:
   `find public/assets -type f \( -name '*.zip' -o -name '*.tar*' -o -name '*.gz' -o
   -name '*.dmg' -o -name '*.pkg' \)` returns nothing. Had a zip been involved, the
   procedure was `unzip -l` first and reject-without-extracting on any
   `.exe .dll .so .dylib .sh .bat .cmd .scr .app .pkg .dmg .command .vbs .ps1` member.

4. **Real-type verification with `file` on all 172 files.** Every file's actual format
   matches its extension:

   | `file` reports | Count | Extension |
   | --- | --- | --- |
   | `Kaydara FBX model, version 7400` | 88 | `.fbx` |
   | `JPEG image data, ... 2048x2048` / `2048x2052` / `768x768` | 71 | `.jpg` |
   | `ASCII text` (valid glTF 2.0 JSON) | 8 | `.gltf` |
   | `Radiance HDR image data` | 4 | `.hdr` |
   | `PNG image data, 512 x 512, 8-bit/color RGBA` | 1 | `.png` |

   No `.png` turned out to be an executable, no `.jpg` turned out to be a script. Nothing
   had to be deleted.

5. **Executable/library rejection sweep.**
   `find public/assets -type f -print0 | xargs -0 file | grep -iE
   'executable|shared library|Mach-O|ELF|script|bytecode|dylib'` -> **no matches.**
   `fetch-assets.mjs` also rejects, before writing, any payload starting with `MZ`
   (PE/DOS), `\x7fELF`, any of the six Mach-O magics, `CAFEBABE`, or `#!`.

6. **Magic-byte format checks at download time.** `fetch-assets.mjs` verifies signatures
   per format (`FFD8FF` for JPEG, the 8-byte PNG signature, `#?` for Radiance,
   `Kaydara FBX Bina` for binary FBX, leading `{` for glTF) and explicitly rejects any
   response whose head matches `<!doctype html`, `<html` or `<?xml`. This is what stops a
   Google Drive interstitial or an error page being saved as a model. All 172 passed.

7. **SHA-256 pinning, with a live tamper test.** Every file's hash is recorded here, in
   `manifest.json`, and in `fetch-assets.mjs`. To prove the check is real rather than
   decorative, `public/assets/textures/white-marble/roughness.jpg` was deliberately
   corrupted by appending bytes: `--verify` reported
   `MISMATCH ... (got d8cf43129567958f)` and exited non-zero, a plain run discarded the
   bad copy and re-fetched a byte-correct one, and a follow-up `--verify` returned
   `ok=172`.

8. **glTF structural parse.** All 8 glTF files were parsed as JSON and inspected. Each
   is valid glTF 2.0, is fully self-contained (zero `buffers[].uri` or `images[].uri`
   values that are not `data:` - so no hidden fetch of an external `.bin` at load time),
   and carries exactly one skin plus its declared animation clips. Generator strings are
   `Khronos glTF Blender I/O v1.6.16` / `v1.7.33`.

9. **macOS quarantine attribute check.** `xattr -p com.apple.quarantine` was run against
   every file: **no file carries a quarantine flag**, consistent with download via
   `curl`/Node rather than a browser. (This is a provenance observation, not a safety
   guarantee - the absence of the flag means macOS Gatekeeper never tagged them, not
   that they were scanned.)

10. **Sanity checks.** No zero-byte or sub-1 KB truncated files. All 172 manifest paths
    resolve to real files. All 118 manifest ids are unique lowercase-kebab.

### Residual risk, stated plainly

These checks establish *what these files are* - correctly-formed image, HDR, FBX and
glTF data from two named CC0 publishers, byte-identical to what those publishers served,
containing no executable code at their heads. They do **not** constitute a malware scan.
The realistic residual risks are (a) a malformed-media parser exploit in a loader, which
no signature scanner would have caught either, and (b) upstream compromise of Poly Haven
or a Quaternius Drive folder before download. Pinning SHA-256 at least means any *future*
change to those upstreams becomes a loud verification failure rather than a silent swap.

---

## Appendix A -- complete SHA-256 index

Full 64-character digests for all 172 files, in `shasum -a 256` order
(`<hash>  <path relative to public/>`). Regenerate with
`node tools/fetch-assets.mjs --print-hashes`.

```text
5244534e9cf5b606f2ff513aa00ddb161b0a4826ffd88a0d3bd03ac29247d198  assets/hdri/midday-partly-cloudy-2k.hdr
99451201586489ef3288c97bfac2a2ac232a5491c51a1faf0ec8ea39f3ccd533  assets/hdri/golden-hour-sunset-2k.hdr
312b1b04b7f10057a4f1418abc59d1166c8933cc93fc72051502edaf8d6b2fcd  assets/hdri/overcast-afternoon-2k.hdr
7261c613b35a9b760ed5c7846ec8182532b90d89f6a8385c42bb743883159a66  assets/hdri/dawn-sunrise-2k.hdr
da2f453c7c3683f5b01ca8b365ccf81ebce488afab7661adecd83208fc9aec97  assets/textures/roman-travertine-blocks/albedo.jpg
735f205de2d44f2e7edddf22d6b7dca5cd2ace000f3f637546302508dd9616c2  assets/textures/roman-travertine-blocks/normal.jpg
676d9f00b54f303dc19856123312110be3859066661b224dececc3bc857c8f21  assets/textures/roman-travertine-blocks/roughness.jpg
8c77ecef52727a13a3e6afa731390c37c285692de9703da426402fe1e61b611f  assets/textures/roman-travertine-blocks/ao.jpg
d403786171716f86718bdd67eba923d4fb6125c0636bacef0e6a21dd5d623a48  assets/textures/white-marble/albedo.jpg
d5e17ccb2913adbf28fcb781fddf0aa711259ddea6c1c918442f9a3589aa4660  assets/textures/white-marble/normal.jpg
1b970e033856c93ee7390d947da5340e101b489fc8c1463354ea9e6655ce039a  assets/textures/white-marble/roughness.jpg
e0d535b591430f1ebfd8ffa38086949bb074ae470f6fec7f3dcd55f594f52d4e  assets/textures/white-marble/ao.jpg
87e5f9404e8aa572d6a21ba86e57a67d17c71e39dfcd9ca0699393a1d116d425  assets/textures/limestone-wall-blocks/albedo.jpg
10980fa925525e08450779599756b3852370640010b29b59a583609917d92047  assets/textures/limestone-wall-blocks/normal.jpg
5e8294a1954d5aec314159822ccb0d06b198784b617511d86ea77f635265c423  assets/textures/limestone-wall-blocks/roughness.jpg
80ffa0f03d975b36a5d74a46212365a5570fc5b9f75233178aada35e1ead86bf  assets/textures/limestone-wall-blocks/ao.jpg
570e1878985993bf81433d785b4fa2d4ab9f6d32447706193089b11ff0851731  assets/textures/terracotta-roof-tiles/albedo.jpg
762e2f18ba063fe3c587955be9f8a0a6e8e75cee4057e188970d1ec70a880194  assets/textures/terracotta-roof-tiles/normal.jpg
a70d571203b80f763a6bcd4463330d8e2a5480ee6e29b559d1a05f1a61d5a81e  assets/textures/terracotta-roof-tiles/roughness.jpg
c49e8cc0175ed764ca3e25c4bfeb71184acb80049570959be8def17e271e943e  assets/textures/terracotta-roof-tiles/ao.jpg
6fd812ed8dd5be1873c29aeef38ce9bf1fb30a22c6d4b3a12db725e98c26a1be  assets/textures/painted-plaster/albedo.jpg
2d601a46ed5ce2af866741c53cafa3cba472620c272e633b6484d4de16a80eb1  assets/textures/painted-plaster/normal.jpg
35aad595469533cc3b7cc209cc6c7e065d660211f02c867f4492d3b371b1fee1  assets/textures/painted-plaster/roughness.jpg
3d89b5ea1f9d93d611ab0015d887b620ec9c6623e19effadba84ee9345c4c6fc  assets/textures/painted-plaster/ao.jpg
9aaf7db7f660f03d0c5c129c11e83caa828fb8bca63f8cd5154d450ffc4c340f  assets/textures/cobblestone-road/albedo.jpg
42dd5fc2da4a858f9c076c9ac5002857a1c064f8f4c4ffb12fafecffb84e96cc  assets/textures/cobblestone-road/normal.jpg
3bc645ec45543c704fe1042f7b81f9bad4f88a8567760c4898c82bc2a134e093  assets/textures/cobblestone-road/roughness.jpg
f409fa52dceac782dcb625af914fd592105595749651f396547e8355867b6a5c  assets/textures/cobblestone-road/ao.jpg
503cf1444d98526e4105b065112c36258c0063e0fa0a86c573c29f45eecebe88  assets/textures/cobblestone-road/displacement.jpg
0cf0fca68cbf4277199a2b9b7b3a8013357e4087247b1367f86d4a53b4fafa7e  assets/textures/dry-grass/albedo.jpg
5fd42baf06224086cb9afcb2f7a3b9f26feddd719bf1f9aed65ec49c586e7ff9  assets/textures/dry-grass/normal.jpg
86adb8d6f24d0a38eb96c6b625f2dd027b805f59af46fe2a05ffe29f633e33c8  assets/textures/dry-grass/roughness.jpg
b91ec4cab6fdd8034c928647a4ad9a09a5b99744db8d18c0743ead407c8d1b93  assets/textures/dry-grass/ao.jpg
2e9ade0a66c6d6b9990ce19ead20b155e1aed7969e4e86f8210fc7595dd2983d  assets/textures/dry-grass/displacement.jpg
8e1c6d21365d4b89bc5a35ab664da98a78dbc3ab9ba6100474881c8619a5b113  assets/textures/meadow-grass/albedo.jpg
df0cf0ce96e653f033e5b934d5b12995464bda027aa53bd12e329be889aa9f45  assets/textures/meadow-grass/normal.jpg
34e1733bf4064b6950a575ff57e78c8b7ff71b63749eb48a49221bd65de6fb4f  assets/textures/meadow-grass/roughness.jpg
bcce4368f6a1affe11b4a643e14cfed7dfb46abf6bb9e6a28a3b87c2de2ddb11  assets/textures/meadow-grass/ao.jpg
de34be0f135a3c92fe6e55cca9501a4cc40e02e84de9cc4c7fefded1da5bd3f3  assets/textures/meadow-grass/displacement.jpg
57a87dae26769677578ab53b8829fe9b1e4dfec1ae1726f2942ce99fc73f400b  assets/textures/mud/albedo.jpg
4d9ea1c9321618dbde7bdb2287fae85b646e4bd7b27c294a3475096d30b33880  assets/textures/mud/normal.jpg
d4beda6f00e1d0bd431360037569cb7807c38a4f3a5102c256f3c24a4bc0e860  assets/textures/mud/roughness.jpg
4ac0ed146a261a00fb6007844841395962304b7382e37c7ed2ca90d1b184d4a4  assets/textures/mud/ao.jpg
295bc090d6c436a84fa2e3402f37b8637ea5c6478b71f6fe892d237ab33cd2f4  assets/textures/mud/displacement.jpg
cdab7130a67bc70f8c241b9ab2cd41b731d2baf1ec533939a333573b80070dd6  assets/textures/dirt-gravel/albedo.jpg
191985454de9403961aab2a6ffd33b6ca1e4c2715712e03f3c928a8140322719  assets/textures/dirt-gravel/normal.jpg
da39087ed3beced52f7ca68f77610ecaa048113c33e49a47cb6e7d930733fcaa  assets/textures/dirt-gravel/roughness.jpg
e98b986061c0919cb09cf7494cf142094c602690e496752cc2a876b3f0a32a71  assets/textures/dirt-gravel/ao.jpg
1708db581f6a915b25af3711a923e4b7e7da79ba0828f113797e42d4bd308a08  assets/textures/dirt-gravel/displacement.jpg
f311767ab68e132cb9de4160493a71ff17ec765c699d411facd5154d9a9a9c18  assets/textures/sand/albedo.jpg
b784b6a0526b79c81635bf423be9bc517ad36278ae5d68a4ff30f46eac56f0e3  assets/textures/sand/normal.jpg
60ec73993d245be5dab83f9debb67cab4303a0af9d4cec3f28868a58f939f8db  assets/textures/sand/roughness.jpg
869cb6a93c2fb37fbe37236b33e386871134a5b154354396c7ba000f1be09b22  assets/textures/sand/ao.jpg
3edaf84b5075600a0c26665d69e4c45dc8bf9df045f126fd18686d0688448a5f  assets/textures/sand/displacement.jpg
070ebc4c56a6729ca73a791f7cd3bab7670eb03bfa9ac0218864a554228bcc30  assets/textures/weathered-wood-planks/albedo.jpg
1c4882afd62de8da66b6e0730894e1a08db1e0cdd2370bd8bce77a6935d8812b  assets/textures/weathered-wood-planks/normal.jpg
6897855d0e2758b612fd8cf478aed01b4992d856987a8b4951e5758a48003df2  assets/textures/weathered-wood-planks/roughness.jpg
69d2aa676f199365dd63253b36db7e1ac78eafbb835055528856c9c3d16d3e5f  assets/textures/weathered-wood-planks/ao.jpg
5b8801674fa53ff1b6f7853300f50aa7a1b31e69278554803bd957fe9fa7e392  assets/textures/worn-iron/albedo.jpg
495d3c87da059827ffaf49dae59f967cb3e0b187f4426ab0a47088c3fa83e50b  assets/textures/worn-iron/normal.jpg
652eaa2e668c4d24b038716e01c460e6614429634f67ddbcd7f9593296a24885  assets/textures/worn-iron/roughness.jpg
4340b7de13e1690b2132234ec631d9b1166c70ae2c8076b2d32cf51808bad7f5  assets/textures/worn-iron/ao.jpg
864c9a653acd1f5034c9bbe7f955b18cc9687a81bbdfa805e7a2319939676910  assets/textures/steel-plate/albedo.jpg
146f8c00874a584bcc4a184643e72f160da2a7568d469198e02b26c9ff93cf43  assets/textures/steel-plate/normal.jpg
3cdc139df4ec5b304dd986278c1fb026c67c42e6623f0ee5caa7f373d51c7bef  assets/textures/steel-plate/roughness.jpg
31e586f0bde9f28331077b30495f0f324aa9f91a9d656205d03242d1d3e2e439  assets/textures/steel-plate/ao.jpg
e71016e08dfebea1dd4e8a2a675e3b617a889a782af782f1abb795906f4db1b4  assets/textures/rough-linen/albedo.jpg
c5733ad50cfe0f90c546f3d4076590c1c78a4fd1a83c967cc9c92dc8175b99e6  assets/textures/rough-linen/normal.jpg
48400d48fa203882bf5d984d5beb2f95edb1550309924601c018f2c4f3f80731  assets/textures/rough-linen/roughness.jpg
277399dfd364393c506fb35f7b868a2d3c0c388400439c327829cf787bc7c315  assets/textures/rough-linen/ao.jpg
b0de2403a31efa31e501b0028c0bd8e504d5bd6318f4a5ce90c550c3067f96d8  assets/textures/brown-leather/albedo.jpg
3386277290af50b4d464dc9a9f195bbf8dd6f137b9ae0274552397d2f0135c98  assets/textures/brown-leather/normal.jpg
8a47afca2630310849034fe40ca9497db0956c67c0d933e6efd49d3cd2befe83  assets/textures/brown-leather/roughness.jpg
0f1f8753775779d4e25512f4d08aec1e7dbb73b1d0dc98df66af2071fe8bfa77  assets/textures/brown-leather/ao.jpg
0b744c9092a09bfb7228d5ecce26c665363e0f22725d3d89e356dc13789498c3  assets/models/nature/CommonTree_1.fbx
b3ca339781adc90ca0714d5d3fb081e5432f4a0e47f2697b7865a907b39c93cc  assets/models/nature/CommonTree_2.fbx
c6c09a4d4797d2b0651cdf8e56ea7baecefd8eb4b4a79fc680ef17747c42b70e  assets/models/nature/CommonTree_3.fbx
611134a64de288ba485ba429478978b8572ff9d74e5d1798f7389b4bbacf43d7  assets/models/nature/CommonTree_4.fbx
65f4b9dd21c242d311199406afbd7e6e20785cc66c57ee4db76d5a7c38d3dd4a  assets/models/nature/CommonTree_5.fbx
e8b1abbacb9f77f2535670c64a0ebe1e9526c5e591f1509067794630124f6591  assets/models/nature/CommonTree_Dead_1.fbx
d5c3d823d515cbfddb0305c5046136348d43230bf5bfc1cbf5951f0632a16b00  assets/models/nature/CommonTree_Dead_2.fbx
67ca71199a30e8d61b8c1c5094be60dec2cb90c2b597e890d3fc8bfce0343ddd  assets/models/nature/CommonTree_Dead_3.fbx
5627e2f33577398ea13ab63f4263afb6cdd4839bf6b4e5d288d6174ff2887266  assets/models/nature/PineTree_1.fbx
afc20aab8e9c35ea5e5edf1366d312f8f94948f4d00a40445feb9367cd3e06a3  assets/models/nature/PineTree_2.fbx
e4f038ab6bc8390a5a387bc99fb6b917bb93b6d673d1ac8c22a07521300c1ffc  assets/models/nature/PineTree_3.fbx
7451481e4ae14102b01632bd74e04072cf22b9ce84819175e45220e0ac8bda4f  assets/models/nature/PineTree_4.fbx
f48c82f590fd94e9dd265575232f867963d08e1d57c9b473e4e1e069220e5536  assets/models/nature/PineTree_5.fbx
4490d814ed6f744e2390e635a1be31faf461806bfb25b0e15a1203cf4660cb60  assets/models/nature/Willow_1.fbx
9614a514370a608493aaf2cf04340c57334672804bb06528103ad65dfc73fa3e  assets/models/nature/Willow_2.fbx
3a29483120f919f803604cbcbb0cad6bdf240e3c012143e56875495662d79a33  assets/models/nature/Willow_3.fbx
bcf142d8a1ceae00edcf4036de1b4cdb43239c578bbd693737b9ed5fa8818df6  assets/models/nature/PalmTree_1.fbx
716e9e71270e56a8d2eeb69e48014a8ae390d20383e5f3b8f2c50a4d1dd4d815  assets/models/nature/PalmTree_2.fbx
8a6e150e2d71dd601daf48d7967e273e940347a4826c2004b71ed1a9fa99c962  assets/models/nature/Rock_1.fbx
5a06ef3ec0b90098666407792fd2ea03879a10d3d0b0fe09b47f0df3a04025a1  assets/models/nature/Rock_2.fbx
4144136bd6c313ac7c48a08548504d7d30b7d628f35ce9dcd290ebe84e10e734  assets/models/nature/Rock_3.fbx
a914a59150ad1c12ff01ffc11de22b826fee9d52dabeb703fb43e7bde1f04e1d  assets/models/nature/Rock_4.fbx
a335cfa716e962010450026884f19c7474967682334635286ca315eef3490c94  assets/models/nature/Rock_5.fbx
36f79bdcae803b60e5968487f4a9b26f589490817ace655a1045b960d1af81f3  assets/models/nature/Rock_6.fbx
a7e68ae16e6e7af933ad81249a1a7eadf5940d3528eeea9963751a3b3efd8129  assets/models/nature/Rock_7.fbx
94ea25751e2ce17ca55ab0ddf3a70d5fda1fca4f308d883f9e51451162faf20e  assets/models/nature/Rock_Moss_1.fbx
9e6bb49e692da8c21c6cf5cdb77bcf6b9956edb55e1719a265524f7007fc717c  assets/models/nature/Rock_Moss_2.fbx
5f51b88bb9fe3c1a77e504521fca0fe03dc055d406aa2586bd543ef0413aad0e  assets/models/nature/Rock_Moss_3.fbx
ef4fd15c36fd95a19aa769a15b4acde2a22bbfea4ada7144ece5fd82c2e05a0f  assets/models/nature/Bush_1.fbx
73a9aa512b2967ad333451ffb4b4e460f400a7a17a73a0b90fc1656404273388  assets/models/nature/Bush_2.fbx
1e70f836ae535b5e8bc7096abfa5f7fe2517ea8baa6d06964eff5296e39d7edc  assets/models/nature/BushBerries_1.fbx
02c360d6c2738e3ef42610aee3b00604ff2c5722cb6b773e23fa78f6d38cece4  assets/models/nature/BushBerries_2.fbx
849a2ca44c4765b47414bfd83eb8d276835db43c33d2755f7407006f5bb53c7e  assets/models/nature/Grass.fbx
c7d84984661f8330d1c8e1f21f2cb0ede457586526b6bd38306d133d7c4f38c3  assets/models/nature/Grass_2.fbx
7244d7d8a30eb51e11e454083714f39d3b7d1d2512dd395b2acca787c064a7fa  assets/models/nature/Grass_Short.fbx
ffd9ad6299f0058855a97fcc819640ebed7131796c71a2eacb60b53d0d28d4c7  assets/models/nature/Flowers.fbx
14fc5f5b4c29451e21da9626795125f59343952ea700217826a1061b46ea386f  assets/models/nature/Plant_1.fbx
dac0f960bfd59ecf9b9f449b57556e20dc113908d20f042772e79ed87336f6d7  assets/models/nature/Plant_2.fbx
dbf8f891b383b761953c9f497bb7e5dcdecf31de562944625af8181425064b31  assets/models/nature/Plant_3.fbx
6495b56100a2e2cc2b87f5f809daf55fe9119ec3af8d613cfd3c7c659c15c7c3  assets/models/nature/Plant_4.fbx
c1708097421a206f2309efee097038cd2896d9a22da13dd44e948fd2e32e013f  assets/models/nature/Plant_5.fbx
bb2f526c4259a915b49102ad374b9065d87153181c9dfb88a029068826fc88cb  assets/models/nature/TreeStump.fbx
53197f0637f5729af6f6cc4f20125b0575bdf8fa53ed21106430a80de0b35dec  assets/models/nature/TreeStump_Moss.fbx
efc0eacf35939e10b6ca13cac145fda682ae65a624448fd43faebc84d98dbb02  assets/models/nature/WoodLog.fbx
5a18bfd817959e886d0e781efd8c2134801a70c45a86fa000df34b8c09b2a1cf  assets/models/nature/WoodLog_Moss.fbx
590e4345e08fde9b0a5ba6cba205ecc6c6ba7279734325df9412a47621081f18  assets/models/nature/Wheat.fbx
0fa77eafe953ac058e63aedca68ce1a82f02b6bbe009f53a0d3f7fc0120abcc8  assets/models/ruins/Arch_Round.fbx
039670b60b4648a269884cd8378f0bbf0ec13b2f424887f8a90dee7f6fca20e2  assets/models/ruins/Arch_Round_RoundColumn.fbx
c9b3f643c5eca4b39e3490023555a053d0b490ae81a1838ed10940d1c3244d3e  assets/models/ruins/Column_Round.fbx
f9c66da3c80b2576163afc2beee1e6dcbfbb3d65dc9307fb1a134163b9421ad0  assets/models/ruins/Column_Round_Short.fbx
df263445e20b73c2f5983036d55d0c6287984500be5700327b7208eed2e2dcbe  assets/models/ruins/Column_Square.fbx
fd951b16e2e9d0d13ad0b3fea92a374b7a9b89ffee8737386d17a0979e122938  assets/models/ruins/Column_BridgeSupport.fbx
6a37475da866a457f6b2872052c409576c6f7be5838a95cca3a51fbb75e19605  assets/models/ruins/Wall.fbx
7f70fddb4008eea87da8aee398ecda3f7f6ad4a4248f0695a1c9b3d0a0708077  assets/models/ruins/Wall_Half.fbx
6a4383be9c0b2101e1d471d8bb2a33e8b36ca95ca5b86e6b775b12b09ae76439  assets/models/ruins/Wall_Broken.fbx
b5c5e7dbce3b07f9d46c94466820f5127008815e284b85298061384c6df86095  assets/models/ruins/Wall_Hole.fbx
9d5351f316f73577593fa80e0ca495766308a136b79e98411fd71d086bb80693  assets/models/ruins/Wall_Double_Broken.fbx
3e9f6c6a498e9c585ad462e608bb498f0591fc6b80214de7b9281b28c3f857b5  assets/models/ruins/Wall_ArchRound.fbx
1ee949732ccc1599411c8cc6fa2ed7cacf983967695d90f78b3813fdb732d7e8  assets/models/ruins/Wall_ArchRound_Broken.fbx
c0ea1ec251962e5cd04afee5d444cc9019faa1a7b1caed0033ce318dc3f04beb  assets/models/ruins/Wall_Overgrown.fbx
5114ce65e16d4f404cc31294dbae8c1874e7cfefab6bec46ca790f7eba767f36  assets/models/ruins/Floor_Standard.fbx
2ebd309c037122fdacbbc8925b56a699ed328afa3d1734e30ecdb160bf410e42  assets/models/ruins/Floor_Standard_Half.fbx
8f4ae42df3f5990127b1c0b27886deebb411b747ee09c856e88cbcb86bd8cceb  assets/models/ruins/Floor_SquareLarge.fbx
6aa3d8ebae6dccf5ede7b213eebbfe629db089c336b7dafca2b2b9c9f42d1d62  assets/models/ruins/Floor_Squares.fbx
ff22d69fdd431c0e783afd6df7475a0932a0f6fee941884c8c04fe095a510f8a  assets/models/ruins/Floor_Diamond.fbx
b2e9bcbbfb966d43e5800b72a5ac45afd3c11901f5d3d65f9beb2ad127dc4552  assets/models/ruins/Stairs.fbx
c1b646e1e8d4f37d9cea9fe289b1dda0bbdaaff2336b215233e6c4b7a5e7e5c1  assets/models/ruins/Stairs_2.fbx
c26c4a11e868dfe3b342facd1a48aebe8b8fe3b49239fe649509753522deb960  assets/models/ruins/BridgeSection.fbx
645a4a1aea7a9da72609cdff285f701629ee4cb6429c64ef1d1a96853772e4b8  assets/models/ruins/Brick.fbx
7f7d77c199b75e3c7cbb1534ed1c528215c08101b3d567f2a987c25feac273fa  assets/models/ruins/Bricks.fbx
22f3f4fdb6296fff10dcb59f42eb28dd7ceff02982efc67a5df9e33c657d8df4  assets/models/ruins/Barrel.fbx
7418c22870df0c8181996712515abda96d5a0c50f2cb3ee938e69f47dec8a4b9  assets/models/ruins/Crate.fbx
04d89e1d53bb01888aac3450103d45517ee4e63b1584ffc97d7375a177a74b16  assets/models/ruins/Cart.fbx
35fc7a2d293b9635f4ec6711e88ce7cb96fcf7f1a95c268454fb9cf30e999662  assets/models/ruins/Pot1.fbx
23ef6465a25cac19fd3e2b84a0ec61a0d7c530dcb5a77f0aa17867dda7e534bc  assets/models/ruins/Pot2.fbx
3e2bc8d77c498b49cf055b8aef6f729b6acf5be308ea4fce81aefeed816c8337  assets/models/ruins/Pot3.fbx
e318cc8c9ae246206d1c3528dd035d70da7ac9245a1f8aeadda8b14bfdc7b08b  assets/models/ruins/Pot1_Broken.fbx
b3de2b520aa45d4866a529eafd9ae7532f169c9d102bfb2f47a42c0abf8ec610  assets/models/ruins/Pot2_Broken.fbx
f2c06f7c23f88b528a4229354d17e5d04350daa1f8ed3c2fa0df69558826bcc2  assets/models/ruins/Torch.fbx
b5f85de7fb062e76e6a5ddc82f42a7d219449addf5a005842ba866073ea47d0a  assets/models/ruins/Rail_Straight.fbx
fe16c399bafc4232fe260174f773890506230be8edc67b0651cb1a51422cc5f9  assets/models/ruins/Rail_Corner.fbx
84fbc233888cd6e2680646e92526b69eabbbb3245fb84f99a8df5bda67f2b76c  assets/models/ruins/Support_Center.fbx
0435e636f0d24c48d6d3220257a5750f98546bed064cd9117f537280edad1019  assets/models/ruins/Support_Left.fbx
fc8115bcdf26b14e4d1435c33309588570b76022e6a352ba26307f2657c9c6ae  assets/models/ruins/Support_Right.fbx
46c01b4b258249997d6892517ffc4d3b298e3cbdaf0928f3f5dad4fed2c79a99  assets/models/ruins/Support_Tall.fbx
4534d98ed94418f65b3ca1137437fc303bfd9fd604bdf3f83cf37241986c412d  assets/models/ruins/Doors_RoundArch.fbx
cedb47fe8a0c59384e3d6a0a0bf15e7b1ee7eab5dd8ee4ed1ce294b85f0cc7ff  assets/models/ruins/Window_Open.fbx
8f93ea6a05a5ec114dec9339e9c300497129a9d2e243ee89da1fb6b24b25d5de  assets/models/ruins/Window_Bars.fbx
d6fdb3cbf6df624bfe8e5d45fe7b5b1a05ec6d7b1fdb0fa4cc4774b4119bf017  assets/models/ruins/Bark_Texture.jpg
34649aec779adde617568fc89e6ed24277d2bc5b254f592cdf26627f29fe63e0  assets/models/ruins/Leaf_Texture.png
3deb61550dff1d2786d04b6e8559d63ad3907d6ab606ba28ce0af074ed96341b  assets/models/animals/Horse.gltf
f137ee67bd565244f7441f35b5594a597588cda8b60ab109e2041cf13c58e1dd  assets/models/animals/Horse_White.gltf
4cbb2eb7d057789c945b6445d99d0c73b76c0caf7ac9b37ce88a04ca718be2ff  assets/models/animals/Donkey.gltf
535da2992eb125d517725159a2eddeb520b72595bcb3021985fc43d2c84bff76  assets/models/animals/Bull.gltf
21f7a61afb6bd6cef6961490c367594e3c2fc01ec1f041662131172ce763063e  assets/models/characters/Adventurer.gltf
46d3e85fa8d848ee479ab8e4672c16724ee4ea51f3af5733705a153937f93555  assets/models/characters/Farmer.gltf
e49f8ec0f8a7de72dd26b1c01e6413c9a87a9116eeee21f9364ccd36bc286335  assets/models/characters/Worker.gltf
659c7d84dcea8c6331698c3430484861944c83e629389425664b782d4aecd17c  assets/models/characters/King.gltf
```
