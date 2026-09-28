/**
 * Grass without a device: the field a game describes, and what is refused;
 * the blades grown in it from its seed, which the GPU grows again from the
 * same hash and a test on a device holds to these; how many are kept at a
 * distance; the wind's gusts; and the trample the game presses. Each is
 * something that would be quietly wrong on a device, a blade in the cup or
 * a track that never recovers, with no symptom but the picture.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../../gpu/camera';
import {
  BAND, CHUNK, MAX_SIDE, PRESSES_A_FRAME, STILL, Trample,
  bend, bladesIn, checkField, chunkKinds, frustumPlanes, grassGround, gust, hash, keep, lattice, levels, shrink,
  visibleChunks, widen,
  type GrassField, type GrassKind,
} from '../grass';

const GREEN: GrassKind = { density: 150, height: 0.15, width: 0.05, base: [0.05, 0.25, 0.04], tip: [0.2, 0.6, 0.15] };
const ROUGH: GrassKind = { density: 12, height: 0.8, width: 0.09, base: [0.04, 0.2, 0.05], tip: [0.15, 0.45, 0.1] };

/** A field `cols` by `rows` of a quarter unit a cell, all green, at height 0. */
function field(cols = 32, rows = 32, over: Partial<GrassField> = {}): GrassField {
  return {
    origin: [0, 0], cell: 0.25, cols, rows,
    mask: new Uint8Array(cols * rows).fill(1),
    heights: new Float32Array(cols * rows),
    kinds: [GREEN, ROUGH],
    seed: 7,
    ...over,
  };
}

/** Every blade of the field's grid, kind by kind, chunk by chunk. */
function all(f: GrassField) {
  const out = [];
  for (let cy = 0; cy * CHUNK < f.rows; cy++)
    for (let cx = 0; cx * CHUNK < f.cols; cx++)
      for (let k = 0; k < f.kinds.length; k++) out.push(...bladesIn(f, cx, cy, k));
  return out;
}

describe('a field is refused when it cannot be what it says', () => {
  it('accepts a well-made one', () => {
    expect(() => checkField(field())).not.toThrow();
  });

  it('refuses a mask or heights of the wrong length', () => {
    expect(() => checkField(field(8, 8, { mask: new Uint8Array(63) }))).toThrow(/mask/);
    expect(() => checkField(field(8, 8, { heights: new Float32Array(65) }))).toThrow(/heights/);
  });

  it('refuses more than eight kinds, none, and a mask naming a kind there is not', () => {
    expect(() => checkField(field(8, 8, { kinds: Array(9).fill(GREEN) }))).toThrow(/kinds/);
    expect(() => checkField(field(8, 8, { kinds: [] }))).toThrow(/kinds/);
    const mask = new Uint8Array(64).fill(1);
    mask[5] = 3;
    expect(() => checkField(field(8, 8, { mask }))).toThrow(/mask/);
  });

  it('refuses a height that is not a number', () => {
    const heights = new Float32Array(64);
    heights[9] = NaN;
    expect(() => checkField(field(8, 8, { heights }))).toThrow(/height/);
  });

  it('refuses a grid past its ceiling, or with no size', () => {
    expect(() => checkField(field(MAX_SIDE + 1, 1))).toThrow(/cells/);
    expect(() => checkField(field(0, 4))).toThrow(/cells/);
    expect(() => checkField(field(8, 8, { cell: 0 }))).toThrow(/cell/);
  });

  it('refuses a kind with no blades, no height or no width, or more blades than a chunk can hold', () => {
    expect(() => checkField(field(8, 8, { kinds: [{ ...GREEN, density: 0 }] }))).toThrow(/density/);
    expect(() => checkField(field(8, 8, { kinds: [{ ...GREEN, height: 0 }] }))).toThrow(/height/);
    expect(() => checkField(field(8, 8, { kinds: [{ ...GREEN, width: -1 }] }))).toThrow(/width/);
    expect(() => checkField(field(8, 8, { kinds: [{ ...GREEN, density: 1e6 }] }))).toThrow(/density/);
  });

  it('refuses an outside that names a kind there is not', () => {
    expect(() => checkField(field(8, 8, { outside: { kind: 2, height: 0 } }))).toThrow(/outside/);
  });

  it('refuses distances out of order, a capacity of nothing, and a trample past its ceiling', () => {
    expect(() => checkField(field(), { near: 50, mid: 40 })).toThrow(/near/);
    expect(() => checkField(field(), { capacity: 0 })).toThrow(/capacity/);
    expect(() => checkField(field(), { trample: { origin: [0, 0], cell: 0.1, cols: 2048, rows: 1024 } })).toThrow(/trample/);
  });
});

