/**
 * The wind under node: its packing into the wash's uniform, and the air's
 * velocity at a point, which is the wind with the wash's air on top. The
 * shader's own sum is held to `airVelocity` on a device in `wind.gpu.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { WASH_CAPACITY, WASH_STRIDE, WIND_AT, airVelocity, packWind, washVelocity, type Wash } from '../wash';

const WASH: Wash = { position: [0, 0, 100], radius: 40, speed: 400, reach: 160 };

describe('packing the wind', () => {
  it('lies after the washes, in the floats the uniform has for it, and says whether it blows', () => {
    expect(WIND_AT).toBe(WASH_CAPACITY * WASH_STRIDE);
    const out = new Float32Array(WIND_AT + 4).fill(9);
    expect(packWind(out, [3, -4, 0.5])).toBe(true);
    expect([...out.slice(WIND_AT, WIND_AT + 4)]).toEqual([3, -4, 0.5, 0]);
    expect(out[WIND_AT - 1]).toBe(9);
    expect(packWind(out, [0, 0, 0])).toBe(false);
    expect([...out.slice(WIND_AT, WIND_AT + 4)]).toEqual([0, 0, 0, 0]);
  });

  it('takes nothing from a wind that is not a number, as no wind', () => {
    const out = new Float32Array(WIND_AT + 4);
    for (const bad of [[NaN, 1, 1], [1, Infinity, 0], [0, 0, -Infinity]] as const) {
      expect(packWind(out, bad)).toBe(false);
      expect([...out.slice(WIND_AT, WIND_AT + 4)]).toEqual([0, 0, 0, 0]);
    }
  });
});

describe('the air at a point', () => {
  it('is the wind alone with no wash, the same everywhere', () => {
    for (const p of [[0, 0, 0], [500, -20, 90], [0, 0, -1e4]] as const) expect(airVelocity([30, -10, 2], [], p)).toEqual([30, -10, 2]);
  });

  it('is the wash alone with no wind, to the bit', () => {
    for (const p of [[0, 0, 60], [8, 0, 90], [300, 0, 0]] as const) expect(airVelocity([0, 0, 0], [WASH], p, 0.5)).toEqual(washVelocity([WASH], p, 0.5));
  });

  it('is the wind with the wash on top where the wash blows, and the wind alone where it does not', () => {
    const wind: [number, number, number] = [30, -10, 2];
    const under = airVelocity(wind, [WASH], [8, 0, 90], 0.5);
    const wash = washVelocity([WASH], [8, 0, 90], 0.5);
    expect(wash[2]).toBeLessThan(0);
    [0, 1, 2].forEach((k) => expect(under[k]).toBeCloseTo(wind[k] + wash[k], 12));
    expect(airVelocity(wind, [WASH], [300, 0, 0], 0.5)).toEqual(wind);
  });

  it('is none with neither', () => {
    expect(airVelocity([0, 0, 0], [], [1, 2, 3])).toEqual([0, 0, 0]);
  });
});
