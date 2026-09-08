import { describe, expect, it } from 'vitest';
import { LIGHT_STRIDE, LightPool, type PointLight } from '../lights';

/**
 * Values a float32 holds exactly, so a round trip through the packed array
 * can be compared for equality rather than closeness. 0.1 is not one of
 * them, which is what the first version of this got wrong.
 */
const light = (n: number): PointLight => ({
  position: [n, n * 2, n * 3],
  radius: 10 + n,
  colour: [n / 8, 0.5, 1 - n / 8],
  intensity: n,
});

describe('LightPool', () => {
  it('packs a light the way the shader reads it', () => {
    const pool = new LightPool(4);
    pool.set(0, light(1));
    expect([...pool.data.slice(0, LIGHT_STRIDE)]).toEqual([1, 2, 3, 11, 0.125, 0.5, 0.875, 1]);
  });

  it('counts only up to the highest index written', () => {
    const pool = new LightPool(8);
    expect(pool.count).toBe(0);
    pool.set(3, light(1));
    // the shader walks from zero, so writing at three means four are live
    expect(pool.count).toBe(4);
    pool.set(1, light(2));
    expect(pool.count).toBe(4);
  });

  it('appends until it is full, and says so rather than losing a light', () => {
    const pool = new LightPool(2);
    expect(pool.add(light(1))).toBe(0);
    expect(pool.add(light(2))).toBe(1);
    expect(pool.add(light(3))).toBe(-1);
    expect(pool.count).toBe(2);
    expect(pool.set(2, light(4))).toBe(false);
    expect(pool.set(1, light(4))).toBe(true);
  });

  it('clears the count without disturbing what was written', () => {
    const pool = new LightPool(4);
    pool.add(light(7));
    const before = [...pool.data.slice(0, LIGHT_STRIDE)];
    pool.clear();
    expect(pool.count).toBe(0);
    expect([...pool.data.slice(0, LIGHT_STRIDE)]).toEqual(before);
    // and the next add lands back at the start
    expect(pool.add(light(9))).toBe(0);
  });

  it('reads a light back, and refuses one past the live end', () => {
    const pool = new LightPool(4);
    pool.add(light(2));
    expect(pool.get(0)).toEqual(light(2));
    expect(pool.get(1)).toBeNull();
    expect(pool.get(-1)).toBeNull();
  });

  it('never lets a radius reach zero, which would divide by it', () => {
    const pool = new LightPool(1);
    pool.set(0, { ...light(1), radius: 0 });
    expect(pool.get(0)!.radius).toBeGreaterThan(0);
  });

  it('allocates for the capacity asked for, and at least one', () => {
    expect(new LightPool(10).data.length).toBe(10 * LIGHT_STRIDE);
    expect(new LightPool(0).capacity).toBe(1);
  });
});
