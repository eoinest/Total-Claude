# The browser budget

> **This is half the story.** The cap here counts browsers, which prices CPU, and on 23 August
> 2026 it was established that the contended resource on this machine is the **GPU**: one agent
> browser rendering the field battle used 24 % of the CPU and 85 % of the GPU, and the owner
> reported lag twice while this cap read *within budget*. `docs/tech/RESOURCE-BUDGET.md` is the
> other half — an owner-state ladder, a measured GPU ceiling, a throttle that reaches work
> already running, and the reclamation that took this machine from 118 worktrees to 59.

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

## The process supervisor: owning what we start

The orphan fix above solved it **for Vite**, because the runner is our code and could be taught to
watch its parent. It could not generalise: the next orphan was a scratch script, and there are three
hundred entry points nobody is going to edit one at a time.

**23 Aug 2026.** An agent ran `tools/scratch/net-flake-load.mjs --runs=6` to reproduce a gate flake
under load, and was stopped. The loop had been **reparented to init** and went on launching
browsers. It survived **two** `pkill` sweeps and was found only by walking parents up from a live
browser. That is the second child in this repository to outlive the thing that started it, so it is
a pattern and the fix is for the class.

### Four mechanisms, no daemon

A supervisor daemon is the obvious shape and it is the wrong one: it becomes the single process
whose death leaks everything. The semaphore above had already demonstrated the better pattern —
**state on disk, liveness re-derived on every read, never trusted** — so the supervisor is four
independent mechanisms, any three of which can fail without leaking *and* without wedging.

1. **The group, plus the descendant closure.** `spawnOwned()` runs every job under
   `tools/lib/spawn-guard.mjs` with `detached: true`, so the guard is a process-group leader and
   the real command runs inside its group. `detached: true` **without** a group kill is exactly
   what happened on 23 Aug.
2. **The guard's anchor watch.** The guard polls the PIDs whose lives the job requires — the
   spawning process, and the **agent session** — and takes the tree down when the *first* of them
   is gone. The agent anchor is the one that matters: on 23 Aug the spawning shell had exited
   hours earlier, so watching the parent alone would have watched a PID that was already dead.
3. **The registry, and `reapOwned()`.** Every job writes a file naming the group, the anchors, the
   owner and the boot generation. `reapOwned()` re-derives liveness and kills the trees whose
   owners are gone, and it is called from `acquireSlot` — so **every browser launch on this
   machine, by any agent, sweeps first.** The window on a leak is "until anybody next starts a
   browser", not "until somebody remembers".
4. **The agent anchor inside the harness itself,** for the case none of the three above can reach:
   a tool the agent runs *directly*. `node tools/probe-x.mjs` has no guard — it is a child of the
   agent's shell — and on 23 Aug that shell had exited hours before, so the harness was reparented
   to init, went on heartbeating its slot, and looked perfectly healthy to every liveness test the
   semaphore had. **It was healthy. It was just not owned.** So `acquireSlot` starts a two-second
   `kill(agentPid, 0)` watch in the harness: when the agent goes, the harness kills its browser by
   group and exits, which releases the slot, restores QoS and takes down its Vite. The slot record
   carries `agentPid` too, so a *fourth* staleness reason — `no-agent` — lets any other process on
   the machine reach the same verdict about a harness that has stopped cooperating.

Fail each in turn. Guard SIGKILLed → the reaper finds the entry and kills the tree. Registry
unwritable → the guard still kills on anchor death. Harness wedged past its own watch → the slot
goes `no-agent` and any reaper kills the browser PID it recorded. All of them → the group id is
inherited by everything in it and one `browsers.mjs sweep --force` finishes it, with `machine` able
to say whose it was.
Machine rebooted → every entry's boot generation is wrong, so every entry is dropped **without
signalling any PID in it**, because those numbers now belong to strangers.

### A process group is not enough, and that was measured

Playwright launches the browser with `detached: true` too, so the browser sits in a **process group
of its own** while remaining our grandchild:

```
this node: pid 75124 pgid 75122
  pid 75520 pgid 75520 ppid 75124   (browser)          <- its own group, our child
  pid 75521 pgid 75520 ppid 75520   --type=gpu-process
  pid 75670 pgid 75520 ppid 75520   --type=renderer
```

