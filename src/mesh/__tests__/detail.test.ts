import { afterEach, describe, expect, it } from 'vitest';
import { detail, scaledCount, setDetail } from '../detail';
import { petal } from '../../parts/petal';
import { wire } from '../../parts/wire';
import { compile } from '../../dsl';
import { expectWatertight, expectWellFormed } from './helpers';

afterEach(() => setDetail(1));

describe('scaledCount', () => {
  it('leaves every count alone at full detail', () => {
    for (const n of [6, 8, 12, 72, 128]) expect(scaledCount(n)).toBe(n);
  });
  it('halves a count at half detail, but never below eight', () => {
    setDetail(0.5);
    expect(scaledCount(72)).toBe(36);
    expect(scaledCount(128)).toBe(64);
    expect(scaledCount(12)).toBe(8);
  });
  it('never raises a count above what was written: a hexagon stays a hexagon', () => {
    setDetail(0.5);
    expect(scaledCount(6)).toBe(6);
    expect(scaledCount(3)).toBe(3);
  });
  it('clamps the detail itself to a usable range', () => {
    setDetail(0);
    expect(detail()).toBe(0.1);
    setDetail(4);
    expect(detail()).toBe(1);
  });
});

describe('parts at draft detail', () => {
  const spec = { length: 7, width: 5, thickness: 0.5, shape: 'round' as const, cup: 0.6, curl: 0.4 };
  it('build a bent petal with far fewer triangles, still closed', () => {
    const full = petal(spec).mesh;
    setDetail(0.5);
    const draft = petal(spec).mesh;
    expect(draft.indices.length).toBeLessThan(full.indices.length / 2);
    expectWellFormed(draft);
    expectWatertight(draft);
  });
  it('do not change a mesh the detail does not reach', () => {
    const full = wire({ path: { at: (t: number) => [t * 10, 0, 0], tangent: () => [1, 0, 0] } as never, radius: 1, sections: 8, sides: 6 }).mesh;
    setDetail(0.5);
    const draft = wire({ path: { at: (t: number) => [t * 10, 0, 0], tangent: () => [1, 0, 0] } as never, radius: 1, sections: 8, sides: 6 }).mesh;
    expect(draft.indices.length).toBe(full.indices.length);
  });
});

describe('the sketch at draft detail', () => {
  const source = `
    material gold polished
    part p = petal(length: 7, width: 5, cup: 30deg, segments: 72)
    part w = wire(path: through((0,0,0), (5,0,2), (10,0,0)), radius: 0.5)
    form f {
      place p at (0, 0, 0)
      place w at (0, 0, 0)
    }
  `;
  const triangles = () => {
    const r = compile(source);
    expect(r.error).toBeUndefined();
    return r.sketch!.assembly.placements.map((p) => p.part.mesh.indices.length / 3);
  };
  it('scales a written count as well as a default one, and is not served the full-detail part from the memo', () => {
    const full = triangles();
    setDetail(0.5);
    const draft = triangles();
    expect(draft[0]).toBeLessThan(full[0] / 2);
    expect(draft[1]).toBeLessThan(full[1] / 2);
    setDetail(1);
    expect(triangles()).toEqual(full);
  });
});
