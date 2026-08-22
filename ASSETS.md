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
| `textures[].resolutionPx` | Nominal square resolution. Exactly one set is 2048x2052 upstream - `rough-linen` (all four maps); non-power-of-two height is fine for `RepeatWrapping` in WebGL2. Every other Poly Haven map on disk measures 2048x2048, `limestone-wall-blocks` and `cobblestone-road` included. Verified per file with `sharp().metadata()` across all 72 images: 66 at 2048x2048, 4 at 2048x2052, plus the two ruins maps at 768x768 (`Bark_Texture.jpg`) and 512x512 (`Leaf_Texture.png`). |
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

---

## Historical reference maps — `reference/rome-plans/` (research only, not shipped)

These are **not shipped** and are not loaded at runtime. They live in the gitignored
`reference/` tree and were used only to derive and check the coordinates, dimensions and
long-axis bearings in `src/city/rome.ts`. Nothing in `public/assets/` comes from them and
the built game does not read them. They are recorded here because the coordinates in the
source *are* derived from them, and because the licences differ.

The two Lanciani plate bearings quoted in `rome.ts` (the Circus Maximus at 119° and the
Colosseum's major axis at 68°) were measured off item 5 below by converting the survey's
lat/lon to pixel coordinates against that image's stated bounding box.

**Items 9–11 were added in the Rome fabric pass** (`docs/ROME-FABRIC.md`), from plates the owner
supplied plus their full-resolution originals; **item 12 records the three he supplied that were
rejected, and the reason for each.** One of those three is not a map of Rome at all.

### 1. Plan of Ancient Rome (Clarke, 1830)
- **Creator:** William Barnard Clarke; Society for the Diffusion of Useful Knowledge;
  engraved by J. & C. Walker; published by Baldwin & Cradock. 1830.
- **Asset page:** https://commons.wikimedia.org/wiki/File:1830_Plan_of_Ancient_Rome._By_W.B._Clarke,_Archt.jpg
- **File:** https://upload.wikimedia.org/wikipedia/commons/d/de/1830_Plan_of_Ancient_Rome._By_W.B._Clarke%2C_Archt.jpg
- **Licence (verbatim, `{{PD-Art|PD-old-100-expired}}`):** "This work is in the public
  domain in its country of origin and other countries and areas where the copyright term is
  the author's life plus 100 years or fewer." Also: "This work is in the public domain in
  the United States because it was published … before January 1, 1930."
- 9531 × 7617 JPEG. Not georeferenced. Scan credited raremaps.com.
- Local: `reference/rome-plans/clarke-1830-sduk-plan-of-ancient-rome-9531px.jpg`

### 2–4. Rodolfo Lanciani, *Forma Urbis Romae* — Synopsis 1, Tavola 29, Tavola 35
- **Creator:** Rodolfo Lanciani (1845–1929), Milan 1893–1901, 1:1000.
- **Asset pages:**
  - https://commons.wikimedia.org/wiki/File:Rodolfo_Lanciani_-_Forma_Urbis_Romae_-_Synopsis_1.jpg
  - https://commons.wikimedia.org/wiki/File:Rodolfo_Lanciani_-_Forma_Urbis_Romae_-_Tavola_29.jpg (Forum, Palatine, Colosseum)
  - https://commons.wikimedia.org/wiki/File:Rodolfo_Lanciani_-_Forma_Urbis_Romae_-_Tavola_35.jpg (Circus Maximus)
- **Files:** the `.../thumb/<hash>/<name>/3840px-<name>` renditions of the above.
- **Licence (verbatim, `{{PD-old}}{{PD-ineligible}}`):** "This work is in the public domain
  in its country of origin and other countries and areas where the copyright term is the
  author's life plus 70 years or fewer." / "This file has been identified as being free of
  known restrictions under copyright law, including all related and neighboring rights."
- Note: Commons' Credit field says davidrumsey.com (David Rumsey licenses *his own* scans
  CC BY-NC-SA 3.0) while the licence field is public domain under the PD-Art doctrine, which
  EU DSM Directive Art. 14 codifies. Recorded here because the two statements coexist.
- Local: `lanciani-1901-synopsis1-index-plan-3840.jpg`,
  `lanciani-1901-tavola29-forum-palatine-colosseum-3840.jpg`,
  `lanciani-1901-tavola35-circus-maximus-3840.jpg`

### 5. Lanciani, *Forma Urbis Romae* — georectified WMS render
- **Creator:** Lanciani (source map); georectification by Gruppo di lavoro SITAR,
  Soprintendenza Speciale Archeologia Belle Arti e Paesaggio di Roma (SSABAP-RM).
- **Asset page:** https://www.archeositarproject.it/geoservizi/
- **File:** GeoServer WMS `GetMap` on layer
  `cartografia_storica:Forma Urbis Romae - Lanciani`,
  `srs=EPSG:3004`, `bbox=2307658.1627,4638582.868607,2314671.3719,4643263.3909`,
  `width=4096&height=2734&format=image/png`, host
  `https://repositar.archeositarproject.it/geoserver/wms`
- **Licence (verbatim, SITAR `/open-data/`):** "La Piattaforma Digitale SITAR mette a
  disposizione degli utenti la possibilità di fruire di geoservizi di rete allineati agli
  standard OGC rilasciati con licenza CC-BY-SA 4.0." GetCapabilities declares
  AccessConstraints NONE, Fees NONE.
  **Caveat:** SITAR's `/termini-e-condizioni/` carves *scanned imagery* out of the open
  licence — "Per l'uso delle immagini e di specifici contenuti documentali, l'utente è
  vincolato a quanto previsto dall'etichetta Beni Culturali Standard (BCS)" — so the safe
  reading is: map content public domain by age (author d. 1929), georectification
  CC-BY-SA 4.0 to SSABAP-RM. Not shipped, so neither term is triggered.
- **CRS / extent:** EPSG:3004 (Monte Mario, Italy zone 2, metres); 7013.21 × 4680.52 m at
  1.7122 m/px. WGS84 equivalent bbox
  `12.439575163, 41.870577811, 12.525687221, 41.914545675`.
- Local: `lanciani-georef-EPSG3004-2307658_4638583_2314671_4643263-4096px.png`

### 6. Forma Urbis Severiana — digitised vector (Severan Marble Plan, AD 203–211)
- **Creator:** digitised and georeferenced by Riccardo Montalbano for Gruppo di lavoro
  SITAR, SSABAP-RM (2020-12-19). Source monument AD 203–211.
- **Asset page:** https://www.archeositarproject.it/geoservizi/
- **File:** GeoServer WFS `GetFeature`, `typeNames=sitar:forma_urbis`,
  `outputFormat=application/json`, `srsName=EPSG:4326`, host
  `https://repositar.archeositarproject.it/geoserver/ows`
- **Licence:** contradictory on the two SITAR pages — `/termini-e-condizioni/` states
  "tutti i dati grezzi e i metadati descrittivi pubblicati sul portale WebGIS SITAR sono
  rilasciati sotto i termini della licenza Creative Commons Attribuzione 4.0 Internazionale
  (CC BY 4.0)" while `/open-data/` says CC-BY-SA 4.0. **Treated as CC-BY-SA 4.0**, the
  stricter of the two. Vector geometry is explicitly in the open bucket.
- **Required citation:** "Scheda [OI/PA/UA] cod. [codice identificativo], Anno dell'indagine
  archeologica [20xx], Data di ultima consultazione [20xx], Fonte: ArcheoSITARproject –
  WebGIS SITAR, SSABAP-RM."
- 8,150 MultiPolygon features, EPSG:4326, bbox
  `12.463268, 41.875187, 12.500995, 41.902367`. No monument-name field: properties are
  `admapkey`, `layer` (`001_fum_frammenti` = 280 fragment outlines,
  `002_fum_caratt_interna` = 7,870 interior lines) and a leaked `path`. Coordinates are 3D
  with a constant Z = 0.
- Local: `sitar-forma-urbis-severiana-vector-EPSG4326.geo.json`

### 7. Piano Topografico di Roma e Suburbio 1908–1924 — 1 m contours
- **Creator:** survey by the Istituto Geografico Militare, 1908–1924; layer published by
  ArcheoSITARproject (SSABAP-RM). Scientific supervision Mirella Serlorenzi, Rocco
  Bochicchio; validation Università La Sapienza, Dipartimento di Scienze della Terra.
- **Asset page:** https://www.archeositarproject.it/geoservizi/
- **File:** GeoServer WFS `GetFeature`,
  `typeNames=sitar_potenziale:p_1924_contour_lines_ptrs`, `srsName=EPSG:4326`, bbox
  `2308500,4639000,2312500,4642000,urn:ogc:def:crs:EPSG::3004`
- **Licence and required citation:** as item 6.
- 2,871 MultiLineString features; elevation in the `altitudine` field (integer metres
  a.s.l., 8–88). Used to check the survey's hill elevations: the Aventine reads 45.0 m
  against 46 expected, the Caelian 43.8 against 48, the Janiculum 76.3 against 82 and Tiber
  Island 12.9, wherever the nearest contour is within 60 m; on the flat Campus Martius the
  contours are too sparse to interpolate and everything reads ~10 m.
- Local: `sitar-ptrs-1924-contours-1m-central-rome-EPSG4326.geo.json`

**7b. The same layer, north-east quadrant** — fetched 2026-08-20 for `docs/ROME.md` §3.3,
because item 7's extract stops short of the Pincian, the Quirinal and the Castra Praetoria and
returns nothing usable there.
- Same creator, licence and required citation as item 7.
- **File:** GeoServer WFS `GetFeature`, **`version=1.1.0`**,
  `typeName=sitar_potenziale:p_1924_contour_lines_ptrs`, `outputFormat=application/json`,
  `srsName=EPSG:4326`, **`propertyName=geom,altitudine`**,
  `bbox=2310000,4640500,2314800,4644500,urn:ogc:def:crs:EPSG::3004`, host
  `https://repositar.archeositarproject.it/geoserver/ows`
- **The `propertyName` filter is required.** WFS 2.0.0 with JSON output returns
  `PSQLException: column "data_provider" does not exist` — a server-side schema mismatch on the
  layer. Restricting the requested properties to the geometry and the altitude works.
