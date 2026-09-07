import { describe, expect, it } from 'vitest';
import { chordLimit, deform, deformAnchor } from '../deform';
import { MeshBuilder, type Mesh } from '../types';

const ROWS = 10, COLS = 6;
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
const allFinite = (mesh: Mesh) => [...mesh.positions].every(Number.isFinite) && [...mesh.normals].every(Number.isFinite);

describe('deform edge cases: zero length or width', () => {
  it('throws cleanly (not a silent NaN) when length is zero and curl is set', () => {
    const mesh = plate(0.001, 5);
    expect(() => deform(mesh, { curl: 1, length: 0, halfWidth: 5 })).toThrow(/non-finite/);
  });

  it('does nothing harmful when length is zero but no field reads it', () => {
    const mesh = plate(0.001, 5);
    expect(() => deform(mesh, { length: 0, halfWidth: 5 })).not.toThrow();
  });

  it('already throws for halfWidth=0 with cup (regression: covered again alongside the length=0 case)', () => {
    const mesh = plate(20, 0.001);
    expect(() => deform(mesh, { cup: 1, length: 20, halfWidth: 0 })).toThrow(/non-finite/);
  });
});

describe('deform edge cases: negative field values mirror the positive case', () => {
  it('negative cup folds the margins toward -Z instead of +Z', () => {
    const mesh = plate(20, 5);
    deform(mesh, { cup: -1, length: 20, halfWidth: 5 });
    expect(allFinite(mesh)).toBe(true);
    const rightZ = mesh.positions[(5 * (COLS + 1) + COLS) * 3 + 2];
    expect(rightZ).toBeLessThan(0);
  });

  it('negative twist rotates the opposite way', () => {
    const pos = plate(20, 5);
    const neg = plate(20, 5);
    deform(pos, { twist: Math.PI / 2, length: 20, halfWidth: 5 });
    deform(neg, { twist: -Math.PI / 2, length: 20, halfWidth: 5 });
    const zAt = (mesh: Mesh) => mesh.positions[(ROWS * (COLS + 1) + COLS) * 3 + 2];
    expect(Math.sign(zAt(pos))).toBe(-Math.sign(zAt(neg)));
  });

  it('negative ruffle still stays finite and still leaves the midrib untouched', () => {
    const mesh = plate(20, 5);
    deform(mesh, { ruffle: -1, ruffleWaves: 4, length: 20, halfWidth: 5 });
    expect(allFinite(mesh)).toBe(true);
    for (let r = 0; r <= ROWS; r++) {
      expect(mesh.positions[(r * (COLS + 1) + COLS / 2) * 3 + 2]).toBeCloseTo(0, 1);
    }
  });
});

describe('deform edge cases: out-of-range keel is clamped, not merely tolerated', () => {
  it('keel above 1 behaves the same as keel = 1 (clamped internally)', () => {
    const over = plate(20, 5);
    const atOne = plate(20, 5);
    deform(over, { cup: 1, keel: 2.5, length: 20, halfWidth: 5 });
    deform(atOne, { cup: 1, keel: 1, length: 20, halfWidth: 5 });
    expect(allFinite(over)).toBe(true);
    expect(over.positions).toEqual(atOne.positions);
  });

  it('keel below 0 behaves the same as keel = 0', () => {
    const under = plate(20, 5);
    const atZero = plate(20, 5);
    deform(under, { cup: 1, keel: -3, length: 20, halfWidth: 5 });
    deform(atZero, { cup: 1, keel: 0, length: 20, halfWidth: 5 });
    expect(under.positions).toEqual(atZero.positions);
  });
});

describe('deform edge cases: curl through more than a full turn', () => {
  it('stays finite for several full turns of curl', () => {
    const mesh = plate(20, 5, 60, 6);
    deform(mesh, { curl: Math.PI * 6, length: 20, halfWidth: 5 });
    expect(allFinite(mesh)).toBe(true);
  });

  it('still preserves arc length along the midrib after several turns', () => {
    const flat = plate(20, 5, 60, 6);
    const curled = plate(20, 5, 60, 6);
    deform(curled, { curl: Math.PI * 4, length: 20, halfWidth: 5 });
    const midribLength = (mesh: Mesh) => {
      let total = 0;
      for (let r = 0; r < 60; r++) {
        const a = (r * 7 + 3) * 3, b = ((r + 1) * 7 + 3) * 3;
        total += Math.hypot(
          mesh.positions[b] - mesh.positions[a],
          mesh.positions[b + 1] - mesh.positions[a + 1],
          mesh.positions[b + 2] - mesh.positions[a + 2],
        );
      }
      return total;
    };
    expect(midribLength(curled)).toBeCloseTo(midribLength(flat), 0);
  });
});

