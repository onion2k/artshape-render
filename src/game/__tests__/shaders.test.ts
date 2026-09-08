import { describe, expect, it } from 'vitest';
import { sceneSource } from '../shaders';

describe('the scene shader is a permutation of itself', () => {
  it('puts what the ladder gives up in constants, not uniforms', () => {
    // A branch the compiler cannot fold leaves the code resident, and
    // residency is most of what a shader costs here: gating the still-life
    // renderer's table reflection behind a uniform saved nothing at all,
    // where compiling it out saved five milliseconds a megapixel. So these
    // must be `const`, and a test says so because the next person to add a
    // rung will reach for a uniform first.
    const on = sceneSource({ cullLights: true, points: true });
    expect(on).toContain('const CULL_BY_RADIUS: bool = true;');
    expect(on).toContain('const POINT_LIGHTS: bool = true;');
    const off = sceneSource({ cullLights: false, points: false });
    expect(off).toContain('const CULL_BY_RADIUS: bool = false;');
    expect(off).toContain('const POINT_LIGHTS: bool = false;');
  });

  it('defaults to the whole thing', () => {
    expect(sceneSource()).toContain('const CULL_BY_RADIUS: bool = true;');
    expect(sceneSource()).toContain('const POINT_LIGHTS: bool = true;');
  });

  it('differs only in the prelude, so the permutations cannot drift apart', () => {
    const body = (s: string) => s.slice(s.indexOf('struct Frame'));
    expect(body(sceneSource({ cullLights: false }))).toBe(body(sceneSource({ cullLights: true })));
    expect(body(sceneSource({ points: false }))).toBe(body(sceneSource({ points: true })));
  });

  it('has no shadow machinery in it at all', () => {
    // The still-life shader spends 4.7 ms a megapixel filtering one soft
    // shadow over thirty-six taps. A game that wants a shadow casts it
    // itself; nothing here should quietly acquire one.
    const src = sceneSource();
    for (const word of ['shadowTaps', 'blocker', 'textureSampleCompare', 'discShadow']) {
      expect(src).not.toContain(word);
    }
  });
});
