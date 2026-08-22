/**
 * The judge's control table: where things are, read from OUTSIDE the repo.
 *
 * `tools/probe-fabric.mjs` states its blind spot plainly — *"it can prove a footprint is the
 * wrong SIZE and it cannot prove it is in the wrong PLACE"* — and `docs/MAP-METHOD.md` §3
 * records the fix it could not afford: *"budget the digitising. Twenty monuments' corner
 * coordinates read off the georeferenced Lanciani raster, in a table shaped like PUBLISHED,
 * turns the whole position question into a gate."* This is that table.
 *
 * Every row carries `how`, and `how` is the whole value of the file:
 *
 *   'plate'     — read off `reference/rome-plans/lanciani-georef-EPSG3004-…-4096px.png` this
 *                 pass, by cropping the raster at the row's nominal position through
 *                 `overlay.ts`'s own affine (1.71 m/px, worst residual 1.26 m over 7 km),
 *                 drawing a 50 m survey-metre grid on the crop, and reading the inked plan's
 *                 centre off that grid. `err` is the reader's own estimate of how well the
 *                 inked feature can be centred, and is never better than 15 m because the
 *                 plate resolves the Pantheon's rotunda as 34 px.
 *   'gazetteer'  — WGS84 latitude and longitude, converted with the same origin and the same
 *                 local metre-per-degree constants the survey's own `cite` fields imply.
 *                 Independent of the repo but NOT confirmed on the plate this pass.
 *   'survey'     — I could not better the survey's own value. **A row marked 'survey' is not
 *                 evidence and the position criterion is UNGRADED for it.** Never scored.
 *
 * Nothing here is read from `src/`. Where this table and `survey.ts` disagree the disagreement
 * is the measurement.
 */
export const CONTROL = [
  // --- read off the plate this pass -----------------------------------------
  { id: 'stadium-domitian', e: -762, n: 745, err: 20, how: 'plate',
    note: 'the inked stadium plan at Piazza Navona coincides with the survey rectangle to within the reading error: sphendone at the north, arena, both long sides.' },
  { id: 'mausoleum-augustus', e: -481, n: 1500, err: 20, how: 'plate',
    note: 'the concentric-ring tumulus plan is centred inside the survey square.' },
  { id: 'colosseum', e: 839, n: -249, err: 20, how: 'plate',
    note: 'outer ellipse extremes read on the 50 m grid: centre +19 E, +7 N of the survey row. Major axis read at 113-117 deg against the survey 115.' },
  { id: 'pantheon', e: -447, n: 655, err: 25, how: 'plate',
    note: 'rotunda centred; the survey box (84 long, entrance axis) puts its centre ~23 m south of the rotunda centre, which is right for rotunda + portico but the row centre reads ~23 m south of where the box centre should sit.' },
  { id: 'castra-praetoria', e: 2032, n: 1532, err: 35, how: 'plate',
    note: 'four wall corners read off the 50 m grid; camp centre +93 E, +65 N of the survey row. North wall bears 69 deg, east wall 165 deg, east side 434 m — so the long axis really is ~345/165 and the survey bearing 340 is right to ~5 deg.' },
  { id: 'tiber-island', e: -404, n: -207, err: 25, how: 'plate',
    note: 'island outline centre reads 39 m west and 18 m south of the survey row; 34 m of that is perpendicular to a 67 m wide island.' },
  { id: 'theatre-pompey', e: -700, n: 270, err: 45, how: 'plate',
    note: 'the cavea arc lies OUTSIDE the survey rectangle to the east. Cavea centre of curvature reads e -721 n +297; the whole complex (cavea west + quadriporticus east) centres near e -700. The survey row is ~136 m too far west.' },
  { id: 'theatre-marcellus', e: -215, n: -78, err: 30, how: 'plate',
    note: 'cavea sits inside the survey box; no measurable displacement at 30 m reading error.' },

  // --- WGS84, not confirmed on the plate this pass ---------------------------
  // Only `baths-nero` is genuinely independent: the rest turned out to restate survey.ts's own
  // cite to four decimals, which is a check comparing a thing against itself.
  { id: 'baths-nero', lat: 41.8990, lon: 12.4758, err: 60, how: 'gazetteer',
    note: 'Thermae Neronianae/Alexandrinae ran from the Pantheon NORTH toward the Stadium (Palazzo Madama / S. Eustachio). The survey puts them 58 m SOUTH of the Pantheon; the gazetteer puts them 45 m NORTH.' },
  { id: 'baths-agrippa', lat: 41.8977, lon: 12.4771, err: 40, how: 'restated' },
  { id: 'largo-argentina', lat: 41.8955, lon: 12.4768, err: 30, how: 'restated' },
  { id: 'mausoleum-hadrian', lat: 41.9031, lon: 12.4663, err: 25, how: 'restated' },
  { id: 'forum-romanum', lat: 41.8925, lon: 12.4853, err: 40, how: 'restated' },
  { id: 'temple-jupiter', lat: 41.8925, lon: 12.4823, err: 20, how: 'restated',
    note: 'the survey origin. Graded so that a build which moves the origin is caught.' },
  { id: 'trajan-column', lat: 41.8959, lon: 12.4843, err: 15, how: 'restated',
    note: 'the column still stands; its position is known to a metre.' },
  { id: 'circus-maximus', lat: 41.8859, lon: 12.4853, err: 40, how: 'restated' },
  { id: 'palatine', lat: 41.8887, lon: 12.4869, err: 70, how: 'restated' },
  { id: 'baths-caracalla', lat: 41.8790, lon: 12.4925, err: 40, how: 'restated' },

  // --- not bettered this pass: position UNGRADED ----------------------------
  { id: 'ara-pacis', how: 'survey' },
  { id: 'horologium', how: 'survey' },
  { id: 'temple-isis', how: 'survey' },
  { id: 'porticus-octaviae', how: 'survey',
    note: 'screened on the plate and NOT settled: the colonnaded enclosure I take for the quadriportico reads ~200 m east of the survey row, but I could not separate it from the Crypta Balbi at the reading scale. Needs a dedicated crop.' },
  { id: 'tabularium', how: 'survey' },
  { id: 'basilica-ulpia', how: 'survey' },
  { id: 'trajan-market', how: 'survey' },
  { id: 'imperial-fora', how: 'survey' },
  { id: 'ludus-magnus', how: 'survey' },
  { id: 'baths-titus', how: 'survey' },
  { id: 'baths-trajan', how: 'survey' },
  { id: 'temple-serapis', how: 'survey' },
  { id: 'gardens-sallust', how: 'survey' },
  { id: 'aventine-temples', how: 'survey' },
  { id: 'caelian-villas', how: 'survey' },
  { id: 'janiculum', how: 'survey' },
];

