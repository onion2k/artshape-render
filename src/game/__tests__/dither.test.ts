/**
 * The dither's sums, as the composite's WGSL has them: from -1 to 1, triangular, with a mean of nought, the same at a
 * pixel every time, and no pattern a row or a column long. The GPU's own is held to the pixels in `post.gpu.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { DITHER_STEPS, DITHER_WGSL, PCG, ditherAt, ditherValue, pcg } from '../dither';
import { COMPOSITE_WGSL } from '../shaders';

const SIDE = 256;
const all = (): number[] => {
  const out: number[] = [];
  for (let y = 0; y < SIDE; y++) for (let x = 0; x < SIDE; x++) out.push(ditherAt(x, y));
  return out;
};

describe('the dither', () => {
  it('is PCG over 32 bits: integers, and the same for the same pixel', () => {
    for (const v of [0, 1, 2 ** 31, 2 ** 32 - 1]) {
      const h = pcg(v);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
    expect(ditherAt(17, 300)).toBe(ditherAt(17, 300));
    expect(ditherAt(17, 300)).not.toBe(ditherAt(300, 17));
  });

  it('runs from -1 to 1 with a mean of nought, and is triangular: a third of it within a fifth of nought and a fiftieth past nine tenths', () => {
    const d = all();
    const n = d.length;
    expect(Math.min(...d)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...d)).toBeLessThanOrEqual(1);
    const mean = d.reduce((a, b) => a + b, 0) / n;
    expect(Math.abs(mean)).toBeLessThan(0.01);
    // a triangle on -1 to 1: 0.36 of it within 0.2 of nought, 0.01 past 0.9 either way, and a variance of a sixth
    expect(d.filter((v) => Math.abs(v) < 0.2).length / n).toBeCloseTo(0.36, 1);
    expect(d.filter((v) => Math.abs(v) > 0.9).length / n).toBeLessThan(0.02);
    const variance = d.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    expect(variance).toBeCloseTo(1 / 6, 2);
  });

  it('has no pattern along a row or a column: a pixel and its neighbours are not alike', () => {
    let across = 0,
      down = 0,
      n = 0;
    for (let y = 0; y < SIDE - 1; y++)
      for (let x = 0; x < SIDE - 1; x++) {
        across += ditherAt(x, y) * ditherAt(x + 1, y);
        down += ditherAt(x, y) * ditherAt(x, y + 1);
        n++;
      }
    // the correlation of neighbours, over a variance of a sixth
    expect(Math.abs(across / n / (1 / 6))).toBeLessThan(0.02);
    expect(Math.abs(down / n / (1 / 6))).toBeLessThan(0.02);
  });

  it('moves a value by at most its amount of the screen’s steps', () => {
    for (let x = 0; x < 64; x++) expect(Math.abs(ditherValue(x, 5, 1))).toBeLessThanOrEqual(1 / DITHER_STEPS);
    expect(Math.abs(ditherValue(3, 4, 0))).toBe(0);
  });

  it('is the same sums in the WGSL, from the same constants, and the composite adds it only when asked', () => {
    expect(DITHER_WGSL).toContain(`${PCG.mul}u`);
    expect(DITHER_WGSL).toContain(`${PCG.inc}u`);
    expect(DITHER_WGSL).toContain(`${PCG.out}u`);
    expect(DITHER_WGSL).toContain(`const DITHER_STEPS: f32 = ${DITHER_STEPS}.0;`);
    expect(COMPOSITE_WGSL).toContain('fn ditherAt(p: vec2u) -> f32');
    expect(COMPOSITE_WGSL).toContain('dither: f32');
    expect(COMPOSITE_WGSL).toMatch(/if \(post\.dither > 0\.0\) \{\s*d \+= vec3f\(post\.dither \* ditherAt\(vec2u\(in\.pos\.xy\)\) \/ DITHER_STEPS\);/);
  });
});
