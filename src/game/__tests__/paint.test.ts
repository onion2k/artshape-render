/**
 * The painted edge's knobs, their packing and their sums, without a device.
 * What must hold is what the shader reads: the uniform's floats sit where the
 * struct says, an empty set is the recipe exactly, one moved knob moves one
 * float, and each sum does what its plan line says at its ends.
 */
import { describe, expect, it } from 'vitest';
import {
  PAINT_DEFAULT,
  PAINT_OFFSETS,
  PAINT_SETS,
  PAINT_SET_FLOATS,
  PAINT_UNIFORM_WGSL,
  PAINT_WGSL,
  packPaint,
  paintBand,
  paintCrowdFade,
  paintFade,
  paintLip,
  paintLit,
  paintMark,
  paintStrength,
  paintWidth,
  type PaintSet,
} from '../paint';

const pack = (sets: PaintSet[]) => {
  const out = new Float32Array(PAINT_SETS * PAINT_SET_FLOATS);
  packPaint(out, sets);
  return out;
};
const KNOBS = Object.keys(PAINT_DEFAULT) as (keyof PaintSet)[];
const floatsOf = (k: keyof PaintSet) => (Array.isArray(PAINT_DEFAULT[k]) ? 3 : 1);

describe('packing', () => {
  it('writes PAINT_SETS records of PAINT_SET_FLOATS floats, and a multiple of four', () => {
    expect(PAINT_SETS).toBe(4);
    expect(PAINT_SET_FLOATS % 4).toBe(0);
    const out = new Float32Array(PAINT_SETS * PAINT_SET_FLOATS + 8).fill(7);
    packPaint(out, []);
    expect(out.slice(PAINT_SETS * PAINT_SET_FLOATS).every((v) => v === 7)).toBe(true);
    expect(out.slice(0, PAINT_SETS * PAINT_SET_FLOATS).some((v) => v === 7)).toBe(false);
  });

  it('holds the float count: every knob has an offset, none overlap, all inside the record', () => {
    expect(Object.keys(PAINT_OFFSETS).sort()).toEqual([...KNOBS].sort());
    const used = new Set<number>();
    for (const k of KNOBS) for (let i = 0; i < floatsOf(k); i++) {
      const at = PAINT_OFFSETS[k] + i;
      expect(used.has(at), `${k} overlaps`).toBe(false);
      expect(at).toBeLessThan(PAINT_SET_FLOATS);
      used.add(at);
    }
    // nothing wasted beyond padding: the record is the knobs rounded up to the struct's own alignment
    expect(PAINT_SET_FLOATS - used.size).toBeLessThan(8);
  });

  it('packs an empty set, and a missing one, as the default, every field by offset', () => {
    const out = pack([{}]);
    for (let s = 0; s < PAINT_SETS; s++)
      for (const k of KNOBS) {
        const want = PAINT_DEFAULT[k];
        const vals = Array.isArray(want) ? want : [want];
        vals.forEach((v, i) => expect(out[s * PAINT_SET_FLOATS + PAINT_OFFSETS[k] + i], `${k} of set ${s}`).toBe(Math.fround(v as number)));
      }
  });

  it('changes only the float of the one knob moved, in the one set', () => {
    const base = pack([]);
    for (const k of KNOBS) {
      const moved: PaintSet = { [k]: Array.isArray(PAINT_DEFAULT[k]) ? [0.11, 0.22, 0.33] : 0.123 };
      const out = pack([{}, {}, moved]);
      const changed: number[] = [];
      out.forEach((v, i) => v !== base[i] && changed.push(i));
      const at = 2 * PAINT_SET_FLOATS + PAINT_OFFSETS[k];
      expect(changed, k).toEqual(Array.from({ length: floatsOf(k) }, (_, i) => at + i));
    }
  });

  it('takes a knob left out of a set that is given as the default', () => {
    const out = pack([{ gate: 0.5 }]);
    expect(out[PAINT_OFFSETS.gate]).toBe(0.5);
    expect(out[PAINT_OFFSETS.ramp]).toBe(Math.fround(PAINT_DEFAULT.ramp));
  });
});

