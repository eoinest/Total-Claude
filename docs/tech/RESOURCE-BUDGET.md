# The resource budget: the GPU, the owner, and giving the machine back

`docs/tech/BROWSER-BUDGET.md` is the account of the count-based cap that landed on 22 August
2026. This is the account of what that cap could not express, and of the reclamation that
nothing had ever done.

Read that one first. This one assumes it.

---

## 1. The cap held and the owner still lagged

The browser budget caps this machine at four concurrent headless Chromiums, across independent
agent processes, on the filesystem. It works. `node tools/browsers.mjs` has printed *within
budget* every time it has been asked since.

The owner has reported the machine lagging **twice** since it landed, and both times
`browsers.mjs` was inside its cap and the CPU looked half idle. Measured on 23 August with
**one** agent browser rendering the field battle:

```
load average    6.25 on 16 cores      ← 39%, "idle"
Device Utilization %   62, 94, 100, 26, 46, 99
```

And from `node tools/browsers.mjs machine`, captured live during the work:

```
gpu          85% mean, p90 92%, max 92%  [####################....]
cpu          3.8 of 16 cores            [######..................]
browsers     1 slot(s) held of 4
```

**One browser. 24% of the CPU. 85% of the GPU.**

There is one GPU on an M4 Max, and every headless Chromium in this repository runs
`--use-angle=metal` on purpose — the SwiftShader fallback turns a seconds-long boot into four
to six minutes. So every agent browser queues its draw calls on exactly the silicon the owner's
game draws on. A count of browsers prices CPU; CPU was never the contended resource. Four
browsers is not four-sixteenths of this machine, it is most of the GPU, and no number of slots
can say so.

---

## 2. Measuring the GPU without root

`powermetrics` gives good GPU numbers and needs `sudo`, so it is not used: an admission check
that prompts for a password is one that gets disabled within the day.

The Apple GPU driver publishes its own counters where anybody can read them:

```
$ ioreg -r -d 1 -w 0 -c IOAccelerator | grep -o '"Device Utilization %"=[0-9]*'
"Device Utilization %"=77
```

`AGXAcceleratorG16X` exposes `Device Utilization %`, `Renderer Utilization %`,
`Tiler Utilization %` and its memory footprint in `PerformanceStatistics`.

**These are instantaneous, not cumulative, and they are very noisy.** Six consecutive reads a
second apart on an "idle" machine with one browser rendering:

```
62, 94, 100, 26, 46, 99
```

A single sample is worthless. `gpuUtilisation()` in `tools/lib/machine-load.mjs` averages eight
reads 120 ms apart and reports mean, p90 and max, because they answer different questions:
`mean` is how much of the GPU is gone, `max` is whether anything got all of it, and **p90 is the
one that predicts the owner's experience** — a game that misses one frame in ten feels broken
while its average frame time looks fine.

Everything else in that file is the same shape: readable without privileges, or not used.

| reading | source | how it lies |
|---|---|---|
| GPU utilisation | `ioreg -c IOAccelerator` | instantaneous and noisy; never read one sample |
| cores in use | two `ps` samples, per-PID deltas | a process exiting mid-window is not counted |
| memory pressure | `memory_pressure`, `vm_stat` | free percentage lags a sudden allocation |
| screen locked | `CGSSessionScreenIsLocked` | no false positives at all |
| owner at the keyboard | `IOHIDSystem.HIDIdleTime` | says *input*, not attention |
| owner in a browser | `lsappinfo front` | the game may be in a non-frontmost window |

---

## 3. Owner-present mode: three signals, and how each is wrong

Automatic detection, with an explicit flag that beats it.

**`CGSSessionScreenIsLocked`** is a fact, not an inference. A locked screen means nobody is
looking at this machine, and it fires the instant he walks away where an idle timer needs its
full window to agree. It has no false positives. It is checked first.

