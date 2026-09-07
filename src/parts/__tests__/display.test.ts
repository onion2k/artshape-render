import { describe, expect, it } from 'vitest';
import { bust, earringStand, easel, ringStand } from '../display';
import { findAnchor } from '../types';
import { expectWatertight, expectWellFormed, boundsOf } from '../../mesh/__tests__/helpers';

describe('ringStand', () => {
  it('is a well-formed, watertight solid', () => {
    const p = ringStand({ baseRadius: 10 });
    expectWellFormed(p.mesh);
    expectWatertight(p.mesh);
  });

  it('a larger baseRadius widens the foot', () => {
    const small = ringStand({ baseRadius: 6 });
    const large = ringStand({ baseRadius: 14 });
    const footSpan = (p: typeof small) => boundsOf(p.mesh).max[0] - boundsOf(p.mesh).min[0];
    expect(footSpan(large)).toBeGreaterThan(footSpan(small));
  });

  it('a taller postHeight makes a taller stand', () => {
    const short = ringStand({ baseRadius: 10, postHeight: 6 });
    const tall = ringStand({ baseRadius: 10, postHeight: 20 });
    const height = (p: typeof short) => boundsOf(p.mesh).max[2];
    expect(height(tall)).toBeGreaterThan(height(short));
  });

  it('the post is narrower than the base — a ring can slide down onto it', () => {
    const p = ringStand({ baseRadius: 10, postRadius: 3 });
    // near the base of the post, only the post's own radius shows; nothing
    // as wide as the foot reaches this high
    const midHeight = boundsOf(p.mesh).max[2] * 0.4;
    let maxR = 0;
    for (let i = 0; i < p.mesh.positions.length; i += 3) {
      if (Math.abs(p.mesh.positions[i + 2] - midHeight) < 0.5) {
        maxR = Math.max(maxR, Math.hypot(p.mesh.positions[i], p.mesh.positions[i + 1]));
      }
    }
    expect(maxR).toBeLessThan(10 * 0.6);
  });

  it('base and peg anchors sit at the bottom and the top', () => {
    const p = ringStand({ baseRadius: 10 });
    const base = findAnchor(p, 'base');
    const peg = findAnchor(p, 'peg');
    expect(base.position).toEqual([0, 0, 0]);
    expect(peg.position[2]).toBeGreaterThan(0);
    expect(peg.position[2]).toBeCloseTo(boundsOf(p.mesh).max[2], 1);
  });
});

describe('earringStand', () => {
  it('is a well-formed, watertight solid', () => {
    const p = earringStand({ baseRadius: 9 });
    expectWellFormed(p.mesh);
    expectWatertight(p.mesh);
  });

  it('a longer barLength spreads the bar wider than the foot', () => {
    const short = earringStand({ baseRadius: 9, barLength: 10 });
    const long = earringStand({ baseRadius: 9, barLength: 30 });
    const span = (p: typeof short) => boundsOf(p.mesh).max[0] - boundsOf(p.mesh).min[0];
    expect(span(long)).toBeGreaterThan(span(short));
    // wider than the foot specifically, once it's long enough to overhang it
    expect(span(long)).toBeGreaterThan(9 * 2);
  });

  it('a taller postHeight lifts the bar higher', () => {
    const short = earringStand({ baseRadius: 9, postHeight: 6 });
    const tall = earringStand({ baseRadius: 9, postHeight: 30 });
    expect(boundsOf(tall.mesh).max[2]).toBeGreaterThan(boundsOf(short.mesh).max[2]);
  });

  it('left and right anchors sit at the two ends of the bar, at its height', () => {
    const p = earringStand({ baseRadius: 9, barLength: 20 });
    const left = findAnchor(p, 'left');
    const right = findAnchor(p, 'right');
    expect(left.position[0]).toBeCloseTo(-10, 1);
    expect(right.position[0]).toBeCloseTo(10, 1);
    expect(left.position[2]).toBeCloseTo(right.position[2], 5);
    // the bar's own radius stands proud of the anchor's centreline height
    expect(boundsOf(p.mesh).max[2]).toBeGreaterThan(left.position[2]);
    expect(boundsOf(p.mesh).max[2] - left.position[2]).toBeLessThan(9 * 0.5);
  });

  it('base anchor sits at the bottom centre', () => {
    const p = earringStand({ baseRadius: 9 });
    expect(findAnchor(p, 'base').position).toEqual([0, 0, 0]);
  });
});