/**
 * The Tiber's centreline, as sixteen modern bridge midpoints in WGS84.
 *
 * A bridge midpoint is on the channel centreline by construction, which makes this the one
 * river control that needs no ink-reading judgement at all. Verified against the plate as a
 * polyline: `/tmp/judge/river-on-plate.png` shows the green control tracking Lanciani's blue
 * channel through the whole city reach. The nineteenth-century embankments narrowed the
 * channel roughly symmetrically, so the modern centreline is the ancient one to within a few
 * tens of metres — which is an order of magnitude below the departures being measured.
 */
export const TIBER_CONTROL = [
  ['Ponte Milvio', 41.9351, 12.4667], ['Ponte Duca d Aosta', 41.9296, 12.4691],
  ['Ponte Risorgimento', 41.9203, 12.4707], ['Ponte Matteotti', 41.9146, 12.4726],
  ['Ponte Regina Margherita', 41.9109, 12.4741], ['Ponte Cavour', 41.9060, 12.4741],
  ['Ponte Umberto I', 41.9020, 12.4715], ['Ponte Sant Angelo', 41.9017, 12.4665],
  ['Ponte Vittorio Emanuele II', 41.8977, 12.4650], ['Ponte Mazzini', 41.8945, 12.4663],
  ['Ponte Sisto', 41.8930, 12.4700], ['Ponte Garibaldi', 41.8918, 12.4749],
  ['Ponte Fabricio', 41.8917, 12.4779], ['Ponte Palatino', 41.8894, 12.4788],
  ['Ponte Sublicio', 41.8829, 12.4757], ['Ponte Testaccio', 41.8748, 12.4713],
];

/**
 * Published plan dimensions, metres, long x short. Copied from the literature with a source
 * per row, never from `survey.ts`. Deliberately overlaps `tools/probe-fabric.mjs`'s
 * `PUBLISHED`: two independent transcriptions of the same literature that disagree is itself
 * a finding, and agreeing costs nothing.
 */
