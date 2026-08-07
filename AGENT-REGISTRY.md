# Carthage map plan — child agent registry

Manager worktree: `/private/tmp/tc-cmap2`, branch `e/city/carthage-plan`, based on `965e12b`.
Concurrency cap: **3**. Every child must be stopped before the manager reports.
Own port: **5199** (5173 is the owner's playtest server — never touched).

## Wave 0 — salvage from the predecessor (manager, no children)

| item | from | status |
|---|---|---|
| `tools/probe-carthage.mjs` +1111 lines, `--plates` mode | `tc-cplan2` @ `e1c4d58` | committed `0c41eb6`, base byte-identical to main |
| `src/maps/carthage/heightfield.ts` +343, the basin cut | `tc-cplan2` @ `e1c4d58` | committed `0c41eb6`, base byte-identical to main |
| `tools/scratch/*.mjs` 12 measuring tools | `tc-cplan2` | committed `0c41eb6` |
| `src/city/carthage/fabric.ts` +70, the one-city lattice | `tc-cplan` @ `b7d8aaf` | rebased onto main by `git apply --3way`; one conflict (`let drowned = 0`, the water-datum fix) resolved by keeping both |
| six rendered plates | `tc-cplan` | kept as `plans/stale-b7d8aaf/` for reference only — they show 22 lagoon houses and a drowned cothon, both since fixed. **Not shown to the owner.** |

## Children

| # | name | id | wave | status | scope |
|---|---|---|---|---|---|
| D1 | verify-build | `aa3374a5e2505ffbe` | 1 | RUNNING | typecheck, boot `?map=carthage`, `window.__game.ready`, probe checks |
| D2 | merchant-basin | `aa6f2d01a6ed7eeae` | 1 | RUNNING | the one line in `harbour.ts` that blocks the merchant basin's excavation |
| D3 | | | 2 | | |

## Stop log
(append `TaskStop` confirmations here)
