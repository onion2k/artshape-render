import { describe, expect, it } from 'vitest';
import { bar, disc, gusset, plate } from '../panel';
import { chevronOutline, circleOutline, fanOutline, sunburstOutline, zigguratOutline } from '../../geom/outline';
import { findAnchor } from '../types';
import { expectWellFormed, boundsOf } from '../../mesh/__tests__/helpers';

describe('bar', () => {
  it('is well-formed', () => {
    expectWellFormed(bar({ length: 34, width: 5, thickness: 1.4, bore: 2.2 }).mesh);
  });

  it('has anchors a and b at the two end holes', () => {
    const p = bar({ length: 30, width: 5, thickness: 1.4, bore: 2 });
    const a = findAnchor(p, 'a');
    const b = findAnchor(p, 'b');
    expect(a.bore).toBe(2);
    expect(b.bore).toBe(2);
    expect(Math.abs(a.position[0] - b.position[0])).toBeCloseTo(30 - 5, 1);
  });

  it('adds numbered intermediate holes between the ends', () => {
    const p = bar({ length: 30, width: 5, thickness: 1.4, bore: 2, intermediate: 2 });
    expect(p.anchors.map((a) => a.name)).toEqual(['a', 'hole1', 'hole2', 'b']);
  });

  it('spans close to its full length along x', () => {
    const p = bar({ length: 30, width: 5, thickness: 1.4, bore: 2 });
    expect(boundsOf(p.mesh).max[0] - boundsOf(p.mesh).min[0]).toBeCloseTo(30, 0);
  });
});

describe('disc', () => {
  it('is well-formed as a circle, a polygon, and with a bore', () => {
    expectWellFormed(disc({ radius: 9, thickness: 1.2 }).mesh);
    expectWellFormed(disc({ radius: 9, thickness: 1.2, sides: 6 }).mesh);
    expectWellFormed(disc({ radius: 9, thickness: 1.2, bore: 2 }).mesh);
  });

  it('face and back anchors sit on opposite sides, bored to the same diameter', () => {
    const p = disc({ radius: 9, thickness: 1.2, bore: 2 });
    const face = findAnchor(p, 'face');
    const back = findAnchor(p, 'back');
    expect(face.position[2]).toBeCloseTo(0.6);
    expect(back.position[2]).toBeCloseTo(-0.6);
    expect(face.axis).toEqual([0, 0, 1]);
    expect(back.axis).toEqual([0, 0, -1]);
    expect(face.bore).toBe(2);
  });

  it('a bore actually removes cap material from the centre', () => {
    const p = disc({ radius: 9, thickness: 1.2, bore: 4 });
    for (let i = 0; i < p.mesh.positions.length / 3; i++) {
      if (p.mesh.cap?.[i] !== 1) continue;
      const r = Math.hypot(p.mesh.positions[i * 3], p.mesh.positions[i * 3 + 1]);
      expect(r).toBeGreaterThanOrEqual(2 - 1e-6);
    }
  });

  it('bolts add one named anchor per bolt, on a circle', () => {
    const p = disc({ radius: 9, thickness: 1.2, bolts: 4 });
    const bolts = p.anchors.filter((a) => a.name.startsWith('bolt'));
    expect(bolts).toHaveLength(4);
    for (const b of bolts) expect(Math.hypot(b.position[0], b.position[1])).toBeCloseTo(9 * 0.72, 1);
  });

  it('sides makes a regular polygon instead of a circle', () => {
    const hexPart = disc({ radius: 9, thickness: 1.2, sides: 6 });
    expect(hexPart.name).toBe('polygon');
    const circlePart = disc({ radius: 9, thickness: 1.2 });
    expect(circlePart.name).toBe('disc');
  });
});

describe('gusset', () => {
  it('is well-formed, with and without a lightening hole', () => {
    expectWellFormed(gusset({ radius: 9, thickness: 1.4, bore: 2.4 }).mesh);
    expectWellFormed(gusset({ radius: 9, thickness: 1.4, bore: 2.4, lighten: 4 }).mesh);
  });

  it('has three anchors a, b, c, each bored and 120 degrees apart', () => {
    const p = gusset({ radius: 9, thickness: 1.4, bore: 2.4 });
    expect(p.anchors.map((a) => a.name)).toEqual(['a', 'b', 'c']);
    for (const a of p.anchors) expect(a.bore).toBe(2.4);
    const angleOf = (a: (typeof p.anchors)[number]) => Math.atan2(a.position[1], a.position[0]);
    const da = ((angleOf(p.anchors[1]) - angleOf(p.anchors[0]) + Math.PI * 4) % (Math.PI * 2));
    expect(da).toBeCloseTo((Math.PI * 2) / 3, 1);
  });

  it('a larger fillet shrinks the ring the anchor holes sit on', () => {
    const tight = gusset({ radius: 9, thickness: 1.4, bore: 2.4, fillet: 1 });
    const loose = gusset({ radius: 9, thickness: 1.4, bore: 2.4, fillet: 4 });
    const rOf = (p: typeof tight) => Math.hypot(p.anchors[0].position[0], p.anchors[0].position[1]);
    expect(rOf(loose)).toBeLessThan(rOf(tight));
  });
});

describe('plate', () => {
  it('is well-formed cut to a deco outline, with a bore and a piercing', () => {
    expectWellFormed(plate({ outline: fanOutline(12, { blades: 5 }), thickness: 1 }).mesh);
    expectWellFormed(plate({ outline: sunburstOutline(12, 10), thickness: 1, bore: 2 }).mesh);
    expectWellFormed(plate({
      outline: zigguratOutline(20, 12, 4), thickness: 1,
      holes: [circleOutline(2).map(([x, y]) => [x, y + 6])],
    }).mesh);
  });

  it('fixes the winding of whatever outline it is handed', () => {
    const cw = [...fanOutline(10)].reverse();
    expectWellFormed(plate({ outline: cw, thickness: 1 }).mesh);
  });

  it('puts face and back anchors at the outline centroid, not the origin', () => {
    const p = plate({ outline: fanOutline(10), thickness: 2 });
    const face = findAnchor(p, 'face');
    const back = findAnchor(p, 'back');
    expect(face.position[0]).toBeGreaterThan(3);
    expect(face.position[1]).toBeCloseTo(0, 5);
    expect(face.position[2]).toBeCloseTo(1);
    expect(back.position[2]).toBeCloseTo(-1);
    expect(back.axis[2]).toBe(-1);
  });

  it('marks the top face for enamel when asked', () => {
    const p = plate({ outline: chevronOutline(20, 8, 3), thickness: 1, enamel: 'ruby' });
    expect(p.enamel).toBe('ruby');
    expect(p.mesh.enamel).toBeDefined();
    expect(Array.from(p.mesh.enamel!).some((v) => v > 0.5)).toBe(true);
  });
});

describe('stepped plate', () => {
  it('stacks tiers shrinking about the centroid, centred on z like a flat plate', () => {
    const p = plate({ outline: fanOutline(12), thickness: 1, tiers: 3, shrink: 0.25 });
    expectWellFormed(p.mesh);
    const b = boundsOf(p.mesh);
    expect(b.max[2]).toBeCloseTo(1.5);
    expect(b.min[2]).toBeCloseTo(-1.5);
    expect(findAnchor(p, 'face').position[2]).toBeCloseTo(1.5);
    expect(findAnchor(p, 'back').position[2]).toBeCloseTo(-1.5);
  });
});
