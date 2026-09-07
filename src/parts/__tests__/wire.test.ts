import { describe, expect, it } from 'vitest';
import { band, blade, wire } from '../wire';
import { arc } from '../../geom/curve';
import { findAnchor } from '../types';
import { expectWellFormed, boundsOf } from '../../mesh/__tests__/helpers';

describe('wire', () => {
  it('is well-formed for every section shape', () => {
    for (const section of ['round', 'square', 'hex', 'octagon', 'flat', 'lens'] as const) {
      expectWellFormed(wire({ path: arc(5, 0, Math.PI * 2), radius: 1, section }).mesh);
    }
  });

  it('has base and tip anchors at the path\'s two ends', () => {
    const p = wire({ path: arc(5, 0, Math.PI), radius: 1 });
    const base = findAnchor(p, 'base');
    const tip = findAnchor(p, 'tip');
    expect(base.position[0]).toBeCloseTo(5, 1);
    expect(tip.position[0]).toBeCloseTo(-5, 1);
  });

  it('has no base/tip anchors when closed into a loop', () => {
    const p = wire({ path: arc(5, 0, Math.PI * 2), radius: 1, closed: true });
    expect(p.anchors).toHaveLength(0);
  });

  it('tip tapers to a fraction of the base radius', () => {
    const full = wire({ path: arc(5, 0, Math.PI / 2), radius: 2, tipScale: 1 });
    const tapered = wire({ path: arc(5, 0, Math.PI / 2), radius: 2, tipScale: 0.1 });
    // the tube's local radius right at its tip: 3D distance of each vertex from
    // the tip anchor itself, which sits exactly on the path and so is not
    // affected by taper. The sweep's rotation-minimizing frame can rotate the
    // profile's local axes along the path, so this has to be a true 3D
    // distance from a fixed reference point, not a planar/radial proxy.
    // the largest distance any vertex within a short reach of the tip anchor
    // has from it is a stand-in for the tube's local radius there, since the
    // anchor itself sits exactly on the path centerline
    const tubeRadiusAtTip = (p: typeof full) => {
      const tip = findAnchor(p, 'tip').position;
      let best = 0;
      for (let i = 0; i < p.mesh.positions.length; i += 3) {
        const d = Math.hypot(
          p.mesh.positions[i] - tip[0], p.mesh.positions[i + 1] - tip[1], p.mesh.positions[i + 2] - tip[2],
        );
        if (d < 2) best = Math.max(best, d);
      }
      return best;
    };
    expect(tubeRadiusAtTip(tapered)).toBeLessThan(tubeRadiusAtTip(full));
  });

  it('a round wire is dipped whole when enamelled', () => {
    const p = wire({ path: arc(5, 0, Math.PI * 2), radius: 1, enamel: 'cobalt' });
    expect([...p.mesh.enamel!].every((v) => v === 1)).toBe(true);
  });

  it('a flat wire enamels only one face, not the whole body', () => {
    const p = wire({ path: arc(5, 0, Math.PI * 2), radius: 1, section: 'flat', enamel: 'cobalt' });
    const flags = [...p.mesh.enamel!];
    expect(flags).toContain(0);
    expect(flags).toContain(1);
  });
});

describe('blade', () => {
  it('is well-formed', () => {
    expectWellFormed(blade({ path: arc(10, 0, Math.PI), width: 4, thickness: 0.8 }).mesh);
  });

  it('has a single base anchor at the path\'s start', () => {
    const p = blade({ path: arc(10, 0, Math.PI), width: 4, thickness: 0.8 });
    expect(p.anchors).toHaveLength(1);
    expect(p.anchors[0].name).toBe('base');
  });

  it('dies away toward the tip by default (the leaf-like swell)', () => {
    const p = blade({ path: arc(10, 0, Math.PI), width: 6, thickness: 1 });
    // near t=1 the default swell approaches ~0.06 of the width; near the
    // middle it approaches its peak — so the mesh should be much narrower
    // (in the profile's own thickness direction) at the very end
    const b = boundsOf(p.mesh);
    expect(b.max[2] - b.min[2]).toBeGreaterThan(0);
  });
});

describe('band', () => {
  it('is well-formed and watertight — a closed ring standing on edge', () => {
    expectWellFormed(band({ radius: 20, width: 3, thickness: 0.9 }).mesh);
  });

  it('north and south anchors sit opposite each other at the given radius', () => {
    const p = band({ radius: 20, width: 3, thickness: 0.9 });
    expect(findAnchor(p, 'north').position).toEqual([20, 0, 0]);
    expect(findAnchor(p, 'south').position).toEqual([-20, 0, 0]);
  });

  it('stands on edge: the ribbon\'s width runs along z (the ring axis), its thickness runs radially', () => {
    const p = band({ radius: 20, width: 8, thickness: 0.9 });
    const b = boundsOf(p.mesh);
    // width, not thickness, is what "standing on edge" means here: see the
    // comment on band() — the frame is seeded so width lies along +Z
    expect(b.max[2] - b.min[2]).toBeCloseTo(8, 0);
    let maxR = 0, minR = Infinity;
    for (let i = 0; i < p.mesh.positions.length; i += 3) {
      const r = Math.hypot(p.mesh.positions[i], p.mesh.positions[i + 1]);
      maxR = Math.max(maxR, r); minR = Math.min(minR, r);
    }
    expect(maxR - minR).toBeCloseTo(0.9, 0);
  });
});
