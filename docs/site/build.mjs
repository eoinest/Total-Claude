#!/usr/bin/env node
/**
 * Build the static documentation site.
 *
 * ---------------------------------------------------------------------------
 * This build is deliberately separate from the game's build, and must stay that way.
 * ---------------------------------------------------------------------------
 *
 * The game is a Vite application whose `rollupOptions.input` names `index.html` and
 * `viewer.html` explicitly, and whose deployment is verified by bundle hash (see
 * `docs/RELEASING.md` step 2). If the documentation shared that build, adding a page would
 * change the bundle hash and invalidate a release that had already been verified live.
 *
 * So: own directory, own `package.json`, own `node_modules`, own output. Nothing here reads
 * `vite.config.ts`, nothing here writes to `dist/`, and no script in the root
 * `package.json` invokes this file. The only coupling is that this script *reads* Markdown
 * out of `docs/`.
 *
 * Output is a tree of plain HTML with one stylesheet and no client-side JavaScript, so it
 * can be uploaded to any static host — including via `tools/deploy-vercel.mjs`, which
 * posts a prebuilt tree with `framework: null` and `buildCommand: null` and therefore
 * cannot run the game's build even by accident.
 *
 * ---------------------------------------------------------------------------
 * The image rule
 * ---------------------------------------------------------------------------
 *
 * `reference/` and `reference-crops/` hold copyrighted Total War: ROME II press plates and
 * licensed museum photographs. Both are gitignored precisely so they cannot be published by
 * accident, and "gitignored" is not a mechanism that survives a build script that copies
 * files by glob. This one copies images from exactly one directory — `docs/images/`, all of
 * which are our own renders — and then re-checks every `<img>` in every emitted page against
 * an allowlist, refusing the build if anything else appears. See `assertNoReferenceImagery`.
 *
 * Usage: node build.mjs [--out=dist] [--base=/]
 */

import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import ts from 'highlight.js/lib/languages/typescript';
import js from 'highlight.js/lib/languages/javascript';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

hljs.registerLanguage('typescript', ts);
hljs.registerLanguage('javascript', js);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
/*
 * The aliases the corpus actually uses, and a build-time refusal for the ones it does not.
 *
 * A fence tagged with a language highlight.js does not have registered falls through to
 * plain escaped text — silently, and it looks like a styling problem rather than a missing
 * registration. `unknownLangs` collects them and the build reports them at the end, which is
 * the same "make the silent case loud" rule the harnesses in TOOLING.md are built on.
 */
hljs.registerAliases(['ts'], { languageName: 'typescript' });
hljs.registerAliases(['js', 'mjs', 'node'], { languageName: 'javascript' });
hljs.registerAliases(['sh', 'shell', 'console', 'zsh'], { languageName: 'bash' });
hljs.registerAliases(['jsonc'], { languageName: 'json' });
hljs.registerAliases(['html'], { languageName: 'xml' });
const unknownLangs = new Set();

const HERE = path.resolve(import.meta.dirname);
const DOCS = path.resolve(HERE, '..');
const ROOT = path.resolve(DOCS, '..');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const OUT = path.resolve(HERE, args.get('out') ?? 'dist');

// ---------------------------------------------------------------------------
// The nav. Order is editorial, not alphabetical.
// ---------------------------------------------------------------------------
/**
 * `src` is relative to `docs/`. `out` is the emitted path, without a leading slash.
 *
 * A volume whose source file does not exist is *skipped with a warning*, not fatal. Three
 * sibling agents are writing SIMULATION, RENDERING and SIEGE on their own branches off the
 * same commit; this site is built to pick them up when they land rather than to block on
 * them. `--strict` turns the warning into an error, which is what the final build before a
 * deploy should use.
 */