describe('the blades grown in a field', () => {
  it('are the same from the same seed, and others from another', () => {
    const a = all(field()), b = all(field()), c = all(field(32, 32, { seed: 8 }));
    expect(b).toEqual(a);
    expect(c.length).toBeGreaterThan(0);
    expect(c.map((x) => x.x)).not.toEqual(a.map((x) => x.x));
  });

  it('grow only in cells their own kind is given', () => {
    // the left half green, the right half rough, and a hole of none in the middle, as a cup is cut from a green
    const f = field(32, 32);
    const cup = (x: number, y: number) => Math.hypot(x - 4, y - 4) < 1.45;
    for (let j = 0; j < 32; j++)
      for (let i = 0; i < 32; i++) {
        const x = (i + 0.5) * 0.25, y = (j + 0.5) * 0.25;
        f.mask[j * 32 + i] = cup(x, y) ? 0 : i < 16 ? 1 : 2;
      }
    const blades = all(f);
    expect(blades.length).toBeGreaterThan(1000);
    for (const b of blades) {
      const i = Math.floor(b.x / 0.25), j = Math.floor(b.y / 0.25);
      expect(f.mask[j * 32 + i], `a blade at ${b.x}, ${b.y}`).toBe(b.kind + 1);
    }
    // none inside the cup's disc, by more than the width of a cell
    expect(blades.filter((b) => Math.hypot(b.x - 4, b.y - 4) < 1.45 - 0.36).length).toBe(0);
  });

  it('stand on the height of the cell they grow in', () => {
    const f = field(32, 32);
    for (let j = 0; j < 32; j++) for (let i = 0; i < 32; i++) f.heights[j * 32 + i] = i >= 16 ? 0.4 : 0;
    const blades = all(f);
    expect(blades.filter((b) => b.z > 0).length).toBeGreaterThan(1000);
    for (const b of blades) expect(b.z).toBe(Math.floor(b.x / 0.25) >= 16 ? Math.fround(0.4) : 0);
  });

  it('come to the density asked, within five per cent over a large field', () => {
    const f = field(128, 128);
    const area = 32 * 32;
    const green = all(f).filter((b) => b.kind === 0).length;
    expect(Math.abs(green / area - 150) / 150).toBeLessThan(0.05);
    f.mask.fill(2);
    const rough = all(f).filter((b) => b.kind === 1).length;
    expect(Math.abs(rough / area - 12) / 12).toBeLessThan(0.05);
  });

  it('stay where they are in every cell but those changed, since they are anchored to the ground and not the field', () => {
    const f = field(32, 32);
    const before = all(f);
    expect(before.length).toBeGreaterThan(1000);
    // a square unit turned to rough: a single cell is smaller than the rough's lattice, and might grow none
    for (let j = 8; j < 12; j++) for (let i = 8; i < 12; i++) f.mask[j * 32 + i] = 2;
    const after = all(f);
    const inCell = (b: { x: number; y: number }) => b.x >= 2 && b.x < 3 && b.y >= 2 && b.y < 3;
    expect(after.filter((b) => !inCell(b))).toEqual(before.filter((b) => !inCell(b)));
    expect(after.filter(inCell).length).toBeGreaterThan(0);
    expect(after.filter(inCell).every((b) => b.kind === 1)).toBe(true);
  });

  it('grow beyond the grid only as the outside says, at its height', () => {
    const f = field(16, 16, { outside: { kind: 1, height: -3 } });
    const beyond = bladesIn(f, 1, 0, 1);
    expect(beyond.length).toBeGreaterThan(0);
    expect(beyond.every((b) => b.z === -3 && b.x >= 4)).toBe(true);
    expect(bladesIn(field(16, 16), 1, 0, 1)).toEqual([]);
    expect(bladesIn(f, 1, 0, 0)).toEqual([]);
  });

  it('are given a lattice of as many a side as the density asks, held to what a chunk can hold', () => {
    expect(lattice(GREEN, 4)).toBe(49);
    expect(lattice(ROUGH, 4)).toBe(14);
    expect(lattice({ ...GREEN, density: 1e-6 }, 4)).toBe(1);
  });

  it('draw their chance from a hash that spreads a counter over all of a u32', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const h = hash(i);
      expect(Number.isInteger(h) && h >= 0 && h < 2 ** 32).toBe(true);
      seen.add(h);
    }
    expect(seen.size).toBe(1000);
  });
});

