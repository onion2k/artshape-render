import { describe, expect, it } from 'vitest';
import {
  along, compose, dihedral, helical, mirror, nested, phyllotaxis, radial, ring,
  spray, sphereShell, branching,
} from '../symmetry';
import { determinant3, identity, transformDirection, transformPoint } from '../../geom/transform';
import { arc } from '../../geom/curve';
import { len } from '../../geom/vec';
import { expectVec } from '../../geom/__tests__/helpers';

describe('radial', () => {
  it('produces `count` transforms', () => {
    expect(radial(6)).toHaveLength(6);
  });

  it('spaces them evenly about Z, each carrying +X to the ith angle', () => {
    const sym = radial(4);
    expectVec(transformDirection(sym[0], [1, 0, 0]), [1, 0, 0]);
    expectVec(transformDirection(sym[1], [1, 0, 0]), [0, 1, 0]);
    expectVec(transformDirection(sym[2], [1, 0, 0]), [-1, 0, 0]);
  });

  it('offsets every copy by phase', () => {
    const sym = radial(4, Math.PI / 2);
    expectVec(transformDirection(sym[0], [1, 0, 0]), [0, 1, 0]);
  });
});

describe('ring', () => {
  it('places `count` copies on a circle of the given radius', () => {
    const sym = ring(8, 5);
    expect(sym).toHaveLength(8);
    for (const m of sym) {
      const p = transformPoint(m, [0, 0, 0]);
      expect(Math.hypot(p[0], p[1])).toBeCloseTo(5);
      expect(p[2]).toBeCloseTo(0);
    }
  });

  it('lifts every copy by z', () => {
    const sym = ring(4, 5, { z: 3 });
    expect(transformPoint(sym[0], [0, 0, 0])[2]).toBeCloseTo(3);
  });

  it('faces each copy outward along +X', () => {
    const sym = ring(4, 5);
    // copy 0 is at angle 0: outward is (1, 0, 0)
    expectVec(transformDirection(sym[0], [1, 0, 0]), [1, 0, 0]);
    // copy 1 is at angle 90deg: outward is (0, 1, 0)
    expectVec(transformDirection(sym[1], [1, 0, 0]), [0, 1, 0]);
  });

  it('scales each copy uniformly', () => {
    const sym = ring(1, 5, { scale: 2 });
    expectVec(transformDirection(sym[0], [1, 0, 0]), [2, 0, 0]);
  });

  it('tilts about the local tangent, not a fixed world axis', () => {
    // a positive tilt on the copy facing +Y should still tip its growth
    // direction toward -Z, exactly as it does for the copy facing +X
    const sym = ring(4, 5, { tilt: 0.3 });
    expect(transformDirection(sym[0], [1, 0, 0])[2]).toBeLessThan(0);
    expect(transformDirection(sym[1], [1, 0, 0])[2]).toBeLessThan(0);
  });
});

describe('dihedral', () => {
  it('produces 2n copies: n rotations and their mirror images', () => {
    expect(dihedral(5)).toHaveLength(10);
  });

  it('has a positive determinant on the first half and negative on the second', () => {
    const sym = dihedral(4);
    for (let i = 0; i < 4; i++) expect(determinant3(sym[i])).toBeGreaterThan(0);
    for (let i = 4; i < 8; i++) expect(determinant3(sym[i])).toBeLessThan(0);
  });
});

describe('mirror', () => {
  it('is the identity plus one reflection', () => {
    const sym = mirror([1, 0, 0]);
    expect(sym).toHaveLength(2);
    expectVec(transformPoint(sym[0], [1, 2, 3]), [1, 2, 3]);
    expectVec(transformPoint(sym[1], [1, 2, 3]), [-1, 2, 3]);
  });
});

