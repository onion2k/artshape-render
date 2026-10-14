import { describe, expect, it } from 'vitest';
import { CLEAR_DEFAULTS_MM, CLEAR_FINISH_FLOATS, CLEAR_FOAM_FLOATS, CLEAR_FRAME_FLOATS, CLEAR_MIRROR_FLOATS, CLEAR_RIPPLE_FLOATS, CLEAR_STRIDE, clearUniform, finishUniform, mirrorUniform, foamUniform, packClearFrame, resolveClear, rippleUniform } from '../clear';
import { WAVE_FLOATS } from '../waves';
import { SHORE_FIELD_FLOATS } from '../shore';
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

describe("clear water's finish", () => {
  it('is none of it where a look asks for none: no near colour, no crests, no sparkles, all packed as noughts', () => {
    const w = resolveClear(undefined, 100);
    expect([w.near, w.crest, w.sparkles]).toEqual([null, null, 0]);
    expect([...finishUniform(new Float32Array(CLEAR_FINISH_FLOATS), w)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, w.sparkleCut, w.sparkleBright, w.sparkleSize]);
    // the near distance a millimetre figure, in the world's own units
    expect(w.nearDistance).toBeCloseTo(CLEAR_DEFAULTS_MM.nearDistance / 100, 10);
  });

  it('packs a near colour with its distance and a crest with its amount, and holds shares to one', () => {
    const w = resolveClear({ near: [0.5, 0.75, 1], nearDistance: 8, crest: [1, 1, 0.5], crestAmount: 3, sparkles: 2, sparkleCut: 0.25, sparkleBright: 6, sparkleSize: 4 }, 100);
    expect([...finishUniform(new Float32Array(CLEAR_FINISH_FLOATS), w)]).toEqual([0.5, 0.75, 1, 8, 1, 1, 0.5, 1, 1, 0.25, 6, 4]);
  });

  it('comes after the waves in the frame and before the shore field, which is every part packed and no more', () => {
    expect(CLEAR_FRAME_FLOATS).toBe(16 + 4 + CLEAR_STRIDE + WAVE_FLOATS + CLEAR_FINISH_FLOATS + SHORE_FIELD_FLOATS + CLEAR_MIRROR_FLOATS + CLEAR_RIPPLE_FLOATS + CLEAR_FOAM_FLOATS);
    const out = new Float32Array(CLEAR_FRAME_FLOATS).fill(-1);
    packClearFrame(out, new Float32Array(16), 100, 50, resolveClear({ near: [0.25, 0.5, 0.75], nearDistance: 3 }, 100), 98.1);
    expect([...out.subarray(20 + CLEAR_STRIDE + WAVE_FLOATS, 24 + CLEAR_STRIDE + WAVE_FLOATS)]).toEqual([0.25, 0.5, 0.75, 3]);
    expect(out.includes(-1), 'every float written').toBe(false);
  });
});

describe("clear water's mirror", () => {
  it('asks for nothing by default: no tint, the whole easing to nothing by the camera, today\'s strength', () => {
    const w = resolveClear(undefined, 100);
    expect([w.mirrorTint, w.mirrorNear, w.mirror]).toEqual([null, 0, 1]);
    expect([...mirrorUniform(new Float32Array(CLEAR_MIRROR_FLOATS).fill(-1), w)]).toEqual([0, 0, 0, 0, 1, 0, 0, 0]);
  });

  it('takes a tint, a share kept by the camera and a strength, and packs them where the shader reads them', () => {
    const w = resolveClear({ mirrorTint: [0, 0.5, 1], mirrorNear: 0.25, mirror: 0.5 }, 100);
    expect([w.mirrorTint, w.mirrorNear, w.mirror]).toEqual([[0, 0.5, 1], 0.25, 0.5]);
    expect([...mirrorUniform(new Float32Array(CLEAR_MIRROR_FLOATS).fill(-1), w)]).toEqual([0, 0.5, 1, 1, 0.5, 0.25, 0, 0]);
    // and in the frame, after the shore field, which keeps the place it had
    const out = new Float32Array(CLEAR_FRAME_FLOATS).fill(-1);
    packClearFrame(out, new Float32Array(16), 100, 50, w, 98.1);
    expect([...out.subarray(CLEAR_FRAME_FLOATS - CLEAR_FOAM_FLOATS - CLEAR_RIPPLE_FLOATS - CLEAR_MIRROR_FLOATS, CLEAR_FRAME_FLOATS - CLEAR_FOAM_FLOATS - CLEAR_RIPPLE_FLOATS)]).toEqual([0, 0.5, 1, 1, 0.5, 0.25, 0, 0]);
    expect(out.includes(-1), 'every float written').toBe(false);
  });

  it('holds the share to nought and one and the strength to at least nought, and keeps the default for what is not a number', () => {
    expect(resolveClear({ mirrorNear: 3 }, 100).mirrorNear).toBe(1);
    expect(resolveClear({ mirrorNear: -1 }, 100).mirrorNear).toBe(0);
    expect(resolveClear({ mirror: -2 }, 100).mirror).toBe(0);
    expect(resolveClear({ mirror: 2.5 }, 100).mirror).toBe(2.5);
    expect(resolveClear({ mirrorNear: NaN, mirror: Infinity }, 100)).toMatchObject({ mirrorNear: 0, mirror: 1 });
  });
});

