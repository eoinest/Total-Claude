"""One-shot: Math.hypot -> Math.sqrt across src/terrain, src/maps and the one src/city regression.

Every edit is an exact string replacement, applied once, and the script fails loudly if a
pattern does not appear exactly once. A sed pass over 27 call sites in eight files is how a
`Math.hypot(a, b, c)` quietly becomes `Math.sqrt(a * a + b * b)`.
"""
import pathlib
import sys

EDITS = [
    # --- src/terrain/erosion.ts ---
    ("src/terrain/erosion.ts",
     "      const d = Math.hypot(dx, dy);",
     "      const d = Math.sqrt(dx * dx + dy * dy);"),
    ("src/terrain/erosion.ts",
     "      const dl = Math.hypot(dirX, dirY);",
     "      const dl = Math.sqrt(dirX * dirX + dirY * dirY);"),

    # --- src/terrain/heightfield.ts ---
    ("src/terrain/heightfield.ts",
     "      const slope = clamp01(Math.hypot(gx, gz));",
     "      const slope = clamp01(Math.sqrt(gx * gx + gz * gz));"),
    ("src/terrain/heightfield.ts",
     "        const dr = Math.hypot(dx, dz) * (1 + 0.16 * gnoise(wx * 0.03, wz * 0.03, seed + 61));",
     "        const dr = Math.sqrt(dx * dx + dz * dz) * (1 + 0.16 * gnoise(wx * 0.03, wz * 0.03, seed + 61));"),
    ("src/terrain/heightfield.ts",
     "        const dr = Math.hypot((wx - q.x) / q.radius, (wz - q.z) / (q.radius * 0.78));",
     "        const qu = (wx - q.x) / q.radius;\n"
     "        const qv = (wz - q.z) / (q.radius * 0.78);\n"
     "        const dr = Math.sqrt(qu * qu + qv * qv);"),

    # --- src/terrain/proctex.ts ---
    ("src/terrain/proctex.ts",
     "          const d = Math.hypot(cu - px, cv - py);",
     "          const d = Math.sqrt((cu - px) * (cu - px) + (cv - py) * (cv - py));"),
    ("src/terrain/proctex.ts",
     "      const len = Math.hypot(nx, ny, nz);",
     "      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);"),

    # --- src/terrain/TerrainSystem.ts ---
    ("src/terrain/TerrainSystem.ts",
     "    const m = Math.hypot(dx, dz);",
     "    const m = Math.sqrt(dx * dx + dz * dz);"),

    # --- src/terrain/topography.ts ---
    ("src/terrain/topography.ts",
     "export const riverPerpScale = (z: number): number => 1 / Math.hypot(1, riverCurvature(z));",
     "export const riverPerpScale = (z: number): number => {\n"
     "  const s = riverCurvature(z);\n"
     "  return 1 / Math.sqrt(1 + s * s);\n"
     "};"),

    # --- src/maps/campusMartius.ts ---
    ("src/maps/campusMartius.ts",
     "      if (Math.hypot((x - q.x) / q.radius, (z - q.z) / (q.radius * 0.8)) < 1.25) return true;",
     "      const qu = (x - q.x) / q.radius;\n"
     "      const qv = (z - q.z) / (q.radius * 0.8);\n"
     "      if (Math.sqrt(qu * qu + qv * qv) < 1.25) return true;"),

    # --- src/maps/pydna/heightfield.ts ---
    ("src/maps/pydna/heightfield.ts",
     "      const slope = clamp01(Math.hypot(gx, gz));",
     "      const slope = clamp01(Math.sqrt(gx * gx + gz * gz));"),

    # --- src/maps/carthage/heightfield.ts ---
    ("src/maps/carthage/heightfield.ts",
     "  const byrsa = Math.exp(-Math.pow(Math.hypot((x - BYRSA_X) / 230, (z - BYRSA_Z) / 145), 2));\n"
     "  const djedid = Math.exp(-Math.pow(Math.hypot((x - 210) / 260, (z - 1037) / 175), 2));",
     "  const bu = (x - BYRSA_X) / 230;\n"
     "  const bv = (z - BYRSA_Z) / 145;\n"
     "  const byrsa = Math.exp(-Math.pow(Math.sqrt(bu * bu + bv * bv), 2));\n"
     "  const ju = (x - 210) / 260;\n"
     "  const jv = (z - 1037) / 175;\n"
     "  const djedid = Math.exp(-Math.pow(Math.sqrt(ju * ju + jv * jv), 2));"),
    ("src/maps/carthage/heightfield.ts",
     "  return Math.hypot(x - (x1 + dx * t), z - (z1 + dz * t));",
     "  const px = x - (x1 + dx * t);\n"
     "  const pz = z - (z1 + dz * t);\n"
     "  return Math.sqrt(px * px + pz * pz);"),
    ("src/maps/carthage/heightfield.ts",
     "  return 1 - sstep(flat, flat + APRON_FALL, Math.hypot(x - COTHON.x, z - COTHON.z));",
     "  return 1 - sstep(flat, flat + APRON_FALL,\n"
     "    Math.sqrt((x - COTHON.x) * (x - COTHON.x) + (z - COTHON.z) * (z - COTHON.z)));"),
    ("src/maps/carthage/heightfield.ts",
     "  const r = Math.hypot(x - COTHON.x, z - COTHON.z);\n"
     "  let w = sstep(COTHON.islandR, COTHON.islandR + BASIN_EDGE, r)",
     "  const r = Math.sqrt((x - COTHON.x) * (x - COTHON.x) + (z - COTHON.z) * (z - COTHON.z));\n"
     "  let w = sstep(COTHON.islandR, COTHON.islandR + BASIN_EDGE, r)"),
    ("src/maps/carthage/heightfield.ts",
     "      const slope = clamp01(Math.hypot(gx, gz));",
     "      const slope = clamp01(Math.sqrt(gx * gx + gz * gz));"),
    ("src/maps/carthage/heightfield.ts",
     "        const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));",
     "        const px = x - (a.x + dx * t);\n"
     "        const pz = z - (a.z + dz * t);\n"
     "        const d = Math.sqrt(px * px + pz * pz);"),
    ("src/maps/carthage/heightfield.ts",
     "    const r = Math.hypot(x - COTHON.x, z - COTHON.z);\n"
     "    return r <= R && r >= COTHON.islandR;",
     "    const r = Math.sqrt((x - COTHON.x) * (x - COTHON.x) + (z - COTHON.z) * (z - COTHON.z));\n"
     "    return r <= R && r >= COTHON.islandR;"),
    ("src/maps/carthage/heightfield.ts",
     "      const g = Math.hypot(\n"
     "        (at(x + 3.5, z) - at(x - 3.5, z)) / 7,\n"
     "        (at(x, z + 3.5) - at(x, z - 3.5)) / 7,\n"
     "      );",
     "      const gx = (at(x + 3.5, z) - at(x - 3.5, z)) / 7;\n"
     "      const gz = (at(x, z + 3.5) - at(x, z - 3.5)) / 7;\n"
     "      const g = Math.sqrt(gx * gx + gz * gz);"),
    ("src/maps/carthage/heightfield.ts",
     "    const len = Math.hypot(1, dz);",
     "    const len = Math.sqrt(1 + dz * dz);"),
    ("src/maps/carthage/heightfield.ts",
     "      const g = Math.hypot(\n"
     "        (at(x + CELL, z) - at(x - CELL, z)) / (CELL * 2),\n"
     "        (at(x, z + CELL) - at(x, z - CELL)) / (CELL * 2),\n"
     "      );",
     "      const gx = (at(x + CELL, z) - at(x - CELL, z)) / (CELL * 2);\n"
     "      const gz = (at(x, z + CELL) - at(x, z - CELL)) / (CELL * 2);\n"
     "      const g = Math.sqrt(gx * gx + gz * gz);"),
    ("src/maps/carthage/heightfield.ts",
     "  const m = Math.hypot(gx, gz);",
     "  const m = Math.sqrt(gx * gx + gz * gz);"),

    # --- src/maps/carthage/topography.ts ---
    ("src/maps/carthage/topography.ts",
     "  const r = Math.hypot((x - cx) / hw, (z - cz) / hd);",
     "  const ru = (x - cx) / hw;\n"
     "  const rv = (z - cz) / hd;\n"
     "  const r = Math.sqrt(ru * ru + rv * rv);"),

    # --- src/city/rome/circuit.ts — a regression, not a backlog item.
    # tools/check-determinism.mjs already reports it: hypot was cleared out of src/city
    # deliberately and measured free, so a hit there is new code re-introducing it.
    ("src/city/rome/circuit.ts",
     "  const run = Math.hypot(foot.x - head.x, foot.z - head.z);",
     "  const run = Math.sqrt((foot.x - head.x) * (foot.x - head.x)\n"
     "    + (foot.z - head.z) * (foot.z - head.z));"),
]

# The three-argument sites in proctex that share one source line shape and must each be done.
TRIPLE = ("src/terrain/proctex.ts",
          "      const len = Math.hypot(nx, ny, 1);",
          "      const len = Math.sqrt(nx * nx + ny * ny + 1);")

root = pathlib.Path(__file__).resolve().parents[2]
fail = 0
for rel, old, new in EDITS:
    p = root / rel
    s = p.read_text()
    n = s.count(old)
    if n != 1:
        print(f"FAIL {rel}: pattern appears {n} times, expected 1:\n  {old[:90]}")
        fail += 1
        continue
    p.write_text(s.replace(old, new, 1))

# proctex has this exact line twice (lines 336 and 480), both three-argument with a literal 1.
rel, old, new = TRIPLE
p = root / rel
s = p.read_text()
n = s.count(old)
if n != 2:
    print(f"FAIL {rel}: three-arg pattern appears {n} times, expected 2")
    fail += 1
else:
    p.write_text(s.replace(old, new))

sys.exit(1 if fail else 0)
