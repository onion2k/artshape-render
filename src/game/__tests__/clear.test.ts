import { describe, expect, it } from 'vitest';
import { CLEAR_DEFAULTS_MM, CLEAR_FRAGMENT, CLEAR_FINISH_FLOATS, WAVE_FADE_FROM, CLEAR_FOAM_FLOATS, CLEAR_DRIFT_FLOATS, CLEAR_FRAME_FLOATS, CLEAR_MIRROR_FLOATS, CLEAR_RIPPLE_FLOATS, CLEAR_STRIDE, clearUniform, finishUniform, mirrorUniform, foamUniform, packClearFrame, resolveClear, rippleUniform, driftUniform, extraUniform, CLEAR_EXTRA_FLOATS, CLEAR_RINGS_FLOATS, RING_SLOTS, packRings, ringsUniform } from '../clear';

/** Where the splash rings are in the frame: last of all. */
const RINGS_AT = CLEAR_FRAME_FLOATS - CLEAR_RINGS_FLOATS;
/** Where round two's options are: just before the rings. */
const EXTRA_AT = RINGS_AT - CLEAR_EXTRA_FLOATS;
/** Where the sparkles' drift is in the frame: round two's options come after it, so it is counted back from them. */
const DRIFT_AT = EXTRA_AT - CLEAR_DRIFT_FLOATS;
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
    expect(CLEAR_FRAME_FLOATS).toBe(16 + 4 + CLEAR_STRIDE + WAVE_FLOATS + CLEAR_FINISH_FLOATS + SHORE_FIELD_FLOATS + CLEAR_MIRROR_FLOATS + CLEAR_RIPPLE_FLOATS + CLEAR_FOAM_FLOATS + CLEAR_DRIFT_FLOATS + CLEAR_EXTRA_FLOATS + CLEAR_RINGS_FLOATS);
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
    expect([...out.subarray(DRIFT_AT - CLEAR_FOAM_FLOATS - CLEAR_RIPPLE_FLOATS - CLEAR_MIRROR_FLOATS, DRIFT_AT - CLEAR_FOAM_FLOATS - CLEAR_RIPPLE_FLOATS)]).toEqual([0, 0.5, 1, 1, 0.5, 0.25, 0, 0]);
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
    const at = DRIFT_AT - CLEAR_FOAM_FLOATS - CLEAR_RIPPLE_FLOATS - CLEAR_MIRROR_FLOATS;
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
    expect([...out.subarray(DRIFT_AT - CLEAR_FOAM_FLOATS - CLEAR_RIPPLE_FLOATS, DRIFT_AT - CLEAR_FOAM_FLOATS)]).toEqual([0.25, 0.5, 1, 1, 0.75, 0.125, 0, 0]);
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
    expect([...out.subarray(DRIFT_AT - CLEAR_FOAM_FLOATS, DRIFT_AT)]).toEqual([Math.fround(0.01), 1, 0, 0]);
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
    expect([...out.subarray(DRIFT_AT - CLEAR_FOAM_FLOATS, DRIFT_AT)]).toEqual([Math.fround(0.01), 1, Math.fround(0.4), Math.fround(0.08)]);
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

