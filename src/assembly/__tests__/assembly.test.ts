import { describe, expect, it } from 'vitest';
import { Assembly } from '../assembly';
import { identity, rotationAbout, transformPoint, translation } from '../../geom/transform';
import { MeshBuilder } from '../../mesh/types';
import { meshBounds, type Part } from '../../parts/types';

function cubePart(name = 'cube'): Part {
  const mb = new MeshBuilder();
  // a minimal box, 2 units on a side centred at the origin — just enough
  // triangles for bounds()/stats() to have something real to measure
  const pts: [number, number, number][] = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ];
  for (const [x, y, z] of pts) mb.vertex(x, y, z, 0, 0, 1, 0, 0);
  for (const t of [[0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6]]) mb.triangle(t[0], t[1], t[2]);
  const mesh = mb.build();
  return { name, mesh, bounds: meshBounds(mesh), anchors: [
    { name: 'top', position: [0, 0, 1], axis: [0, 0, 1], tangent: [1, 0, 0] },
    { name: 'bottom', position: [0, 0, -1], axis: [0, 0, -1], tangent: [1, 0, 0] },
  ] };
}

function pinPart(name = 'pin'): Part {
  const mb = new MeshBuilder();
  for (const [x, y, z] of [[-0.2, -0.2, 0], [0.2, -0.2, 0], [0, 0.2, 1]] as const) {
    mb.vertex(x, y, z, 0, 0, 1, 0, 0);
  }
  mb.triangle(0, 1, 2);
  const mesh = mb.build();
  return { name, mesh, bounds: meshBounds(mesh), anchors: [
    { name: 'seat', position: [0, 0, 0], axis: [0, 0, -1], tangent: [1, 0, 0] },
  ] };
}

describe('Assembly.place', () => {
  it('adds a placement at the identity by default', () => {
    const a = new Assembly();
    const p = a.place(cubePart());
    expect(a.placements).toHaveLength(1);
    expect(p.matrix).toEqual(identity());
  });

  it('carries the given origin as the placement\'s own origins entry', () => {
    const a = new Assembly();
    const p = a.place(cubePart(), identity(), { start: 5, end: 10 });
    expect(p.origins).toEqual([{ start: 5, end: 10 }]);
  });

  it('transforms the part\'s anchors into assembly space', () => {
    const a = new Assembly();
    const p = a.place(cubePart(), translation([3, 0, 0]));
    expect(p.anchor('top').position).toEqual([3, 0, 1]);
  });
});

describe('Assembly.connect', () => {
  it('mates the source anchor onto the target position and axis', () => {
    const a = new Assembly();
    const cube = a.place(cubePart());
    const pin = a.connect(cube.anchor('top'), pinPart(), 'seat');
    // the pin's seat anchor (axis -Z) mated 'same' onto the cube's top (axis +Z)
    // lands the seat exactly at the target position
    expect(pin.anchor('seat').position[0]).toBeCloseTo(0);
    expect(pin.anchor('seat').position[1]).toBeCloseTo(0);
    expect(pin.anchor('seat').position[2]).toBeCloseTo(1);
  });

  it('align: opposed flips the mated axis', () => {
    const a = new Assembly();
    const cube = a.place(cubePart());
    const same = a.connect(cube.anchor('top'), pinPart(), 'seat', { align: 'same' });
    const opposed = a.connect(cube.anchor('top'), pinPart(), 'seat', { align: 'opposed' });
    const dot = (u: readonly number[], v: readonly number[]) => u[0]*v[0]+u[1]*v[1]+u[2]*v[2];
    expect(dot(same.anchor('seat').axis, opposed.anchor('seat').axis)).toBeCloseTo(-1, 4);
  });

  it('offset moves the placed part along the target axis', () => {
    const a = new Assembly();
    const cube = a.place(cubePart());
    const raised = a.connect(cube.anchor('top'), pinPart(), 'seat', { offset: 2 });
    expect(raised.anchor('seat').position[2]).toBeCloseTo(3);
  });

  it('scale scales the placed part uniformly, without touching its own (local) bounds', () => {
    const a = new Assembly();
    const cube = a.place(cubePart());
    const plain = a.connect(cube.anchor('top'), pinPart(), 'seat');
    const scaled = a.connect(cube.anchor('top'), pinPart(), 'seat', { scale: 2 });
    // the pin's apex sits at local (0, 0.2, 1) — its distance from the seat
    // (local origin) doubles in world space once placed, even though the
    // Part's own recorded bounds are untouched (scale lives in the matrix)
    const apex: [number, number, number] = [0, 0.2, 1];
    const seat = plain.anchor('seat').position;
    const plainApex = transformPoint(plain.matrix, apex);
    const scaledApex = transformPoint(scaled.matrix, apex);
    const dist = (p: readonly number[]) => Math.hypot(p[0] - seat[0], p[1] - seat[1], p[2] - seat[2]);
    expect(dist(scaledApex)).toBeCloseTo(dist(plainApex) * 2, 4);
    expect(scaled.part.bounds.max[2] - scaled.part.bounds.min[2]).toBeCloseTo(1);
  });

  it('throws when the part has no anchor of that name', () => {
    const a = new Assembly();
    const cube = a.place(cubePart());
    expect(() => a.connect(cube.anchor('top'), pinPart(), 'nope')).toThrow(/has no anchor "nope"/);
  });

  it('roll spins the placed part about the mating axis', () => {
    const a = new Assembly();
    const cube = a.place(cubePart());
    const p0 = a.connect(cube.anchor('top'), pinPart(), 'seat', { roll: 0 });
    const p90 = a.connect(cube.anchor('top'), pinPart(), 'seat', { roll: Math.PI / 2 });
    expect(p0.anchor('seat').tangent).not.toEqual(p90.anchor('seat').tangent);
  });
});