describe('the chunks a camera sees', () => {
  const camera = () => {
    const c = new Camera();
    c.fov = 40; c.aspect = 1.6; c.near = 2; c.far = 800;
    c.target = [4, 4, 0];
    c.position = [4, 4 - Math.sin(0.78) * 62, Math.cos(0.78) * 62];
    c.update();
    return c;
  };

  it('are the planes of the frustum, which a point in view is inside and one behind is not', () => {
    const c = camera();
    const planes = frustumPlanes(c.viewProjection);
    const inside = (p: number[]) => [0, 1, 2, 3, 4, 5].every((k) => planes[k * 4] * p[0] + planes[k * 4 + 1] * p[1] + planes[k * 4 + 2] * p[2] + planes[k * 4 + 3] >= 0);
    expect(inside([4, 4, 0])).toBe(true);
    expect(inside([4, -200, 0])).toBe(false);
    expect(inside([400, 4, 0])).toBe(false);
  });

  it('take in every chunk of a field in view, each once for each kind grown in it', () => {
    const f = field(32, 32);
    f.mask.fill(2, 0, 32 * 16);
    const c = camera();
    const out = new Int32Array(4 * 64);
    const n = visibleChunks(f, chunkKinds(f), frustumPlanes(c.viewProjection), c.position, 300, out);
    const entries = [...Array(n)].map((_, i) => [...out.subarray(i * 4, i * 4 + 4)]);
    // four chunks: the two lower rough, the two upper green, and each with its lattice
    expect(entries.sort()).toEqual([[0, 0, 1, 14], [0, 1, 0, 49], [1, 0, 1, 14], [1, 1, 0, 49]].sort());
  });

  it('leave out what is past the far distance, and hold to the room they are given', () => {
    const f = field(32, 32, { outside: { kind: 1, height: 0 } });
    const c = camera();
    const planes = frustumPlanes(c.viewProjection);
    const out = new Int32Array(4 * 100_000);
    const near = visibleChunks(f, chunkKinds(f), planes, c.position, 100, out);
    const far = visibleChunks(f, chunkKinds(f), planes, c.position, 300, out);
    expect(far).toBeGreaterThan(near);
    for (let i = 0; i < far; i++) {
      const x = (out[i * 4] + 0.5) * 4, y = (out[i * 4 + 1] + 0.5) * 4;
      expect(Math.hypot(x - c.position[0], y - c.position[1])).toBeLessThan(300 + 4);
    }
    expect(visibleChunks(f, chunkKinds(f), planes, c.position, 300, new Int32Array(4 * 10))).toBe(10);
  });
});