describe("clear water's detail layer", () => {
  it('is none by default: no cell, a first guess of one for the amount, and the ripples\' two spare words packed as the noughts they were', () => {
    const w = resolveClear(undefined, 100);
    expect([w.detailPixels, w.detailAmount]).toEqual([0, 1]);
    expect([...rippleUniform(new Float32Array(CLEAR_RIPPLE_FLOATS).fill(-1), w)]).toEqual([0, 0, 0, 0, 0.5, Math.fround(0.3), 0, 0]);
  });

  it('takes a cell in pixels and an amount, and packs them into the ripples\' spare words, where the shader reads them, growing nothing', () => {
    const w = resolveClear({ detailPixels: 8, detailAmount: 0.75, ripple: [0.25, 0.5, 1], rippleAmount: 0.75, rippleCut: 0.125 }, 100);
    expect([w.detailPixels, w.detailAmount]).toEqual([8, 0.75]);
    const out = new Float32Array(CLEAR_FRAME_FLOATS).fill(-1);
    packClearFrame(out, new Float32Array(16), 100, 50, w, 98.1);
    expect([...out.subarray(DRIFT_AT - CLEAR_FOAM_FLOATS - CLEAR_RIPPLE_FLOATS, DRIFT_AT - CLEAR_FOAM_FLOATS)]).toEqual([0.25, 0.5, 1, 1, 0.75, 0.125, 8, 0.75]);
    expect(out.includes(-1), 'every float written').toBe(false);
    // no struct grew for it: the frame was the hundred and four floats it was at 0.40.0, before the sparkles' drift
    expect([CLEAR_RIPPLE_FLOATS, DRIFT_AT]).toEqual([8, 104]);
  });

  it('is packed only when asked: a cell of nought, or an amount of nought, writes the noughts a water naming neither does', () => {
    const spare = (named: Parameters<typeof resolveClear>[0]) => [...rippleUniform(new Float32Array(CLEAR_RIPPLE_FLOATS).fill(-1), resolveClear(named, 100))].slice(6);
    expect(spare({ detailAmount: 0.5 }), 'an amount with no cell').toEqual([0, 0]);
    expect(spare({ detailPixels: 0, detailAmount: 0.5 })).toEqual([0, 0]);
    expect(spare({ detailPixels: 8, detailAmount: 0 }), 'a cell with no amount').toEqual([0, 0]);
    expect(spare({ detailPixels: 8 }), 'a cell at the default amount').toEqual([8, 1]);
  });

  it('refuses what is not a number, holds the amount to nought or more and a cell to a pixel at the least, and a negative cell is none', () => {
    expect(resolveClear({ detailPixels: NaN, detailAmount: NaN }, 100)).toMatchObject({ detailPixels: 0, detailAmount: 1 });
    expect(resolveClear({ detailPixels: Infinity, detailAmount: -Infinity }, 100)).toMatchObject({ detailPixels: 0, detailAmount: 1 });
    expect(resolveClear({ detailPixels: -4 }, 100).detailPixels).toBe(0);
    // a cell under a pixel would be read finer than the screen can show, and alias: it is held at one
    expect(resolveClear({ detailPixels: 0.25 }, 100).detailPixels).toBe(1);
    expect(resolveClear({ detailAmount: -1 }, 100).detailAmount).toBe(0);
    expect(resolveClear({ detailAmount: 2 }, 100).detailAmount).toBe(2);
  });

  it('turns nothing by the world\'s units: a cell is pixels on the screen and the amount a share of the steepness', () => {
    // the default cell is nought, which no unit turns; one of eight is put in its place for the length of this test
    const was = CLEAR_DEFAULTS_MM.detailPixels;
    CLEAR_DEFAULTS_MM.detailPixels = 8;
    try {
      for (const mmPerUnit of [1, 100, 1000]) expect(resolveClear(undefined, mmPerUnit)).toMatchObject({ detailPixels: 8, detailAmount: 1 });
    } finally {
      CLEAR_DEFAULTS_MM.detailPixels = was;
    }
    for (const mmPerUnit of [1, 100, 1000]) expect(resolveClear({ detailPixels: 8, detailAmount: 0.6 }, mmPerUnit)).toMatchObject({ detailPixels: 8, detailAmount: 0.6 });
  });

  it('moves the fine waves\' own fade down from where flow.ts begins it, which is said in both and held equal here', async () => {
    const { FLOW_WGSL } = await import('../flow');
    expect(FLOW_WGSL).toContain(`smoothstep(${WAVE_FADE_FROM}, 0.7, pixel * k)`);
    expect(CLEAR_FRAGMENT).toContain(`const DETAIL_FADE: f32 = ${WAVE_FADE_FROM / (2 * Math.PI)};`);
  });
});

