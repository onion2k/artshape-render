import { describe, expect, it } from 'vitest';
import { EMITTER_STRIDE, PARTICLE_STRIDE, packEmitter, type Emit } from '../particles';
import { WASH_CAPACITY, packWashes, washFollow, washVelocity, type Wash } from '../wash';

const hub: Wash = { position: [0, 0, 100], radius: 20, speed: 300, reach: 200 };

describe('the wash, a field of air under a source', () => {
  it('blows straight down under the hub', () => {
    const [x, y, z] = washVelocity([hub], [0, 0, 60]);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(0, 6);
    expect(z).toBeLessThan(-100);
  });

  it('is at its fullest at the source itself, and weaker further down the column', () => {
    const top = washVelocity([hub], [0, 0, 100])[2];
    const mid = washVelocity([hub], [0, 0, 50])[2];
    const low = washVelocity([hub], [0, 0, -50])[2];
    expect(top).toBeCloseTo(-300, 4);
    expect(Math.abs(mid)).toBeLessThan(Math.abs(top));
    expect(Math.abs(low)).toBeLessThan(Math.abs(mid));
  });

  it('turns outward as it nears the ground, below the source', () => {
    const high = washVelocity([hub], [8, 0, 90]);
    const low = washVelocity([hub], [8, 0, -70]);
    // up by the hub it is mostly down; near the end of its reach mostly out
    expect(Math.abs(high[2])).toBeGreaterThan(Math.abs(high[0]));
    expect(low[0]).toBeGreaterThan(0);
    expect(low[0]).toBeGreaterThan(Math.abs(low[2]));
    // out is away from the axis, whichever side
    expect(washVelocity([hub], [-8, 0, -70])[0]).toBeLessThan(0);
    expect(washVelocity([hub], [0, 8, -70])[1]).toBeGreaterThan(0);
  });

  it('is weaker across the column than down its middle', () => {
    const middle = washVelocity([hub], [0, 0, 80]);
    const edge = washVelocity([hub], [15, 0, 80]);
    expect(Math.hypot(...edge)).toBeLessThan(Math.hypot(...middle));
  });

  it('is nothing above the source', () => {
    expect(washVelocity([hub], [0, 0, 100.5])).toEqual([0, 0, 0]);
    expect(washVelocity([hub], [5, 0, 500])).toEqual([0, 0, 0]);
  });

  it('is nothing past its reach', () => {
    expect(washVelocity([hub], [0, 0, -100])).toEqual([0, 0, 0]);
    expect(washVelocity([hub], [0, 0, -400])).toEqual([0, 0, 0]);
    // and falls to nothing as it gets there, not in a step
    expect(Math.hypot(...washVelocity([hub], [0, 0, -99]))).toBeLessThan(2);
  });

  it('is nothing past the column\'s edge, which widens as it falls', () => {
    expect(washVelocity([hub], [20, 0, 100])).toEqual([0, 0, 0]);
    expect(washVelocity([hub], [25, 0, 100])).toEqual([0, 0, 0]);
    // lower down the same offset is inside, since the air has spread
    expect(Math.hypot(...washVelocity([hub], [25, 0, 0]))).toBeGreaterThan(0);
    expect(washVelocity([hub], [500, 0, 0])).toEqual([0, 0, 0]);
  });

  it('is the sum of two washes where they overlap', () => {
    const other: Wash = { position: [10, 0, 120], radius: 30, speed: 150, reach: 250 };
    const p: [number, number, number] = [4, 3, 40];
    const a = washVelocity([hub], p), b = washVelocity([other], p), both = washVelocity([hub, other], p);
    for (let k = 0; k < 3; k++) expect(both[k]).toBeCloseTo(a[k] + b[k], 9);
    expect(Math.hypot(...a)).toBeGreaterThan(0);
    expect(Math.hypot(...b)).toBeGreaterThan(0);
  });

  it('is nothing from no washes, and from a wash that says nothing', () => {
    expect(washVelocity([], [0, 0, 0])).toEqual([0, 0, 0]);
    expect(washVelocity([{ ...hub, speed: 0 }], [0, 0, 50])).toEqual([0, 0, 0]);
  });

  it('has a smoke follow it closely and a drop hardly at all', () => {
    expect(washFollow(0)).toBeGreaterThan(0.8);
    expect(washFollow(-1)).toBe(washFollow(0));
    expect(washFollow(1)).toBeLessThan(0.1);
    expect(washFollow(5)).toBe(washFollow(1));
    expect(washFollow(0.5)).toBeLessThan(washFollow(0));
    expect(washFollow(0.5)).toBeGreaterThan(washFollow(1));
  });
});