describe('the uniform struct', () => {
  it('lays its fields at the offsets the table says, with vec3 aligned to sixteen bytes', () => {
    const body = /struct PaintSet\s*\{([^}]*)\}/.exec(PAINT_UNIFORM_WGSL)![1]!;
    const fields = [...body.matchAll(/(\w+)\s*:\s*(f32|vec3f)/g)].map((m) => ({ name: m[1]!, type: m[2]! }));
    let at = 0;
    const seen: Record<string, number> = {};
    for (const f of fields) {
      const [size, align] = f.type === 'vec3f' ? [3, 4] : [1, 1];
      at = Math.ceil(at / align) * align;
      if (!f.name.startsWith('pad')) seen[f.name] = at;
      at += size;
    }
    expect(seen).toEqual(PAINT_OFFSETS);
    expect(Math.ceil(at / 4) * 4).toBe(PAINT_SET_FLOATS);
    expect(PAINT_UNIFORM_WGSL).toMatch(new RegExp(`array<PaintSet, ${PAINT_SETS}>`));
  });

  it('declares every sum the fragment will call', () => {
    for (const name of ['paintWidth', 'paintBand', 'paintStrength', 'paintFade', 'paintCrowdFade', 'paintMark', 'paintLit', 'paintLip'])
      expect(PAINT_WGSL).toContain(`fn ${name}(`);
  });
});

describe('the band', () => {
  it('is one on the edge, a half at the width, nought a footprint of antialiasing past it', () => {
    const [w, foot, aa] = [0.2, 0.05, 0.25];
    expect(paintBand(0, w, foot, aa)).toBe(1);
    expect(paintBand(w, w, foot, aa)).toBeCloseTo(0.5, 12);
    expect(paintBand(w + aa * foot, w, foot, aa)).toBe(0);
    expect(paintBand(w + 1, w, foot, aa)).toBe(0);
    expect(paintBand(w - aa * foot, w, foot, aa)).toBe(1);
  });
});

describe('the width', () => {
  const facet = 1;
  it('is the larger of the world width and its share of the facet', () => {
    expect(paintWidth(0.2, 0.08, 0, 0, facet, 0)).toBeCloseTo(0.2);
    expect(paintWidth(0.2, 0.5, 0, 0, facet, 0)).toBeCloseTo(0.5);
  });
  it('halves where the share cap binds', () => {
    const free = paintWidth(0.5, 0, 0, 0, facet, 0);
    expect(paintWidth(0.5, 0, 0, 0.25, facet, 0)).toBeCloseTo(0.25);
    expect(paintWidth(0.5, 0, 0, 0.25, facet, 0)).toBe(free / 2);
  });
  it('never falls under the pixel floor unless the cap says so', () => {
    expect(paintWidth(0.01, 0, 1, 0, facet, 0.3)).toBeCloseTo(0.3);
    expect(paintWidth(0.01, 0, 1, 0.25, facet, 0.3)).toBeCloseTo(0.25);
    expect(paintWidth(0.01, 0, 1, 0.25, facet, 0.1)).toBeCloseTo(0.1);
  });
});

describe('the strength', () => {
  it('is nought under the gate and one over the gate and the ramp', () => {
    expect(paintStrength(0.3, 0.3, 0.15, 1, 0.3)).toBe(0);
    expect(paintStrength(0, 0.3, 0.15, 1, 0.3)).toBe(0);
    expect(paintStrength(0.45, 0.3, 0.15, 1, 0.3)).toBe(1);
    expect(paintStrength(2, 0.3, 0.15, 1, 0.3)).toBe(1);
    expect(paintStrength(0.375, 0.3, 0.15, 1, 0.3)).toBeCloseTo(0.5);
  });
  it('is nought where the up-share is under ridgeUp - 0.1, one over ridgeUp + 0.1', () => {
    expect(paintStrength(1, 0.3, 0.15, 0.2 - 1e-6, 0.3)).toBe(0);
    expect(paintStrength(1, 0.3, 0.15, 0.4, 0.3)).toBe(1);
    expect(paintStrength(1, 0.3, 0.15, 0.3, 0.3)).toBeCloseTo(0.5);
  });
  it('survives a ramp of nought', () => {
    expect(paintStrength(1, 0.3, 0, 1, 0.3)).toBe(1);
  });
});

