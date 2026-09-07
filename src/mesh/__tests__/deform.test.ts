import { describe, expect, it } from 'vitest';
import { chordLimit, deform, deformAnchor, lateralCoords, lateralVein, lateralWave } from '../deform';
import { MeshBuilder, type Mesh } from '../types';

/**
 * A flat rectangular grid: +X the length, +Y the width, +Z the face normal.
 * Vertex (r, c) sits at index r*(cols+1)+c — deform() moves vertices in place,
 * so tests address them by their known grid position rather than by searching
 * post-deform coordinates, which the fields themselves change.
 */
const ROWS = 20;
const COLS = 12;

function plate(length: number, halfWidth: number, rows = ROWS, cols = COLS): Mesh {
  const mb = new MeshBuilder();
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const x = (r / rows) * length;
      const y = -halfWidth + (c / cols) * halfWidth * 2;
      mb.vertex(x, y, 0, 0, 0, 1, r / rows, c / cols);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * (cols + 1) + c;
      mb.quad(i, i + cols + 1, i + cols + 2, i + 1);
    }
  }
  return mb.build();
}

function at(mesh: Mesh, r: number, c: number, cols = COLS): [number, number, number] {
  const i = (r * (cols + 1) + c) * 3;
  return [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]];
}

describe('deform: does nothing without any field set', () => {
  it('leaves the mesh bit-identical', () => {
    const mesh = plate(20, 5);
    const before = mesh.positions.slice();
    deform(mesh, { length: 20, halfWidth: 5 });
    expect(mesh.positions).toEqual(before);
  });
});

describe('deform: cup', () => {
  it('lifts both margins toward +Z, symmetrically about the midrib', () => {
    const mesh = plate(20, 5);
    deform(mesh, { cup: 0.8, length: 20, halfWidth: 5 });
    const left = at(mesh, 10, 0);
    const right = at(mesh, 10, COLS);
    expect(left[2]).toBeGreaterThan(0.5);
    expect(right[2]).toBeCloseTo(left[2], 1);
  });

  it('leaves the midrib (y=0, c=COLS/2) on the z=0 plane', () => {
    const mesh = plate(20, 5);
    deform(mesh, { cup: 0.8, length: 20, halfWidth: 5 });
    for (let r = 0; r <= ROWS; r++) expect(at(mesh, r, COLS / 2)[2]).toBeCloseTo(0, 1);
  });

  it('preserves arc length across the section — a bend, not a stretch', () => {
    const before = plate(20, 5);
    const after = plate(20, 5);
    deform(after, { cup: 1.2, length: 20, halfWidth: 5 });
    const rowLength = (mesh: Mesh, row: number) => {
      let total = 0;
      for (let c = 0; c < COLS; c++) {
        const a = at(mesh, row, c), b = at(mesh, row, c + 1);
        total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      }
      return total;
    };
    expect(rowLength(after, 5)).toBeCloseTo(rowLength(before, 5), 1);
  });

  it('keel folds the section rigidly rather than as a smooth arc', () => {
    const smooth = plate(20, 5);
    const keeled = plate(20, 5);
    deform(smooth, { cup: 1, keel: 0, length: 20, halfWidth: 5 });
    deform(keeled, { cup: 1, keel: 1, length: 20, halfWidth: 5 });
    // column 3/4 of the way to the margin: the keeled version has already
    // turned through more of its angle there than the smooth arc has
    const c = Math.round(COLS * 0.875);
    expect(at(keeled, 10, c)[2]).not.toBeCloseTo(at(smooth, 10, c)[2], 1);
  });
});

describe('deform: curl', () => {
  it('lifts the tip toward +Z for a positive curl, leaving the base at the origin', () => {
    const mesh = plate(20, 5);
    deform(mesh, { curl: 1.2, length: 20, halfWidth: 5 });
    expect(at(mesh, 0, COLS / 2)[2]).toBeCloseTo(0, 1);
    expect(at(mesh, ROWS, COLS / 2)[2]).toBeGreaterThan(1);
  });

  it('curls the other way for a negative curl', () => {
    const up = plate(20, 5);
    const down = plate(20, 5);
    deform(up, { curl: 1, length: 20, halfWidth: 5 });
    deform(down, { curl: -1, length: 20, halfWidth: 5 });
    expect(Math.sign(at(up, ROWS, COLS / 2)[2])).toBe(1);
    expect(Math.sign(at(down, ROWS, COLS / 2)[2])).toBe(-1);
  });

  it('preserves the total arc length along the midrib', () => {
    const flat = plate(20, 5);
    const curled = plate(20, 5);
    deform(curled, { curl: 2, length: 20, halfWidth: 5 });
    const midribLength = (mesh: Mesh) => {
      let total = 0;
      for (let r = 0; r < ROWS; r++) {
        const a = at(mesh, r, COLS / 2), b = at(mesh, r + 1, COLS / 2);
        total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      }
      return total;
    };
    expect(midribLength(curled)).toBeCloseTo(midribLength(flat), 0);
  });

  it('curlBias above 1 keeps the base straighter and throws the tip back further', () => {
    const even = plate(20, 5);
    const biased = plate(20, 5);
    deform(even, { curl: 1.5, curlBias: 1, length: 20, halfWidth: 5 });
    deform(biased, { curl: 1.5, curlBias: 3, length: 20, halfWidth: 5 });
    // a quarter of the way along the row index (not x, since x itself moves)
    const r = Math.round(ROWS * 0.25);
    expect(at(biased, r, COLS / 2)[2]).toBeLessThan(at(even, r, COLS / 2)[2]);
  });
});

