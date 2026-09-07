import { describe, expect, it } from 'vitest';
import {
  chevronOutline, fanOutline, keystoneOutline, lozengeOutline, roundCorners, scallopOutline,
  signedArea, sunburstOutline, zigguratOutline,
} from '../outline';
import type { Vec2 } from '../types';

const bounds = (loop: Vec2[]) => ({
  minX: Math.min(...loop.map((p) => p[0])), maxX: Math.max(...loop.map((p) => p[0])),
  minY: Math.min(...loop.map((p) => p[1])), maxY: Math.max(...loop.map((p) => p[1])),
});

/** No two consecutive points coincide, and the loop is counter-clockwise. */
function expectCleanLoop(loop: Vec2[]) {
  expect(loop.length).toBeGreaterThanOrEqual(3);
  expect(signedArea(loop)).toBeGreaterThan(0);
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i], q = loop[(i + 1) % loop.length];
    expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeGreaterThan(1e-9);
  }
}

describe('fanOutline', () => {
  it('opens along +X from an apex at the origin', () => {
    const loop = fanOutline(10);
    expectCleanLoop(loop);
    const b = bounds(loop);
    expect(b.minX).toBeCloseTo(0, 5);
    expect(b.maxX).toBeCloseTo(10, 5);
    expect(b.minY).toBeCloseTo(-10, 5);
    expect(b.maxY).toBeCloseTo(10, 5);
    expect(loop.some(([x, y]) => x === 0 && y === 0)).toBe(true);
  });

  it('blades scallop the rim without changing its extent', () => {
    const plain = fanOutline(10, { spread: Math.PI / 2 });
    const bladed = fanOutline(10, { spread: Math.PI / 2, blades: 4, bladeDepth: 0.2 });
    expectCleanLoop(bladed);
    expect(bounds(bladed).maxX).toBeCloseTo(bounds(plain).maxX, 5);
    expect(signedArea(bladed)).toBeLessThan(signedArea(plain));
    // the rim dips to radius * (1 - depth) between blades
    const rim = bladed.filter(([x, y]) => Math.hypot(x, y) > 1e-6);
    const minR = Math.min(...rim.map(([x, y]) => Math.hypot(x, y)));
    expect(minR).toBeCloseTo(8, 3);
  });

  it('an inner radius cuts the apex away into a band', () => {
    const loop = fanOutline(10, { inner: 4 });
    expectCleanLoop(loop);
    expect(loop.every(([x, y]) => Math.hypot(x, y) > 3.99)).toBe(true);
  });

  it('a full circle spread closes without a seam point', () => {
    const loop = fanOutline(10, { spread: Math.PI * 2, blades: 6 });
    expectCleanLoop(loop);
  });
});

describe('chevronOutline', () => {
  it('is a six-point band pointing along +X', () => {
    const loop = chevronOutline(20, 8, 3);
    expectCleanLoop(loop);
    expect(loop.length).toBe(6);
    const b = bounds(loop);
    expect(b.maxX).toBeCloseTo(8);
    expect(b.minX).toBeCloseTo(-3);
    expect(b.maxY).toBeCloseTo(10);
    // a band's area is its width times its bar, measured along X
    expect(signedArea(loop)).toBeCloseTo(20 * 3, 5);
  });
});

describe('sunburstOutline', () => {
  it('has twice as many points as rays when the rays are sharp', () => {
    const loop = sunburstOutline(10, 8);
    expectCleanLoop(loop);
    expect(loop.length).toBe(16);
    const radii = loop.map(([x, y]) => Math.hypot(x, y));
    expect(Math.max(...radii)).toBeCloseTo(10);
    expect(Math.min(...radii)).toBeCloseTo(5.5);
  });

  it('a flattened tip adds a point per ray', () => {
    const loop = sunburstOutline(10, 8, { tip: 0.3 });
    expectCleanLoop(loop);
    expect(loop.length).toBe(24);
  });
});

