import { describe, expect, it } from 'vitest';
import { bead, bell, bud, collar, egg, pod, rivet } from '../fastener';
import { findAnchor } from '../types';
import { expectWellFormed, boundsOf } from '../../mesh/__tests__/helpers';

describe('rivet', () => {
  it('is a well-formed mesh', () => {
    expectWellFormed(rivet({ headDiameter: 3.5, headHeight: 1.2, shankDiameter: 2, grip: 1 }).mesh);
  });

  it('seats at the origin, tails at -grip', () => {
    const p = rivet({ headDiameter: 3.5, headHeight: 1.2, shankDiameter: 2, grip: 1.5 });
    expect(findAnchor(p, 'seat').position).toEqual([0, 0, 0]);
    expect(findAnchor(p, 'tail').position).toEqual([0, 0, -1.5]);
  });

  it('the head rises to headHeight above the seat', () => {
    const p = rivet({ headDiameter: 3.5, headHeight: 1.2, shankDiameter: 2, grip: 1 });
    expect(boundsOf(p.mesh).max[2]).toBeCloseTo(1.2, 1);
  });

  it('a tailSpread bucks the tail out past the shank radius', () => {
    const flush = rivet({ headDiameter: 3.5, headHeight: 1.2, shankDiameter: 2, grip: 1, tailSpread: 0 });
    const bucked = rivet({ headDiameter: 3.5, headHeight: 1.2, shankDiameter: 2, grip: 1, tailSpread: 1.5 });
    const spanAt = (mesh: typeof flush.mesh, z: number) => {
      let r = 0;
      for (let i = 0; i < mesh.positions.length; i += 3) {
        if (Math.abs(mesh.positions[i + 2] - z) < 0.05) r = Math.max(r, Math.hypot(mesh.positions[i], mesh.positions[i + 1]));
      }
      return r;
    };
    expect(spanAt(bucked.mesh, -1)).toBeGreaterThan(spanAt(flush.mesh, -1));
  });
});

describe('bead', () => {
  it('is well-formed, solid and bored', () => {
    expectWellFormed(bead({ radius: 3 }).mesh);
    expectWellFormed(bead({ radius: 3, bore: 1 }).mesh);
  });

  it('seats at the bottom pole', () => {
    const p = bead({ radius: 4 });
    expect(findAnchor(p, 'seat').position).toEqual([0, 0, -4]);
  });

  it('a longer point extends the top past a plain ovoid', () => {
    const plain = bead({ radius: 4, point: 0 });
    const pointed = bead({ radius: 4, point: 6 });
    expect(boundsOf(pointed.mesh).max[2]).toBeGreaterThan(boundsOf(plain.mesh).max[2]);
  });

  it('carries enamel onto the whole body when asked', () => {
    const p = bead({ radius: 4, enamel: 'ruby' });
    expect(p.enamel).toBe('ruby');
    expect([...p.mesh.enamel!].every((v) => v === 1)).toBe(true);
  });
});

describe('egg', () => {
  it('is well-formed', () => {
    expectWellFormed(egg({ radius: 11, taper: 0.34 }).mesh);
  });

  it('bases and apexes at ±height', () => {
    const p = egg({ radius: 10, height: 14 });
    expect(findAnchor(p, 'base').position).toEqual([0, 0, -14]);
    expect(findAnchor(p, 'apex').position).toEqual([0, 0, 14]);
  });

  it('taper narrows the top relative to the bottom', () => {
    const p = egg({ radius: 10, height: 15, taper: 0.5 });
    let topMax = 0, bottomMax = 0;
    for (let i = 0; i < p.mesh.positions.length; i += 3) {
      const z = p.mesh.positions[i + 2];
      const r = Math.hypot(p.mesh.positions[i], p.mesh.positions[i + 1]);
      if (z > 0) topMax = Math.max(topMax, r); else bottomMax = Math.max(bottomMax, r);
    }
    expect(topMax).toBeLessThan(bottomMax);
  });

  it('carries enamel onto the whole body', () => {
    const p = egg({ radius: 10, enamel: 'cobalt' });
    expect([...p.mesh.enamel!].every((v) => v === 1)).toBe(true);
  });
});