const NAV = [
  {
    section: 'Technical volumes',
    blurb: 'How the thing actually works, one subsystem per volume.',
    pages: [
      { src: 'tech/SIMULATION.md', out: 'tech/simulation.html', title: 'Simulation', desc: 'Nine thousand soldiers, the pool that holds them, and the fixed step that moves them.' },
      { src: 'tech/RENDERING.md', out: 'tech/rendering.html', title: 'Rendering', desc: 'Instancing, materials, lighting and the frame budget.' },
      { src: 'tech/SIEGE.md', out: 'tech/siege.html', title: 'Siege', desc: 'Walls, bays, escalade and the orders that move men along a parapet.' },
      { src: 'tech/TOOLING.md', out: 'tech/tooling.html', title: 'Tooling and verification', desc: 'The harnesses, the probes, and the blind A/B instrument.' },
    ],
  },
  {
    section: 'Reference',
    blurb: 'Written for a different reader, and still the best account of what is where.',
    pages: [
      { src: 'ARCHITECTURE.md', out: 'architecture.html', title: 'Architecture', desc: 'Systems, the engine loop, and where a new subsystem goes.' },
      { src: 'CARTHAGE.md', out: 'carthage.html', title: 'Carthage', desc: 'The 146 BC map: survey, fortifications and the city plan.' },
      { src: 'VISUAL-RUBRIC.md', out: 'visual-rubric.html', title: 'Visual rubric', desc: 'The criteria a frame is graded against.' },
      { src: 'RELEASING.md', out: 'releasing.html', title: 'Releasing', desc: 'Commit, deploy, verify by bundle hash, tag, release.' },
    ],
  },
  {
    section: 'Appendix',
    blurb: 'A running log. Useful, long, and not a starting point.',
    pages: [
      { src: 'HANDOFF.md', out: 'appendix/handoff.html', title: 'Handoff log', desc: 'The session-by-session record. Long; search it rather than read it.' },
    ],
  },
];

const STRICT = args.has('strict');
const warnings = [];

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/** GitHub-style slug, so an in-page `#anchor` written for GitHub still resolves here. */
const slug = (s) => s.toLowerCase().trim()
  .replace(/<[^>]+>/g, '')
  .replace(/[^\w\- ]+/g, '')
  .replace(/\s+/g, '-');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * Every `.md` link in the corpus, mapped to its emitted page.
 *
 * The docs link each other with relative paths written for a GitHub tree —
 * `../CHANGELOG.md`, `docs/ARCHITECTURE.md`, `./HANDOFF.md#anchor`. Left alone those become
 * 404s in a flat site, which is the single most common way a documentation build looks fine
 * and is broken. Anything resolving to a page in `NAV` is rewritten to that page; anything
 * resolving to a file in the repo that is *not* published is rewritten to GitHub; anything
 * else is left alone and reported.
 */
const GITHUB = 'https://github.com/eoinest/Total-Claude/blob/main';