describe("clear water's sparkles' drift", () => {
  it('is nought by default, so the lattice is pinned where it was, packed as noughts last in the frame', () => {
    const w = resolveClear(undefined, 100);
    expect(w.sparkleDrift).toEqual([0, 0]);
    expect([...driftUniform(new Float32Array(CLEAR_DRIFT_FLOATS).fill(-1), w)]).toEqual([0, 0, 0, 0]);
    // a vec4 of its own, after the foam's options, so no earlier offset moved: the frame was a hundred and eight floats
    // before round two's options came after it
    expect([CLEAR_DRIFT_FLOATS, DRIFT_AT + CLEAR_DRIFT_FLOATS]).toEqual([4, 108]);
  });

  it('takes a velocity in the world\'s own units a second, and packs it where the shader reads it, its two spare words nought', () => {
    const w = resolveClear({ sparkleDrift: [0.25, -0.5] }, 100);
    expect(w.sparkleDrift).toEqual([0.25, -0.5]);
    const out = new Float32Array(CLEAR_FRAME_FLOATS).fill(-1);
    packClearFrame(out, new Float32Array(16), 100, 50, w, 98.1);
    expect([...out.subarray(DRIFT_AT, DRIFT_AT + CLEAR_DRIFT_FLOATS)]).toEqual([0.25, -0.5, 0, 0]);
    expect(out.includes(-1), 'every float written').toBe(false);
  });

  it('refuses what is not a pair of numbers, and keeps the default', () => {
    expect(resolveClear({ sparkleDrift: [NaN, 1] }, 100).sparkleDrift).toEqual([0, 0]);
    expect(resolveClear({ sparkleDrift: [1, Infinity] }, 100).sparkleDrift).toEqual([0, 0]);
    expect(resolveClear({ sparkleDrift: [1] as unknown as [number, number] }, 100).sparkleDrift).toEqual([0, 0]);
    expect(resolveClear({ sparkleDrift: 1 as unknown as [number, number] }, 100).sparkleDrift).toEqual([0, 0]);
    // a copy, so a look's own array is not what the frame reads
    const named: [number, number] = [1, 2];
    expect(resolveClear({ sparkleDrift: named }, 100).sparkleDrift).not.toBe(named);
  });

  it('turns nothing by the world\'s units: a named drift is already in them, and the default is nought', () => {
    for (const mmPerUnit of [1, 100, 1000]) {
      expect(resolveClear(undefined, mmPerUnit).sparkleDrift).toEqual([0, 0]);
      expect(resolveClear({ sparkleDrift: [0.5, 0.25] }, mmPerUnit).sparkleDrift).toEqual([0.5, 0.25]);
    }
  });
});

