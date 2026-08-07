# Releasing

How a change gets from `main` to [total-claude.vercel.app](https://total-claude.vercel.app) and into
[`CHANGELOG.md`](../CHANGELOG.md) and a GitHub Release, without any step resting on somebody
remembering it.

**The order below is the point of this document.** Verify that the deploy actually took *before*
publishing notes that claim it did. A tag and a release are outward-facing and effectively permanent;
a deployment that silently did not happen is not.

---

## Versioning

**Sequential release numbers: `r1`, `r2`, `r3`…** One integer, incremented on every production
deploy, tagged and released under that name.

There is no published API here, so semver's major/minor distinction would be an arbitrary judgement
call on every deploy, and a pure date needs a disambiguator on the days that ship twice (7 August
2026 shipped two). A monotone integer says exactly one thing, which is the one thing that is true:
how many times this has gone to production.

The next number is `$(git tag --list 'r*' | sort -V | tail -1)` plus one. Do not reuse or renumber.

---

## The procedure

### 0. Pick the commit

Pick an explicit SHA and write it down. Everything below refers to it as `$C`. It is normally
`main`'s tip, but read it once and use that value everywhere — **never `HEAD`**, and never a branch
name. The shared checkout is routinely on some agent's `e/…` branch, not on `main`, and agents have
twice switched it out from under a deploy.

```sh
C=$(git rev-parse main)            # read it once
git log -1 --oneline "$C"          # and look at what you got
```

### 1. Deploy from a detached worktree pinned to `$C`

**Never deploy from the shared checkout.** It carries other agents' in-flight edits, it is on the
wrong branch, and it can change between the build and the upload.

```sh
W=/tmp/tc-release-$(date +%s)                       # unique name; do not reuse another agent's
git worktree add --detach "$W" "$C"
ln -s "$(git rev-parse --show-toplevel)/node_modules" "$W/node_modules"
git -C "$W" status --porcelain                      # must be empty apart from node_modules
cd "$W" && npm run build
```

Two things that bite here:

- **The Vercel CLI uploads untracked files too.** A worktree with a stray `screenshots/` directory
  ships it. Check `git status --porcelain` and clean with `git clean -fd -e node_modules` —
  **`-e node_modules` is not optional**, because `git clean -fd` deletes the symlink and the next
  command fails one step later with `Cannot find package 'playwright'`. `git stash push -u` takes it
  for the same reason.
- **`npm run build` runs `tsc --noEmit` first.** A typecheck failure stops the build, which is
  correct — but a typecheck *pass* is not proof of life. Step 3 is what proves the thing runs.

Then deploy. Two routes, both in use:

```sh
npm run deploy                                       # build + tools/deploy-vercel.mjs (prebuilt dist upload)
# or
vercel deploy --prod --scope ernest-generaltrans-projects   # source upload, Vercel runs the build
```

Project `total-claude`, scope `ernest-generaltrans-projects`. `tools/deploy-vercel.mjs` exists
because the CLI refuses a personal account as an explicit `--scope` in non-interactive mode; it goes
through the REST API and omits `teamId`, which is what puts the deployment in the personal scope. It
reuses the token the CLI already stored, so `vercel login` is still the way in.

Record the deployment URL the tool prints. It looks like
`https://total-claude-<slug>-ernest-generaltrans-projects.vercel.app`.

### 2. Verify by bundle hash, not by status code

**A failed Vercel build leaves the previous deployment live, and the site still returns 200.** That
has happened on this project. A `curl -o /dev/null -w '%{http_code}'` check would have passed every
time.

The bundle filename carries a content hash, so comparing the live `index.html` against your own
build of `$C` is an exact test:

```sh
curl -s https://total-claude.vercel.app/ -o /tmp/tc-live-$$.html
diff /tmp/tc-live-$$.html "$W/dist/index.html" && echo "index.html byte-identical"

# and the bundle itself, in case a CDN edge is serving a stale document
B=$(grep -oE '/bundle/main-[A-Za-z0-9_-]+\.js' "$W/dist/index.html" | head -1)
curl -s "https://total-claude.vercel.app$B" | shasum -a 256
shasum -a 256 "$W/dist$B"
```

Both must match. If they do not, the deployment did not take — **stop here.** Nothing has been
tagged and nothing has been published, which is the whole reason this step comes first.

If the live site is behind Vercel's SSO on a per-deployment URL, use the production alias
(`total-claude.vercel.app`), which is not protected.

### 3. Boot all three maps and confirm the clock advances

A bundle that downloads is not a game that runs. There are three maps — `campus-martius`, `pydna`
and `carthage` — and they have shipped broken independently of each other; Carthage in particular
has had `city: null`, an unreachable faction and a boot-time hang in its history.

For each of `?map=campus-martius`, `?map=pydna`, `?map=carthage` against the **live URL**:

1. Load the page and read `window.__game.ready`. `true`, not merely "no timeout".
2. **Capture `pageerror` and `console`.** Without them a dead app is indistinguishable from a slow
   boot, and agents have lost hours to unexplained 180-second timeouts.
3. **Read the simulation clock twice, a few seconds apart, and confirm it moved.** A frozen sim
   renders perfectly and looks fine in a screenshot. This project has shipped a field battle that
   froze for sixteen minutes.

`tools/qa-preview.mjs` and `tools/qa-deploy.mjs` are the closest existing harnesses; either can be
pointed at a URL rather than a local vite. If you drive a browser by hand, **do not touch port
5173** — that is the owner's playtest server.

### 4. Write the notes, from the commit range

Only now that the deploy is real. The range is the last tag to `$C`:

```sh
LAST=$(git tag --list 'r*' | sort -V | tail -1)
git log --no-merges --format='%h %s' "$LAST..$C"
git log --no-merges --format='%h %s%n%n%b' "$LAST..$C" | less   # the bodies are the source material
```

**Write it for a player and a curious developer, not for a build system.** House style, which the
commit messages already set:

- **Group by what changed for someone playing the game** — what is new, what was broken and is now
  fixed, what got faster — not by module, and never as a list of commit subjects.
- **A one-line summary at the top of each version that says what the release *is*.**
- **Use the commit messages as source material rather than reproducing them.** Each one names a
  defect and the measurement that found it; the measurement is the interesting part.
- **Quote no number you cannot source.** Every figure must come from a commit message, from
  `docs/HANDOFF.md`, or from a measurement you took. If you cannot find it, leave it out.
- **Where a claim was later retracted or corrected, carry the corrected version, not the original.**
  Several already have been. Each release section ends with a *Corrections to the record* block for
  exactly this.
- **Credit outside contributors by name**, and say which release their work landed in.

Add the section to the top of `CHANGELOG.md` with the release number, the date, `$C`, and the
verified deployment slug from step 1. Commit it:

```sh
git commit -m "docs: changelog for rN"
```

That commit sits *after* the released commit, which is correct: the changelog documents what
shipped, it is not what shipped.

### 5. Tag the deployed commit

The tag names the bytes that are live, so it points at `$C` and not at the changelog commit:

```sh
git tag -a rN -m "rN — <the one-line summary>" "$C"
git push origin rN
```

**Never move or delete a tag that already exists, and never force-push one.** If `rN` is taken,
take the next number and say so.

### 6. Cut the GitHub Release

```sh
gh release create rN --title "rN — <the one-line summary>" --notes-file <(…the section you wrote…)
```

The notes are the changelog section for that release, verbatim. Mark it `--latest` only if it is
actually the live version.

### 7. Clean up

```sh
cd / && git worktree remove "$W" --force
```

Delete any screenshot directory the verification produced. Nine gigabytes of agent screenshots
across 287 directories once took the machine down through Spotlight indexing.

---

## Verifying a deploy after the fact

Sometimes you need to establish which commit a past deployment contained — backfilling a changelog,
or settling an argument about what is live. The Vercel API holds a plain SHA-1 of every file's bytes
in a deployment, and git can produce the same number, so the match is exact rather than
circumstantial.

```sh
TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync(
  process.env.HOME+'/Library/Application Support/com.vercel.cli/auth.json','utf8')).token)")
vercel ls total-claude --scope ernest-generaltrans-projects
vercel inspect <deployment-url> --scope ernest-generaltrans-projects   # gives the dpl_… id and created time
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.vercel.com/v6/deployments/<dpl_id>/files"
```

The response is a tree wrapped in a synthetic root named `src`; each leaf's `uid` is
`sha1(file bytes)`. Git's blob hash is *not* that number — it is `sha1("blob <len>\0" + bytes)` — so
recompute from `git cat-file blob`. A deployment made from a clean checkout at commit `C` matches
every tracked file in `C`'s tree; the four releases in `CHANGELOG.md` were each identified this way
at 100%.

Note that only *source* uploads carry this fingerprint. A prebuilt `dist/` upload contains no source
and cannot be traced to a commit at all — which is why the four deployments before `r1` are
unidentified.

---

## The rules behind the rules

Each of these was paid for.

1. **Pin to an explicit commit in a detached worktree.** Not the shared checkout, not `HEAD`, not a
   branch name. Agents have twice switched the shared checkout onto their own branches mid-task, and
   a draw-call A/B was once run against a worktree whose "baseline" had three other agents' commits
   in it.
2. **Verify by bundle hash, not by status code.** A failed Vercel build leaves the previous
   deployment live and returns 200.
3. **A typecheck is not proof of life.** `tsc` cannot see a missing runtime method behind `?.`, an
   ESM binding error, or a temporal dead zone. Three commits were once stacked on a tree that
   white-screened. Load the page, read `window.__game.ready`, and capture `pageerror` and `console`.
4. **`tsc --noEmit` goes blind program-wide the moment any file has a syntax error.** Use
   `node tools/typecheck.mjs --mine=<path>`; `INCONCLUSIVE` (exit 2) is not a pass.
5. **A rendering deploy is not verified until the clock has moved.** A frozen simulation photographs
   perfectly.
6. **Never commit a subset of a multi-file change.** That is exactly what broke mainline for three
   commits.
7. **Give every scratch file and worktree a unique name, inside your own worktree.** Several agents
   run at once.
8. **Do not touch port 5173.** It is the owner's playtest server, and killing vite by filtering on
   `port 5173` misses it, because `npm run dev` puts no port on its command line. That has killed the
   owner's server three times.
