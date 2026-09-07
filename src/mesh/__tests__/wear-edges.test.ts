import { describe, expect, it } from 'vitest';
import { computeWear } from '../wear';
import { extrude } from '../extrude';
import { MeshBuilder } from '../types';

function bevelledPlate() {
  return extrude({ outline: [[-10, -10], [10, -10], [10, 10], [-10, 10]], thickness: 2, bevel: 0.6 });
}

describe('computeWear edge cases: minimal and degenerate meshes', () => {
  it('a single isolated triangle reads as flat everywhere (no shared edge to judge curvature against)', () => {
    const mb = new MeshBuilder();
    mb.vertex(0, 0, 0, 0, 0, 1, 0, 0);
    mb.vertex(1, 0, 0, 0, 0, 1, 1, 0);
    mb.vertex(0, 1, 0, 0, 0, 1, 0, 1);
    mb.triangle(0, 1, 2);
    const wear = computeWear(mb.build());
    expect([...wear]).toEqual([0, 0, 0]);
  });

  it('a zero-area triangle (three collinear points) stays finite rather than producing NaN', () => {
    const mb = new MeshBuilder();
    mb.vertex(0, 0, 0, 0, 0, 1, 0, 0);
    mb.vertex(1, 0, 0, 0, 0, 1, 1, 0);
    mb.vertex(2, 0, 0, 0, 0, 1, 2, 0); // collinear with the first two: no real normal
    mb.triangle(0, 1, 2);
    const wear = computeWear(mb.build());
    for (const w of wear) expect(Number.isFinite(w)).toBe(true);
  });

  it('a triangle whose three vertices all coincide stays finite', () => {
    const mb = new MeshBuilder();
    for (let i = 0; i < 3; i++) mb.vertex(0, 0, 0, 0, 0, 1, 0, 0);
    mb.triangle(0, 1, 2);
    const wear = computeWear(mb.build());
    for (const w of wear) expect(Number.isFinite(w)).toBe(true);
  });

  it('two disconnected triangles are judged independently, both flat', () => {
    const mb = new MeshBuilder();
    mb.vertex(0, 0, 0, 0, 0, 1, 0, 0);
    mb.vertex(1, 0, 0, 0, 0, 1, 1, 0);
    mb.vertex(0, 1, 0, 0, 0, 1, 0, 1);
    mb.vertex(100, 100, 100, 0, 0, 1, 0, 0);
    mb.vertex(101, 100, 100, 0, 0, 1, 1, 0);
    mb.vertex(100, 101, 100, 0, 0, 1, 0, 1);
    mb.triangle(0, 1, 2);
    mb.triangle(3, 4, 5);
    const wear = computeWear(mb.build());
    expect([...wear]).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('computeWear edge cases: reference radius extremes', () => {
  it('a reference radius of 0 zeroes the smooth-curvature component, but a real crease still registers', () => {
    // tanh(k * 0) = 0 for every vertex's *edge* curvature, but the separate
    // sharp-edge (duplicate-vertex) detection judges by geometry alone and
    // is not scaled by reference at all, so a real bevel still stands out
    const mesh = bevelledPlate();
    const wear = computeWear(mesh, 0);
    const maxAbs = Math.max(...[...wear].map(Math.abs));
    expect(maxAbs).toBeGreaterThan(0.1);
  });

  it('a negative reference radius flips the sign of the smooth-curvature contribution', () => {
    const mesh = bevelledPlate();
    const pos = computeWear(mesh, 0.6);
    const neg = computeWear(mesh, -0.6);
    for (const w of neg) expect(Number.isFinite(w)).toBe(true);
    // wherever the positive read is small (away from any sharp-crease override),
    // the negative read should be its near-exact negation
    let checked = 0;
    for (let i = 0; i < pos.length; i++) {
      if (Math.abs(pos[i]) < 0.05) {
        expect(neg[i]).toBeCloseTo(-pos[i], 3);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('stays within [-1, 1] at an extreme (very large) reference radius', () => {
    const wear = computeWear(bevelledPlate(), 1000);
    for (const w of wear) { expect(w).toBeGreaterThanOrEqual(-1); expect(w).toBeLessThanOrEqual(1); }
  });
});

describe('computeWear edge cases: empty and minimal input', () => {
  it('an empty mesh returns an empty array without throwing', () => {
    expect(() => computeWear(new MeshBuilder().build())).not.toThrow();
    expect(computeWear(new MeshBuilder().build())).toHaveLength(0);
  });

  it('vertices with no triangles referencing them at all read as flat (never touched by any edge)', () => {
    const mb = new MeshBuilder();
    mb.vertex(0, 0, 0, 0, 0, 1, 0, 0); // orphan: no triangle uses it
    mb.vertex(1, 0, 0, 0, 0, 1, 1, 0);
    mb.vertex(0, 1, 0, 0, 0, 1, 0, 1);
    mb.vertex(1, 1, 0, 0, 0, 1, 1, 1);
    mb.triangle(1, 2, 3);
    const wear = computeWear(mb.build());
    expect(wear[0]).toBe(0);
  });
});