- 3,053 features, 42,340 vertices, altitudes 8–66 m, bbox `12.45756, 41.87228, 12.53159, 41.93238`.
- **Known limit, and it is why `docs/ROME.md` §3.3 carries a warning before its results.** The
  1924 survey drew contours where there is relief and **nothing at all on the flat**. On the
  Campus Martius the nearest contour to any sample is 100–600 m away, so a naive
  two-nearest interpolation returns a number that means nothing — it returned "10.5 m" for the
  Pincian summit and "47.5 m" for the Porta Nomentana on a first pass. Any sample whose nearest
  contour is more than ~35 m away is not a measurement.
- Sampled by `tools/scratch/rome-contour.mjs`, `rome-wallprofile.mjs` and `rome-transect.mjs`.
- Local: `sitar-ptrs-1924-contours-ne-quadrant-EPSG4326.geo.json` (1.6 MB)

### Referenced but deliberately NOT used
- **Stanford Digital Forma Urbis Romae** (formaurbis.stanford.edu) — its meshes and photos
  are fetchable without authentication, but `docs/FURcopyright.html` states they "may not be
  copied, downloaded and stored, forwarded, reproduced or published in any form … without
  express written permission". **All rights reserved. Not downloaded.**
- **Digital Augustan Rome** (digitalaugustanrome.org) — has an undocumented JSON API with
  352 full-precision WGS84 records and a georeferenced tile pyramid, and is the best fitting
  dataset found, but carries **no licence statement anywhere**; only an attribution request,
  and the paper maps are sold. Treated as all rights reserved. Not downloaded, not used.
- **mappingrome.com** — all rights reserved.
- **Pleiades** (CC-BY 3.0) and **OpenHistoricalMap** (CC0) were consulted only as a
  cross-check on individual point coordinates — e.g. Pleiades place 285857974 gives the
  Amphitheatrum Flavium at 12.49234831, 41.89025089, which agrees with the 12.4922, 41.8902
  used in `rome.ts` to within 12 m. **No OHM or Pleiades data ships**, and none of it is
  loaded at runtime; if any ever does, note that OHM is CC0 but many Pleiades intra-urban
  geometries are traced from OSM and therefore ODbL-derived upstream despite the CC-BY label.
- **DARE** is CC BY-**SA** 3.0 (not CC-BY) and has no intra-urban Rome content.
  **AWMC** is ODbL for GIS and CC BY-NC 4.0 for finished maps, and has no Rome city plan.

### 8. AGEA 2012 colour orthophoto of central Rome — the modern aerial reference
- **Creator:** Agenzia per le Erogazioni in Agricoltura (AGEA), flown 2012; published by the
  Geoportale Nazionale, Ministero dell'Ambiente e della Sicurezza Energetica (MASE).
- **Asset page / service:** <https://gn.mase.gov.it/> — WMS
  `http://wms.pcn.minambiente.it/ogc?map=/ms_ogc/WMS_v1.3/raster/ortofoto_colore_12.map`
- **Licence (verbatim, `https://gn.mase.gov.it/portale/note-legali`):** "I dati scaricabili
  tramite il servizio di Download del Geoportale sono messi a disposizione con licenza
  **CC BY 4.0**". The `GetCapabilities` of this service additionally declares
  `<Fees>Nessuna condizione applicata</Fees>` and `<AccessConstraints>Nessuno</AccessConstraints>`.
  Attribution: *AGEA / Geoportale Nazionale — MASE, CC BY 4.0*.
- **File:** WMS 1.1.1 `GetMap`, `layers=OI.ORTOIMMAGINI.2012.33`, `srs=EPSG:3004`,
  `format=image/jpeg`. The service caps `WIDTH`/`HEIGHT` at 2048, so it was fetched as four
  2048 × 1367 tiles on the bbox quadrants and mosaicked.
- **CRS / extent:** EPSG:3004, bbox
  `2307658.1627,4638582.868607,2314671.3719,4643263.3909` — **byte-for-byte the same bbox,
  size and CRS as item 5**, so the modern orthophoto and the Lanciani plan are
  pixel-registered to each other and share one georeference. 4096 × 2734 at 1.7122 m/px
  (50 cm native, downsampled).
- **What it is for.** The user asked for "aerial photos of rome versus aerial photos of the
  layout". This is the aerial photograph half. It also independently validates the survey in
  `src/city/rome.ts`, because a 50 cm orthophoto shows the Colosseum and the Circus Maximus
  unambiguously: measured off it, the Colosseum's centre agrees with `rome.ts` to ~25 m and
  its arena axis to ~9°, and the Circus Maximus's centre to 27 m with a long axis of
  **118.8°** against the 120° in the survey.
- Local: `agea-2012-ortofoto-EPSG3004-2307658_4638583_2314671_4643263-4096px.jpg`

### 9. Shepherd, *Historical Atlas* — "Plan of Imperial Rome", 1:25 000, c. AD 350

The plate the owner supplied for the Rome fabric pass (`docs/ROME-FABRIC.md` §4). **The single
most complete named index of the Aurelian circuit in the whole reference pool**: every gate
named, all fourteen Augustan regions numbered, the consular roads outside the wall and the
named internal streets inside it (Alta Semita, Vicus Longus, Vicus Patricius, Subura, Clivus
Suburanus, Broad Way = Via Lata), the aqueducts, and every major monument picked out in yellow
at its own plan shape — **superimposed on the modern street grid**, which is what makes it
georeferenceable against items 5 and 8.

- **Creator:** William Robert Shepherd (1871–1934), *Historical Atlas*, New York: Henry Holt
  and Company, 1911; the UT Austin copy is the 1923/1926 edition, pages 22–23, "Plans of Rome
  and Athens".
- **Asset pages:**
  - <https://commons.wikimedia.org/wiki/File:Shepherd-c-022-023.jpg> — the whole plate, and
    the file page that carries the formal licence tag.
  - <https://maps.lib.utexas.edu/maps/historical/history_shepherd_1923.html> — the
    Perry-Castañeda Library Map Collection index entry, `rome_athens_imperial_plans.jpg`.
- **Licence (verbatim, Commons `{{PD-old-auto-expired}}` + `{{PD-mark}}`):** "This work is in
  the public domain in its country of origin and other countries and areas where the copyright
  term is the author's life plus 70 years or fewer." / "This file has been identified as being
  free of known restrictions under copyright law, including all related and neighboring
  rights." Author died 1934; first US publication 1911, i.e. before 1 January 1930.
- **Licence (verbatim, UT Austin, `https://maps.lib.utexas.edu/maps/faq.html`):** "Most of the
  maps scanned by the University of Texas Libraries and served from this web site are in the
  public domain… **No permissions are needed to copy them. You may download them and use them
  as you wish.** … We appreciate credit to 'University of Texas Libraries' as the source of the
  scanned images." *Attribution preserved here as required.*
- **Two files, and why both.**
  - `shepherd-1923-plan-of-imperial-rome-350ad-2826px.jpg` — **2826 × 2158**, the Rome half
    only, at more than twice the linear resolution of the Commons plate. This is the file the
    owner supplied. Immediate source: `http://www.emersonkent.com/images/rome_350_ad.jpg`,
    whose own page credits "University of Texas at Austin. Historical Atlas by William
    Shepherd (1923-26)"; EXIF records an HP ScanJet 4600 scan dated 2010-08-19. The scan is a
    **slavish reproduction of a two-dimensional public-domain work** and therefore carries no
    new copyright in the US — the same PD-Art reasoning already recorded for the Lanciani
    plates at items 2–4 above. 2 319 542 bytes, SHA-256 `c1a8262b81afd595…`.
  - `shepherd-1911-plate22-rome-and-athens-full-1550px.jpg` — **1550 × 1932**, the complete
    plate from Commons: Imperial Rome, **Plan of Republican Rome** (the Servian circuit and its
    four regions, which the crop above only carries as a small inset), Athens, and the
    Acropolis. Lower resolution; kept as the licence anchor and for the Republican plan.
    1 089 546 bytes, SHA-256 `a8701d162494162d…`.
- **Measured scale.** The plate declares 1:25 000 and carries two independent bars. Measured on
  the 2826 px file: the yards bar spans 800 yd (731.5 m) in 348.3 px and the stadia bar spans
  4 stadia (740 m, at 1 stadium = 625 Roman feet = 185.0 m) in 353.3 px — **2.100 and 2.094 m
  per pixel, agreeing to 0.3 %.** So the file covers about 5 935 × 4 532 m of ground and
  resolves a 43 m rotunda as 20 px. **Use it for completeness and for names, not for
  dimensions**: item 5 (Lanciani georectified, 1.71 m/px, worst residual 1.26 m over 7 km) is
  four times more accurate and is the raster `src/city/overlay.ts` is already fitted to.

### 10. Kiepert / *Encyclopædia Britannica* 11th ed. — "Plan of Ancient Rome", 1911

The second plate the owner supplied, replaced here with the full-resolution Commons original
(his copy was a 960 px thumbnail). Its value over item 9 is that it is a **metric** plate — it
carries a bar in metres *and* one in *pedes Romani antiqui* — and that it distinguishes
Republican from Imperial fabric in colour, which is the §6.3 "state in 271" filter. It is also
by the same hand and from the same volume as `reference/rome-aurelian/middleton-1911-eb11-aurelian-wall-tower-plan.jpg`,
so the two register against each other.

- **Creator:** based on Heinrich Kiepert, *Formae Orbis Antiqui* (c. 1894), by permission of
  Dietrich Reimer, Berlin; engraved by Emery Walker. *Encyclopædia Britannica*, 11th edition,
  vol. 23 (1911), article "Rome" (J. H. Middleton), fig. 7, facing p. 586.
- **Asset page:** <https://commons.wikimedia.org/wiki/File:EB1911_Rome_-_ancient_map.jpg>
- **File:** <https://upload.wikimedia.org/wikipedia/commons/d/db/EB1911_Rome_-_ancient_map.jpg>
- **Licence (verbatim, `{{PD-Britannica}}`):** "This image comes from the 13th edition of the
  Encyclopædia Britannica or earlier. The copyrights for that book have expired in the United
  States because the book was first published in the US with the publication occurring before
  January 1, 1931. As such, this image is in the public domain in the United States."