describe('collar', () => {
  it('is well-formed and watertight — a closed ferrule', () => {
    expectWellFormed(collar({ innerRadius: 1.6, wall: 0.7, length: 4.5 }).mesh);
  });

  it('anchors a and b sit at ±length/2, bored to the inner diameter', () => {
    const p = collar({ innerRadius: 2, wall: 1, length: 6 });
    expect(findAnchor(p, 'a').position).toEqual([0, 0, -3]);
    expect(findAnchor(p, 'b').position).toEqual([0, 0, 3]);
    expect(findAnchor(p, 'a').bore).toBe(4);
  });

  it('the bore is at least innerRadius, whatever the belly does to the outside', () => {
    const p = collar({ innerRadius: 2, wall: 1, length: 6, belly: 1.5 });
    for (let i = 0; i < p.mesh.positions.length; i += 3) {
      const r = Math.hypot(p.mesh.positions[i], p.mesh.positions[i + 1]);
      expect(r).toBeGreaterThanOrEqual(2 - 1e-6);
    }
  });
});

describe('pod', () => {
  it('is well-formed, with and without whorls or ribs', () => {
    expectWellFormed(pod({ length: 16, width: 8 }).mesh);
    expectWellFormed(pod({ length: 16, width: 8, whorls: 5 }).mesh);
    expectWellFormed(pod({ length: 16, width: 8, ribs: 8 }).mesh);
  });

  it('bases and tips at ±length/2', () => {
    const p = pod({ length: 20, width: 8 });
    expect(findAnchor(p, 'base').position).toEqual([0, 0, -10]);
    expect(findAnchor(p, 'tip').position).toEqual([0, 0, 10]);
  });

  it('comes to a point at both ends: radius ~0 at the poles', () => {
    const p = pod({ length: 20, width: 8 });
    let maxRAtPoles = 0;
    for (let i = 0; i < p.mesh.positions.length; i += 3) {
      if (Math.abs(Math.abs(p.mesh.positions[i + 2]) - 10) < 0.05) {
        maxRAtPoles = Math.max(maxRAtPoles, Math.hypot(p.mesh.positions[i], p.mesh.positions[i + 1]));
      }
    }
    expect(maxRAtPoles).toBeLessThan(0.5);
  });
});

describe('bell', () => {
  it('is well-formed and watertight — a thin shell, open at both ends but closed as a wall', () => {
    expectWellFormed(bell({ length: 12, mouth: 16, throat: 6 }).mesh);
    expectWellFormed(bell({ length: 12, mouth: 16, throat: 6, lobes: 5 }).mesh);
  });

  it('throat sits at the origin, mouth at length, bored to their own diameters', () => {
    const p = bell({ length: 12, mouth: 16, throat: 6 });
    expect(findAnchor(p, 'throat').position).toEqual([0, 0, 0]);
    expect(findAnchor(p, 'mouth').position).toEqual([0, 0, 12]);
    expect(findAnchor(p, 'throat').bore).toBe(6);
    expect(findAnchor(p, 'mouth').bore).toBe(16);
  });

  it('the mouth end is wider than the throat end for a normal flare', () => {
    const p = bell({ length: 12, mouth: 16, throat: 6 });
    let mouthR = 0, throatR = Infinity;
    for (let i = 0; i < p.mesh.positions.length; i += 3) {
      const z = p.mesh.positions[i + 2], r = Math.hypot(p.mesh.positions[i], p.mesh.positions[i + 1]);
      if (z > 11) mouthR = Math.max(mouthR, r);
      if (z < 1) throatR = Math.min(throatR, r);
    }
    expect(mouthR).toBeGreaterThan(throatR);
  });

  it('enamels the inside, leaving the rim annuli metal', () => {
    const p = bell({ length: 12, mouth: 16, throat: 6, enamel: 'cobalt' });
    expect([...p.mesh.enamel!]).toContain(1);
    expect([...p.mesh.enamel!]).toContain(0);
  });
});

describe('bud', () => {
  it('is well-formed', () => {
    expectWellFormed(bud({ length: 14, width: 8 }).mesh);
  });

  it('bases at the origin, tips at length', () => {
    const p = bud({ length: 14, width: 8 });
    expect(findAnchor(p, 'base').position).toEqual([0, 0, 0]);
    expect(findAnchor(p, 'tip').position).toEqual([0, 0, 14]);
  });

  it('draws to a point at the tip', () => {
    const p = bud({ length: 14, width: 8 });
    let tipR = 0;
    for (let i = 0; i < p.mesh.positions.length; i += 3) {
      if (p.mesh.positions[i + 2] > 13.9) {
        tipR = Math.max(tipR, Math.hypot(p.mesh.positions[i], p.mesh.positions[i + 1]));
      }
    }
    expect(tipR).toBeLessThan(0.5);
  });
});
