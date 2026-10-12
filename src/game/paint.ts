/**
 * The painted edge's knobs, their packing and their sums, without their
 * picture: a few chosen ridges of faceted scenery carry a crisp stroke of
 * pale paint, sized by the facet, loaded at its head and dry at its tail,
 * faded where ridges crowd a vertex and as the thing shrinks on screen. Each
 * sum is written once here and once as WGSL built from the same constants,
 * so the shader cannot drift from what a test under node holds it to.
 * `PAINT_UNIFORM_WGSL` is the struct the fragment reads the four sets from,
 * and `packPaint` writes it; a test holds the two to each other.
 *
 * Without this file the knobs would be numbers spliced into shader text, so
 * tuning one a frame would recompile, and a field moved in the struct and
 * not in the packing would paint a stroke from the wrong knob in silence.
 *
 * The record of one set is PAINT_SET_FLOATS floats (a vec3 colour sits on a
 * sixteen-byte boundary and the float after it fills its padding), at these
 * offsets, in floats from the record's start:
 *
 *   0 width          1 widthFacet     2 widthPx        3 shareCap
 *   4 fadePx         5 gate           6 ramp           7 ridgeUp
 *   8 edgeAa         9 feather       10 featherWidth  11 swell
 *  12 swellScale    13 taper         14 broken        15 brokenScale
 *  16 vertexFade    17 fadeReach     18 light         19 sun
 *  20 up            21 upPow         22 litCut        23 markValue
 *  24 markScale     25 markEnd       26 markHue       27 markAlong
 *  28 facet         29..31 padding
 *  32..34 lightColour                35 dark
 *  36..38 markHueColour              39 darkFactor
 *
 * `PAINT_OFFSETS` is this table as data, and a test holds it to the struct.
 */

type Rgb = readonly [number, number, number];

/** Every knob of one set, each optional: a knob left out is `PAINT_DEFAULT`'s. */
export interface PaintSet {
  /** The band's width in world units, the floor of its share of the facet. */
  width?: number;
  /** The band's width as a share of the facet, so a boulder's stroke is wider than a pebble's. */
  widthFacet?: number;
  /** The least the band is, in pixels, so a far stroke never thins out of the picture. */
  widthPx?: number;
  /** The most the band is, as a share of the facet, applied after the pixel floor, so the floor loses on a tiny facet; 0 for no cap. */
  shareCap?: number;
  /** The facet's smallest height in pixels under which the paint lets go; it is whole at three times this. */
  fadePx?: number;
  /** The fold, in radians, an edge must pass to carry paint. */
  gate?: number;
  /** How softly the gate opens, in radians. */
  ramp?: number;
  /** The up-share an edge must have to carry paint, eased over 0.1 either side. */
  ridgeUp?: number;
  /** The band's antialiasing half-width, in pixels. */
  edgeAa?: number;
  /** The share of the band's inner side that fades into the face; 0 for a crisp stroke. */
  feather?: number;
  /** How far the feather reaches, as a multiple of the width. */
  featherWidth?: number;
  /** How much the stroke's width wobbles along it. */
  swell?: number;
  /** The wobble's size in the world. */
  swellScale?: number;
  /** How much the stroke thins toward a break. */
  taper?: number;
  /** How much the stroke breaks; 0 under ridgelines, where a chain is one stroke. */
  broken?: number;
  /** The breaks' size in the world. */
  brokenScale?: number;
  /** How far the lip is let go near a crowded vertex. */
  vertexFade?: number;
  /** How far from that vertex it is let go, as a share of the facet. */
  fadeReach?: number;
  /** The lip's strength. */
  light?: number;
  /** The lip's absolute colour, mixed into the albedo before the light. */
  lightColour?: Rgb;
  /** The weight toward faces that face the sun. */
  sun?: number;
  /** The weight toward faces that face up. */
  up?: number;
  /** The power the two weights are raised to, so the lip keeps to the upper, sunward edges. */
  upPow?: number;
  /** How far the lip is let go on a face the sun squarely lights. */
  litCut?: number;
  /** How much brighter the loaded head is than the dry tail. */
  markValue?: number;
  /** The mark's noise size in the world. */
  markScale?: number;
  /** How far the stroke's ends are dimmed. */
  markEnd?: number;
  /** How far the loaded head leans toward `markHueColour`. */
  markHue?: number;
  /** The colour the loaded head leans toward. */
  markHueColour?: Rgb;
  /** How far the mark runs along the ridgeline and not by noise; 1 under ridgelines. */
  markAlong?: number;
  /** The concave crease's strength; 0 for none. */
  dark?: number;
  /** What the crease multiplies the albedo by. */
  darkFactor?: number;
  /** A flat value offset a face, from its id; 0 for none. */
  facet?: number;
}

