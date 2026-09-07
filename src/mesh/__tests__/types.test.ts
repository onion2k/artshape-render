import { describe, expect, it } from 'vitest';
import {
  enamelConcave, enamelInside, enamelWhole, mergeMeshes, MeshBuilder, recomputeNormals, uvExtent, type Mesh,
} from '../types';
import type { Vec3 } from '../../geom/types';
import { sweep } from '../sweep';
import { extrude } from '../extrude';
import { circle } from '../../geom/profile';
import { line, samplePath } from '../../geom/curve';

function flatQuad(): Mesh {
  // a unit quad in the XY plane, facing +Z if wound correctly
  const mb = new MeshBuilder();
  mb.vertex(0, 0, 0, 0, 0, 1, 0, 0);
  mb.vertex(1, 0, 0, 0, 0, 1, 1, 0);
  mb.vertex(1, 1, 0, 0, 0, 1, 1, 1);
  mb.vertex(0, 1, 0, 0, 0, 1, 0, 1);
  mb.quad(0, 1, 2, 3);
  return mb.build();
}

describe('MeshBuilder', () => {
  it('tracks vertex and triangle counts as it accumulates', () => {
    const mb = new MeshBuilder();
    expect(mb.vertexCount).toBe(0);
    mb.vertex(0, 0, 0, 0, 0, 1, 0, 0);
    mb.vertex(1, 0, 0, 0, 0, 1, 1, 0);
    mb.vertex(0, 1, 0, 0, 0, 1, 0, 1);
    expect(mb.vertexCount).toBe(3);
    mb.triangle(0, 1, 2);
    expect(mb.triangleCount).toBe(1);
  });

  it('vertex() returns the index it was assigned', () => {
    const mb = new MeshBuilder();
    mb.vertex(0, 0, 0, 0, 0, 1, 0, 0);
    const second = mb.vertex(1, 0, 0, 0, 0, 1, 1, 0);
    expect(second).toBe(1);
  });

  it('quad() winds as two triangles sharing the a-c diagonal', () => {
    const mb = new MeshBuilder();
    for (let i = 0; i < 4; i++) mb.vertex(i, 0, 0, 0, 0, 1, 0, 0);
    mb.quad(0, 1, 2, 3);
    expect([...mb.build().indices]).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it('grid() stitches a rows*cols lattice as quads, duplicated-seam column included', () => {
    const mb = new MeshBuilder();
    // 2 rows, 3 cols (as if col 2 duplicates col 0 for a seam)
    for (let i = 0; i < 6; i++) mb.vertex(i, 0, 0, 0, 0, 1, 0, 0);
    mb.grid(0, 2, 3);
    // (rows-1) * (cols-1) quads = 1 * 2 = 2 quads = 4 triangles
    expect(mb.triangleCount).toBe(4);
  });

  it('build() produces arrays sized consistently with what was accumulated', () => {
    const mb = new MeshBuilder();
    mb.vertex(0, 0, 0, 0, 0, 1, 0.25, 0.75);
    const mesh = mb.build();
    expect(mesh.positions).toEqual(new Float32Array([0, 0, 0]));
    expect(mesh.normals).toEqual(new Float32Array([0, 0, 1]));
    expect(mesh.uvs).toEqual(new Float32Array([0.25, 0.75]));
  });
});

describe('recomputeNormals', () => {
  it('gives a flat quad a uniform normal along its winding direction', () => {
    const mesh = flatQuad();
    mesh.normals.fill(0); // clobber the analytic normals recomputeNormals is meant to replace
    recomputeNormals(mesh);
    for (let v = 0; v < 4; v++) {
      expect(mesh.normals[v * 3]).toBeCloseTo(0);
      expect(mesh.normals[v * 3 + 1]).toBeCloseTo(0);
      expect(mesh.normals[v * 3 + 2]).toBeCloseTo(1);
    }
  });

  it('every normal has unit length afterward', () => {
    // a simple pyramid: apex plus a triangular base, non-planar around the apex
    const mb = new MeshBuilder();
    mb.vertex(0, 0, 2, 0, 0, 1, 0, 0); // apex, 0
    mb.vertex(-1, -1, 0, 0, 0, 1, 0, 0); // 1
    mb.vertex(1, -1, 0, 0, 0, 1, 0, 0); // 2
    mb.vertex(0, 1, 0, 0, 0, 1, 0, 0); // 3
    mb.triangle(0, 1, 2);
    mb.triangle(0, 2, 3);
    mb.triangle(0, 3, 1);
    const mesh = mb.build();
    mesh.normals.fill(0);
    recomputeNormals(mesh);
    for (let v = 0; v < 4; v++) {
      const l = Math.hypot(mesh.normals[v * 3], mesh.normals[v * 3 + 1], mesh.normals[v * 3 + 2]);
      expect(l).toBeCloseTo(1);
    }
  });
});

describe('mergeMeshes', () => {
  it('concatenates positions and offsets the second mesh\'s indices', () => {
    const a = flatQuad();
    const b = flatQuad();
    const merged = mergeMeshes([a, b]);
    expect(merged.positions.length).toBe(a.positions.length + b.positions.length);
    expect(merged.indices.length).toBe(a.indices.length + b.indices.length);
    // b's first triangle now points past all of a's vertices
    const bFirstIndex = merged.indices[a.indices.length];
    expect(bFirstIndex).toBe(a.positions.length / 3);
  });

  it('every index in the merged mesh stays within the merged vertex count', () => {
    const merged = mergeMeshes([flatQuad(), flatQuad(), flatQuad()]);
    const n = merged.positions.length / 3;
    for (const i of merged.indices) { expect(i).toBeGreaterThanOrEqual(0); expect(i).toBeLessThan(n); }
  });

  it('carries enamel through only for meshes that have it, defaulting the rest to 0', () => {
    const plain = flatQuad();
    const glazed = enamelWhole(flatQuad());
    const merged = mergeMeshes([plain, glazed]);
    expect(merged.enamel).toBeDefined();
    const n = plain.positions.length / 3;
    for (let i = 0; i < n; i++) expect(merged.enamel![i]).toBe(0);
    for (let i = n; i < n * 2; i++) expect(merged.enamel![i]).toBe(1);
  });

  it('omits enamel entirely when no input mesh carries it', () => {
    const merged = mergeMeshes([flatQuad(), flatQuad()]);
    expect(merged.enamel).toBeUndefined();
  });

  it('merging nothing produces an empty mesh, not an error', () => {
    const merged = mergeMeshes([]);
    expect(merged.positions).toHaveLength(0);
    expect(merged.indices).toHaveLength(0);
  });
});

describe('enamelWhole', () => {
  it('marks every vertex', () => {
    const mesh = enamelWhole(flatQuad());
    expect([...mesh.enamel!]).toEqual([1, 1, 1, 1]);
  });
});

describe('enamelInside', () => {
  it('marks only vertices whose normal points back toward the axis', () => {
    // two vertices on a cylinder at radius 1: one with an outward normal
    // (metal outside), one with an inward normal (glazed inside)
    const mb = new MeshBuilder();
    mb.vertex(1, 0, 0, 1, 0, 0, 0, 0);  // 0: outward normal
    mb.vertex(-1, 0, 0, 1, 0, 0, 0, 0); // 1: normal still points +X, i.e. inward here
    mb.vertex(0, 0, 5, 0, 0, 1, 0, 0);  // 2: on the axis, radius ~0, never marked
    mb.triangle(0, 1, 2);
    const mesh = enamelInside(mb.build());
    expect(mesh.enamel![0]).toBe(0);
    expect(mesh.enamel![1]).toBe(1);
    expect(mesh.enamel![2]).toBe(0);
  });
});

describe('enamelConcave', () => {
  it('marks the concave face — opposite the side a bulging path bows toward', () => {
    // a path bulging toward +Y (a shallow hill): the concave side, the one a
    // marble would settle into, is the underside, facing -Y. Interior points
    // only — an endpoint's one-sided difference is too shallow to classify
    // against this test's 0.35 threshold, which is exactly why enamelConcave
    // borrows the whole-path fallback rather than trusting single endpoints.
    const path: Vec3[] = Array.from({ length: 7 }, (_, i) => {
      const x = i * 5;
      const t = i / 6;
      return [x, 4 * t * (1 - t) * 4, 0] as Vec3; // parabolic bulge, peak at the middle
    });
    const mb = new MeshBuilder();
    for (const p of path) {
      mb.vertex(p[0], p[1], p[2], 0, 1, 0, 0, 0);  // faces +Y: the convex, outer side
      mb.vertex(p[0], p[1], p[2], 0, -1, 0, 0, 0); // faces -Y: the concave, inner side
    }
    const mesh = enamelConcave(mb.build(), path);
    for (let i = 1; i < path.length - 1; i++) {
      expect(mesh.enamel![i * 2], `+Y at point ${i}`).toBe(0);
      expect(mesh.enamel![i * 2 + 1], `-Y at point ${i}`).toBe(1);
    }
  });

  it('falls back to the upper face when the path has no broad concave face', () => {
    // a path bowed within the XY plane: the bend direction lies in-plane, so
    // no vertex normal (which points out of the swept tube's own faces) can
    // align broadly with it — the function should fall back to marking z > 0
    const path: Vec3[] = [[0, 0, 0], [10, 3, 0], [20, 0, 0]];
    const mb = new MeshBuilder();
    for (const p of path) {
      mb.vertex(p[0], p[1], p[2] + 1, 0, 0, 1, 0, 0);  // above: +Z
      mb.vertex(p[0], p[1], p[2] - 1, 0, 0, -1, 0, 0); // below: -Z
    }
    const mesh = enamelConcave(mb.build(), path);
    for (let i = 0; i < path.length; i++) {
      expect(mesh.enamel![i * 2]).toBe(1);
      expect(mesh.enamel![i * 2 + 1]).toBe(0);
    }
  });
});

describe('uvExtent', () => {
  it('reads a flat plate as its own width and height in millimetres', () => {
    const mb = new MeshBuilder();
    // a 20 x 8 rectangle with uv 0..1 across each
    mb.vertex(0, 0, 0, 0, 0, 1, 0, 0);
    mb.vertex(20, 0, 0, 0, 0, 1, 1, 0);
    mb.vertex(20, 8, 0, 0, 0, 1, 1, 1);
    mb.vertex(0, 8, 0, 0, 0, 1, 0, 1);
    mb.quad(0, 1, 2, 3);
    const [su, sv] = uvExtent(mb.build());
    expect(su).toBeCloseTo(20);
    expect(sv).toBeCloseTo(8);
  });

  it('reads a swept tube as its length along u and its circumference around v', () => {
    const mesh = sweep(samplePath(line([0, 0, 0], [30, 0, 0]), 10), { profile: circle(2, 16) });
    const [su, sv] = uvExtent(mesh);
    // the end caps carry odd uv and pull the estimate a little; within 5% is what it is for
    expect(Math.abs(su - 30) / 30).toBeLessThan(0.05);
    expect(Math.abs(sv - 2 * Math.PI * 2) / (2 * Math.PI * 2)).toBeLessThan(0.05);
  });

  it('a plate records its span at extrusion', () => {
    const mesh = extrude({ outline: [[-5, -2], [5, -2], [5, 2], [-5, 2]], thickness: 1 });
    expect(mesh.uvSpan).toEqual([-5, -2, 10, 4]);
  });
});
