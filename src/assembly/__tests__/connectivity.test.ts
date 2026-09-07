import { describe, expect, it } from 'vitest';
import { analyseConnectivity, type PlacedMeshes } from '../connectivity';
import { identity, translation } from '../../geom/transform';
import { MeshBuilder } from '../../mesh/types';

/** A closed cube of the given side length, centred at the origin. */
function cube(side: number) {
  const h = side / 2;
  const mb = new MeshBuilder();
  const pts: [number, number, number][] = [
    [-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h],
    [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h],
  ];
  for (const [x, y, z] of pts) mb.vertex(x, y, z, 0, 0, 1, 0, 0);
  const faces = [
    [0, 1, 2], [0, 2, 3], // bottom
    [4, 6, 5], [4, 7, 6], // top
    [0, 4, 5], [0, 5, 1], // -y
    [3, 2, 6], [3, 6, 7], // +y
    [0, 3, 7], [0, 7, 4], // -x
    [1, 5, 6], [1, 6, 2], // +x
  ];
  for (const [a, b, c] of faces) mb.triangle(a, b, c);
  return mb.build();
}

function placed(mesh: ReturnType<typeof cube>, matrix = identity()): PlacedMeshes['placements'][number] {
  return { part: { mesh }, matrix };
}

describe('analyseConnectivity: trivial inputs', () => {
  it('an empty assembly has no bodies', () => {
    const r = analyseConnectivity({ placements: [] });
    expect(r.bodies).toBe(0);
    expect(r.floating).toBe(0);
    expect(r.bodyOf).toHaveLength(0);
  });

  it('a single placement is its own body of size 1 — and counts as "floating", by this report\'s own definition', () => {
    // floating means "the only placement in its body", which is trivially
    // true for a lone part with nothing else in the assembly to touch
    const r = analyseConnectivity({ placements: [placed(cube(2))] });
    expect(r.bodies).toBe(1);
    expect(r.floating).toBe(1);
    expect(r.largest).toBe(1);
  });

  it('reports a non-negative timing', () => {
    const r = analyseConnectivity({ placements: [placed(cube(2))] });
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });
});

describe('analyseConnectivity: intersection', () => {
  it('two overlapping cubes are one body', () => {
    const mesh = cube(2);
    const r = analyseConnectivity({
      placements: [placed(mesh), placed(mesh, translation([1, 0, 0]))], // half-overlap
    });
    expect(r.bodies).toBe(1);
    expect(r.floating).toBe(0);
  });

  it('two cubes far apart are two separate, floating bodies', () => {
    const mesh = cube(2);
    const r = analyseConnectivity({
      placements: [placed(mesh), placed(mesh, translation([100, 0, 0]))],
    });
    expect(r.bodies).toBe(2);
    expect(r.floating).toBe(2);
    expect(r.largest).toBe(1);
  });

  it('three cubes in a chain (A touches B, B touches C, A and C do not) are one body', () => {
    const mesh = cube(2);
    const r = analyseConnectivity({
      placements: [
        placed(mesh, translation([0, 0, 0])),
        placed(mesh, translation([1.9, 0, 0])),
        placed(mesh, translation([3.8, 0, 0])),
      ],
    });
    expect(r.bodies).toBe(1);
  });
});

describe('analyseConnectivity: tolerance', () => {
  it('two cubes within tolerance of each other (not touching) still merge', () => {
    const mesh = cube(2);
    // cubes span [-1,1]; a gap of 2.05 leaves a 0.05mm gap, comfortably
    // inside the default 0.1mm tolerance
    const r = analyseConnectivity({
      placements: [placed(mesh), placed(mesh, translation([2.05, 0, 0]))],
    });
    expect(r.bodies).toBe(1);
  });

  it('two cubes well outside tolerance do not merge', () => {
    const mesh = cube(2);
    const r = analyseConnectivity({
      placements: [placed(mesh), placed(mesh, translation([3, 0, 0]))],
    }, { tolerance: 0.1 });
    expect(r.bodies).toBe(2);
  });

  it('a larger explicit tolerance merges a gap the default would not', () => {
    const mesh = cube(2);
    const gapped = { placements: [placed(mesh), placed(mesh, translation([3, 0, 0]))] };
    expect(analyseConnectivity(gapped, { tolerance: 0.1 }).bodies).toBe(2);
    expect(analyseConnectivity(gapped, { tolerance: 1.5 }).bodies).toBe(1);
  });
});

describe('analyseConnectivity: containment', () => {
  it('a small cube fully inside a larger one, with no surface crossing, is one body', () => {
    const outer = cube(10);
    const inner = cube(2); // comfortably inside [-5, 5]
    const r = analyseConnectivity({ placements: [placed(outer), placed(inner)] });
    expect(r.bodies).toBe(1);
    expect(r.floating).toBe(0);
  });
});

describe('analyseConnectivity: bodyOf and floatingPlacements', () => {
  it('bodyOf has one entry per placement, and groups touching placements under the same id', () => {
    const mesh = cube(2);
    const r = analyseConnectivity({
      placements: [
        placed(mesh, translation([0, 0, 0])),
        placed(mesh, translation([1.9, 0, 0])), // touches placement 0
        placed(mesh, translation([100, 0, 0])), // isolated
      ],
    });
    expect(r.bodyOf).toHaveLength(3);
    expect(r.bodyOf[0]).toBe(r.bodyOf[1]);
    expect(r.bodyOf[2]).not.toBe(r.bodyOf[0]);
  });

  it('floatingPlacements lists exactly the indices in a body of size 1', () => {
    const mesh = cube(2);
    const r = analyseConnectivity({
      placements: [
        placed(mesh, translation([0, 0, 0])),
        placed(mesh, translation([1.9, 0, 0])),
        placed(mesh, translation([100, 0, 0])),
      ],
    });
    expect(r.floatingPlacements).toEqual([2]);
  });
});

describe('analyseConnectivity: stride', () => {
  it('a coarser stride still finds an obvious, large overlap', () => {
    const mesh = cube(2);
    const r = analyseConnectivity(
      { placements: [placed(mesh), placed(mesh, translation([0.5, 0, 0]))] },
      { stride: 4 },
    );
    expect(r.bodies).toBe(1);
  });
});