/** The settled recipe for rock. A game may move any of it. */
export const PAINT_DEFAULT: Required<PaintSet> = {
  width: 0.2,
  widthFacet: 0.08,
  widthPx: 1,
  shareCap: 0.25,
  fadePx: 6,
  gate: 0.3,
  ramp: 0.15,
  ridgeUp: 0.3,
  edgeAa: 0.25,
  feather: 0,
  featherWidth: 1,
  swell: 0.3,
  swellScale: 4,
  taper: 0.2,
  broken: 0,
  brokenScale: 8,
  vertexFade: 1,
  fadeReach: 0.8,
  light: 1.3,
  lightColour: [0.62, 0.55, 0.42],
  sun: 0.6,
  up: 0.9,
  upPow: 2,
  litCut: 0,
  markValue: 0.6,
  markScale: 8,
  markEnd: 0.8,
  markHue: 1,
  markHueColour: [0.66, 0.52, 0.36],
  markAlong: 1,
  dark: 0,
  darkFactor: 0.45,
  facet: 0,
};

/** The sets a look may carry, chosen per mesh by `PaintOptions.set`. */
export const PAINT_SETS = 4;
/** The floats of one set's record. See the table in the file's header. */
export const PAINT_SET_FLOATS = 40;

/** Where each knob starts in a record, in floats; a colour takes three. */
export const PAINT_OFFSETS: Readonly<Record<keyof PaintSet, number>> = {
  width: 0,
  widthFacet: 1,
  widthPx: 2,
  shareCap: 3,
  fadePx: 4,
  gate: 5,
  ramp: 6,
  ridgeUp: 7,
  edgeAa: 8,
  feather: 9,
  featherWidth: 10,
  swell: 11,
  swellScale: 12,
  taper: 13,
  broken: 14,
  brokenScale: 15,
  vertexFade: 16,
  fadeReach: 17,
  light: 18,
  sun: 19,
  up: 20,
  upPow: 21,
  litCut: 22,
  markValue: 23,
  markScale: 24,
  markEnd: 25,
  markHue: 26,
  markAlong: 27,
  facet: 28,
  lightColour: 32,
  dark: 35,
  markHueColour: 36,
  darkFactor: 39,
};

/** Every knob, listed once, so a look packed each frame allocates nothing. */
const PAINT_KEYS = Object.keys(PAINT_DEFAULT) as (keyof PaintSet)[];

/**
 * Writes `PAINT_SETS` records into `out`, from the sets given: a set not
 * given, or a knob left out of one, takes the default, so a look that asks
 * for nothing packs the recipe. Padding is written as nought, so the same
 * look is the same bytes.
 */
export function packPaint(out: Float32Array, sets: readonly PaintSet[]): void {
  const keys = PAINT_KEYS;
  for (let s = 0; s < PAINT_SETS; s++) {
    const base = s * PAINT_SET_FLOATS;
    out.fill(0, base, base + PAINT_SET_FLOATS);
    const set = sets[s];
    for (const k of keys) {
      const v = set?.[k] ?? PAINT_DEFAULT[k];
      const at = base + PAINT_OFFSETS[k];
      if (typeof v === 'number') out[at] = v;
      else {
        out[at] = v[0];
        out[at + 1] = v[1];
        out[at + 2] = v[2];
      }
    }
  }
}

/** The up-share step's half-width: an edge's up-share is eased over this either side of `ridgeUp`. */
const RIDGE_EASE = 0.1;
/** Where the stroke's head is whole (a seventh of the way in) and where its tail begins to dim. */
const MARK_HEAD = 0.15;
const MARK_TAIL = 0.75;
/** The fade with size is whole at this many times `fadePx`. */
const FADE_SPAN = 3;
/** The crowd, in convex edges at a vertex, from which the lip lets go: none at two, all at five. */
const CROWD_FROM = 2;
const CROWD_TO = 5;
/** The smallest a ramp or a reach may be, so a knob at nought does not divide by it. */
const TINY = 1e-4;

const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * The band's width at a place: the world width or its share of the facet,
 * whichever is larger, floored at `widthPx` pixels, then capped at
 * `shareCap` of the facet, in that order, so on a facet too small to carry
 * the floor the cap wins and the stroke does not swallow the face.
 */
