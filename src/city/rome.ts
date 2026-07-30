import { HALF_EXTENT } from '../terrain/TerrainSystem';
import { crestZAt, RIVER_HALF_WIDTH, riverCentreX, roadCentreX } from '../terrain/topography';
import { clamp } from '../util/math';

/**
 * The real plan of imperial Rome, and the projection that puts it on the battlefield.
 *
 * ## Why this file exists
 *
 * The city used to be authored as two hundred hand-typed battlefield coordinates. That
 * is unfalsifiable: nothing in the file said where a monument *actually* is, so nothing
 * could catch the Circus Maximus being laid across the Palatine, and nothing could tell
 * you whether the Colosseum was east of the Forum or west of it. Here every monument
 * carries its measured position and size in **real metres**, and the battlefield
 * coordinates are computed. Getting Rome wrong now requires getting the survey wrong.
 *
 * ## Frame
 *
 * `e` and `n` are metres **east** and **north** of the Temple of Jupiter Optimus
 * Maximus on the Capitoline (41.8925 N, 12.4823 E), converted from WGS84 at
 * 111,132 m/° of latitude and 82,857 m/° of longitude (the value at 41.89 N).
 * `bearing` is the compass bearing of the building's **long axis**, degrees clockwise
 * from north — so 90 is a building whose length runs east–west.
 *
 * Sources for the positions and dimensions, per monument, are cited in `ROME` below.
 * The general framework is:
 *
 *  - Rodolfo Lanciani, *Forma Urbis Romae* (Milan 1893–1901), the standard
 *    archaeological plan at 1:1000; public domain.
 *    https://commons.wikimedia.org/wiki/Category:Forma_Urbis_Romae_(Lanciani)
 *  - Samuel Ball Platner & Thomas Ashby, *A Topographical Dictionary of Ancient Rome*
 *    (Oxford 1929); public domain, transcribed at
 *    https://penelope.uchicago.edu/Thayer/E/Gazetteer/Places/Europe/Italy/Lazio/Roma/Rome/_Texts/PLATOP/home.html
 *  - The Severan Marble Plan, *Forma Urbis Romae* (c. AD 203–211), and the Stanford
 *    Digital Forma Urbis Romae Project, https://formaurbis.stanford.edu/
 *  - Italo Gismondi's *Plastico di Roma imperiale* (Museo della Civiltà Romana),
 *    the canonical 1:250 model of the Constantinian city.
 *
 * ## Projection
 *
 * `worldOf` is a plain anisotropic affine map: `x = X0 + KX·e`, `z = Z0 − KZ·n`.
 * The battlefield only offers ~940 m of depth between the wall crest and the edge of
 * the heightfield for Rome's ~3.3 km of north–south extent, so depth is compressed
 * 4.5× and width 2.2×. The two anchors are non-negotiable and both come from the
 * terrain:
 *
 *  - the **Porta Flaminia** must sit where the Via Flaminia crosses the crest, because
 *    the terrain cuts a saddle for it there (`roadCentreX ∘ crestZAt`);
 *  - the **Castra Praetoria** must sit at the east end of the curtain, because Aurelian
 *    incorporated the camp's own north and east walls into the circuit.
 *
 * With `KX = 0.45` those two anchors are 2,436 real metres and 1,078 world metres
 * apart, which is where `KX` comes from rather than being a taste decision. `KZ = 0.22`
 * is then the largest value that fits the Baths of Caracalla inside the heightfield.
 *
 * A monument's *footprint* is compressed too, by `PLAN_SCALE` in layout.ts, and only there.
 * Positions compress by 0.443 × 0.222 and a building at 1:1 therefore covers ten times its
 * real share of the ground: summed over this table the masonry comes to 727,000 m² against
 * about 1.7 M m² of buildable city, and the overlap resolver had to move every monument 174
 * world metres on average — 560 real metres of depth — to make it fit. Heights are untouched.
 * The measurement behind the number is tabulated at `PLAN_SCALE`.
 *
 * Anisotropy rotates plan angles, so `worldBearing` transforms the long axis through
 * the same map instead of copying the compass bearing — otherwise the Circus Maximus
 * would sit at its true 142° in a frame that has squashed north–south by 2× relative
 * to east–west, and its ends would land 100 m off the valley floor.
 *
 * Everything on the **far bank** is placed relative to the terrain's own meander
 * instead, because the modelled Tiber is a fixed analytic curve that does not agree
 * with a scaled real one (see `FAR_BANK`).
 */