describe('zigguratOutline', () => {
  it('rises from y = 0 through the given number of terraces', () => {
    const loop = zigguratOutline(20, 9, 3, 8);
    expectCleanLoop(loop);
    const b = bounds(loop);
    expect(b.minY).toBeCloseTo(0);
    expect(b.maxY).toBeCloseTo(9);
    expect(b.maxX).toBeCloseTo(10);
    // the top is exactly `top` wide
    const top = loop.filter(([, y]) => Math.abs(y - 9) < 1e-9);
    expect(Math.max(...top.map((p) => p[0]))).toBeCloseTo(4);
    // area: three terraces, 20, 14 and 8 wide, each 3 tall
    expect(signedArea(loop)).toBeCloseTo((20 + 14 + 8) * 3, 5);
  });

  it('is symmetric about the y axis', () => {
    const loop = zigguratOutline(20, 9, 4);
    for (const [x, y] of loop) {
      expect(loop.some(([mx, my]) => Math.abs(mx + x) < 1e-9 && Math.abs(my - y) < 1e-9)).toBe(true);
    }
  });
});

describe('keystoneOutline', () => {
  it('is a trapezoid flaring at the head', () => {
    const loop = keystoneOutline(10, 6, 0.5);
    expectCleanLoop(loop);
    expect(loop.length).toBe(4);
    const b = bounds(loop);
    expect(b.maxX).toBeCloseTo(7.5);
    expect(signedArea(loop)).toBeCloseTo(((10 + 15) / 2) * 6, 5);
  });

  it('rounded corners shrink the area a little and stay inside the sharp shape', () => {
    const sharp = keystoneOutline(10, 6, 0.5);
    const eased = keystoneOutline(10, 6, 0.5, 1);
    expectCleanLoop(eased);
    expect(signedArea(eased)).toBeLessThan(signedArea(sharp));
    expect(signedArea(eased)).toBeGreaterThan(signedArea(sharp) * 0.95);
    const bs = bounds(sharp), be = bounds(eased);
    expect(be.maxX).toBeLessThanOrEqual(bs.maxX + 1e-9);
    expect(be.maxY).toBeLessThanOrEqual(bs.maxY + 1e-9);
  });
});

describe('scallopOutline', () => {
  it('dips by the depth between lobes and reaches the radius on them', () => {
    const loop = scallopOutline(10, 8, 1.5);
    expectCleanLoop(loop);
    const radii = loop.map(([x, y]) => Math.hypot(x, y));
    expect(Math.max(...radii)).toBeCloseTo(10, 5);
    expect(Math.min(...radii)).toBeCloseTo(8.5, 5);
  });
});

describe('lozengeOutline', () => {
  it('is a rhombus when straight-sided', () => {
    const loop = lozengeOutline(20, 10);
    expectCleanLoop(loop);
    expect(loop.length).toBe(4);
    expect(signedArea(loop)).toBeCloseTo(100, 5);
  });

  it('a bulge bows the sides outward', () => {
    const loop = lozengeOutline(20, 10, 0.3);
    expectCleanLoop(loop);
    expect(signedArea(loop)).toBeGreaterThan(100);
  });
});

describe('roundCorners', () => {
  it('rounds a square into something with less area and the same extent', () => {
    const square: Vec2[] = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
    const eased = roundCorners(square, 2);
    // a square of side 10 with 4 fillets of radius 2 loses (4 - pi) r^2
    // a square of side 10 with 4 fillets of radius 2 loses (4 - pi) r^2; the
    // arcs are polygonal so the loss is a touch more
    const ideal = 100 - (4 - Math.PI) * 4;
    expect(signedArea(eased)).toBeLessThan(ideal);
    expect(signedArea(eased)).toBeGreaterThan(ideal - 0.3);
    expect(bounds(eased).maxX).toBeCloseTo(5, 9);
  });

  it('shrinks the fillet where a side is too short for it', () => {
    const sliver: Vec2[] = [[0, 0], [10, 0], [10, 1], [0, 1]];
    const eased = roundCorners(sliver, 5);
    expect(signedArea(eased)).toBeGreaterThan(0);
    expect(eased.every(([x, y]) => x >= -1e-9 && x <= 10 + 1e-9 && y >= -1e-9 && y <= 1 + 1e-9)).toBe(true);
  });
});