describe("clear water's round two options: the sun's lane, the caustics' glow and the foam's grain", () => {
  const NAMED = { sunLane: 0.6, sunLaneWidth: 60, causticGlow: 0.3, foamGrain: 0.3 };

  it('are nought by default, so a water that names none is packed as noughts and drawn as v0.42.0 drew it', () => {
    const w = resolveClear(undefined, 100);
    expect([w.sunLane, w.sunLaneWidth, w.causticGlow, w.foamGrain]).toEqual([0, 0, 0, 0]);
    expect([...extraUniform(new Float32Array(CLEAR_EXTRA_FLOATS).fill(-1), w)]).toEqual([0, 0, 0, 0]);
  });

  it('are one vec4 after the drift, which makes the frame a hundred and twelve floats and moves no earlier offset', () => {
    expect(CLEAR_EXTRA_FLOATS).toBe(4);
    expect(EXTRA_AT).toBe(108);
    expect(DRIFT_AT).toBe(104);
    const out = new Float32Array(CLEAR_FRAME_FLOATS).fill(-1);
    packClearFrame(out, new Float32Array(16), 100, 50, resolveClear(NAMED, 100), 98.1);
    expect([...out.subarray(EXTRA_AT, RINGS_AT)]).toEqual([Math.fround(0.6), 60, Math.fround(0.3), Math.fround(0.3)]);
    // the drift before it is as it was, and nothing was left unwritten
    expect([...out.subarray(DRIFT_AT, DRIFT_AT + CLEAR_DRIFT_FLOATS)]).toEqual([0, 0, 0, 0]);
    expect(out.includes(-1), 'every float written').toBe(false);
  });

  it('packs a lane as nought unless it has a width and a strength both, since a power of nought is one everywhere', () => {
    const packed = (named: Parameters<typeof resolveClear>[0]) => [...extraUniform(new Float32Array(CLEAR_EXTRA_FLOATS), resolveClear(named, 100))];
    expect(packed({ sunLane: 0.6 }).slice(0, 2), 'a strength with no width').toEqual([0, 0]);
    expect(packed({ sunLaneWidth: 60 }).slice(0, 2), 'a width with no strength').toEqual([0, 0]);
    expect(packed({ sunLane: 0.6, sunLaneWidth: 60 }).slice(0, 2)).toEqual([Math.fround(0.6), 60]);
    // the other two do not wait on it
    expect(packed({ causticGlow: 0.5, foamGrain: 0.25 })).toEqual([0, 0, 0.5, 0.25]);
  });

  it('holds the strengths to nought and one and the width to at least nought', () => {
    const w = resolveClear({ sunLane: 3, causticGlow: 9, foamGrain: 2, sunLaneWidth: 500 }, 100);
    expect([w.sunLane, w.causticGlow, w.foamGrain, w.sunLaneWidth]).toEqual([1, 1, 1, 500]);
    const l = resolveClear({ sunLane: -1, causticGlow: -0.5, foamGrain: -3, sunLaneWidth: -60 }, 100);
    expect([l.sunLane, l.causticGlow, l.foamGrain, l.sunLaneWidth]).toEqual([0, 0, 0, 0]);
  });

  it('keeps the default for what is not a number, and names nothing it does not know', () => {
    for (const bad of [NaN, Infinity, -Infinity, '0.5' as unknown as number, null as unknown as number, {} as unknown as number]) {
      const w = resolveClear({ sunLane: bad, sunLaneWidth: bad, causticGlow: bad, foamGrain: bad }, 100);
      expect([w.sunLane, w.sunLaneWidth, w.causticGlow, w.foamGrain], `${String(bad)}`).toEqual([0, 0, 0, 0]);
    }
    // a bad one among good ones spoils only itself
    const w = resolveClear({ sunLane: NaN, sunLaneWidth: 60, causticGlow: 0.5, foamGrain: Infinity }, 100);
    expect([w.sunLane, w.sunLaneWidth, w.causticGlow, w.foamGrain]).toEqual([0, 60, 0.5, 0]);
  });

  it('turns nothing by the world\'s units: a power and two shares are not lengths', () => {
    for (const mmPerUnit of [1, 100, 1000]) {
      expect(resolveClear(undefined, mmPerUnit).sunLane).toBe(0);
      const w = resolveClear(NAMED, mmPerUnit);
      expect([w.sunLane, w.sunLaneWidth, w.causticGlow, w.foamGrain]).toEqual([0.6, 60, 0.3, 0.3]);
    }
  });

  it('are read in the shader from a vec4 that follows the drift in the frame\'s struct', () => {
    expect(CLEAR_FRAGMENT).toMatch(/drift: vec4f,\s*(\/\/[^\n]*\n\s*)*extra: vec4f,/);
  });
});

