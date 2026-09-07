import { describe, expect, it } from 'vitest';
import { shank } from '../ring';
import { findAnchor } from '../types';
import { expectWatertight, expectWellFormed, boundsOf } from '../../mesh/__tests__/helpers';

describe('shank: base contract', () => {
  it('is a well-formed, watertight closed band', () => {
    const p = shank({ size: 17, width: 2.4, thickness: 1.7 });
    expectWellFormed(p.mesh);
    expectWatertight(p.mesh);
  });

  it('has a crown anchor pointing radially outward, at the outer radius', () => {
    const p = shank({ size: 17, width: 2.4, thickness: 1.7 });
    const crown = findAnchor(p, 'crown');
    const radius = 17 / 2 + 1.7 / 2;
    expect(crown.position).toEqual([radius, 0, 0]);
    expect(crown.axis).toEqual([1, 0, 0]);
  });

  it('the inner bore matches the given size, not the outer radius', () => {
    const p = shank({ size: 17, width: 2.4, thickness: 1.7 });
    let minR = Infinity;
    for (let i = 0; i < p.mesh.positions.length; i += 3) {
      minR = Math.min(minR, Math.hypot(p.mesh.positions[i], p.mesh.positions[i + 1]));
    }
    expect(minR).toBeCloseTo(17 / 2, 1);
  });

  it('a larger size widens the band without changing its width or thickness', () => {
    const small = shank({ size: 15, width: 2.4, thickness: 1.7 });
    const large = shank({ size: 20, width: 2.4, thickness: 1.7 });
    const outerRadius = (p: typeof small) => {
      let max = 0;
      for (let i = 0; i < p.mesh.positions.length; i += 3) {
        max = Math.max(max, Math.hypot(p.mesh.positions[i], p.mesh.positions[i + 1]));
      }
      return max;
    };
    expect(outerRadius(large)).toBeGreaterThan(outerRadius(small));
    // width (finger-axis extent) is unaffected by size
    const b1 = boundsOf(small.mesh), b2 = boundsOf(large.mesh);
    expect(b2.max[2] - b2.min[2]).toBeCloseTo(b1.max[2] - b1.min[2], 1);
  });
});

describe('shank: shoulder', () => {
  it('a plain band (shoulder: 0) has a uniform cross-section all the way round', () => {
    const p = shank({ size: 17, width: 2.4, thickness: 1.7, shoulder: 0 });
    // every ring's cross-section has several vertices at the *same* angle
    // (the profile's own points), so the outer radius at that angle is the
    // max among them, not whichever vertex a nearest-angle search happens
    // to land on first
    const outerRadiusAt = (frac: number) => {
      const target = frac * Math.PI * 2;
      let best = 0;
      for (let i = 0; i < p.mesh.positions.length; i += 3) {
        const [x, y] = [p.mesh.positions[i], p.mesh.positions[i + 1]];
        const a = ((Math.atan2(y, x) + Math.PI * 2) % (Math.PI * 2));
        const d = Math.min(Math.abs(a - target), Math.PI * 2 - Math.abs(a - target));
        if (d < 0.02) best = Math.max(best, Math.hypot(x, y));
      }
      return best;
    };
    expect(outerRadiusAt(0)).toBeCloseTo(outerRadiusAt(0.5), 1);
  });

  it('a shoulder swells the band at the crown (angle 0) relative to the back (angle 0.5 turn)', () => {
    const p = shank({ size: 17, width: 2.4, thickness: 1.7, shoulder: 0.6, shoulderSpread: 0.4 });
    const heightAt = (frac: number) => {
      const target = frac * Math.PI * 2;
      const z: number[] = [];
      for (let i = 0; i < p.mesh.positions.length; i += 3) {
        const [x, y] = [p.mesh.positions[i], p.mesh.positions[i + 1]];
        const a = ((Math.atan2(y, x) + Math.PI * 2) % (Math.PI * 2));
        const d = Math.min(Math.abs(a - target), Math.PI * 2 - Math.abs(a - target));
        if (d < 0.03) z.push(p.mesh.positions[i + 2]);
      }
      return Math.max(...z) - Math.min(...z);
    };
    expect(heightAt(0)).toBeGreaterThan(heightAt(0.5));
  });

  it('the shoulder bump wraps across the seam rather than only affecting one side of it', () => {
    // the crown sits exactly at angle 0, the point where the sweep's own
    // taper table wraps from t=1 back to t=0 — a bug here would show as an
    // asymmetric swell, wide approaching the seam from one side and flat
    // from the other
    const p = shank({ size: 17, width: 2.4, thickness: 1.7, shoulder: 0.6, shoulderSpread: 0.3 });
    const heightNear = (angle: number) => {
      const z: number[] = [];
      for (let i = 0; i < p.mesh.positions.length; i += 3) {
        const [x, y] = [p.mesh.positions[i], p.mesh.positions[i + 1]];
        const a = ((Math.atan2(y, x) + Math.PI * 2) % (Math.PI * 2));
        const d = Math.min(Math.abs(a - angle), Math.PI * 2 - Math.abs(a - angle));
        if (d < 0.05) z.push(p.mesh.positions[i + 2]);
      }
      return z.length ? Math.max(...z) - Math.min(...z) : 0;
    };
    const justBefore = heightNear(0.05); // approaching the seam from the "1-turn" side
    const justAfter = heightNear(Math.PI * 2 - 0.05); // approaching from the "just under a turn" side
    expect(Math.abs(justBefore - justAfter)).toBeLessThan(0.05);
  });
});

