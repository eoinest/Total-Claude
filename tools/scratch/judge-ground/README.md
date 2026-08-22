# Ground-judge measurements

Raw output of `tools/scratch/judge-fabric.mjs`, one file per tree, named by the commit whose
`src/` produced it. Kept so that `docs/CITY-GROUND-JUDGE.md`'s numbers can be checked without
re-running a browser, and so that the next pass has a before to diff against.

| file | tree | map |
|---|---|---|
| `rome-58bc584.json` | `main`, `KZ` = 0.222 — the tree the owner looked at | campus-martius |
| `carthage-58bc584.json` | same tree | carthage — the control |
| `rome-bc2e0f2.json` | the three builders' shared base, `KZ` = 0.35, phase 1 landed | campus-martius |

Each holds `walk` (the gate axis in 5 m steps, with what a standing man is inside and what the
frontage is left and right), `samples` (random open points and their opposed gaps), `monuments`
(built footprints), and `cityStats` (the city's own published way-in-monument count).

**`monuments[].h` is not trustworthy and is not quoted anywhere.** See
`docs/CITY-GROUND-JUDGE.md` §1: three methods gave 9.2 m, 89 m and 55.2 m for the same
amphitheatre. The footprints and the walk are sound; the heights are a datum problem nobody has
solved yet, and solving it is worth an hour to whoever needs an absolute height.