describe('helical', () => {
  it('produces `count` copies rising and turning together', () => {
    const sym = helical(5, 10, 20, 2);
    expect(sym).toHaveLength(5);
    const z = sym.map((m) => transformPoint(m, [0, 0, 0])[2]);
    // rises from -10 to +10 across the run
    expect(z[0]).toBeCloseTo(-10, 1);
    expect(z[z.length - 1]).toBeCloseTo(10, 1);
    // strictly increasing
    for (let i = 1; i < z.length; i++) expect(z[i]).toBeGreaterThan(z[i - 1]);
  });

  it('a single copy sits at t=0 — the bottom of the range, not its centre', () => {
    const sym = helical(1, 10, 20, 2);
    expect(transformPoint(sym[0], [0, 0, 0])[2]).toBeCloseTo(-10);
  });
});

describe('phyllotaxis', () => {
  it('produces `count` copies, none coincident, spreading outward with index', () => {
    const sym = phyllotaxis(20, 2);
    expect(sym).toHaveLength(20);
    const r = sym.map((m) => len(transformPoint(m, [0, 0, 0])));
    for (let i = 1; i < r.length; i++) expect(r[i]).toBeGreaterThanOrEqual(r[i - 1]);
  });

  it('accepts a tilt as a function of normalised position', () => {
    const sym = phyllotaxis(10, 2, { tilt: (t) => t * 0.5 });
    expect(sym).toHaveLength(10);
  });
});

describe('sphereShell', () => {
  it('places every copy at the given radius from the origin', () => {
    const sym = sphereShell(50, 10);
    for (const m of sym) {
      expect(len(transformPoint(m, [0, 0, 0]))).toBeCloseTo(10, 3);
    }
  });

  it('orients outward copies so +X points away from the centre', () => {
    const sym = sphereShell(20, 10, { orient: 'outward' });
    for (const m of sym) {
      const p = transformPoint(m, [0, 0, 0]);
      const outward = transformDirection(m, [1, 0, 0]);
      const radial3 = [p[0] / len(p), p[1] / len(p), p[2] / len(p)] as const;
      const dot = outward[0] * radial3[0] + outward[1] * radial3[1] + outward[2] * radial3[2];
      expect(dot).toBeGreaterThan(0.99);
    }
  });

  it('orients flat copies so +Z points away from the centre instead', () => {
    const sym = sphereShell(20, 10, { orient: 'flat' });
    for (const m of sym) {
      const p = transformPoint(m, [0, 0, 0]);
      const faceNormal = transformDirection(m, [0, 0, 1]);
      const radial3 = [p[0] / len(p), p[1] / len(p), p[2] / len(p)] as const;
      const dot = faceNormal[0] * radial3[0] + faceNormal[1] * radial3[1] + faceNormal[2] * radial3[2];
      expect(dot).toBeGreaterThan(0.99);
    }
  });
});

describe('along', () => {
  it('produces `count` copies distributed over the curve', () => {
    const sym = along(arc(10, 0, Math.PI), 6);
    expect(sym).toHaveLength(6);
    const first = transformPoint(sym[0], [0, 0, 0]);
    const last = transformPoint(sym[sym.length - 1], [0, 0, 0]);
    expectVec(first, [10, 0, 0], 1);
    expectVec(last, [-10, 0, 0], 1);
  });

  it('respects a from/to sub-range of the curve', () => {
    const sym = along(arc(10, 0, Math.PI * 2), 3, { from: 0, to: 0.25 });
    const first = transformPoint(sym[0], [0, 0, 0]);
    const last = transformPoint(sym[sym.length - 1], [0, 0, 0]);
    expectVec(first, [10, 0, 0], 1);
    expectVec(last, [0, 10, 0], 1);
  });

  it('alternating turns every other copy about the face normal without mirroring it', () => {
    const sym = along(arc(10, 0, Math.PI), 4, { alternate: true });
    for (const m of sym) expect(determinant3(m)).toBeGreaterThan(0);
  });
});

describe('compose', () => {
  it('produces every combination of outer and inner', () => {
    const outer = radial(3);
    const inner = mirror();
    expect(compose(outer, inner)).toHaveLength(6);
  });

  it('is empty if either input is empty', () => {
    expect(compose([], mirror())).toHaveLength(0);
    expect(compose(radial(3), [])).toHaveLength(0);
  });
});