describe('shank: gap (tension setting)', () => {
  it('leaves a gap of no material centred on the crown', () => {
    const p = shank({ size: 17, width: 2.4, thickness: 1.7, gap: 0.6 });
    for (let i = 0; i < p.mesh.positions.length; i += 3) {
      const [x, y] = [p.mesh.positions[i], p.mesh.positions[i + 1]];
      const a = Math.abs(Math.atan2(y, x));
      // no vertex should fall inside the gap's own half-angle
      expect(a).toBeGreaterThanOrEqual(0.6 / 2 - 0.02);
    }
  });

  it('a wider gap opens a wider empty wedge, not the same one', () => {
    // segments (and so vertex count) is fixed by the spec either way; what
    // changes with gap is how much of the angular range those segments cover
    const nearestMaterialAngle = (p: ReturnType<typeof shank>) => {
      let best = Math.PI;
      for (let i = 0; i < p.mesh.positions.length; i += 3) {
        const [x, y] = [p.mesh.positions[i], p.mesh.positions[i + 1]];
        best = Math.min(best, Math.abs(Math.atan2(y, x)));
      }
      return best;
    };
    const narrow = shank({ size: 17, width: 2.4, thickness: 1.7, gap: 0.3 });
    const wide = shank({ size: 17, width: 2.4, thickness: 1.7, gap: 1.2 });
    expect(nearestMaterialAngle(wide)).toBeGreaterThan(nearestMaterialAngle(narrow));
  });

  it('caps the two cut ends rather than leaving them open', () => {
    const p = shank({ size: 17, width: 2.4, thickness: 1.7, gap: 0.6 });
    expectWatertight(p.mesh);
  });

  it('gap: 0 is identical in shape to no gap at all', () => {
    const withZero = shank({ size: 17, width: 2.4, thickness: 1.7, gap: 0 });
    const without = shank({ size: 17, width: 2.4, thickness: 1.7 });
    expect(withZero.mesh.positions).toEqual(without.mesh.positions);
  });

  it('the crown anchor still sits at the outer radius, in the middle of the gap', () => {
    const p = shank({ size: 17, width: 2.4, thickness: 1.7, gap: 0.6 });
    const crown = findAnchor(p, 'crown');
    const radius = 17 / 2 + 1.7 / 2;
    expect(crown.position).toEqual([radius, 0, 0]);
  });

  it('a shoulder swell now peaks at the two cut jaws either side of the gap', () => {
    const p = shank({ size: 17, width: 2.4, thickness: 1.7, gap: 0.5, shoulder: 0.6, shoulderSpread: 0.3 });
    const heightAt = (targetAngle: number) => {
      const z: number[] = [];
      for (let i = 0; i < p.mesh.positions.length; i += 3) {
        const [x, y] = [p.mesh.positions[i], p.mesh.positions[i + 1]];
        const a = Math.atan2(y, x);
        if (Math.abs(a - targetAngle) < 0.03) z.push(p.mesh.positions[i + 2]);
      }
      return z.length ? Math.max(...z) - Math.min(...z) : 0;
    };
    const nearJaw = heightAt(0.3); // just past the gap's own edge
    const atBack = heightAt(Math.PI); // directly opposite the gap
    expect(nearJaw).toBeGreaterThan(atBack);
  });
});