describe('deform: twist', () => {
  it('rotates the section progressively along the length, leaving the base fixed', () => {
    const mesh = plate(20, 5);
    deform(mesh, { twist: Math.PI / 2, length: 20, halfWidth: 5 });
    expect(at(mesh, 0, COLS)[2]).toBeCloseTo(0, 1);
    // at the tip a 90 degree twist rotates the +Y margin substantially toward Z
    expect(Math.abs(at(mesh, ROWS, COLS)[2])).toBeGreaterThan(1);
  });
});

describe('deform: ruffle', () => {
  it('does nothing along the midrib (across = 0 there)', () => {
    const mesh = plate(20, 5);
    deform(mesh, { ruffle: 1, ruffleWaves: 4, length: 20, halfWidth: 5 });
    for (let r = 0; r <= ROWS; r++) expect(at(mesh, r, COLS / 2)[2]).toBeCloseTo(0, 1);
  });

  it('displaces the margin in z somewhere along the length', () => {
    const mesh = plate(20, 5);
    deform(mesh, { ruffle: 1, ruffleWaves: 4, length: 20, halfWidth: 5 });
    let anyDisplaced = false;
    for (let r = 0; r <= ROWS; r++) if (Math.abs(at(mesh, r, COLS)[2]) > 0.05) anyDisplaced = true;
    expect(anyDisplaced).toBe(true);
  });
});

describe('deform: relief (veinField)', () => {
  it('raises the midrib near the base and leaves it flat near the tip', () => {
    const mesh = plate(20, 5);
    deform(mesh, { relief: 0.3, reliefVeins: 0, length: 20, halfWidth: 5 });
    expect(at(mesh, 1, COLS / 2)[2]).toBeGreaterThan(0.05);
    expect(at(mesh, ROWS - 1, COLS / 2)[2]).toBeLessThan(0.05);
  });

  it('does not touch vertex normals — the shader carries the ridge instead', () => {
    const mesh = plate(20, 5);
    const before = mesh.normals.slice();
    deform(mesh, { relief: 0.3, reliefVeins: 3, length: 20, halfWidth: 5 });
    expect(mesh.normals).toEqual(before);
  });
});

describe('deform: throws on a non-finite result', () => {
  it('throws when halfWidth is zero and cup divides by it', () => {
    const mesh = plate(20, 0.001);
    expect(() => deform(mesh, { cup: 1, length: 20, halfWidth: 0 })).toThrow(/non-finite/);
  });
});

describe('deformAnchor', () => {
  it('leaves an anchor untouched when no field is set', () => {
    const result = deformAnchor([5, 0, 0], [0, 0, 1], { length: 20, halfWidth: 5 });
    expect(result.position[0]).toBeCloseTo(5);
    expect(result.axis).toEqual([0, 0, 1]);
  });

  it('carries an anchor through curl the same way the surface at the same x is carried', () => {
    const mesh = plate(20, 5);
    deform(mesh, { curl: 1.2, length: 20, halfWidth: 5 });
    const surface = at(mesh, ROWS, COLS / 2); // x=20, y=0 before deform
    const result = deformAnchor([20, 0, 0], [1, 0, 0], { curl: 1.2, length: 20, halfWidth: 5 });
    expect(result.position[0]).toBeCloseTo(surface[0], 3);
    expect(result.position[2]).toBeCloseTo(surface[2], 3);
  });
});

describe('lateralVein / lateralCoords / lateralWave', () => {
  it('lateralVein returns a valid geometry description for every index', () => {
    for (let i = 0; i < 5; i++) {
      const v = lateralVein(i, 5, 10, 1);
      expect(Number.isFinite(v.r)).toBe(true);
      expect(v.r).toBeGreaterThan(0);
    }
  });

  it('lateralCoords returns 0 along-distance for a point behind the launch point', () => {
    const v = lateralVein(0, 5, 10, 1);
    const [, t] = lateralCoords(v, -100, 0);
    expect(t).toBe(0);
  });

  it('lateralWave is bounded by its amplitude', () => {
    const v = lateralVein(2, 5, 10, 1);
    for (let t = 0; t < v.r * v.sweep; t += 0.5) {
      expect(Math.abs(lateralWave(v, t))).toBeLessThanOrEqual(v.wave * 0.028 + 1e-9);
    }
  });
});

describe('chordLimit', () => {
  it('is infinite when nothing bends the plate', () => {
    expect(chordLimit({}, 0.01)).toBe(Infinity);
  });

  it('shrinks as curl or cup increases', () => {
    const gentle = chordLimit({ curl: 0.3, length: 20 }, 0.01);
    const sharp = chordLimit({ curl: 2, length: 20 }, 0.01);
    expect(sharp).toBeLessThan(gentle);
  });

  it('is bounded by the relief vein width when relief is set, however gentle the bend', () => {
    const limit = chordLimit({ relief: 0.1, halfWidth: 10 }, 100);
    expect(limit).toBeLessThanOrEqual(10 * 0.11 * 0.8 + 1e-9);
  });
});