*The key is absent when the screen is unlocked* — not `=No`, simply not in the dictionary. The
first version of `screenLocked()` matched `(Yes|No)` and returned `null`, "unreadable", for the
entire unlocked case: **the strongest signal here was silently unavailable exactly when somebody
was at the machine**, and `node tools/browsers.mjs owner` printed `screen locked  unreadable`
while its owner was typing into the next window. It was caught by reading that output, not by
any test, which is the argument for printing each signal separately rather than only the
conclusion.

**`IOHIDSystem.HIDIdleTime`** is nanoseconds since the last key, click or trackpad event,
maintained by the window server, needing no entitlement and no accessibility permission. Three
reads two seconds apart gave 307.7 s, 309.8 s, 311.9 s — it is real-time and it is exact.

Its error is one-sided and it matters: **it says input, not attention.** Reading a diff,
watching a replay and being out of the building are indistinguishable to it. That error
under-reports presence, which is the dangerous direction, so the window is a generous three
minutes (`TC_OWNER_IDLE_MS`).

It cannot be spoofed upward by anything here. Headless Chromium synthesises input inside its own
renderer and never touches the HID stack, so **no agent can make itself look like a person**.
That asymmetry is the reason to trust it at all.

**`lsappinfo front`** names the frontmost application. Present + a browser frontmost is read as
*playing*. This is the weakest of the three: he may have the game in a window that is not
frontmost while he reads something else, and this will call that `present` rather than
`playing`. The cost of that error is a cap of 2 instead of 1.

### Three states, because they want different things

| state | detected by | what he needs | cap | GPU ceiling | running work |
|---|---|---|---|---|---|
| `away` | screen locked, or idle > 180 s | nothing | 4 | 92% | normal priority |
| `present` | recent input, terminal or editor frontmost | a responsive terminal — a CPU and memory ask | 2 | 70% | normal priority |
| `playing` | recent input, a browser frontmost | the GPU | 1 | 45% | **demoted** |

### The flag, and why it exists

```
node tools/browsers.mjs owner playing      # tell it
node tools/browsers.mjs owner auto         # go back to guessing
TC_OWNER=away <command>                    # for one run
```

Detection is a guess. His own statement is not. The flag is written to
`/tmp/tc-browser-budget/owner`, where **every agent on the machine reads it**, rather than into
one shell — and running holders pick it up on their next heartbeat, within ten seconds.

---

## 4. The two levers, and why one of them was not enough

### Admission control, at `acquireSlot`

A free slot is now necessary and not sufficient. `admit()` applies the ladder above and refuses
while measured GPU utilisation is over the ceiling for the current state. Both refusals queue
exactly as a full slot table does, and the wait message names which one it hit — "waiting for a
slot" while three slots stand empty is the most confusing thing this change could print.

The GPU test is deliberately **not** applied when nothing holds a slot. A machine whose GPU is
busy for reasons that are nothing to do with agents — him playing, a video call — would
otherwise refuse the *first* browser forever, and a budget that deadlocks on the owner's own
activity gets switched off. With zero holders the ladder alone applies, which still means one
browser while he plays and never more.

**What it costs.** Admission reads the machine once per process — six GPU samples and a 600 ms
CPU window, about **1.4 s** — then publishes it to `<budget dir>/machine.json` where every other
holder reads it for six seconds. Measured on the same process: first acquire 1460 ms, second
0 ms, third 0 ms. Without one shared observation, four holders heartbeating every ten seconds
would spend four seconds a minute measuring how busy the machine is, which is its own small
contribution to the problem. `TC_WORK_BUDGET=off` takes the acquire back to 6 ms and gives up
everything in this section.

### The throttle, on the heartbeat

**Admission control cannot help against a film that took its slot six minutes ago, and both of
his lag reports were exactly that shape.** So the heartbeat that every holder already sends
every ten seconds now also re-reads the owner state (about 50 ms) and reconciles QoS.

`taskpolicy -b -p <pid>` is Darwin's own throttling primitive, needs no privileges for a process
you own, and does four things at once:

1. moves the process to the **efficiency cores** — a hard ceiling of 4 rather than 16 here;
2. drops I/O priority to throttled;
3. moves timer coalescing to the background tier;
4. **de-prioritises its GPU submissions** — which is the lever the contention actually needs and
   the one no amount of `nice` would have given.

`-B` restores, and the release path and every exit hook restore unconditionally: a process left
in the background band outlives us.

---

## 5. Does the throttle work? The measurement

`tools/scratch/gpu-bench.mjs`. An "owner" browser rendering the battle and reading its own rAF
frame deltas, with an agent browser rendering behind it, alternating the agent between
foreground and background QoS.

**It is paired and interleaved, and the first version was not, and that is worth recording.**
The first design ran `solo`, then `contended`, then `throttled`, once each. It reported the
contended arm as **28% faster than solo**, which is not a thing contention can do. The
explanation is that other agents run gates on this machine while it measures, and a neighbouring
`qa-net` finished between the two reads. **Sequential arms on a shared machine measure the
neighbours.** The current design keeps the agent up throughout and alternates in short windows,
so anything drifting slower than one cycle cancels.

### The first run at 1280x800 found nothing, and that was the instrument

Four paired cycles, owner and agent both at 1280x800:

```
owner alone            120.0 fps before, 120.0 fps after
agents at foreground   119.1 fps  = 99% of alone
agents at background   120.0 fps  = 100% of alone
per-cycle gain: 1.00x  1.00x  1.00x  1.03x
```

Exactly 120.0 fps in every window, p95 9.5 ms. That is not the absence of contention, it is the
absence of **load**: headless Chromium is vsync-locked to the display's 120 Hz, and at 1.0
megapixel this scene finishes in 8 ms with room to spare. There was nothing for an agent to take.

He does not play at 1280x800. He plays full-screen on a Retina panel, four to eight times the
pixels, and the GPU cost of this scene is very nearly linear in them. **A bench whose owner arm
has 40% headroom cannot measure an effect that only appears when it has none**, and "no effect"
from it would have been the wrong answer stated confidently. The viewports are parameters now,
and the default owner arm is 2560x1600.

### The measurement, at a pixel load he would recognise

Owner 2560x1600, two agents at 1920x1080, four paired cycles of six seconds:

```
  cycle   agents           owner fps   p95 ms   hitches   gpu
      1   foreground           58.8     25.7       25%   100%
      1   background          112.2     16.0        0%    91%
      2   foreground           65.5     25.0       13%   100%
      2   background          120.0      9.8        0%    85%
      3   foreground           68.2     25.1       13%   100%
      3   background          120.0      9.9        0%    87%
      4   foreground           68.2     24.8        9%   100%
      4   background          120.0      9.9        0%    86%

owner alone (after, clean)   120.0 fps   p95  9.6 ms    0% hitches
agents at foreground          65.2 fps   p95 25.2 ms   15% hitches
agents at background         118.0 fps   p95 11.4 ms    0% hitches

per-cycle gain from demoting: 1.91x  1.83x  1.76x  1.76x   mean 1.81x
```

**Two agent browsers at normal priority cost the owner 46% of his frame rate and put a visible
hitch on one frame in seven. Demoted, they cost him 2%.**

The consistency check that makes this trustworthy is the last row against the reference:
118.0 fps with two agents demoted, against 120.0 fps with no agents at all. **With the throttle
on, two agents rendering are very nearly free.** The `82.7 fps` "before" reference is discarded
— the GPU read 100% during it, because a neighbouring agent's gate was running, which is exactly
the contamination the paired design exists to survive. The per-cycle gains are within 0.15x of
each other across four cycles, which a drifting machine does not produce.

### And the wiring is proved separately from the effect

The bench applies the demotion itself, with a direct `setQosTree`. That leaves the part that
matters in production untested: whether `launchBrowser` identifies its own browser, whether the
heartbeat notices, and whether release puts the process back. All three have been wrong once
already, and **a QoS demotion produces no error when it lands on the wrong process, or on
none**.