export const PUBLISHED = {
  colosseum: [189, 156, 'Platner-Ashby s.v. Amphitheatrum Flavium; 188 x 156 also given'],
  pantheon: [84, 58, 'rotunda 58 m external diameter; 84 x 58 overall with the forecourt'],
  'stadium-domitian': [275, 106, 'Platner-Ashby s.v. Stadium Domitiani'],
  'mausoleum-augustus': [87, 87, '300 pedes diameter; Platner-Ashby'],
  'castra-praetoria': [437, 380, 'Platner-Ashby s.v. Castra Praetoria; measured 434 m on the east side off the plate this pass'],
  'theatre-marcellus': [129.8, 115, 'external diameter 129.8 m'],
  'circus-maximus': [621, 118, 'Humphrey, Roman Circuses (1986) 56-131 — TRACK 621 x 118; 621 x 190 is the outer envelope'],
  'baths-caracalla': [218, 112, 'bathing block; the precinct is 337 x 328'],
  'porticus-octaviae': [132, 119, 'Severan Marble Plan'],
  'temple-jupiter': [63, 53, 'podium; Platner-Ashby'],
  'temple-isis': [200, 50, 'Digital Augustan Rome; 240 x 60 also given. survey.ts models 70 x 34'],
  'ara-pacis': [11.625, 10.55, 'enclosure'],
  'tiber-island': [270, 67, 'the ancient island, not the 446 x 116 modern outline'],
  'basilica-ulpia': [130, 55, 'Platner-Ashby'],
};

/**
 * The Tiber's channel centre, READ OFF THE PLATE, at five stations on the reach the assault
 * is fought beside. This supersedes `TIBER_CONTROL` where the two disagree, and they do.
 *
 * Method: `tools/judge/crop2.mjs` at 1.02 m/px with a 100 m survey-metre grid drawn through
 * `overlay.ts`'s own affine, centred (-800, 1900); the channel's two banks read off that grid
 * and the midpoint taken. Reading error ~25 m per station — the inked channel is 60-90 plate
 * metres wide and this is the centre of it by eye.
 *
 * **Why `TIBER_CONTROL` is demoted to corroboration.** Two of its bridge midpoints (Regina
 * Margherita, Cavour) were recalled at the same longitude, which makes the control's channel
 * run straight through the reach where the plate shows it swinging 129 m east. A control that
 * is too straight cannot grade a river for being too straight. Measured: the control sits
 * 41 m and 54 m from the plate's channel at those two stations. Recorded rather than deleted,
 * because a corroborating instrument that disagrees by a known amount is worth more than one
 * that has been quietly dropped.
 */
export const TIBER_PLATE = [
  { n: 2256, e: -841, err: 25 },
  { n: 2001, e: -805, err: 25 },
  { n: 1747, e: -754, err: 25 },
  { n: 1499, e: -676, err: 25 },
  { n: 1414, e: -652, err: 25 },
];

/**
 * The Aurelian circuit's gates, READ OFF THE PLATE. Lanciani draws the wall as hatched
 * masonry and labels each gate; these are the gate structures' own centres, read on a 50 m
 * survey-metre grid at 0.64 m/px. Reading error ~20 m.
 *
 * `ROME_CIRCUIT_SURVEY`'s fourteen waypoints carry **no `cite` field at all** — they are the
 * only survey on this map with no source per row, and they are the line the whole battle is
 * fought on. This table is what they should have been checked against.
 */
export const CIRCUIT_PLATE = [
  { id: 'porta-flaminia', e: -497, n: 2131, err: 20, note: 'Porta del Popolo, at the north end of the inked oval piazza; longitude agrees with the survey to under a metre.' },
  { id: 'posterula-pinciana', e: 501, n: 1886, err: 20, note: 'labelled PORTA PINCIANA on the plate; the gate still stands.' },
  { id: 'porta-salaria', e: 1305, n: 2024, err: 25, note: 'labelled PORTA SALARIA. The surveyed waypoint sits in open ground inside the Horti Sallustiani, 235 m south of the inked wall.' },
  { id: 'porta-nomentana', e: 1633, n: 1788, err: 25, note: 'labelled PORTA NOMENTANA; the gate still stands beside the British Embassy.' },
  { id: 'castra-nw', e: 1767, n: 1698, err: 35, note: "the camp's north-west angle where the curtain runs into it." },
  { id: 'tiber-angle', e: -731, n: 1955, err: 60, note: 'the wall corner where the circuit turns south for the river. Read at 1.02 m/px and the least certain row here: the sheet mosaic has a seam across this reach.' },
];
