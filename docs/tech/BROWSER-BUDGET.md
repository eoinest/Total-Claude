# The browser budget

How many headless browsers may run on this machine at once, what enforces it, and the
measurement the number comes from.

---

## What happened

On **22 August 2026** this machine reached **load average 160 on 16 cores with 136 concurrent
`vite` and `chrome-headless-shell` processes** and had to be recovered by hand. Earlier the
same morning **nineteen orphaned dev servers** were swept off it, several more than a day old,
belonging to worktrees whose agent sessions had ended.

Neither was one bad tool. Both are structural, and the structure is the thing this project is
otherwise proud of: every agent works in its own git worktree, and every worktree starts its
own Vite server and its own Playwright Chromium. A survey of the tree found **303 runnable
entry points that open a browser** — 106 in `tools/`, 172 in `tools/scratch/`, and 23 more
reaching one through `tools/scratch/pl-lib-emc.mjs` — and **92 files that spawn `npx vite`**.
None of them knew any of the others existed. Twelve agents each behaving impeccably is twelve
browsers, and twelve browsers is about three times this machine.

There was a convention — *use ports in the 5900s, never 5173* — written in `docs/HANDOFF.md`.
Nothing enforced it. Two agents landed on 5901 and one killed the other's dev server.

---

## The measurement

`tools/scratch/bb-bench.mjs`. Each job is the shape of a real gate run: its own Vite server on
its own port with its own `TC_VITE_CACHE_DIR`, its own Chromium, the field battle booted
through the real menu (8,632 men, `tier=high`), then simulation advanced. Jobs are long enough
— about 80 s — for the one-minute load average to converge, which the first attempt was not:
23-second jobs reported a peak load of 5.9 for a single browser against a 5.4 baseline, not
because one browser costs half a core but because the average had barely begun to move.

Two arms, because they load different parts of the machine. The **CPU arm** advances with
`fastForward` (`render: false`) — what `qa-determinism` and `qa-replay` cost. The **GPU arm**
advances and screenshots in a loop — what `shoot.mjs`, `film.mjs` and every plate-taking probe
cost, contending for one GPU rather than for sixteen cores.

Machine: Apple M4 Max, 16 cores, 128 GiB. Baseline during the sweep was one other agent's
browser and about 2 cores of background, recorded rather than eliminated — the machine is
never idle and a cap measured on an idle machine would be the wrong cap.

### CPU arm — `--seconds=1200`

| N | wall s | median job s | jobs/min | efficiency vs N=1 | settled load | load / core | peak RSS |
|---|---|---|---|---|---|---|---|
| 1 | 77.6 | 77.5 | 0.77 | 1.00 | 7.4 | 0.46 | 7.0 GiB |
| 2 | 77.1 | 77.0 | 1.56 | 1.01 | 6.9 | 0.43 | 9.4 GiB |
| 3 | 79.0 | 78.7 | 2.28 | 0.99 | 7.8 | 0.49 | 9.8 GiB |
| 4 | 79.7 | 78.1 | 3.01 | **0.98** | 7.1 | **0.45** | 8.9 GiB |
| 6 | 84.1 | 82.9 | 4.28 | 0.93 | 10.8 | 0.67 | 13.2 GiB |
| 8 | 89.4 | 88.3 | 5.37 | 0.87 | 17.4 | **1.09** | 17.7 GiB |

**Throughput is not the binding constraint. Load is.** Scaling is still 87% efficient at N=8 —
this workload is not purely CPU-bound, and true CPU utilisation at N=8 measured about 11 of 16
cores. What breaks is the load average, and it breaks suddenly: 0.45× cores at N=4, 0.67× at
N=6, and **1.09× at N=8**, which is an oversubscribed machine. Between N=6 and N=8 the
run queue starts holding work that has nowhere to go, and that is the state that ran away to
160 on 22 August.

### GPU arm — `--seconds=600 --shots=40`

Advance, screenshot, repeat — what `shoot.mjs`, `film.mjs` and every plate-taking probe do.

