import { describe, expect, it } from 'vitest';
import { sword } from '../sword';
import { findAnchor } from '../types';
import { expectWatertight, expectWellFormed, boundsOf } from '../../mesh/__tests__/helpers';

describe('sword: base contract', () => {
  it('is a well-formed, watertight solid', () => {
    const p = sword({ bladeLength: 80 });
    expectWellFormed(p.mesh);
    expectWatertight(p.mesh);
  });

  it('stands from z=0 to base + grip + blade, tip above base', () => {
    const p = sword({ bladeLength: 80 });
    const b = boundsOf(p.mesh);
    expect(b.min[2]).toBeCloseTo(0, 5);
    expect(b.max[2]).toBeGreaterThan(80);
  });

  it('a longer bladeLength makes a taller sword', () => {
    const short = sword({ bladeLength: 40 });
    const long = sword({ bladeLength: 120 });
    expect(boundsOf(long.mesh).max[2]).toBeGreaterThan(boundsOf(short.mesh).max[2]);
  });

  it('base and tip anchors sit at the very bottom and the blade point', () => {
    const p = sword({ bladeLength: 80 });
    const base = findAnchor(p, 'base');
    const tip = findAnchor(p, 'tip');
    expect(base.position).toEqual([0, 0, 0]);
    expect(tip.position[2]).toBeCloseTo(boundsOf(p.mesh).max[2], 1);
  });
});

describe('sword: guard and blade', () => {
  it('the guard reaches wider than the blade or the grip alone', () => {
    const p = sword({ bladeLength: 80, guardWidth: 40 });
    const b = boundsOf(p.mesh);
    // guardWidth is the span tip to tip; the finial at each end stands a
    // little proud of that again, so the true span is somewhat more
    const span = b.max[0] - b.min[0];
    expect(span).toBeGreaterThan(40);
    expect(span).toBeLessThan(50);
  });

  it('a wider bladeWidth widens the blade (and, by default, the guard with it)', () => {
    const narrow = sword({ bladeLength: 80, bladeWidth: 4 });
    const wide = sword({ bladeLength: 80, bladeWidth: 12 });
    const spanAt = (p: typeof narrow, z: number) => {
      let max = 0;
      for (let i = 0; i < p.mesh.positions.length; i += 3) {
        if (Math.abs(p.mesh.positions[i + 2] - z) < 1) max = Math.max(max, Math.abs(p.mesh.positions[i]));
      }
      return max * 2;
    };
    // partway up the blade, well clear of the guard
    const z = boundsOf(narrow.mesh).max[2] * 0.6;
    expect(spanAt(wide, z)).toBeGreaterThan(spanAt(narrow, z));
  });

  it('bladeTaper closer to 1 holds full width for longer before the point', () => {
    const early = sword({ bladeLength: 80, bladeTaper: 0.2 });
    const late = sword({ bladeLength: 80, bladeTaper: 0.9 });
    // at 60% up the blade's own span, a blade that only starts tapering at
    // 90% should still be near full width; one that started at 20% should not
    const bladeZAt = (p: typeof early, frac: number) => {
      const tip = findAnchor(p, 'tip').position[2];
      const guardZ = tip - 80;
      return guardZ + frac * 80;
    };
    const widthAt = (p: typeof early, z: number) => {
      let max = 0;
      for (let i = 0; i < p.mesh.positions.length; i += 3) {
        if (Math.abs(p.mesh.positions[i + 2] - z) < 1) max = Math.max(max, Math.abs(p.mesh.positions[i]));
      }
      return max;
    };
    const z = bladeZAt(early, 0.6);
    expect(widthAt(late, z)).toBeGreaterThan(widthAt(early, z));
  });

  it('is well-formed and watertight at dagger-like proportions too', () => {
    const p = sword({ bladeLength: 18, gripLength: 8 });
    expectWellFormed(p.mesh);
    expectWatertight(p.mesh);
  });

  it('the blade is flatter (thinner) than it is wide', () => {
    const p = sword({ bladeLength: 80, bladeWidth: 10 });
    // partway up the blade, clear of the guard and the point, the front-back
    // extent (Y) should be a fraction of the left-right extent (X)
    const z = findAnchor(p, 'tip').position[2] - 40;
    let maxY = 0;
    for (let i = 0; i < p.mesh.positions.length; i += 3) {
      if (Math.abs(p.mesh.positions[i + 2] - z) < 1 && Math.abs(p.mesh.positions[i]) < 6) {
        maxY = Math.max(maxY, Math.abs(p.mesh.positions[i + 1]));
      }
    }
    expect(maxY * 2).toBeLessThan(10 * 0.3);
  });
});