export function paintWidth(width: number, widthFacet: number, widthPx: number, shareCap: number, facet: number, footprint: number): number {
  const wide = Math.max(Math.max(width, widthFacet * facet), widthPx * footprint);
  return shareCap > 0 ? Math.min(wide, shareCap * facet) : wide;
}

/** The band's coverage at distance `d` from the edge: one inside, nought outside, eased over `edgeAa` footprints either side of the width, so it antialiases the same on a diagonal as a straight edge. */
export function paintBand(d: number, width: number, footprint: number, edgeAa: number): number {
  const aa = Math.max(edgeAa, 0.01) * footprint;
  return 1 - smoothstep(width - aa, width + aa, d);
}

/** What an edge carries: the gate's smoothstep on its fold, times a step on its up-share, so the undersides carry nothing. */
export function paintStrength(fold: number, gate: number, ramp: number, upShare: number, ridgeUp: number): number {
  return smoothstep(gate, gate + Math.max(ramp, TINY), fold) * smoothstep(ridgeUp - RIDGE_EASE, ridgeUp + RIDGE_EASE, upShare);
}

/** The paint's share as a facet shrinks on screen: gone at `fadePx` and whole at three times it; whole where `fadePx` is nought. */
export function paintFade(facetPx: number, fadePx: number): number {
  return fadePx > 0 ? smoothstep(fadePx, FADE_SPAN * fadePx, facetPx) : 1;
}

/** The lip's multiplier near a vertex where many ridges meet, which would otherwise gather into a blot: the crowd counts the convex edges there, and `dVertex` is the distance to it. */
export function paintCrowdFade(crowd: number, dVertex: number, fadeReach: number, facet: number, vertexFade: number): number {
  const near = 1 - smoothstep(0, Math.max(fadeReach * facet, 1e-5), dVertex);
  return 1 - vertexFade * smoothstep(CROWD_FROM, CROWD_TO, Math.floor(crowd)) * near;
}

/**
 * The lip's value multiplier along a stroke: loaded at its head and dry at
 * its tail. `noise` is a world noise in [0, 1] (the stroke's break and
 * value when it is not a ridgeline's), `along` the place along the
 * ridgeline, 0 at the higher end; `markAlong` mixes the two. Along the
 * ridgeline the value runs from bright to dark and the ends are dimmed by
 * `markEnd`; by noise, the same value runs by the noise and the dimming by
 * where the noise is low.
 */
export function paintMark(along: number, noise: number, markValue: number, markEnd: number, markAlong: number): number {
  const noiseForm = (1 + markValue * (2 * noise - 1)) * (1 - markEnd * (1 - smoothstep(0, 0.5, noise)));
  const alongForm =
    (1 + markValue * (1 - 2 * along)) * (1 - markEnd * (1 - smoothstep(0, MARK_HEAD, along) * (1 - smoothstep(MARK_TAIL, 1, along))));
  return noiseForm + (alongForm - noiseForm) * markAlong;
}

/** How much a face is let to carry the lip: weighted toward sun-facing and up-facing faces, each raised to `upPow`, and let go on a face the sun squarely lights by `litCut`. */
export function paintLit(nDotSun: number, nDotUp: number, sun: number, up: number, upPow: number, litCut: number): number {
  const pow = Math.max(upPow, 1);
  const lit = 1 - Math.max(sun, up) + Math.max(sun * Math.max(nDotSun, 1e-6) ** pow, up * Math.max(nDotUp, 1e-6) ** pow);
  return lit * (1 - litCut * smoothstep(0.1, 0.5, Math.max(nDotSun, 0)));
}

/** The albedo with the lip mixed in, before the light: an absolute colour of its own, never over one. */
export function paintLip(albedo: Rgb, lightColour: Rgb, amount: number): [number, number, number] {
  const t = clamp01(amount);
  return albedo.map((a, i) => clamp01(a + (lightColour[i]! - a) * t)) as [number, number, number];
}

/** A number as WGSL writes an f32, so a constant here is the constant there. */
const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : `${x}`);