| N | wall s | median job s | jobs/min | efficiency vs N=1 | settled load | load / core | peak RSS |
|---|---|---|---|---|---|---|---|
| 1 | 41.6 | 41.5 | 1.44 | 1.00 | 4.8 | 0.30 | 2.1 GiB |
| 4 | 45.2 | 45.2 | 5.30 | **0.92** | 7.7 | **0.48** | 8.7 GiB |
| 8 | 53.9 | 52.6 | 8.91 | 0.77 | 11.6 | 0.73 | 17.3 GiB |

The caveat was right in direction and wrong in size. Rendering **does** scale worse — 0.77
efficiency at N=8 against the CPU arm's 0.87, so a fifth of the added concurrency is spent
contending rather than working — but it does not oversubscribe the machine the way the CPU arm
does, because a screenshot is mostly JPEG encode and readback rather than sustained GPU load.

**Both arms agree at N=4**: 0.45–0.48× cores, 92–98% of perfect linear scaling. That agreement
is why the number is 4 and not a compromise between two different numbers.

### A warning about the load average on this machine

The one-minute load average here reads roughly **1.2–1.4× the true CPU utilisation**, and at
idle it is wildly high: measured 1.8 cores genuinely in use at a load average of 5.96. Anything
that reasons from `uptime` alone on this box will conclude the machine is three times busier
than it is. `node tools/browsers.mjs` prints both, and the honest one is the second:

```
16 cores; load 5.96 / 7.19 / 6.90; 1.8 cores actually in use right now
```

It is computed by summing the CPU-time delta **per PID over processes present in both of two
samples**, two seconds apart. Summing the machine total and subtracting is the obvious version
and it is wrong: a browser that exits during the window takes its accumulated CPU time out of
the total and the tool reports minus eighty-four cores. That is a real reading from the first
draft of it.

---

## The cap: 4

**`TC_MAX_BROWSERS`, default 4.**

Four, and not six or eight, for four reasons in descending order of weight:

1. **N=8 leaves the safe band outright** — 1.09× cores of load. N=6 is 0.67×, which is
   defensible on an otherwise-idle machine and is *not* what this machine is.
2. **Four costs almost nothing.** 98% of perfect linear scaling. The whole gain from 4 to 6 is
   42% more throughput in exchange for going from 45% to 67% of the machine, and the gain from
   6 to 8 buys 25% more throughput for an oversubscribed box.
3. **The bench measures browsers and nothing else.** The real machine also runs a dozen agent
   `node` processes, the owner's own dev server on 5173, and his editor. Half the machine left
   over at N=4 is the room for those, and it is the difference between an agent noticing the
   fan and the owner losing his playtest.
4. **The failure modes are asymmetric.** Too low costs wall-clock, visibly, in a queue that
   says what it is waiting for. Too high cost a machine reboot and an afternoon.

The number is deliberately overridable and deliberately loud about it:

```
TC_MAX_BROWSERS=6 node tools/qa-determinism.mjs   # this run only
node tools/browsers.mjs cap 6                     # machine-wide, every agent, until changed
```

**What would change my mind.** An orchestrator convention that reliably keeps the rest of the
machine quiet — no owner playtest, no dozen idling agents — would justify **6**, which both
arms show is still inside the band (0.67× and 0.73× cores). A sustained queue in
`node tools/browsers.mjs` with the machine measuring under 8 cores in use would say the same
thing: the cap is costing wall-clock it does not need to.

Going the other way: this is **one browser per four cores**, and on any machine smaller than
this one 4 is too many. It should be `max(2, floor(cores / 4))`. It is not computed from
`os.cpus()` automatically, deliberately — a cap that changes silently with the hardware is a
cap nobody can reason about across two machines, and this project has been bitten by
instruments that quietly reconfigured themselves.

---

## The design

Every agent is a separate `node` process with no shared memory, so the cap lives on the
filesystem: `/tmp/tc-browser-budget/` (override with `TC_BUDGET_DIR`).

```
/tmp/tc-browser-budget/
  cap              machine-wide default, written by `browsers.mjs cap <n>`
  slots/00.json    one file per held slot — the lock IS the file's existence
  waiting/*.json   one file per queued caller, named so they sort into a FIFO
  tmp/             scratch for the atomic create
```