describe('how many are kept at a distance', () => {
  it('is all of them inside the near distance, and none at the far', () => {
    expect(keep(0, 40, 300)).toBe(1);
    expect(keep(40, 40, 300)).toBe(1);
    expect(keep(300, 40, 300)).toBe(0);
    expect(keep(1000, 40, 300)).toBe(0);
  });

  it('falls without a step from the near to the far', () => {
    let last = 1;
    for (let d = 40; d <= 300; d += 0.05) {
      const k = keep(d, 40, 300);
      expect(k).toBeLessThanOrEqual(last);
      expect(last - k).toBeLessThan(0.01);
      last = k;
    }
  });

  it('keeps a blade full height where it is kept at all, and shrinks it to nothing before it goes', () => {
    expect(shrink(0.99, 1)).toBe(1);
    expect(shrink(0.2, 0.5)).toBe(1);
    expect(shrink(0.5 * (1 + BAND), 0.5)).toBe(0);
    let last = 1;
    for (let k = 1; k >= 0; k -= 0.001) {
      const s = shrink(0.4, k);
      expect(last - s).toBeLessThan(0.02);
      last = s;
    }
    expect(last).toBe(0);
  });

  it('keeps at half the density a subset of what it keeps at the whole', () => {
    expect(keep(10, 40, 300, 0.5)).toBe(0.5);
    for (let r = 0; r < 1; r += 0.01)
      for (const d of [10, 60, 150])
        if (shrink(r, keep(d, 40, 300, 0.5)) > 0) expect(shrink(r, keep(d, 40, 300, 1))).toBeGreaterThan(0);
  });

  it('widens what it keeps so the field holds its colour, and never past three times', () => {
    expect(widen(1)).toBe(1);
    expect(widen(0.25)).toBeCloseTo(2);
    expect(widen(0.001)).toBe(3);
  });

  it('takes its distances from the tallest kind unless it is told them', () => {
    expect(levels(field())).toEqual({ near: 40, mid: 88, far: 300 });
    expect(levels(field(), { near: 10, mid: 20, far: 30 })).toEqual({ near: 10, mid: 20, far: 30 });
  });
});

describe('the wind', () => {
  const wind = { direction: [3, 4] as [number, number], strength: 1, gustSize: 20, gustSpeed: 4 };

  it('gusts between nothing and all of its strength, and not evenly', () => {
    let lo = 1, hi = 0;
    for (let i = 0; i < 2000; i++) {
      const g = gust(i * 0.37, i * 1.13, wind, i * 0.01);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
      lo = Math.min(lo, g); hi = Math.max(hi, g);
    }
    expect(hi - lo).toBeGreaterThan(0.5);
  });

  it('carries its gusts downwind at their speed', () => {
    const [dx, dy] = [0.6, 0.8];
    for (const [x, y, t] of [[1, 2, 0], [30, -7, 5.5], [-12, 40, 100]]) {
      const moved = gust(x + dx * 4 * 1.5, y + dy * 4 * 1.5, wind, t + 1.5);
      expect(moved).toBeCloseTo(gust(x, y, wind, t), 5);
    }
  });

  it('bends nothing when it is still, and more for more give', () => {
    expect(bend(1, STILL, 0.7, 0.3, 12)).toBe(0);
    expect(bend(1, wind, 0.7, 0.3, 12)).toBeGreaterThan(bend(0.2, wind, 0.7, 0.3, 12));
  });
});

describe('the colour the ground under a kind should be', () => {
  it('is what a blade averages to from its root to its tip', () => {
    const g = grassGround(GREEN);
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let i = 0; i < 1000; i++) sum += GREEN.base[c] + (GREEN.tip[c] - GREEN.base[c]) * ((i + 0.5) / 1000) ** 0.7;
      expect(g[c]).toBeCloseTo(sum / 1000, 3);
    }
  });
});

