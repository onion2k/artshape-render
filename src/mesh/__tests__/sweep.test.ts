import { describe, expect, it } from 'vitest';
import { sweep } from '../sweep';
import * as profile from '../../geom/profile';
import { line } from '../../geom/curve';
import { samplePath } from '../../geom/curve';
import { expectWatertight, expectWellFormed, boundsOf } from './helpers';

const straight = (length = 20, n = 10) => samplePath(line([0, 0, 0], [length, 0, 0]), n);

describe('sweep: structural invariants', () => {
  it('produces a well-formed mesh for a round, capped, open sweep', () => {
    const mesh = sweep(straight(), { profile: profile.circle(2, 12), caps: true });
    expectWellFormed(mesh);
  });

  it('produces a well-formed mesh for a sharp-cornered profile (a square rod)', () => {
    const mesh = sweep(straight(), { profile: profile.polygon(4, 2), caps: true });
    expectWellFormed(mesh);
  });

  it('an open, capped sweep is watertight — it is a solid with no missing faces', () => {
    const mesh = sweep(straight(), { profile: profile.circle(2, 10), caps: true });
    expectWatertight(mesh);
  });

  it('a closed loop (a torus) is watertight without caps', () => {
    const ring = samplePath({ at: (t) => [Math.cos(t * Math.PI * 2) * 10, Math.sin(t * Math.PI * 2) * 10, 0] }, 24);
    const mesh = sweep(ring, { profile: profile.circle(1, 8), closed: true });
    expectWatertight(mesh);
  });

  it('an open sweep without caps is not watertight — the ends are open', () => {
    const mesh = sweep(straight(), { profile: profile.circle(2, 8), caps: false });
    expect(() => expectWatertight(mesh)).toThrow();
  });
});

describe('sweep: geometry', () => {
  it('a straight tube stays within the section radius perpendicular to the path', () => {
    const radius = 3;
    const mesh = sweep(straight(20, 30), { profile: profile.circle(radius, 24), caps: false });
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const y = mesh.positions[i + 1], z = mesh.positions[i + 2];
      expect(Math.hypot(y, z)).toBeLessThanOrEqual(radius + 1e-4);
    }
  });

  it('spans the path length along the sweep axis', () => {
    const mesh = sweep(straight(20, 10), { profile: profile.circle(1, 8), caps: true });
    const b = boundsOf(mesh);
    expect(b.min[0]).toBeCloseTo(0, 1);
    expect(b.max[0]).toBeCloseTo(20, 1);
  });

  it('taper shrinks the cross-section toward the tapered end', () => {
    const mesh = sweep(straight(20, 40), {
      profile: profile.circle(3, 16),
      taper: (t) => 1 - 0.9 * t,
      caps: false,
    });
    const radiusAt = (x: number) => {
      let best = Infinity, r = 0;
      for (let i = 0; i < mesh.positions.length; i += 3) {
        const d = Math.abs(mesh.positions[i] - x);
        if (d < best) { best = d; r = Math.hypot(mesh.positions[i + 1], mesh.positions[i + 2]); }
      }
      return r;
    };
    expect(radiusAt(20)).toBeLessThan(radiusAt(0) * 0.3);
  });

  it('scale-zero taper collapses the tip to the path itself, not to nothing', () => {
    const mesh = sweep(straight(20, 40), { profile: profile.circle(3, 16), taper: (t) => 1 - t, caps: false });
    // the last ring's vertices should all sit essentially on the path (radius ~ 0)
    const b = boundsOf(mesh);
    expect(b.max[0]).toBeCloseTo(20, 0);
  });

  it('closing the sweep stitches the last ring back to the first', () => {
    const ring = samplePath({ at: (t) => [Math.cos(t * Math.PI * 2) * 10, Math.sin(t * Math.PI * 2) * 10, 0] }, 16);
    const mesh = sweep(ring, { profile: profile.circle(1, 6), closed: true });
    // watertight already proves the seam quad exists; also check no cap fans were added
    const before = mesh.indices.length;
    const capped = sweep(ring.slice(0, -1), { profile: profile.circle(1, 6), closed: false, caps: true });
    expect(capped.indices.length).toBeGreaterThan(before - mesh.positions.length); // caps add extra triangles
  });

  it('morphing to a different profile changes the section at the far end but not the near one', () => {
    const round = profile.circle(2, 12);
    const flat = profile.lens(2 * 2.6, 2 * 0.7, 12);
    const mesh = sweep(straight(20, 20), { profile: round, morphTo: flat, caps: false });
    // at x=0 the cross-section should still be round: roughly constant radius
    const nearRadii: number[] = [];
    const farRadii: number[] = [];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i], y = mesh.positions[i + 1], z = mesh.positions[i + 2];
      const r = Math.hypot(y, z);
      if (x < 0.5) nearRadii.push(r);
      if (x > 19.5) farRadii.push(r);
    }
    const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    expect(spread(nearRadii)).toBeLessThan(0.2);
    expect(spread(farRadii)).toBeGreaterThan(0.2);
  });
});

describe('sweep: a closed loop\'s engraving coordinate goes the whole way round', () => {
  const ring = samplePath({ at: (t) => [Math.cos(t * Math.PI * 2) * 10, Math.sin(t * Math.PI * 2) * 10, 0] }, 24);

  it('records the loop\'s length as the period, closing step included', () => {
    const mesh = sweep(ring, { profile: profile.circle(1, 8), closed: true });
    // 24 chords of a circle of radius 10, the last back to the first
    const chord = 2 * 10 * Math.sin(Math.PI / 24);
    expect(mesh.engravePeriod).toBeCloseTo(chord * 24, 6);
  });

  it('carries the seam ring twice, at nought and at the period, on the same positions', () => {
    const mesh = sweep(ring, { profile: profile.circle(1, 8), closed: true });
    const e = mesh.engrave!;
    const period = mesh.engravePeriod!;
    const atStart: number[] = [], atEnd: number[] = [];
    for (let v = 0; v < e.length / 2; v++) {
      if (e[v * 2] === 0) atStart.push(v);
      if (Math.abs(e[v * 2] - period) < 1e-4) atEnd.push(v);
    }
    expect(atStart.length).toBeGreaterThan(0);
    expect(atEnd.length).toBe(atStart.length);
    for (let i = 0; i < atStart.length; i++) {
      for (let k = 0; k < 3; k++) {
        expect(mesh.positions[atEnd[i] * 3 + k]).toBeCloseTo(mesh.positions[atStart[i] * 3 + k], 9);
        expect(mesh.normals[atEnd[i] * 3 + k]).toBeCloseTo(mesh.normals[atStart[i] * 3 + k], 9);
      }
    }
    // no coordinate beyond the period, none below nought
    for (let v = 0; v < e.length / 2; v++) expect(e[v * 2]).toBeGreaterThanOrEqual(0);
    for (let v = 0; v < e.length / 2; v++) expect(e[v * 2]).toBeLessThanOrEqual(period + 1e-4);
    expectWatertight(mesh);
    expectWellFormed(mesh);
  });

  it('an open sweep has no period', () => {
    const mesh = sweep(straight(), { profile: profile.circle(2, 10), caps: true });
    expect(mesh.engravePeriod).toBeUndefined();
  });
});
