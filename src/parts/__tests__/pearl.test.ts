import { describe, expect, it } from 'vitest';
import { pearl } from '../pearl';
import { findAnchor } from '../types';
import { expectWellFormed, boundsOf } from '../../mesh/__tests__/helpers';

describe('pearl', () => {
  it('is a well-formed mesh', () => {
    expectWellFormed(pearl({ radius: 5 }).mesh);
  });

  it('is never solderable — cemented onto its peg, not joined', () => {
    expect(pearl({ radius: 5 }).solderable).toBe(false);
  });

  it('seats at the bottom pole, crowns at the top, radius apart with no oblation', () => {
    const p = pearl({ radius: 5 });
    expect(findAnchor(p, 'seat').position).toEqual([0, 0, -5]);
    expect(findAnchor(p, 'crown').position).toEqual([0, 0, 5]);
  });

  it('spans exactly 2*radius in every axis for a round pearl', () => {
    const p = pearl({ radius: 4 });
    const b = boundsOf(p.mesh);
    for (const k of [0, 1, 2]) expect(b.max[k] - b.min[k]).toBeCloseTo(8, 1);
  });

  it('oblate flattens the pearl along z only', () => {
    const round = pearl({ radius: 5 });
    const oblate = pearl({ radius: 5, oblate: 0.3 });
    const depth = (p: typeof round) => boundsOf(p.mesh).max[2] - boundsOf(p.mesh).min[2];
    const width = (p: typeof round) => boundsOf(p.mesh).max[0] - boundsOf(p.mesh).min[0];
    expect(depth(oblate)).toBeLessThan(depth(round));
    expect(width(oblate)).toBeCloseTo(width(round), 1);
  });

  it('clamps oblate to a sane range rather than inverting the pearl', () => {
    const p = pearl({ radius: 5, oblate: 5 });
    expect(findAnchor(p, 'crown').position[2]).toBeGreaterThan(0);
  });
});
