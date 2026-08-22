"""The +Z edge, re-derived from the two anchors rather than from `layout.ts`.

Checks `ROME-FABRIC.md` §8.5a's claim that **the shipped map draws the Colosseum 12 world
metres past the edge of the heightfield**, and that the landmarks branch draws it entirely on.

The frame comes from `tools/scratch/rome-frame.mjs`, which re-derives it from the Porta
Flaminia anchor and the two scales without importing `topography.ts`:

  GATE_X = 72.0000, GATE_Z = 529.7456, KX = 0.443, KZ = 0.35, HALF_EXTENT = 1400
  X0 = GATE_X - KX * (-497),  Z0 = GATE_Z + KZ * 2045

The reach along world z of a rotated rectangle is |hw*sin(rot)| + |hd*cos(rot)|, with
`rot = worldRot(bearing, axis)` — the same expression `maxDrawAt` uses, written out here from
the rotation convention rather than called, so this is arithmetic and not a re-run.

  python3 tools/scratch/jg2-edge.py
"""
import math

KX, KZ, HALF, PRECINCT = 0.443, 0.35, 1400.0, 1.07
GATE_X, GATE_Z = 72.0, 529.7456
X0 = GATE_X - KX * (-497)
Z0 = GATE_Z + KZ * 2045


def worldOf(e, n):
    return X0 + KX * e, Z0 - KZ * n


def worldRot(bearing_deg, axis='x'):
    th = math.radians(bearing_deg)
    dx = KX * math.sin(th)
    dz = -KZ * math.cos(th)
    if axis == 'x':
        return -math.atan2(dz, dx)
    return math.atan2(dx, dz)


def reach_z(length, width, bearing, axis, scale):
    """World +z half-extent of the reserved box at this plan scale."""
    along_z = axis == 'z'
    hw = (width if along_z else length) * 0.5 * PRECINCT * scale
    hd = (length if along_z else width) * 0.5 * PRECINCT * scale
    rot = worldRot(bearing, axis)
    return abs(hw * math.sin(rot)) + abs(hd * math.cos(rot))


CASES = [
    # id, e, n, len, wid, bearing, axis, scale, label
    ('colosseum  bc2e0f2 (PLAN_SCALE 0.65)', 820, -256, 189, 156, 115, 'x', 0.65),
    ('colosseum  bc2e0f2 at full plan     ', 820, -256, 189, 156, 115, 'x', 1.00),
    ('colosseum  6c975e8 (draw 0.573)     ', 839, -249, 189, 156, 115, 'x', 0.573),
    ('colosseum  6c975e8 at full plan     ', 839, -249, 189, 156, 115, 'x', 1.00),
    ('castra-pr. 6c975e8 (draw 0.190)     ', 2113, 1484, 400, 377, 340, 'x', 0.190),
    ('castra-pr. 6c975e8 at full plan     ', 2113, 1484, 400, 377, 340, 'x', 1.00),
]

print(f"X0 = {X0:.3f}   Z0 = {Z0:.3f}   HALF_EXTENT = {HALF:.0f}\n")
print(f"  {'case':38} {'centre z':>9} {'reach z':>8} {'z max':>8} {'over edge':>10}")
for label, e, n, L, W, b, ax, sc in CASES:
    x, z = worldOf(e, n)
    r = reach_z(L, W, b, ax, sc)
    print(f"  {label:38} {z:9.1f} {r:8.1f} {z + r:8.1f} {z + r - HALF:+10.1f}")

# The cap the branch says binds: (HALF - z) / reachPerUnit
for label, e, n, L, W, b, ax, sc in CASES:
    if 'full plan' not in label:
        continue
    x, z = worldOf(e, n)
    per = reach_z(L, W, b, ax, 1.0)
    print(f"\n  {label.strip()}: maxDrawAt = (1400 - {z:.1f}) / {per:.1f} = {(HALF - z)/per:.3f}")
