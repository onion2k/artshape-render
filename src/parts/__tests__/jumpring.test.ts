import { describe, expect, it } from 'vitest';
import { jumpRing } from '../jumpring';
import { findAnchor } from '../types';
import { expectWatertight, expectWellFormed, boundsOf } from '../../mesh/__tests__/helpers';

describe('jumpRing: closed (soldered)', () => {
  it('is a well-formed, watertight closed loop', () => {
    const p = jumpRing({ radius: 3, wireRadius: 0.5 });
    expectWellFormed(p.mesh);
    expectWatertight(p.mesh);
  });

  it('a larger radius widens the loop without changing the wire gauge', () => {
    const small = jumpRing({ radius: 2, wireRadius: 0.5 });
    const large = jumpRing({ radius: 6, wireRadius: 0.5 });
    const span = (p: typeof small) => {
      const b = boundsOf(p.mesh);
      return b.max[0] - b.min[0];
    };
    expect(span(large)).toBeGreaterThan(span(small));
  });

  it('a larger wireRadius thickens the loop', () => {
    const thin = jumpRing({ radius: 3, wireRadius: 0.3 });
    const thick = jumpRing({ radius: 3, wireRadius: 0.9 });
    let maxR = (p: typeof thin) => {
      let max = 0;
      for (let i = 0; i < p.mesh.positions.length; i += 3) {
        max = Math.max(max, Math.hypot(p.mesh.positions[i], p.mesh.positions[i + 1]));
      }
      return max;
    };
    expect(maxR(thick)).toBeGreaterThan(maxR(thin));
  });

  it('the gate anchor sits at the outer radius', () => {
    const p = jumpRing({ radius: 3, wireRadius: 0.5 });
    const gate = findAnchor(p, 'gate');
    expect(gate.position).toEqual([3, 0, 0]);
    expect(gate.axis).toEqual([1, 0, 0]);
  });
});

describe('jumpRing: gap (open, unsoldered)', () => {
  it('leaves a gap of no material centred on the gate', () => {
    const p = jumpRing({ radius: 3, wireRadius: 0.5, gap: 0.6 });
    for (let i = 0; i < p.mesh.positions.length; i += 3) {
      const [x, y] = [p.mesh.positions[i], p.mesh.positions[i + 1]];
      const a = Math.abs(Math.atan2(y, x));
      expect(a).toBeGreaterThanOrEqual(0.6 / 2 - 0.02);
    }
  });

  it('caps the two cut ends rather than leaving them open', () => {
    const p = jumpRing({ radius: 3, wireRadius: 0.5, gap: 0.6 });
    expectWatertight(p.mesh);
  });

  it('gap: 0 is identical in shape to no gap at all', () => {
    const withZero = jumpRing({ radius: 3, wireRadius: 0.5, gap: 0 });
    const without = jumpRing({ radius: 3, wireRadius: 0.5 });
    expect(withZero.mesh.positions).toEqual(without.mesh.positions);
  });

  it('the gate anchor still sits at the outer radius, in the middle of the gap', () => {
    const p = jumpRing({ radius: 3, wireRadius: 0.5, gap: 0.6 });
    const gate = findAnchor(p, 'gate');
    expect(gate.position).toEqual([3, 0, 0]);
  });
});
