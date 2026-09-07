import { describe, expect, it } from 'vitest';
import { sweep } from '../sweep';
import * as profile from '../../geom/profile';
import { samplePath } from '../../geom/curve';
import { computeWear } from '../wear';
import { MeshBuilder, type Mesh } from '../types';
import { extrude } from '../extrude';

/** A flat grid, so every interior vertex should read as unworn (curvature 0). */
function flatGrid(rows = 6, cols = 6): Mesh {
  const mb = new MeshBuilder();
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) mb.vertex(r, c, 0, 0, 0, 1, r / rows, c / cols);
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * (cols + 1) + c;
      mb.quad(i, i + cols + 1, i + cols + 2, i + 1);
    }
  }
  return mb.build();
}

describe('computeWear: a flat plate wears evenly at (close to) zero', () => {
  it('every interior vertex is near zero', () => {
    const wear = computeWear(flatGrid());
    for (const w of wear) expect(Math.abs(w)).toBeLessThan(0.05);
  });

  it('returns one value per vertex', () => {
    const mesh = flatGrid();
    const wear = computeWear(mesh);
    expect(wear).toHaveLength(mesh.positions.length / 3);
  });
});

/**
 * A bevelled square plate, from the real extrude() generator, gives a known
 * mix of features to judge computeWear against without hand-building a
 * synthetic crease: a flat cap interior (should read near zero), and a
 * bevel where the surface actually breaks (should read strongly either way).
 */
function bevelledPlate() {
  return extrude({
    outline: [[-10, -10], [10, -10], [10, 10], [-10, 10]],
    thickness: 2,
    bevel: 0.6,
  });
}

describe('computeWear: a real bevelled edge reads more strongly than a flat cap', () => {
  it('cap-interior vertices (cap = 1 or -1, away from the rim) read near zero', () => {
    const mesh = bevelledPlate();
    const wear = computeWear(mesh);
    let interior = 0, count = 0;
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      if (!mesh.cap![v]) continue;
      if (Math.abs(mesh.positions[v * 3]) > 7 || Math.abs(mesh.positions[v * 3 + 1]) > 7) continue;
      interior += Math.abs(wear[v]);
      count++;
    }
    expect(count).toBeGreaterThan(0);
    expect(interior / count).toBeLessThan(0.1);
  });

  it('bevel vertices (cap = 0) read more strongly than the flat cap interior does, on average', () => {
    const mesh = bevelledPlate();
    const wear = computeWear(mesh);
    const meanAbsWhere = (pred: (v: number) => boolean) => {
      let total = 0, count = 0;
      for (let v = 0; v < mesh.positions.length / 3; v++) {
        if (!pred(v)) continue;
        total += Math.abs(wear[v]); count++;
      }
      return count ? total / count : 0;
    };
    const bevelMean = meanAbsWhere((v) => mesh.cap![v] === 0);
    const capInteriorMean = meanAbsWhere((v) =>
      !!mesh.cap![v] && Math.abs(mesh.positions[v * 3]) < 7 && Math.abs(mesh.positions[v * 3 + 1]) < 7);
    expect(bevelMean).toBeGreaterThan(capInteriorMean);
  });

  it('output always stays within [-1, 1]', () => {
    const wear = computeWear(bevelledPlate());
    for (const w of wear) { expect(w).toBeGreaterThanOrEqual(-1); expect(w).toBeLessThanOrEqual(1); }
  });
});

describe('computeWear: reference radius controls sensitivity', () => {
  it('a smaller reference radius saturates the same geometry more readily', () => {
    const mesh = bevelledPlate();
    const coarse = computeWear(mesh, 0.05);
    const fine = computeWear(mesh, 5);
    const meanAbs = (w: Float32Array) => [...w].reduce((s, v) => s + Math.abs(v), 0) / w.length;
    expect(meanAbs(fine)).toBeGreaterThan(meanAbs(coarse));
  });
});

describe('computeWear: does not throw on a degenerate mesh', () => {
  it('a mesh with zero-length edges (duplicate positions) is handled without NaN', () => {
    const mb = new MeshBuilder();
    mb.vertex(0, 0, 0, 0, 0, 1, 0, 0);
    mb.vertex(0, 0, 0, 0, 0, 1, 0, 0); // duplicate
    mb.vertex(1, 0, 0, 0, 0, 1, 0, 0);
    mb.triangle(0, 1, 2);
    const wear = computeWear(mb.build());
    for (const w of wear) expect(Number.isFinite(w)).toBe(true);
  });

  it('an empty mesh returns an empty array', () => {
    const wear = computeWear(new MeshBuilder().build());
    expect(wear).toHaveLength(0);
  });
});

describe('computeWear: a vertex split at a seam wears as one', () => {
  it('a closed band\'s seam ring reads as its neighbours do, on both copies', () => {
    const ring = samplePath({ at: (t) => [Math.cos(t * Math.PI * 2) * 12, Math.sin(t * Math.PI * 2) * 12, 0] }, 64);
    const mesh = sweep(ring, { profile: profile.ribbon(4.5, 1, 4), closed: true, up: [0, 0, 1] });
    const wear = computeWear(mesh);
    const e = mesh.engrave!;
    const period = mesh.engravePeriod!;
    let cols = 0;
    while (e[cols * 2] === 0) cols++;
    const dup = mesh.positions.length / 3 - cols;
    expect(Math.abs(e[dup * 2] - period)).toBeLessThan(1e-4);
    // the flat of the band, away from its corners
    for (let c = 3; c < cols - 3; c++) {
      const inner = wear[2 * cols + c];
      expect(Math.abs(wear[c] - inner)).toBeLessThan(0.05);
      expect(Math.abs(wear[dup + c] - inner)).toBeLessThan(0.05);
    }
  });
});
