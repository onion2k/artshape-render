import { describe, expect, it } from 'vitest';
import { checkShoreField, fieldUniform, halfOf, packShoreField, SHORE_FIELD_FLOATS, type ShoreField } from '../shore';

const field = (size: number, fill = 1): ShoreField => ({ size, distances: new Float32Array(size * size).fill(fill), min: [-4, -2], max: [4, 6] });

describe('a shore field', () => {
  it('is turned into half floats as the GPU reads them, near enough for a distance', () => {
    const bits = new Uint16Array(1);
    for (const v of [0, 0.5, 1, 1.5, 2.25, 17.3, 1000, -3.75]) {
      bits[0] = halfOf(v);
      // read back by hand: sign, five bits of exponent, ten of fraction
      const b = bits[0];
      const sign = b >> 15 ? -1 : 1, e = (b >> 10) & 31, f = b & 1023;
      const back = e === 0 ? sign * (f / 1024) * 2 ** -14 : sign * (1 + f / 1024) * 2 ** (e - 15);
      expect(back, `${v}`).toBeCloseTo(v, Math.abs(v) > 100 ? -1 : 2);
    }
    expect(halfOf(1e9)).toBe(0x7bff);
  });

  it('packs its distances row by row from its south edge', () => {
    const f = field(2);
    f.distances.set([0, 1, 2, 3]);
    expect([...packShoreField(f)].map((b) => b.toString(16))).toEqual(['0', '3c00', '4000', '4200']);
  });

  it('is told to the clear pass by its corner and one over its size, and by whether there is one at all', () => {
    const out = new Float32Array(SHORE_FIELD_FLOATS).fill(-1);
    fieldUniform(out, field(4), { foamGap: 0.5, foamWidth2: 0.25 });
    expect([...out]).toEqual([-4, -2, 1 / 8, 1 / 8, 0.5, 0.25, 1, 0]);
    fieldUniform(out, null, { foamGap: 0.5, foamWidth2: 0.25 });
    expect(out[6], 'none').toBe(0);
  });

  it('refuses a field that is not one, by name', () => {
    expect(() => checkShoreField(field(1))).toThrow(/two texels/);
    expect(() => checkShoreField({ ...field(4), distances: new Float32Array(15) })).toThrow(/16 distances/);
    const nan = field(4);
    nan.distances[5] = Number.NaN;
    expect(() => checkShoreField(nan)).toThrow(/texel 5/);
    expect(() => checkShoreField({ ...field(4), max: [-4, 6] })).toThrow(/no width/);
    expect(() => checkShoreField(field(4))).not.toThrow();
  });
});
