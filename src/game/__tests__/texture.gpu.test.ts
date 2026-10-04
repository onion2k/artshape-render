/**
 * The ground texture on a real device: an image sampled by world position
 * under a placement's colour, on the placements that opt in. A textured plane
 * differs from a plain one; a texture bound that no group wears draws not one
 * pixel differently; the layer picks the image and the repeat sizes it; the
 * shade channel moves where a toon band's edge falls, with its strength and
 * not at nought; far ground fades to its flat colour; the builds are compiled
 * only when a group asks, once, and at four samples when those are asked for,
 * in either order; and the layers are refused by name. Pixel checks, under an
 * error scope, since a pass wrongly put together draws nothing and says so
 * only to the console. VITE_FRAME_DIR writes the frames.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { MeshBuilder, type Mesh } from '../../mesh/types';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, FULL_ECONOMY, GameRenderer, PATTERN_STRIDE, TEXTURE_STRIDE, type FrameMode, type GameGroup } from '../renderer';
import { LightPool } from '../lights';
import { FLOW_RIPPLE, packFlow } from '../flow';
import { packTexture } from '../texture';
import { differing, meanIn, readPixels, saveFrame, type Pixels } from './frame';

const W = 192, H = 192;
/** The pipelines a renderer makes before `ready`, as v0.19.0's did: a game asking for nothing new makes no more. */
const PIPELINES_AT_0_19 = 46;
/** The textured builds: toon or not, shadows, points and the cull, each rung of the ladder, and always patterned. */
const TEXTURED_BUILDS = 16;
/** The one pipeline that draws a texture's mips, made with the first texture. */
const MIP_PIPELINES = 1;
const GREEN: [number, number, number] = [0.3, 0.5, 0.2];
/** The camera: far off and long in the lens, so every point of the square is seen from the same direction. */
const DISTANCE = 301.5, FOV = 3;
const PX_PER_UNIT = H / (2 * DISTANCE * Math.tan((FOV / 2) * (Math.PI / 180)));

/** A square of `size` across the mesh's own x and y, facing up, about the origin. */
function plane(size: number): Mesh {
  const b = new MeshBuilder();
  const s = size / 2;
  b.vertex(-s, -s, 0, 0, 0, 1, 0, 0);
  b.vertex(s, -s, 0, 0, 0, 1, 1, 0);
  b.vertex(s, s, 0, 0, 0, 1, 1, 1);
  b.vertex(-s, s, 0, 0, 0, 1, 0, 1);
  b.quad(0, 1, 2, 3);
  return b.build();
}

const at = (scale: number, x = 0, y = 0, z = 0) => new Float32Array([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, x, y, z, 1]);

/** A toon look with its bands hard and flat: no finish, no smooth ramp, no form, so a band's edge is a step. */
const HARD = { gloss: 0, sheen: 0, smoothShading: 0, occlusionTint: 0, form: 0 };

