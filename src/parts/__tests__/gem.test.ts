import { describe, expect, it } from 'vitest';
import { gem, type GemCut } from '../gem';
import { findAnchor } from '../types';
import { expectWellFormed } from '../../mesh/__tests__/helpers';

const CUTS: GemCut[] = [
  'brilliant', 'oval', 'pear', 'marquise', 'trillion', 'step', 'baguette', 'rose', 'cabochon',
];

describe('gem: every cut is a well-formed mesh', () => {
  for (const cut of CUTS) {
    it(cut, () => {
      expectWellFormed(gem({ cut, width: 8 }).mesh);
    });
  }
});

describe('gem: anchors', () => {
  it('seats at the origin, facing up — a stone drops onto its mount there', () => {
    const p = gem({ width: 8 });
    const seat = findAnchor(p, 'seat');
    expect(seat.position).toEqual([0, 0, 0]);
    expect(seat.axis).toEqual([0, 0, 1]);
  });

  it('table sits above the seat, culet below it', () => {
    const p = gem({ width: 8 });
    const table = findAnchor(p, 'table');
    const culet = findAnchor(p, 'culet');
    expect(table.position[2]).toBeGreaterThan(0);
    expect(culet.position[2]).toBeLessThan(0);
  });

  it('a cabochon still has all three anchors, with the culet at its base', () => {
    const p = gem({ cut: 'cabochon', width: 8 });
    expect(findAnchor(p, 'culet').position[2]).toBeCloseTo(0);
  });
});

describe('gem: is not solderable, and carries its cut\'s pavilion facet count', () => {
  it('is never solderable — a stone is held, not joined', () => {
    expect(gem({ width: 8 }).solderable).toBe(false);
  });

  it('a brilliant reports 8 pavilion mains, a step cut 4', () => {
    expect(gem({ cut: 'brilliant', width: 8 }).pavilionFacets).toBe(8);
    expect(gem({ cut: 'step', width: 8 }).pavilionFacets).toBe(4);
  });
});

describe('gem: proportions actually change the geometry', () => {
  it('width sets the girdle span', () => {
    const small = gem({ width: 4 });
    const large = gem({ width: 12 });
    const span = (p: typeof small) => p.bounds.max[0] - p.bounds.min[0];
    expect(span(large)).toBeGreaterThan(span(small));
    expect(span(large) / span(small)).toBeCloseTo(3, 0);
  });

  it('length elongates the stone along x, independently of width along y', () => {
    // width sets halfW (the y half-extent), length sets halfL (the x half-extent)
    const round = gem({ cut: 'oval', width: 8 });
    const long = gem({ cut: 'oval', width: 8, length: 16 });
    const spanX = (p: typeof round) => p.bounds.max[0] - p.bounds.min[0];
    const spanY = (p: typeof round) => p.bounds.max[1] - p.bounds.min[1];
    // "round" here still defaults to oval's own 1.4 length:width ratio, so this
    // only needs to grow further, not multiply by some assumed factor
    expect(spanX(long)).toBeGreaterThan(spanX(round));
    expect(spanY(long)).toBeCloseTo(spanY(round), 0);
  });

  it('depth changes the total height of the stone', () => {
    const shallow = gem({ width: 8, depth: 3 });
    const deep = gem({ width: 8, depth: 8 });
    const height = (p: typeof shallow) => p.bounds.max[2] - p.bounds.min[2];
    expect(height(deep)).toBeGreaterThan(height(shallow));
  });
});
