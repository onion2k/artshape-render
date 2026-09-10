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

  it('has a hard shadow of its own, and none of the still-life machinery', () => {
    // The still-life shader spends 4.7 ms a megapixel filtering one soft
    // shadow over thirty-six taps, with a blocker search first. This one
    // reads four hardware-compared taps and is sharp: it asserted for a
    // long time that it had no shadow at all, and now it asserts that what
    // it has is the cheap kind.
    const src = sceneSource();
    expect(src).toContain('textureSampleCompareLevel');
    for (const word of ['shadowTaps', 'blocker', 'discShadow', 'textureSampleCompare(']) {
      expect(src).not.toContain(word);
    }
  });

  it('folds the shadow lookups to a constant when the ladder gives them up', () => {
    expect(sceneSource({ shadows: false })).toContain('const SHADOWS: bool = false;');
    expect(sceneSource()).toContain('const SHADOWS: bool = true;');
  });
});
