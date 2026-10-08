import { describe, expect, it } from 'vitest';
import { spotShadowMatrix, sunShadowFitted, sunShadowMatrix, type Box } from '../shadows';

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

describe('the sun shadow fitted to the view', () => {
  // a hole's box: wide and long, a little deep, and tall enough for its trees
  const hole: Box = { min: [-200, -500, -4], max: [200, 500, 24] };
  const sun: [number, number, number] = [0.35, -0.3, 0.89];
  const fit = { reach: 240 };
  const MAP = 2048;

  it('covers the ground ahead of the camera to its reach, and every caster above it in depth', () => {
    const m = new Float32Array(16);
    const eye: [number, number, number] = [0, -300, 40];
    sunShadowFitted(m, sun, hole, eye, [0, -200, 0], fit, MAP);
    // the camera's own ground, and ground a good way ahead of it, are on the map
    for (const p of [
      [0, -300, 0],
      [0, -200, 0],
      [0, -120, 0],
      [60, -150, 24],
      [-60, -150, -4],
    ] as [number, number, number][]) {
      const [x, y, z] = through(m, p);
      expect(Math.abs(x)).toBeLessThan(1);
      expect(Math.abs(y)).toBeLessThan(1);
      expect(z).toBeGreaterThan(0);
      expect(z).toBeLessThan(1);
    }
    // ground far past the reach is off it
    const [fx, fy] = through(m, [0, 300, 0]);
    expect(Math.max(Math.abs(fx), Math.abs(fy))).toBeGreaterThan(1);
  });

  it('spends a texel on a reach over the map, not on the whole box', () => {
    const m = new Float32Array(16);
    sunShadowFitted(m, sun, hole, [0, -300, 40], [0, -200, 0], fit, MAP);
    // two points a texel's worth of reach apart along the light's own x land a texel's width of clip apart
    const [x0, y0] = through(m, [0, -200, 0]);
    const [x1, y1] = through(m, [10, -200, 0]);
    const clipPerUnit = Math.hypot(x1 - x0, y1 - y0) / 10;
    // the clip square is two across; a reach across it is two over the reach a unit, give or take the sun's slant
    expect(clipPerUnit).toBeGreaterThan(1.6 / fit.reach);
    expect(clipPerUnit).toBeLessThan(2.4 / fit.reach);
  });

  it('holds a still point to the same texel as the camera slides, so an edge does not swim', () => {
    const a = new Float32Array(16),
      b = new Float32Array(16);
    const texelOf = (m: Float32Array, p: [number, number, number]) => {
      const [x, y] = through(m, p);
      return [((x + 1) / 2) * MAP, ((1 - y) / 2) * MAP];
    };
    const p: [number, number, number] = [13.3, -170.7, 2];
    sunShadowFitted(a, sun, hole, [0, -300, 40], [0, -200, 0], fit, MAP);
    for (const slide of [0.01, 0.37, 1.9, 7.3]) {
      sunShadowFitted(b, sun, hole, [slide, -300 + slide, 40], [slide, -200 + slide, 0], fit, MAP);
      const [ax, ay] = texelOf(a, p),
        [bx, by] = texelOf(b, p);
      // the window moves by whole texels only, so the point's place within its texel is the same to a rounding
      expect(Math.abs((ax % 1) - (bx % 1)) % 1).toBeLessThan(1e-3);
      expect(Math.abs((ay % 1) - (by % 1)) % 1).toBeLessThan(1e-3);
    }
  });

  it('looking straight down, centres on what the camera looks at', () => {
    const m = new Float32Array(16);
    sunShadowFitted(m, sun, hole, [50, 100, 400], [50, 100, 0], fit, MAP);
    const [x, y] = through(m, [50, 100, 0]);
    expect(Math.abs(x)).toBeLessThan(0.05);
    expect(Math.abs(y)).toBeLessThan(0.05);
  });

  it('is the box fit again when the reach covers the box: nothing is lost on a small hole', () => {
    const small: Box = { min: [-30, -40, -4], max: [30, 40, 12] };
    const m = new Float32Array(16);
    sunShadowFitted(m, sun, small, [0, -60, 30], [0, 0, 0], { reach: 400 }, MAP);
    for (let i = 0; i < 8; i++) {
      const c: [number, number, number] = [
        i & 1 ? small.max[0] : small.min[0],
        i & 2 ? small.max[1] : small.min[1],
        i & 4 ? small.max[2] : small.min[2],
      ];
      const [x, y, z] = through(m, c);
      expect(Math.abs(x)).toBeLessThanOrEqual(1);
      expect(Math.abs(y)).toBeLessThanOrEqual(1);
      expect(z).toBeGreaterThanOrEqual(0);
      expect(z).toBeLessThanOrEqual(1);
    }
  });
});
