import { describe, expect, it } from 'vitest';
import { leverBack } from '../leverback';
import { findAnchor } from '../types';
import { expectWatertight, expectWellFormed, boundsOf } from '../../mesh/__tests__/helpers';

describe('leverBack: base contract', () => {
  it('is a well-formed, watertight loop-and-lever', () => {
    const p = leverBack({ radius: 5 });
    expectWellFormed(p.mesh);
    expectWatertight(p.mesh);
  });

  it('a larger radius widens the loop', () => {
    const small = leverBack({ radius: 3 });
    const large = leverBack({ radius: 8 });
    const span = (p: typeof small) => {
      const b = boundsOf(p.mesh);
      return b.max[0] - b.min[0];
    };
    expect(span(large)).toBeGreaterThan(span(small));
  });

  it('the seat anchor sits at the outer radius, in the middle of the gap', () => {
    const p = leverBack({ radius: 5 });
    const seat = findAnchor(p, 'seat');
    expect(seat.position).toEqual([5, 0, 0]);
    expect(seat.axis).toEqual([1, 0, 0]);
  });
});

describe('leverBack: gap and lever', () => {
  // The lever always bridges the gap — that is the whole point of the part —
  // so unlike shank's or jumpRing's gap, there is no angle near the seat left
  // genuinely free of material to probe for. What's worth pinning down
  // instead is that the gap parameter actually reaches the geometry (changes
  // it) and stays well-formed across its range, including the values it
  // clamps at.

  it('a different gap produces different geometry', () => {
    const narrow = leverBack({ radius: 5, gap: 0.4 });
    const wide = leverBack({ radius: 5, gap: 1.2 });
    expect(narrow.mesh.positions).not.toEqual(wide.mesh.positions);
  });

  it('stays well-formed and watertight from a bare sliver to almost a full turn', () => {
    for (const gap of [0, 0.01, 3, Math.PI * 2 - 0.2]) {
      const p = leverBack({ radius: 5, gap });
      expectWellFormed(p.mesh);
      expectWatertight(p.mesh);
    }
  });

  it('a negative gap clamps to the same minimum as gap: 0', () => {
    const zero = leverBack({ radius: 5, gap: 0 });
    const negative = leverBack({ radius: 5, gap: -3 });
    expect(negative.mesh.positions).toEqual(zero.mesh.positions);
  });

  it('a wider leverWidth makes a bigger paddle', () => {
    const narrow = leverBack({ radius: 5, leverWidth: 0.6 });
    const wide = leverBack({ radius: 5, leverWidth: 2.5 });
    // farthest any vertex strays from the loop's own plane-radius, near the
    // gap: the lever is the only geometry that can push this out
    const maxProudRadius = (p: typeof narrow) => {
      let max = 0;
      for (let i = 0; i < p.mesh.positions.length; i += 3) {
        const [x, y] = [p.mesh.positions[i], p.mesh.positions[i + 1]];
        max = Math.max(max, Math.hypot(x, y));
      }
      return max;
    };
    expect(maxProudRadius(wide)).toBeGreaterThan(maxProudRadius(narrow));
  });
});