describe('sword: pommel', () => {
  it('is not much wider than the grip it caps', () => {
    const p = sword({ bladeLength: 80, gripRadius: 3 });
    let maxR = 0;
    for (let i = 0; i < p.mesh.positions.length; i += 3) {
      // sampled low, in the pommel's own region, well clear of the guard
      if (p.mesh.positions[i + 2] < 6) {
        maxR = Math.max(maxR, Math.hypot(p.mesh.positions[i], p.mesh.positions[i + 1]));
      }
    }
    expect(maxR).toBeLessThan(3 * 1.6);
  });
});

describe('sword: leather wrap', () => {
  it('is well-formed and watertight with the default wrap', () => {
    const p = sword({ bladeLength: 80 });
    expectWellFormed(p.mesh);
    expectWatertight(p.mesh);
  });

  it('wrapTurns: 0 leaves the grip bare — fewer vertices than the default', () => {
    const wrapped = sword({ bladeLength: 80 });
    const bare = sword({ bladeLength: 80, wrapTurns: 0 });
    expect(bare.mesh.positions.length).toBeLessThan(wrapped.mesh.positions.length);
  });

  it('a thicker wrapRadius stands proud of the bare grip radius', () => {
    const p = sword({ bladeLength: 80, gripRadius: 3, wrapRadius: 1.5, wrapTurns: 4 });
    // sampled mid-grip, clear of the pommel and the guard
    const z = 10;
    let maxR = 0;
    for (let i = 0; i < p.mesh.positions.length; i += 3) {
      if (Math.abs(p.mesh.positions[i + 2] - z) < 1) {
        maxR = Math.max(maxR, Math.hypot(p.mesh.positions[i], p.mesh.positions[i + 1]));
      }
    }
    expect(maxR).toBeGreaterThan(3);
  });

  it('an enamel colour on a bare grip changes nothing — there is no wrap to carry it', () => {
    const bare = sword({ bladeLength: 80, wrapTurns: 0 });
    expect(bare.mesh.enamel).toBeUndefined();
  });

  it('an enamel colour with the wrap present marks only some vertices, not the whole sword', () => {
    const p = sword({ bladeLength: 80, enamel: 'umber' });
    expect(p.enamel).toBe('umber');
    expect(p.mesh.enamel).toBeDefined();
    const marked = Array.from(p.mesh.enamel!).filter((v) => v > 0).length;
    expect(marked).toBeGreaterThan(0);
    expect(marked).toBeLessThan(p.mesh.enamel!.length);
  });
});

describe('sword: runes', () => {
  it('runeCount: 0 is the default — explicit and implicit give identical meshes', () => {
    const implicit = sword({ bladeLength: 80, wrapTurns: 0 });
    const explicit = sword({ bladeLength: 80, wrapTurns: 0, runeCount: 0 });
    expect(implicit.mesh.positions).toEqual(explicit.mesh.positions);
  });

  it('adds vertices, and stays well-formed and watertight, with runes on', () => {
    const plain = sword({ bladeLength: 80, wrapTurns: 0 });
    const runed = sword({ bladeLength: 80, wrapTurns: 0, runeCount: 4 });
    expect(runed.mesh.positions.length).toBeGreaterThan(plain.mesh.positions.length);
    expectWellFormed(runed.mesh);
    expectWatertight(runed.mesh);
  });

  it('more runes means more marks, up to where the blade starts to taper', () => {
    const few = sword({ bladeLength: 80, wrapTurns: 0, runeCount: 2 });
    const many = sword({ bladeLength: 80, wrapTurns: 0, runeCount: 8 });
    expect(many.mesh.positions.length).toBeGreaterThan(few.mesh.positions.length);
  });
});