describe("clear water's splash rings", () => {
  /** A ring in the four floats a game hands over: where it landed, how long ago in seconds, and how big. */
  const ring = (x: number, y: number, age: number, size: number) => [x, y, age, size];
  const NAMED = { ringStrength: 2.5, ringWavelength: 0.5, ringSpeed: 3, ringTrain: 0.5, ringGrowth: 0.6, ringLife: 3.5, ringPixels: 6 };

  it('are none by default: no strength, so a water that hands rings over draws as v0.43.0 drew it', () => {
    const w = resolveClear(undefined, 100);
    expect(w.ringStrength).toBe(0);
    const out = new Float32Array(CLEAR_RINGS_FLOATS).fill(-1);
    const rings = new Float32Array(ring(1, 2, 0.5, 1));
    ringsUniform(out, w, rings, 1);
    // no strength, so no count: the pass reads a count of nought and does nothing
    expect(out[0], 'the count').toBe(0);
    expect(out[1], 'the strength').toBe(0);
    expect(out.includes(-1), 'every float written').toBe(false);
  });

  it('are a vec4 of their shape, another of their motion and twelve of rings, after round two, moving no earlier offset', () => {
    expect(RING_SLOTS).toBe(12);
    expect(CLEAR_RINGS_FLOATS).toBe(8 + 12 * 4);
    expect(CLEAR_FRAME_FLOATS).toBe(112 + CLEAR_RINGS_FLOATS);
    expect(RINGS_AT).toBe(112);
    const out = new Float32Array(CLEAR_FRAME_FLOATS).fill(-1);
    const rings = new Float32Array([...ring(1, 2, 0.25, 1), ...ring(-3, 4, 1.5, 0.6)]);
    packClearFrame(out, new Float32Array(16), 100, 50, resolveClear(NAMED, 100), 98.1, null, rings, 2);
    const at = out.subarray(RINGS_AT);
    // the count, the strength, the wavelength and the least pixels; then the speed, the train, its growth and the life
    expect([...at.subarray(0, 8)]).toEqual([2, 2.5, 0.5, 6, 3, 0.5, Math.fround(0.6), 3.5]);
    expect([...at.subarray(8, 16)]).toEqual([1, 2, 0.25, 1, -3, 4, 1.5, Math.fround(0.6)]);
    expect([...at.subarray(16)].every((v) => v === 0), 'the slots not used are nought').toBe(true);
    expect(out.includes(-1), 'every float written').toBe(false);
  });

  it('take no more than the twelve slots, and say how many they took', () => {
    const many = new Float32Array(20 * 4);
    for (let i = 0; i < 20; i++) many.set(ring(i, 0, 0.1, 1), i * 4);
    const store = new Float32Array(RING_SLOTS * 4);
    expect(packRings(store, many, 20)).toBe(12);
    expect(store[11 * 4], 'the twelfth kept').toBe(11);
    // a count past the data is the data's
    expect(packRings(store, many, 99)).toBe(12);
    expect(packRings(store, many.subarray(0, 8), 2), 'two handed, two taken').toBe(2);
    expect(packRings(store, many, 0)).toBe(0);
    expect(packRings(store, many, -3)).toBe(0);
  });

  it('refuse a ring that is not numbers or has no size, keeping the others in order, and clear what is left', () => {
    const data = new Float32Array([
      ...ring(1, 1, 0.1, 1),
      ...ring(NaN, 1, 0.1, 1),
      ...ring(2, Infinity, 0.1, 1),
      ...ring(3, 3, NaN, 1),
      ...ring(4, 4, 0.1, 0),
      ...ring(5, 5, 0.1, -1),
      ...ring(6, 6, 0.2, 0.5),
    ]);
    const store = new Float32Array(RING_SLOTS * 4).fill(7);
    expect(packRings(store, data, 7)).toBe(2);
    expect([...store.subarray(0, 8)]).toEqual([1, 1, Math.fround(0.1), 1, 6, 6, Math.fround(0.2), 0.5]);
    expect([...store.subarray(8)].every((v) => v === 0), 'the rest cleared').toBe(true);
  });

  it('turn their lengths and speeds from millimetres into the world\'s units, and not the life, the strength or the pixels', () => {
    const d = resolveClear(undefined, 100);
    expect(d.ringWavelength).toBeCloseTo(CLEAR_DEFAULTS_MM.ringWavelength / 100, 10);
    expect(d.ringSpeed).toBeCloseTo(CLEAR_DEFAULTS_MM.ringSpeed / 100, 10);
    expect(d.ringTrain).toBeCloseTo(CLEAR_DEFAULTS_MM.ringTrain / 100, 10);
    expect(d.ringGrowth).toBeCloseTo(CLEAR_DEFAULTS_MM.ringGrowth / 100, 10);
    for (const mmPerUnit of [1, 100, 1000]) {
      const w = resolveClear(undefined, mmPerUnit);
      expect([w.ringStrength, w.ringLife, w.ringPixels]).toEqual([CLEAR_DEFAULTS_MM.ringStrength, CLEAR_DEFAULTS_MM.ringLife, CLEAR_DEFAULTS_MM.ringPixels]);
      // what a game names is already in its units
      expect(resolveClear(NAMED, mmPerUnit).ringWavelength).toBe(0.5);
    }
    // a pebble's at a hundred millimetres a unit: half a unit across, out at three units a second, gone by three and a half
    expect([d.ringWavelength, d.ringSpeed, d.ringLife]).toEqual([0.5, 3, 3.5]);
  });

  it('hold what cannot be drawn: a strength and a growth at nought or more, a wavelength, speed, train and life over nought', () => {
    const w = resolveClear({ ringStrength: -1, ringWavelength: 0, ringSpeed: -2, ringTrain: 0, ringGrowth: -1, ringLife: 0, ringPixels: -4 }, 100);
    expect(w.ringStrength).toBe(0);
    expect(w.ringGrowth).toBe(0);
    expect(w.ringPixels).toBe(0);
    for (const k of ['ringWavelength', 'ringSpeed', 'ringTrain', 'ringLife'] as const) expect(w[k], k).toBeGreaterThan(0);
  });

  it('keep the default for what is not a number', () => {
    const d = resolveClear(undefined, 100);
    for (const bad of [NaN, Infinity, '1' as unknown as number, null as unknown as number]) {
      const w = resolveClear({ ringStrength: bad, ringWavelength: bad, ringLife: bad }, 100);
      expect([w.ringStrength, w.ringWavelength, w.ringLife], String(bad)).toEqual([d.ringStrength, d.ringWavelength, d.ringLife]);
    }
  });

  it('are read in the shader from the frame\'s last fields, after round two\'s', () => {
    expect(CLEAR_FRAGMENT).toMatch(/extra: vec4f,\s*(\/\/[^\n]*\n\s*)*ringShape: vec4f,\s*(\/\/[^\n]*\n\s*)*ringMotion: vec4f,\s*(\/\/[^\n]*\n\s*)*rings: array<vec4f, 12>,\s*\};/);
  });
});

describe("clear water's shader", () => {
  it('is its own text: not a word of it in any build of the scene shader, and the waves and the scene head in it', async () => {
    const { clearSource, sceneSource } = await import('../shaders');
    const text = clearSource();
    for (const word of ['ClearFrame', 'opaqueDepth', 'clearWorld', 'FOAM_CORE', 'CAUSTIC_LINE', 'clearDetail', 'clearFootprint', 'DETAIL_FADE'])
      for (const toon of [false, true])
        for (const flowing of [false, true])
          for (const shadows of [false, true]) expect(sceneSource({ toon, flowing, shadows }), `${word} in a scene build`).not.toContain(word);
    expect(text).toContain('fn waterSlope');
    expect(text).toContain('struct Frame');
    expect(text).toContain('@group(1) @binding(0) var opaque');
    expect(clearSource(false)).toContain('const SHADOWS: bool = false;');
  });
});
