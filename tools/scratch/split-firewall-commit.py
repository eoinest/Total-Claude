"""Split this branch's work into two commits whose second one is revertible on its own.

Commit 1 is the cross-engine arm, the port guard, the orphan fix and the `Math.hypot` sweep.
It moves no pinned hash and changes no behaviour.

Commit 2 is `src/sim/quantise.ts` — the float32 firewall on `UnitGroupState` — together with the
baseline re-record it forces and the `uf64` severity change it justifies. It costs −10.0%
survivors at t+200 on the field battle, which is a balance change the owner has to ratify, so it
has to come out in one `git revert` and take its documentation with it.

    python3 tools/scratch/split-firewall-commit.py strip     # produce the commit-1 files
    python3 tools/scratch/split-firewall-commit.py restore   # put the commit-2 files back

`strip` saves the full versions under /tmp first and every removal asserts it matched exactly
once, so a half-applied split fails loudly instead of committing a document that contradicts the
tree.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
SAVE = pathlib.Path('/tmp/tc-firewall-split')

# (path, a fragment of the block's first line, a fragment of the first line AFTER it)
#
# Fragments rather than whole lines, and ASCII-only fragments at that: these files use
# typographic apostrophes, and a whole-line match that differs from the file by one U+2019
# fails to bracket and reports nothing removed. Which it did, once, here.
BLOCKS = [
    ('docs/MULTIPLAYER.md',
     'And then the thing this document said was a 3',
     'port hazard is closed and it was real'),
    ('docs/MULTIPLAYER.md',
     'Repriced 21 August 2026, from measurement',
     'One module implementing `sin`, `cos`, `tan`'),
    ('docs/MULTIPLAYER.md',
     'Step one of the four below is no longer',
     'Do not build realtime multiplayer yet. Build the determinism fix'),
    ('docs/MULTIPLAYER.md',
     'Two of the three sentences that open this paragraph',
     'Three engines run the default battle bit-identically through every checkpoint'),
    ('docs/HANDOFF.md',
     '`uf64` is a hard failure now, and there is a fourth gate command',
     'is the new arm and it is *not* in the every-commit gate'),
    ('docs/HANDOFF.md',
     'balance cost.** `src/sim/quantise.ts` is what makes all three battles',
     'Whether battle lines should **fit** their deployment boxes'),
]

# Straight replacements, for the places a block boundary is not a whole line.
SWAPS = [
    ('docs/HANDOFF.md',
     """Confirm every run by headcount, always: **field battle 8,632 / Rome 3,074 / Carthage 3,440.** A
Carthage run reporting 8,632 measured something else. (Headcounts are unchanged by the float32
firewall — it moves the *survivor* curve, not the order of battle. Field battle survivors at t+200
went 7,061 → 6,358 and at t+400 5,849 → 4,785 when it landed; see `docs/MULTIPLAYER.md` §3 Stage 3
and the balance note in the standing rules.)""",
     """Confirm every run by headcount, always: **field battle 8,632 / Rome 3,074 / Carthage 3,440.** A