`kill(-75122)` reaches the harness and **not one of the four browser processes**. The first version
of the load-bearing test passed anyway — because Playwright installs its own SIGTERM handler and
closed them politely. Under SIGKILL, which is the shape a stopped agent actually has, nothing would
have. So everything here signals the **descendant closure** and not the group: `treeMembers()` walks
`ppid` as well as `pgid`, and the snapshot is taken *before* the first signal, because the instant
the parent dies the browser is reparented to init and the link is gone.

Reparenting does not defeat it: `pgid` is inherited and does **not** change when a process is
reparented, so a loop whose shell has died is still findable by group.

### Which unit the ceiling is in

**Both, and they answer different questions.**

**Browsers is the admission unit**, because admission is decided before anything is spent and the
thing being decided is one `launch()`. You cannot grant three-fifths of a browser.

**Processes is the audit unit and the backstop**, because it is the number read off `ps`, and
because it catches three things a slot count provably cannot: a browser that took no slot; a tool
that takes **one** slot and opens twenty pages, each a renderer; and a spawned tree that is not a
browser at all — the 23 Aug loop, which held no slot at any moment a sweep looked at it.

The number per unit is **measured**, `tools/scratch/procs-per-browser.mjs`, chrome-headless-shell
under Playwright 1.62:

| state | chromium | vite + guard | total |
|---|---|---|---|
| browser, no page | 3 (browser + gpu-process + utility) | 0 | 3 |
| browser + Vite + one real page | 4 (+ 1 renderer) | 2 | **6** |
| each additional page | +1 renderer | — | +1 |

**One unit of gate work is six OS processes.** The older "six or seven" was full Chromium, which
carries network and audio services this repository never launches. The guard is this file's own
overhead and it is **counted, not exempted**: a budget that left its own cost out of the number it
reports would be lying in the direction that flatters it.

The ceiling is `cap x (6 + 3)` — the measured six plus three renderers of headroom, so that a
legitimately multi-page tool such as `qa-net` is not refused for being multi-page. That is **36
away, 18 present, 9 playing**. `TC_MAX_PROCS` overrides; `TC_PROC_BUDGET=off` disables it loudly.

### Whose is it?

The port-5901 incident was an agent killing a sibling's dev server, having written afterwards that
one `lsof -a -p <pid> -d cwd` would have told it. Ownership was inferable and not recorded. It is
recorded now — agent session id, agent PID, worktree, branch, port, label, argv, start time, boot
generation — and `attribute()` still infers it for anything started outside this.

Four sources of evidence, best first, and the answer says **which one it used**, because "recorded"
and "inferred" justify different actions:

1. a **registry entry** whose group contains the PID;
2. a **live budget slot** whose `pid`, `vitePid` or `browserPid` is the PID;
3. the **parent chain**, walked up to a `claude` — what had to be done by hand on 23 Aug;
4. **`lsof -d cwd`** — the worktree it is standing in. Weakest, and never nothing.

A sweep may refuse to kill either kind, and only kills on the strength of the first two.
`browsers.mjs sweep` gives three verdicts — mine, a *live* sibling's (**refused**, and named), and
unowned — and `--include-others` is the override a human recovering a wedged machine needs, which
prints whose each one is before it acts.

### Proof, hardest case first

`node tools/qa-supervisor.mjs` — **47 assertions, 10 cases**, and it runs the destructive path for
real. Measured on this tree:

```
1. detached child launching browsers, parent SIGKILLed
     child tree gone, browser gone, 2,288 ms after the kill (guard polls every 2,000)
2. THE CONTROL - the same fixture spawned the 23 Aug way
     5 processes and 1 browser outlived a SIGKILLed parent, exactly as on 23 Aug
3. the loop SIGKILLed instead, so Playwright's own handler never runs
     the browsers it orphaned were swept anyway, 401 ms later
4. a sibling's process
     named from the registry - branch and port, not just a pid - and refused
     killTree refused a recycled group: "nothing in it looks like vite-runner.mjs"
5. a stale entry, owner killed, tree still up      reaped, tree killed
6. an entry from a previous boot                   dropped, and NOTHING signalled
7. the ceiling with no room                        refused with a reason in 6.5 s, not hung
8. the guard AND its owner SIGKILLed                a reaper in another process finished it
9. a harness the agent ran DIRECTLY, agent killed
     harness ended itself and its browser died, 1,603 ms after the agent went;
     its own parent stayed alive throughout - this is 23 Aug exactly
10. the test itself                                 left no detached anything behind
```

