import { describe, expect, it } from 'vitest';
import { axe } from '../axe';
import { findAnchor } from '../types';
import { expectWatertight, expectWellFormed, boundsOf } from '../../mesh/__tests__/helpers';

describe('axe: base contract', () => {
  it('is a well-formed, watertight solid', () => {
    const p = axe({ haftLength: 100 });
    expectWellFormed(p.mesh);
    expectWatertight(p.mesh);
  });

  it('stands from z=0 (the butt) to at least the haft length', () => {
    const p = axe({ haftLength: 100 });
    const b = boundsOf(p.mesh);
    expect(b.min[2]).toBeCloseTo(0, 5);
    expect(b.max[2]).toBeGreaterThanOrEqual(100 - 1);
  });

  it('a longer haftLength makes a taller axe', () => {
    const short = axe({ haftLength: 60 });
    const long = axe({ haftLength: 160 });
    expect(boundsOf(long.mesh).max[2]).toBeGreaterThan(boundsOf(short.mesh).max[2]);
  });

  it('butt and edge anchors sit at the bottom and the head tip', () => {
    const p = axe({ haftLength: 100, headReach: 26 });
    const butt = findAnchor(p, 'butt');
    const edge = findAnchor(p, 'edge');
    expect(butt.position).toEqual([0, 0, 0]);
    expect(edge.position[0]).toBeCloseTo(26, 0);
  });
});

describe('axe: head', () => {
  it('the head reaches out to one side, well past the haft radius', () => {
    const p = axe({ haftLength: 100, haftRadius: 1.8, headReach: 26 });
    const b = boundsOf(p.mesh);
    expect(b.max[0]).toBeGreaterThan(20);
  });

  it('a single-bit axe only reaches out on the +X side', () => {
    const p = axe({ haftLength: 100, headReach: 26 });
    const b = boundsOf(p.mesh);
    // the -X side never goes past the haft's own radius (~1.8 here)
    expect(-b.min[0]).toBeLessThan(5);
    expect(b.max[0]).toBeGreaterThan(20);
  });

  it('doubleBit mirrors a second head on the -X side', () => {
    const p = axe({ haftLength: 100, headReach: 26, doubleBit: true });
    const b = boundsOf(p.mesh);
    expect(-b.min[0]).toBeGreaterThan(20);
    expect(b.max[0]).toBeGreaterThan(20);
  });

  it('a taller headHeight makes a taller head', () => {
    const short = axe({ haftLength: 100, headHeight: 10 });
    const tall = axe({ haftLength: 100, headHeight: 40 });
    const spanAt = (p: typeof short) => {
      const b = boundsOf(p.mesh);
      return b.max[2] - b.min[2];
    };
    expect(spanAt(tall)).toBeGreaterThan(spanAt(short));
  });

  it('is well-formed and watertight with a double bit too', () => {
    const p = axe({ haftLength: 100, doubleBit: true });
    expectWellFormed(p.mesh);
    expectWatertight(p.mesh);
  });

  it('is well-formed and watertight at hatchet-like proportions', () => {
    const p = axe({ haftLength: 30, headReach: 10, headHeight: 12 });
    expectWellFormed(p.mesh);
    expectWatertight(p.mesh);
  });
});

describe('axe: hand piece and ornament anchors', () => {
  it('wrapTurns: 0 (the default) leaves the haft bare, with no enamel mask', () => {
    const p = axe({ haftLength: 100 });
    expect(p.mesh.enamel).toBeUndefined();
  });

  it('a wrap adds vertices and stays well-formed and watertight', () => {
    const bare = axe({ haftLength: 100 });
    const bound = axe({ haftLength: 100, wrapTurns: 12 });
    expect(bound.mesh.positions.length).toBeGreaterThan(bare.mesh.positions.length);
    expectWellFormed(bound.mesh);
    expectWatertight(bound.mesh);
  });

  it('the wrap covers only its own stretch of the haft', () => {
    const p = axe({ haftLength: 100, haftRadius: 2, wrapTurns: 12, wrapFrom: 0.1, wrapLength: 0.3 });
    // anything wider than the haft below the head must be the binding
    const proudAt = (z: number) => {
      let max = 0;
      for (let i = 0; i < p.mesh.positions.length; i += 3) {
        if (Math.abs(p.mesh.positions[i + 2] - z) < 1) {
          max = Math.max(max, Math.hypot(p.mesh.positions[i], p.mesh.positions[i + 1]));
        }
      }
      return max;
    };
    expect(proudAt(25)).toBeGreaterThan(2.1);
    expect(proudAt(70)).toBeLessThan(2.1);
  });

  it('an enamel colour marks only the binding, not the haft or head', () => {
    const p = axe({ haftLength: 100, wrapTurns: 12, enamel: 'umber' });
    expect(p.enamel).toBe('umber');
    const marked = Array.from(p.mesh.enamel!).filter((v) => v > 0).length;
    expect(marked).toBeGreaterThan(0);
    expect(marked).toBeLessThan(p.mesh.enamel!.length);
  });

  it('cheek anchors face out along +Y and -Y from the head, top faces up, poll faces back', () => {
    const p = axe({ haftLength: 100 });
    expect(findAnchor(p, 'cheek').axis).toEqual([0, 1, 0]);
    expect(findAnchor(p, 'cheekBack').axis).toEqual([0, -1, 0]);
    expect(findAnchor(p, 'top').position).toEqual([0, 0, 100]);
    expect(findAnchor(p, 'poll').axis).toEqual([-1, 0, 0]);
    expect(findAnchor(p, 'cheek').position[0]).toBeGreaterThan(0);
  });
});

describe('axe: haft: false', () => {
  it('leaves out the haft but keeps the head hung at haftLength, with its socket', () => {
    const full = axe({ haftLength: 100 });
    const headOnly = axe({ haftLength: 100, haft: false });
    expect(headOnly.mesh.positions.length).toBeLessThan(full.mesh.positions.length);
    // nothing reaches the butt any more; the head is still where it was
    expect(boundsOf(headOnly.mesh).min[2]).toBeGreaterThan(50);
    expect(findAnchor(headOnly, 'top').position).toEqual([0, 0, 100]);
    expectWellFormed(headOnly.mesh);
    expectWatertight(headOnly.mesh);
  });
});