describe("clear water's scene in the mirror", () => {
  it('asks for nothing by default: off, the plane at nought, and the words in the mirror uniform the old nought', () => {
    const w = resolveClear(undefined, 100);
    expect([w.mirrorScene, w.mirrorPlane, w.mirrorDistort]).toEqual([false, 0, 0.03]);
    // off, the distortion is not packed either, so a water that does not ask is packed word for word as it was
    expect([...mirrorUniform(new Float32Array(CLEAR_MIRROR_FLOATS).fill(-1), w)]).toEqual([0, 0, 0, 0, 1, 0, 0, 0]);
    expect([...mirrorUniform(new Float32Array(CLEAR_MIRROR_FLOATS).fill(-1), resolveClear({ mirrorDistort: 0.5 }, 100))]).toEqual([0, 0, 0, 0, 1, 0, 0, 0]);
  });

  it('takes the plane and the distortion, and packs the distortion and a one for the scene where the shader reads them', () => {
    const w = resolveClear({ mirrorScene: true, mirrorPlane: -0.25, mirrorDistort: 0.08, mirrorTint: [0, 0.5, 1], mirror: 0.5 }, 100);
    expect([w.mirrorScene, w.mirrorPlane, w.mirrorDistort]).toEqual([true, -0.25, 0.08]);
    expect([...mirrorUniform(new Float32Array(CLEAR_MIRROR_FLOATS).fill(-1), w)]).toEqual([0, 0.5, 1, 1, 0.5, 0, Math.fround(0.08), 1]);
    const out = new Float32Array(CLEAR_FRAME_FLOATS).fill(-1);
    packClearFrame(out, new Float32Array(16), 100, 50, w, 98.1);
    const at = CLEAR_FRAME_FLOATS - CLEAR_FOAM_FLOATS - CLEAR_RIPPLE_FLOATS - CLEAR_MIRROR_FLOATS;
    expect([...out.subarray(at, at + CLEAR_MIRROR_FLOATS)]).toEqual([0, 0.5, 1, 1, 0.5, 0, Math.fround(0.08), 1]);
    expect(out.includes(-1), 'every float written').toBe(false);
  });

  it('holds the distortion to at least nought, and keeps the default for what is not a number', () => {
    expect(resolveClear({ mirrorDistort: -1 }, 100).mirrorDistort).toBe(0);
    expect(resolveClear({ mirrorDistort: 2 }, 100).mirrorDistort).toBe(2);
    expect(resolveClear({ mirrorDistort: NaN }, 100).mirrorDistort).toBe(0.03);
    expect(resolveClear({ mirrorDistort: Infinity }, 100).mirrorDistort).toBe(0.03);
    expect(resolveClear({ mirrorPlane: NaN }, 100).mirrorPlane).toBe(0);
    expect(resolveClear({ mirrorPlane: -Infinity }, 100).mirrorPlane).toBe(0);
    expect(resolveClear({ mirrorPlane: -3 }, 100).mirrorPlane).toBe(-3);
    // only a true is on: a truthy word is not
    expect(resolveClear({ mirrorScene: 1 as unknown as boolean }, 100).mirrorScene).toBe(false);
  });

  it('turns no default by the world\'s units: the plane is a height the game names and the distortion is a share of the screen', () => {
    for (const mmPerUnit of [1, 100, 1000]) {
      const w = resolveClear(undefined, mmPerUnit);
      expect([w.mirrorPlane, w.mirrorDistort]).toEqual([0, 0.03]);
    }
    // a plane a game names is in its own units and is taken as it is
    expect(resolveClear({ mirrorPlane: 2.5 }, 1).mirrorPlane).toBe(2.5);
    expect(resolveClear({ mirrorPlane: 2.5 }, 1000).mirrorPlane).toBe(2.5);
  });
});