Carthage run reporting 8,632 measured something else."""),
]

FILES = sorted({b[0] for b in BLOCKS} | {s[0] for s in SWAPS} | {'tools/qa-determinism.mjs'})


def strip() -> int:
    """Save the full versions once, then remove the firewall's prose from them.

    **Save once, not every time.** Running `strip` twice overwrote the saved copies with the
    already-stripped ones and lost the commit-2 text outright; it cost half an hour of retyping.
    A second `strip` now refuses rather than destroying the only copy.
    """
    if SAVE.exists():
        print(f'REFUSING: {SAVE} already holds a saved set. `restore` first, or delete it if you')
        print('  are certain the saved copies are the stripped ones and not the full ones.')
        return 1
    SAVE.mkdir(parents=True, exist_ok=True)
    for rel in FILES:
        (SAVE / rel.replace('/', '__')).write_text((ROOT / rel).read_text())

    bad = 0
    for rel, first, after in BLOCKS:
        p = ROOT / rel
        lines = p.read_text().split('\n')
        try:
            a = next(i for i, l in enumerate(lines) if first in l)
            b = next(i for i, l in enumerate(lines) if i > a and after in l)
        except StopIteration:
            print(f'FAIL {rel}: could not bracket\n  from {first[:70]}\n  to   {after[:70]}')
            bad += 1
            continue
        p.write_text('\n'.join(lines[:a] + lines[b:]))

    for rel, old, new in SWAPS:
        p = ROOT / rel
        s = p.read_text()
        if s.count(old) != 1:
            print(f'FAIL {rel}: swap matched {s.count(old)} times')
            bad += 1
            continue
        p.write_text(s.replace(old, new, 1))

    # qa-determinism: the uf64 severity change belongs to the firewall commit.
    p = ROOT / 'tools/qa-determinism.mjs'
    s = p.read_text()
    start = s.index('/**\n * Whether a float64 unit-layer drift against the *baseline*')
    end = s.index('const STRICT_UNITS = !SOFT_UNITS;') + len('const STRICT_UNITS = !SOFT_UNITS;')
    s = s[:start] + """/**
 * Make a float64 unit-layer drift against the *baseline* a failure rather than a warning.
 *
 * Off by default. `uf64` is exact-bit and the measurement says a Chromium point release moves
 * it on its own, so defaulting this on would red the gate for every agent every time the
 * browser updated. On, this file becomes a portability gate rather than a reproducibility one.
 */
const STRICT_UNITS = args.get('strict-units') === 'true';""" + s[end:]
    s = s.replace(" *                                       [--strict-units] [--soft-units]",
                  " *                                       [--strict-units]")
    s = s.replace("""    if (softDrift) {
      console.log(`\\n  ${softDrift} checkpoint(s) drifted on uf64 only (warning: --soft-units),`);
      console.log('  with the pool hash and the');""",
                  """    if (softDrift) {
      console.log(`\\n  ${softDrift} checkpoint(s) drifted on uf64 only, with the pool hash and the`);""")
    s = s.replace("""      console.log('    · a Chromium point release is enough to do that — measured, twelve of');
      console.log('      fourteen Math functions changed between Chrome 149 and 151 — with no');
      console.log('      change to this tree at all;');""",
                  """      console.log('    · a Chromium point release is enough to do that — measured, twelve of');
      console.log('      fourteen Math functions changed between Chrome 149 and 151 — with no');
      console.log('      change to this tree at all;');""")
    s = s.replace("""      console.log('  and it will surface later as a real divergence. Re-record deliberately.');
      console.log('  NOTE: uf64 is a hard failure by default since src/sim/quantise.ts landed —');
      console.log('  the unit layer is float32-quantised at birth and at the end of every tick, so');
      console.log('  three browser engines now agree on it for six thousand ticks. You are seeing');
      console.log('  this text because --soft-units was passed. On an unchanged tree that is');
      console.log('  itself a finding: run tools/qa-xengine.mjs, which names the field.');""",
                  """      console.log('  and it will surface later as a real divergence. Re-record deliberately, or run');
      console.log('  --strict-units to make it a failure while you investigate.');""")
    # Two more in the same file that the block matcher does not reach: the `uf64` header
    # amendment and the verdict string, both of which only become true once the firewall exists.
    s = p.read_text()
    a = s.index(' *\n *             **Amended 21 August 2026.** That reasoning was correct')
    b = s.index("being the promotion. See the flag's own comment below.", a)
    b = s.index("\n", b) + 1
    s = s[:a] + s[b:]
    s = s.replace(
        "          : STRICT_UNITS ? 'DRIFTED (float64 — hard)' : 'DRIFTED (float64 only — warning, --soft-units)';",
        "          : STRICT_UNITS ? 'DRIFTED (float64 — hard, --strict-units)' : 'DRIFTED (float64 only — warning)';")
    p.write_text(s)
    print('stripped' if not bad else f'{bad} failure(s)')
    return 1 if bad else 0


def restore() -> int:
    for rel in FILES:
        src = SAVE / rel.replace('/', '__')
        if not src.exists():
            print(f'FAIL: no saved copy of {rel}')
            return 1
        (ROOT / rel).write_text(src.read_text())
    print('restored')
    return 0


sys.exit({'strip': strip, 'restore': restore}[sys.argv[1]]())
