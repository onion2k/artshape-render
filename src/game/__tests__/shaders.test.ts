import { describe, expect, it } from 'vitest';
import { BLUR_WGSL, BRIGHT_WGSL, COMPOSITE_WGSL, DEPTH_WGSL, EFFECT_WGSL, FOG_BLEND_WGSL, FOG_MSAA_WGSL, FOG_WGSL, FXAA_WGSL, sceneSource, sceneWith } from '../shaders';
import { DRAW_WGSL, SPRITE_WGSL } from '../particles';

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

  it('builds toon shading in as a constant of its own permutation, the body the same either way', () => {
    expect(sceneSource()).toContain('const TOON: bool = false;');
    expect(sceneSource({ toon: true })).toContain('const TOON: bool = true;');
    const body = (s: string) => s.slice(s.indexOf('struct Frame'));
    expect(body(sceneSource({ toon: true }))).toBe(body(sceneSource()));
  });

  it('lights another vertex stage with the same fragment stage, so a blade and a box are shaded alike', () => {
    // a thing built in its own vertex stage is lit by the group's fragment stage, not a copy of it that could drift
    const other = '@vertex fn vsMain(@builtin(vertex_index) v: u32) -> VsOut { var out: VsOut; return out; }\n';
    const tail = (s: string) => s.slice(s.indexOf('fn cellHash'));
    for (const toon of [false, true]) {
      const built = sceneWith(other, { toon });
      expect(built).toContain(other);
      expect(built).not.toContain('@location(4) m0: vec4f');
      expect(tail(built)).toBe(tail(sceneSource({ toon })));
    }
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
  const writes = { scene: sceneSource(), toon: sceneSource({ toon: true }), effects: EFFECT_WGSL, particles: DRAW_WGSL, sprites: SPRITE_WGSL, fog: FOG_WGSL, fogMsaa: FOG_MSAA_WGSL };
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
    const all = { ...writes, ...reads, blur: BLUR_WGSL, depth: DEPTH_WGSL, fogBlend: FOG_BLEND_WGSL, fxaa: FXAA_WGSL };
    for (const [name, src] of Object.entries(all)) {
      for (const m of src.matchAll(/smoothstep\(\s*(-?[0-9.]+)\s*,\s*(-?[0-9.]+)\s*,/g)) {
        expect(+m[1], `${name}: ${m[0]}`).toBeLessThan(+m[2]);
      }
    }
  });
});


/** FNV-1a over a text's UTF-16 units, in eight hex digits: enough to say a text is the one it was. */
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