describe("clear water's ripples", () => {
  it('add nothing by default: no colour, half at a full slope, nothing below three tenths', () => {
    const w = resolveClear(undefined, 100);
    expect([w.ripple, w.rippleAmount, w.rippleCut]).toEqual([null, 0.5, 0.3]);
    expect([...rippleUniform(new Float32Array(CLEAR_RIPPLE_FLOATS).fill(-1), w)]).toEqual([0, 0, 0, 0, 0.5, Math.fround(0.3), 0, 0]);
  });

  it('take a colour, an amount and a cut, and pack them last in the frame, where the shader reads them', () => {
    const w = resolveClear({ ripple: [0.25, 0.5, 1], rippleAmount: 0.75, rippleCut: 0.125 }, 100);
    expect([w.ripple, w.rippleAmount, w.rippleCut]).toEqual([[0.25, 0.5, 1], 0.75, 0.125]);
    expect(CLEAR_RIPPLE_FLOATS).toBe(8);
    const out = new Float32Array(CLEAR_FRAME_FLOATS).fill(-1);
    packClearFrame(out, new Float32Array(16), 100, 50, w, 98.1);
    expect([...out.subarray(CLEAR_FRAME_FLOATS - CLEAR_FOAM_FLOATS - CLEAR_RIPPLE_FLOATS, CLEAR_FRAME_FLOATS - CLEAR_FOAM_FLOATS)]).toEqual([0.25, 0.5, 1, 1, 0.75, 0.125, 0, 0]);
    expect(out.includes(-1), 'every float written').toBe(false);
  });

  it('hold the amount and the cut to nought and one, and keep the default for what is not a number', () => {
    expect(resolveClear({ rippleAmount: 3 }, 100).rippleAmount).toBe(1);
    expect(resolveClear({ rippleAmount: -1 }, 100).rippleAmount).toBe(0);
    expect(resolveClear({ rippleCut: 3 }, 100).rippleCut).toBe(1);
    expect(resolveClear({ rippleCut: -1 }, 100).rippleCut).toBe(0);
    expect(resolveClear({ rippleAmount: NaN, rippleCut: Infinity }, 100)).toMatchObject({ rippleAmount: 0.5, rippleCut: 0.3 });
  });
});

describe("clear water's foam", () => {
  it('is as it was by default: an edge of six hundredths of the width, and only the shore fields lines inside the field', () => {
    const w = resolveClear(undefined, 100);
    expect([w.foamSoft, w.foamEverywhere]).toEqual([0.06, false]);
    expect([...foamUniform(new Float32Array(CLEAR_FOAM_FLOATS).fill(-1), w)]).toEqual([Math.fround(0.06), 0, 0, 0]);
  });

  it('take a softness and a flag, and pack them last in the frame, after the ripples, where the shader reads them', () => {
    const w = resolveClear({ foamSoft: 0.01, foamEverywhere: true }, 100);
    expect([w.foamSoft, w.foamEverywhere]).toEqual([0.01, true]);
    expect(CLEAR_FOAM_FLOATS).toBe(4);
    const out = new Float32Array(CLEAR_FRAME_FLOATS).fill(-1);
    packClearFrame(out, new Float32Array(16), 100, 50, w, 98.1);
    expect([...out.subarray(CLEAR_FRAME_FLOATS - CLEAR_FOAM_FLOATS)]).toEqual([Math.fround(0.01), 1, 0, 0]);
    expect(out.includes(-1), 'every float written').toBe(false);
  });

  it('hold the softness to nought or more, and keep the default for what is not a number', () => {
    expect(resolveClear({ foamSoft: -1 }, 100).foamSoft).toBe(0);
    expect(resolveClear({ foamSoft: 0 }, 100).foamSoft).toBe(0);
    expect(resolveClear({ foamSoft: NaN }, 100).foamSoft).toBe(0.06);
    expect(resolveClear({ foamSoft: Infinity }, 100).foamSoft).toBe(0.06);
  });
});