/** The sums as WGSL, the same as the functions above, taking the knobs as arguments. */
export const PAINT_WGSL = `
const PAINT_RIDGE_EASE: f32 = ${f(RIDGE_EASE)};
const PAINT_MARK_HEAD: f32 = ${f(MARK_HEAD)};
const PAINT_MARK_TAIL: f32 = ${f(MARK_TAIL)};
const PAINT_FADE_SPAN: f32 = ${f(FADE_SPAN)};
const PAINT_CROWD_FROM: f32 = ${f(CROWD_FROM)};
const PAINT_CROWD_TO: f32 = ${f(CROWD_TO)};
const PAINT_TINY: f32 = ${f(TINY)};
fn paintWidth(width: f32, widthFacet: f32, widthPx: f32, shareCap: f32, facet: f32, footprint: f32) -> f32 {
  let wide = max(max(width, widthFacet * facet), widthPx * footprint);
  return select(wide, min(wide, shareCap * facet), shareCap > 0.0);
}
fn paintBand(d: f32, width: f32, footprint: f32, edgeAa: f32) -> f32 {
  let aa = max(edgeAa, 0.01) * footprint;
  return 1.0 - smoothstep(width - aa, width + aa, d);
}
fn paintStrength(fold: f32, gate: f32, ramp: f32, upShare: f32, ridgeUp: f32) -> f32 {
  return smoothstep(gate, gate + max(ramp, PAINT_TINY), fold) * smoothstep(ridgeUp - PAINT_RIDGE_EASE, ridgeUp + PAINT_RIDGE_EASE, upShare);
}
fn paintFade(facetPx: f32, fadePx: f32) -> f32 {
  return select(1.0, smoothstep(fadePx, PAINT_FADE_SPAN * fadePx, facetPx), fadePx > 0.0);
}
fn paintCrowdFade(crowd: f32, dVertex: f32, fadeReach: f32, facet: f32, vertexFade: f32) -> f32 {
  let near = 1.0 - smoothstep(0.0, max(fadeReach * facet, 1e-5), dVertex);
  return 1.0 - vertexFade * smoothstep(PAINT_CROWD_FROM, PAINT_CROWD_TO, floor(crowd)) * near;
}
fn paintMark(along: f32, noise: f32, markValue: f32, markEnd: f32, markAlong: f32) -> f32 {
  let noiseForm = (1.0 + markValue * (2.0 * noise - 1.0)) * (1.0 - markEnd * (1.0 - smoothstep(0.0, 0.5, noise)));
  let alongForm = (1.0 + markValue * (1.0 - 2.0 * along)) * (1.0 - markEnd * (1.0 - smoothstep(0.0, PAINT_MARK_HEAD, along) * (1.0 - smoothstep(PAINT_MARK_TAIL, 1.0, along))));
  return mix(noiseForm, alongForm, markAlong);
}
fn paintLit(nDotSun: f32, nDotUp: f32, sun: f32, up: f32, upPow: f32, litCut: f32) -> f32 {
  let p = max(upPow, 1.0);
  let lit = 1.0 - max(sun, up) + max(sun * pow(max(nDotSun, 1e-6), p), up * pow(max(nDotUp, 1e-6), p));
  return lit * (1.0 - litCut * smoothstep(0.1, 0.5, max(nDotSun, 0.0)));
}
fn paintLip(albedo: vec3f, lightColour: vec3f, amount: f32) -> vec3f {
  return clamp(mix(albedo, lightColour, clamp(amount, 0.0, 1.0)), vec3f(0.0), vec3f(1.0));
}
`;

/**
 * The struct the fragment reads the sets from, field for field the table in
 * this file's header; a test holds the two to each other, so a field moved
 * in one and not the other fails there and not as a stroke of the wrong
 * colour. The `pad` fields keep the colours on sixteen-byte boundaries.
 */
export const PAINT_UNIFORM_WGSL = `
struct PaintSet {
  width: f32, widthFacet: f32, widthPx: f32, shareCap: f32,
  fadePx: f32, gate: f32, ramp: f32, ridgeUp: f32,
  edgeAa: f32, feather: f32, featherWidth: f32, swell: f32,
  swellScale: f32, taper: f32, broken: f32, brokenScale: f32,
  vertexFade: f32, fadeReach: f32, light: f32, sun: f32,
  up: f32, upPow: f32, litCut: f32, markValue: f32,
  markScale: f32, markEnd: f32, markHue: f32, markAlong: f32,
  facet: f32, pad0: f32, pad1: f32, pad2: f32,
  lightColour: vec3f, dark: f32,
  markHueColour: vec3f, darkFactor: f32,
}
struct PaintUniform {
  sets: array<PaintSet, ${PAINT_SETS}>,
}
`;