describe('deform edge cases: zero curlBias, and a zero-length span', () => {
  it('curlBias of 0 does not throw (though physically odd: s^0 = 1 everywhere)', () => {
    const mesh = plate(20, 5);
    expect(() => deform(mesh, { curl: 1, curlBias: 0, length: 20, halfWidth: 5 })).not.toThrow();
    expect(allFinite(mesh)).toBe(true);
  });
});

describe('deformAnchor edge cases', () => {
  it('a zero-length axis does not throw, but its own guard leaves the returned axis at zero rather than a unit vector', () => {
    // deformAnchor's probe divides by (dx,dy,dz)'s own length with "|| 1", so
    // a zero-length input axis produces a zero-length output axis rather
    // than NaN — silently wrong (not a unit vector) but not a crash
    const result = deformAnchor([1, 0, 0], [0, 0, 0], { curl: 1, length: 20, halfWidth: 5 });
    expect(Number.isFinite(result.axis[0])).toBe(true);
    expect(Math.hypot(...result.axis)).toBeCloseTo(0);
  });

  it('a position outside [0, length] still returns a finite result via the table\'s extrapolation', () => {
    const result = deformAnchor([100, 0, 0], [1, 0, 0], { curl: 1, length: 20, halfWidth: 5 });
    expect(Number.isFinite(result.position[0])).toBe(true);
    expect(Number.isFinite(result.position[2])).toBe(true);
  });
});

describe('chordLimit edge cases', () => {
  it('treats a negative curl or cup the same as its positive magnitude', () => {
    expect(chordLimit({ curl: -2, length: 20 }, 0.01)).toBeCloseTo(chordLimit({ curl: 2, length: 20 }, 0.01));
    expect(chordLimit({ cup: -1, halfWidth: 5 }, 0.01)).toBeCloseTo(chordLimit({ cup: 1, halfWidth: 5 }, 0.01));
  });

  it('a zero tolerance drives the limit to zero rather than throwing', () => {
    expect(chordLimit({ curl: 1, length: 20 }, 0)).toBe(0);
  });

  it('takes the tightest constraint when several fields are set at once', () => {
    const curlOnly = chordLimit({ curl: 3, length: 20 }, 0.01);
    const both = chordLimit({ curl: 3, length: 20, cup: 3, halfWidth: 0.5 }, 0.01);
    expect(both).toBeLessThanOrEqual(curlOnly);
  });
});

describe('deform edge cases: twist also guards against a zero length', () => {
  it('throws the same non-finite guard as curl and cup', () => {
    const mesh = plate(0.001, 5);
    expect(() => deform(mesh, { twist: 1, length: 0, halfWidth: 5 })).toThrow(/non-finite/);
  });

  it('stays finite through many full turns', () => {
    const mesh = plate(20, 5);
    deform(mesh, { twist: Math.PI * 20, length: 20, halfWidth: 5 });
    expect(allFinite(mesh)).toBe(true);
  });
});

describe('deform edge cases: ruffleWaves = 0 degenerates to no ruffle at all', () => {
  it('leaves every z coordinate untouched (sin(0 * x) is 0 everywhere)', () => {
    const mesh = plate(20, 5);
    deform(mesh, { ruffle: 1, ruffleWaves: 0, length: 20, halfWidth: 5 });
    for (let i = 0; i < mesh.positions.length; i += 3) expect(mesh.positions[i + 2]).toBeCloseTo(0, 6);
  });
});

describe('deform edge cases: a negative reliefVeins count is simply no laterals', () => {
  it('does not throw, and still raises the midrib ridge on its own', () => {
    const mesh = plate(20, 5);
    // veinField's lateral loop is `for (i = 0; i < veins; i++)`, so a
    // negative count just never runs it — only the midrib term applies
    expect(() => deform(mesh, { relief: 0.3, reliefVeins: -2, length: 20, halfWidth: 5 })).not.toThrow();
    expect(mesh.positions[(1 * (COLS + 1) + COLS / 2) * 3 + 2]).toBeGreaterThan(0);
  });
});
