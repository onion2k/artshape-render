import { describe, expect, it } from 'vitest';
import { FLOW_CRUST, FLOW_DRIFT, FLOW_RIPPLE, isFlowKind, packFlow, usesFlow } from '../flow';
import { PATTERN_STRIDE } from '../renderer';

describe('a flowing placement\'s eight floats', () => {
  it('are kind, scale, speed and glow, then the second colour and a spare, in the stride the vertex layout reads', () => {
    expect(PATTERN_STRIDE).toBe(8);
    const out = new Float32Array(16).fill(-1);
    packFlow(out, PATTERN_STRIDE, { kind: FLOW_CRUST, scale: 0.5, speed: 3, glow: 2, second: [1, 0.25, 0.125] });
    expect([...out.subarray(0, 8)]).toEqual([-1, -1, -1, -1, -1, -1, -1, -1]);
    expect([...out.subarray(8, 16)]).toEqual([6, 0.5, 3, 2, 1, 0.25, 0.125, 0]);
  });

  it('give a glow of nought when none is named', () => {
    const out = packFlow(new Float32Array(8), 0, { kind: FLOW_RIPPLE, scale: 1, speed: 1, second: [1, 1, 1] });
    expect(out[3]).toBe(0);
  });

  it('name the three kinds five, six and seven', () => {
    expect([FLOW_RIPPLE, FLOW_CRUST, FLOW_DRIFT]).toEqual([5, 6, 7]);
    for (const k of [0, 1, 2, 3, 4]) expect(isFlowKind(k)).toBe(false);
    for (const k of [5, 6, 7, 9]) expect(isFlowKind(k)).toBe(true);
  });

  it('are what says a group is flowing: any placement of kind five or more, and none of the old kinds', () => {
    const p = new Float32Array(PATTERN_STRIDE * 3);
    expect(usesFlow(undefined, PATTERN_STRIDE)).toBe(false);
    expect(usesFlow(p, PATTERN_STRIDE)).toBe(false);
    p[0] = 4; p[PATTERN_STRIDE] = 1;
    expect(usesFlow(p, PATTERN_STRIDE)).toBe(false);
    p[PATTERN_STRIDE * 2] = 5;
    expect(usesFlow(p, PATTERN_STRIDE)).toBe(true);
  });
});