`node tools/qa-throttle.mjs` — 7 assertions against a real browser through the real
`launchBrowser` path. The observable is `ps -o pri`: the background band reads **4**.

```
1. launch with the owner away
   family of 4 process(es): 33532:46 33582:47 33583:47 33647:47
2. the owner sits down and starts playing
   after 9s:  33532:4 33582:4 33583:4 33647:4      ← the whole family, not just the parent
3. the owner leaves again
   after 10s: 33532:46 33582:47 33583:47 33647:47
4. demoted, then released
   after release: 33532:46 33582:47 33583:47 33647:47
```

Step 2's second assertion is the one worth having: **a renderer left at normal priority while
its parent is demoted is the process still competing for the GPU**, and it would look like a
working throttle that simply did not help much.

Step 4 is the one that costs somebody else if it is wrong. A process left in the background
band outlives us, and the next thing to inherit it gets a quarter of the machine with nothing
saying why.

### And the cap ladder bites

`acquireSlot` with a private budget directory, configured cap 4 throughout, five callers each
time:

```
owner=away      configured cap 4, actually granted 4
owner=present   configured cap 4, actually granted 2
owner=playing   configured cap 4, actually granted 1
```

Against the *shared* budget on the live machine, with one neighbouring agent already holding a
slot, `owner=playing` refused the request outright and `owner=present` granted one and refused
the second — the neighbour's slot counting against the ladder exactly as it should.



### What this measures, and what it does not

The "owner" browser is headless, like the agents. His real Chrome is a window compositing
through the window server at the display's refresh rate, and its absolute frame times are not
these. What the headless proxy measures exactly is **GPU throughput contention**, which is the
mechanism behind both lag reports. **The ratio is the claim; the milliseconds are not.**

A headed arm would be closer and was rejected: the screen is locked while this runs, and a
locked screen suspends compositing for windowed applications, so it would have measured the lock
screen.

### The bug the bench found in the thing it was benching

The first run reported the throttled arm at **6.5 fps against 88.7 solo** — the throttle making
the owner thirteen times worse. It was real, and it was not the throttle.

`browserPid()` identified a browser by scanning `ps` for the first `chrome-headless-shell` whose
parent is us. With one browser that is right. The bench runs an **owner** browser and an
**agent** browser from one process, so it returned the same PID twice, and the demotion landed
on the owner.

Playwright 1.62 exposes no PID for a locally launched browser — `browser.process()`,
`browser._process` and `browser._channel._connection._transport._process` are all `undefined`,
verified on this tree rather than assumed. The fix is a before-and-after diff of our own direct
children (`ourBrowserPids` / `newBrowserPid`), which returns `null` rather than guessing if the
diff is not exactly one PID.

**Any harness that opened a second browser would have hit this silently**, because a QoS
demotion produces no error. It is the reason the bench exists at all: an unmeasured throttle is
indistinguishable from a throttle pointed at the wrong process.

---

## 6. Reclamation

### What was on the machine, 23 August 2026

```
118 registered worktrees, 28 GB, 23 of them already gone
612 MB of /tmp/tc-* scratch, the largest 281 MB
1.0 GB of screenshots
a node process from /tmp alive 23 hours
```

Nothing had ever removed any of it. On 22 August nineteen orphaned dev servers were swept off
this box, several more than a day old.

### The rule, and why it is mostly refusals

A crash here once destroyed a day of unpushed work, and a branch survived only because its
worktree did. So the interesting content of `tools/reclaim.mjs` is the list of things that stop
a delete. Of the 117 non-primary worktrees:

| | |
|---:|---|
| 57 | clean, every commit pushed — candidates |
| 29 | dirty, every commit pushed — **protected**: uncommitted work |
| 5 | clean, commits on no remote — **protected**: 2 and 7 commits |
| 3 | dirty, commits on no remote — **protected twice**: one holds 16 |
| 23 | directory already gone — metadata only |

**A rule of "delete worktrees whose branch is merged" would have destroyed eight worktrees
carrying 43 commits that exist on no remote.** That is what this tool exists to not be.

