# Visual Rubric — grading against Total War: Rome II

The standard for this project. Critics score rendered frames against these criteria,
not against source code. Every item is something a Rome II frame actually does, chosen
because it is *diagnostic* — the specific tells that separate a shipped AAA strategy
game from a competent WebGL demo.

Scoring per criterion: **0 = absent, 1 = attempted but wrong, 2 = acceptable,
3 = matches Rome II, 4 = exceeds it.**
A subsystem passes at **mean ≥ 3.0 with no criterion below 2**.

---

## A. Lighting & atmosphere (the highest-signal category)

| # | Criterion | The specific tell |
|---|---|---|
| A1 | Warm/cool split | Sunlit surfaces are warm; shadowed surfaces take a distinctly cool blue-grey sky bounce. Flat grey shadow = instant fail. |
| A2 | Aerial perspective | Distant terrain/city progressively desaturates and shifts toward sky colour. Should be *strong* — Rome II's distance haze is very pronounced. |
| A3 | Shadow quality | Tight and dark at contact points (feet, wall bases), softening with distance from the occluder. No acne, no peter-panning, no crawling while the camera pans. |
| A4 | Sun direction legibility | You can tell where the sun is from the shading alone, without seeing it. |
| A5 | Sky depth | Gradient from horizon haze to zenith, cloud form with real silhouette and silver lining toward the sun. Not a flat blue dome. |
| A6 | Exposure & contrast | Filmic S-curve. Highlights roll off rather than clipping to white; shadows retain detail rather than crushing to black. |
| A7 | Ambient occlusion | Contact darkening in crevices, under eaves, between men in a rank. Subtle — not a dirty grey outline around everything. |
| A8 | No flat ambient | Nothing looks lit by a uniform hemisphere. Every surface has directional information. |

## B. Terrain & ground

| # | Criterion | The specific tell |
|---|---|---|
| B1 | No visible tiling | From a high camera, no repeating texture grid. Requires macro variation, not just a small tile. |
| B2 | Material variety | Dry grass, trampled dirt, mud, gravel, stone — blended by slope/height/curvature, interlocking rather than cross-fading. |
| B3 | Close-up fidelity | At eye level in the melee, the ground still reads as ground: detail normal, small stones, grass tufts. |
| B4 | Erosion plausibility | Valleys have V-profiles and connected drainage; ridges have coherent lines. Not obviously fBm noise. |
| B5 | Grass integration | Grass fades into terrain colour with no visible density ring or LOD pop; moves with wind. |
| B6 | Vegetation placement | Trees clustered as they would actually grow — along water, in copses, following boundaries. Not uniform sprinkle. |
| B7 | Human landscape | Roads, field boundaries, terraces. Evidence of habitation. |

## C. Units & crowds (where hobby projects fail hardest)

| # | Criterion | The specific tell |
|---|---|---|
| C1 | Individual variation | No two adjacent men identical: height, kit, skin, beard, cloak, shield emblem. Scan a rank — if you spot a repeated pair, fail. |
| C2 | Animation desync | Idle and march cycles visibly out of phase across a unit. Synchronised breathing is a fatal tell. |
| C3 | Kit specificity | You can identify the unit type from its silhouette: segmentata bands, scutum curve, galea cheek-guards, spangenhelm, bare-chested fanatics. |
| C4 | Formation density | Men nearly shoulder to shoulder (~0.86 m). Rome II formations are *dense*; sparse ranks read as a tech demo. |
| C5 | Formation legibility | Ranks and files readable from above; the shape of the formation is obvious. |
| C6 | Weight in motion | Footfall, hip counter-rotation, lean into acceleration. No sliding feet, no floating. |
| C7 | LOD invisibility | No popping as the camera moves. Silhouette preserved at every tier. |
| C8 | Corpses | Fallen men lie conformed to the ground, varied poses, persistent, piling where fighting was heaviest. |
| C9 | Scale truth | A man is 1.75 m against 6.5 m walls and 43 m domes. Everything reads at correct relative size. |

## D. City & architecture

| # | Criterion | The specific tell |
|---|---|---|
| D1 | Mass and thickness | The wall reads as metres of solid masonry, not a plane. Visible depth at gates, embrasures, wall-walk. |
| D2 | Material honesty | Brick courses read as courses. Travertine looks like travertine. Romans painted their buildings — ochres, reds, whites, not bare grey. |
| D3 | Silhouette recognition | The skyline is unmistakably ancient Rome without a caption. |
| D4 | Density without repetition | Insulae are varied in height, width, roofline, colour. No copy-paste grid. |
| D5 | Weathering | Dirt at bases, sun-bleaching on top, staining below drains. |
| D6 | Period accuracy | Nothing medieval or fantastical. Correct proportions for known buildings. |

## E. Combat & VFX

| # | Criterion | The specific tell |
|---|---|---|
| E1 | Dust | Moving formations trail sunlit dust; a cavalry charge rolls a wall of it. Rome II's most recognisable effect. |
| E2 | Clash readability | The moment lines meet is visually distinct — compression, dust, debris. |
| E3 | Front-rank fighting | Only men in contact are swinging. A whole block flailing is wrong. |
| E4 | Blood restraint | Present and physical; not a red firework. |
| E5 | Ground persistence | Blood pools, trampled earth, spent shafts accumulate over the battle. |
| E6 | Particle lighting | Particles lit by the sun, depth-faded against geometry. No flat unlit billboards. |
| E7 | Banners | Legible, wind-driven cloth. The landmarks that let you read the field. |
| E8 | Missile plausibility | Volleys ragged not synchronised; arcs correct; misses scatter believably. |

## F. Presentation & UI

| # | Criterion | The specific tell |
|---|---|---|
| F1 | Register | Bronze/gold/oxblood, Trajan capitals, engraved metal. Reads as a historical AAA title, not a web dashboard. |
| F2 | Information density | Unit cards carry strength, morale, fatigue, ammo, status at a glance. |
| F3 | Finish | Nothing misaligned, clipped, low-contrast, or default-browser-styled. Crisp on HiDPI. |
| F4 | Restraint | HUD does not fight the battle for attention. |

## G. Frame-level craft

| # | Criterion | The specific tell |
|---|---|---|
| G1 | Composition | A still frame is *photographic* — it has a subject and depth layers. |
| G2 | Colour grade | Sun-bleached, slightly desaturated, cohesive. Not oversaturated, not orange-teal. |
| G3 | Anti-aliasing | No stair-stepping on wall edges or spear shafts; no shimmer on distant ranks. |
| G4 | Post restraint | Bloom on genuine highlights only. Subtle vignette and grain. No lens-flare spam. |
| G5 | Believability | The instinctive reaction is "screenshot from a game I could buy", not "impressive for a browser". |

---

## Critic instructions

1. **Look at the frame before reading anything about it.** Form a first impression and
   write it down. First impressions catch what analysis rationalises away.
2. Score every applicable criterion with a one-line justification citing what you see.
3. **Be harsh.** Grade inflation makes you useless. If the mean is above 3.0 you are
   claiming this matches a game with a multi-million-dollar art budget — hold that bar.
   Most first passes should score 1.5–2.5.
4. Name the **single highest-leverage fix**: the one change that would most improve the
   frame. Be specific and actionable ("distance haze is far too weak, raise density
   ~4× and tint it toward sun colour"), never vague ("improve the lighting").
5. Do not credit intent. If code exists for an effect but the effect is not visible in
   the frame, it scores 0.
6. State the verdict explicitly: **PASS** (mean ≥ 3.0, nothing below 2) or **FAIL**,
   with the mean and the list of sub-2 criteria.
