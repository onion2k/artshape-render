/**
 * The toon look's sums without its picture: the smooth light's ramp and the
 * soft tone, each written once here and once as WGSL built from the same
 * constants, so the shader cannot drift from what a test under node holds
 * it to. `toy.gpu.test.ts` holds the shader's to these on a device.
 *
 * Without them the finish's arithmetic would live in shader strings alone,
 * where the only test is a picture, and a ramp that lifted flat ground by a
 * level or a tone that turned an orange yellow would be found by a player.
 */

/** The deepest band's share of a colour: in the sun's shadow, or turned from it. */
export const TOON_SHADE = 0.6;
/** The band between's share: half turned from the sun. */
export const TOON_MID = 0.8;
/** The most the top band takes with the form light: a surface facing the sun more squarely than flat ground. */
export const TOON_TOP = 1.25;
/** How much of the sun a toon surface takes at all, since a band at the whole colour is the colour and not a quarter of it. */
export const TOON_SUN = 0.4;

/**
 * How steeply the ramp's low side leaves the deepest band, against a straight
 * line to the band between: half again as steep, so the terminator is crisp,
 * and so half as steep where it meets the fall, so no stretch is flat.
 */
const RAMP_START = 1.5;
/** How wide the join between the form's fall and the low side is eased, so neither ends in a corner. */
const RAMP_JOIN = 0.06;

/**
 * The most of each part of the finish a look may ask for. Twice the part's
 * own default: a glossier toy, or a shinier coat, and not a mirror.
 */
export const MAX_GLOSS = 2;
export const MAX_SHEEN = 2;

/**
 * Where the soft tone's shoulder starts, as the brightest channel. Under the
 * knee a colour is shown as it is, exactly as the clamp shows it; over it
 * the brightest channel eases toward one and the others keep their share of
 * it, so an orange lit past one stays orange where the clamp holds two
 * channels at one and turns it yellow.
 *
 * What the shoulder takes off is let spill toward white. A highlight is white
 * light on a colour, far past one, and a white highlight on red plastic that
 * kept its hue would be pink: so a colour that is largely white light (its
 * dimmest channel against its brightest, from SOFT_WHITE_FROM to
 * SOFT_WHITE_TO) goes to white once the shoulder is taking a good deal off
 * it (from SOFT_GLARE_FROM to SOFT_GLARE_TO). A pastel is largely white too,
 * but a lit pastel is not far past one, and it first went white with the
 * highlights, and a candy world's pink ground with it; now it keeps its
 * hue. Anything else spills only slowly (SOFT_SPILL), so a lit red is red
 * and a red lit blindingly is white at last.
 */