A worktree is reclaimed **only if every one of these holds**. Any single failure protects it,
and the failure is named in the report.

1. It is **not** the primary checkout.
2. It is **not** locked.
3. `git status --porcelain` is **empty** — modified, staged and untracked-and-unignored all
   count. Ignored files (`node_modules`, caches) do not, and go with it.
4. `git rev-list --count HEAD --not --remotes` is **zero**. This is stronger than "merged" and
   it is the exact statement of *nothing here would be lost*.
5. HEAD is an **ancestor of `origin/main`**. `--any-pushed` relaxes this to rule 4 alone.
6. **No operation in progress**: no `MERGE_HEAD`, `REBASE_HEAD`, `CHERRY_PICK_HEAD`,
   `REVERT_HEAD`, `BISECT_LOG`, `sequencer/`. A worktree mid-rebase holds state in no commit.
7. **No live agent** — see below.
8. **Quiet for `--min-age`**, default 24 h, by the mtime of its index, HEAD and directory. This
   is the backstop for an agent that is *thinking* and therefore has no process signature.
9. **`git fetch` succeeded within ten minutes.** Rules 4 and 5 are statements about
   remote-tracking refs and a stale ref makes them lies. Without it, `--apply` refuses to run.

And then, having decided, it calls **`git worktree remove` without `--force`**, so git re-checks
2 and 3 with its own implementation. Two independent checks of the expensive condition is the
design, not redundancy.

### Liveness is the semaphore's, unchanged

A PID is not an identity across a reboot — that is why the browser budget stamps every lock with
the kernel's boot generation, and the reclaimer imports the same `bootId()`. A worktree is in
use if any of these names it:

- a **live budget slot** whose `root` or `cwd` is inside it (boot generation, `kill(pid,0)` and
  heartbeat all already applied by `listSlots()`);
- the **cwd of any live process** — one `lsof -a -d cwd -Fpn`, 0.2 s for the whole machine;
- the **command line** of any live process.

There is no cheaper complete answer, and an incomplete one is not usable: the cost of missing a
live agent is deleting its work.

### What it will never touch, under any flag

- the primary checkout, or anything outside a known worktree or scratch root;
- **port 5173**, or any Vite with no `--port` on its command line — which is what `npm run dev`
  looks like, so an unattributable server is left alone rather than guessed at;
- anything **tracked by git**, including committed screenshots;
- `.git` object storage. **Removing a worktree does not remove its branch or its commits.** They
  stay in the shared object store and the branch ref keeps them reachable.

Screenshots are opt-in (`--include=screenshots`) because "old" and "wanted" are uncorrelated
there, and tracked ones are protected outright.

### The safety proof

`node tools/qa-reclaim.mjs` — **14 assertions, and they run the real `--apply` path.**

It builds five worktrees: one with a commit on no remote, one with a live process standing in
its cwd, one dirty, one with `REBASE_HEAD` present, and one genuinely dead. It scopes the
reclaimer to them with `--under`, runs it for real, and asserts that four survive and one goes —
then asserts that the unpushed commit is still in the object store and its branch still names
it.

`--min-age=0s` is set for the main pass because the fixtures are seconds old. That gate is a
*timer*, not a safety property, and it is proved separately: with the default 24 h, all five
including the dead one come back protected by `too-young`.

```
PASS — 14/14 assertions
It refuses unpushed commits, uncommitted work, an in-progress rebase, and a tree
with a live process standing in it. It takes the one that is genuinely dead.
```

### On a schedule

```
node tools/reclaim.mjs --install-schedule
```

writes a launchd job to `~/Library/LaunchAgents/com.total-claude.reclaim.plist` and **does not
load it**, because deleting files while somebody is asleep is a decision about his machine and
not this tool's to make. It prints the `launchctl bootstrap` line.