/** A layer made from a function of its texel, as a bitmap with its alpha left alone. */
async function layer(side: number, texel: (x: number, y: number) => [number, number, number, number]): Promise<ImageBitmap> {
  const data = new ImageData(side, side);
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) data.data.set(texel(x, y), (y * side + x) * 4);
  return createImageBitmap(data, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

/** Two tones in blocks of sixteen texels, the colour alone, its alpha mid-grey: what the albedo channel is held with. */
const blocks = (a = 40, b = 216) => layer(256, (x, y) => { const v = ((x >> 4) + (y >> 4)) & 1 ? a : b; return [v, v, v, 128]; });
/** Mid-grey colour, and an alpha that ramps from nought to one across the layer's x: what the shade channel is held with. */
const ramp = () => layer(256, (x) => [128, 128, 128, Math.round((x / 255) * 255)]);

describe('the ground texture on the game renderer', () => {
  let gpu: Gpu;
  let env: ReturnType<typeof bakeEnvironment>;
  let r: GameRenderer;
  let target: GPUTexture;

  async function make(size = W): Promise<GameRenderer> {
    const renderer = new GameRenderer(gpu, 8, 8, 256, 100);
    await renderer.ready;
    renderer.setEnvironment(env.specular, env.brdf, env.mips);
    renderer.resize(size, size);
    renderer.setLights(new LightPool(8));
    renderer.look = { ...renderer.look, background: [0.02, 0.02, 0.03], occlusion: 0 };
    renderer.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
    renderer.economy = { ...FULL_ECONOMY, shadows: true };
    renderer.camera.fov = FOV; renderer.camera.near = 100; renderer.camera.far = 600;
    renderer.camera.target = [0, 0, 0];
    renderer.camera.position = [0, -30, 300];
    return renderer;
  }

  beforeAll(async () => {
    gpu = await createDevice();
    env = bakeEnvironment(gpu, 'daylight', { size: 32, mips: 3 });
    await env.samples;
    target = gpu.device.createTexture({ size: [W, H], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    r = await make();
  });

  afterAll(() => { r?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  beforeEach(() => {
    r.look = { ...r.look, shading: 'pbr', antialias: undefined, sunColour: [1, 1, 1], ambient: 1, exposure: 1, sunDir: [0.3, -0.4, 0.86] };
    r.economy = { ...FULL_ECONOMY, shadows: true };
    r.camera.target = [0, 0, 0];
    r.camera.position = [0, -30, 300];
    r.setGroundTexture(null);
    r.setStatic([]);
    r.setDynamic([]);
  });

  /** A twelve-unit square of the green, wearing a layer of the texture if it is told one. */
  const ground = (tex?: { layer?: number; repeat?: number; albedo?: number; shade?: number }, extra: Partial<GameGroup> = {}, at_ = at(1)): GameGroup => ({
    mesh: plane(12), matrices: at_, albedo: GREEN, roughness: 0.9, ...extra,
    ...(tex ? { texture: packTexture(new Float32Array(TEXTURE_STRIDE), 0, { layer: tex.layer ?? 1, repeat: tex.repeat ?? 0.1, albedo: tex.albedo ?? 1, shade: tex.shade ?? 0 }) } : {}),
  });

  async function draw(name = '', mode: FrameMode = 'redraw', renderer = r, tex = target): Promise<Pixels> {
    gpu.device.pushErrorScope('validation');
    const drew = renderer.frame(tex.createView(), mode, 0);
    const error = await gpu.device.popErrorScope();
    expect(error?.message ?? null).toBeNull();
    expect(drew).toBe(true);
    const px = await readPixels(gpu, tex);
    if (name) await saveFrame(`texture ${name}`, px);
    return px;
  }

  /** The group alone, once its builds are in. */
  async function drawn(group: GameGroup, name = ''): Promise<Pixels> {
    r.setStatic([group]);
    await r.prepare();
    return draw(name);
  }

  /** The mean absolute difference of the middle of two frames, in levels. */
  function meanAbs(a: Pixels, b: Pixels): number {
    let sum = 0, n = 0;
    for (let y = 60; y < 132; y++) for (let x = 60; x < 132; x++) for (let c = 0; c < 3; c++) { sum += Math.abs(a.rgb[(y * W + x) * 3 + c] - b.rgb[(y * W + x) * 3 + c]); n++; }
    return sum / n;
  }

  /** The most any channel of any pixel of the middle differs between two frames. */
  function worst(a: Pixels, b: Pixels): number {
    let m = 0;
    for (let y = 60; y < 132; y++) for (let x = 60; x < 132; x++) for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(a.rgb[(y * W + x) * 3 + c] - b.rgb[(y * W + x) * 3 + c]));
    return m;
  }

  it('draws a textured plane unlike a plain one, over most of the plane, in both looks', async () => {
    r.setGroundTexture([await blocks()]);
    for (const shading of ['pbr', 'toon'] as const) {
      r.look = { ...r.look, shading };
      const plain = await drawn(ground(), `plain ${shading}`);
      const textured = await drawn(ground({ repeat: 0.1 }), `textured ${shading}`);
      // the plane is some 146 pixels across, about 21,000 of them
      expect(differing(plain, textured), shading).toBeGreaterThan(10000);
      // both tones show: the dark blocks and the light ones, about the plain colour between them
      const [pr, pg] = meanIn(plain, 70, 70, 122, 122);
      const grey = meanIn(textured, 70, 70, 122, 122);
      expect(Math.abs(grey[1] - pg), `${shading}: the mean stays about the game's own colour`).toBeLessThan(pg * 0.35);
      expect(pr).toBeGreaterThan(0);
    }
  });

  it('keeps the game\'s palette: the textured plane is the plain colour times the layer about its mid-grey, and no more', async () => {
    r.setGroundTexture([await blocks(64, 192)]);
    const plain = await drawn(ground());
    const textured = await drawn(ground({ repeat: 0.1 }));
    let lo = 1e9, hi = 0;
    for (let y = 70; y < 122; y++) for (let x = 70; x < 122; x++) {
      const i = (y * W + x) * 3;
      // the frame is gamma encoded, and the sums are in light
      const ratio = ((textured.rgb[i + 1] + 0.5) / 255) ** 2.2 / (((plain.rgb[i + 1] + 0.5) / 255) ** 2.2);
      lo = Math.min(lo, ratio); hi = Math.max(hi, ratio);
    }
    // 64 and 192 of 255 are 0.5 and 1.5 times mid-grey
    expect(lo).toBeLessThan(0.58);
    expect(lo).toBeGreaterThan(0.42);
    expect(hi).toBeGreaterThan(1.3);
    expect(hi).toBeLessThan(1.7);
  });

  it('is as it was where no group opts in: a bound texture changes not one pixel of a scene that wears none', async () => {
    const scene = (): GameGroup[] => [ground(), { mesh: plane(3), matrices: at(1, 0, 0, 0.5), albedo: [0.8, 0.2, 0.2], roughness: 0.4, patterns: packFlowless() }];
    function packFlowless() { const p = new Float32Array(PATTERN_STRIDE); p[0] = 4; p[1] = 2; p[4] = 1; p[5] = 1; p[6] = 1; return p; }
    for (const shading of ['pbr', 'toon'] as const) {
      r.look = { ...r.look, shading };
      r.setStatic(scene());
      await r.prepare();
      const without = await draw();
      r.setGroundTexture([await blocks(), await ramp()]);
      expect(differing(without, await draw()), `${shading}: texture bound, nothing opted in`).toBe(0);
      // a group whose every placement says layer nought has not opted in either
      r.setStatic([ground({ layer: 0 }), ...scene().slice(1)]);
      await r.prepare();
      expect(differing(without, await draw()), `${shading}: layer nought`).toBe(0);
      r.setGroundTexture(null);
      r.setStatic(scene());
      expect(differing(without, await draw()), `${shading}: and taken away again`).toBe(0);
    }
  });

  it('draws a group that asks before any texture is set as it would without, and a texture taken away leaves it nearly so', async () => {
    const plain = await drawn(ground());
    const asked = await drawn(ground({ repeat: 0.1, shade: 1 }));
    // the neutral texel is 128 of 255, doubled: a part in two hundred and fifty
    expect(worst(plain, asked)).toBeLessThanOrEqual(2);
    r.setGroundTexture([await blocks()]);
    expect(differing(asked, await draw())).toBeGreaterThan(10000);
    r.setGroundTexture(null);
    expect(worst(plain, await draw())).toBeLessThanOrEqual(2);
  });

  it('wears the layer it names, sized by its repeat, and a layer past the last wears the last', async () => {
    r.setGroundTexture([await blocks(40, 216), await blocks(120, 136)]);
    const one = await drawn(ground({ layer: 1 }));
    const two = await drawn(ground({ layer: 2 }));
    const three = await drawn(ground({ layer: 3 }));
    const spread = (px: Pixels) => {
      let lo = 255, hi = 0;
      for (let y = 70; y < 122; y++) for (let x = 70; x < 122; x++) { const g = px.rgb[(y * W + x) * 3 + 1]; lo = Math.min(lo, g); hi = Math.max(hi, g); }
      return hi - lo;
    };
    expect(spread(one), 'layer one swings widely').toBeGreaterThan(60);
    expect(spread(two), 'layer two hardly at all').toBeLessThan(20);
    expect(differing(two, three), 'layer three is not there and wears the last, two').toBe(0);
    // twice the repeat, twice the blocks to a unit: not the same picture
    expect(differing(one, await drawn(ground({ layer: 1, repeat: 0.2 })))).toBeGreaterThan(5000);
    // the texture is of the world and not the mesh: the same plane moved on by a whole tile of the texture draws the same
    const moved = await drawn(ground({ layer: 1, repeat: 1 / 16 }, {}, at(1, 0, 0)));
    r.camera.target = [16, 0, 0]; r.camera.position = [16, -30, 300];
    const shifted = await drawn(ground({ layer: 1, repeat: 1 / 16 }, {}, at(1, 16, 0)));
    // but for the rounding of a coordinate sixteen units out, along the plane's edge and the blocks' (a hundredth of the plane)
    expect(differing(moved, shifted), 'a plane moved a whole tile of the texture, and the camera with it').toBeLessThan(200);
    expect(meanAbs(moved, shifted), 'and no more than a rounding off, on the mean').toBeLessThan(0.5);
  });

  it('is one field across two placements that abut, so the ground has no seam between kinds', async () => {
    r.setGroundTexture([await blocks()]);
    // two squares side by side with the same texture, and one square twice the width: the same frame
    const half = (x: number): GameGroup => ({ ...ground({ repeat: 0.1 }, {}, at(1, x, 0)) });
    r.setStatic([half(-6), half(6)]);
    await r.prepare();
    const two = await draw();
    r.setStatic([{ ...ground({ repeat: 0.1 }), mesh: wide() }]);
    // a coordinate interpolated over two meshes rounds a hair differently at the blocks' edges: a level off, now and then, and no seam
    expect(meanAbs(two, await draw()), 'two squares and one of their width, on the mean').toBeLessThan(0.5);
    function wide(): Mesh {
      const b = new MeshBuilder();
      b.vertex(-12, -6, 0, 0, 0, 1, 0, 0); b.vertex(12, -6, 0, 0, 0, 1, 1, 0); b.vertex(12, 6, 0, 0, 0, 1, 1, 1); b.vertex(-12, 6, 0, 0, 0, 1, 0, 1);
      b.quad(0, 1, 2, 3);
      return b.build();
    }
  });

  it('keeps a speckle on a textured group that has one, and a group of both is not a flowing one', async () => {
    r.setGroundTexture([await blocks()]);
    const speckle = new Float32Array(PATTERN_STRIDE); speckle[0] = 4; speckle[1] = 3; speckle[4] = 1; speckle[5] = 1; speckle[6] = 1;
    const plain = await drawn(ground({ repeat: 0.1 }));
    const both = await drawn(ground({ repeat: 0.1 }, { patterns: speckle }), 'speckle and texture');
    expect(differing(plain, both), 'the speckle shows through the texture').toBeGreaterThan(500);
    const flow = packFlow(new Float32Array(PATTERN_STRIDE), 0, { kind: FLOW_RIPPLE, scale: 1, speed: 0, second: [1, 1, 1] });
    expect(() => r.setStatic([ground({ repeat: 0.1 }, { patterns: flow })])).toThrow(/texture and a flow kind/);
  });

  describe('the shade channel', () => {
    /** The column, along a row through the middle, where the toon bands' edge falls: the first jump in brightness running right. */
    function edge(px: Pixels): number {
      const row = 96;
      let prev = -1;
      for (let x = 32; x < W - 32; x++) {
        const i = (row * W + x) * 3, g = px.rgb[i] + px.rgb[i + 1] + px.rgb[i + 2];
        if (prev >= 0 && g - prev > 12) return x;
        prev = g;
      }
      return -1;
    }

    /** A plane of the ramp, its x from 0 to 12 so the ramp's alpha is 0 to 1 along it, with the sun at thirty degrees so flat ground takes half of it, and toon's hard bands. */
    async function banded(shade: number, albedo = 0): Promise<Pixels> {
      r.look = { ...r.look, shading: 'toon', sunDir: [0.866025, 0, 0.5], ...HARD };
      r.camera.target = [6, 0, 0]; r.camera.position = [6, -30, 300];
      return drawn(ground({ repeat: 1 / 12, albedo, shade }, {}, at(1, 6, 0)));
    }

    it('moves where a band\'s edge falls with its strength, and not at all at nought', async () => {
      r.setGroundTexture([await ramp()]);
      r.look = { ...r.look, shading: 'toon', sunDir: [0.866025, 0, 0.5], ...HARD };
      r.camera.target = [6, 0, 0]; r.camera.position = [6, -30, 300];
      const none = await drawn(ground({ repeat: 1 / 12, albedo: 0, shade: 0 }, {}, at(1, 6, 0)), 'shade 0');
      const flat = await drawn(ground(undefined, {}, at(1, 6, 0)));
      expect(differing(none, flat), 'strength nought is the plain plane').toBe(0);
      expect(edge(none), 'and has no edge in it').toBe(-1);
      const edges = [] as number[];
      for (const s of [0.25, 0.5, 1]) edges.push(edge(await banded(s)));
      expect(edges.every((e) => e > 0), `an edge at each strength: ${edges}`).toBe(true);
      // the light is half the sun, so the top band is entered where the strength times the height clears 0.9: further right the more there is
      expect(edges[0]).toBeLessThan(edges[1]);
      expect(edges[1]).toBeLessThan(edges[2]);
      // where the sums say: x = 12 * (s - 0.1) / (2 s), on a plane whose middle is at pixel 96 and a unit is PX_PER_UNIT pixels across
      for (const [k, s] of [0.25, 0.5, 1].entries()) {
        const expected = 96 + (12 * ((s - 0.1) / (2 * s)) - 6) * PX_PER_UNIT;
        expect(Math.abs(edges[k] - expected), `strength ${s}: edge at ${edges[k]}, sums say ${expected.toFixed(1)}`).toBeLessThan(3);
      }
    });

    it('leaves the colour alone when only the shade is asked for, in the pbr look as in toon', async () => {
      r.setGroundTexture([await ramp()]);
      // a mid-grey colour channel is the identity, so only the shade can move the plane, and in pbr it does by the sun's light
      r.look = { ...r.look, shading: 'pbr' };
      const flat = await drawn(ground());
      const shaded = await drawn(ground({ repeat: 1 / 12, albedo: 0, shade: 1 }));
      expect(differing(flat, shaded), 'pbr takes the shade on its diffuse term').toBeGreaterThan(5000);
    });
  });

  it('settles to the flat colour where the texels are smaller than a pixel, and shows where they are not', async () => {
    r.setGroundTexture([await blocks()]);
    const plain = await drawn(ground());
    // a texel is a few thousand to a pixel: far ground, which a grey mip would otherwise make of the layer
    const far = await drawn(ground({ repeat: 20, shade: 1 }));
    expect(worst(plain, far), 'at twenty tiles a unit').toBeLessThanOrEqual(2);
    const near = await drawn(ground({ repeat: 0.1, shade: 1 }));
    expect(worst(plain, near), 'at a tenth of a tile a unit').toBeGreaterThan(40);
    // and between, the strength goes from one to nought without a step: the spread of the grain falls as the repeat rises
    const grain = (px: Pixels) => { let lo = 255, hi = 0; for (let y = 70; y < 122; y++) for (let x = 70; x < 122; x++) { const g = px.rgb[(y * W + x) * 3 + 1]; lo = Math.min(lo, g); hi = Math.max(hi, g); } return hi - lo; };
    const swing = [] as number[];
    for (const repeat of [0.1, 1, 3, 6, 20]) swing.push(grain(await drawn(ground({ repeat }))));
    expect(swing[0]).toBeGreaterThan(swing[4] + 40);
    expect(swing[4]).toBeLessThanOrEqual(2);
  });

  it('reads a layer as it comes, the alpha too, and mips it down so a far plane is the layer\'s average', async () => {
    // alternate texels of 0 and 255 across the whole layer: its level zero is as contrasty as a layer can be and its average is mid-grey
    r.setGroundTexture([await layer(256, (x, y) => { const v = (x + y) & 1 ? 255 : 0; return [v, v, v, 128]; })]);
    const plain = await drawn(ground());
    // a texel to a pixel's tenth, and the fade not yet at work (repeat chosen so the density is under four octaves): the mip is the average, so the plane is the plain colour
    const near = await drawn(ground({ repeat: 0.5 }));
    expect(worst(plain, near), 'a checkerboard of single texels, averaged by its mips').toBeLessThanOrEqual(4);
  });

  describe('the builds', () => {
    /** Counts the pipelines the device is asked for while `fn` runs. */
    async function counting<T>(fn: (made: () => number) => Promise<T>): Promise<T> {
      const device = gpu.device as unknown as Record<string, (...a: unknown[]) => unknown>;
      let made = 0;
      const originals: Record<string, (...a: unknown[]) => unknown> = {};
      for (const m of ['createRenderPipelineAsync', 'createComputePipelineAsync', 'createRenderPipeline', 'createComputePipeline']) {
        originals[m] = device[m];
        device[m] = function (this: unknown, ...a: unknown[]) { made++; return originals[m].apply(this, a); };
      }
      try { return await fn(() => made); } finally { for (const m of Object.keys(originals)) device[m] = originals[m]; }
    }

    it('make no pipeline for it until a group asks, and a game that sets a texture and asks nothing makes one for the mips', async () => {
      await counting(async (made) => {
        const fresh = await make();
        expect(made(), 'pipelines made before ready').toBe(PIPELINES_AT_0_19);
        fresh.setStatic([ground(), ground({ layer: 0 })]);
        fresh.setDynamic([ground()]);
        await fresh.prepare();
        expect(made(), 'pipelines made by groups with no texture').toBe(PIPELINES_AT_0_19);
        fresh.setGroundTexture([await blocks()]);
        expect(made(), 'a texture set and no group wearing it: the mips\' pass alone').toBe(PIPELINES_AT_0_19 + MIP_PIPELINES);
        fresh.setGroundTexture([await blocks(), await ramp()]);
        fresh.setGroundTexture(null);
        expect(made(), 'and not made again for the next').toBe(PIPELINES_AT_0_19 + MIP_PIPELINES);
        fresh.setStatic([ground({ repeat: 0.1 })]);
        expect(made(), 'the first textured group').toBe(PIPELINES_AT_0_19 + MIP_PIPELINES + TEXTURED_BUILDS);
        await fresh.prepare();
        fresh.setStatic([ground({ repeat: 0.2 })]);
        fresh.setDynamic([ground({ repeat: 0.3 })]);
        await fresh.prepare();
        expect(made(), 'and not made again for the next').toBe(PIPELINES_AT_0_19 + MIP_PIPELINES + TEXTURED_BUILDS);
        fresh.dispose();
      });
    });

    it('draw the group plain until they are in, and textured after', async () => {
      r.setGroundTexture([await blocks()]);
      const plain = await drawn(ground());
      r.setStatic([ground({ repeat: 0.1 })]);
      // not yet awaited: whatever the first frame is, it is a frame, and after prepare it is the textured one
      await r.prepare();
      expect(differing(plain, await draw())).toBeGreaterThan(10000);
    });

    it('are in at four samples as well, whichever of the two is asked for first, and FXAA draws them', async () => {
      await counting(async (made) => {
        const texture = [await blocks()];
        // four samples first, the texture after: the textured builds at one sample and at four
        const a = await make();
        a.look = { ...a.look, antialias: 'msaa' };
        await a.prepare();
        a.setGroundTexture(texture);
        const before = made();
        a.setStatic([ground({ repeat: 0.1 })]);
        await a.prepare();
        expect(made() - before, 'the textured builds, at one sample and at four').toBe(TEXTURED_BUILDS * 2);
        const plainA = await draw('', 'redraw', a);
        a.setStatic([ground()]);
        expect(differing(plainA, await draw('', 'redraw', a)), 'textured at four samples').toBeGreaterThan(5000);
        a.dispose();
        // the texture first, four samples after
        const b = await make();
        b.setGroundTexture(texture);
        b.setStatic([ground({ repeat: 0.1 })]);
        await b.prepare();
        b.look = { ...b.look, antialias: 'msaa' };
        await b.prepare();
        const textured = await draw('', 'redraw', b);
        b.setStatic([ground()]);
        expect(differing(textured, await draw('', 'redraw', b)), 'textured at four samples, asked after').toBeGreaterThan(5000);
        b.look = { ...b.look, antialias: 'fxaa' };
        await b.prepare();
        b.setStatic([ground({ repeat: 0.1 })]);
        const fxaa = await draw('', 'redraw', b);
        b.setStatic([ground()]);
        expect(differing(fxaa, await draw('', 'redraw', b)), 'textured under FXAA').toBeGreaterThan(5000);
        b.dispose();
      });
    });
  });

  it('is not left stale in a kept frame: a texture set after the static half was kept shows in the next', async () => {
    r.setGroundTexture([await blocks()]);
    r.setStatic([ground({ repeat: 0.1 })]);
    await r.prepare();
    const first = await draw('', 'redraw');
    r.setGroundTexture([await blocks(100, 150)]);
    const kept = await draw('', 'keep');
    expect(differing(first, kept), 'a keep frame after a new texture').toBeGreaterThan(5000);
    expect(differing(kept, await draw('', 'redraw'))).toBe(0);
  });

  it('refuses layers it cannot make an array of, by name, and leaves the texture it had', async () => {
    const good = await blocks();
    r.setGroundTexture([good]);
    const before = await drawn(ground({ repeat: 0.1 }));
    const wide = await layer(64, () => [0, 0, 0, 0]);
    const odd = await createImageBitmap(new ImageData(100, 100));
    const tall = await createImageBitmap(new ImageData(64, 32));
    const small = await layer(128, () => [0, 0, 0, 0]);
    expect(() => r.setGroundTexture([])).toThrow(/no layers/);
    expect(() => r.setGroundTexture([odd])).toThrow(/power of two/);
    expect(() => r.setGroundTexture([tall])).toThrow(/square/);
    expect(() => r.setGroundTexture([good, small])).toThrow(/same size/);
    expect(() => r.setGroundTexture(Array.from({ length: 9 }, () => wide))).toThrow(/at most 8/);
    expect(differing(before, await draw()), 'after the refusals, the same picture').toBe(0);
  });
});
