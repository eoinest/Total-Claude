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
