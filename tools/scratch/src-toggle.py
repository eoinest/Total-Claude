"""Put `src/` back to HEAD and then put it back to mine, so HEAD itself can be measured.

`tools/determinism-baseline.json` pins a battle, and a pin is only evidence about *my* change if
it was green before *my* change. The gate was last reported green at `5f9030e`; this worktree is
at `58bc584`, several commits later, and a commit in between could have moved a battle without
re-recording. Attributing that drift to this branch would be re-recording movement I did not
cause, which the standing rules forbid by name.

So: measure HEAD. This saves every modified tracked file under `src/`, checks them out, and can
restore the exact bytes afterwards.

    python3 tools/scratch/src-toggle.py head     # src/ == HEAD
    python3 tools/scratch/src-toggle.py mine     # src/ == this branch's working tree

`git stash` would do this in one word and is forbidden here: the stash stack is repo-global and
two agents have already popped each other's work off it.
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
SAVE = pathlib.Path('/tmp/tc-src-toggle')


def modified():
    out = subprocess.run(['git', 'status', '--porcelain', '--', 'src'],
                         cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return [l[3:].strip() for l in out.splitlines() if l[:2].strip() in ('M', 'A', 'AM', 'MM')]


def head() -> int:
    SAVE.mkdir(parents=True, exist_ok=True)
    files = modified()
    if not files:
        print('nothing modified under src/ — already at HEAD?')
        return 0
    (SAVE / 'MANIFEST').write_text('\n'.join(files))
    for rel in files:
        (SAVE / rel.replace('/', '__')).write_text((ROOT / rel).read_text())
    subprocess.run(['git', 'checkout', '--'] + files, cwd=ROOT, check=True)
    print(f'src/ is HEAD ({len(files)} file(s) parked). Do not record a pin from this state'
          ' unless you mean to.')
    return 0


def mine() -> int:
    man = SAVE / 'MANIFEST'
    if not man.exists():
        print('FAIL: no manifest — nothing was parked')
        return 1
    files = man.read_text().split('\n')
    for rel in files:
        src = SAVE / rel.replace('/', '__')
        if not src.exists():
            print(f'FAIL: no saved copy of {rel}')
            return 1
        (ROOT / rel).write_text(src.read_text())
    print(f'src/ restored ({len(files)} file(s))')
    return 0


sys.exit({'head': head, 'mine': mine}[sys.argv[1]]())