- 2430 × 1799 JPEG, 2 209 556 bytes, SHA-256 `dfd1780fcc552ab2…`. Not georeferenced.
- Local: `kiepert-eb1911-plan-of-ancient-rome-2430px.jpg`

### 11. ColdEel / Joris1919 — the fourteen regions, the roads and the river as a clean diagram

The third plate the owner supplied, replaced here with the Commons original PNG (his copy was a
rescaled WebP). Dutch labels. It is not a survey and must not be measured for footprints; what
it gives, and gives better than anything else in the pool, is **the road armature as a graph**:
which consular road enters which gate, which internal street links which two regions, and where
the fourteen regional boundaries run — with a 0–1 km bar to keep it honest. Used in
`docs/ROME-FABRIC.md` §5 to rank the roads.

- **Creator:** fr:User:ColdEel (original, French Wikipedia); edited by nl:Gebruiker:Joris1919.
  2006/2007. *The same Joris1919 whose photographs of the Muro Torto, Porta Pinciana and the
  Castra Praetoria are already in `reference/rome-aurelian/`.*
- **Asset page:** <https://commons.wikimedia.org/wiki/File:Plan_Rome-_Regiones.png>
- **File:** <https://upload.wikimedia.org/wikipedia/commons/a/a2/Plan_Rome-_Regiones.png>
- **Licence (verbatim, `{{PD-self}}` by the author):** "This work has been released into the
  public domain by its author, ColdEel. This applies worldwide."
- 1128 × 900 PNG, 204 554 bytes, SHA-256 `afa20c15fdd29b10…`.
- Local: `coldeel-2006-rome-14-regions-and-roads-1128px.png`

### 12. Three files the owner supplied that were NOT taken, and why

Recorded so that nobody spends a second pass on them.

| supplied as | what it actually is | verdict |
| --- | --- | --- |
| `rome city map 200 ad.jpg`, 1600 × 906 | **Not Rome. It is Roman *London*** — the Thames, Southwark, Ludgate, Newgate, Bishopsgate, Aldgate, Cripplegate fort, the Walbrook, the Temple of Mithras. It also carries "**© 1999 Encyclopædia Britannica, Inc.**" burnt into the plate. | **Rejected twice over**, on subject and on licence. Not committed, not usable, not to be re-fetched. |
| `rome city map.webp`, 2453 × 3347 | A colour German atlas plate, "**Die Stadt Rom / Rom zur Kaiserzeit**", 1:30 000, sheet 33, with insets of the Forum Romanum (1:4 000) and the Kaiserfora (1:8 000). Almost certainly from an edition of **F. W. Putzgers *Historischer Schul-Atlas*** (Velhagen & Klasing) — Commons' full-text index confirms Putzger carries a plate of that title — but **the edition, and therefore the date, could not be established**, and Putzger ran from 1877 into the present. Its legend is the most useful thing in the whole set: it colour-codes fabric as Republican / Augustan / AD 14–250 / late antique, and it shades "*vermutlich bewohntes oder besiedeltes Stadtgebiet*" — probably-inhabited city area, which is exactly the layer the fabric pass needs. | **Not committed.** Licence not established, so the asset rule forbids it. **Cited as an external reference only.** To land it: find the plate on Commons or the Internet Archive with an edition date, confirm pre-1930 publication or author-life+70, and fetch *that* copy through the usual check. Worth someone's half hour. |
| `rome city map 3.jpg`, 500 × 432 | An untitled crop of a modern illustrated map — ancient monuments in orange over a present-day street plan. No title, no scale bar, no legend, no attribution, no creator, and too small to measure anything from. | **Not committed.** Unidentifiable provenance and no research value at 500 px. |

### How the georeference is used in-engine

`src/city/overlay.ts` carries a plain 6-parameter affine from raster pixels to the survey
frame of `rome.ts` (metres east/north of the Temple of Jupiter OM):

```
e = 1.70846149·px + 0.05015993·py − 3538.9517
n = 0.05027504·px − 1.71190121·py + 2244.5710
```

fitted against a full inverse of EPSG:3004 (Transverse Mercator on the Hayford 1909
ellipsoid, k₀ = 0.9996, λ₀ = 15° E, false easting 2 520 000 m, plus the EPSG:1659 Monte
Mario → WGS84 Helmert) over a 13 × 13 grid spanning the whole plate. **Worst residual
1.26 m over 7 km.** The 0.0294 shear is the grid convergence of EPSG:3004 at Rome's
longitude — 1.68° west of grid north — so neither raster is north-up in the survey frame and
neither may be treated as an axis-aligned rectangle.

Both rasters are **local reference only**: `reference/` is gitignored, `overlay.ts` is
imported solely by `preview.ts` and the plan-view harness (neither is a Vite build entry —
the only input is `index.html`), and `CitySystem.setReferenceOverlay` refuses outside
`import.meta.env.DEV`. A clean checkout has neither the code path nor the file, and the
overlay's loader treats a missing raster as a no-op.

### Free 3D models of Rome — checked again, still nothing usable
- **Rome Reborn** (romereborn.org) — could not be reached from this environment on this
  pass, so its terms were **not** re-verified. It is sold through Flyover Zone as commercial
  VR titles and its licensing page has historically been all-rights-reserved; treated as
  unusable until someone reads the page directly.
- **Stanford Digital Forma Urbis Romae**, **Digital Augustan Rome**, **mappingrome.com** —
  unchanged from the section above: all rights reserved or no licence at all. Not used.
- Nothing on Sketchfab under CC0/CC-BY is a *georeferenced model of the city*; the CC0
  Roman assets there are individual props and monuments, which would not answer the
  question this task is about (where the Colosseum is), and were not downloaded.


## Museum and site photography — `reference/museum/` (factual accuracy only, not shipped, not deck-eligible)

Added during a blind-comparison critic pass. Purpose: a **factual** reference for Roman
military kit, wall construction, street paving and insula massing, so that "our brick
courses are wrong" can be settled against a photograph rather than an opinion.

**Deck eligibility: none.** These are photographs of real objects, not renders. Putting a
photograph into a blind render-vs-render deck measures nothing — a grader separates
photography from rendering on sensor noise and depth of field alone, and would score 100%
without ever looking at a shadow. They are eligible for the *accuracy* pass only. The
single-source rule for blind decks is unaffected: `reference/rome2/` remains the only
battle-plate pool, and nothing here may be mixed into it.

**How the licence was verified.** Every file was taken through the Wikimedia Commons
`action=query&prop=imageinfo&iiprop=extmetadata` API, which returns the licence recorded on
that individual file's own description page. Only files reporting Public domain, CC0, CC BY
or CC BY-SA — all commercial-use-permitted — were accepted; everything else was dropped
before any byte was fetched. The attribution below is the `Artist` field from the same
per-file record, which is what CC BY / CC BY-SA require be preserved.

**Download discipline.** Bytes came only from `upload.wikimedia.org`, which is Commons' own
CDN — no mirrors, no re-upload sites, no shorteners. `redirect: 'manual'` was set and any
URL that redirected was skipped rather than followed. Only `image/jpeg` and `image/png`
Content-Types were accepted. No archives were downloaded, so nothing was extracted; no
installer, executable or script was fetched or run; no credentials were entered anywhere.

**Safety verification.** Each of the 41 files: magic bytes checked against JPEG/PNG headers;
whole-file scan for MZ/PE, ELF, Mach-O, ZIP, shebang, PHP and `<script` signatures;
executable bit checked; trailing-data-past-EOI check for JPEG polyglots; and a full decode
through libvips to confirm it is an image and nothing else. Three files matched the three
bytes `#!/` at multi-megabyte offsets inside JPEG entropy-coded data — a chance hit, not a
shebang, which is only meaningful at offset 0 — and each decodes cleanly with no trailing
payload. One candidate was **rejected** by the signature scan and not kept. Stated plainly
rather than dressed up: no on-demand AV scanner (clamscan) exists in this environment, and
macOS `xprotect` here only reports its definition version (5353) with no scan subcommand, so
the above is signature-and-structure checking, not a virus scan.

**Not committed.** `reference/` is gitignored in full. Nothing here is redistributed,
shipped, or referenced by any build entry point, and `reference/.metadata_never_index`
keeps Spotlight out of it.

#### `wall-aurelian/` — Aurelian Wall and Roman city walls (8 files)

| File | Creator | Licence | Source page |
| --- | --- | --- | --- |
| `Aurelian-Wall-1.JPG` | Joris assumed (based on copyright claims). | CC BY-SA 3.0 | <https://commons.wikimedia.org/wiki/File:Aurelian_Wall_1.JPG> |
| `Aurelian-Wall-tower.JPG` | Joris assumed (based on copyright claims). | CC BY-SA 3.0 | <https://commons.wikimedia.org/wiki/File:Aurelian_Wall_tower.JPG> |
| `Le-mura-a-porta-san-Giovanni-2793.JPG` | user:Lalupa | Public domain | <https://commons.wikimedia.org/wiki/File:Le_mura_a_porta_san_Giovanni_2793.JPG> |
| `Ludovisi---mura-e-latrina-1870.JPG` | user:Lalupa | Public domain | <https://commons.wikimedia.org/wiki/File:Ludovisi_-_mura_e_latrina_1870.JPG> |
| `Mura-a-via-della-Ferratella-2193st.JPG` | user:Lalupa | Public domain | <https://commons.wikimedia.org/wiki/File:Mura_a_via_della_Ferratella_2193st.JPG> |
| `2012-07-04-Roma-Corso-d-Italia.jpg` | Blackcat | CC BY-SA 3.0 it | <https://commons.wikimedia.org/wiki/File:2012-07-04_Roma_Corso_d%27Italia.jpg> |
| `2012-08-23-Roma-Piazza-della-Croce-Rossa.jpg` | Blackcat | CC BY-SA 3.0 | <https://commons.wikimedia.org/wiki/File:2012-08-23_Roma_Piazza_della_Croce_Rossa.jpg> |
| `Mura-di-Roma-quartiere-San-Lorenzo.jpg` | User:Walterdolce | CC BY-SA 1.0 | <https://commons.wikimedia.org/wiki/File:Mura_di_Roma,_quartiere_San_Lorenzo.jpg> |

