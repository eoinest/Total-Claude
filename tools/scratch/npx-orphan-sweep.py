"""One-shot: every harness that spawns `npx vite` spawns Vite itself instead.

`npx` is a wrapper *process* around Vite. `server.kill('SIGTERM')` reaches the wrapper, the
wrapper exits, and the dev server keeps running and keeps the port. Nineteen orphans in one
day, some more than a day old, load average 72, one broken gate run.

`spawnVite` from tools/lib/devtree.mjs returns a handle that *is* the server, so every
existing `server.kill('SIGTERM')` in the tree starts working as written, and registers an
`exit` hook so a harness that throws still takes its server with it.

The substitution is one token per call site plus one import per file, and the script refuses
to guess: a file whose spawn does not match the exact expected text is listed and skipped.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
OLD = "spawn('npx', ['vite', "
NEW = "spawnVite(["

changed, skipped, sites = [], [], 0
for p in sorted((ROOT / 'tools').rglob('*.mjs')):
    if p.name == 'devtree.mjs':
        continue
    s = p.read_text()
    n = s.count(OLD)
    if n == 0:
        continue
    s2 = s.replace(OLD, NEW)
    sites += n

    # The import path depends on how deep the file is under tools/.
    rel = p.relative_to(ROOT / 'tools').parent
    prefix = './' if rel == pathlib.Path('.') else '../' * len(rel.parts)
    imp = f"import {{ spawnVite }} from '{prefix}lib/devtree.mjs';"
    if 'spawnVite }' not in s2 and 'spawnVite,' not in s2:
        # After the last top-level import, so it reads with the others.
        ms = list(re.finditer(r"^import .*?;$", s2, re.M))
        if not ms:
            skipped.append(f"{p.relative_to(ROOT)} (no import statement to anchor to)")
            continue
        at = ms[-1].end()
        s2 = s2[:at] + "\n" + imp + s2[at:]

    # `spawn` may now be unused. Drop the import only if nothing else calls it.
    if not re.search(r"\bspawn\s*\(", s2):
        s2 = re.sub(r"^import \{ spawn \} from 'node:child_process';\n", '', s2, flags=re.M)
        s2 = re.sub(r"^(import \{[^}]*?)spawn,\s*([^}]*\} from 'node:child_process';)$",
                    r"\1\2", s2, flags=re.M)
        s2 = re.sub(r"^(import \{[^}]*?),\s*spawn(\s*\} from 'node:child_process';)$",
                    r"\1\2", s2, flags=re.M)

    p.write_text(s2)
    changed.append(str(p.relative_to(ROOT)))

print(f"{len(changed)} file(s), {sites} call site(s)")
for s in skipped:
    print(f"  SKIPPED {s}")
sys.exit(1 if skipped else 0)