**Case 9 is the one that would have caught 23 Aug**, and case 1 is the one that would have caught
it a second time. On the day, the harness was *healthy*: alive, heartbeating, holding a valid slot.
Nothing in the semaphore was wrong; it was answering a different question. **Case 2 is why case 1
means anything.** A test that shows the fixed path working, without showing
the unfixed path failing, cannot tell "the fix works" from "the bug does not reproduce here" — and
this bug's entire history is that it did not reproduce when anybody looked.

Two faults the test found in the thing it was testing. `spawnOwned` unlinked its record whenever the
guard exited, which is right for a clean exit and wrong for the one case the file defends against —
a SIGKILLed guard — where it deleted the only record naming a live process group. And case 8 then
had to stop owning its own job, because `spawnOwned` installs an exit handler in the owner: killing
only the guard was measuring the *owner* tidying up and crediting the reaper with it.

---

## Observability

```
node tools/browsers.mjs             who holds what, for how long, on which port, in which tree
node tools/browsers.mjs --json      the same, machine-readable
node tools/browsers.mjs procs       how many OS processes, against the ceiling, and whose
node tools/browsers.mjs machine     everything: GPU, owner, memory, processes, owners, disk
node tools/browsers.mjs reap        drop lock records whose holder is provably gone
node tools/browsers.mjs sweep       every dev server nobody owns, and whose the rest are
node tools/browsers.mjs sweep --force   …and kill the ones no live sibling owns
node tools/browsers.mjs sweep --force --include-others   …a sibling's too, named first
node tools/browsers.mjs cap [n]     read or set the machine-wide cap
```

**One unit of gate work is six OS processes**, measured — four `chrome-headless-shell`, one Vite,
one guard. `ps | grep -c chrome-headless-shell` returning 136 is not 136 browsers. Both counts are
printed, because each is authoritative for a different thing: browsers for admission, processes for
audit. See *Which unit the ceiling is in* above.

`status`, `procs` and `machine` all call `reapStale()`, so they are not quite read-only: a record
whose holder is dead is dropped and the group it names is taken down. That is the design — the
sweep is paid for by whoever next looks, rather than by a daemon that can itself die.

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

**The third rule: `detached: true`.** The check caught a new `chromium.launch()` and had nothing to
say about `spawn('node', ['tools/scratch/net-flake-load.mjs'], { detached: true })`, which is the
line the 23 Aug orphan went through. You cannot see lexically whether a spawned script opens a
browser — but you can see the shape that makes it survive its parent, and both orphans this
repository has had wrote it. `detached: true` anywhere in `tools/` now fails, with `spawnOwned()`
printed as the fix.

It is deliberately **not** on the ratcheted allowlist and never joins it. That list is a to-do list
of 91 pre-existing direct launches whose whole discipline is that it may only shrink; letting a new
rule add a batch of entries would spend the discipline to buy nothing. The six legitimate uses are
named in `DETACHED_OK` inside the check, **with a reason each**, which is a thing a JSON array of
ninety-one paths cannot be. A file already forgiven for `chromium.launch()` is not thereby forgiven
for detaching a child — verified by appending the line to an allowlisted file and watching it fail.

**What it cannot catch:** an indirect launch through a variable or a helper; computed `spawn`
arguments; `detached` read from a variable or spread in from an options object built elsewhere; a
long-running child spawned *without* `detached`, which shares its caller's group and dies with it;
anything outside `tools/` (`src/audio/audio-selftest.mjs` and `src/city/shoot-city.mjs` both spawn
`npx vite` and are not scanned); and a tool that takes one slot and then opens ten browser
*contexts* inside it. The budget counts `launch()`, not contexts, deliberately — a context is cheap
and a browser is not.

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
- `tools/lib/process-registry.mjs` — `spawnOwned`, `reapOwned`, `killTree`, `attribute`, the census
- `tools/lib/spawn-guard.mjs` — the nanny that outlives nothing
- `tools/lib/liveness.mjs` — boot generation, `kill(pid, 0)`, heartbeat: one verdict, two callers
- `tools/browsers.mjs` — status, procs, machine, reap, sweep, cap
- `tools/qa-supervisor.mjs` — 42 assertions that it kills, before any that it permits
- `tools/check-browser-budget.mjs` — the ratchet, and the un-ratcheted `detached: true` rule
- `tools/scratch/bb-bench.mjs` — the measurement above
- `tools/scratch/bb-proof.mjs` — the demonstration
- `docs/tech/TOOLING.md` — the shape of every harness here
- `docs/HANDOFF.md` — how many agents an orchestrator should run at once