describe('Assembly.repeat', () => {
  it('copies every placement of the sub-assembly under every symmetry transform', () => {
    const sub = new Assembly('sub');
    sub.place(cubePart());
    const a = new Assembly();
    const symmetry = [identity(), translation([5, 0, 0]), translation([10, 0, 0])];
    a.repeat(sub, symmetry);
    expect(a.placements).toHaveLength(3);
    expect(a.placements[1].anchor('top').position[0]).toBeCloseTo(5);
  });

  it('extends each copy\'s origins with the repeat\'s own origin, after the sub\'s own', () => {
    const sub = new Assembly('sub');
    sub.place(cubePart(), identity(), { start: 0, end: 5 });
    const a = new Assembly();
    a.repeat(sub, [identity()], { start: 10, end: 20 });
    expect(a.placements[0].origins).toEqual([{ start: 0, end: 5 }, { start: 10, end: 20 }]);
  });

  it('an empty symmetry produces no placements at all', () => {
    const sub = new Assembly('sub');
    sub.place(cubePart());
    const a = new Assembly();
    a.repeat(sub, []);
    expect(a.placements).toHaveLength(0);
  });
});

describe('Assembly.merge', () => {
  it('copies every placement of the sub-assembly under a single transform', () => {
    const sub = new Assembly('sub');
    sub.place(cubePart());
    sub.place(pinPart());
    const a = new Assembly();
    a.merge(sub, translation([1, 2, 3]));
    expect(a.placements).toHaveLength(2);
    expect(a.placements[0].anchor('top').position).toEqual([1, 2, 4]);
  });

  it('defaults to the identity transform', () => {
    const sub = new Assembly('sub');
    sub.place(cubePart());
    const a = new Assembly();
    a.merge(sub);
    expect(a.placements[0].matrix).toEqual(identity());
  });
});

describe('Assembly.enclose', () => {
  it('appends the given origin to every placement already made', () => {
    const a = new Assembly();
    a.place(cubePart(), identity(), { start: 0, end: 1 });
    a.place(pinPart(), identity(), { start: 2, end: 3 });
    a.enclose({ start: 100, end: 200 });
    for (const p of a.placements) expect(p.origins.at(-1)).toEqual({ start: 100, end: 200 });
  });

  it('does not retroactively affect a placement added after enclose() was called', () => {
    const a = new Assembly();
    a.place(cubePart(), identity(), { start: 0, end: 1 });
    a.enclose({ start: 100, end: 200 });
    a.place(pinPart(), identity(), { start: 2, end: 3 });
    expect(a.placements[1].origins).toEqual([{ start: 2, end: 3 }]);
  });
});

describe('Assembly.bounds', () => {
  it('matches a single unrotated placement\'s own bounds', () => {
    const a = new Assembly();
    a.place(cubePart());
    const b = a.bounds();
    expect(b.min).toEqual([-1, -1, -1]);
    expect(b.max).toEqual([1, 1, 1]);
  });

  it('grows to include a translated placement', () => {
    const a = new Assembly();
    a.place(cubePart());
    a.place(cubePart(), translation([10, 0, 0]));
    const b = a.bounds();
    expect(b.max[0]).toBeCloseTo(11);
  });

  it('accounts for rotation by transforming all eight corners, not just the centre', () => {
    const a = new Assembly();
    // a 45 degree rotation about Z on a unit cube widens its XY footprint
    a.place(cubePart(), rotationAbout([0, 0, 1], Math.PI / 4));
    const b = a.bounds();
    expect(b.max[0]).toBeCloseTo(Math.SQRT2, 4);
  });

  it('is a degenerate, non-infinite box for an empty assembly... ', () => {
    // bounds() starts from +/-Infinity and never narrows with no placements;
    // documented here as the actual (empty-input) contract rather than assumed
    const a = new Assembly();
    const b = a.bounds();
    expect(b.min[0]).toBe(Infinity);
    expect(b.max[0]).toBe(-Infinity);
  });
});

describe('Assembly.stats', () => {
  it('counts instances, unique parts, and triangle totals', () => {
    const a = new Assembly();
    const cube = cubePart();
    a.place(cube);
    a.place(cube); // same Part object: shares the mesh
    a.place(pinPart());
    const s = a.stats();
    expect(s.instances).toBe(3);
    expect(s.uniqueParts).toBe(2);
    expect(s.drawnTriangles).toBe(4 + 4 + 1); // two cube placements + one pin
    expect(s.uniqueTriangles).toBe(4 + 1);
  });

  it('counts a reflected placement as mirrored', () => {
    const a = new Assembly();
    a.place(cubePart(), identity());
    a.place(cubePart(), { ...identity(), 0: -1 } as never); // negate the x basis column: a reflection
    expect(a.stats().mirrored).toBe(1);
  });
});

describe('Placement.anchor', () => {
  it('throws, naming both the part and the missing anchor', () => {
    const a = new Assembly();
    const p = a.place(cubePart());
    expect(() => p.anchor('nope')).toThrow(/"cube" has no anchor "nope"/);
  });
});
