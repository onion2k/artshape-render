import { describe, expect, it } from 'vitest';
import { spotShadowMatrix, sunShadowMatrix, type Box } from '../shadows';

/** A point through a matrix, divided out. */
function through(m: Float32Array, p: [number, number, number]): [number, number, number, number] {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [x / w, y / w, z / w, w];
}

const box: Box = { min: [-6600, -6600, -100], max: [6600, 6600, 700] };

describe('the sun shadow matrix', () => {
  it('puts every corner of the box inside the clip volume', () => {
    const m = new Float32Array(16);
    sunShadowMatrix(m, [0.34, 0.52, 0.78], box);
    for (let i = 0; i < 8; i++) {
      const c: [number, number, number] = [
        i & 1 ? box.max[0] : box.min[0], i & 2 ? box.max[1] : box.min[1], i & 4 ? box.max[2] : box.min[2],
      ];
      const [x, y, z] = through(m, c);
      expect(Math.abs(x)).toBeLessThanOrEqual(1);
      expect(Math.abs(y)).toBeLessThanOrEqual(1);
      expect(z).toBeGreaterThanOrEqual(0);
      expect(z).toBeLessThanOrEqual(1);
    }
  });

  it('is orthographic: w is one everywhere, so depth is linear in distance', () => {
    const m = new Float32Array(16);
    sunShadowMatrix(m, [0, 0, 1], box);
    const [, , zLow, w1] = through(m, [0, 0, 0]);
    const [, , zHigh, w2] = through(m, [0, 0, 400]);
    const [, , zMid] = through(m, [0, 0, 200]);
    expect(w1).toBeCloseTo(1);
    expect(w2).toBeCloseTo(1);
    // straight overhead: nearer the light is nearer depth zero
    expect(zHigh).toBeLessThan(zLow);
    expect(zMid).toBeCloseTo((zLow + zHigh) / 2, 5);
  });

  it('fills the map: the box spans most of the clip square, not a corner of it', () => {
    const m = new Float32Array(16);
    sunShadowMatrix(m, [0, 0, 1], box);
    // which clip axis world x lands on depends on the basis the light picked,
    // so it is the distance across the map that is checked
    const [x0, y0] = through(m, [box.min[0], 0, 0]);
    const [x1, y1] = through(m, [box.max[0], 0, 0]);
    expect(Math.hypot(x1 - x0, y1 - y0)).toBeGreaterThan(1.7);
  });
});

describe('the spot shadow matrix', () => {
  it('sees along its aim, with the aim at the middle of the map', () => {
    const m = new Float32Array(16);
    spotShadowMatrix(m, [0, 0, 500], [0, 0, -1], 30, 3000);
    const [x, y, z, w] = through(m, [0, 0, 0]);
    expect(Math.abs(x)).toBeLessThan(1e-4);
    expect(Math.abs(y)).toBeLessThan(1e-4);
    expect(w).toBeGreaterThan(0);
    expect(z).toBeGreaterThan(0);
    expect(z).toBeLessThan(1);
  });

  it('has the cone just inside its edges', () => {
    const m = new Float32Array(16);
    const outer = 30;
    spotShadowMatrix(m, [0, 0, 500], [0, 0, -1], outer, 3000);
    // a point on the cone's edge, 500 below the lamp
    const r = 500 * Math.tan((outer * Math.PI) / 180);
    const [x, y] = through(m, [r, 0, 0]);
    const off = Math.hypot(x, y);
    expect(off).toBeLessThan(1);
    expect(off).toBeGreaterThan(0.85);
  });

  it('puts nothing behind the lamp on the map', () => {
    const m = new Float32Array(16);
    spotShadowMatrix(m, [0, 0, 500], [0, 0, -1], 30, 3000);
    const [, , , w] = through(m, [0, 0, 900]);
    expect(w).toBeLessThan(0);
  });
});
