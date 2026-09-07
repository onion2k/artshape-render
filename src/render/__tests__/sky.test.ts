import { describe, expect, it } from 'vitest';
import { cubeDirection, skyDistribution, texelSolidAngle, type EnvSamples } from '../env';

/** A sample cube of one radiance everywhere, with a few texels set brighter. */
function cube(size: number, radiance: number, bright: Array<[number, number, number, number]> = []): EnvSamples {
  const faces = Array.from({ length: 6 }, () => new Float32Array(size * size * 4).fill(radiance));
  for (const [f, x, y, r] of bright) faces[f].fill(r, (y * size + x) * 4, (y * size + x) * 4 + 3);
  return { faces, size };
}

describe('skyDistribution', () => {
  it('is a cumulative distribution: rising, ending at one, one entry a texel', () => {
    const { cdf } = skyDistribution(cube(8, 1));
    expect(cdf.length).toBe(6 * 64);
    for (let i = 1; i < cdf.length; i++) expect(cdf[i]).toBeGreaterThanOrEqual(cdf[i - 1]);
    expect(cdf[cdf.length - 1]).toBe(1);
  });

  it('an even sky puts a sixth of its mass on each face, and is not concentrated', () => {
    const { cdf, concentration } = skyDistribution(cube(16, 1));
    const perFace = 16 * 16;
    for (let f = 0; f < 6; f++) expect(cdf[(f + 1) * perFace - 1] - (f ? cdf[f * perFace - 1] : 0)).toBeCloseTo(1 / 6, 3);
    expect(concentration).toBeLessThan(0.03);
  });

  it('a sun carries most of the mass, and the sky reads as concentrated', () => {
    const { cdf, concentration } = skyDistribution(cube(16, 1, [[4, 8, 8, 5000]]));
    const i = (4 * 16 + 8) * 16 + 8;
    expect(cdf[i] - cdf[i - 1]).toBeGreaterThan(0.5);
    expect(concentration).toBeGreaterThan(0.5);
  });

  it('the texels\' solid angles sum to the sphere', () => {
    const size = 32;
    let total = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) total += texelSolidAngle(x, y, size);
    expect(total * 6).toBeCloseTo(4 * Math.PI, 1);
  });

  it('cube directions are unit and point out of their face', () => {
    const axes: Array<[number, number]> = [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]];
    axes.forEach(([axis, sign], face) => {
      const d = cubeDirection(face, 0.3, -0.2);
      expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 6);
      expect(Math.sign(d[axis])).toBe(sign);
      const c = cubeDirection(face, 0, 0);
      expect(Math.abs(c[axis])).toBeCloseTo(1, 6);
    });
  });
});
