# TOTAL CLAUDE — The Siege of Rome, 271 AD

A real-time historical battle simulator in Three.js, built to stand comparison with
Total War: Rome II. Around **9,000 individually simulated soldiers** on a 2.8 km
battlefield: a Juthungi host coming down the Via Flaminia against a late-third-century
Roman field army drawn up in front of the unfinished Aurelian Wall.

Everything renders from code and CC0 assets — no game rips, no commercial content.

**Play it:** [total-claude.vercel.app](https://total-claude.vercel.app)

![Two lines locked in contact on the Campus Martius](docs/images/clash.jpg)

*Roman cohorts in shield wall on the left, a Juthungi warband on the right, dust rising from
the contact corridor between them. 8,561 men simulated, 109 draw calls.*

---

## More

<table>
<tr>
<td width="50%"><img src="docs/images/romanline.jpg" alt="A legionary cohort in line"></td>
<td width="50%"><img src="docs/images/germanhorde.jpg" alt="A Juthungi warband"></td>
</tr>
<tr>
<td><b>Roman line.</b> Segmentata banding, ring mail, cheek-guarded <i>galea</i>, the painted
<i>scutum</i>, and the cohort's <i>vexillum</i>. Every man's shield colour, helmet variant,
crest, skin tone and kit wear is drawn from a stable per-soldier hash, so no two adjacent
men are the same.</td>
<td><b>Juthungi warband.</b> Round limewood shields in different colours with painted
spirals, sunwheels and wolf-heads — men who equipped themselves rather than a quartermaster
who equipped them.</td>
</tr>
<tr>
<td><img src="docs/images/melee.jpg" alt="Inside the melee"></td>
<td><img src="docs/images/aftermath.jpg" alt="The field after the battle"></td>
</tr>
<tr>
<td><b>The melee.</b> Only men who can actually reach an enemy fight; rear ranks press
forward and step into the gaps the dead leave. A quarter of engagements pair two soldiers
into a single shared animation, as Rome II's own <code>matched_combat_percentage</code> does.</td>
<td><b>Aftermath.</b> Blood soaked into the soil, earth churned along the whole contact line,
spent pila and arrows standing where they fell, dropped shields and helmets. Ground damage
accumulates into a persistent buffer and is never cleared.</td>
</tr>
<tr>
<td><img src="docs/images/wall.jpg" alt="The Aurelian Wall under construction"></td>
<td><img src="docs/images/cavalry.jpg" alt="Cavalry at the gallop"></td>
</tr>
<tr>
<td><b>The Aurelian Wall, 271 AD.</b> Brick-faced concrete on a travertine footing, square
towers at one Roman <i>actus</i> (35.5 m), a stair to the wall-walk, and behind it painted
insulae with terracotta roofs. In front, the Via Flaminia necropolis and its cypresses.</td>
<td><b>Cavalry.</b> The gallop's phase is owned by the horse and advanced at its own speed
divided by its measured 5.36 m stride, so hoof slip averages 0.000 m/s instead of the
2.7&ndash;4.1 m/s it started at &mdash; a third of ground speed.</td>
</tr>
<tr>
<td><img src="docs/images/wide.jpg" alt="The battlefield from above"></td>
<td><img src="docs/images/establishing.jpg" alt="The Roman order of battle"></td>
</tr>
<tr>
<td><b>Strategic view.</b> Centuriated fields on a 94&nbsp;m lattice &mdash; the layout is
georeferenced against Lanciani's <i>Forma Urbis Romae</i>, with per-landmark positional
error measured at a mean of 45&nbsp;m.</td>
<td><b>The order of battle.</b> Rome fields 3,784 against 4,860, out-fronted 248&nbsp;m to
334&nbsp;m. Do nothing and you lose: a passive Rome takes 37% casualties and ends the battle
with Juthungi wedges behind its line.</td>
</tr>
</table>

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

### Setting up a battle

The game opens on a Total War-style custom-battle screen before anything loads, so a small
battle never waits for a big one's assets.

- **Battle size** — Small / Normal / Large / Ultra / Extreme, Total War's own ladder. It
  multiplies every unit's establishment, so a legionary cohort is 80 men at Small and 480 at
  Extreme. Artillery crews do not scale; a scorpion needs two men whatever the setting.
- **Army composition** — a row per unit type per side with steppers, capped at **20 units a
  side** (Total War's limit, and past it the card bar stops fitting on screen) and 12 of any
  one type. Live totals show units, men and metres of battle line for each army.
- **Conditions** — time of day, difficulty, graphics tier, and the seed. Same seed and same
  composition replays identically.

Two things it tells you rather than deciding for you. If the chosen size needs more men than
the graphics tier's soldier pool holds, every unit is scaled down to fit — all units stay
present — and it says by how much. And past about 9,000 men it warns that a heavy frame drops
under 60 fps, with the measured numbers, because it does: on an M4 Max at 1920×1080 a rout
frame costs 13.4 ms at 8,644 men, 16.1 ms at 9,584 and 19.2 ms at 11,255.

"Historical order of battle" restores the 271 AD deployment. "Copy link to this battle" puts
the whole setup in the URL so it can be shared or replayed. `?menu=0` skips the screen.

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

**Live at [total-claude.vercel.app](https://total-claude.vercel.app).**

**Vercel:** import the repo and accept the defaults — `vercel.json` is committed.

Note that the CLI cannot deploy to a *personal* Vercel account non-interactively: it
demands an explicit `--scope` and rejects a personal account there outright, offering only
your teams. `tools/deploy-vercel.mjs` goes via the REST API instead, uploading `dist/` as a
prebuilt static deployment:

```bash
npm run build && node tools/deploy-vercel.mjs --name total-claude
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