// ---------------------------------------------------------------------------
// The survey
// ---------------------------------------------------------------------------

/** Which of Rome's hills or valleys a monument stands on. Documentation, and used to
 *  bias the insula-density map so the fabric thins out on the hilltops. */
export type Terrain =
  | 'capitoline'
  | 'palatine'
  | 'aventine'
  | 'caelian'
  | 'esquiline'
  | 'viminal'
  | 'quirinal'
  | 'pincian'
  | 'campus-martius'
  | 'forum-valley'
  | 'vallis-murcia'
  | 'colosseum-valley'
  | 'velabrum'
  | 'trans-tiberim';

export interface RomeMonument {
  id: string;
  name: string;
  /** Metres east of the Temple of Jupiter OM. */
  e: number;
  /** Metres north of the Temple of Jupiter OM. */
  n: number;
  /** Real plan length along the long axis, metres. */
  len: number;
  /** Real plan width across the long axis, metres. */
  wid: number;
  /**
   * Compass bearing, degrees clockwise from north.
   *
   * For `axis: 'x'` (the default) it is the bearing of the **long axis** of the plan.
   * For `axis: 'z'` it is the direction you face **standing at the front looking in** —
   * temples, theatres and the Pantheon are built with their entrance at local −Z, so this
   * is what actually decides which way a portico or a cavea faces.
   */
  bearing: number;
  /** Which local axis carries `len`. Temples, theatres and the Pantheon are 'z'. */
  axis?: 'x' | 'z';
  where: Terrain;
  /** Artificial podium or hill height above sampled terrain, metres. */
  mound?: number;
  /** Plan radius of the mound, metres. Defaults to the footprint's circumradius. */
  moundRadius?: number;
  /** Placed against the terrain's river instead of by the affine map. */
  farBank?: boolean;
  /** Placed on the terrain's river centreline (Tiber Island). */
  onRiver?: boolean;
  /**
   * Landscape rather than masonry — gardens, a planted hill, an island. Soft footprints
   * keep the insula generator out but are exempt from the monument-overlap resolver and
   * its assertion, because a temple standing in the middle of the Horti Sallustiani is
   * how Rome actually worked.
   */
  soft?: boolean;
  /**
   * Fraction of the footprint's depth that may sit *north* of the wall crest. Aurelian's
   * circuit took the Castra Praetoria's own north wall into the curtain, and it was driven
   * straight through the Horti Sallustiani, cutting the gardens in two — so both of those
   * belong at the wall rather than set back inside it.
   */
  atWall?: number;
  /** May run out to the very east edge of the heightfield. See the Castra Praetoria. */
  offMapEast?: boolean;
  /** Notes and the source for this entry. */
  cite: string;
}

/**
 * Rome in 271 AD, north to south. Only what a camera on the Campus Martius can see or
 * walk to: the deep south-east (Baths of Caracalla aside), the Vatican fields and the
 * Amphitheatrum Castrense are past the edge of the heightfield.
 */
