# `tools/judge` — the plan judge's instrument

Three files, deliberately separate, because the defendant, the arithmetic and the ruler should not
be editable in one commit.

| file | role |
|---|---|
| `dump-plan.mjs` | **the defendant.** Starts a dev server in a named checkout, loads `src/city/plan.html`, and returns the plan objects verbatim as JSON — landmarks, districts, ways, insula footprints, the circuit, the river LUT, the wall line. It makes no judgement. |
| `control.mjs` | **the ruler.** Plate-digitised control points with a `how` and an error bar per row, plus published dimensions. Nothing in it is read from `src/`. |
| `grade.mjs` | **the arithmetic.** Compares one against the other. Re-derives the projection from its published closed form rather than importing it, and writes its own polygon clipping rather than calling the repo's. |
| `crop.mjs`, `crop2.mjs` | how the control rows were read: crop the georeferenced Lanciani raster at a survey position and draw a survey-metre grid on it. `crop2` is the one to use — it draws the grid, and a reading with no grid on it is an impression. |
| `digitise-river.mjs` | **a committed failure.** Colour-threshold segmentation of Lanciani's channel. Median run width 0. Kept so nobody spends the afternoon again. |
| `baselines/` | the graded output of each pass, so pass *n+1* diffs against pass *n* instead of being re-argued. |

## Running it

```sh
# the plan, out of a checkout you control. Never port 5173.
node tools/judge/dump-plan.mjs --root=/abs/path/to/checkout --port=5943 --out=/tmp/judge/plan.json
node tools/judge/grade.mjs --in=/tmp/judge/plan.json --json=/tmp/judge/grade.json
```

`dump-plan.mjs` kills its own server. If it is interrupted, check `pgrep -f 'vite --port 594'` and
attribute by `lsof -a -p <pid> -d cwd` before killing anything — other agents run vite on this box.

`reference/` is gitignored and does not exist in a worktree. Symlink it in:
`ln -s /path/to/main/checkout/reference reference`.

## The rubric and the grades

`docs/ROME-PLAN-RUBRIC.md` and `docs/ROME-PLAN-GRADE.md`.
