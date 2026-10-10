import { describe, expect, it } from 'vitest';
import { WAVE_FLOATS, WAVE_SLOTS, gerstnerAt, heightAt, packWaves, waveSpeed, type GerstnerWave } from '../waves';
import { resolveClear } from '../clear';

const G = 98.1;
const ONE: GerstnerWave[] = [{ direction: 0, wavelength: 8, amplitude: 0.1, steepness: 0.5 }];
const FOUR: GerstnerWave[] = [
  { direction: 0.3, wavelength: 9, amplitude: 0.08, steepness: 0.3 },
  { direction: 1.9, wavelength: 5.5, amplitude: 0.05, steepness: 0.25 },
  { direction: -1.1, wavelength: 3.2, amplitude: 0.03, steepness: 0.2 },
  { direction: 2.7, wavelength: 13, amplitude: 0.1, steepness: 0.15 },
];

describe('Gerstner waves', () => {
  it('move nothing when there are none', () => {
    const out = new Float64Array(5);
    gerstnerAt([], 3, -2, 7, G, out);
    expect([...out]).toEqual([0, 0, 0, 0, 0]);
    expect(heightAt([], 3, -2, 7, G)).toBe(0);
  });

  it('travel at the speed deep water gives their length, and rise and fall by their amplitude', () => {
    // a wave of length L in deep water goes at sqrt(g L / 2 pi)
    expect(waveSpeed(8, G)).toBeCloseTo(Math.sqrt((G * 8) / (2 * Math.PI)), 10);
    const out = new Float64Array(5);
    let most = -Infinity,
      least = Infinity;
    for (let k = 0; k < 64; k++) {
      gerstnerAt(ONE, (k / 64) * 8, 0, 0, G, out);
      most = Math.max(most, out[2]);
      least = Math.min(least, out[2]);
    }
    expect(most).toBeCloseTo(0.1, 3);
    expect(least).toBeCloseTo(-0.1, 3);
  });

  it('give the height at a place in the world, from the point of the surface that moved there', () => {
    const at = new Float64Array(5);
    for (const [x, y, t] of [
      [0, 0, 0],
      [3.3, -7.1, 2.5],
      [-12, 4, 9.75],
    ]) {
      // the surface's point (x, y) moves to (x + dx, y + dy) and rises by h; the height there is h
      gerstnerAt(FOUR, x, y, t, G, at);
      expect(heightAt(FOUR, x + at[0], y + at[1], t, G), `${x},${y} at ${t}`).toBeCloseTo(at[2], 4);
    }
  });

  it("pack into the clear pass's floats, four at the most, and refuse a fifth by name", () => {
    expect(WAVE_SLOTS).toBe(4);
    const out = new Float32Array(WAVE_FLOATS).fill(-1);
    packWaves(out, ONE, G);
    const k = (2 * Math.PI) / 8;
    expect([...out.subarray(0, 8)].map((v) => Math.round(v * 1e5) / 1e5)).toEqual(
      [1, 0, k, 0.1, 0.5, Math.sqrt(G * k), 0, 0].map((v) => Math.round(Math.fround(v) * 1e5) / 1e5),
    );
    // the slots not used are noughts, which move nothing
    expect([...out.subarray(8)].every((v) => v === 0)).toBe(true);
    expect(out[WAVE_FLOATS - 1]).toBe(0);
    expect(() => packWaves(out, [...FOUR, ONE[0]], G)).toThrow(/five waves/);
  });

  it('are taken through the clear water settings, refused past four', () => {
    expect(resolveClear({ waves: FOUR }, 100).waves).toEqual(FOUR);
    expect(resolveClear(undefined, 100).waves).toEqual([]);
    expect(() => resolveClear({ waves: [...FOUR, ONE[0]] }, 100)).toThrow(/five waves/);
  });
});