export const ROME: readonly RomeMonument[] = [
  // ---- northern Campus Martius, inside the Porta Flaminia -----------------
  {
    id: 'mausoleum-augustus',
    name: 'Mausoleum of Augustus',
    e: -481, n: 1500, len: 87, wid: 87, bearing: 0,
    where: 'campus-martius',
    cite: '41.9060 N 12.4765 E. Circular tumulus 87 m across, c. 42 m tall; Strabo V.3.8 for the ' +
      'planted terraces and the bronze Augustus. Platner-Ashby s.v. Mausoleum Augusti.',
  },
  {
    id: 'ara-pacis',
    name: 'Ara Pacis Augustae',
    e: -315, n: 1278, len: 11.6, wid: 10.6, bearing: 88,
    where: 'campus-martius',
    cite: 'Original site under Palazzo Fiano, Via in Lucina (41.9040 N 12.4785 E) — not the ' +
      '1938 riverside pavilion. Enclosure 11.6 × 10.6 m, dedicated 9 BC.',
  },
  {
    id: 'horologium',
    name: 'Horologium Augusti',
    e: -323, n: 1011, len: 20, wid: 20, bearing: 0,
    where: 'campus-martius',
    cite: 'Obelisk of Psammetichus II found at Via di Campo Marzio (41.9016 N 12.4784 E), ' +
      '21.8 m of red granite; the meridian line ran north toward the Ara Pacis. Pliny NH 36.72.',
  },
  {
    id: 'stadium-domitian',
    name: 'Stadium of Domitian',
    e: -762, n: 745, len: 275, wid: 106, bearing: 177,
    where: 'campus-martius',
    cite: '41.8992 N 12.4731 E; the plan survives as Piazza Navona. 276 × 106 m, arena ' +
      '193 × 54, c. 30,000 *loca*. Axis 356.6°/176.6°, sphendone at the **north** — hence ' +
      'bearing 177, because the builder puts the sphendone at local −X.',
  },
  {
    id: 'baths-nero',
    name: 'Baths of Nero',
    e: -560, n: 620, len: 190, wid: 120, bearing: 8,
    where: 'campus-martius',
    cite: 'Thermae Neronianae, later Alexandrinae, immediately east of the Stadium between it ' +
      'and the Pantheon (41.8985 N 12.4757 E). Platner-Ashby s.v. Thermae Neronianae.',
  },
  {
    id: 'pantheon',
    name: 'Pantheon',
    e: -447, n: 678, len: 84, wid: 58, bearing: 176, axis: 'z',
    where: 'campus-martius',
    cite: '41.8986 N 12.4769 E. Rotunda 58 m external / 43.3 m internal diameter, dome apex ' +
      '43.3 m; pronaos 33.1 × 15.5 m facing north, 3.7° west of true north (Hannah & Magli ' +
      'give 354.5° for the axis), hence bearing 176 looking in on the `axis: z` convention. ' +
      'Hadrianic, c. AD 126.',
  },
  {
    id: 'baths-agrippa',
    name: 'Baths of Agrippa',
    e: -423, n: 556, len: 120, wid: 100, bearing: 3,
    where: 'campus-martius',
    cite: '41.8975 N 12.4772 E, directly south of the Pantheon and fed by the Aqua Virgo; ' +
      'Rome first public thermae, 25 BC.',
  },
  {
    id: 'temple-isis',
    name: 'Iseum Campense',
    e: -300, n: 560, len: 70, wid: 34, bearing: 270, axis: 'z',
    where: 'campus-martius',
    cite: 'Iseum et Serapeum in Campo Martio, east of the Baths of Agrippa on the line of the ' +
      'modern Via del Seminario (41.8976 N 12.4787 E). Obelisks now on Piazza della Minerva ' +
      'and Piazza della Rotonda.',
  },
  {
    id: 'largo-argentina',
    name: 'Temples of the Area Sacra',
    e: -464, n: 333, len: 90, wid: 60, bearing: 8,
    where: 'campus-martius',
    cite: 'Four republican temples on a shared podium line, 41.8955 N 12.4767 E; the Curia of ' +
      'Pompey stood behind them. Excavated 1926-9.',
  },
  {
    id: 'theatre-pompey',
    name: 'Theatre of Pompey',
    e: -836, n: 244, len: 300, wid: 180, bearing: 89, axis: 'z',
    where: 'campus-martius',
    cite: '41.8947 N 12.4722 E. Rome\'s first stone theatre (55 BC): cavea c. 150 m across ' +
      'with the Temple of Venus Victrix at its summit, opening ENE onto the stage, and the ' +
      'quadriporticus running a further 150 m behind it — so the complex is c. 300 × 180. ' +
      'A circle fit to the surviving cavea arc gives 89°/269°: the cavea opens **due east** ' +
      'onto the stage, the Temple of Venus Victrix at its west summit. Platner-Ashby s.v. ' +
      'Theatrum Pompei.',
  },
  {
    id: 'porticus-octaviae',
    name: 'Porticus Octaviae',
    e: -300, n: -60, len: 132, wid: 119, bearing: 26.5,
    where: 'campus-martius',
    cite: '41.8925 N 12.4784 E, the double-temple precinct of Juno Regina and Jupiter Stator ' +
      'north of the Theatre of Marcellus. 132 × 119 m per the Severan Marble Plan.',
  },
  {
    id: 'theatre-marcellus',
    name: 'Theatre of Marcellus',
    e: -215, n: -78, len: 130, wid: 115, bearing: 204, axis: 'z',
    where: 'campus-martius',
    cite: '41.8918 N 12.4797 E. Cavea 111 m across, 32.6 m to the top of the attic, 41 arcade ' +
      'bays per storey, seated c. 15,000; dedicated 13 BC. The cavea opens SE onto its stage, ' +
      'its arcaded back to the Forum Holitorium. Axis 22-26°/202-206° — Platner: "the stage ' +
      'is toward the river, main axis runs NNE-SSW". Fitting only the *surviving* arcade ' +
      'gives 234°, which is wrong: the standing fragment is the eastern part of the façade, ' +
      'not its middle.',
  },

  // ---- the Capitol, the Fora and the Palatine ----------------------------
  {
    id: 'temple-jupiter',
    name: 'Temple of Jupiter Optimus Maximus',
    e: 0, n: 0, len: 63, wid: 53, bearing: 333, axis: 'z',
    where: 'capitoline', mound: 20, moundRadius: 96,
    cite: 'The datum of this table: the Capitolium, on the **south** summit under Palazzo ' +
      'Caffarelli, 41.8925 N 12.4823 E, 48 m a.s.l. (The north summit is the Arx, with ' +
      'Juno Moneta; the saddle between them is the Asylum. Putting the temple on the Arx is ' +
      'a classic error.) Podium 63 × 53 m, three cellae, facing SE over the Forum — hence ' +
      'bearing 333 looking in: the façade bears 153.5°, the axis deviating 26.5° east of ' +
      'the north-south line. Platner-Ashby s.v. Iuppiter Optimus Maximus Capitolinus. ' +
      'NB Platner-Ashby elevations are above *mean Tiber level*: add 8.2 m for a.s.l.',
  },
  {
    id: 'tabularium',
    name: 'Tabularium',
    e: 60, n: 40, len: 73, wid: 34, bearing: 50,
    where: 'capitoline',
    cite: 'The record office of 78 BC closing the west end of the Forum, its arcaded façade ' +
      'still the base of the Palazzo Senatorio (41.8931 N 12.4830 E).',
  },
  {
    id: 'forum-romanum',
    name: 'Forum Romanum',
    e: 249, n: 0, len: 200, wid: 90, bearing: 117,
    where: 'forum-valley',
    cite: '41.8925 N 12.4853 E. The open square runs NW–SE between the Capitoline and the ' +
      'Velia, c. 200 × 90 m from the Rostra to the Regia. Bearing from the axis of the ' +
      'Via Sacra on the Severan plan.',
  },
  {
    id: 'basilica-ulpia',
    name: 'Basilica Ulpia',
    e: 191, n: 333, len: 130, wid: 55, bearing: 41,
    where: 'quirinal',
    cite: '41.8955 N 12.4846 E. 130 × 55 m with apses at both ends, lying *across* the axis of ' +
      'the Forum of Trajan at its north-west end. AD 112.',
  },
  {
    id: 'trajan-column',
    name: "Trajan's Column",
    e: 166, n: 378, len: 18, wid: 18, bearing: 0,
    where: 'quirinal',
    cite: '41.8959 N 12.4843 E. 29.78 m of shaft and pedestal, 35.07 m to the top of the ' +
      'statue; between the two libraries just north-west of the Basilica Ulpia. CIL VI 960.',
  },
  {
    id: 'trajan-market',
    name: "Trajan's Market",
    e: 262, n: 400, len: 120, wid: 70, bearing: 139,
    where: 'quirinal',
    cite: 'The hemicycle of tabernae cut into the flank of the Quirinal above the Forum of ' +
      'Trajan, 41.8961 N 12.4855 E; six storeys stepping up the hillside.',
  },
  {
    id: 'imperial-fora',
    name: 'Fora of Caesar, Augustus and Nerva',
    e: 300, n: 180, len: 250, wid: 100, bearing: 126,
    where: 'forum-valley',
    cite: 'The chain of imperial fora runs NE from the Forum Romanum along the foot of the ' +
      'Quirinal: Caesar (46 BC) then Augustus (2 BC) then Nerva. Centroid 41.8941 N 12.4859 E.',
  },
  {
    id: 'palatine',
    name: 'Palatine Palaces',
    e: 381, n: -422, len: 230, wid: 190, bearing: 118,
    where: 'palatine', mound: 24, moundRadius: 132,
    cite: '41.8887 N 12.4869 E, 51 m a.s.l. The hill is c. 400 × 350 m; the Domus Augustana ' +
      'and Domus Flavia occupy its centre, with the Severan façade on the SE over the Circus. ' +
      'It stands *between* the Forum (north) and the Circus Maximus (south-west).',
  },
  {
    id: 'circus-maximus',
    name: 'Circus Maximus',
    e: 249, n: -733, len: 621, wid: 190, bearing: 120,
    where: 'vallis-murcia',
    cite: '41.8859 N 12.4853 E. Track 621 × 118 m, the whole structure c. 621 × 190 with ' +
      'its seating, in the Vallis Murcia — the valley *between* the Palatine (NE) and the ' +
      'Aventine (SW). Carceres at the NW end (41.8872 N 12.4825 E), sphendone at the SE ' +
      '(41.8845 N 12.4888 E). Long axis 120°/300°, which is also the valley axis: measured ' +
      '119° off the georeferenced Lanciani plate and 120° off the modern plan. The 142° an ' +
      'earlier revision used came from a coarse endpoint guess and drove both ends of the ' +
      'circus out of the valley. Humphrey, *Roman Circuses* (1986), 56-131.',
  },
  {
    id: 'colosseum',
    name: 'Flavian Amphitheatre',
    e: 820, n: -256, len: 189, wid: 156, bearing: 115,
    where: 'colosseum-valley',
    cite: '41.8902 N 12.4922 E. 189 × 156 m at the ground, 48 m to the attic, 80 bays per ' +
      'storey, arena 86 × 54 m. Stands in the valley of the drained Stagnum Neronis, which ' +
      'drains south-west at c. 230° and is flanked by the Palatine (W/SW), the Velia (NW), ' +
      'the Oppius (N/NE) and the Caelian (S/SE) — east of the Forum, which it bears 112° ' +
      'from at 610 m. Major axis **115°/295°**, from a least-squares ellipse fit to the ' +
      'surviving plan that returns the published 189 m major exactly; corroborated by the ' +
      'Porta Triumphalis being the WNW gate and by the Ludus Magnus lying at 110°. Sources ' +
      'that say "WSW-ENE" contradict their own gate description and are a typo for ' +
      'WNW-ESE — my own first pass mis-measured it off the Lanciani plate as 68°. AD 80. ' +
      'THE ONLY AMPHITHEATRE OF THIS FORM IN ROME: see `assertOneAmphitheatre` in layout.ts.',
  },
  {
    id: 'ludus-magnus',
    name: 'Ludus Magnus',
    e: 990, n: -215, len: 135, wid: 100, bearing: 55,
    where: 'colosseum-valley',
    cite: 'The gladiatorial training school with its own small practice arena, immediately ' +
      'east of the Colosseum across the Via Labicana (41.8906 N 12.4942 E). Domitianic.',
  },
  {
    id: 'baths-titus',
    name: 'Baths of Titus',
    e: 978, n: -100, len: 120, wid: 105, bearing: 115,
    where: 'esquiline',
    cite: '41.8912 N 12.4941 E, on the lower slope of the Oppian directly north-east of the ' +
      'Colosseum; AD 80, and much the smaller of the two Esquiline bath blocks.',
  },
  {
    id: 'baths-trajan',
    name: 'Baths of Trajan',
    e: 1085, n: 60, len: 230, wid: 170, bearing: 125,
    where: 'esquiline',
    cite: '41.8930 N 12.4954 E. Platform 330 × 215 m on the Oppian over the buried Domus ' +
      'Aurea. Main axis 35°/125°, deliberately about 30° off the Domus Aurea grid the Baths ' +
      'of Titus below it still follow — both the ~30° and ~35° figures in the literature are ' +
      'right, against different references (the Domus Aurea grid and true north), so do not ' +
      '"correct" either. The bathing block is c. 230 × 190 and that is what is modelled, the ' +
      'gardens being district fabric. AD 109.'
  },

  // ---- the eastern hills -------------------------------------------------
  {
    id: 'temple-serapis',
    name: 'Temple of Serapis',
    e: 381, n: 645, len: 135, wid: 98, bearing: 45, axis: 'z',
    where: 'quirinal',
    cite: 'Caracalla\'s vast temple on the Quirinal summit above the Forum of Trajan ' +
      '(41.8983 N 12.4869 E); its podium wall survives in the gardens of the Palazzo ' +
      'Colonna. Platner-Ashby s.v. Serapis, Templum.',
  },
  // The Baths of Diocletian are deliberately absent: begun in 298 and dedicated in 306,
  // they did not exist in 271. Their 376 × 361 m precinct was also the single largest
  // consumer of the compressed plan's area, so leaving it out is both correct and useful.
  {
    id: 'castra-praetoria',
    name: 'Castra Praetoria',
    e: 1939, n: 1467, len: 400, wid: 377, bearing: 340,
    where: 'viminal', atWall: 0.02, offMapEast: true,
    cite: '41.9057 N 12.5057 E. 440 × 380 m brick-faced camp of AD 23; Aurelian took its own ' +
      'north and east walls into the circuit, which is why the curtain runs into it. ' +
      'Platner-Ashby s.v. Castra Praetoria; measured 437 × 377 with the *cardo maximus* — ' +
      'the long axis — running 340°/160°, NNW-SSE, and the north and east walls on 70°/160°. ' +
      'Modelled 400 × 377 and pushed hard against the east edge of the heightfield: at true ' +
      'size it is 167,000 m², a tenth of the entire buildable city, and holding all of it ' +
      'inside the map left the Baths of Trajan no room on the Oppius. The east edge of the ' +
      'map cuts the camp, which is the honest version of the compromise the frame makes ' +
      'everywhere else.',
  },
  {
    id: 'gardens-sallust',
    name: 'Horti Sallustiani',
    e: 887, n: 1612, len: 250, wid: 170, bearing: 60,
    where: 'pincian', soft: true, atWall: 0.6,
    cite: 'Sallust\'s gardens in the valley between the Pincian and the Quirinal, imperial ' +
      'property from Tiberius on (41.9070 N 12.4930 E); the Aurelian Wall cuts through them.',
  },

  // ---- the southern hills ------------------------------------------------
  {
    id: 'aventine-temples',
    name: 'The Aventine',
    e: -274, n: -944, len: 150, wid: 110, bearing: 150,
    where: 'aventine', mound: 16, moundRadius: 120,
    cite: '41.8840 N 12.4790 E, 46 m a.s.l. The hill *south-west* of the Circus Maximus, ' +
      'carrying the temples of Juno Regina, Diana and Minerva and, by the third century, ' +
      'senatorial houses. Only the summit group is a landmark; the slopes are district ' +
      'fabric, which is how the hill actually read.',
  },
  {
    id: 'baths-caracalla',
    name: 'Baths of Caracalla',
    e: 845, n: -1500, len: 218, wid: 140, bearing: 130,
    where: 'caelian',
    cite: '41.8790 N 12.4925 E. Precinct 337 × 328 m on the Via Nova south of the Caelian, ' +
      'the bathing block within it 218 × 112; the block is what is modelled. Dedicated ' +
      '216, so the newest great monument in the 271 city.',
  },
  {
    id: 'caelian-villas',
    name: 'The Caelian',
    e: 887, n: -667, len: 150, wid: 110, bearing: 100,
    where: 'caelian', mound: 13, moundRadius: 120,
    cite: '41.8865 N 12.4930 E, 48 m a.s.l. The hill south-east of the Colosseum, ' +
      'in the third century largely great houses, the Castra Peregrina and the Temple of ' +
      'Divus Claudius.',
  },

  // ---- across the Tiber, positioned off the terrain's own meander --------
  {
    id: 'tiber-island',
    name: 'Insula Tiberina',
    e: -365, n: -189, len: 270, wid: 67, bearing: 121,
    where: 'velabrum', onRiver: true, soft: true,
    cite: '41.8908 N 12.4779 E. The island lies between the Capitoline and the Aventine, ' +
      'linked by the Pons Fabricius (62 BC) to the Campus Martius and the Pons Cestius to ' +
      'Trans Tiberim; the Temple of Aesculapius stood at its south-east end. 270 × 67 m on ' +
      'axis 121°/301° — *not* the 446 × 116 of the modern outline, which includes the ' +
      'Lungotevere quays and the upstream cutwater. It bears 060° at 544 m from the ' +
      'Capitoline summit and 166° at 759 m from the Aventine, so it lies south-west of the ' +
      'one and north-north-west of the other.',
  },
  {
    id: 'mausoleum-hadrian',
    name: 'Mausoleum of Hadrian',
    e: -1326, n: 1178, len: 89, wid: 89, bearing: 177,
    where: 'trans-tiberim', farBank: true,
    cite: '41.9031 N 12.4663 E. Drum 64 m across on an 89 m square podium, reached by the ' +
      'Pons Aelius (AD 134); the imperial mausoleum in 271 and later Castel Sant\'Angelo.',
  },
  {
    id: 'janiculum',
    name: 'Janiculum Ridge',
    e: -1599, n: -389, len: 520, wid: 240, bearing: 12,
    where: 'trans-tiberim', farBank: true, mound: 40, moundRadius: 230, soft: true,
    cite: '41.8890 N 12.4630 E, 82 m a.s.l. — the highest ground in the city, a ridge running ' +
      'N–S along the far bank and the only place from which the whole city is in one view.',
  },
];

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Porta Flaminia. Solved by fixed-point iteration on `x = roadCentreX(crestZAt(x))`,
 * because the gate has to be where the Via Flaminia crosses the crest — which is also
 * the saddle the terrain cuts for it. Three passes converge to a tenth of a metre.
 */