**Acquisition is `link()`, not `open(…, 'wx')`.** Both are atomic, but `open` leaves a window
in which the file exists and is empty, and a reader landing in that window sees an unreadable
record and calls it stale — a reaper deleting a lock somebody is in the middle of taking.
Writing the record to a scratch file and hard-linking it into place has no such window.

**Liveness has three independent tests, and any one of them frees the slot.** This is the
property the crash makes non-negotiable: every lock held at load 160 would otherwise still be
held, and the first thing a naive cap would do after the reboot is refuse every launch forever.

| test | detects | latency |
|---|---|---|
| `bootId` mismatch (`sysctl kern.boottime`) | the machine rebooted; the holder cannot exist | instant, certain |
| `kill(pid, 0)` → `ESRCH` | the holder is gone — SIGKILL, crash, anything | instant |
| heartbeat mtime older than `TC_BROWSER_STALE_MS` (90 s) | the holder is alive and wedged | ≤ 90 s |

A PID alone is not an identity across a reboot: pid 4711 from before the crash will match some
unrelated process afterwards and `kill(4711, 0)` will say "alive". The boot generation is what
makes that unambiguous.

**Release checks a token before unlinking.** If a slot was reaped while its holder was wedged
and handed to somebody else, deleting it on the way out would over-subscribe the machine by
one — the exact bug the file exists to prevent, reintroduced by its own cleanup.

**Waiting is a FIFO with a stated timeout.** Callers register a ticket, only the front of the
queue may take a free slot, and the wait fails after `TC_BROWSER_WAIT_MS` (30 min) with the
holders named. It prints who holds what every 30 seconds while it waits, and it detects the
self-block case — every slot held by the *same* PID — and says so, because that one looks
exactly like a deadlock and is not.

---

## The orphan fix

`spawn('npx', ['vite', …])` was in 92 files. **`server` is npx, not Vite.** `npx` execs a shell
which execs `node …/vite.js`, so `server.kill('SIGTERM')` signals a wrapper two processes above
the one holding the port. You can watch it on this machine: `ps` shows the pair, `npm exec vite
--port 5934` and `node …/.bin/vite --port 5934`, every time.

`tools/lib/vite-runner.mjs` replaces it. It is Vite in-process via `createServer`, so the PID
the parent holds *is* the PID holding the port, and it is spawned with `node` directly and in
its own process group. It also **polls its parent every two seconds** and exits when
`kill(parentPid, 0)` throws `ESRCH`. macOS has no `PR_SET_PDEATHSIG`; polling is the portable
way to get "die with my parent", and two seconds is a bounded orphan lifetime instead of an
unbounded one. That is the part that survives a SIGKILL, which no exit hook does.

Proved, and the proof is the SIGKILL case rather than the polite one:

```
server up, vite pid 52074 harness pid 52072
node    52074 ... TCP 127.0.0.1:5933 (LISTEN)          <- the handle IS the server
SIGKILL the harness (52072) - no exit hook, no finally, nothing runs
after 4s, listening on 5933:
RESULT: port free, vite pid 52074 self-terminated
```

It also serves **`/__tc/tree`**, stating which root it is serving. `startVite` asks before
reusing any listener and refuses one serving a different worktree. That closes a hole nobody
had a name for: `qa-determinism` reuses whatever is on its port and would confidently measure
another agent's branch, with a headcount that happens to differ as the only tell.

---

## Observability

```
node tools/browsers.mjs             who holds what, for how long, on which port, in which tree
node tools/browsers.mjs --json      the same, machine-readable
node tools/browsers.mjs reap        drop lock records whose holder is provably gone
node tools/browsers.mjs sweep       list dev servers no live slot claims
node tools/browsers.mjs sweep --force   …and kill them (never 5173, never an unattributable one)
node tools/browsers.mjs cap [n]     read or set the machine-wide cap
```

