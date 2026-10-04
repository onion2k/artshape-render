import { describe, expect, it } from 'vitest';
import { TEXTURE_LAYERS_MOST, TEXTURE_SIDE_MOST, TEXTURE_SPLICES, checkLayers, mipLevels, packTexture, usesTexture } from '../texture';
import { TEXTURE_STRIDE } from '../renderer';
import { sceneSource, sceneWith } from '../shaders';

const square = (side: number) => ({ width: side, height: side });

describe('a textured placement\'s four floats', () => {
  it('are the layer, the repeat, the albedo strength and the shade strength, in the stride the vertex layout reads', () => {
    expect(TEXTURE_STRIDE).toBe(4);
    const out = new Float32Array(8).fill(-1);
    packTexture(out, TEXTURE_STRIDE, { layer: 2, repeat: 0.25, albedo: 0.5, shade: 0.125 });
    expect([...out]).toEqual([-1, -1, -1, -1, 2, 0.25, 0.5, 0.125]);
  });

  it('say a group is textured when any placement names a layer, and not when every one says none', () => {
    expect(usesTexture(undefined)).toBe(false);
    const t = new Float32Array(TEXTURE_STRIDE * 3);
    expect(usesTexture(t)).toBe(false);
    t[TEXTURE_STRIDE * 2] = 1;
    expect(usesTexture(t)).toBe(true);
  });
});

describe('the layers of a ground texture', () => {
  it('are accepted when square, a power of two, the same size, within the limits', () => {
    expect(checkLayers([square(256)])).toBe(256);
    expect(checkLayers(Array.from({ length: TEXTURE_LAYERS_MOST }, () => square(TEXTURE_SIDE_MOST)))).toBe(TEXTURE_SIDE_MOST);
    expect(checkLayers([square(1)])).toBe(1);
  });

  it('are refused by name when there are none, or more than eight', () => {
    expect(() => checkLayers([])).toThrow(/no layers/);
    expect(() => checkLayers(Array.from({ length: 9 }, () => square(64)))).toThrow(/9 layers, and at most 8/);
  });

  it('are refused by name when not square, not a power of two, too big, or of different sizes', () => {
    expect(() => checkLayers([{ width: 256, height: 128 }])).toThrow(/layer 0 is 256 by 128.*square/);
    expect(() => checkLayers([square(256), square(100)])).toThrow(/layer 1 is 100 across.*power of two/);
    expect(() => checkLayers([square(2048)])).toThrow(/2048 across, and at most 1024/);
    expect(() => checkLayers([square(256), square(128)])).toThrow(/layer 1 is 128 across and layer 0 is 256.*same size/);
    expect(() => checkLayers([square(0)])).toThrow(/power of two/);
  });

  it('have a mip chain down to one texel', () => {
    expect([1, 2, 256, 1024].map(mipLevels)).toEqual([1, 2, 9, 11]);
  });
});

describe('the textured build of the scene shader', () => {
  const FLOWING_WORDS = ['flowSurface'];
  // the words that only the textured code has: not one may be in any other build
  const WORDS = ['groundTexture', 'groundSampler', 'groundSample', 'TEXTURED', 'in.tex', 'fwidth(groundUv'];

  it('has the array and its own sampler at the two bindings after the occlusion\'s, the sample, and a constant to say so', () => {
    const src = sceneSource({ textured: true });
    expect(src).toContain('const TEXTURED: bool = true;');
    expect(src).toContain('@group(0) @binding(10) var groundTexture: texture_2d_array<f32>;');
    expect(src).toContain('@group(0) @binding(11) var groundSampler: sampler;');
    expect(src).toContain('@location(11) tex: vec4f');
    expect(src).toContain('textureSample(groundTexture, groundSampler, groundUv, groundLayer)');
  });

  it('samples by the world\'s x and y times the repeat, and fades with the texel density from two to six octaves', () => {
    const src = sceneSource({ textured: true });
    expect(src).toContain('in.world.xy * in.tex.y');
    expect(src).toContain('1.0 - smoothstep(2.0, 6.0, groundTexels)');
    expect(src).toContain('max(fwidth(groundUv.x), fwidth(groundUv.y))');
  });

  it('modulates the albedo about mid-grey after the pattern mix, and the sun\'s light before the toon ramp', () => {
    const src = sceneSource({ textured: true });
    const mix = src.indexOf('f0 = mix(f0, in.second, patternMix');
    const albedo = src.indexOf('f0 = f0 * mix(vec3f(1.0), groundSample.rgb * 2.0');
    const shade = src.indexOf('lit = lit * mix(1.0, groundSample.a * 2.0');
    const ramp = src.indexOf('toonRamp(into');
    expect(mix).toBeGreaterThan(0);
    expect(albedo).toBeGreaterThan(mix);
    expect(shade).toBeGreaterThan(albedo);
    expect(ramp).toBeGreaterThan(shade);
    // the sample is taken before anything branches, where a derivative is defined
    expect(src.indexOf('textureSample(groundTexture')).toBeLessThan(src.indexOf('if (SHADOWS &&'));
  });

  it('is a patterned build too, and keeps its speckle', () => {
    expect(sceneSource({ textured: true })).toContain('const PATTERNED: bool = true;');
  });

  it('is in no other build, which is the text it was to the byte', () => {
    for (const patterned of [false, true])
      for (const toon of [false, true])
        for (const flowing of [undefined, false]) {
          const src = sceneSource({ patterned, toon, flowing });
          for (const word of WORDS) expect(src, `${word} in a build that did not ask`).not.toContain(word);
          expect(sceneSource({ patterned, toon, flowing, textured: false })).toBe(sceneSource({ patterned, toon, flowing }));
        }
    for (const word of FLOWING_WORDS) expect(sceneSource({ textured: true })).not.toContain(word);
  });

  it('is built in the ladder\'s and toon\'s constants as the other builds are, the body the same either way', () => {
    const src = sceneSource({ textured: true, toon: true, points: false, shadows: false, cullLights: false });
    for (const line of ['TOON: bool = true', 'POINT_LIGHTS: bool = false', 'SHADOWS: bool = false', 'CULL_BY_RADIUS: bool = false']) expect(src).toContain(line);
    const body = (s: string) => s.slice(s.indexOf('struct Frame'));
    expect(body(sceneSource({ textured: true, points: false }))).toBe(body(sceneSource({ textured: true, points: true })));
    expect(body(sceneSource({ textured: true, toon: true }))).toBe(body(sceneSource({ textured: true })));
  });

  it('refuses another vertex stage, which has no texture to give it, and a flowing build, which it is not', () => {
    const other = '@vertex fn vsMain(@builtin(vertex_index) v: u32) -> VsOut { var out: VsOut; return out; }\n';
    expect(() => sceneWith(other, { textured: true })).toThrow(/textured/);
    expect(() => sceneSource({ textured: true, flowing: true })).toThrow(/textured.*flowing/);
  });

  it('has every piece it splices in the shader once, or the build is wrong', () => {
    for (const piece of Object.values(TEXTURE_SPLICES)) expect(sceneSource().split(piece.from).length - 1, piece.from).toBe(1);
  });
});