#### `brickwork/` — Roman wall construction — opus reticulatum, opus latericium (6 files)

| File | Creator | Licence | Source page |
| --- | --- | --- | --- |
| `Domus-rovine-5.JPG` | Zanner | Public domain | <https://commons.wikimedia.org/wiki/File:Domus_rovine_5.JPG> |
| `Domus-rovine-6.JPG` | Zanner | Public domain | <https://commons.wikimedia.org/wiki/File:Domus_rovine_6.JPG> |
| `Albano-Laziale---villa-Gneo-Pompeo-Magno.JPG` | Deblu68 | Public domain | <https://commons.wikimedia.org/wiki/File:Albano_Laziale_-_villa_Gneo_Pompeo_Magno.JPG> |
| `Anfiteatro-di-arezzo-opus-reticulatum-02.JPG` | Sailko | CC BY-SA 3.0 | <https://commons.wikimedia.org/wiki/File:Anfiteatro_di_arezzo,_opus_reticulatum_02.JPG> |
| `Anfiteatro-di-arezzo-opus-reticulatum-01.JPG` | Sailko | CC BY-SA 3.0 | <https://commons.wikimedia.org/wiki/File:Anfiteatro_di_arezzo,_opus_reticulatum_01.JPG> |
| `Antiche-Ville-Romane-Agnuli-Mattinata-01.jpg` | Alessandro Fazzini | CC BY-SA 4.0 | <https://commons.wikimedia.org/wiki/File:Antiche_Ville_Romane_Agnuli_Mattinata_01.jpg> |

#### `street/` — Roman road and street paving (6 files)

| File | Creator | Licence | Source page |
| --- | --- | --- | --- |
| `Forum-Aemilianum-stretch-of-the-Via-Appia-Tarracina-Anxur-Terracina-It` | Carole Raddato from FRANKFURT, Germany | CC BY-SA 2.0 | <https://commons.wikimedia.org/wiki/File:Forum_Aemilianum,_stretch_of_the_Via_Appia,_Tarracina_(Anxur),_Terracina,_Italy_(15224581792).jpg> |
| `Remaining-side-of-the-quadrifrons-four-sided-arch-under-which-lay-a-we` | Carole Raddato from FRANKFURT, Germany | CC BY-SA 2.0 | <https://commons.wikimedia.org/wiki/File:Remaining_side_of_the_quadrifrons_(four-sided)_arch_under_which_lay_a_well-preserved_stretch_of_the_ancient_Via_Appia,_Tarracina_(Anxur),_Terracina,_Italy_(15221851581).jpg> |
| `Forum-Aemilianum-stretch-of-the-Via-Appia-Tarracina-Anxur-Terracina-It` | Carole Raddato from FRANKFURT, Germany | CC BY-SA 2.0 | <https://commons.wikimedia.org/wiki/File:Forum_Aemilianum,_stretch_of_the_Via_Appia,_Tarracina_(Anxur),_Terracina,_Italy_(15038262980).jpg> |
| `Katakomben---panoramio-4-.jpg` | Michael aus Halle | CC BY-SA 3.0 | <https://commons.wikimedia.org/wiki/File:Katakomben_-_panoramio_(4).jpg> |
| `Milestones-recording-Hadrian-s-restoration-of-the-Via-Appia-in-AD-123-` | Carole Raddato | CC BY-SA 2.0 | <https://commons.wikimedia.org/wiki/File:Milestones_recording_Hadrian%27s_restoration_of_the_Via_Appia_in_AD_123,_Benevento,_Italy.jpg> |
| `Santuario-di-Monte-Sant-Angelo.-Le-Mura---Resti-torri-quadrangolari-de` | Xavier121 | CC BY-SA 3.0 | <https://commons.wikimedia.org/wiki/File:Santuario_di_Monte_Sant%27Angelo._Le_Mura_-_Resti_torri_quadrangolari_della_porta_attraversata_dall%27appia.JPG> |

#### `insula/` — Insulae — Ostia Antica apartment blocks (6 files)

| File | Creator | Licence | Source page |
| --- | --- | --- | --- |
| `Insula-in-Ostia.jpg` | Dennis G. Jarvis | CC BY-SA 2.0 | <https://commons.wikimedia.org/wiki/File:Insula_in_Ostia.jpg> |
| `La-maison-de-Diane-Ostia-Antica-5900777253-.jpg` | Jean-Pierre Dalbéra from Paris, France | CC BY 2.0 | <https://commons.wikimedia.org/wiki/File:La_maison_de_Diane_(Ostia_Antica)_(5900777253).jpg> |
| `La-maison-de-Diane-Ostia-Antica-5901008906-.jpg` | Jean-Pierre Dalbéra from Paris, France | CC BY 2.0 | <https://commons.wikimedia.org/wiki/File:La_maison_de_Diane_(Ostia_Antica)_(5901008906).jpg> |
| `099-Ostia-antica.JPG` | Robert Schediwy | CC BY-SA 4.0 | <https://commons.wikimedia.org/wiki/File:099_Ostia_antica.JPG> |
| `Italy-0322-5153505665-.jpg` | Dennis G. Jarvis | CC BY-SA 2.0 | <https://commons.wikimedia.org/wiki/File:Italy-0322_(5153505665).jpg> |
| `DSCN2221-5321766054-.jpg` | Manuel Ramírez Sánchez from Las Palmas de Gran Canaria, Espa | CC BY-SA 2.0 | <https://commons.wikimedia.org/wiki/File:DSCN2221_(5321766054).jpg> |

#### `kit-armour/` — Roman armour, helmets and military dress (10 files)

| File | Creator | Licence | Source page |
| --- | --- | --- | --- |
| `007-Conrad-Cichorius-Die-Reliefs-der-Traianss-ule-Tafel-VII-Ausschnitt` | Attributed to Apollodorus of Damascus / Conrad Cichorius | Public domain | <https://commons.wikimedia.org/wiki/File:007_Conrad_Cichorius,_Die_Reliefs_der_Traianss%C3%A4ule,_Tafel_VII_(Ausschnitt_01).jpg> |
| `046-Conrad-Cichorius-Die-Reliefs-der-Traianss-ule-Tafel-XLVI-Ausschnit` | Attributed to Apollodorus of Damascus / Conrad Cichorius | Public domain | <https://commons.wikimedia.org/wiki/File:046_Conrad_Cichorius,_Die_Reliefs_der_Traianss%C3%A4ule,_Tafel_XLVI_(Ausschnitt_01).jpg> |
| `Column-of-Marcus-Aurelius---detail3.jpg` | Barosaurus Lentus | CC BY 3.0 | <https://commons.wikimedia.org/wiki/File:Column_of_Marcus_Aurelius_-_detail3.jpg> |
| `Legio-XXI-Rapax---Sechsel-uten-2011---Lindenhof-2011-04-10-15-58-54.JP` | Roland zh | CC BY-SA 3.0 | <https://commons.wikimedia.org/wiki/File:Legio_XXI_Rapax_-_Sechsel%C3%A4uten_2011_-_Lindenhof_2011-04-10_15-58-54.JPG> |
| `Legio-XXI-Rapax---Sechsel-utenumzug---Sch-tzengasse-Bahnhostrasse-2011` | Roland zh | CC BY-SA 3.0 | <https://commons.wikimedia.org/wiki/File:Legio_XXI_Rapax_-_Sechsel%C3%A4utenumzug_-_Sch%C3%BCtzengasse-Bahnhostrasse_2011-04-11_14-56-50.JPG> |
| `KMM---Lorica-segmentata.jpg` | Wolfgang Sauber | CC BY-SA 3.0 | <https://commons.wikimedia.org/wiki/File:KMM_-_Lorica_segmentata.jpg> |
| `A-possible-incomplete-Roman-strap-fitting-for-plate-armour-lorica-segm` | Museum of London, Ben Paites, 2014-11-19 16:31:54 | CC BY-SA 4.0 | <https://commons.wikimedia.org/wiki/File:A_possible_incomplete_Roman_strap_fitting_for_plate_armour_(lorica_segmentata),_dating_to_the_1st_century_AD._(FindID_650176).jpg> |
| `LegionariaAquilifer-2-.JPG` | Notafly | CC BY-SA 3.0 | <https://commons.wikimedia.org/wiki/File:LegionariaAquilifer_(2).JPG> |
| `Lorica-corbridgeA.jpg` | Suetonius | CC BY-SA 3.0 | <https://commons.wikimedia.org/wiki/File:Lorica_corbridgeA.jpg> |
| `Lorica-corbridgeB.jpg` | Suetonius | CC BY-SA 3.0 | <https://commons.wikimedia.org/wiki/File:Lorica_corbridgeB.jpg> |

#### `kit-shield/` — Roman shields and military reliefs (6 files)

| File | Creator | Licence | Source page |
| --- | --- | --- | --- |
| `AdamclisiMetope32.jpg` | CristianChirita | CC BY-SA 3.0 | <https://commons.wikimedia.org/wiki/File:AdamclisiMetope32.jpg> |
| `AdamclisiMetope36.jpg` | CristianChirita | CC BY-SA 3.0 | <https://commons.wikimedia.org/wiki/File:AdamclisiMetope36.jpg> |
| `AdamclisiMetope37.jpg` | CristianChirita | CC BY-SA 3.0 | <https://commons.wikimedia.org/wiki/File:AdamclisiMetope37.jpg> |
| `051-Conrad-Cichorius-Die-Reliefs-der-Traianss-ule-Tafel-LI-Ausschnitt-` | Attributed to Apollodorus of Damascus / Conrad Cichorius | Public domain | <https://commons.wikimedia.org/wiki/File:051_Conrad_Cichorius,_Die_Reliefs_der_Traianss%C3%A4ule,_Tafel_LI_(Ausschnitt_01).jpg> |
| `Boucliers-escudos---larousse-.jpg` | S. Sibonis de L. | Public domain | <https://commons.wikimedia.org/wiki/File:Boucliers_(escudos_-_larousse).jpg> |
| `Altar-Domitius-Ahenobarbus-Louvre-n3bis.jpg` | Unknown artist Unknown artist | Public domain | <https://commons.wikimedia.org/wiki/File:Altar_Domitius_Ahenobarbus_Louvre_n3bis.jpg> |

