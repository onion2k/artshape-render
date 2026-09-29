/**
 * The look's new settings without a device: which antialiasing a frame is
 * drawn with, from what the look asks and the economy allows; how the toon
 * look's own light is packed for the scene shader, where a look that asks
 * for none of it must pack noughts, since noughts are what skip every
 * branch that reads it; and the two shaders antialiasing adds, the fog's
 * march over a multisampled depth and FXAA. `antialias.gpu.test.ts` and
 * `toonlight.gpu.test.ts` hold them on a device.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOOK, MAX_BAND_SOFTNESS, MAX_FORM, RIM_WIDTH, TOON_FLOATS, antialiasFor, toonUniform, type Antialias, type Look } from '../renderer';
import { FOG_MSAA_WGSL, FOG_WGSL, FXAA_WGSL, multisampledFog, sceneSource } from '../shaders';

const pack = (look: Partial<Look>) => Array.from(toonUniform(new Float32Array(TOON_FLOATS), { ...DEFAULT_LOOK, ...look }));

describe('the antialiasing a frame is drawn with', () => {
  it('is none when the look asks for none, whatever the economy allows', () => {
    for (const economy of [undefined, 'none', 'fxaa', 'msaa'] as (Antialias | undefined)[]) {
      expect(antialiasFor({}, { antialias: economy })).toBe('none');
      expect(antialiasFor({ antialias: 'none' }, { antialias: economy })).toBe('none');
    }
  });

  it('is what the look asks when the economy says nothing', () => {
    for (const asked of ['none', 'fxaa', 'msaa'] as Antialias[]) expect(antialiasFor({ antialias: asked }, {})).toBe(asked);
  });

  it('is held down to what the economy allows, and never raised by it', () => {
    expect(antialiasFor({ antialias: 'msaa' }, { antialias: 'fxaa' })).toBe('fxaa');
    expect(antialiasFor({ antialias: 'msaa' }, { antialias: 'none' })).toBe('none');
    expect(antialiasFor({ antialias: 'fxaa' }, { antialias: 'msaa' })).toBe('fxaa');
    expect(antialiasFor({ antialias: 'fxaa' }, { antialias: 'none' })).toBe('none');
  });

  it('takes a word it does not know as asking for none', () => {
    expect(antialiasFor({ antialias: 'MSAA' as Antialias }, {})).toBe('none');
  });
});

describe('the toon look packed for the scene shader', () => {
  it('packs noughts for a look that asks for none of the toon light, so every branch reading it is skipped', () => {
    // the toon light is the first seventeen; the toy finish after it is on unless it is said to be off (toy.test.ts)
    expect(pack({}).slice(0, 17)).toEqual(new Array(17).fill(0));
    // said, but said as nothing
    expect(pack({ bandSoftness: 0, rim: 0, rimColour: [1, 0.5, 0], rimWidth: 0.5, form: 0 }).slice(0, 17)).toEqual(new Array(17).fill(0));
  });

  it('packs the shade colour, and says there is one', () => {
    const p = pack({ shadeColour: [0.5, 0.52, 0.8] });
    expect(p.slice(0, 3).map((x) => +x.toFixed(4))).toEqual([0.5, 0.52, 0.8]);
    expect(p[15]).toBe(1);
  });

  it('holds the bands softness between nothing and its widest', () => {
    expect(pack({ bandSoftness: 0.04 })[3]).toBeCloseTo(0.04);
    expect(pack({ bandSoftness: 0.5 })[3]).toBeCloseTo(MAX_BAND_SOFTNESS);
    expect(pack({ bandSoftness: -1 })[3]).toBe(0);
    expect(pack({ bandSoftness: NaN })[3]).toBe(0);
  });

  it('packs the rim at its strength, at the width it is given or its own', () => {
    const p = pack({ rim: 0.5, rimColour: [1, 0.8, 0.6] });
    expect(p.slice(4, 7).map((x) => +x.toFixed(4))).toEqual([0.5, 0.4, 0.3]);
    expect(p[7]).toBeCloseTo(RIM_WIDTH);
    expect(pack({ rim: 2 }).slice(4, 8).map((x) => +x.toFixed(4))).toEqual([2, 2, 2, RIM_WIDTH]);
    expect(pack({ rim: 1, rimWidth: 3 })[7]).toBe(1);
  });

  it('packs no rim at all when its width is nothing, or its strength is not a number', () => {
    expect(pack({ rim: 1, rimWidth: 0 }).slice(4, 8)).toEqual([0, 0, 0, 0]);
    expect(pack({ rim: NaN }).slice(4, 8)).toEqual([0, 0, 0, 0]);
  });

  it('packs a sky and a ground light, each taking the other when it is left out', () => {
    const both = pack({ skyLight: [0.3, 0.4, 0.7], groundLight: [0.5, 0.35, 0.2] });
    expect(both.slice(8, 15).map((x) => +x.toFixed(4))).toEqual([0.3, 0.4, 0.7, 1, 0.5, 0.35, 0.2]);
    const sky = pack({ skyLight: [0.3, 0.4, 0.7] });
    expect(sky.slice(12, 15)).toEqual(sky.slice(8, 11));
    expect(sky[11]).toBe(1);
    const ground = pack({ groundLight: [0.5, 0.35, 0.2] });
    expect(ground.slice(8, 11)).toEqual(ground.slice(12, 15));
    expect(ground[11]).toBe(1);
  });

  it('takes a colour with a part that is not a number as not asked for', () => {
    expect(pack({ shadeColour: [0.5, NaN, 0.8] })[15]).toBe(0);
    expect(pack({ skyLight: [Infinity, 0, 0] })[11]).toBe(0);
  });

  it('packs the form light after the rest, held between nothing and its strongest, and nothing beside it', () => {
    const p = pack({ form: 1.5 });
    expect(p[16]).toBeCloseTo(1.5);
    expect(p.slice(0, 16), 'nothing else asked for').toEqual(new Array(16).fill(0));
    expect(pack({ form: 99 })[16]).toBeCloseTo(MAX_FORM);
    expect(pack({ form: -1 })[16]).toBe(0);
    expect(pack({ form: NaN })[16]).toBe(0);
  });

  it('writes at the offset it is given and nowhere else', () => {
    const out = new Float32Array(32 + TOON_FLOATS).fill(7);
    toonUniform(out, { ...DEFAULT_LOOK, rim: 1 }, 32);
    expect(Array.from(out.subarray(0, 32))).toEqual(new Array(32).fill(7));
    expect(out[32 + 7]).toBeCloseTo(RIM_WIDTH);
  });

  it('is laid out as the shader reads it: twenty-four floats after the thirty-two it always had', () => {
    const src = sceneSource({ toon: true });
    const frame = src.slice(src.indexOf('struct Frame {'), src.indexOf('};', src.indexOf('struct Frame {')));
    const fields = [...frame.matchAll(/(\w+): (mat4x4f|vec3f|vec2f|f32)/g)].map((m) => m[2]);
    const floats = fields.reduce((n, t) => n + ({ mat4x4f: 16, vec3f: 3, vec2f: 2, f32: 1 } as Record<string, number>)[t], 0);
    expect(floats).toBe(32 + TOON_FLOATS);
    expect(TOON_FLOATS).toBe(24);
    expect(frame).toMatch(
      /shade: vec3f, softness: f32,\s*rim: vec3f, rimWidth: f32,\s*sky: vec3f, hemisphere: f32,\s*ground: vec3f, shaded: f32,\s*(\/\/[^\n]*\s*)*form: f32, gloss: f32, sheen: f32, smoothShading: f32,\s*occlusionTint: f32, spare0: f32, spare1: f32, spare2: f32,\s*$/,
    );
  });
});

describe('the shaders antialiasing adds', () => {
  it('marches the fog over a multisampled depth with nothing else changed', () => {
    const plain = FOG_WGSL.split('\n');
    const msaa = FOG_MSAA_WGSL.split('\n');
    expect(msaa.length).toBe(plain.length);
    const differ = plain.map((line, i) => [line, msaa[i]]).filter(([a, b]) => a !== b);
    expect(differ).toEqual([['@group(0) @binding(0) var depthTex: texture_depth_2d;', '@group(0) @binding(0) var depthTex: texture_depth_multisampled_2d;']]);
    // sample nought where the plain march reads level nought: the load is the same call
    expect(FOG_MSAA_WGSL).toContain('textureLoad(depthTex, coord, 0)');
  });

  it('refuses to make the multisampled march from a fog that no longer declares its depth as it did', () => {
    expect(() => multisampledFog(FOG_WGSL.replace('var depthTex: texture_depth_2d;', 'var depth: texture_depth_2d;'))).toThrow();
  });

  it('gives a pixel FXAA leaves alone back as it was loaded, and reads nothing else with a derivative', () => {
    // a pixel with no edge through it returns what was loaded, not a filtered sample of it
    expect(FXAA_WGSL).toMatch(/let centre = textureLoad\(src, vec2i\(in\.pos\.xy\), 0\);/);
    expect(FXAA_WGSL).toMatch(/\{ return centre; \}/);
    // the search runs in a loop that stops where each pixel's edge does, where an implicit derivative is not defined
    expect(FXAA_WGSL).not.toMatch(/textureSample\(/);
  });
});
