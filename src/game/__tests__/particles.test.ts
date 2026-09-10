import { describe, expect, it } from 'vitest';
import { EMITTER_STRIDE, PARTICLE_STRIDE } from '../particles';

describe('the particle layouts', () => {
  it('pack a particle into four vec4s and an emitter into six', () => {
    expect(PARTICLE_STRIDE).toBe(16);
    expect(EMITTER_STRIDE).toBe(24);
  });
});