---

## Punic Carthage reference — `reference/carthage/` (layout and accuracy only, not shipped, not deck-eligible)

Gathered for `docs/CARTHAGE.md`, the specification for the second besiegeable city. Purpose:
settle the plan of Punic Carthage — the Byrsa's excavated housing grid, the two harbour
lagoons, the relief of the hill and the coast — against a measured drawing or a photograph
rather than against an opinion.

**Deck eligibility: none, and this pool is the reason the rule exists.** `reference/rome2/`
remains the *sole* blind render-quality pool. Everything here is a photograph of a real place
or a published excavation plan; a grader separates photography from rendering on sensor noise
alone and would score 100% without looking at a shadow. Mixing provenance has been got wrong
twice on this project. These are eligible for the **accuracy and layout** pass only.

**How the licence was verified.** Every candidate was taken through the Wikimedia Commons
`action=query&prop=imageinfo&iiprop=extmetadata` API, which returns the licence recorded on
that individual file's own description page, **before** any byte was fetched. Only files
reporting CC0, Public domain, "Copyrighted free use", CC BY or CC BY-SA — all
commercial-use-permitted — were accepted, and every one returned an empty `Restrictions`
field. The `Artist` column below is the `Artist` field from the same per-file record, which
is what CC BY / CC BY-SA require be preserved.

**What was actually done to check the files, stated honestly.** There is no on-demand AV
scanner in this environment, so this is signature-and-structure checking, not scanning. Each
download was fetched directly from `upload.wikimedia.org` (Wikimedia's own media host, no
mirror, no redirect, no shortener), held in memory, and only written to disk after its **leading
magic bytes** matched the declared type (`89 50 4E 47 0D 0A 1A 0A` for PNG, `FF D8 FF` for
JPEG) **and** its trailing bytes matched a complete container (`IEND®B\`‚` for PNG, `FF D9` for
JPEG). Anything failing either test was to be discarded unwritten; nothing failed. No archives
were involved, so nothing was extracted; no executable, installer or script was downloaded or
run. The three source files are SVG on Commons and SVG is not on the permitted-format list, so
they were taken as **PNG renderings from Wikimedia's own thumbnail service** rather than as
SVG. 15 files, 9.9 MB total. `reference/` is gitignored and carries `.metadata_never_index`.

| File | What it is for | Creator | Licence | Source page | SHA-256 (first 16) |
| --- | --- | --- | --- | --- | --- |
| `plan-byrsa-hannibal-quarter.png` | Lancel excavation plan of the Hannibalic quarter — insula module in Punic cubits, house plots, Rues I–III | Equipe française (via Commons) | Copyrighted free use | <https://commons.wikimedia.org/wiki/File:Plan_quartier_Hannibal_Byrsa_fouilles_fran%C3%A7aises.svg> | `ccb085b792a9b030` |
| `plan-byrsa-house.png` | Measured plan of one Byrsa house — courtyard, side corridor, cistern (after Lancel, *Carthage*) | Habib M'henni | CC BY-SA 3.0 | <https://commons.wikimedia.org/wiki/File:Plan_fouilles_arch_maison_Byrsa.svg> | `b352fa9c09d76f34` |
| `plan-byrsa-hill-section.png` | Section through the Byrsa: Punic levels under the Roman forum platform, and the truncated summit | Habib M'henni | CC0 | <https://commons.wikimedia.org/wiki/File:Plan_fouilles_colline_Byrsa.svg> | `ee06dae8d1ea0c87` |
| `ports-punic-oblique.jpg` | The two Punic harbour lagoons seen from the Byrsa | Citizen59 | CC BY-SA 3.0 | <https://commons.wikimedia.org/wiki/File:PortsPuniquesCarthage.JPG> | `8bb303628b8dd98e` |
| `aerial-salammbo-ports.jpg` | Oblique aerial: both harbours, the admiralty island, the shore and the sand spit | T A | CC BY-SA 2.0 | <https://commons.wikimedia.org/wiki/File:Vue_a%C3%A9rienne_de_Salambo_et_Carthage.jpg> | `89550c3ee5b5ca82` |
| `ports-cothon-ground-1.jpg` | Circular harbour at ground level — basin, island, bank profile | Sharon Hahn Darlin | CC BY 2.0 | <https://commons.wikimedia.org/wiki/File:Punic_Ports_(Ports_Puniques)_of_Carthage,_Tunisia_January_2024_-_1.jpg> | `53685e36f25a360e` |
| `ports-cothon-ground-3.jpg` | Circular harbour at ground level, second angle | Sharon Hahn Darlin | CC BY 2.0 | <https://commons.wikimedia.org/wiki/File:Punic_Ports_(Ports_Puniques)_of_Carthage,_Tunisia_January_2024_-_3.jpg> | `adfbe1a565c6007f` |
| `byrsa-hill.jpg` | The Byrsa from below — the relief the three streets have to climb | Shoestring | CC BY-SA 4.0 | <https://commons.wikimedia.org/wiki/File:Byrsa_hill_in_Carthage.jpg> | `b97c2877c182bf27` |
| `byrsa-site-dalbera.jpg` | Byrsa archaeological site, the Punic quarter in situ | Jean-Pierre Dalbéra | CC BY 2.0 | <https://commons.wikimedia.org/wiki/File:Le_site_arch%C3%A9ologique_de_Byrsa_(Carthage,_Tunisie)_(49787855963).jpg> | `e5fd6185b1c32152` |
| `byrsa-hill-cridland.jpg` | Byrsa hilltop and the excavated quarter | Verity Cridland | CC BY 2.0 | <https://commons.wikimedia.org/wiki/File:Carthage,_Byrsa_hill_(13585102703).jpg> | `9cba03b730af8334` |
| `punic-ruins-masonry.jpg` | Punic wall fabric — ashlar piers with rubble panels (*opus africanum*) | upyernoz | CC BY 2.0 | <https://commons.wikimedia.org/wiki/File:Punic_Ruins,_Carthage.jpg> | `c4a126eb27d85c0e` |
| `aerial-carthage.jpg` | Aerial of the Carthage peninsula — coast, relief and the lie of the land | Aziz0161 | CC BY-SA 4.0 | <https://commons.wikimedia.org/wiki/File:Carthage_aerial_view.jpg> | `4cfea96f9ad9a673` |
| `aerial-carthage-2013.jpg` | Aerial of Carthage, wider frame | Citizen59 | CC BY 3.0 | <https://commons.wikimedia.org/wiki/File:VueDuCielCarthageNov2013.jpg> | `e98331e2752b854d` |
| `tophet.jpg` | The Tophet of Salammbô, immediately west of the harbours | IssamBarhoumi | CC BY-SA 4.0 | <https://commons.wikimedia.org/wiki/File:Tophet_de_Carthage.jpg> | `ec8077f2c996f95b` |
| `byrsa-roman-foundations.jpg` | Roman forum foundation piles punched through the Punic quarter | damian entwistle | CC BY-SA 2.0 | <https://commons.wikimedia.org/wiki/File:Byrsa_roman_foundations.jpg> | `b381d860abad7971` |

**Attribution, as the licences require.** Habib M'henni (2 plans, one CC0 and one CC BY-SA 3.0,
both drawn after Serge Lancel, *Carthage*); the French excavation team, via Commons, for the
Hannibalic quarter plan; Citizen59 (2); Sharon Hahn Darlin (2); Jean-Pierre Dalbéra; Verity
Cridland; upyernoz; T A; Shoestring; Aziz0161; IssamBarhoumi; damian entwistle.

**Skipped, and why.** Gsell's *Histoire ancienne de l'Afrique du Nord* II (1918) and several
other public-domain topographies of Carthage are on Commons as **PDF**, which is not on the
permitted-format list; they are cited in `docs/CARTHAGE.md` as reading, not fetched. No
reconstruction render, artist's impression or game screenshot of Carthage was fetched from any
source, and none may be: the reconstruction imagery that dominates a search for this city is
overwhelmingly either unlicensed, of unknown provenance, or extracted from a commercial game.

---

## Aurelian Rome reference — `reference/rome-aurelian/` (layout and accuracy only, not shipped, not deck-eligible)

Gathered for the map design of the **Aurelian Wall and the Campus Martius, Rome, AD 271**.
Purpose: settle the standing fabric of Aurelian's circuit — the brick curtain, the square
tower interval, the parapet, the inner-face arcading, the gate types — and the plan of the
northern Campus Martius, against a photograph of the real wall or a published measured
drawing rather than against an opinion. 16 files, **29 MB** total. `reference/` is gitignored
and this directory carries `.metadata_never_index`.

**Deck eligibility: none.** `reference/rome2/` remains the **sole** blind render-quality plate
pool. Everything here is a photograph of a real place, an eighteenth-century etching, or a
georeferenced survey raster; a grader separates photography from rendering on sensor noise
alone and would score 100% without looking at a shadow. Mixing provenance has been got wrong
twice on this project. **Nothing in this pool is deck-eligible.** These are for the **accuracy
and layout** pass only.

**The provenance rule that governed this pass, stated plainly.** A large fraction of the
"Aurelian Wall reconstruction" imagery in circulation is extracted from commercial games —
*Total War: Rome II* above all — or is an artist's impression with no traceable source.
**Nothing was taken from Total War, Creative Assembly, any video game, any game wiki, any
modding site, any reconstruction render, or any artist's impression of unknown provenance.**
No such file was downloaded, and none may be.

