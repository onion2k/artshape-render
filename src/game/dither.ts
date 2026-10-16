/**
 * The dither on the frame as it is shown: a little noise, a step or so of the screen's eight bits, added to the
 * displayed value before it is rounded to them, so a gradient that changes by less than a step over many pixels
 * (a long lawn in a gentle light) is not drawn as flat bands a step apart. The frame is half floats until the
 * composite, which writes eight bits a channel, and without it the rounding there is the only thing between a
 * smooth fall of light and the screen.
 *
 * The noise is the same at a pixel every frame, from the pixel alone, so a picture is the same every run and a still
 * frame does not shimmer; at a step of the screen it is not seen as a pattern. It is triangular, the sum of two
 * uniform numbers less one, from -1 to 1, which takes the rounding's error out of the mean and its variance alike,
 * where a uniform one leaves the variance following the gradient. Integer arithmetic (a PCG hash), since `sin` over
 * a large argument is not the same on every GPU.
 */

/** How many steps a channel of the screen has: the composite writes eight bits. */
export const DITHER_STEPS = 255;

/** The hash's constants, PCG's: a multiplier and increment for the state, and the output's multiplier. */
export const PCG = { mul: 747796405, inc: 2891336453, out: 277803737 } as const;

/** PCG's hash of a 32-bit number, as the WGSL has it. */
export function pcg(v: number): number {
  const s = (Math.imul(v >>> 0, PCG.mul) + PCG.inc) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, PCG.out) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}

/** The dither at a pixel, from -1 to 1 and triangular: two hashes of the pixel, each over 2^32, added, less one. */
export function ditherAt(x: number, y: number): number {
  const a = pcg((x >>> 0) + pcg(y >>> 0));
  const b = pcg(a);
  return a / 4294967296 + b / 4294967296 - 1;
}

/** The dither as a step of the screen's channel: what is added to the displayed value at an amplitude of `amount` steps. */
export const ditherValue = (x: number, y: number, amount: number) => (amount * ditherAt(x, y)) / DITHER_STEPS;

/** The same sums as WGSL, built from the same constants. */
export const DITHER_WGSL = `
fn pcgHash(v: u32) -> u32 {
  let s = v * ${PCG.mul}u + ${PCG.inc}u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * ${PCG.out}u;
  return (w >> 22u) ^ w;
}
fn ditherAt(p: vec2u) -> f32 {
  let a = pcgHash(p.x + pcgHash(p.y));
  let b = pcgHash(a);
  return f32(a) / 4294967296.0 + f32(b) / 4294967296.0 - 1.0;
}
const DITHER_STEPS: f32 = ${DITHER_STEPS}.0;
`;