export const SOFT_KNEE = 0.8;
export const SOFT_SPILL = 0.02;
export const SOFT_WHITE_FROM = 0.15;
export const SOFT_WHITE_TO = 0.45;
export const SOFT_GLARE_FROM = 0.3;
export const SOFT_GLARE_TO = 0.9;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** The larger of a and b, eased over k where they are close, and exactly the larger where they are not. */
export function smoothMax(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

/**
 * The smooth light: a colour's share of the sun, by how much of the sun a
 * surface takes (`x`, its cosine to the sun times its shadow), in one ramp
 * where the bands stepped. `flat` is what flat ground facing straight up
 * takes, the sun's height and never under a tenth; `form` is the form
 * light, how steeply the light falls away from flat ground.
 *
 * Two lines, joined without a corner. The fall: through flat ground at one,
 * exactly as the top band lit it, as steep as the form light asks and never
 * less steep than Lambert's, down to the band between; which is the form
 * light's top band to the bit, so a hill reads as it did. And the low side:
 * out of the deepest band where the sun does not reach, which is every
 * shadow's colour exactly as it was, rising to the band between exactly
 * where the fall comes down to it (the knee), and no higher. It first rose
 * on past the band between, and lit a slope turned a little from the sun
 * brighter than the form light had: the Volcano's shaded flank, and the
 * hill read flatter.
 */
export function toonRamp(x: number, flat: number, form: number): number {
  const f = Math.max(form, 1);
  const fall = 1 + (f * (x - flat)) / flat;
  const knee = flat * (1 - (1 - TOON_MID) / f);
  const t = Math.min(Math.max(x / knee, 0), 1);
  const low = TOON_SHADE + (TOON_MID - TOON_SHADE) * t * (RAMP_START - (RAMP_START - 1) * t);
  return Math.min(smoothMax(fall, low, RAMP_JOIN), TOON_TOP);
}

/** The soft tone: a colour, as linear light before the tone map, as it is shown. See SOFT_KNEE. */
export function softTone(c: [number, number, number]): [number, number, number] {
  const peak = Math.max(c[0], c[1], c[2], 1e-5);
  if (peak <= SOFT_KNEE) return [c[0], c[1], c[2]];
  const eased = SOFT_KNEE + (1 - SOFT_KNEE) * (1 - Math.exp(-(peak - SOFT_KNEE) / (1 - SOFT_KNEE)));
  const scale = eased / peak;
  const over = peak - eased;
  const white = smoothstep(SOFT_WHITE_FROM, SOFT_WHITE_TO, Math.max(Math.min(c[0], c[1], c[2]), 0) / peak);
  const spill = Math.min(Math.max(over * SOFT_SPILL + white * smoothstep(SOFT_GLARE_FROM, SOFT_GLARE_TO, over), 0), 1);
  return [c[0], c[1], c[2]].map((v) => v * scale + (eased - v * scale) * spill) as [number, number, number];
}

/** A number as WGSL writes an f32, so a constant here is the constant there. */
const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : `${x}`);

/** The ramp and its smooth max as WGSL, the same sums as `toonRamp` and `smoothMax`. */
export const TOON_RAMP_WGSL = `
const TOON_TOP: f32 = ${f(TOON_TOP)};
const RAMP_START: f32 = ${f(RAMP_START)};
const RAMP_JOIN: f32 = ${f(RAMP_JOIN)};
fn smoothMax(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / k;
  return max(a, b) + h * h * k * 0.25;
}
fn toonRamp(x: f32, flat: f32, form: f32) -> f32 {
  let f = max(form, 1.0);
  let fall = 1.0 + f * (x - flat) / flat;
  let knee = flat * (1.0 - (1.0 - TOON_MID) / f);
  let t = clamp(x / knee, 0.0, 1.0);
  let low = TOON_SHADE + (TOON_MID - TOON_SHADE) * t * (RAMP_START - (RAMP_START - 1.0) * t);
  return min(smoothMax(fall, low, RAMP_JOIN), TOON_TOP);
}
`;

/** The soft tone as WGSL, the same sum as `softTone`. */
export const SOFT_TONE_WGSL = `
const SOFT_KNEE: f32 = ${f(SOFT_KNEE)};
const SOFT_SPILL: f32 = ${f(SOFT_SPILL)};
const SOFT_WHITE_FROM: f32 = ${f(SOFT_WHITE_FROM)};
const SOFT_WHITE_TO: f32 = ${f(SOFT_WHITE_TO)};
const SOFT_GLARE_FROM: f32 = ${f(SOFT_GLARE_FROM)};
const SOFT_GLARE_TO: f32 = ${f(SOFT_GLARE_TO)};
fn softTone(c: vec3f) -> vec3f {
  let peak = max(max(c.r, c.g), max(c.b, 1e-5));
  if (peak <= SOFT_KNEE) { return c; }
  let eased = SOFT_KNEE + (1.0 - SOFT_KNEE) * (1.0 - exp(-(peak - SOFT_KNEE) / (1.0 - SOFT_KNEE)));
  let kept = c * (eased / peak);
  let over = peak - eased;
  let white = smoothstep(SOFT_WHITE_FROM, SOFT_WHITE_TO, max(min(min(c.r, c.g), c.b), 0.0) / peak);
  return kept + (vec3f(eased) - kept) * clamp(over * SOFT_SPILL + white * smoothstep(SOFT_GLARE_FROM, SOFT_GLARE_TO, over), 0.0, 1.0);
}
`;
