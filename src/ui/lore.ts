/**
 * What the loading screen says while the world is being built.
 *
 * A loading screen is a captive twenty seconds in front of a picture, and this project has
 * two thousand lines of researched history behind every map. Total War puts a fact and a
 * painting there; this puts a fact and a frame of its own render.
 *
 * ---------------------------------------------------------------------------
 * The rule these were written under
 * ---------------------------------------------------------------------------
 *
 * **Every card is traceable to `docs/ROME.md`, `docs/CARTHAGE.md` or the map's own header,
 * and nothing is written from memory.** Those documents tag their evidence — `[ANC]` an
 * ancient source, `[ARCH]` archaeology, `[MOD]` modern scholarship, `[DER]` derived from
 * them, `[GAME]` this project's own invention — and **only the first three are allowed here**.
 * Anything the research itself hedges is out, and the list of what was rejected is as much
 * a part of this file as the list of what survived:
 *
 * - **Placentia.** `README.md` says Aurelian beat the Juthungi there; `ROME.md` §2 quotes the
 *   *Historia Augusta* saying he was beaten there so badly the empire was nearly dissolved.
 *   Two documents in one repository disagree, so no card mentions it.
 * - **The siege itself.** `ROME.md`: *"a Juthungi assault on a half-built Aurelian wall never
 *   happened and by construction could not have."* The map is a labelled counterfactual, so
 *   every Rome card below is about the wall and the city, and none of them says a siege
 *   occurred.
 * - **Twenty thousand men barracked inside the Punic wall.** Appian says it; `CARTHAGE.md`
 *   files it under "load-bearing and probably inflated" and computes half a square metre per
 *   soldier. Out.
 * - **Punic war elephants in 146.** They are in the game and they were not at the siege, so
 *   the card says so rather than pretending otherwise.
 * - **The Byrsa's height, the line of the triple wall, the Muro Torto, the Tiber's width.**
 *   All either unlocated, disputed between published figures, or explicitly a decision this
 *   project made. Out, all of them.
 *
 * Where an ancient author is the *only* authority, the card says whose word it is. "Appian
 * says the houses were six storeys" is a different claim from "the houses were six storeys",
 * and a loading screen has room for the two extra words.
 *
 * Pydna is thinner than the other two on purpose. It has no research document — its history
 * lives in the comments of `src/maps/pydna/*.ts` — so its cards stay to what those state
 * outright, and the two that name Plutarch are the only two that name anybody.
 */

import type { MapId } from '../maps';

export interface LoreCard {
  /** Two or three words. The card's own heading. */
  title: string;
  /** One or two sentences. Kept under about 200 characters so it never scrolls. */
  text: string;
  /** The authority, where the research names one. Absent is honest; invented is not. */
  cite?: string;
}

const ROME: readonly LoreCard[] = [
  {
    title: 'A wall four months old',
    text: 'Aurelian began Rome’s wall in 271. It was still unfinished when he died, and was '
      + 'completed under Probus between 276 and 282.',
    cite: 'Zosimus I.49',
  },
  {
    title: 'Half the height it ended at',
    text: 'The first-phase wall stood 6.5 m to the wall-walk. The Honorian rebuild of 401–402 '
      + 'doubled it and roofed the walk over — that wall is 130 years away.',
    cite: 'Richmond, 1930',
  },
  {
    title: 'Seventy per cent already stood',
    text: 'Of some four kilometres of circuit north of the city, 2,800 m was already there: the '
      + 'garden terraces of the Horti Aciliorum and Sallustiani, and the walls of the Castra '
      + 'Praetoria. Aurelian’s engineers heightened them.',
    cite: 'Lanciani, 1897',
  },
  {
    title: 'Second-hand brick',
    text: 'There are no Aurelianic brickstamps anywhere on the circuit. In one curtain east of the '
      + 'Porta Asinaria, 37 per cent of the stamps are Hadrianic — the wall went up out of '
      + 'salvaged brick, sorted by size.',
    cite: 'Lanciani, 1892',
  },
  {
    title: 'A tower every 37 metres',
    text: 'Fourteen kilometres of land circuit at a 37.1 m interaxis gives 384 towers. The '
      + 'Einsiedeln itinerary, walking the wall centuries later, counted 383.',
    cite: 'Dey, 2011',
  },
  {
    title: 'No ditch',
    text: 'The Aurelianic circuit had none. What stood outside the wall in 271 was not a defence '
      + 'work but a building site.',
  },
  {
    title: 'The plain itself',
    text: 'The Campus Martius is some 250 hectares of Tiber flood plain — a little more than '
      + 'two kilometres north to south, from the Capitoline to the Porta Flaminia.',
    cite: 'Platner & Ashby',
  },
];

