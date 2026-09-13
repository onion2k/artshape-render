import { describe, expect, it } from 'vitest';
import { gem, GEM_CUTS } from '../gem';
import { findAnchor } from '../types';
import { expectWellFormed } from '../../mesh/__tests__/helpers';

const CUTS = GEM_CUTS;

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

describe('gem: the round brilliant is the trade\'s layout', () => {
  /** The facets read back from the fans the builder emits: each begins where a triangle's first index changes. */
  const facetsOf = (mesh: { indices: Uint32Array }) => {
    let n = 0, base = -1, last = -1;
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const a = mesh.indices[i], b = mesh.indices[i + 1];
      if (!(a === base && b === last)) { n++; base = a; }
      last = mesh.indices[i + 2];
    }
    return n;
  };

  it('has 57 facets, 16 girdle facets beside them, and one more with a culet', () => {
    const plain = gem({ cut: 'brilliant', width: 6.5 });
    expect(facetsOf(plain.mesh)).toBe(73);
    expect(plain.gemPlanes!.length / 4).toBe(73);
    const cut = gem({ cut: 'brilliant', width: 6.5, culet: 0.04 });
    expect(facetsOf(cut.mesh)).toBe(74);
  });

  it('comes out at Tolkowsky\'s proportions: 56 % table, 15 % crown, 43 % pavilion', () => {
    const p = gem({ cut: 'brilliant', width: 10 });
    const table = findAnchor(p, 'table').position[2];
    const culet = findAnchor(p, 'culet').position[2];
    // crown over the girdle's top edge: (1 - 0.56) * tan 34.5° of the radius, plus half the girdle
    expect(table).toBeCloseTo(0.15 + 0.44 * Math.tan((34.5 * Math.PI) / 180) * 5, 2);
    expect(culet).toBeCloseTo(-(0.15 + Math.tan((40.75 * Math.PI) / 180) * 5), 2);
    expect(p.bounds.max[0] - p.bounds.min[0]).toBeCloseTo(10, 6);
  });

  it('the angles asked for are the angles cut', () => {
    const steep = gem({ cut: 'brilliant', width: 10, crownAngle: 40, pavilionAngle: 42 });
    expect(findAnchor(steep, 'table').position[2]).toBeCloseTo(0.15 + 0.44 * Math.tan((40 * Math.PI) / 180) * 5, 2);
    expect(findAnchor(steep, 'culet').position[2]).toBeCloseTo(-(0.15 + Math.tan((42 * Math.PI) / 180) * 5), 2);
  });

  it('a depth squashes both angles rather than the girdle', () => {
    const p = gem({ cut: 'brilliant', width: 10, depth: 4 });
    // to a hundredth: the squash is taken against the proportions row, which is rounded
    expect(p.bounds.max[2] - p.bounds.min[2]).toBeCloseTo(4, 2);
  });

  it('the oval is the round stretched, so its facets stay planes and its count is the same', () => {
    const p = gem({ cut: 'oval', width: 6, length: 9 });
    expect(facetsOf(p.mesh)).toBe(73);
    expect(p.gemPlanes!.length / 4).toBe(73);
    expect(p.bounds.max[0] - p.bounds.min[0]).toBeCloseTo(9, 6);
    expect(p.bounds.max[1] - p.bounds.min[1]).toBeCloseTo(6, 6);
    // every corner of a facet lies on the facet's plane, to a micron
    const pos = p.mesh.positions, nor = p.mesh.normals, idx = p.mesh.indices;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i], b = idx[i + 1], c = idx[i + 2];
      for (const v of [b, c]) {
        const d = (pos[v * 3] - pos[a * 3]) * nor[a * 3] + (pos[v * 3 + 1] - pos[a * 3 + 1]) * nor[a * 3 + 1] + (pos[v * 3 + 2] - pos[a * 3 + 2]) * nor[a * 3 + 2];
        expect(Math.abs(d)).toBeLessThan(1e-3);
      }
    }
  });

  it('fewer facets round the girdle make fewer mains, and the count follows', () => {
    const six = gem({ cut: 'brilliant', width: 6, facets: 12 });
    expect(six.pavilionFacets).toBe(6);
    expect(facetsOf(six.mesh)).toBe(9 * 6 + 1);
  });
});

describe('gem: the catalogue', () => {
  const facetsOf = (mesh: { indices: Uint32Array }) => {
    let n = 0, base = -1, last = -1;
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const a = mesh.indices[i], b = mesh.indices[i + 1];
      if (!(a === base && b === last)) { n++; base = a; }
      last = mesh.indices[i + 2];
    }
    return n;
  };
  const height = (p: ReturnType<typeof gem>) => p.bounds.max[2] - p.bounds.min[2];

  it('a princess is square, pointed, and its crown is one bevel over chevrons', () => {
    const p = gem({ cut: 'princess', width: 6 });
    expect(p.bounds.max[0] - p.bounds.min[0]).toBeCloseTo(6, 6);
    expect(facetsOf(p.mesh)).toBe(41);
    expect(p.pavilionFacets).toBe(4);
    expect(findAnchor(p, 'culet').position[2]).toBeCloseTo(p.bounds.min[2], 6);
  });

  it('an asscher has three steps each side and an emerald cut two over three', () => {
    expect(facetsOf(gem({ cut: 'asscher', width: 6 }).mesh)).toBe(58);
    expect(facetsOf(gem({ cut: 'step', width: 6 }).mesh)).toBe(50);
  });

  it('the old cuts have a culet you can see, the modern brilliant none', () => {
    const old = gem({ cut: 'oldEuropean', width: 6.5 });
    const culetRing = old.mesh.positions.filter((_, i) => i % 3 === 2 && Math.abs(old.mesh.positions[i] - old.bounds.min[2]) < 1e-6).length;
    expect(culetRing).toBeGreaterThan(8);
    expect(facetsOf(old.mesh)).toBe(146);
    expect(facetsOf(gem({ cut: 'eight', width: 2 }).mesh)).toBe(25);
  });

  it('a briolette is a drop: as tall as its length, round about its axis, with no table', () => {
    const b = gem({ cut: 'briolette', width: 5, length: 9 });
    expect(height(b)).toBeCloseTo(9, 6);
    expect(b.bounds.max[0] - b.bounds.min[0]).toBeCloseTo(5, 6);
    expect(b.bounds.max[1] - b.bounds.min[1]).toBeCloseTo(5, 6);
    // every facet leans: nothing is flat on top or underneath
    for (let i = 2; i < b.mesh.normals.length; i += 3) expect(Math.abs(b.mesh.normals[i])).toBeLessThan(0.999);
  });

  it('the shapes come out at their own ratios, and the half-moon wider than long', () => {
    const ratio = (cut: Parameters<typeof gem>[0]['cut']) => { const p = gem({ cut, width: 6 }); return (p.bounds.max[0] - p.bounds.min[0]) / (p.bounds.max[1] - p.bounds.min[1]); };
    expect(ratio('kite')).toBeCloseTo(1.6, 6);
    expect(ratio('halfMoon')).toBeCloseTo(0.55, 6);
    expect(ratio('hexagon')).toBeCloseTo(1.15, 6);
    expect(ratio('tapered')).toBeCloseTo(2.0, 6);
  });

  it('a double cabochon is a lens with a girdle at its equator and no facets', () => {
    const d = gem({ cut: 'doubleCabochon', width: 8 });
    expect(d.gemPlanes).toBeUndefined();
    expect(findAnchor(d, 'table').position[2]).toBeCloseTo(-findAnchor(d, 'culet').position[2], 6);
    expect(height(d)).toBeCloseTo(4.8, 6);
  });
});
