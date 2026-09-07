import { describe, expect, it } from 'vitest';
import { extrude } from '../extrude';
import { expectWellFormed, boundsOf } from './helpers';
import type { Vec2 } from '../../geom/types';

const finite = (mesh: ReturnType<typeof extrude>) => [...mesh.positions].every(Number.isFinite);
const square: Vec2[] = [[-5, -5], [5, -5], [5, 5], [-5, 5]];

describe('extrude edge cases: degenerate outlines', () => {
  it('a triangle — the minimum outline earcut can triangulate at all — is well-formed', () => {
    const mesh = extrude({ outline: [[0, 0], [10, 0], [5, 8]], thickness: 2 });
    expectWellFormed(mesh);
  });

  it('a 2-point "outline" does not throw, though it has no real area', () => {
    expect(() => extrude({ outline: [[0, 0], [10, 0]], thickness: 2 })).not.toThrow();
  });

  it('a zero-area outline (three collinear points) does not throw', () => {
    const mesh = extrude({ outline: [[0, 0], [5, 0], [10, 0]], thickness: 2 });
    expect(finite(mesh)).toBe(true);
  });
});

describe('extrude edge cases: thickness and bevel', () => {
  it('thickness=0 collapses the top and bottom caps onto (almost) the same plane, but stays finite', () => {
    // bevel defaults to min(0, thickness/2 - 1e-4); at thickness=0 that is a
    // tiny negative number rather than 0, so the wall/bevel bands end up a
    // fraction of a micron thick instead of exactly zero — an epsilon
    // artefact of the clamp, not a real bevel
    const mesh = extrude({ outline: square, thickness: 0 });
    expect(finite(mesh)).toBe(true);
    const b = boundsOf(mesh);
    expect(b.max[2] - b.min[2]).toBeLessThan(0.001);
  });

  it('a bevel at or beyond thickness/2 is clamped, not left to invert the wall', () => {
    // bevel is clamped to `min(bevel, thickness/2 - epsilon)` internally
    const mesh = extrude({ outline: square, thickness: 2, bevel: 5 });
    expect(finite(mesh)).toBe(true);
    const b = boundsOf(mesh);
    expect(b.max[2]).toBeCloseTo(1, 1);
    expect(b.min[2]).toBeCloseTo(-1, 1);
  });

  it('a negative bevel does not throw, though it bevels outward instead of in', () => {
    const mesh = extrude({ outline: square, thickness: 2, bevel: -1 });
    expect(finite(mesh)).toBe(true);
  });
});

describe('extrude edge cases: holes', () => {
  it('a hole the same size as the outline does not throw', () => {
    const mesh = extrude({ outline: square, holes: [square], thickness: 2 });
    expect(finite(mesh)).toBe(true);
  });

  it('a hole larger than the outline does not throw — extrude does not validate this itself', () => {
    // fitsInside()/clearsOthers() (geom/outline.ts) are what keep a real part's
    // piercings sane before they ever reach extrude(); extrude() itself just
    // hands whatever loops it is given to earcut
    const big: Vec2[] = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
    const mesh = extrude({ outline: square, holes: [big], thickness: 2 });
    expect(finite(mesh)).toBe(true);
  });
});

describe('extrude edge cases: maxCapEdge', () => {
  it('maxCapEdge=0 is treated the same as not tessellating further, not as "infinitely fine"', () => {
    // spacing = min(maxCapEdge ?? Infinity, ...); the tessellation pass only
    // runs when spacing > 0, so 0 skips it entirely rather than requesting
    // an impossible zero-length subdivision
    const withZero = extrude({ outline: square, thickness: 2, maxCapEdge: 0 });
    const withNone = extrude({ outline: square, thickness: 2 });
    expect(withZero.positions.length).toBeLessThanOrEqual(withNone.positions.length + 12);
    expect(finite(withZero)).toBe(true);
  });

  it('a maxCapEdge tighter than the default spacing densifies the cap further', () => {
    // the default spacing is max(span.width, span.height) * 0.05, which for
    // this 10-unit square is 0.5 — so 0.5 alone would be a no-op; go tighter
    const dense = extrude({ outline: square, thickness: 2, maxCapEdge: 0.1 });
    const plain = extrude({ outline: square, thickness: 2 });
    expect(dense.positions.length).toBeGreaterThan(plain.positions.length);
  });
});