const CARTHAGE: readonly LoreCard[] = [
  {
    title: 'Spring, 146 BC',
    text: 'The fourth year of the Third Punic War, and the final assault, under Publius Cornelius '
      + 'Scipio Aemilianus.',
  },
  {
    title: 'The wall never fell',
    text: 'The triple wall across the isthmus was still unbreached when the city was taken. Scipio '
      + 'never got through it — Carthage fell from the harbour side.',
    cite: 'Appian, Punica',
  },
  {
    title: 'Thirty cubits, thirty feet',
    text: 'Appian gives the main wall 13.7 m to the wall-walk and 9.1 m of masonry through, before '
      + 'you count its parapets and its towers.',
    cite: 'Appian, Punica',
  },
  {
    title: 'Stables inside the masonry',
    text: 'The wall was hollow, in two vaulted levels: the lower held stalls for 300 elephants with '
      + 'their fodder, the upper for 4,000 horses.',
    cite: 'Appian, Punica',
  },
  {
    title: 'And no elephants',
    text: 'Carthage had none in 146. The peace of 201 forbade the city to train them, and in 149 it '
      + 'surrendered its arms wholesale. The stalls in the wall stood empty.',
  },
  {
    title: 'Towers every 200 feet',
    text: 'Four storeys each, at 59.2 m intervals. The real 4.43 km isthmus wall carried about '
      + 'seventy-five of them.',
    cite: 'Appian, Punica',
  },
  {
    title: 'The cothon',
    text: 'The circular naval basin was 325 m across, with a 125 m artificial island at its centre. '
      + 'Its sea entrance was 21 m wide and closed with iron chains.',
    cite: 'Hurst, British Mission',
  },
  {
    title: 'Six days up three streets',
    text: 'Three streets climbed from the forum to the Byrsa between houses Appian says were six '
      + 'storeys high. It took the Romans six days and nights to fight up them, crossing roof to '
      + 'roof on planks.',
    cite: 'Appian, Punica',
  },
];

const PYDNA: readonly LoreCard[] = [
  {
    title: 'The day after the omen',
    text: '22 June 168 BC — the summer solstice, and the day after the lunar eclipse the '
      + 'Macedonians read as a sign against their king.',
  },
  {
    title: 'About the ninth hour',
    text: 'Plutarch has the fighting begin around 14:30, the phalanx broken within the hour, and '
      + 'the pursuit run until dark.',
    cite: 'Plutarch, Aemilius',
  },
  {
    title: 'Why here',
    text: 'The Pierian plain falls a little over one per cent to the sea — level enough for a '
      + 'phalanx to keep its dress, which is why Perseus offered battle on it and why Aemilius '
      + 'Paullus did not want it.',
  },
  {
    title: 'Half a metre of ground',
    text: 'Dry runnels 0.4 to 0.8 m deep cross the plain. A man walks through one without breaking '
      + 'step. A sixteen-deep pike block crossing one at an angle loses its dress.',
  },
  {
    title: 'Into the gaps',
    text: 'Perseus’ line came on and Paullus’ gave ground; then the maniples went into the '
      + 'gaps the broken plain had opened in the pikes.',
    cite: 'Plutarch, Aemilius',
  },
  {
    title: 'No paved road',
    text: 'Macedonia in 168 BC had no highway — the Via Egnatia was twenty years off. The coast '
      + 'road is packed earth polished by cart wheels.',
  },
];

const BY_MAP: Record<MapId, readonly LoreCard[]> = {
  'campus-martius': ROME,
  carthage: CARTHAGE,
  pydna: PYDNA,
};

/**
 * The cards for a map, in a rotation that starts somewhere different each visit.
 *
 * Deliberately *not* seeded off the battle. A loading screen is the one surface in this game
 * that has nothing to do with the simulation, and reading `config.seed` here would make two
 * runs of `qa-determinism` differ in their DOM for no reason anybody would enjoy debugging.
 * `Math.random` is correct precisely because nothing downstream of it is measured.
 */
export function loreFor(map: MapId): readonly LoreCard[] {
  const cards = BY_MAP[map] ?? ROME;
  const start = Math.floor(Math.random() * cards.length);
  return [...cards.slice(start), ...cards.slice(0, start)];
}
