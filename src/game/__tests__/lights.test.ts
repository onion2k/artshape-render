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
    expect([...pool.data.slice(0, LIGHT_STRIDE)]).toEqual([
      1, 2, 3, 11,             // position, radius
      0.125, 0.5, 0.875, 1,    // colour, intensity
      0, 0, -1, -2,            // no cone: an outer edge no cosine can reach
      -1, 0, 0, 0,
    ]);
  });

  it('packs a spotlight with its aim normalised and its cone as cosines', () => {
    const pool = new LightPool(2);
    pool.set(0, { ...light(1), direction: [0, 0, -4], cone: [60, 90] });
    const d = [...pool.data.slice(8, 13)];
    expect(d.slice(0, 3)).toEqual([0, 0, -1]);
    expect(d[3]).toBeCloseTo(Math.cos(Math.PI / 2), 6);   // outer, 90 degrees
    expect(d[4]).toBeCloseTo(Math.cos(Math.PI / 3), 6);   // inner, 60
  });

  it('reads a cone back as the angles it was given', () => {
    const pool = new LightPool(2);
    pool.add({ ...light(1), direction: [0, 1, 0], cone: [20, 45] });
    const back = pool.get(0)!;
    expect(back.direction).toEqual([0, 1, 0]);
    expect(back.cone![0]).toBeCloseTo(20, 4);
    expect(back.cone![1]).toBeCloseTo(45, 4);
    // and a light with no direction reads back without one
    pool.add(light(2));
    expect(pool.get(1)!.direction).toBeUndefined();
  });

  it('never lets an inner angle exceed its outer', () => {
    // the smoothstep in the shader needs its edges in order or the cone
    // inverts, lighting everything except where it is pointed
    const pool = new LightPool(1);
    pool.set(0, { ...light(1), direction: [1, 0, 0], cone: [80, 30] });
    const back = pool.get(0)!;
    expect(back.cone![0]).toBeLessThanOrEqual(back.cone![1] + 1e-6);
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
