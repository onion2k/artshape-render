/**
 * A shore field: how far each point of the water is from the nearest land or anything standing in it, which a game
 * works out once from its own content and hands to the renderer (`setShoreField`). With one, clear water's foam is a
 * line of even width round every shore and rock, with a second line a little way out, as a painted lake's is. Foam
 * cut by the depth alone is as wide as the shore is gentle, so a lake that shelves slowly wears a wide band of it and
 * a rock with steep sides barely any.
 *
 * Its distances are checked as anything from outside is, and packed as half floats, which the GPU filters between
 * texels so the lines are smooth however coarse the field.
 */

export interface ShoreField {
  /** How many texels the field is along each side. */
  size: number;
  /** `size` times `size` distances, in world units, row by row from the south edge, each row from west to east. */
  distances: Float32Array;
  /** The world's x and y at the field's south-west corner and at its north-east: it is stretched over them. */
  min: [number, number];
  max: [number, number];
}

/** How many floats the field's place and the second line are packed into: two vec4s. */
export const SHORE_FIELD_FLOATS = 8;

/** Refuses a field the clear pass cannot read, naming why. */
export function checkShoreField(f: ShoreField): void {
  if (!Number.isInteger(f.size) || f.size < 2) throw new Error(`a shore field of size ${f.size} is not one: it needs two texels a side at the least`);
  if (f.distances.length !== f.size * f.size) {
    throw new Error(`a shore field ${f.size} square needs ${f.size * f.size} distances, and has ${f.distances.length}`);
  }
  const bad = f.distances.findIndex((d) => !Number.isFinite(d));
  if (bad >= 0) throw new Error(`a shore field's distance at texel ${bad} is not a number`);
  if (![...f.min, ...f.max].every(Number.isFinite) || f.max[0] <= f.min[0] || f.max[1] <= f.min[1]) {
    throw new Error('a shore field stretched over no width or no height is not one: its max must be beyond its min');
  }
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** A number as the bits of a half float, rounded to the nearest, and held to the largest a half can be. */
export function halfOf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 127 + 15;
  let m = x & 0x7fffff;
  if (e >= 31) return sign | 0x7bff;
  if (e <= 0) {
    // too small for a half's own exponent: a subnormal, or nought
    if (e < -10) return sign;
    m = (m | 0x800000) >> (1 - e);
    return sign | ((m + 0x1000) >> 13);
  }
  const rounded = (e << 10) | (m >> 13);
  // rounding the fraction up can carry into the exponent, which is the next half up, as it should be
  return sign | Math.min(rounded + ((m >> 12) & 1), 0x7bff);
}

/** The field's distances as half floats, row by row as the texture is written. */
export function packShoreField(f: ShoreField): Uint16Array<ArrayBuffer> {
  const out = new Uint16Array(f.distances.length);
  for (let i = 0; i < out.length; i++) out[i] = halfOf(f.distances[i]);
  return out;
}

/**
 * Writes where the field lies and the second line into `out`: its south-west corner and one over its width and height,
 * then the gap to the second line and its width, and one where there is a field, nought where there is none. Returns
 * `out`.
 */
export function fieldUniform(out: Float32Array, f: ShoreField | null, lines: { foamGap: number; foamWidth2: number }): Float32Array {
  if (f) out.set([f.min[0], f.min[1], 1 / (f.max[0] - f.min[0]), 1 / (f.max[1] - f.min[1])]);
  else out.set([0, 0, 0, 0]);
  out.set([lines.foamGap, lines.foamWidth2, f ? 1 : 0, 0], 4);
  return out;
}