describe('the flowing build of the scene shader', () => {
  const body = (s: string) => s.slice(s.indexOf('struct Frame'));
  // the words that only the flow code has: not one may be in any other build
  const FLOW_WORDS = ['flowSurface', 'flowFbm', 'flowVoro', 'flowHash', 'FLOWING', 'frame.spare0', 'in.tx', 'in.ty', 'waterSlope', 'waterWave', 'WATER_RF0', 'WATER_GLINT'];

  it('has the flow code, a constant to say so, and the clock read from the frame', () => {
    const src = sceneSource({ flowing: true });
    expect(src).toContain('const FLOWING: bool = true;');
    for (const word of ['flowSurface', 'flowFbm', 'flowVoro', 'flowHash', 'frame.spare0']) expect(src, word).toContain(word);
    // it carries the placement's tangents, which turn a normal by a slope, and the glow is added after the lights
    expect(src).toContain('tx: vec3f');
    expect(src).toContain('out.tx = m0.xyz;');
    expect(src).toContain('colour += flow.glow;');
  });

  it('bends the sheet before the waves are laid on it, and keeps the swell weak, so the sky in it does not repeat', () => {
    const src = sceneSource({ flowing: true });
    expect(src).toContain('const WATER_WARP: f32 = 0.45;');
    expect(src).toContain('let p = p0 + WATER_WARP * vec2f(');
    // three swell waves at 0.18, 0.144 and 0.126, where they were 0.34, 0.28 and 0.22: the clouds in the mirror
    expect(src).toContain('1.9, 0.9, 0.0, 0.18,');
    expect(src).toContain('2.6, 1.1, 1.7, 0.144,');
    expect(src).toContain('3.3, 1.3, 4.1, 0.126,');
  });

  it('has open water: its waves in the world, its mirror and its glint after the lights, and no flow kind past it', () => {
    const src = sceneSource({ flowing: true });
    for (const word of ['waterSlope', 'waterWave', 'WATER_RF0', 'WATER_GLINT']) expect(src, word).toContain(word);
    expect(src).toContain('if (kind > 7.5 && kind < 8.5) {');
    expect(src).toContain('if (in.pattern.x > 7.5 && in.pattern.x < 8.5) {');
    // the glint is the camera's: aimed from the view vector and not from the light
    expect(src).toContain('let ahead = vec3f(heading * sqrt(1.0 - rise * rise), rise);');
    expect(src).toContain('textureSampleLevel(envSpecular, samp,');
    // the dead value noise of the experiment is not carried
    expect(src).not.toContain('flowNoiseD');
    expect(src).not.toContain('waterHash');
    // the water branch is in the glow splice's place, before the return (that it compiles is the GPU suite's)
    expect(src.indexOf('colour += flow.glow;')).toBeLessThan(src.indexOf('let ahead'));
  });

  it('is a patterned build too, so kinds one to four draw in it as they do in the patterned one', () => {
    expect(sceneSource({ flowing: true })).toContain('const PATTERNED: bool = true;');
    // and what a flow kind mixes is the flow's, not the speckle the patterned build's own field would make of its number
    expect(sceneSource({ flowing: true })).toContain('select(patternMix(in.local, in.pattern), flow.mixing, in.pattern.x > 4.5)');
  });

  it('is in no other build, not a word of it, whatever the other settings', () => {
    for (const patterned of [false, true])
      for (const toon of [false, true])
        for (const flowing of [undefined, false]) {
          const src = sceneSource({ patterned, toon, flowing });
          for (const word of FLOW_WORDS) expect(src, `${word} in a build that did not ask`).not.toContain(word);
        }
  });

  it('leaves every other build as it was to the byte: the same text with or without the setting named', () => {
    for (const patterned of [false, true]) expect(sceneSource({ patterned, flowing: false })).toBe(sceneSource({ patterned }));
    expect(sceneSource({ patterned: true })).toContain('const PATTERNED: bool = true;\nconst TOON: bool = false;');
  });

  // Written again for v0.28.0, whose sun shadow can be softened and faded at a fitted map's edge in every build, each
  // behind a uniform that is nought unless asked (held to the pixel by shadowfit.gpu.test.ts); the flowing splices are
  // still held out of these builds' text by the test above.
  it('leaves the builds that are not flowing as they were in v0.28.0, to the byte: their text hashed then and now', () => {
    const hashes: string[] = [];
    for (const patterned of [false, true]) for (const toon of [false, true]) for (const shadows of [false, true])
      hashes.push(fnv(sceneSource({ patterned, toon, shadows })));
    expect(hashes).toEqual(['2c3e5b81', 'ac8c8ec8', 'e1d6c7a8', '1709f9ff', '7cbacd88', '3334178b', 'fb49cfbf', '235c2dba']);
  });

  it('is built in the ladder\'s and toon\'s constants as the other builds are', () => {
    const src = sceneSource({ flowing: true, toon: true, points: false, shadows: false, cullLights: false });
    for (const line of ['TOON: bool = true', 'POINT_LIGHTS: bool = false', 'SHADOWS: bool = false', 'CULL_BY_RADIUS: bool = false']) expect(src).toContain(line);
    expect(body(sceneSource({ flowing: true, points: false }))).toBe(body(sceneSource({ flowing: true, points: true })));
  });

  it('refuses another vertex stage, which has no tangents to give it', () => {
    const other = '@vertex fn vsMain(@builtin(vertex_index) v: u32) -> VsOut { var out: VsOut; return out; }\n';
    expect(() => sceneWith(other, { flowing: true })).toThrow(/flowing/);
  });
});