describe('nested', () => {
  it('scales each successive copy by `factor` to the power of its index', () => {
    const sym = nested(4, 0.5);
    const scaleAt = (m: (typeof sym)[number]) => len(transformDirection(m, [1, 0, 0]));
    expect(scaleAt(sym[0])).toBeCloseTo(1);
    expect(scaleAt(sym[1])).toBeCloseTo(0.5);
    expect(scaleAt(sym[2])).toBeCloseTo(0.25);
    expect(scaleAt(sym[3])).toBeCloseTo(0.125);
  });

  it('spins each successive copy by `spin` times its index', () => {
    const sym = nested(3, 1, Math.PI / 2);
    expectVec(transformDirection(sym[0], [1, 0, 0]), [1, 0, 0]);
    expectVec(transformDirection(sym[1], [1, 0, 0]), [0, 1, 0]);
    expectVec(transformDirection(sym[2], [1, 0, 0]), [-1, 0, 0]);
  });
});

describe('spray', () => {
  it('produces `count` copies, gathered at the centre and spreading toward the rim', () => {
    const sym = spray(30, 10);
    expect(sym).toHaveLength(30);
    const r = sym.map((m) => Math.hypot(...transformPoint(m, [0, 0, 0]).slice(0, 2) as [number, number]));
    expect(r[0]).toBeCloseTo(0);
    expect(Math.max(...r)).toBeCloseTo(10, 0);
  });

  it('leans +Z outward rather than +X, unlike the other symmetries', () => {
    const sym = spray(10, 10, { lean: 0.8 });
    // the outermost copy should have tipped its own +Z away from vertical
    const last = sym[sym.length - 1];
    const faceUp = transformDirection(last, [0, 0, 1]);
    expect(Math.abs(faceUp[2])).toBeLessThan(1);
  });
});

describe('branching', () => {
  it('counts 1 + n + n² + … placements, or only the last level with tipsOnly', () => {
    expect(branching(3, 2, 10, 0.5, 0.7).length).toBe(1 + 2 + 4 + 8);
    expect(branching(3, 2, 10, 0.5, 0.7, { tipsOnly: true }).length).toBe(8);
    expect(branching(0, 2, 10, 0.5, 0.7).length).toBe(1);
  });

  it('puts each child at its parent\'s tip, tilted by the spread and shrunk', () => {
    const sym = branching(1, 2, 10, 0.4, 0.7);
    const [root, a, b] = sym;
    expect(Array.from(root)).toEqual(Array.from(identity()));
    // both children start at the root's tip
    expectVec(transformPoint(a, [0, 0, 0]), [10, 0, 0]);
    expectVec(transformPoint(b, [0, 0, 0]), [10, 0, 0]);
    // and lean away from +X by the spread, on opposite sides, at the shrunk scale
    const da = transformDirection(a, [1, 0, 0]);
    const db = transformDirection(b, [1, 0, 0]);
    expect(Math.hypot(...da)).toBeCloseTo(0.7);
    expect(Math.acos(da[0] / 0.7)).toBeCloseTo(0.4);
    expect(Math.acos(db[0] / 0.7)).toBeCloseTo(0.4);
    expect(da[1]).toBeCloseTo(-db[1]);
    expect(Math.abs(da[2])).toBeLessThan(1e-9);   // a fork of two with no twist lies flat
  });

  it('a grandchild sits at the shrunk tip of its parent, in the parent\'s frame', () => {
    const sym = branching(2, 1, 10, 0.3, 0.5);
    const [, child, grandchild] = sym;
    const childTip = transformPoint(child, [10, 0, 0]);
    expectVec(transformPoint(grandchild, [0, 0, 0]), childTip);
  });

  it('a twist rolls each level round its parent', () => {
    const flat = branching(2, 2, 10, 0.4, 0.7);
    const twisted = branching(2, 2, 10, 0.4, 0.7, { twist: Math.PI / 2 });
    // the first fork is the same either way; the second is turned out of the plane
    expectVec(transformPoint(twisted[1], [1, 0, 0]), transformPoint(flat[1], [1, 0, 0]));
    const g = transformDirection(twisted[3], [1, 0, 0]);
    expect(Math.abs(g[2])).toBeGreaterThan(0.05);
  });
});
