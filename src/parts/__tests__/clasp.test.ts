import { describe, expect, it } from 'vitest';
import { clasp } from '../clasp';
import { findAnchor } from '../types';
import { expectWellFormed, boundsOf } from '../../mesh/__tests__/helpers';

describe('clasp: base contract', () => {
  it('is a well-formed mesh', () => {
    expectWellFormed(clasp({ radius: 0.6, hookRadius: 4 }).mesh);
  });

  it('base sits at the start of the curl, tip at the far end', () => {
    const p = clasp({ radius: 0.6, hookRadius: 4, sweep: Math.PI });
    const base = findAnchor(p, 'base');
    const tip = findAnchor(p, 'tip');
    // a half-turn hook (sweep: pi) starts at (hookRadius, 0, 0) and ends at (-hookRadius, 0, 0)
    expect(base.position[0]).toBeCloseTo(4, 1);
    expect(tip.position[0]).toBeCloseTo(-4, 1);
  });

  it('a wider sweep curls further round, back toward the base', () => {
    const short = clasp({ radius: 0.6, hookRadius: 4, sweep: Math.PI });
    const long = clasp({ radius: 0.6, hookRadius: 4, sweep: Math.PI * 1.8 });
    const tipDistanceFromBase = (p: typeof short) => {
      const b = findAnchor(p, 'base').position, t = findAnchor(p, 'tip').position;
      return Math.hypot(t[0] - b[0], t[1] - b[1], t[2] - b[2]);
    };
    // past a half turn, more sweep brings the tip back around, closer to the base
    expect(tipDistanceFromBase(long)).toBeLessThan(tipDistanceFromBase(short));
  });
});

describe('clasp: taper', () => {
  it('is full gauge at the base and thinner at the tip by default', () => {
    const p = clasp({ radius: 1, hookRadius: 5, tip: 0.4 });
    const base = findAnchor(p, 'base').position;
    const tip = findAnchor(p, 'tip').position;
    // local tube radius near a point: 3D distance of nearby vertices from it,
    // since the anchor itself sits exactly on the swept centerline
    const tubeRadiusNear = (point: readonly number[]) => {
      let best = 0;
      for (let i = 0; i < p.mesh.positions.length; i += 3) {
        const d = Math.hypot(
          p.mesh.positions[i] - point[0], p.mesh.positions[i + 1] - point[1], p.mesh.positions[i + 2] - point[2],
        );
        if (d < 1.3) best = Math.max(best, d);
      }
      return best;
    };
    expect(tubeRadiusNear(tip)).toBeLessThan(tubeRadiusNear(base));
  });

  it('tip: 1 keeps the hook at a constant gauge end to end', () => {
    const constant = clasp({ radius: 1, hookRadius: 5, tip: 1 });
    const tapered = clasp({ radius: 1, hookRadius: 5, tip: 0.3 });
    expect(constant.mesh.positions.length).toBe(tapered.mesh.positions.length);
    expect(constant.mesh.positions).not.toEqual(tapered.mesh.positions);
  });
});

describe('clasp: size', () => {
  it('a larger hookRadius makes a bigger hook', () => {
    const small = clasp({ radius: 0.6, hookRadius: 3 });
    const large = clasp({ radius: 0.6, hookRadius: 8 });
    const span = (p: typeof small) => {
      const b = boundsOf(p.mesh);
      return Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]);
    };
    expect(span(large)).toBeGreaterThan(span(small));
  });
});