describe("clear water's shallows", () => {
  it('lose light from the surface down and draw today\'s caustic line by default, packed into the foam\'s two free words as noughts', () => {
    const w = resolveClear(undefined, 100);
    expect([w.clearKnee, w.causticLine]).toEqual([0, 0.16]);
    // a water naming neither is packed word for word as it was before them: the line at its default is a nought, which
    // the shader reads as its own constant
    expect([...foamUniform(new Float32Array(CLEAR_FOAM_FLOATS).fill(-1), w)]).toEqual([Math.fround(0.06), 0, 0, 0]);
  });

  it('take a knee and a line, and pack them after the foam\'s edge and flag, where the shader reads them', () => {
    const w = resolveClear({ clearKnee: 0.4, causticLine: 0.08, foamSoft: 0.01, foamEverywhere: true }, 100);
    expect([w.clearKnee, w.causticLine]).toEqual([0.4, 0.08]);
    expect([...foamUniform(new Float32Array(CLEAR_FOAM_FLOATS).fill(-1), w)]).toEqual([Math.fround(0.01), 1, Math.fround(0.4), Math.fround(0.08)]);
    const out = new Float32Array(CLEAR_FRAME_FLOATS).fill(-1);
    packClearFrame(out, new Float32Array(16), 100, 50, w, 98.1);
    expect([...out.subarray(CLEAR_FRAME_FLOATS - CLEAR_FOAM_FLOATS)]).toEqual([Math.fround(0.01), 1, Math.fround(0.4), Math.fround(0.08)]);
    expect(out.includes(-1), 'every float written').toBe(false);
    // and no struct grew for them
    expect(CLEAR_FOAM_FLOATS).toBe(4);
  });

  it('refuse what is not a number, and hold the knee to nought or more and the line to a width that can be drawn', () => {
    expect(resolveClear({ clearKnee: NaN, causticLine: NaN }, 100)).toMatchObject({ clearKnee: 0, causticLine: 0.16 });
    expect(resolveClear({ clearKnee: Infinity, causticLine: -Infinity }, 100)).toMatchObject({ clearKnee: 0, causticLine: 0.16 });
    expect(resolveClear({ clearKnee: -1 }, 100).clearKnee).toBe(0);
    // a line of no width is a smoothstep from nought to nought, which WGSL leaves undefined
    expect(resolveClear({ causticLine: 0 }, 100).causticLine).toBeGreaterThan(0);
    expect(resolveClear({ causticLine: -2 }, 100).causticLine).toBeGreaterThan(0);
  });

  it('turn the knee\'s millimetre default into the world\'s own units, and not the line, which is a share of a cell', () => {
    // the default knee is nought, which no unit turns; one of half a metre is put in its place for the length of this test
    const was = CLEAR_DEFAULTS_MM.clearKnee;
    CLEAR_DEFAULTS_MM.clearKnee = 500;
    try {
      expect(resolveClear(undefined, 100).clearKnee).toBeCloseTo(5, 10);
      expect(resolveClear(undefined, 1).clearKnee).toBe(500);
      expect(resolveClear(undefined, 1000).clearKnee).toBeCloseTo(0.5, 10);
    } finally {
      CLEAR_DEFAULTS_MM.clearKnee = was;
    }
    for (const mmPerUnit of [1, 100, 1000]) expect(resolveClear(undefined, mmPerUnit).causticLine).toBe(0.16);
    // a knee a game names is in its own units and is taken as it is
    expect(resolveClear({ clearKnee: 0.25 }, 1).clearKnee).toBe(0.25);
    expect(resolveClear({ clearKnee: 0.25 }, 1000).clearKnee).toBe(0.25);
  });

  it('pack a line named at its default as the nought it was, so it draws as before to the pixel', () => {
    expect([...foamUniform(new Float32Array(CLEAR_FOAM_FLOATS).fill(-1), resolveClear({ causticLine: 0.16 }, 100))]).toEqual([Math.fround(0.06), 0, 0, 0]);
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