describe('the washes packed for the GPU', () => {
  it('lays each out as two vec4s: where and how wide, then how fast and how far', () => {
    const out = new Float32Array(WASH_CAPACITY * 8).fill(-1);
    const r = packWashes([hub, { position: [1, 2, 3], radius: 4, speed: 5, reach: 6 }], out);
    expect(r).toEqual({ count: 2, dropped: 0 });
    expect([...out.slice(0, 8)]).toEqual([0, 0, 100, 20, 300, 200, 0, 0]);
    expect([...out.slice(8, 16)]).toEqual([1, 2, 3, 4, 5, 6, 0, 0]);
  });

  it('keeps no more than the capacity and says how many it dropped', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ ...hub, speed: 100 + i }));
    const out = new Float32Array(WASH_CAPACITY * 8);
    expect(WASH_CAPACITY).toBe(4);
    const r = packWashes(six, out);
    expect(r).toEqual({ count: 4, dropped: 2 });
    // the first four, in order
    expect([out[4], out[12], out[20], out[28]]).toEqual([100, 101, 102, 103]);
  });

  it('leaves out a wash that could blow nothing, or is not a number, and does not count it as dropped', () => {
    const out = new Float32Array(WASH_CAPACITY * 8);
    const bad = [
      { ...hub, speed: 0 }, { ...hub, radius: 0 }, { ...hub, reach: -1 }, { ...hub, speed: NaN },
      { ...hub, position: [0, Infinity, 0] as [number, number, number] },
    ];
    expect(packWashes([...bad, hub], out)).toEqual({ count: 1, dropped: 0 });
    expect(out[4]).toBe(300);
    expect(packWashes([], out)).toEqual({ count: 0, dropped: 0 });
  });
});

describe('an emitter packed with its fade', () => {
  const emit: Emit = { position: [1, 2, 3], velocity: [4, 5, 6], spread: 7, count: 8, life: 9, size: 10, colour: [0.1, 0.2, 0.3], alpha: 0.5 };
  const pack = (e: Emit) => { const d = new Float32Array(EMITTER_STRIDE).fill(-9); packEmitter(d, 0, e, 8, 3, 4); return d; };

  it('gives the particle room for it: five vec4s, and the emitter still six', () => {
    expect(PARTICLE_STRIDE).toBe(20);
    expect(EMITTER_STRIDE).toBe(24);
  });

  it('holds the fade colour and a one in the spare vec4', () => {
    const d = pack({ ...emit, fade: [0.7, 0.8, 0.9] });
    expect([...d.slice(20, 24)].map((v) => Math.round(v * 10) / 10)).toEqual([0.7, 0.8, 0.9, 1]);
  });

  it('holds nothing in it when there is no fade, so the colour is kept for life', () => {
    expect([...pack(emit).slice(20, 24)]).toEqual([0, 0, 0, 0]);
  });

  it('packs the rest as it always was', () => {
    const want = new Float32Array([1, 2, 3, 8, 4, 5, 6, 7, 0.1, 0.2, 0.3, 0.5, 9, 10, 0, -1e9, 1, 3, 0, 4]);
    expect(pack(emit).slice(0, 20)).toEqual(want);
  });
});