export const GATE_X = (() => {
  let x = 20;
  for (let i = 0; i < 6; i++) x = roadCentreX(crestZAt(x));
  return Math.round(x * 10) / 10;
})();
export const GATE_Z = crestZAt(GATE_X);

/** Real position of the Porta Flaminia in the survey frame: Piazza del Popolo. */
const PORTA_FLAMINIA_E = -497;
const PORTA_FLAMINIA_N = 2045;

/**
 * East–west scale. From the Porta Flaminia to the west wall of the Castra Praetoria is
 * 2,436 real metres, and the world curtain runs 1,078 m from the gate to its east end,
 * so the scale is fixed by the two anchors rather than chosen: 1078 / 2436 = 0.443.
 */
export const KX = 0.443;

/**
 * Depth scale. The heightfield ends at z = 1400 and the wall crest reaches z = 583, so
 * there are about 940 m of city depth for Rome's 3,545 m from the Porta Flaminia to the
 * Baths of Caracalla. 0.222 is the largest value that fits Caracalla inside the map with
 * its precinct clear of the edge.
 */
export const KZ = 0.222;

/** Effective east-west : north-south anisotropy for plan rotations. See `worldRot`. */
export const ROT_RATIO = 1.45;

const X0 = GATE_X - KX * PORTA_FLAMINIA_E;
const Z0 = GATE_Z + KZ * PORTA_FLAMINIA_N;

