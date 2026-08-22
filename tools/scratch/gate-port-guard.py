"""Put the tree-identity port guard on the remaining every-commit gate tools.

`qa-determinism.mjs` and `probe-seams.mjs` already refuse a port they cannot prove. `qa-deploy`
and `qa-replay` are the other two browser arms of the gate and had the same hole: try the port,
and if something answers, use it. A gate that can pass on another agent's branch is worse than
no gate, and the whole gate should refuse rather than two thirds of it.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
TARGETS = {'tools/qa-deploy.mjs': 'qa-deploy', 'tools/qa-replay.mjs': 'qa-replay'}

BLOCK = re.compile(
    r"const base = `http://127\.0\.0\.1:\$\{PORT\}`;\n"
    r"let server = null;\n"
    r"if \(!\(await waitForServer\(base, 1200\)\)\) \{\n"
    r"  server = spawnVite\(\['--port', String\(PORT\), '--host', '127\.0\.0\.1', '--strictPort'\], \{\n"
    r"    cwd: ROOT, stdio: 'ignore', env: \{ \.\.\.process\.env, TC_NO_HMR: '1' \},\n"
    r"  \}\);\n"
    r"  if \(!\(await waitForServer\(base, \d+\)\)\) \{ console\.error\('vite did not start'\); process\.exit\(1\); \}\n"
    r"\}\n")

fail = 0
for rel, label in TARGETS.items():
    p = ROOT / rel
    s = p.read_text()
    m = BLOCK.search(s)
    if not m:
        print(f'FAIL {rel}: server block shape not matched')
        fail += 1
        continue
    s = s[:m.start()] + (
        '/*\n'
        ' * A listener answering on this port is not the same claim as this tree being on it.\n'
        ' * Eighty worktrees here default to a handful of ports, so an unverified reuse means a\n'
        " * gate that passes on another agent's branch and reports it as this one's.\n"
        ' * `ownDevServer` proves it — every `.ts` under `src/`, through Vite\'s `?raw` route — or\n'
        ' * exits 2 naming the files that differ. See `tools/lib/devtree.mjs`.\n'
        ' */\n'
        'const { base, kill: killServer } = await ownDevServer({\n'
        '  root: ROOT,\n'
        '  port: PORT,\n'
        '  cacheDir: process.env.TC_VITE_CACHE_DIR ?? null,\n'
        f"  label: '{label}',\n"
        '});\n'
    ) + s[m.end():]
    s = s.replace("import { spawnVite } from './lib/devtree.mjs';",
                  "import { ownDevServer } from './lib/devtree.mjs';")
    s = re.sub(r"^(\s*)if \(server\) server\.kill\('SIGTERM'\);$", r"\1killServer();", s, flags=re.M)
    p.write_text(s)
    print(f'ok {rel}')

sys.exit(1 if fail else 0)
