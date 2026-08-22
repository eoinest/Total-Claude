# Rome fabric, phase 1 — the review plates

Branch `e/city/rome-fabric-p1`, based on `15e209f`. **`KZ` 0.222 → 0.35. Nothing else about the city
was rebuilt: no roads, no grid, no fabric, and `resolveOverlaps` is still live.** Full write-up in
`docs/ROME-FABRIC.md` §7.

Open them in this order.

---

## 1. `01-survey-on-lanciani-survey-only.png` — is the survey right?

**Look at this one first, and look at it for a long time.**

Every monument in the survey drawn at its **real published plan**, at its **real bearing**, at its
surveyed position, on the georeferenced Lanciani *Forma Urbis Romae* — the plate the survey was
fitted to, at 1.71 m/px with a worst georeference residual of **1.26 m over 7 km**. Everything is in
**real metres**. No projection is involved, so nothing in this picture can be wrong because of the
map's compression.

**The question it answers: does each black rectangle sit on its own inked plan?** If it does, the
survey's position for that monument is right. Piazza Navona is the Stadium of Domitian, the round
plan north-west of it is the Mausoleum of Augustus, the big rectangle top right is the Castra
Praetoria, and the ellipse bottom centre is the Colosseum.

The blue line is the Aurelian circuit's fourteen surveyed waypoints. The red dashed line across the
bottom is **the +Z edge of the battlefield at `KZ` 0.35** — everything south of it is off the map.
The five red dashed rectangles below it are the monuments that cost us: the **Palatine, the Circus
Maximus, the Aventine, the Baths of Caracalla and the Caelian.** That is the price, drawn to scale on
the plate, rather than described. The Janiculum ridge (green, far left) survives after all.

## 2. `01-survey-on-lanciani-after.png` — and what the engine actually draws

The same plate and the same black survey rectangles, plus an **orange** layer: where the engine puts
each monument, taken back out of world coordinates into the same real-metre frame, with a line from
where it should be to where it is.

**The orange layer is the fault you reported.** *"The footprint of where the buildings are is
completely wrong… everything is completely off."* The mechanism is `resolveOverlaps`, a solver that
runs at boot and pushes monuments apart until nothing intersects. It succeeds — nothing intersects —
and it pays for that by moving the Theatre of Pompey **1,098 real metres**, the Stadium of Domitian
887, the Iseum 755. Mean displacement is 351 real metres.

**This is worse than it was before this change, and that is expected and temporary.** At `KZ` 0.222
the mean was 226 real metres and the worst 672. Giving the solver a deeper city gave it more room to
push into, so it pushed further. **Phase 2 deletes the solver**, and `docs/ROME-FABRIC.md` §7.8 shows
the arithmetic that says it can be deleted without the overlaps coming back.

## 3. `01-survey-on-lanciani-before.png` — the same picture at the old `KZ`

For comparison. The survey layer is identical (it is in real metres). What differs is the position of
the red +Z edge — off the bottom of the plate, so nothing was lost — and the orange layer.

---

## 4. `02-engine-plan-after.png` / `02-engine-plan-before.png` — the map from overhead

The engine's own plan view, north up, with a 500-world-metre scale bar, at `KZ` 0.35 and 0.222.
Monuments labelled, districts as dashed rectangles, the Tiber in blue, the wall in dark red across
the top.

Two things to notice, **both of which are phase 5's and neither of which this change caused**:

- **The dashed district rectangles overlap enormously.** Seventeen quarters claim 266 % of the ground
  inside the circuit. That is the "quilt" fault; phase 5 replaces them with the fourteen Augustan
  regions, which tile.
- **Insulae are standing in the Tiber.** Measured: **37 of 903 solids entirely under the water line
  before this change, 60 of 1,259 after** — the same rate, more city. Nothing has ever checked for
  it.

Comparing the two: at `KZ` 0.35 the Campus Martius band behind the gate is **716 world metres deep
against 450**, and 39 % more city is standing in it.

---

## 5. `engine-after/` — six in-engine frames

Real GPU rasterisation, ANGLE/Metal, 1920 × 1080, HUD off.

| file | what it is |
|---|---|
| `ground-funnel.png` | down the funnel from the attacker's line — the ground the battle is fought on |
| `ground-bench.png` | the wall on its graded bench, climbing the Muro Torto, from the field |
| `wall.png` | along the Aurelian curtain, raking light |
| `city.png` | the wall with the city behind it |
| `skyline.png` | Rome behind the wall |
| `deepcity.png` | deep into the city — insula density and landmark silhouettes |

`city.png` shows the buildings-in-the-river fault clearly.

---

## What phase 1 claims, and what it does not

**Claims, all measured:** the wall is untouched — 36 bays, x 2.006 to 1334.55, 37.015 m pitch,
byte-identical to before. The approach is 725.7 m, unchanged. The Tiber re-fits its twelve survey
points to 0.1 m. The graded bench is ≥ 40 m under 100 % of stations. Zero bays in the water, zero
projectile rays through the wall, zero section faults. The georeference is untouched.

**Does not claim:** that the city looks right. It does not yet. The monuments are displaced, the
districts overlap, the blocks are hash-rotated and some of them are in the river. Those are phases 2
through 5, each with its own acceptance measurement written down in `docs/ROME-FABRIC.md` §5 before
the work starts — which is the thing the previous attempt did not do.

**What phase 1 is asking you to approve is the frame**: `KZ` = 0.35, and the loss of the five
monuments in plate 1.
