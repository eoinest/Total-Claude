# TOTAL CLAUDE — The Siege of Rome, 271 AD

A real-time historical battle simulator in Three.js, built to stand comparison with
Total War: Rome II. Around **9,000 individually simulated soldiers** on a 2.8 km
battlefield: a Juthungi host coming down the Via Flaminia against a late-third-century
Roman field army drawn up in front of the unfinished Aurelian Wall.

Everything renders from code and CC0 assets — no game rips, no commercial content.

---

## The setting is real

The Juthungi and Alemanni broke into Italy in 270–271. Aurelian caught and beat them at
Placentia, Fano and Pavia, but the panic they caused in the capital is exactly why he
began the Aurelian Walls that same year. This is that campaign's *what if they had reached
the city* — which is why the wall in the background is **under construction**, with
half-built bays, scaffolding, a treadwheel crane, mortar pits and a gap hastily blocked
with palisade and rubble.

Kit is 271 AD, not the Augustan cliché: ring mail and the longer *spatha* are displacing
*segmentata* and the *gladius*, oval shields are replacing the rectangular *scutum*, and
ridge helmets are coming in. The Germanic side fights in deep wedges with *framea*
javelins, long ash spears and painted limewood shields.

---

## Running it

```bash
npm install
npm run dev          # http://127.0.0.1:5173
```

Assets are optional — with an empty `public/assets/` everything falls back to procedural
substitutes and the game still runs. To fetch the CC0 set (213 MB, integrity-checked
against pinned SHA-256s):

```bash
npm run assets
```

### Controls

| | |
|---|---|
| **W A S D** / arrows / screen edge | pan |
| **Q E** or right-drag | rotate |
| wheel | zoom (drives pitch and FOV together, as Total War's does) |
| **left-click** / drag | select unit / marquee select |
| **double-click** | select all of that type |
| **right-click** | move, or attack the unit under the cursor |
| **right-click-drag** | set frontage and facing (drag length = line width) |
| **shift** + order | queue a waypoint |
| **1 2 3** / **space** | speed 1× / 2× / 4× / pause |
| **F3** | AI debug overlay |
| **L** | performance overlay |

---

## Deploying

Static build; no server needed.

```bash
npm run build        # typecheck → vite build → asset optimisation
npm run preview      # check the production build locally
```

**Vercel:** import the repo and accept the defaults — `vercel.json` is committed. Or:

```bash
npx vercel --prod
```

The build step cuts the deployed payload from **213 MB to 24 MB**:

- Ground textures are resized to the resolution the shaders already consume (the terrain
  halves everything to 1024/512 at load anyway, so shipping 2K downloaded four times the
  pixels and discarded three quarters) and re-encoded to WebP: 164.9 MB → 4.6 MB.
- HDRIs are copied verbatim. Re-encoding Radiance to any 8-bit format destroys the >1.0
  radiance values that make them usable as a light source rather than a picture.
- The 30 MB of Quaternius models is omitted, because nothing in `src/` constructs an
  `FBXLoader` or `GLTFLoader` — both the terrain and unit pipelines ended up fully
  procedural. They stay in the repo for provenance; `npm run build:full` includes them.

---

## How it works

`docs/ARCHITECTURE.md` is the full contract. In brief:

**Engine.** Fixed 30 Hz deterministic simulation, variable-rate render that interpolates
between ticks. Subsystems never reference each other directly — they resolve dependencies
by name and communicate over a typed event bus. Four quality tiers.

**Simulation.** Soldiers live in a structure-of-arrays pool of typed arrays with a
uniform-grid spatial hash rebuilt every tick. At 9,000 men an array-of-objects layout
spends most of its time chasing pointers. Nothing in a fixed step touches `Math.random()`;
every stochastic decision draws from a seeded stream, so a battle replays identically —
verified by hashing every soldier's state across independent runs.

**Combat** resolves per soldier: only men who can actually reach an enemy fight, rear ranks
press forward and step into gaps, blows land on the animation's weapon-contact frame, and
shields only defend the arc they actually face — so flanking genuinely bypasses them.

**Morale** decides battles, not casualties. Attrition, flanking, encirclement, fatigue,
cavalry shock, witnessed routs, the general's aura and army-wide collapse all feed a
pressure model; routs spread by contagion, and a broken unit that gets clear can rally and
re-form. A typical battle is decided by a cascading collapse in about two minutes.

**Rendering.** Soldiers are GPU-skinned instances: bone transforms are baked into a
quaternion+translation texture (360 KB for all 35 clips, shared by every LOD, faction and
kit variant) and blended in the vertex shader, so a whole army draws in **≤ 12 calls**
across three mesh LODs and a billboard tier. Terrain is a geo-clipmap in **one draw call**
over a 2049² eroded heightfield, splat-blended by *height* rather than linear interpolation
so gravel sits in the hollows of grass. Sky is a Rayleigh/Mie/ozone scattering integral
baked to a cube that feeds both the visible sky and the IBL, so the lighting cannot
disagree with what the player is looking at.

**Audio** is entirely synthesised at runtime — 89 sounds, zero audio files shipped,
including the Germanic *barritus* that Tacitus and Ammianus both describe.

---

## Verification

Quality is graded from rendered frames, not from source.

```bash
npm run shoot                    # 15 repeatable camera shots → screenshots/
npm run shoot -- --list
npm run trace                    # battle state over time: does it advance, clash, resolve?
npm run perfdiff -- a.json b.json
```

The harness boots the game in headless Chromium on a real GPU, fast-forwards the
simulation, auto-frames the combat shots on the live engagement centroid, and measures
true frame cost behind a `readPixels` barrier. `docs/VISUAL-RUBRIC.md` is the 40-criterion
standard used to judge the output.

---

## Assets and licensing

Every shipped asset is CC0. `ASSETS.md` records name, creator, source URL, licence and
SHA-256 for all 172 files, plus what was deliberately skipped and why.

- **Poly Haven** (CC0) — sky HDRIs and PBR ground/material textures.
- **Quaternius** (CC0) — models and rigged characters used as animation and proportion
  references during development.
- Everything else — soldier and horse meshes, all texture atlases, the entire city, all
  vegetation, every sound — is generated in code.

Nothing is derived from Total War, Rome II, or any other commercial game. Sketchfab models
were skipped entirely: downloads are account-gated, so licences could not be verified
against the actual files, and the site is a known home for game rips.

`reference/` is gitignored and holds no project content.
