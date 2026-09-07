import { describe, expect, it } from 'vitest';
import { extrude, extrudeStepped } from '../extrude';
import { expectWellFormed, expectWatertight, boundsOf } from './helpers';
import type { Vec2 } from '../../geom/types';

const square = (size: number): Vec2[] => [
  [-size / 2, -size / 2], [size / 2, -size / 2], [size / 2, size / 2], [-size / 2, size / 2],
];

describe('extrude: structural invariants', () => {
  it('is a well-formed mesh for a plain rectangle', () => {
    const mesh = extrude({ outline: square(10), thickness: 2 });
    expectWellFormed(mesh);
  });

  it('is well-formed with a bevel', () => {
    const mesh = extrude({ outline: square(10), thickness: 2, bevel: 0.3 });
    expectWellFormed(mesh);
  });

  it('is well-formed with a hole pierced through it', () => {
    const mesh = extrude({ outline: square(10), holes: [square(3)], thickness: 2 });
    expectWellFormed(mesh);
  });

  it('every vertex carries a cap flag: +1 top, -1 bottom, or 0 on the wall/bevel', () => {
    const mesh = extrude({ outline: square(10), thickness: 2 });
    expect(mesh.cap).toBeDefined();
    for (const c of mesh.cap!) expect([1, -1, 0]).toContain(c);
    expect([...mesh.cap!]).toContain(1);
    expect([...mesh.cap!]).toContain(-1);
  });
});

describe('extrude: geometry', () => {
  it('spans exactly ±thickness/2 along z with no bevel', () => {
    const mesh = extrude({ outline: square(10), thickness: 4 });
    const b = boundsOf(mesh);
    expect(b.min[2]).toBeCloseTo(-2);
    expect(b.max[2]).toBeCloseTo(2);
  });

  it('still spans ±thickness/2 with a bevel — the bevel eats into x/y, not z', () => {
    const mesh = extrude({ outline: square(10), thickness: 4, bevel: 1 });
    const b = boundsOf(mesh);
    expect(b.min[2]).toBeCloseTo(-2);
    expect(b.max[2]).toBeCloseTo(2);
  });

  it('stays within the outline\'s own footprint in x and y', () => {
    const mesh = extrude({ outline: square(10), thickness: 2 });
    const b = boundsOf(mesh);
    expect(b.min[0]).toBeGreaterThanOrEqual(-5 - 1e-6);
    expect(b.max[0]).toBeLessThanOrEqual(5 + 1e-6);
    expect(b.min[1]).toBeGreaterThanOrEqual(-5 - 1e-6);
    expect(b.max[1]).toBeLessThanOrEqual(5 + 1e-6);
  });

  it('a hole removes cap material from its own footprint', () => {
    const withHole = extrude({ outline: square(10), holes: [square(4)], thickness: 2 });
    const withoutHole = extrude({ outline: square(10), thickness: 2 });
    // the pierced plate is the same footprint but fewer triangles overall
    // once you account for the wall the hole's own rim adds
    const capTrianglesOf = (mesh: typeof withHole) => {
      let count = 0;
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const allTop = [0, 1, 2].every((k) => mesh.cap![mesh.indices[t + k]] === 1);
        if (allTop) count++;
      }
      return count;
    };
    // the hole's rim is inset, so no cap vertex should ever fall inside it —
    // check no top-cap vertex sits within the hole's own half-width
    const holeMesh = withHole;
    for (let i = 0; i < holeMesh.positions.length / 3; i++) {
      if (holeMesh.cap![i] !== 1) continue;
      const x = holeMesh.positions[i * 3], y = holeMesh.positions[i * 3 + 1];
      const insideHole = Math.abs(x) < 1.9 && Math.abs(y) < 1.9;
      expect(insideHole).toBe(false);
    }
    expect(capTrianglesOf(withHole)).toBeGreaterThan(0);
    expect(capTrianglesOf(withoutHole)).toBeGreaterThan(0);
  });
});

describe('extrude: enamel', () => {
  it('enamelTop marks exactly the top cap, and nothing else', () => {
    const mesh = extrude({ outline: square(10), thickness: 2, enamelTop: true });
    expect(mesh.enamel).toBeDefined();
    for (let i = 0; i < mesh.enamel!.length; i++) {
      expect(mesh.enamel![i]).toBe(mesh.cap![i] === 1 ? 1 : 0);
    }
  });

  it('is absent without enamelTop', () => {
    const mesh = extrude({ outline: square(10), thickness: 2 });
    expect(mesh.enamel).toBeUndefined();
  });

  it('a bevel keeps the rim as metal — the top cap is enamelled, the bevel band is not', () => {
    const mesh = extrude({ outline: square(10), thickness: 2, bevel: 0.5, enamelTop: true });
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      if (mesh.cap![i] === 0) expect(mesh.enamel![i]).toBe(0);
    }
  });
});

describe('extrudeStepped', () => {
  const sq = (h: number): Vec2[] => [[-h, -h], [h, -h], [h, h], [-h, h]];

  it('is well-formed and rises through its tiers from z = 0', () => {
    const mesh = extrudeStepped({ tiers: [{ outline: sq(10), thickness: 2 }, { outline: sq(7), thickness: 2 }, { outline: sq(4), thickness: 2 }], bevel: 0.3 });
    expectWellFormed(mesh);
    const b = boundsOf(mesh);
    expect(b.min[2]).toBeCloseTo(0);
    expect(b.max[2]).toBeCloseTo(6);
    expect(b.max[0]).toBeCloseTo(10);
  });

  it('is watertight: one closed surface with no hidden faces', () => {
    const mesh = extrudeStepped({ tiers: [{ outline: sq(10), thickness: 2 }, { outline: sq(6), thickness: 2 }] });
    expectWatertight(mesh);
  });

  it('marks every tread as a top cap and only the foot as a bottom cap', () => {
    const mesh = extrudeStepped({ tiers: [{ outline: sq(10), thickness: 2 }, { outline: sq(6), thickness: 2 }] });
    const z = mesh.positions;
    let treads = 0, feet = 0;
    for (let i = 0; i < mesh.cap!.length; i++) {
      if (mesh.cap![i] > 0.5) { treads++; expect([2, 4]).toContainEqual(expect.closeTo(z[i * 3 + 2], 5)); }
      if (mesh.cap![i] < -0.5) { feet++; expect(z[i * 3 + 2]).toBeCloseTo(0); }
    }
    expect(treads).toBeGreaterThan(0);
    expect(feet).toBeGreaterThan(0);
  });

  it('uses fewer triangles than the same tiers stacked as whole plates', () => {
    const tiers = [{ outline: sq(10), thickness: 2 }, { outline: sq(7), thickness: 2 }, { outline: sq(4), thickness: 2 }];
    const stepped = extrudeStepped({ tiers, bevel: 0.3 });
    const stacked = tiers.reduce((n, t) => n + extrude({ outline: t.outline, thickness: t.thickness, bevel: 0.3 }).indices.length, 0);
    expect(stepped.indices.length).toBeLessThan(stacked);
  });

  it('enamels the treads only', () => {
    const mesh = extrudeStepped({ tiers: [{ outline: sq(10), thickness: 2 }, { outline: sq(6), thickness: 2 }], enamelTop: true });
    for (let i = 0; i < mesh.enamel!.length; i++) {
      expect(mesh.enamel![i]).toBe(mesh.cap![i] > 0.5 ? 1 : 0);
    }
  });
});