describe('the trample', () => {
  const rect = { origin: [0, 0] as [number, number], cell: 0.25, cols: 40, rows: 40, recovery: 6 };

  it('is pressed at once, recovers over its time, and is gone by the end of it', () => {
    const t = new Trample(rect);
    expect(t.press(5, 5, 1, 1, 0, 10)).toBe(true);
    expect(t.depthAt(5, 5, 10)).toBe(1);
    let last = 1;
    for (let s = 10; s <= 16; s += 0.1) {
      const d = t.depthAt(5, 5, s);
      expect(d).toBeLessThanOrEqual(last);
      last = d;
    }
    expect(t.depthAt(5, 5, 16)).toBe(0);
    expect(t.depthAt(5, 5, 100)).toBe(0);
  });

  it('presses a disc, soft at its edge, and nothing outside it', () => {
    const t = new Trample(rect);
    t.press(5, 5, 1, 0, 1, 0);
    expect(t.depthAt(5.3, 5, 0)).toBe(1);
    const edge = t.depthAt(5.8, 5, 0);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(1);
    expect(t.depthAt(6.4, 5, 0)).toBe(0);
  });

  it('has nothing pressed before its time, as after a new hole the clock goes back', () => {
    const t = new Trample(rect);
    t.press(5, 5, 1, 1, 0, 10);
    expect(t.depthAt(5, 5, 10)).toBe(1);
    expect(t.depthAt(5, 5, 9)).toBe(0);
  });

  it('leaves a fresh track deeper than a light touch that comes after it', () => {
    const t = new Trample(rect);
    t.press(5, 5, 1, 1, 0, 10);
    t.press(5.9, 5, 1, 0, 1, 10.5);
    expect(t.depthAt(5, 5, 10.5)).toBeGreaterThan(0.9);
    expect(t.direction(5, 5)).toEqual([1, 0]);
  });

  it('refuses a press off its grid, and past so many in a frame', () => {
    const t = new Trample(rect);
    expect(t.press(-5, -5, 1, 1, 0, 0)).toBe(false);
    expect(t.press(50, 5, 1, 1, 0, 0)).toBe(false);
    for (let i = 0; i < PRESSES_A_FRAME; i++) expect(t.press(5, 5, 0.5, 1, 0, 0)).toBe(true);
    expect(t.press(5, 5, 0.5, 1, 0, 0)).toBe(false);
    t.take();
    expect(t.press(5, 5, 0.5, 1, 0, 0)).toBe(true);
  });

  it('says which texels a frame pressed, and nothing once taken', () => {
    const t = new Trample(rect);
    expect(t.take()).toBeNull();
    t.press(2, 2, 0.5, 1, 0, 0);
    t.press(6, 3, 0.5, 1, 0, 0);
    const d = t.take()!;
    expect(d.x0).toBeLessThanOrEqual(Math.floor(1.5 / 0.25));
    expect(d.x1).toBeGreaterThanOrEqual(Math.ceil(6.5 / 0.25));
    expect(d.y0).toBeLessThanOrEqual(Math.floor(1.5 / 0.25));
    expect(d.y1).toBeGreaterThanOrEqual(Math.ceil(3.5 / 0.25));
    expect(t.take()).toBeNull();
  });

  it('is emptied by clear, all of it marked to be sent again', () => {
    const t = new Trample(rect);
    t.press(5, 5, 1, 1, 0, 0);
    t.take();
    t.clear();
    expect(t.depthAt(5, 5, 0)).toBe(0);
    expect(t.take()).toEqual({ x0: 0, y0: 0, x1: 40, y1: 40 });
  });

  it('keeps a fixed amount whatever is pressed, since nothing is added to', () => {
    const t = new Trample(rect);
    const data = t.data;
    for (let i = 0; i < 10_000; i++) {
      t.press((i * 0.37) % 10, (i * 0.91) % 10, 0.8, 1, 0, i * 0.01);
      if (i % PRESSES_A_FRAME === 0) t.take();
    }
    expect(t.data).toBe(data);
    expect(t.data.length).toBe(40 * 40 * 4);
  });
});
