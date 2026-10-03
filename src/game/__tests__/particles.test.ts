import { describe, expect, it } from 'vitest';
import { EMITTER_STRIDE, PARTICLE_STRIDE } from '../particles';

describe('the particle layouts', () => {
  it('pack a particle into five vec4s and an emitter into six', () => {
    // the fifth is the colour it fades to and whether it does; the emitter's was a spare
    expect(PARTICLE_STRIDE).toBe(20);
    expect(EMITTER_STRIDE).toBe(24);
  });
});