**How the licence was verified.** Every Commons candidate was taken through the
`action=query&prop=imageinfo&iiprop=extmetadata` API — which returns the licence recorded on
that individual file's own description page — **before** any byte was fetched, and then the
page's own **wikitext** was read so the licence *template* could be recorded verbatim rather
than paraphrased from a rendered box. Only CC0, Public domain, CC BY or CC BY-SA were
accepted; every accepted file returned an empty `Restrictions` field. The two WMS rasters were
verified against the publisher's own licence page, re-read during this pass (see the two
verbatim quotations below the table). No PDF was fetched: the permitted formats were JPEG,
PNG, SVG and TIFF, and every file here is JPEG.

**What was actually done to check the files, stated honestly.** There is no on-demand AV
scanner in this environment, so this is signature-and-structure checking, not scanning. Each
download was fetched directly from `upload.wikimedia.org` or from the publisher's own OGC
endpoint — no mirror, no shortener — held in memory, and written to disk only after its
**leading magic bytes** matched the declared type (`FF D8 FF` for JPEG, `89 50 4E 47 0D 0A 1A
0A` for PNG) **and** its trailing bytes matched a complete container (`FF D9` for JPEG,
`IEND®B\`‚` for PNG). Anything failing either test was to be discarded unwritten; nothing
failed. No archives were involved, so nothing was extracted; no executable, installer or
script was downloaded or run. Where a Commons original was larger than the pass's byte budget
it was taken as a **rendition from Wikimedia's own thumbnail service** (`Special:FilePath?width=N`,
which snaps to Wikimedia's standard buckets — asking for 4096 or 3200 returns 3840, asking for
2560 returns 1920), which is the same practice as the Lanciani `3840px-` plates above.

### The pool

| File | What it is for | Creator / date | Licence (template, verbatim) | Source page | px | Bytes | SHA-256 (first 16) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `muro-torto-lean-and-fabric-joris-2006.jpg` | **The Muro Torto** — the leaning Pincian retaining wall close to, showing its batter, its height and its brick-and-rubble fabric with a buttress stub. The single most wanted item. | Joris (van Rooden), 2006-01-03 | `{{self\|GFDL\|Cc-by-sa-3.0-migrated\|Cc-by-sa-2.5,2.0,1.0}}` — multi-licensed; taken under **CC BY-SA 3.0** | <https://commons.wikimedia.org/wiki/File:Aurelian_Wall_Mura_delle_torte.JPG> | 2048 × 1536 | 1 502 111 | `de86286975df0bcf` |
| `muro-torto-viale-and-pincio-indeciso42-2024.jpg` | The Muro Torto in section: the sunk Viale del Muro Torto, the leaning wall on the Pincian side, the casino above, the retaining wall opposite. Gives the depth of the cut and the road width. | it:indeciso42, 2024-07-20 | `{{Self\|cc-by-sa-4.0}}` — **CC BY-SA 4.0** | <https://commons.wikimedia.org/wiki/File:MUROTORTOPINCIO20072024_014A.jpg> | 1600 × 1065 | 523 079 | `1183762c54121412` |
| `piranesi-1756-tavXI-muro-torto-speroni-plan-3840px.jpg` | **Measured plan of the Muro Torto's buttresses** — "Pianta de Speroni del muro del Busto, detto Muro Torto", *Le antichità Romane* t. I, tav. XI. The buttress spacing and the wall's plan thickness, surveyed. | Giovanni Battista Piranesi, 1756 | `{{Piranesi\|…}}`, which renders `{{PD-Art}}` + `{{PD-old-100}}` + `{{PD-US-expired}}`: "This work is in the public domain in its country of origin and other countries and areas where the copyright term is the author's life plus 100 years or fewer." / "This work is in the public domain in the United States because it was published (or registered with the U.S. Copyright Office) before January 1, 1931." / "This file has been identified as being free of known restrictions under copyright law, including all related and neighboring rights." | <https://commons.wikimedia.org/wiki/File:Piranesi-1016.jpg> | 3840 × 2591 (orig. 6400 × 4318) | 3 919 126 | `5c14a9f61f393bab` |
| `wall-inner-face-arcading-via-campania-sailko.jpg` | **The inner-face arcading.** Via Campania: the row of tall blind arches carrying the chemin de ronde, with a tower behind. This is the single clearest statement of how the wall is built on the city side. | Sailko, 2016-10-15 | `{{self\|cc-by-3.0}}` — **CC BY 3.0** | <https://commons.wikimedia.org/wiki/File:Mura_aureliane_in_via_campania_a_roma.jpg> | 2724 × 2200 | 4 453 002 | `7eb3b3fd70539514` |
| `wall-walk-parapet-tower-museo-delle-mura-3840px.jpg` | **The wall-walk from above** — parapet, merlons, the gallery floor, a square tower and the run of the curtain, seen from the Museo delle Mura at Porta San Sebastiano. Gives the walk width and the tower interval in one frame. | Pierfelice Licitra, 2013-04-25 (Panoramio) | `{{cc-by-3.0\|Pierfelice Licitra}}` + `{{Panoramioreview}}` — **CC BY 3.0** | <https://commons.wikimedia.org/wiki/File:Mura_aureliane_veduta_dal_Museo_delle_Mura_-_panoramio.jpg> | 3840 × 2880 (orig. 4000 × 3000) | 2 465 841 | `aca4935c71cc7c6e` |
| `wall-corso-ditalia-tower-interval-blackcat-2012.jpg` | The Corso d'Italia stretch (Porta Pinciana → Porta Pia): the curtain seen along its length with successive square towers. Tower interval and the modern street grade against the wall foot. | Blackcat (Sergio D'Afflitto), 2012-07-04 | `{{User:Blackcat/Permission\|3.0\|2012\|07}}`, which renders: "This photograph is a 2012 work by Sergio D'Afflitto. It is released under the terms of CC-BY-SA-3.0 licence. Anyone who reuses this work must give appropriate credit to its author." (API reports `cc-by-sa-3.0-it`) | <https://commons.wikimedia.org/wiki/File:2012-07-04_Roma_Corso_d%27Italia.jpg> | 2817 × 1878 | 1 207 769 | `ed8da18ba3ca4a54` |
| `wall-porta-sansebastiano-to-porta-latina-lalupa.jpg` | The Porta San Sebastiano → Porta Latina stretch as a 3.5:1 panorama — the best-preserved run on the circuit, string courses and tower rhythm legible end to end. | Lalupa, 2012 | `{{PD-user\|Lalupa}}`: "This work has been released into the public domain by its author, Lalupa. This applies worldwide." | <https://commons.wikimedia.org/wiki/File:Le_mura_tra_porta_san_Sebastiano_e_porta_Latina_2012st.JPG> | 3040 × 868 | 579 481 | `25e0f5064d74172c` |
| `middleton-1911-eb11-aurelian-wall-tower-plan.jpg` | **Measured plan and section of one wall segment with its tower**, showing the passage in the thickness of the wall. The only measured drawing of the wall's own cross-section in the pool. | John Henry Middleton, *Encyclopædia Britannica* 11th ed., v. 23, 1911, "Rome", p. 607 fig. 13 | `{{PD-Britannica}}`: "This image comes from the 13th edition of the Encyclopædia Britannica or earlier. The copyrights for that book have expired in the United States because the book was first published in the US with the publication occurring before January 1, 1931. As such, this image is in the public domain in the United States." | <https://commons.wikimedia.org/wiki/File:EB1911_Rome_-_Aurelian%27s_Wall.jpg> | 780 × 406 | 104 562 | `054f41292fa64756` |
| `porta-san-sebastiano-porta-appia-frontal-raboe-2025-3840px.jpg` | **Porta San Sebastiano (Porta Appia) frontal** — the type specimen of the twin-tower gate: two semicircular towers on square marble-faced bases, the Honorian raising, the single arch, the merlons. | Raboe001, 2025-04-25 | `{{cc-by-sa-3.0}}` — **CC BY-SA 3.0** (page also carries `{{GFDL\|migration=redundant}}`) | <https://commons.wikimedia.org/wiki/File:Rom_2025_-_Mura_aureliane_-_by-RaBoe_001.jpg> | 3840 × 1974 (orig. 5334 × 2742) | 1 614 673 | `cd35a05a3ae39750` |
| `porta-salaria-ancient-gate-photo-c1870.jpg` | **Porta Salaria as it stood before demolition** — photograph made *c.* 1870, i.e. the **ancient** gate, before the 1870 breach damage, Vespignani's 1873 replacement, and the 1921 demolition of that replacement. The only pre-demolition record in the pool. | photographer not recorded; Rome, *c.* 1870 | `{{PD-old}}`: "This work is in the public domain in its country of origin and other countries and areas where the copyright term is the author's life plus 70 years or fewer." | <https://commons.wikimedia.org/wiki/File:Porta_Salaria.jpg> | 1417 × 1063 | 333 222 | `da01c72b3616fc6f` |
| `porta-pinciana-external-face-joris-2006.jpg` | **Porta Pinciana, external face** — the northern-arc gate that survives largely as built: a single arch between two semicircular towers on square bases. The northern counterpart to Porta San Sebastiano. | Joris (van Rooden), 2006-01-03 | `{{PD-self}}`: "I, the copyright holder of this work, release this work into the public domain. This applies worldwide." | <https://commons.wikimedia.org/wiki/File:Porta_Pinciana_front.JPG> | 2048 × 1536 | 1 459 365 | `5fb225a30de2019b` |
| `castra-praetoria-north-wall-joris-2006.jpg` | **The Castra Praetoria north wall standing** — the Tiberian camp wall that Aurelian absorbed into the circuit and heightened; shows the earlier fabric under the Aurelianic raising. | Joris (van Rooden), 2006-01-03 | `{{self\|GFDL\|Cc-by-sa-3.0-migrated\|Cc-by-sa-2.5,2.0,1.0}}` — taken under **CC BY-SA 3.0** | <https://commons.wikimedia.org/wiki/File:Castra_Praetoria_North_Wall.JPG> | 2048 × 1536 | 1 467 859 | `7b7c747dff63c169` |
| `piranesi-1756-tavXXXIX-castra-praetoria-plan-3840px.jpg` | **Plan of the Castra Praetoria** — "Pianta della forma del Castro di Tiberio innanzi al suo disfacimento", *Le antichità Romane* t. I, tav. XXXIX. Camp outline, gates and internal arrangement. Piranesi states his own sources on the plate (the surviving remains, the Arch of Constantine relief, coins, ancient writers), so parts of it are **restoration, not survey** — read it against the Lanciani raster below. | Giovanni Battista Piranesi, 1756 | `{{Piranesi\|…}}` → same PD-Art / PD-old-100 / PD-US-expired text quoted for tav. XI above | <https://commons.wikimedia.org/wiki/File:Piranesi-1071.jpg> | 3840 × 5619 (orig. 4374 × 6400) | 5 794 444 | `0567804d0e599e5e` |
| `opus-latericium-putlog-holes-caracalla-villa-2023-1920px.jpg` | **Third-century *opus latericium* close to**, with a brick relieving arch and a clear row of **putlog holes** across the face. Baths of Caracalla, AD 212–216 — the same Roman brick industry, 55–60 years before the wall. | Paolo Villa, 2023-10-06 | `{{cc-by-sa-4.0}}` — **CC BY-SA 4.0** | <https://commons.wikimedia.org/wiki/File:10_2023_-_Terme_(Baths_of)_Caracalla,_Arte_Romana,_Viale_Guido_Baccelli,_Rome,_Roma,_Lazio,_00154,_Italy_-_Photo_Paolo_Villa_-_FO232092_-_Architettura_e_mattoni.jpg> | 1920 × 2899 (orig. 3264 × 4928) | 2 136 017 | `d30e5ecfb74cde16` |
| `lanciani-sitar-northern-arc-campus-martius-EPSG4326-12.4660_41.8955_12.5100_41.9155-4096px.jpg` | **The plan.** Lanciani's *Forma Urbis Romae* rendered over the **northern arc and the northern Campus Martius**: Porta Flaminia, the Muro Torto and the Pincian, Porta Pinciana, Porta Salaria, Porta Nomentana, the Castra Praetoria with the wall running along its north and east sides, the Mausoleum of Augustus, the Horologium/Ara Pacis quarter, Via Lata, the Stadium of Domitian, the Tiber bend. Tower ticks are individually resolved. | Rodolfo Lanciani (1845–1929), Milan 1893–1901, 1:1000; georectification by Gruppo di lavoro SITAR, SSABAP-RM | Publisher's own statement, re-read this pass — see the two verbatim quotations below the table. Map content **public domain by age** (author d. 1929); georectification **CC BY-SA 4.0** to SSABAP-RM | <https://www.archeositarproject.it/geoservizi/> | 4096 × 2496 | 1 449 231 | `0c0bba8acc84a978` |
| `agea-2012-ortofoto-northern-campus-martius-EPSG4326-12.4660_41.9000_12.4900_41.9160-2048px.jpg` | **The modern aerial.** Piazza del Popolo and Porta del Popolo, the Pincio and the Muro Torto cut, the Mausoleum of Augustus and the Ara Pacis, Via del Corso on the line of the Via Lata, and the **Tiber's width and bend** at the Campus Martius with the Ponte Cavour / Regina Margherita / Margherita crossings. Also serves as the Tiber reference. | Agenzia per le Erogazioni in Agricoltura (AGEA), flown 2012; published by the Geoportale Nazionale, MASE | **CC BY 4.0**, verbatim from `gn.mase.gov.it/portale/note-legali` — see below | <https://gn.mase.gov.it/> | 2048 × 1831 | 1 388 493 | `f066ccb76f0ba0b6` |

