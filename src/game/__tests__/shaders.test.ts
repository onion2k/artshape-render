import { describe, expect, it } from 'vitest';
import { BLUR_WGSL, BRIGHT_WGSL, COMPOSITE_WGSL, DEPTH_WGSL, EFFECT_WGSL, FOG_BLEND_WGSL, FOG_WGSL, sceneSource } from '../shaders';
import { DRAW_WGSL } from '../particles';

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

  it('builds the patterns in only where a group has them, by a constant and not a branch on a uniform', () => {
    // a pattern is per placement, so its kind is read from the placement; but whether the pattern code is there at
    // all is the permutation's, so a group with none draws through a shader with none, and pays nothing for it
    expect(sceneSource()).toContain('const PATTERNED: bool = false;');
    expect(sceneSource({ patterned: true })).toContain('const PATTERNED: bool = true;');
    const body = (s: string) => s.slice(s.indexOf('struct Frame'));
    expect(body(sceneSource({ patterned: true }))).toBe(body(sceneSource()));
  });

  it('folds the shadow lookups to a constant when the ladder gives them up', () => {
    expect(sceneSource({ shadows: false })).toContain('const SHADOWS: bool = false;');
    expect(sceneSource()).toContain('const SHADOWS: bool = true;');
  });
});

describe('the frame is half floats, and every stage is held to what they have', () => {
  // `overflow.gpu.test.ts` says why, and proves it on a device. This says
  // only that nobody has added a stage and forgotten: a stage that writes
  // colour to the frame writes it through `finite`, and one that reads the
  // frame reads it through `finite`.
  const writes = { scene: sceneSource(), effects: EFFECT_WGSL, particles: DRAW_WGSL, fog: FOG_WGSL };
  const reads = { bright: BRIGHT_WGSL, composite: COMPOSITE_WGSL };

  for (const [name, src] of Object.entries(writes)) {
    it(`holds what the ${name} write`, () => {
      const returns = [...src.matchAll(/return vec4f\(([^;]*);/g)].map((m) => m[1]);
      // the fragment stage's returns: the ones that carry a colour, which the vertex stages' do not
      const colours = returns.filter((r) => !r.startsWith('p ') && !r.includes('viewProj') && !r.includes('position'));
      expect(colours.length).toBeGreaterThan(0);
      for (const r of colours) expect(r, `${name}: ${r}`).toMatch(/^finite\(|^c, a\)$/);
      expect(src).toContain('fn finite(');
    });
  }

  it('holds the effects colour before it is returned beside its alpha', () => {
    expect(EFFECT_WGSL).toContain('let c = finite(');
  });

  for (const [name, src] of Object.entries(reads)) {
    it(`holds what the ${name} pass reads of the frame`, () => {
      const reads = [...src.matchAll(/(\w*\(?)texture(?:Sample|Load)\((src|bloom)\b/g)];
      expect(reads.length).toBeGreaterThan(0);
      for (const m of reads) expect(m[1], `${name}: a read of ${m[2]} not through finite`).toBe('finite(');
    });
  }

  it('has no smoothstep with its edges the wrong way round, which is whatever the compiler makes of it', () => {
    const all = { ...writes, ...reads, blur: BLUR_WGSL, depth: DEPTH_WGSL, fogBlend: FOG_BLEND_WGSL };
    for (const [name, src] of Object.entries(all)) {
      for (const m of src.matchAll(/smoothstep\(\s*(-?[0-9.]+)\s*,\s*(-?[0-9.]+)\s*,/g)) {
        expect(+m[1], `${name}: ${m[0]}`).toBeLessThan(+m[2]);
      }
    }
  });
});