**One headless Chromium is six or seven OS processes** — a browser process, a GPU process, a
couple of utility processes and a renderer per page. `ps | grep -c chrome-headless-shell`
returning 136 is not 136 browsers; it is roughly twenty. `status` prints both, because the cap
counts browsers and `ps` counts processes and confusing the two is how somebody concludes the
cap is not working.

It also flags, each for a specific past failure:

- **browsers running that hold no slot** — an unconverted tool, or `TC_BROWSER_BUDGET=off`;
- **Vite servers started through npx** — the orphan mechanism, still live somewhere;
- **GPU processes on `--use-angle=swiftshader`** rather than Metal;
- **holders that disagree about the cap** — somebody has `TC_MAX_BROWSERS` in their shell.

That SwiftShader check reads the *value* of `--use-angle` and nothing else. Its first version
grepped the command line for `swiftshader` and reported every healthy Metal-backed browser on
the machine as software-rasterising, because `--enable-unsafe-swiftshader` is on that command
line too — and that flag is a permission to fall back, not a statement that anything did.

---

## Enforcement

`node tools/check-browser-budget.mjs`, wired into `npm run lint` (which is now **3 checks, not
2**). It fails on any file in `tools/` that calls `chromium.launch` or spawns `npx vite`
directly and is not on `tools/browser-budget-allow.json`.

It is a **ratchet, not a wall**: 254 files were already doing it directly when the budget
landed — 91 in `tools/` and 163 under `tools/scratch/` — most of them one-off scratch scripts. The allowlist is a to-do list with a number on
it. It may shrink — `--prune` after converting one — and it must not grow. A *new* tool that
launches directly fails, with the one-line fix printed.

Scope is `tools/` excluding `tools/scratch/`, the same as `tools/check-tool-args.mjs` and for
the same reason: scratch is where a five-minute measurement gets written and deleted the same
day, and a lint that blocks that is a lint people route around. `--all` includes it and prints
the real total. Scratch scripts are still counted by `browsers.mjs`, which sees browsers with
no slot however they started.

**What it cannot catch:** an indirect launch through a variable or a helper; computed `spawn`
arguments; anything outside `tools/` (`src/audio/audio-selftest.mjs` and
`src/city/shoot-city.mjs` both spawn `npx vite` and are not scanned); and a tool that takes one
slot and then opens ten browser *contexts* inside it. The budget counts `launch()`, not
contexts, deliberately — a context is cheap and a browser is not.

---

## Proof that it blocks and recovers

`node tools/scratch/bb-proof.mjs --cap=2 --n=5 --hold=25`. Three acts: five children against a
cap of two, so three queue; `browsers.mjs` printed verbatim while the queue is full; and then
one holder **SIGKILLed** — no exit hook, no `finally`, nothing runs — with the queue required
to advance anyway. That last act is the machine crash in miniature.

Measured, twice, on two different trees:

```
[21:53:20.431] child 0: GOT slot 0 after 0.2s
[21:53:20.843] child 1: GOT slot 1 after 0.2s
               children 2, 3, 4 queue — 3 waiting, FIFO, each named in browsers.mjs
[21:53:35.387] SIGKILL to pid 51827 (bb-proof-0, slot 0)
[21:53:35.816] child 2: GOT slot 0 after 14.8s     <- 0.43 s after the holder died
[21:53:39.418] child 3: GOT slot 1 after 18.0s
[21:53:54.762] child 4: GOT slot 0 after 32.9s
               all children done in 52.6s — three waves of 18 s, as predicted
               slots still held: 0
```

Two slots, five callers, three waves, FIFO order preserved across a holder that died without
running a line of cleanup, and nothing left behind.

---

## Related

- `tools/lib/browser-budget.mjs` — the cap, the launcher, the server starter
- `tools/lib/vite-runner.mjs` — the dev server that cannot outlive its parent
- `tools/browsers.mjs` — status, reap, sweep, cap
- `tools/check-browser-budget.mjs` — the ratchet
- `tools/scratch/bb-bench.mjs` — the measurement above
- `tools/scratch/bb-proof.mjs` — the demonstration
- `docs/tech/TOOLING.md` — the shape of every harness here
- `docs/HANDOFF.md` — how many agents an orchestrator should run at once
