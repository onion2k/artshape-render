import { describe, expect, it } from 'vitest';
import { findAnchor, meshBounds } from '../types';
import { MeshBuilder } from '../../mesh/types';
import type { Part } from '../types';

describe('meshBounds', () => {
  it('finds the min and max of a simple mesh', () => {
    const mb = new MeshBuilder();
    mb.vertex(-1, -2, -3, 0, 0, 1, 0, 0);
    mb.vertex(4, 5, 6, 0, 0, 1, 0, 0);
    mb.vertex(0, 0, 0, 0, 0, 1, 0, 0);
    const b = meshBounds(mb.build());
    expect(b.min).toEqual([-1, -2, -3]);
    expect(b.max).toEqual([4, 5, 6]);
  });

  it('collapses to a point for a single vertex', () => {
    const mb = new MeshBuilder();
    mb.vertex(2, 3, 4, 0, 0, 1, 0, 0);
    const b = meshBounds(mb.build());
    expect(b.min).toEqual([2, 3, 4]);
    expect(b.max).toEqual([2, 3, 4]);
  });
});

describe('findAnchor', () => {
  const part: Part = {
    name: 'thing',
    mesh: new MeshBuilder().build(),
    bounds: { min: [0, 0, 0], max: [0, 0, 0] },
    anchors: [{ name: 'base', position: [0, 0, 0], axis: [0, 0, 1], tangent: [1, 0, 0] }],
  };

  it('finds an anchor by name', () => {
    expect(findAnchor(part, 'base').position).toEqual([0, 0, 0]);
  });

  it('throws, naming both the part and the anchor, when it is missing', () => {
    expect(() => findAnchor(part, 'nope')).toThrow(/"thing" has no anchor "nope"/);
  });
});