### 13. AGEA 2012 orthophoto — the **northern extension**, six tiles and a mosaic

Added by the Tiber re-survey pass, 21 Aug 2026. **Same service, same layer, same CRS, same licence
as item 8** — this is item 8's bbox extended 7,011 m north, nothing else.

- **Why it was needed.** Item 8 and item 5 share one bbox and cover survey n −2436 … +2450, i.e.
  world z 388 … 1400 at `KZ` = 0.35. The battlefield runs z −1400 … +1400, so **1,788 world metres
  of the map's river — the ford at z −520 and the whole attacker's approach — was north of every
  plate in `reference/`.** Phase 1's answer was a run-out on the mean bearing. The whole point of
  this pass is that extrapolating between real points is what bent the river the wrong way.
- **Creator / publisher:** as item 8. Agenzia per le Erogazioni in Agricoltura (AGEA), flown 2012;
  published by the Geoportale Nazionale, MASE.
- **Licence:** **CC BY 4.0**, verbatim from `gn.mase.gov.it/portale/note-legali`. Re-read from the
  live `GetCapabilities` before a byte was fetched this pass:
  `<Fees>Nessuna condizione applicata</Fees>`, `<AccessConstraints>Nessuno</AccessConstraints>`.
  Attribution: *AGEA / Geoportale Nazionale — MASE, CC BY 4.0*.
- **Request:** WMS 1.1.1 `GetMap`, `layers=OI.ORTOIMMAGINI.2012.33`, `srs=EPSG:3004`,
  `format=image/jpeg`, host
  `http://wms.pcn.minambiente.it/ogc?map=/ms_ogc/WMS_v1.3/raster/ortofoto_colore_12.map`.
  Six tiles of 2048 × 1365 on a 2 × 3 grid, held in memory and written only after the leading
  `FF D8 FF` and trailing `FF D9` both matched JPEG. `node tools/scratch/tiber-fetch-north.mjs`
  reproduces it; `tools/scratch/tiber-north-tiles.json` records each tile's bbox and SHA-256.
- **Tiling, and why it matters:** each tile's left edge and pixel size are item 8's own —
  `X0 = 2307658.1627`, 1.712209 m/px — and `(4643263.3909 − 4650273.89167) / 1.711966 = −4095.000`
  exactly, so the mosaic is item 8's pixel grid extended upward by exactly 4,095 rows.
  `tools/scratch/tiber-raster.mjs` treats the two as **one raster** with `py` running −4095 … 2734,
  and `src/city/overlay.ts`'s published pixel → survey affine serves both without refitting.
- **Verified rather than assumed:** the Stadio Olimpico read off the mosaic lands at survey
  e −2285, n 4608 against its published 41.93389 N, 12.45472 E — 60 m, inside the reading error at
  1.71 m/px for a 300 m stadium.
- **CRS / extent:** EPSG:3004, X 2307658.16 … 2314671.37, Y 4643263.39 … 4650273.89. Together with
  item 8 that is survey n −2436 … +8180, world z −1505 … +1400 — the whole battlefield.
- Local: `agea-2012-ortofoto-EPSG3004-north-r{0,1,2}c{0,1}-*-2048px.jpg` (six tiles, 5 289 054 bytes
  total) and the mosaic `agea-2012-ortofoto-EPSG3004-north-mosaic-4096x4095.jpg`
  (8 211 946 bytes, SHA-256 `958ee37a3ee2e8a3…`). Tile SHA-256 prefixes: r0c0 `09d21db5606d5dfc`,
  r0c1 `3277458a2d80441e`, r1c0 `7cdd49a01f250f12`, r1c1 `14e70f440dc4c41f`,
  r2c0 `5ac1b726b2aae39b`, r2c1 `1de53931d02159e0`. Nothing ships: `reference/` is gitignored in
  full and carries `.metadata_never_index`.

### The two raster licences, verbatim

- **SITAR** (`https://www.archeositarproject.it/open-data/`, re-read this pass): *"geoservizi
  di rete" allineati agli standard OGC rilasciati con licenza "CC-BY-SA 4.0"*; the same page
  repeats *"i dati SITAR, rilasciati con licenza CC-BY-SA 4.0"* under both **Elastic Search**
  and **API REST**. The caveat recorded for `reference/rome-plans/` still applies: SITAR's
  `/termini-e-condizioni/` carves *scanned imagery* out of the open licence under the Beni
  Culturali Standard label, so the safe reading is map content public domain by age,
  georectification CC-BY-SA 4.0 to SSABAP-RM. Required citation form as recorded above.
- **AGEA / Geoportale Nazionale** (`https://gn.mase.gov.it/portale/note-legali`, re-read this
  pass): *"I dati scaricabili tramite il servizio di Download del Geoportale sono messi a
  disposizione con licenza CC BY 4.0."* Attribution: *AGEA / Geoportale Nazionale — MASE,
  CC BY 4.0*.

### Georeference of the two rasters

Both were requested as **WMS 1.1.1 `GetMap`, `srs=EPSG:4326`** — plain plate carrée, north-up,
no rotation, so the mapping from pixel to WGS84 is a two-line affine with no grid convergence
term. **This is not the EPSG:3004 frame used by `reference/rome-plans/` items 5 and 8 and by
`src/city/overlay.ts`; these two are *not* pixel-registered to those.**

```
Lanciani  bbox 12.4660, 41.8955, 12.5100, 41.9155   4096 × 2496
          lon = 12.4660 + px · (0.0440 / 4096)      lat = 41.9155 − py · (0.0200 / 2496)
AGEA      bbox 12.4660, 41.9000, 12.4900, 41.9160   2048 × 1831
          lon = 12.4660 + px · (0.0240 / 2048)      lat = 41.9160 − py · (0.0160 / 1831)
```

The pixel counts were chosen so that the **ground pixel is square in metres**, not square in
degrees: `W/H` was set to `(Δlon · 82 855) / (Δlat · 111 100)` at latitude 41.9°. Lanciani
resolves to **0.890 m/px**, AGEA to **0.971 m/px** (0.5 m native, downsampled). The AGEA
service refuses any `WIDTH` or `HEIGHT` above 2048 — *"Image size out of range, WIDTH and
HEIGHT must be between 1 and 2048 pixels"* — and there is no image library in this environment
to mosaic tiles, so the orthophoto was framed tighter than the plan rather than stitched.

The Lanciani raster was first pulled as PNG at 18.5 MB, which alone would have blown the pass's
byte budget. It was re-pulled as JPEG at 1.4 MB and the two were **compared at native scale on
a 1024 × 849 window over the Castra Praetoria**: at 1:1 the JPEG resolves the sheet's small
red capitals (`PORTA·PRAETORIA`, `PORTA·COLLINA`, `PORTA·NOMENTANA`) and the individual tower
ticks along the curtain, so the PNG was deleted and the JPEG kept.

