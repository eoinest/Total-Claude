# Carthage map plan — child agent registry

Manager worktree: `/private/tmp/tc-cmap2`, branch `e/city/carthage-plan`, based on `965e12b`.
Concurrency cap: **3**, never exceeded. Peak load 9.75 against the 78 that killed nine agents.
Own ports: **5199**, **5561**, **5563**. Port 5173 is the owner's playtest server and was
confirmed up and untouched (PID 60618) at the start, the middle and the end.

## Wave 0 — salvage from the predecessor (manager, no children)

Both dead worktrees were checked before a line was written, and both held uncommitted work.

| item | from | status |
|---|---|---|
| `tools/probe-carthage.mjs` +1111 lines, `--plates` mode | `tc-cplan2` @ `e1c4d58` | committed `0c41eb6`; base blob byte-identical to main, so copied |
| `src/maps/carthage/heightfield.ts` +343, the basin cut | `tc-cplan2` @ `e1c4d58` | committed `0c41eb6`; base byte-identical, copied |
| `tools/scratch/*.mjs` 12 measuring tools | `tc-cplan2` | committed `0c41eb6` |
| `src/city/carthage/fabric.ts` +70, the one-city lattice | `tc-cplan` @ `b7d8aaf` | rebased by `git apply --3way`; one conflict (`let drowned = 0`, from the water-datum fix) resolved by keeping both. Committed `55cd022` |
| six rendered plates | `tc-cplan` | **discarded, not shown to the owner** — shot at `b7d8aaf`, they show 22 lagoon houses and a cothon 1.46 m below the sea, both since fixed |

## Children

| # | name | id | wave | status | outcome |
|---|---|---|---|---|---|
| D1 | verify-build | `aa3374a5e2505ffbe` | 1 | **REPORTED, stopped, ports freed** | typecheck PASS. Liveness attempt inconclusive — it used `?map=carthage`, but the app selects its map from a base64 `?battle=` token, so the page loaded clean with zero errors and simply never started a battle. Superseded by the manager's own completed probe run. Also found the worktree had no `node_modules`; `npm ci` fixed it |
| D2 | merchant-basin | `aa6f2d01a6ed7eeae` | 1 | **REPORTED, stopped** | found it: `harbour.ts:261` sampled the merchant quay's height at the *basin centre*, which the excavation digs to the bed — so turning the cut on would have put every quay and mole 3 m under. Fixed the sample point, enabled `CUT_MERCHANT_BASIN`. **84% buried → 0.8%** (2.3% by the stricter of two instruments; both reported rather than the flattering one). Cothon unregressed. Commit `520988a` |
| D3 | landmark-audit | `a0fc75da331579558` | 2 | **REPORTED, committed, stopped** | the Tophet of Salammbô was coded at (x −1150, z 950) under a comment citing the survey's e/n that had never been run through the projection. §2.5 gives x −740, z 929 — **410 m out**. Commit `9d0f4ea` |

## Stop log

- D1 — sent a wrap-up directive at its time box; reported, killed its own vite by PID, removed
  its two scratch scripts, confirmed 5199 free and 5173 untouched.
- D2 — completed on its own inside its box.
- D3 — sent two directives; committed and stopped. `TaskStop` was refused for this agent
  ("owned by" itself), so the stop was verified the honest way instead: worktree
  `git status` clean, and all three of my ports confirmed with no listener.
- Final check: 5199 / 5561 / 5563 all free. 5173 still up on its original PID.

## A correction I made against myself

I grepped `layout.ts` for the Tophet, read `x: -740, z: 929`, and told D3 its 410 m finding was
**refuted**. It was not. I had read D3's own uncommitted edit sitting in the shared worktree and
mistaken it for the original. D3 was right and I was wrong, and because my plate set had been
shot minutes earlier it was carrying the *old* position — so the plates were re-shot at
`9d0f4ea` and the Tophet's label verified at screen x 573 (world −740) where the stale one would
have been at 261. Three agents committing into one worktree is what made this possible; the
lesson is that a `grep` is not a measurement of `HEAD` unless the tree is clean.

## D3's landmark table, recorded in full

Coded against §2.5's survey run through §2.3's projection, world metres, worst first.

| landmark | coded | survey | error | disposition |
|---|---|---|---|---|
| Tophet of Salammbô | (−1150, 950) | (−740, 929) | **410.3 m** | transcription bug — **fixed**, `9d0f4ea` |
| Cothon | (−930, 1000) | (−670, 984) | 260.4 m | deliberate — `layout.ts` header, departure 1: basin centres separated at true scale, not projected |
| Forum | (−230, 1005) | (−180, 1000) | 50.2 m | deliberate, documented twice — §7.6 moves it for room, `layout.ts` moves it again to lengthen the three streets |
| Merchant harbour | (−540, 1010) | (−540, 973) | 37.5 m, all in z | x exact; z residual small and unitemised |
| La Malga Cisterns | (100, 788) | (100, 788) | 0 | correct |
| Byrsa summit | (0, 945) | (0, 945) | 0 | correct, it is the origin |

`circuit.ts`'s `SHORE` polyline matches §3.6 at all seven points.

**The Odeon, and why D3's one wrong call is worth keeping on the record.** D3 reported the
Odeon as a *missing landmark*: the terrain hill stands at exactly (210, 1037), `topography.ts`
said the ridge carried "the Odeon" on its summit, and no monument existed. Every one of those
facts is true and the conclusion is backwards. The Odeon of Carthage is **Severan, c. AD 200**
— 350 years after this map's moment — and `docs/CARTHAGE.md` only ever uses the word as a
modern place-name for a survey point (§2.5 a coordinate, §3.3 an elevation). The building is
not missing, it is correctly absent, and building it would drop an imperial concert hall into a
Punic city on the day that city died.

The defect was the *comment*, which was quietly instructing every future agent to commit an
anachronism — and had already produced one such report. Comment corrected in `topography.ts`,
naming the trap so the next audit does not re-file it.

**Wall, FYI only, not touched:** `circuit.ts` self-diagnoses that two independently-fitted
curves through the wall's three surveyed anchors disagreed by up to ~25 world m at mid-span.
Wall-owned, `src/city/carthageWall.ts`, another workstream's ground.

---

# Missile geometry over a crenellated parapet — child agent registry

Manager worktree: `/private/tmp/tc-merlon`, branch `e/sim/merlon-embrasure`, based on `89cb13f`.
Concurrency cap: **3**, and in practice **2**. Machine load was already 25 at the start, against
the 78 that killed nine agents. Own ports: **5301**, **5303**. Port 5173 is the owner's playtest
server and is not touched.

Held by other agents and therefore read-only here: `src/city/wall.ts`, `src/city/carthageWall.ts`,
`src/sim/Siege.ts` (wall traversal past towers), `src/city/carthageWall.ts` again (gate-door seam),
`src/sim/Combat.ts` (melee), `src/terrain/` (shading), `src/city/carthage/` (housing).
This workstream writes only `src/sim/Projectiles.ts`, `src/city/CitySystem.ts` and `tools/`.

## Children

| # | name | id | wave | port | status | outcome |
|---|---|---|---|---|---|---|
| M1 | measure | `a89415936a629a216` | 1 | 5301 | launched | where garrison arrows die, per rank; before-arm kills/min |
| M2 | geometry | `ab2fe961b69e49ff5` | 1 | none (read-only) | launched | parapet profile both cities; phase alignment |

## Stop log

(filled in as each reports)
