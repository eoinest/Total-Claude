# Carthage map plan — child agent registry

Manager worktree: `/private/tmp/tc-cplan` (detached at `b7d8aaf`).
Concurrency cap: **3**. Every child must be stopped before the manager reports.

| # | name | id | wave | status | scope |
|---|---|---|---|---|---|
| C1 | ref-analysis | `ae8a3a35e2d4554ae` | 1 | **REPORTED, stopped** | four images all Roman; birdseye block pitch 85-125 m = 6-8x coarser than the Punic module |
| C2 | code-inventory | `ac85b58a26b73abce` | 1 | **REPORTED, stopped** | no resolver, Rome's defect structurally avoided; 4 real gaps found (Tophet 410 m, mole not walkable, cut channel invisible, no sea wall) |
| C3 | viz-harness | `a0b1e7863bd137ada` | 1 | RUNNING | `--plates` mode; 4 plates written 23:41 and verified legible by the manager |
| C4 | lattice | `a91cbd4366e1ffe2f` | 2 | **REPORTED** | snap works: 13 built bearings -> 1, reach +2.1/+0.3/-0.1 ha, -8 blocks. Exposed a pre-existing centre-only build-line test. Recipe to re-apply on `e1c4d58`. |
| C5 | harbour-ground | `abffedfd691ae88f9` | 2 | **REPORTED** | cothon dug: buried 51.1% -> 0.8%, freeboard 0.34 -> 2.00 m, +4,491 standable cells. Merchant basin blocked on one line in `harbour.ts`. |
| C6 | consolidate | `a24d76c32bae078d8` | 3 | RUNNING | re-apply lattice on `e1c4d58`, face-based build-line test, merchant basin, re-shoot before/after plates |

**Base moved to `e1c4d58` mid-flight** (water-datum landed). Second worktree
`/private/tmp/tc-cplan2` at `e1c4d58` carries the plates-enabled probe. Plates must be
re-shot there before the owner sees them: the `b7d8aaf` set shows 22 lagoon houses and a
cothon 1.46 m below the sea, all since fixed.

Manager's own measurement, not delegated: the 12 quarters share a bearing (all within +/-0.03 rad)
but have **12 different lattice phases** across a 34.9 x 22.45 m cell, so no local street runs from
one quarter into the next. That is why the plan reads as grid patches, not a city grid.

Manager holds: worktree setup, dev-server boot, `probe-carthage.mjs --plan` baseline, the
Punic-vs-Roman fork, and the final report.

## Stop log
(append `TaskStop` confirmations here)
