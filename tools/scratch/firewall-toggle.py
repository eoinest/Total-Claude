"""Turn the float32 firewall off and on again, for an A/B control run.

Four seeds holding across three engines *with* the firewall proves nothing on its own: they
might be seeds that were never going to fork. The claim needs the same seeds measured without
it. This is how, and it is a save-and-restore rather than an edit-and-remember, because the one
thing that must not happen is a control run leaking into the tree.

    python3 tools/scratch/firewall-toggle.py off
    python3 tools/scratch/firewall-toggle.py on      # restores the saved bytes exactly

`on` compares against the saved copy rather than re-editing, so it cannot leave a half-restored
file behind, and it fails if there is no saved copy to restore from.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
SAVE = pathlib.Path('/tmp/tc-firewall-toggle')
FILES = ['src/main.ts', 'src/sim/BattleSystem.ts']

CUTS = [
    ('src/main.ts',
     'engine.add(new UnitQuantiseSystem(battle));',
     '// [firewall-toggle off] engine.add(new UnitQuantiseSystem(battle));'),
    ('src/sim/BattleSystem.ts',
     '    quantiseUnit(u);',
     '    // [firewall-toggle off] quantiseUnit(u);'),
]


def off() -> int:
    SAVE.mkdir(parents=True, exist_ok=True)
    for rel in FILES:
        (SAVE / rel.replace('/', '__')).write_text((ROOT / rel).read_text())
    for rel, old, new in CUTS:
        p = ROOT / rel
        s = p.read_text()
        if s.count(old) != 1:
            print(f'FAIL {rel}: matched {s.count(old)} times, expected 1')
            return 1
        p.write_text(s.replace(old, new, 1))
    print('firewall OFF — this is a control run, do not commit or measure a pin here')
    return 0


def on() -> int:
    for rel in FILES:
        src = SAVE / rel.replace('/', '__')
        if not src.exists():
            print(f'FAIL: no saved copy of {rel}')
            return 1
        (ROOT / rel).write_text(src.read_text())
    for rel in FILES:
        if 'firewall-toggle off' in (ROOT / rel).read_text():
            print(f'FAIL: {rel} still carries the toggle marker after restore')
            return 1
    print('firewall ON — restored from the saved bytes')
    return 0


sys.exit({'off': off, 'on': on}[sys.argv[1]]())