/** Project survey metres to battlefield metres. */
export const worldOf = (e: number, n: number): { x: number; z: number } => ({
  x: X0 + KX * e,
  z: Z0 - KZ * n,
});

/**
 * Map a compass bearing through the same anisotropic transform and return the plan
 * rotation the geometry builders want: radians, where 0 leaves the long axis running
 * east–west and positive turns the local +X axis toward +Z.
 *
 * Copying the compass bearing straight across would be wrong. Under a map that squashes
 * north–south twice as hard as east–west, a real 142° axis becomes a 122° axis; use the
 * uncorrected value and the Circus Maximus ends up 100 m out of its valley at both ends.
 */
export const worldRot = (bearingDeg: number, axis: 'x' | 'z' = 'x'): number => {
  const th = (bearingDeg * Math.PI) / 180;
  // Direction of the axis in world metres, through the map's *effective* anisotropy.
  //
  // Not KX/KZ = 2.0. The overlap resolver spreads the plan east-west to make room for
  // true-scale buildings, so by the time anything is drawn the local position scale in x
  // is well above the nominal KX and the frame is nearer 1.45:1 than 2:1. Correcting
  // bearings by the nominal ratio over-rotates everything toward east-west: it turned the
  // Circus Maximus's 121° valley axis into 107°, which is very nearly a straight
  // east-west racetrack and loses the one thing that identifies the Vallis Murcia.
  const dx = KZ * ROT_RATIO * Math.sin(th);
  const dz = -KZ * Math.cos(th);
  // makeRotationY(r) maps local +X to world (cos r, −sin r) and local +Z to (sin r, cos r).
  if (axis === 'x') return -Math.atan2(dz, dx);
  return Math.atan2(dx, dz);
};

/** Where the city may build: the plateau behind the crest, inside the heightfield. */
export const CITY_Z_MIN = (x: number): number => crestZAt(clamp(x, -HALF_EXTENT, HALF_EXTENT)) + 24;
export const CITY_Z_MAX = HALF_EXTENT - 26;

/**
 * The far bank. The terrain's Tiber is a fixed two-term meander that does not agree
 * with a scaled real one — at the latitude of the Theatre of Pompey the modelled channel
 * is 500 m closer in than Rome's is — so anything Trans Tiberim is placed a set distance
 * west of the actual centreline at its own depth rather than by the affine map. That
 * keeps Hadrian's mausoleum on the correct side of the water, which is the fact that
 * matters.
 */
export const FAR_BANK = (z: number, offset: number): number =>
  riverCentreX(z) - RIVER_HALF_WIDTH - offset;

/** East bank of the Tiber at a given depth, the western limit of the city proper. */
export const EAST_BANK = (z: number): number => riverCentreX(z) + RIVER_HALF_WIDTH;
