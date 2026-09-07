import { expect } from 'vitest';
import type { Mesh } from '../types';

/** Structural sanity every generator must satisfy, whatever shape it draws. */
export function expectWellFormed(mesh: Mesh) {
  const n = mesh.positions.length / 3;
  expect(mesh.positions.length % 3).toBe(0);
  expect(mesh.normals.length).toBe(mesh.positions.length);
  expect(mesh.uvs.length).toBe(n * 2);
  expect(mesh.indices.length % 3).toBe(0);
  expect(mesh.indices.length).toBeGreaterThan(0);

  for (const i of mesh.indices) {
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(n);
  }
  for (let v = 0; v < n; v++) {
    const l = Math.hypot(mesh.normals[v * 3], mesh.normals[v * 3 + 1], mesh.normals[v * 3 + 2]);
    // a degenerate seam vertex can legitimately average to zero; every mesh
    // tested here is expected to be otherwise well-conditioned
    if (l > 1e-6) expect(l).toBeCloseTo(1, 1);
  }
  // no degenerate (zero-area) triangle
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  }
}

/**
 * Every geometric edge of a closed surface is shared by exactly two faces.
 *
 * Keyed by rounded position rather than vertex index: a crease or a cap seam
 * is drawn as two coincident vertices with different normals on purpose (see
 * MeshBuilder / sweep's own comments), so index-sharing is not what "closed"
 * means for these generators — position-sharing is.
 */
export function expectWatertight(mesh: Mesh, precision = 4) {
  // Round first, then fold -0 to +0: a value merely close to zero (a residual
  // cos/sin epsilon at a seam) still prints as "-0.0000" from toFixed alone,
  // which would hash a vertex away from its geometrically identical twin.
  const scale = 10 ** precision;
  const fmt = (n: number) => {
    const rounded = Math.round(n * scale) / scale;
    return (rounded + 0).toFixed(precision);
  };
  const key = (v: number) => `${fmt(mesh.positions[v * 3])},${fmt(mesh.positions[v * 3 + 1])},${fmt(mesh.positions[v * 3 + 2])}`;
  const counts = new Map<string, number>();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const tri = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]].map(key);
    for (let e = 0; e < 3; e++) {
      const a = tri[e], b = tri[(e + 1) % 3];
      const edgeKey = a < b ? `${a}|${b}` : `${b}|${a}`;
      counts.set(edgeKey, (counts.get(edgeKey) ?? 0) + 1);
    }
  }
  for (const [edge, count] of counts) expect(count, `edge ${edge}`).toBe(2);
}

export function boundsOf(mesh: Mesh) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], mesh.positions[i + k]);
      max[k] = Math.max(max[k], mesh.positions[i + k]);
    }
  }
  return { min, max };
}