describe('bust', () => {
  it('is a well-formed, watertight solid', () => {
    const p = bust({ height: 40 });
    expectWellFormed(p.mesh);
    expectWatertight(p.mesh);
  });

  it('a taller height makes a taller bust, spanning from 0 to height', () => {
    const short = bust({ height: 30 });
    const tall = bust({ height: 60 });
    expect(boundsOf(tall.mesh).max[2]).toBeGreaterThan(boundsOf(short.mesh).max[2]);
    expect(boundsOf(short.mesh).min[2]).toBeCloseTo(0, 5);
    expect(boundsOf(short.mesh).max[2]).toBeCloseTo(30, 1);
  });

  it('the shoulders are wider than both the base and the neck', () => {
    const p = bust({ height: 40 });
    const b = boundsOf(p.mesh);
    const shoulderSpan = b.max[0] - b.min[0];
    // the base and the neck cap are both narrower cross-sections than the
    // widest point (the shoulders) by construction — check the base directly
    let baseR = 0;
    for (let i = 0; i < p.mesh.positions.length; i += 3) {
      if (Math.abs(p.mesh.positions[i + 2]) < 0.5) {
        baseR = Math.max(baseR, Math.hypot(p.mesh.positions[i], p.mesh.positions[i + 1]));
      }
    }
    expect(shoulderSpan / 2).toBeGreaterThan(baseR);
  });

  it('the neck cylinder holds a near-constant radius up to the cut top', () => {
    const p = bust({ height: 40, neckRadius: 7 });
    const top = boundsOf(p.mesh).max[2];
    const radiusNear = (z: number) => {
      let max = 0;
      for (let i = 0; i < p.mesh.positions.length; i += 3) {
        if (Math.abs(p.mesh.positions[i + 2] - z) < 0.3) {
          max = Math.max(max, Math.hypot(p.mesh.positions[i], p.mesh.positions[i + 1]));
        }
      }
      return max;
    };
    // sampled a little below the very top cap, where the neck is already a
    // plain cylinder rather than still narrowing from the shoulders
    expect(radiusNear(top * 0.85)).toBeCloseTo(7, 0);
  });

  it('the neck anchor stands proud of the neck surface, outward, not embedded in it', () => {
    const p = bust({ height: 40, neckRadius: 7 });
    const neck = findAnchor(p, 'neck');
    expect(neck.position[0]).toBeCloseTo(7, 1);
    // "same" alignment carries a fastened part's own bulk opposite its own
    // seat axis and onto the target's axis — outward here means the target
    // axis must point away from the bust's own centreline, not into it
    expect(neck.axis[0]).toBeLessThan(0);
  });

  it('base anchor sits at the bottom centre', () => {
    const p = bust({ height: 40 });
    expect(findAnchor(p, 'base').position).toEqual([0, 0, 0]);
  });
});

describe('easel', () => {
  it('is a well-formed, watertight solid', () => {
    const p = easel({ width: 24, height: 30 });
    expectWellFormed(p.mesh);
    expectWatertight(p.mesh);
  });

  it('spans the given width and height in its own outline plane (local X/Y)', () => {
    const p = easel({ width: 24, height: 30 });
    const b = boundsOf(p.mesh);
    expect(b.max[0] - b.min[0]).toBeCloseTo(24, 0);
    // the leg reaches below y=0 and the peg above y=height, so the card's
    // own bottom/top are the tight bound only on X, not Y
    expect(b.min[1]).toBeLessThanOrEqual(0);
    expect(b.max[1]).toBeGreaterThanOrEqual(30);
  });

  it('a longer legDepth reaches further behind the card', () => {
    const short = easel({ width: 24, height: 30, legDepth: 5 });
    const long = easel({ width: 24, height: 30, legDepth: 20 });
    const back = (p: typeof short) => boundsOf(p.mesh).min[2];
    expect(back(long)).toBeLessThan(back(short));
  });

  it('a bigger peg reaches further off the front face', () => {
    const small = easel({ width: 24, height: 30, pegRadius: 0.5, pegLength: 1 });
    const large = easel({ width: 24, height: 30, pegRadius: 3, pegLength: 6 });
    const front = (p: typeof small) => boundsOf(p.mesh).max[2];
    expect(front(large)).toBeGreaterThan(front(small));
  });

  it('the hook anchor sits at the peg tip, and base at the card foot', () => {
    const p = easel({ width: 24, height: 30 });
    const hook = findAnchor(p, 'hook');
    const base = findAnchor(p, 'base');
    expect(base.position).toEqual([0, 0, 0]);
    expect(hook.position[2]).toBeCloseTo(boundsOf(p.mesh).max[2], 1);
    expect(hook.position[1]).toBeCloseTo(30 * 0.86, 5);
  });
});
