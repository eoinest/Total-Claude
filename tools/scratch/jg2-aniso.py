"""Anisotropy per monument, by **two independent methods**, on both trees.

`docs/CITY-GROUND-JUDGE.md` §1 records that three ways of measuring the Flavian
Amphitheatre's height gave 9.2 m, 89 m and 55.2 m, and refused to quote an absolute height
anywhere. This is the same caution applied to a *ratio*: the number that matters for rubric H8
is `h / long plan` against the published `h / long plan`, and it is computed here twice.

  A. **grid-max raycast** — an 11 x 11 grid inside 0.9 of the collision box, one datum at the
     monument's own centre, the maximum hit. `judge-fabric.mjs`'s method.
  B. **vertex maximum** — the largest `y` among the monument's own drawn vertices, attributed
     by nearest-owner-normalised-by-reach off the baked `monuments-*-lod0` chunks, minus the
     same datum. No rays at all.

They fail differently. A can be fooled by a neighbour's stone overhanging the box or by a
slope inside it; B can be fooled by attribution, which on Rome is positional because the city
emits its monuments in three depth bands rather than one chunk each (`ROME-FABRIC.md` §8.5c).
**Where they agree the reading is safe; where they disagree it is not, and this prints both.**

  python3 tools/scratch/jg2-aniso.py
"""
import json

REAL_H = {  # long plan, real height, from the probe's own typed-in table
    'colosseum': (189, 48.5), 'pantheon': (84, 43.4), 'mausoleum-augustus': (87, 45),
    'theatre-marcellus': (130, 32.6), 'mausoleum-hadrian': (89, 21), 'temple-jupiter': (63, 30),
    'castra-praetoria': (400, 8), 'baths-trajan': (230, 30), 'baths-nero': (190, 25),
    'basilica-ulpia': (130, 25), 'trajan-column': (18, 38), 'ara-pacis': (11.6, 6),
    'theatre-pompey': (160, 30), 'stadium-domitian': (275, 20), 'forum-romanum': (200, 15),
    'imperial-fora': (250, 20), 'baths-agrippa': (120, 25), 'baths-titus': (120, 25),
    'ludus-magnus': (135, 15), 'trajan-market': (120, 35), 'porticus-octaviae': (132, 15),
    'porticus-pompei': (180, 15), 'temple-isis': (200, 20), 'temple-serapis': (135, 30),
    'tabularium': (73, 25), 'largo-argentina': (90, 15),
}

import sys

PREFIX = sys.argv[1] if len(sys.argv) > 1 else '/tmp/tc-jg2/mon2'
trees = {}
for tag in ('bc2e0f2', '6c975e8'):
    d = json.load(open(f'{PREFIX}-{tag}.json'))
    trees[tag] = {r['id']: r for r in d['rows']}


def aniso(r, method):
    real = REAL_H.get(r.get('id'))
    if not real or r.get('box', {}).get('w') is None:
        return None
    L = max(r['box']['w'], r['box']['d'])
    h = r.get('drawnHeight') if method == 'A' else r.get('stoneHeight')
    if not h or h <= 0:
        return None
    return (h / L) / (real[1] / real[0])


def med(v):
    s = sorted(x for x in v if x)
    return s[len(s) // 2] if s else None


for method in ('A', 'B'):
    label = 'grid-max raycast' if method == 'A' else 'vertex maximum'
    print(f"\n=== method {method}: {label} " + "=" * 34)
    print(f"  {'monument':22} {'draw':>6} | {'bc2e0f2':>8} {'6c975e8':>8} {'ratio':>7}")
    rows = []
    for k in sorted(REAL_H):
        a0 = aniso(trees['bc2e0f2'].get(k, {}), method)
        a1 = aniso(trees['6c975e8'].get(k, {}), method)
        if a0 is None and a1 is None:
            continue
        rows.append((k, a0, a1))
        f = f"{a1/a0:7.2f}" if (a0 and a1) else '      -'
        dr = trees['6c975e8'].get(k, {}).get('declared', {}).get('planScale')
        print(f"  {k:22} {dr if dr is not None else '-':>6} | "
              f"{(f'{a0:8.2f}' if a0 else '       -')} {(f'{a1:8.2f}' if a1 else '       -')} {f}")
    b, a = med([r[1] for r in rows]), med([r[2] for r in rows])
    print(f"\n  median anisotropy: bc2e0f2 {b:.2f}  ->  6c975e8 {a:.2f}   ({a/b:.2f}x)")
    imp = [r[0] for r in rows if r[1] and r[2] and r[2] < r[1] * 0.95]
    wor = [r[0] for r in rows if r[1] and r[2] and r[2] > r[1] * 1.05]
    print(f"  improved by >5 %: {len(imp)}   worsened by >5 %: {len(wor)}")
    print(f"    worsened: {sorted(wor)}")
    # Under isotropy, a row whose builder did not change should move by exactly 1/1.538 = 0.650.
    ratios = sorted(r[2] / r[1] for r in rows if r[1] and r[2])
    near = [x for x in ratios if 0.58 <= x <= 0.72]
    print(f"  rows moving by 0.650 +/- 0.07 (i.e. the old global 0.65 being undone): "
          f"{len(near)} of {len(ratios)}")

print("\n=== the two methods against each other, on 6c975e8 " + "=" * 20)
print(f"  {'monument':22} {'h(A)':>7} {'h(B)':>7} {'B/A':>6}  verdict")
for k in sorted(REAL_H):
    r = trees['6c975e8'].get(k)
    if not r or r.get('stoneHeight') is None or not r.get('drawnHeight'):
        continue
    q = r['stoneHeight'] / r['drawnHeight']
    v = 'agree' if 0.9 <= q <= 1.11 else 'DISAGREE — neither reading is safe'
    print(f"  {k:22} {r['drawnHeight']:7.1f} {r['stoneHeight']:7.1f} {q:6.2f}  {v}")
