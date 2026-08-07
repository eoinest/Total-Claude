/**
 * The config layer, exercised in the live page rather than in a unit test that does not exist.
 *
 * Three things this checks and nothing else does:
 *
 *  1. **`encodeConfig`/`decodeConfig` round-trips every map, including the new one.** The
 *     token is base64url of JSON and `decodeConfig` runs the result back through
 *     `sanitiseConfig`, so a field the sanitiser does not know about is silently dropped and a
 *     shared link quietly describes a different battle. A new `MapId` is exactly the kind of
 *     field that gets dropped: `isMapId` is a registry lookup, so a map missing from `MAPS`
 *     decodes to the Campus Martius and nobody notices until a screenshot is of the wrong
 *     place.
 *  2. **`sanitiseConfig` refuses an assault on a map with no wall**, from both directions —
 *     asking for one on open ground, and switching a stored assault onto an open-ground map.
 *  3. **Every map in the menu actually loads**, which is the only test that catches a map
 *     whose module throws at init.
 *
 * Usage: `node tools/probe-mapconfig.mjs --port=5847`
 *
 * The modules are imported *in the page*, so this grades the source the dev server is serving
 * rather than a copy of the logic reimplemented here — which is the failure mode of every
 * config test this project could have written in node.
 */
import { chromium } from 'playwright';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? '1'];
  }),
);
const PORT = Number(args.get('port') ?? 5847);
const base = `http://127.0.0.1:${PORT}`;

console.log(`[mapconfig] ${base}`);

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`CONSOLE ${m.text()}`);
});

// A bare page on the same origin, so a module import resolves against the dev server.
await page.goto(`${base}/?menu=0&harness=1&w=320&h=200`, { waitUntil: 'domcontentloaded' });

const out = await page.evaluate(async () => {
  const cfgMod = await import('/src/sim/battleConfig.ts');
  const mapMod = await import('/src/maps/index.ts');
  const {
    DEFAULT_CONFIG, encodeConfig, decodeConfig, sanitiseConfig, scenarioFor, SCENARIOS,
  } = cfgMod;
  const { MAPS, getMap, isMapId } = mapMod;

  const rows = [];
  const fail = [];

  for (const m of MAPS) {
    const hasCity = getMap(m.id).city !== null;

    // 1. Round-trip, with a non-default value in every field the token carries.
    const src = sanitiseConfig({
      ...DEFAULT_CONFIG,
      map: m.id,
      scenario: hasCity ? 'assault' : 'field',
      unitSize: 'large',
      timeOfDay: 13,
      seed: 0xdeadbeef,
      difficulty: 'legendary',
      quality: 'medium',
    });
    const back = decodeConfig(encodeConfig(src));
    if (!back) fail.push(`${m.id}: token did not decode`);
    else {
      for (const k of Object.keys(src)) {
        const a = JSON.stringify(src[k]);
        const b = JSON.stringify(back[k]);
        if (a !== b) fail.push(`${m.id}: ${k} round-tripped ${a} -> ${b}`);
      }
    }

    // 2. The one pairing that cannot exist, from both directions.
    const asked = sanitiseConfig({ ...DEFAULT_CONFIG, map: m.id, scenario: 'assault' });
    if (hasCity && asked.scenario !== 'assault') fail.push(`${m.id}: has a wall but refused an assault`);
    if (!hasCity && asked.scenario !== 'field') fail.push(`${m.id}: has no wall but allowed an assault`);

    if (!isMapId(m.id)) fail.push(`${m.id}: not recognised by isMapId`);

    rows.push({
      id: m.id,
      city: hasCity ? getMap(m.id).city.name : '—',
      garrison: hasCity ? getMap(m.id).city.garrison : '—',
      hour: m.sky.defaultHour,
      lat: m.site.latitudeDeg,
      dec: m.site.declinationDeg,
      fieldSub: scenarioFor('field', m.id).subtitle,
      assaultSub: scenarioFor('assault', m.id).subtitle,
      token: encodeConfig(sanitiseConfig({ ...DEFAULT_CONFIG, map: m.id })),
    });
  }

  // 3. A garbage token must not throw and must not lose the player their battle.
  if (decodeConfig('not-a-token') !== null) fail.push('a garbage token decoded to something');
  const scenarioIds = SCENARIOS.map((s) => s.id).join(',');

  return { rows, fail, scenarioIds };
});

await browser.close();

for (const r of out.rows) {
  console.log(
    `  ${r.id.padEnd(15)} city ${String(r.city).padEnd(9)} garrison ${String(r.garrison).padEnd(3)}` +
      ` ${r.lat}N dec ${r.dec} @${r.hour}h  "${r.fieldSub}" / "${r.assaultSub}"`
  );
  console.log(`  ${''.padEnd(15)} ?battle=${r.token}`);
}
console.log(`  scenarios: ${out.scenarioIds}`);

const bad = [...out.fail, ...errors];
if (bad.length) {
  console.log(`\n[mapconfig] FAIL — ${bad.length}:`);
  for (const b of bad) console.log(`  ${b}`);
} else {
  console.log(`\n[mapconfig] PASS — ${out.rows.length} maps round-trip, assault gating holds`);
}
process.exit(bad.length ? 1 : 0);
