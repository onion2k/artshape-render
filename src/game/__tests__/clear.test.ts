import { describe, expect, it } from 'vitest';
import { CLEAR_DEFAULTS_MM, CLEAR_STRIDE, clearUniform, resolveClear } from '../clear';
import { FLOW_CLEAR, FLOW_GLOW, FLOW_WATER, isFlowKind, packFlow, usesClear, usesFlow } from '../flow';
import { PATTERN_STRIDE } from '../renderer';

describe('clear water and glow, as pattern kinds', () => {
  it('are nine and ten, after the four that flow', () => {
    expect([FLOW_CLEAR, FLOW_GLOW]).toEqual([9, 10]);
    expect(isFlowKind(FLOW_CLEAR)).toBe(true);
    expect(isFlowKind(FLOW_GLOW)).toBe(true);
  });

  it('say a group is clear only when a placement of it is clear water', () => {
    const p = new Float32Array(PATTERN_STRIDE * 3);
    expect(usesClear(undefined, PATTERN_STRIDE)).toBe(false);
    expect(usesClear(p, PATTERN_STRIDE)).toBe(false);
    packFlow(p, 0, { kind: FLOW_WATER, scale: 0.4, speed: 1, glow: 0.3, second: [1, 1, 1] });
    packFlow(p, PATTERN_STRIDE, { kind: FLOW_GLOW, scale: 0, speed: 0, glow: 2, second: [0.5, 1, 0.3] });
    expect(usesClear(p, PATTERN_STRIDE), 'open water and a glow are not clear').toBe(false);
    expect(usesFlow(p, PATTERN_STRIDE)).toBe(true);
    packFlow(p, PATTERN_STRIDE * 2, { kind: FLOW_CLEAR, scale: 0.4, speed: 1, glow: 0.1, second: [0, 0.2, 0.4] });
    expect(usesClear(p, PATTERN_STRIDE)).toBe(true);
  });
});

describe("clear water's settings", () => {
  it('are the defaults, in the world\'s own units, where a look asks for none of them', () => {
    // a world in tenths of a metre, the golf's: a hundred millimetres a unit
    const w = resolveClear(undefined, 100);
    expect(w.clarity).toBeCloseTo(CLEAR_DEFAULTS_MM.clarity / 100, 10);
    expect(w.refraction).toBeCloseTo(CLEAR_DEFAULTS_MM.refraction / 100, 10);
    expect(w.foamWidth).toBeCloseTo(CLEAR_DEFAULTS_MM.foamWidth / 100, 10);
    expect(w.causticScale).toBeCloseTo(CLEAR_DEFAULTS_MM.causticScale / 100, 10);
    // and in millimetres, arena's and chess's, the same water a thousand times the numbers of a world in metres
    expect(resolveClear(undefined, 1).clarity).toBe(CLEAR_DEFAULTS_MM.clarity);
    expect(w.glitter).toBe(CLEAR_DEFAULTS_MM.glitter);
    expect(w.caustics).toBe(CLEAR_DEFAULTS_MM.caustics);
  });

  it('take what a look names over the defaults, and keep the rest', () => {
    const w = resolveClear({ clarity: 3, caustics: 0 }, 100);
    expect(w.clarity).toBe(3);
    expect(w.caustics).toBe(0);
    expect(w.refraction).toBeCloseTo(CLEAR_DEFAULTS_MM.refraction / 100, 10);
  });

  it('refuse what cannot be drawn: a clarity or a foam of no width, or a number that is not one', () => {
    const w = resolveClear({ clarity: 0, foamWidth: -1, glitter: Number.NaN, caustics: -2, causticScale: 0 }, 100);
    expect(w.clarity).toBeGreaterThan(0);
    expect(w.foamWidth).toBeGreaterThanOrEqual(0);
    expect(w.glitter).toBe(CLEAR_DEFAULTS_MM.glitter);
    expect(w.caustics).toBe(0);
    expect(w.causticScale).toBeGreaterThan(0);
  });

  it('pack into twelve floats, in the order the clear pass reads them', () => {
    expect(CLEAR_STRIDE).toBe(12);
    const out = new Float32Array(CLEAR_STRIDE).fill(-1);
    clearUniform(out, {
      clarity: 2, refraction: 0.5, foamWidth: 0.25, glitter: 0.75,
      foam: [1, 0.5, 0.25], caustics: 0.5, foamEdge: [0.125, 0.25, 0.5], causticScale: 4,
    });
    expect([...out]).toEqual([2, 0.5, 0.25, 0.75, 1, 0.5, 0.25, 0.5, 0.125, 0.25, 0.5, 4]);
  });
});

describe("clear water's shader", () => {
  it('is its own text: not a word of it in any build of the scene shader, and the waves and the scene head in it', async () => {
    const { clearSource, sceneSource } = await import('../shaders');
    const text = clearSource();
    for (const word of ['ClearFrame', 'opaqueDepth', 'clearWorld', 'FOAM_CORE', 'CAUSTIC_LINE'])
      for (const toon of [false, true])
        for (const flowing of [false, true])
          for (const shadows of [false, true]) expect(sceneSource({ toon, flowing, shadows }), `${word} in a scene build`).not.toContain(word);
    expect(text).toContain('fn waterSlope');
    expect(text).toContain('struct Frame');
    expect(text).toContain('@group(1) @binding(0) var opaque');
    expect(clearSource(false)).toContain('const SHADOWS: bool = false;');
  });
});