describe('the fade with size', () => {
  it('is nought at fadePx, one at three times it, and none where fadePx is nought', () => {
    expect(paintFade(6, 6)).toBe(0);
    expect(paintFade(18, 6)).toBe(1);
    expect(paintFade(30, 6)).toBe(1);
    expect(paintFade(0.1, 0)).toBe(1);
  });
});

describe('the crowd fade', () => {
  it('lets go at a crowded vertex, and not at a quiet one or far from it', () => {
    expect(paintCrowdFade(5, 0, 0.8, 1, 1)).toBe(0);
    expect(paintCrowdFade(5, 0.8, 0.8, 1, 1)).toBe(1);
    expect(paintCrowdFade(2, 0, 0.8, 1, 1)).toBe(1);
    expect(paintCrowdFade(5, 0, 0.8, 1, 0)).toBe(1);
    expect(paintCrowdFade(5.9, 0, 0.8, 1, 0.5)).toBeCloseTo(0.5);
  });
});

describe('the mark', () => {
  it('along the ridgeline is brightest at its head and darkest at its tail', () => {
    const at = (a: number) => paintMark(a, 0.5, 0.6, 0, 1);
    expect(at(0)).toBeCloseTo(1.6, 10);
    expect(at(1)).toBeCloseTo(0.4, 10);
    for (let a = 0.05; a <= 1; a += 0.05) expect(at(a)).toBeLessThan(at(a - 0.05));
  });
  it('dims the stroke at both ends and leaves the middle whole', () => {
    const at = (a: number) => paintMark(a, 0.5, 0, 0.8, 1);
    expect(at(0)).toBeCloseTo(0.2, 10);
    expect(at(1)).toBeCloseTo(0.2, 10);
    expect(at(0.15)).toBeCloseTo(1, 10);
    expect(at(0.75)).toBeCloseTo(1, 10);
    expect(at(0.075)).toBeLessThan(1);
  });
  it('by noise alone ignores the place along', () => {
    for (const n of [0, 0.3, 1]) expect(paintMark(0, n, 0.6, 0.8, 0)).toBe(paintMark(0.7, n, 0.6, 0.8, 0));
  });
  it('is one with nothing asked of it', () => {
    expect(paintMark(0.5, 0.5, 0, 0, 1)).toBe(1);
    expect(paintMark(0.5, 0.9, 0, 0, 0)).toBe(1);
  });
});

describe('the lit weighting', () => {
  it('with litCut one is nought where the sun squarely lights the face', () => {
    expect(paintLit(1, 1, 0.6, 0.9, 2, 1)).toBe(0);
    expect(paintLit(1, 1, 0.6, 0.9, 2, 0)).toBeCloseTo(1);
  });
  it('is the whole where neither weight is asked, and lower turned from sun and up', () => {
    expect(paintLit(0, 0, 0, 0, 2, 0)).toBe(1);
    expect(paintLit(0, 0, 0.6, 0.9, 2, 0)).toBeCloseTo(0.1, 5);
  });
  it('keeps a power for the sun and up terms, so a half-turned face gets a quarter', () => {
    expect(paintLit(0.5, 0, 1, 0, 2, 0)).toBeCloseTo(0.25, 5);
  });
});

describe('the lip', () => {
  it('is the albedo at nought, the paint at one, and never over one', () => {
    expect(paintLip([0.2, 0.3, 0.4], [0.62, 0.55, 0.42], 0)).toEqual([0.2, 0.3, 0.4]);
    expect(paintLip([0.2, 0.3, 0.4], [0.62, 0.55, 0.42], 1)).toEqual([0.62, 0.55, 0.42]);
    for (const amount of [-3, 0.5, 1, 7]) for (const c of paintLip([1, 0.9, 1], [1.4, 1, 2], amount)) expect(c).toBeLessThanOrEqual(1);
    for (const c of paintLip([0.2, 0.3, 0.4], [0.62, 0.55, 0.42], -3)) expect(c).toBeGreaterThanOrEqual(0);
  });
});