### Attribution, as the licences require

Joris (van Rooden) — 3 files, two CC BY-SA 3.0 and one released to the public domain; Giovanni
Battista Piranesi — 2 plates, public domain; Lalupa — public domain; Sailko — CC BY 3.0;
Pierfelice Licitra — CC BY 3.0; Sergio D'Afflitto ("Blackcat") — CC BY-SA 3.0; Raboe001 —
CC BY-SA 3.0; it:indeciso42 — CC BY-SA 4.0; Paolo Villa — CC BY-SA 4.0; John Henry Middleton —
public domain; Rodolfo Lanciani with georectification by Gruppo di lavoro SITAR, SSABAP-RM —
CC BY-SA 4.0; AGEA / Geoportale Nazionale — MASE — CC BY 4.0.

### Wanted, and NOT found under an acceptable licence

- **Ian Richmond, *The City Wall of Imperial Rome* (Oxford, 1930)** — the measured survey of
  the circuit, and the thing this pass most wanted. Richmond died in 1965, so the work is in
  copyright in the UK and the EU until 2036, and its 1930 US publication is outside the
  pre-1930 expiry window. **No plate of it is on Commons or in any open-access repository
  under a usable licence. Not fetched.** `middleton-1911-eb11-aurelian-wall-tower-plan.jpg`
  is the substitute and it is a much thinner drawing.
- **A measured elevation of the Aurelian curtain** — a scaled drawing showing course heights,
  string-course spacing, arcade pier spacing and parapet height as dimensioned lines. Nothing
  of the kind was found under any acceptable licence. Everything on offer is either a modern
  Wikipedia-editor schematic of unstated provenance (`File:Mur d'Aurélien - Dimensions,
  composition et galerie.svg` and its siblings — CC-licensed, but they cite no source and are
  interpretive drawings, so they were **rejected on provenance, not on licence**) or a plate
  inside a copyrighted monograph.
- **The *Bullettino della Commissione Archeologica Comunale di Roma*** — the excavation
  reports on the wall and its gates. Runs of it are digitised, but as **PDF**, which the
  format rule excludes; nothing was extracted.
- **Lanciani's *Storia degli scavi di Roma*, Rossini's *Piante icnografiche*, Middleton's
  *Ancient Rome in 1888*, Parker's *The Archaeology of Rome*, Burn's *Rome and the Campagna***
  — all public domain, all on Commons or the Internet Archive as **PDF only**. Excluded by the
  format rule; cited as reading, not fetched.
- **A 19th-century photograph of the Muro Torto.** Piranesi's 1756 plate is the only
  pre-modern record of it in the pool.
- **Any aerial of the northern Campus Martius from a photographer under CC.** The Commons
  aerials of Rome are of the Vatican, the Forum, the Colosseum and the suburbs; none frames
  the Piazza del Popolo / Pincio. The AGEA orthophoto is the substitute and is better for
  measurement anyway, being nadir and 0.5 m native.

### Checked, licence verified, and deliberately NOT fetched

- **Porta del Popolo (Porta Flaminia).** Several usable files exist — e.g.
  `File:0 Porta del Popolo (Rome).JPG` (Jean-Pol GRANDMONT, **CC BY 4.0**, 3888 × 2592) — and
  the licence was verified. **None was fetched, because none of them shows ancient fabric.**
  What stands is: the **outer façade of 1562–65**, commissioned by Pius IV via Michelangelo and
  built by **Nanni di Baccio Bigio**; the **inner façade by Bernini, 1655**, made for Christina
  of Sweden's entry on 23 December 1655; the **two flanking towers demolished in 1879** and the
  **two lateral archways cut in 1887**. Aurelianic remains and the bases of the gate's
  *cylindrical* towers were found in 19th-century work but are not standing and not visible.
  For the AD 271 map, Porta Flaminia must be reconstructed from the **type** — see
  `porta-pinciana-external-face-joris-2006.jpg`, which is the surviving northern-arc gate of
  the same round-tower family — and from the Lanciani raster for its position, **not** from a
  photograph of the present gate.
- **Porta Asinaria** (`File:Aurelian Walls - Porta Asinaria.jpg`, MrPanyGoff, CC BY-SA 4.0,
  2674 × 1650) and **Porta Nomentana** (`File:Porta Nomentana 28 09 2019.jpg`, Gustavo La Pizza,
  CC BY-SA 4.0, 3840 × 2880). Both verified and both good; both dropped only to hold the pass
  to 16 files, and both are one command away if the gate work needs more of the twin-tower type.
- **`File:Ludovisi - mura e area sepolcrale a piazza Fiume 1865.JPG`** (Lalupa, `{{PD-user}}`).
  Filed under Porta Salaria and dated 1865 in its name, but the EXIF and the camera category
  show it is a **modern digital photograph** of the site; the 1865 date belongs to the
  sepulchral area, not to the picture. **Not a pre-demolition record**, so not used as one.
- **`File:1 Porta salaria.PNG`** and its seven siblings (Ragusaibla, CC BY-SA 4.0). Small
  reproductions of what appear to be historic views, uploaded in 2014 as **"own work"**. The
  licence is clean but the **provenance is not**, so they were rejected on the same rule that
  rejects a game render.

### Not searched, and why

No search was made on any game wiki, mod repository, asset store, or "ancient Rome
reconstruction" image board. Those are exactly where the *Rome II* extractions live, and the
cost of one of them entering a pool that sits next to `reference/rome2/` is far higher than
the value of anything they contain.

---

## Trailer music — `tools/scratch/trailer2-music.mjs` input (not shipped, not in `public/`)

One audio file was downloaded for the second trailer's music bed. **It is not a game asset**: it
is not under `public/assets/`, it is not in `public/assets/manifest.json`, `fetch-assets.mjs`
does not know about it, and no build or runtime code path reads it. The game's own sound remains
100 % procedurally synthesised by `src/audio/Synth.ts` with no sampled audio of any kind, exactly
as `docs/video/README.md` describes. This entry exists because the asset rules apply to anything
downloaded, shipped or not.

| | |
| --- | --- |
| Title | **Song Of The Forge** |
| Creator | **Scott Buckley** |
| Asset page | <https://www.scottbuckley.com.au/library/song-of-the-forge/> |
| Download URL | `https://www.scottbuckley.com.au/library/wp-content/uploads/2025/11/SongOfTheForge.mp3` |
| Licence | **CC BY 4.0** — <https://creativecommons.org/licenses/by/4.0/> |
| Format | MP3, MPEG-1 Layer III, 320 kb/s, 44.1 kHz, joint stereo, 205.869 s |
| Size | 8,238,222 bytes |
| SHA-256 | `5be7859f5846bf80f93c4d936991e76616c8b147c178ba7e77b292191b3b5d48` |
| Attribution | **required** — see below |
| Where it is used | `docs/video/TRAILER-2.md`; the bed is the track's 166.24 s – 194.51 s |

### The licence, quoted from the track's own page

> This work is licensed under a Creative Commons Attribution 4.0 International License; meaning
> it's free for use in any project (including commercial) as long as I'm credited.

### The attribution, in the form the creator's own page asks for

> 'Song Of The Forge' by Scott Buckley - released under CC-BY 4.0. www.scottbuckley.com.au

That string is reproduced **in the trailer itself**, as a credit line burned into the end card's
last 3.5 s, and here. CC BY 4.0 §3(a)(1) requires identification of the creator, a copyright
notice or licence notice where supplied, the licence URI, and an indication of whether the
material was modified. Taken in order: the creator is named; the licence is named and its URI is
above; and **the material was modified** — a 28.267 s window was excerpted from the 205.869 s
original and given a linear fade over its last 0.9 s. Nothing was pitched, time-stretched,
re-equalised, layered or remixed.

### Verification performed on the download

- **Licence read on the individual asset's own page**, not on a listing page and not on an
  aggregator. The library index states CC BY 4.0 for the collection and the track page states it
  again for this track, with the attribution string to use.
- **Downloaded from the creator's own domain**, over the URL published on that page, in one hop:
  `curl` reported `http=200`, `content-type: audio/mpeg`, and a final effective URL identical to
  the requested one — no redirect to a mirror, no re-upload site, no link shortener, no
  intermediary. No account was created, nothing was logged into, and no payment information was
  entered anywhere.
- **Format allowlist:** `.mp3`. No archive, no installer, no executable, no script was downloaded
  in the course of this work.
- **Magic bytes and payload shape:** `file` reports `Audio file with ID3 version 2.3.0, contains:
  MPEG ADTS, layer III, v1, 320 kbps, 44.1 kHz, JntStereo`. The head matches none of
  `fetch-assets.mjs`'s `FORBIDDEN_HEADS` (`MZ`, `ELF`, the four Mach-O magics, the fat/Java magic,
  `#!`) and is not an HTML or XML error page. It decoded cleanly to 9,881,712 samples per channel
  through `OfflineAudioContext.decodeAudioData`, which is the strongest available evidence that
  the bytes are what they claim to be: a non-audio payload does not decode.
- **Malware tooling on this machine:** there is no ClamAV, `rkhunter` or `chkrootkit` installed,
  and macOS's `xprotect` command exposes `update`/`logs`/`version`/`check`/`status` and no
  per-file scan subcommand. What was checked instead: `xprotect status` reports **launch scans
  enabled and background scans enabled** with signature version **5356 (installed 2026-08-19)**,
  so the file has been seen by the system scanner in the ordinary course; `xattr -l` shows the
  file carries no `com.apple.quarantine` flag and only `com.apple.provenance`; and `spctl` /
  `codesign` are not applicable, because the payload is not an executable or a bundle. The
  SHA-256 above pins exactly what was examined.
- **Nothing was taken from a game.** No Total War, Rome II or other commercial-game audio was
  downloaded, extracted, referenced or listened to. The alternative sources considered were
  Kevin MacLeod's `freepd.com` — **rejected because the site is offline as of August 2026 and its
  closure notice is not a licence statement** — and Pixabay, rejected because the Pixabay Content
  Licence is neither CC0 nor CC BY and its redistribution terms are not clean for a video that
  ships as a release asset.