The default job is **not** the full reclaimer. It runs `--apply --only=stale,scratch,servers`:
registrations whose directory is already gone (git re-checks that itself), `/tmp/tc-*` older
than 24 h with nothing in it, and Vite servers no live slot claims. `ProcessType=Background` and
`LowPriorityIO`, so the reclaimer cannot itself be the thing that makes the fans audible.

**Worktrees are excluded from the scheduled job.** They are 28 GB and they are the point, but
they are the only class where a mistake costs work rather than disk, and the difference between
"I ran it" and "it ran while I was out" is the whole of the risk. `--groups=…,worktrees` adds
them once the daily preview has been boring for a week.

Every removal is appended to `/tmp/tc-browser-budget/reclaim-log.jsonl` with path, branch and
HEAD sha, so even a mistake leaves the commits nameable.

### Run in anger, 24 August 2026

`node tools/reclaim.mjs --apply --min-age=48h --skip=servers` — 48 hours rather than the default
24, because other agents were live on the machine and the one residual risk is a session idle
long enough to have no process but not long enough to be dead.

```
                        before      after
registered worktrees       118         59
.claude/worktrees        28 GB      19 GB
/tmp/tc-*               612 MB     132 MB
disk free                92 GB     102 GB

removed 113 things; 0 refused at the last moment
```

`0 refused` is the line worth reading: **git's independent re-check agreed with all 113
decisions.** Afterwards, the eight worktrees holding 43 commits that exist on no remote were
still there, all 43 commits still named by their branches, and `git fsck --connectivity-only`
found nothing broken. The one worktree with a live process in it was untouched.

---

## 7. One command

```
node tools/browsers.mjs machine
```

Owner state and the policy it implies; GPU against its ceiling; CPU split by chromium, vite and
node; memory with a swap warning; disk; slots with holders; servers; and the worktree ledger —
how many are reclaimable, how much that is, how many are protected and by what, and a named
warning for the ones holding commits that exist on no remote.

It changes nothing, and it shells out to `tools/reclaim.mjs --json` rather than reimplementing
the rule. **There must be exactly one definition of what is safe to delete**, and a second copy
of it inside a status command is how one of them stops being true.

---

## 8. What is not solved

- **The throttle de-prioritises; it does not stop.** A demoted browser rendering nine thousand
  men still submits work, and if it is the only thing submitting it still gets the whole GPU.
  The claim is relative: when his game and a demoted probe both want the GPU, the game wins.
- **`present` versus `playing` is the weakest inference.** The game in a background window reads
  as `present`, and the cap is 2 instead of 1. The flag is the answer and it is one command.
- **The GPU ceilings are a preference, not a measurement.** 70% while he works and 45% while he
  plays are defensible defaults for "how much of my machine do I want left free". Only he can
  set them. They are `TC_GPU_CEILING` and the `POLICY` table in `tools/lib/work-budget.mjs`.
- **A `playing` cap of 1 can stall a gate for 30 minutes** — the browser wait timeout. That is
  the honest trade and it is what "his experience is the requirement" costs. `TC_OWNER=away`
  overrides it for one run, and the orchestrator rule in `docs/HANDOFF.md` is written so that
  the situation is rare rather than managed.
- **A process that already holds a slot is never refused by the work gate.** `qa-net` needs two
  browsers and sometimes three from one process, and refusing its second under a ladder of 1
  would deadlock a required gate against itself for thirty minutes. So the admission half is
  given up for runs already underway — the hard count cap still applies, and so does the
  demotion, which is the part that protects his frame rate. It means a single two-browser gate
  can be rendering while he plays. Demoted, that measured at 2% of his frame rate.
- **A run SIGKILLed while demoted leaves its browser in the background band.** Every other exit
  path restores. That orphan is also still *running*, which is the larger problem, and
  `tools/reclaim.mjs` and `browsers.mjs sweep` are what catch it.
- **Nothing here bounds *memory*.** It is measured and reported and it has never been the
  binding constraint on a 137 GB machine, but six browsers each holding a nine-thousand-man
  scene is not free, and the day this machine swaps, every number above stops mattering.