function makeRenderer(page, pageSet) {
  const renderer = new marked.Renderer();
  const seen = new Map();

  renderer.heading = function ({ tokens, depth }) {
    const text = this.parser.parseInline(tokens);
    const base = slug(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const id = n ? `${base}-${n}` : base;
    return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${text}</h${depth}>\n`;
  };

  renderer.code = function ({ text, lang }) {
    const name = (lang ?? '').trim().split(/\s+/)[0];
    let body;
    if (name && hljs.getLanguage(name)) {
      body = hljs.highlight(text, { language: name, ignoreIllegals: true }).value;
    } else {
      if (name) unknownLangs.add(name);
      body = esc(text);
    }
    const label = name ? `<span class="lang">${esc(name)}</span>` : '';
    return `<div class="code">${label}<pre><code class="hljs">${body}</code></pre></div>\n`;
  };

  renderer.link = function ({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens);
    const resolved = resolveLink(href, page, pageSet);
    const ext = /^https?:/.test(resolved) ? ' target="_blank" rel="noopener"' : '';
    return `<a href="${esc(resolved)}"${title ? ` title="${esc(title)}"` : ''}${ext}>${text}</a>`;
  };

  renderer.image = function ({ href, title, text }) {
    const resolved = resolveImage(href, page);
    return `<img src="${esc(resolved)}" alt="${esc(text ?? '')}"${title ? ` title="${esc(title)}"` : ''} loading="lazy">`;
  };

  renderer.table = function (token) {
    const head = token.header.map((c) => `<th>${this.parser.parseInline(c.tokens)}</th>`).join('');
    const rows = token.rows.map((r) =>
      `<tr>${r.map((c) => `<td>${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`).join('\n');
    return `<div class="tablewrap"><table><thead><tr>${head}</tr></thead><tbody>\n${rows}\n</tbody></table></div>\n`;
  };

  return renderer;
}

/** Depth of a page below the site root, for building `../` prefixes. */
const upTo = (out) => '../'.repeat(out.split('/').length - 1);

function resolveLink(href, page, pageSet) {
  if (!href) return '#';
  if (/^(https?:|mailto:|#)/.test(href)) return href;

  const [pathPart, hash = ''] = href.split('#');
  const suffix = hash ? `#${slug(decodeURIComponent(hash))}` : '';
  if (!pathPart) return href;

  // Resolve against the source document's directory, inside docs/.
  const fromDir = path.dirname(path.join(DOCS, page.src));
  const abs = path.resolve(fromDir, pathPart);
  const relToDocs = path.relative(DOCS, abs);

  const target = pageSet.get(relToDocs);
  if (target) return `${upTo(page.out)}${target}${suffix}`;

  const relToRoot = path.relative(ROOT, abs);
  if (!relToRoot.startsWith('..')) {
    if (existsSync(abs)) return `${GITHUB}/${relToRoot}${hash ? `#${hash}` : ''}`;
    warnings.push(`${page.src}: link to "${href}" resolves to ${relToRoot}, which does not exist`);
    return `${GITHUB}/${relToRoot}`;
  }
  warnings.push(`${page.src}: link to "${href}" escapes the repository`);
  return href;
}

/** Images resolve into `img/`, and only from `docs/images/`. */
const shippedImages = new Set();
function resolveImage(href, page) {
  if (!href) return '';
  if (/^https?:/.test(href)) {
    warnings.push(`${page.src}: remote image "${href}" — a published page should not hotlink`);
    return href;
  }
  const fromDir = path.dirname(path.join(DOCS, page.src));
  const abs = path.resolve(fromDir, href);
  const rel = path.relative(path.join(DOCS, 'images'), abs);
  if (rel.startsWith('..')) {
    warnings.push(`${page.src}: image "${href}" is outside docs/images/ and was NOT published`);
    return '';
  }
  shippedImages.add(rel);
  return `${upTo(page.out)}img/${rel}`;
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

function navHtml(current, out) {
  const up = upTo(out);
  const parts = [`<a class="brand" href="${up}index.html">Total&nbsp;Claude<span>technical documentation</span></a>`];
  for (const group of NAV) {
    const live = group.pages.filter((p) => p.exists);
    if (!live.length) continue;
    parts.push(`<div class="navgroup"><h4>${group.section}</h4><ul>`);
    for (const p of live) {
      const here = p.out === current ? ' class="here"' : '';
      parts.push(`<li><a href="${up}${p.out}"${here}>${p.title}</a></li>`);
    }
    parts.push('</ul></div>');
  }
  return parts.join('\n');
}

/** A table of contents from the h2/h3 of a page. Long documents are unusable without one. */
function tocHtml(html) {
  const items = [...html.matchAll(/<h([23]) id="([^"]+)">(?:<a[^>]*>#<\/a>)?([\s\S]*?)<\/h[23]>/g)];
  if (items.length < 3) return '';
  const li = items.map(([, d, id, text]) =>
    `<li class="d${d}"><a href="#${id}">${text.replace(/<[^>]+>/g, '')}</a></li>`).join('\n');
  return `<nav class="toc"><h4>On this page</h4><ul>\n${li}\n</ul></nav>`;
}

function shell({ title, out, body, toc, desc }) {
  const up = upTo(out);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Total Claude</title>
${desc ? `<meta name="description" content="${esc(desc)}">` : ''}
<link rel="stylesheet" href="${up}style.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="layout">
<aside class="sidebar">${navHtml(out, out)}
<div class="navgroup"><h4>Elsewhere</h4><ul>
<li><a href="https://total-claude.vercel.app" target="_blank" rel="noopener">Play the game</a></li>
<li><a href="${GITHUB}/README.md" target="_blank" rel="noopener">Repository</a></li>
</ul></div>
</aside>
<main id="main">
${toc}
<article class="prose">
${body}
</article>
</main>
</div>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// The safety check that gives the image rule teeth
// ---------------------------------------------------------------------------
/**
 * Refuse to finish a build that is about to publish anything from `reference/` or
 * `reference-crops/`.
 *
 * The check is on the *emitted HTML*, after every rewrite, not on the Markdown source —
 * because the thing that must be true is about the artefact, and a rule enforced anywhere
 * earlier is a rule about intent. Every `src` in every page must resolve to a file that was
 * copied out of `docs/images/`, and the output tree must contain no path naming a reference
 * directory.
 */
async function assertNoReferenceImagery(outDir, pages) {
  const problems = [];
  const BANNED = /(^|\/)(reference|reference-crops)(\/|$)/;

  for (const p of pages) {
    const html = await readFile(path.join(outDir, p.out), 'utf8');
    for (const [, src] of html.matchAll(/<img[^>]+src="([^"]*)"/g)) {
      if (/^https?:/.test(src)) { problems.push(`${p.out}: remote image ${src}`); continue; }
      if (!src) { problems.push(`${p.out}: an image was dropped and left an empty src`); continue; }
      const rel = src.replace(/^(\.\.\/)+/, '');
      if (!rel.startsWith('img/')) { problems.push(`${p.out}: image outside img/ — ${src}`); continue; }
      if (!existsSync(path.join(outDir, rel))) problems.push(`${p.out}: ${src} does not exist in the output`);
    }
  }

  const walk = async (dir) => {
    const out = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(full)));
      else out.push(path.relative(outDir, full).split(path.sep).join('/'));
    }
    return out;
  };
  const shipped = await walk(outDir);
  for (const f of shipped) if (BANNED.test(f)) problems.push(`output contains a reference path: ${f}`);

  // Belt and braces: every published raster must be byte-identical to one in docs/images/.
  const rasters = shipped.filter((f) => /\.(png|jpe?g|webp|avif|gif)$/i.test(f));
  for (const r of rasters) {
    if (!r.startsWith('img/')) { problems.push(`raster outside img/: ${r}`); continue; }
    const origin = path.join(DOCS, 'images', r.slice('img/'.length));
    if (!existsSync(origin)) problems.push(`published raster has no origin in docs/images/: ${r}`);
  }

  if (problems.length) {
    console.error('\nREFUSED — the image rule failed:');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(3);
  }
  return { rasters: rasters.length };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

marked.use({ gfm: true, breaks: false });

for (const g of NAV) {
  for (const p of g.pages) {
    p.exists = existsSync(path.join(DOCS, p.src));
    if (!p.exists) warnings.push(`MISSING volume: docs/${p.src} — skipped, nav omits it`);
  }
}
const pages = NAV.flatMap((g) => g.pages).filter((p) => p.exists);
const pageSet = new Map(pages.map((p) => [p.src, p.out]));

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (const p of pages) {
  const md = await readFile(path.join(DOCS, p.src), 'utf8');
  const html = marked.parse(md, { renderer: makeRenderer(p, pageSet) });
  const toc = tocHtml(html);
  await mkdir(path.dirname(path.join(OUT, p.out)), { recursive: true });
  await writeFile(path.join(OUT, p.out), shell({ title: p.title, out: p.out, body: html, toc, desc: p.desc }));
  p.bytes = Buffer.byteLength(html);
  p.words = md.split(/\s+/).length;
}

// The index. Written here rather than in Markdown because it is generated from NAV — a
// volume that lands later appears on it without anyone remembering to add a line.
{
  const cards = NAV.map((g) => {
    const live = g.pages.filter((p) => p.exists);
    if (!live.length) return '';
    return `<section class="group">
<h2 id="${slug(g.section)}">${g.section}</h2>
<p class="blurb">${g.blurb}</p>
<div class="cards">
${live.map((p) => `<a class="card" href="${p.out}"><h3>${p.title}</h3><p>${esc(p.desc)}</p></a>`).join('\n')}
</div>
</section>`;
  }).join('\n');

  const pending = NAV.flatMap((g) => g.pages).filter((p) => !p.exists);
  const pendingHtml = pending.length
    ? `<section class="group"><h2 id="not-yet-published">Not yet published</h2>
<p class="blurb">These volumes are being written on their own branches. This site is built to
pick them up as soon as their Markdown lands in <code>docs/</code>; nothing else has to change.</p>
<ul class="pending">${pending.map((p) => `<li><strong>${p.title}</strong> — <code>docs/${p.src}</code></li>`).join('')}</ul></section>`
    : '';

  /*
   * The one image on the site, and it goes through the same allowlist as any other.
   * `shippedImages` is what the copy pass and `assertNoReferenceImagery` both read, so a
   * hero added here cannot bypass the check that a published raster came from docs/images/.
   */
  const HERO = 'wall.jpg';
  shippedImages.add(HERO);

  const body = `<h1 id="total-claude">Total Claude — technical documentation</h1>
<img class="hero" src="img/${HERO}" alt="The Aurelian Wall in raking light, the Juthungi host beyond it and Rome behind — a frame from the game's own screenshot harness.">
<p class="lede">A real-time historical battle simulator in TypeScript and Three.js: roughly nine
thousand individually simulated soldiers, the Aurelian Wall of Rome in 271 AD and Carthage in
146 BC. <a href="https://total-claude.vercel.app" target="_blank" rel="noopener">Play it here</a>.</p>
<p>These pages are written for somebody who has to change the code, not for somebody deciding
whether to try the game. Each volume assumes you will have the repository open beside it, and
names files and symbols rather than describing them.</p>
${cards}
${pendingHtml}
<hr>
<p class="foot">Built from the documentation in <code>docs/</code>. Every image on this site is
our own render.</p>`;
  await writeFile(path.join(OUT, 'index.html'), shell({ title: 'Technical documentation', out: 'index.html', body, toc: '', desc: 'Technical documentation for Total Claude, a Three.js real-time historical battle simulator.' }));
}

await cp(path.join(HERE, 'style.css'), path.join(OUT, 'style.css'));

// Images: copied one at a time, only the ones a page actually referenced, only from
// docs/images/. A glob copy of the directory would ship whatever happened to be in it.
if (shippedImages.size) {
  for (const rel of shippedImages) {
    const from = path.join(DOCS, 'images', rel);
    const to = path.join(OUT, 'img', rel);
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to);
  }
}

const audit = await assertNoReferenceImagery(OUT, pages);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
let total = 0;
const files = [];
const walkOut = async (dir) => {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkOut(full);
    else { const s = await stat(full); total += s.size; files.push(path.relative(OUT, full)); }
  }
};
await walkOut(OUT);

console.log(`\n${pages.length} page${pages.length === 1 ? '' : 's'} + index → ${path.relative(ROOT, OUT)}`);
for (const p of pages) console.log(`  ${p.out.padEnd(28)} ${String(p.words).padStart(6)} words`);
console.log(`  ${files.length} files, ${(total / 1024).toFixed(0)} KiB, ${audit.rasters} image(s), all from docs/images/`);

for (const l of unknownLangs) warnings.push(`no highlighter registered for \`\`\`${l} — rendered plain`);

if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  ${w}`);
}
const missing = NAV.flatMap((g) => g.pages).filter((p) => !p.exists);
if (STRICT && missing.length) {
  console.error(`\n✗ --strict: ${missing.length} volume(s) missing`);
  process.exit(1);
}
console.log(`\n✓ built`);
