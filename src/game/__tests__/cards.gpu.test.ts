/**
 * Cut-out cards on a real device, the colour pass: a square wearing a disc mask draws a disc, in plain, at four
 * samples and in toon; its back is lit as a front is; a uv past one repeats the mask; a game that asks for no card
 * compiles nothing new, and one that does gets exactly the carded builds and the two cut depth passes, once; a static card handed in before its
 * builds land is drawn square and then, in a kept frame, cut once they are in; and the refusals are by name. The
 * unasked frame itself is held by `cardsgolden.gpu.test.ts`. Pixel checks, under an error scope, since a pass wrongly
 * put together draws nothing and says so only to the console. VITE_FRAME_DIR writes the frames.
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
import leafAlpha from './fixtures/leaf-alpha-256.b64?raw';
import maskFlowers from './fixtures/mask-Flowers.png.b64?raw';
import maskPine from './fixtures/mask-Leaf_Pine_C.png.b64?raw';
import maskLeaves from './fixtures/mask-Leaves.png.b64?raw';
import maskNormal from './fixtures/mask-Leaves_NormalTree_C.png.b64?raw';
import maskTwisted from './fixtures/mask-Leaves_TwistedTree_C.png.b64?raw';
import { differing, meanIn, readPixels, saveFrame, type Pixels } from './frame';

const W = 192, H = 192;
/** The pipelines a renderer makes before `ready`, as v0.19.0's did: a game asking for nothing new makes no more. */
const PIPELINES_AT_0_19 = 46;
/** The carded builds: toon or not, shadows, points and the cull, each rung of the ladder. */
const CARDED_BUILDS = 16;
/** The cut depth passes, made with the carded builds: the shadow maps' and the occlusion prepass's, at one sample whatever the frame's. */
const CUT_DEPTH_BUILDS = 2;
/** The card images' mips are made on the CPU and need no pipeline, as the ground's blit does. */
const MIP_PIPELINES = 0;
const GREEN: [number, number, number] = [0.3, 0.5, 0.2];
/** The camera: far off and long in the lens, so every point of the square is seen from the same direction. */
const DISTANCE = 301.5, FOV = 3;
const PX_PER_UNIT = H / (2 * DISTANCE * Math.tan((FOV / 2) * (Math.PI / 180)));
const SIDE = 12;
/** Pixels across the square, about 146. */
const SQUARE_PX = SIDE * PX_PER_UNIT;
const MID = W / 2;

/** A square of `SIDE` across x and y, facing up, about the origin, whose uvs run from nought to `uv` across it. */
function card(uv = 1): Mesh {
  const b = new MeshBuilder();
  const s = SIDE / 2;
  b.vertex(-s, -s, 0, 0, 0, 1, 0, 0);
  b.vertex(s, -s, 0, 0, 0, 1, uv, 0);
  b.vertex(s, s, 0, 0, 0, 1, uv, uv);
  b.vertex(-s, s, 0, 0, 0, 1, 0, uv);
  b.quad(0, 1, 2, 3);
  return b.build();
}

const at = (scale: number, x = 0, y = 0, z = 0) => new Float32Array([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, x, y, z, 1]);
/** Turned over about x, so that the camera above the square sees its back. */
const turned = () => new Float32Array([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]);

/** A toon look with its bands hard and flat: no finish, no smooth ramp, no form, so a band's edge is a step. */
const HARD = { gloss: 0, sheen: 0, smoothShading: 0, occlusionTint: 0, form: 0 };

/** A disc of opaque white on nothing, 64 across, made as a game would make a mask: drawn, then read without its alpha folded into its colour. */
async function disc(radius = 28): Promise<ImageBitmap> {
  const canvas = new OffscreenCanvas(64, 64);
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(32, 32, radius, 0, Math.PI * 2);
  g.fill();
  return createImageBitmap(canvas, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

describe('cut-out cards on the game renderer', () => {
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
    r.look = { ...r.look, shading: 'pbr', antialias: undefined, sunColour: [1, 1, 1], ambient: 0.2, exposure: 1, sunDir: [0.3, -0.4, 0.86] };
    r.economy = { ...FULL_ECONOMY, shadows: true };
    r.camera.target = [0, 0, 0];
    r.camera.position = [0, -30, 300];
    r.setCardImages(null);
    r.setStatic([]);
    r.setDynamic([]);
  });

  /** A twelve-unit square of the green; a card if it is told a layer. */
  const square = (layer?: number, extra: Partial<GameGroup> = {}, uv = 1, matrices = at(1)): GameGroup => ({
    mesh: card(uv), matrices, albedo: GREEN, roughness: 0.9, ...(layer ? { card: { layer } } : {}), ...extra,
  });

  async function draw(name = '', mode: FrameMode = 'redraw', renderer = r, tex = target): Promise<Pixels> {
    gpu.device.pushErrorScope('validation');
    const drew = renderer.frame(tex.createView(), mode, 0);
    const error = await gpu.device.popErrorScope();
    expect(error?.message ?? null).toBeNull();
    expect(drew).toBe(true);
    const px = await readPixels(gpu, tex);
    if (name) await saveFrame(`cards ${name}`, px);
    return px;
  }

  /** The group alone, once its builds are in. */
  async function drawn(group: GameGroup, name = ''): Promise<Pixels> {
    r.setStatic([group]);
    await r.prepare();
    return draw(name);
  }

  /** The mean of the green channel in a block of `size` pixels about (x, y). */
  const green = (p: Pixels, x: number, y: number, size = 10) => meanIn(p, Math.round(x - size / 2), Math.round(y - size / 2), Math.round(x + size / 2), Math.round(y + size / 2))[1];
  /** The offset of a corner's block from the middle, in pixels: well inside the square, and well outside the disc. */
  const CORNER = SQUARE_PX / 2 - 12;
  const corners = (p: Pixels) => [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) => green(p, MID + sx * CORNER, MID + sy * CORNER));

  describe('the colour pass', () => {
    for (const [name, shading, antialias] of [['plain', 'pbr', undefined], ['four samples', 'pbr', 'msaa'], ['toon', 'toon', undefined]] as const) {
      it(`draws a disc from a square wearing a disc mask: the corners show the background, the middle the albedo (${name})`, async () => {
        r.look = { ...r.look, shading, antialias, ...(shading === 'toon' ? HARD : {}) };
        r.setCardImages([await disc()]);
        await r.prepare();
        const bare = await drawn(square());
        const cut = await drawn(square(1), `disc ${name}`);
        const background = green(bare, 12, 12);
        const albedo = green(bare, MID, MID);
        // the square is solid green with no card, and the background is dark
        expect(albedo).toBeGreaterThan(background + 40);
        expect(corners(bare).every((c) => c > background + 40), 'a square without a card fills its corners').toBe(true);
        for (const c of corners(cut)) expect(c, 'a corner of the card shows the background').toBeCloseTo(background, 0);
        // the middle is the card's albedo, lit as the square is
        expect(Math.abs(green(cut, MID, MID) - albedo), 'the middle').toBeLessThanOrEqual(2);
        // the cut takes the square's four corners and leaves the disc: 1 - pi * (28/64)^2, two fifths of the square
        const gone = differing(bare, cut);
        expect(gone).toBeGreaterThan(0.3 * SQUARE_PX * SQUARE_PX);
        expect(gone).toBeLessThan(0.5 * SQUARE_PX * SQUARE_PX);
      });
    }

    it('lights the back of a card as its front: turned to show its back, the middle is within a toon band of the front, and not without the flip', async () => {
      r.setCardImages([await disc()]);
      for (const shading of ['pbr', 'toon'] as const) {
        r.look = { ...r.look, shading, ...(shading === 'toon' ? HARD : {}) };
        const front = await drawn(square(1), `front ${shading}`);
        const back = await drawn(square(1, {}, 1, turned()), `back ${shading}`);
        const f = green(front, MID, MID), b = green(back, MID, MID);
        expect(f, `${shading}: the front is lit`).toBeGreaterThan(40);
        expect(Math.abs(f - b), `${shading}: front ${f}, back ${b}`).toBeLessThanOrEqual(2);
        // and it is still a disc from behind
        for (const c of corners(back)) expect(c).toBeLessThan(f * 0.5);
      }
    });

    it('repeats a mask past one: uvs of nought to two show four discs, touching at the middle', async () => {
      r.setCardImages([await disc()]);
      const four = await drawn(square(1, {}, 2), 'four discs');
      const q = SQUARE_PX / 4;
      const background = green(four, 12, 12);
      const albedo = green(await drawn(square()), MID, MID);
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) expect(green(four, MID + sx * q, MID + sy * q), 'the middle of a tile').toBeGreaterThan(albedo - 3);
      expect(green(four, MID, MID), 'where four tiles meet').toBeCloseTo(background, 0);
      // a tile's own corner, at the square's: further from its disc's middle than the disc is wide
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) expect(green(four, MID + sx * (SQUARE_PX / 2 - 8), MID + sy * (SQUARE_PX / 2 - 8), 6), 'the corner').toBeCloseTo(background, 0);
    });

    it('keeps a pattern the group has, and a card with none is the same as one with the kind nought', async () => {
      r.setCardImages([await disc()]);
      const speckle = new Float32Array(PATTERN_STRIDE);
      speckle[0] = 4; speckle[1] = 2; speckle[4] = 1; speckle[5] = 1; speckle[6] = 1;
      const plain = await drawn(square(1));
      const patterned = await drawn(square(1, { patterns: speckle }));
      expect(differing(plain, patterned), 'the speckle shows on the card').toBeGreaterThan(500);
      for (const c of corners(patterned)) expect(c, 'and the card is still cut').toBeCloseTo(green(plain, 12, 12), 0);
    });

    it('draws a card at the placement\'s own scale and position, with a cut of its own', async () => {
      r.setCardImages([await disc()]);
      // a cut of nought keeps everything the mask draws, even its transparent texels: the square
      const solid = await drawn(square(1, { card: { layer: 1, cut: 0 } }));
      for (const c of corners(solid)) expect(c).toBeGreaterThan(green(solid, 12, 12) + 40);
      // a cut over the mask's opaque alpha throws the whole card away
      const gone = await drawn(square(1, { card: { layer: 1, cut: 1.01 } }));
      expect(differing(gone, await drawn({ mesh: card(), matrices: new Float32Array(16), count: 0 })), 'nothing of it is left').toBe(0);
    });
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

    it('make no pipeline for cards until a group asks, and an image set with no group wearing it makes one for the mips', async () => {
      await counting(async (made) => {
        const fresh = await make();
        expect(made(), 'pipelines made before ready').toBe(PIPELINES_AT_0_19);
        fresh.setStatic([square()]);
        fresh.setDynamic([square()]);
        await fresh.prepare();
        expect(made(), 'pipelines made by groups that are not cards').toBe(PIPELINES_AT_0_19);
        fresh.setCardImages([await disc()]);
        expect(made(), 'images set and no group wearing them: the mips\' pass alone').toBe(PIPELINES_AT_0_19 + MIP_PIPELINES);
        fresh.setCardImages([await disc(), await disc(20)]);
        fresh.setCardImages(null);
        expect(made(), 'and not made again for the next').toBe(PIPELINES_AT_0_19 + MIP_PIPELINES);
        fresh.setStatic([square(1)]);
        expect(made(), 'the first card group').toBe(PIPELINES_AT_0_19 + MIP_PIPELINES + CARDED_BUILDS + CUT_DEPTH_BUILDS);
        await fresh.prepare();
        fresh.setStatic([square(1)]);
        fresh.setDynamic([square(1)]);
        await fresh.prepare();
        expect(made(), 'and not made again for the next').toBe(PIPELINES_AT_0_19 + MIP_PIPELINES + CARDED_BUILDS + CUT_DEPTH_BUILDS);
        fresh.dispose();
      });
    });

    it('are in at four samples as well, whichever of the two is asked for first', async () => {
      await counting(async (made) => {
        const images = [await disc()];
        // four samples first, the cards after: the carded builds at one sample and at four
        const a = await make();
        a.look = { ...a.look, antialias: 'msaa' };
        await a.prepare();
        a.setCardImages(images);
        const before = made();
        a.setStatic([square(1)]);
        await a.prepare();
        expect(made() - before, 'the carded builds, at one sample and at four, and the two cut depth passes').toBe(CARDED_BUILDS * 2 + CUT_DEPTH_BUILDS);
        a.dispose();
        // the cards first, four samples after: the ordinary builds' four-sample copies, which are the same count as
        // without cards, and the carded ones, which are made as the four-sample builds are
        const c = await make();
        const base = made();
        c.look = { ...c.look, antialias: 'msaa' };
        await c.prepare();
        const ordinary = made() - base;
        c.dispose();
        const b = await make();
        b.setCardImages(images);
        b.setStatic([square(1)]);
        await b.prepare();
        const mid = made();
        b.look = { ...b.look, antialias: 'msaa' };
        await b.prepare();
        expect(made() - mid, 'four samples after the cards: the ordinary copies and the carded').toBe(ordinary + CARDED_BUILDS);
        b.dispose();
      });
    });

    /** A renderer whose card builds have not been asked for, which the shared one's have. */
    async function fresh(): Promise<GameRenderer> {
      const f = await make();
      f.look = { ...f.look, sunColour: [1, 1, 1], ambient: 0.2, exposure: 1, sunDir: [0.3, -0.4, 0.86] };
      f.setCardImages([await disc()]);
      return f;
    }

    it('draw the group square until they are in, and cut after', async () => {
      const f = await fresh();
      f.setStatic([square()]);
      await f.prepare();
      const bare = await draw('', 'redraw', f);
      f.setStatic([square(1)]);
      // not yet awaited: the first frame is a frame, and a square; after prepare it is the cut one
      const early = await draw('', 'redraw', f);
      expect(differing(early, bare), 'drawn uncut until its build is in').toBe(0);
      await f.prepare();
      const late = await draw('', 'redraw', f);
      expect(differing(late, bare)).toBeGreaterThan(5000);
      f.dispose();
    });

    it('re-bake a kept frame when they land: a static card handed in before its builds is square, then cut', async () => {
      const f = await fresh();
      f.setStatic([square(1)]);
      const early = await draw('', 'keep', f);
      const background = green(early, 12, 12);
      for (const c of corners(early)) expect(c, 'baked before the builds landed: the square').toBeGreaterThan(background + 40);
      await f.prepare();
      const late = await draw('kept cut', 'keep', f);
      for (const c of corners(late)) expect(c, 'and the kept half drawn again once they have').toBeCloseTo(background, 0);
      f.dispose();
    });

    it('draw a kept static card and a moving one together, each cut', async () => {
      r.setCardImages([await disc()]);
      r.setStatic([square(1)]);
      r.setDynamic([square(1, {}, 1, at(0.4, 40, 0, 1))]);
      await r.prepare();
      const kept = await draw('', 'keep');
      const again = await draw('', 'redraw');
      expect(differing(kept, again), 'keep and redraw agree').toBe(0);
    });
  });

  describe('the mips', () => {
    /** The real leaf's alpha, 256 across, as a white image: drawn as a game would make it, with the alpha unfolded. */
    async function leaf(): Promise<ImageBitmap> {
      const alpha = Uint8Array.from(atob(leafAlpha.trim()), (c) => c.charCodeAt(0));
      const data = new Uint8ClampedArray(256 * 256 * 4).fill(255);
      for (let i = 0; i < alpha.length; i++) data[i * 4 + 3] = alpha[i];
      return createImageBitmap(new ImageData(data, 256, 256), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    }

    /** The share of the card's bounding pixels (a box of `side` about the middle) that are not the background. */
    function share(p: Pixels, side: number, background: number): number {
      const half = Math.round(side / 2);
      let n = 0, all = 0;
      for (let y = MID - half; y < MID + half; y++)
        for (let x = MID - half; x < MID + half; x++) {
          all++;
          if (p.rgb[(y * p.width + x) * 3 + 1] > background + 20) n++;
        }
      return n / all;
    }

    /** A spray of small leaflets, 5 to 9 texels across, thinly set: the features a box filter blurs under the cut within three levels. */
    async function leaflets(): Promise<ImageBitmap> {
      const canvas = new OffscreenCanvas(256, 256);
      const g = canvas.getContext('2d')!;
      g.fillStyle = '#ffffff';
      let seed = 12345;
      const next = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
      for (let i = 0; i < 90; i++) {
        const a = next() * Math.PI * 2, d = Math.sqrt(next()) * 115;
        g.beginPath();
        g.ellipse(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 5 + next() * 4, 2 + next() * 2, next() * Math.PI, 0, Math.PI * 2);
        g.fill();
      }
      return createImageBitmap(canvas, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    }

    /**
     * The footprints drawn: a side as a share of the full one. A quarter is a sixteenth of the area. 0.2192 and 0.1096
     * put a texel of the third and the fourth level on a pixel exactly. Between two levels the trilinear blend of two
     * sparse masks thins the cut by itself, and no scale chosen level by level can cure it: a spray of small leaflets
     * at a quarter holds 0.056 of the pixels against 0.081 at full size (0.034 with the scale off), and the sums say
     * why in the note on `cardLevels`. So the spray is held on the levels and the real leaf, whose features are big,
     * at a quarter.
     */
    const cases = [
      ['a real leaf', leaf, 0.25],
      ['a spray of leaflets', leaflets, 0.2192],
      ['a spray of leaflets', leaflets, 0.1096],
    ] as const;
    for (const [name, make, k] of cases) {
      it(`keeps the coverage of ${name} at a distance: drawn at ${k} across it covers within 10% of the share it covers at full size`, async () => {
        r.setCardImages([await make()]);
        await r.prepare();
        const full = await drawn(square(1), `${name} full`);
        const small = await drawn(square(1, {}, 1, at(k)), `${name} ${k}`);
        const background = green(full, 12, 12);
        const big = share(full, SQUARE_PX, background), little = share(small, SQUARE_PX * k, background);
        expect(big, 'it covers part of its square').toBeGreaterThan(0.05);
        expect(Math.abs(little - big) / big, `full ${big.toFixed(4)}, small ${little.toFixed(4)}`).toBeLessThan(0.1);
      });
    }

    /** A big solid disc, a radius of 0.35 of the side: it loses nothing under mips, so it trusts the measurement. */
    async function bigDisc(): Promise<ImageBitmap> {
      const canvas = new OffscreenCanvas(256, 256);
      const g = canvas.getContext('2d')!;
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(128, 128, 90, 0, Math.PI * 2);
      g.fill();
      return createImageBitmap(canvas, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    }

    /** One of the game's own masks: a 256 square PNG of the kit (CC0, Quaternius), kept as base64 text. */
    const kit = (png: string) => async () => {
      const bytes = Uint8Array.from(atob(png.trim()), (c) => c.charCodeAt(0));
      return createImageBitmap(new Blob([bytes], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    };

    /**
     * The sweep: twelve sizes evenly on a log scale from full to `smallest`, each held to `limit` of the full-size share;
     * and, as information only, six smaller ones, printed with VITE_SWEEP set and not asserted. Held only down to 0.317
     * because that is as far as the instrument is good: a big solid disc, which loses nothing under mips, strays by
     * 4 to 5% by 0.4 and 7.5% by 0.1 from the whole pixels it is counted in, with the scale off as on. The leaflets are
     * held only to 0.434, which is a measured limit: the fit leaves them 11.3% under at 0.352 and 11.7% at 0.317.
     */
    const SWEEPS = [
      ['a big solid disc', bigDisc, 0.05, 0.317],
      ['a spray of leaflets', leaflets, 0.1, 0.434],
      ['the kit\'s Flowers', kit(maskFlowers), 0.1, 0.317],
      ['the kit\'s Leaf_Pine_C', kit(maskPine), 0.1, 0.317],
      ['the kit\'s Leaves', kit(maskLeaves), 0.1, 0.317],
      ['the kit\'s Leaves_NormalTree_C', kit(maskNormal), 0.1, 0.317],
      ['the kit\'s Leaves_TwistedTree_C', kit(maskTwisted), 0.1, 0.317],
    ] as const;
    const INFORMATION = [0.25, 0.2, 0.159, 0.127, 0.101, 0.08];

    for (const [name, make, limit, smallest] of SWEEPS)
      it(`holds the coverage of ${name} at every distance, not only on a level: twelve sizes from full to ${smallest} across, evenly on a log scale, each within ${limit * 100}% of the full-size share`, async () => {
        r.setCardImages([await make()]);
        await r.prepare();
        const background = green(await drawn(square(1)), 12, 12);
        // a share counted in whole pixels wanders by the pixel grid the edge falls on, so each size is drawn at sixteen sub-pixel phases and the shares averaged
        const phases = Array.from({ length: 16 }, (_, j) => [((j % 4) + 0.5) / 4 - 0.5, (Math.floor(j / 4) + 0.5) / 4 - 0.5]);
        const averaged = async (k: number) => {
          let sum = 0;
          for (const [px, py] of phases) sum += share(await drawn(square(1, {}, 1, at(k, px / PX_PER_UNIT, py / PX_PER_UNIT))), SQUARE_PX * k + 4, background) * ((SQUARE_PX * k + 4) / (SQUARE_PX * k)) ** 2;
          return sum / phases.length;
        };
        const bigShare = await averaged(1);
        const row = async (k: number) => {
          const little = await averaged(k);
          const error = (little - bigShare) / bigShare;
          return { error, text: `${k.toFixed(3)} ${little.toFixed(4)} ${(error * 100).toFixed(1)}%` };
        };
        const rows: string[] = [];
        let worst = 0;
        for (let i = 0; i < 12; i++) {
          const { error, text } = await row(Math.exp((Math.log(smallest) * i) / 11));
          worst = Math.max(worst, Math.abs(error));
          rows.push(text);
        }
        if (import.meta.env.VITE_SWEEP) {
          const more = [];
          for (const k of INFORMATION) more.push((await row(k)).text);
          console.log(`SWEEP ${name} full ${bigShare.toFixed(4)}\n${rows.join('\n')}\n-- information only\n${more.join('\n')}`);
        }
        expect(worst, `full ${bigShare.toFixed(4)}; size, share, error:\n${rows.join('\n')}`).toBeLessThan(limit);
      });
  });

  describe('alpha to coverage, at four samples', () => {
    /** A big solid disc, a radius of 0.35 of the side: it loses nothing under mips, so it trusts the measurement. */
    async function bigDisc(): Promise<ImageBitmap> {
      const canvas = new OffscreenCanvas(256, 256);
      const g = canvas.getContext('2d')!;
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(128, 128, 90, 0, Math.PI * 2);
      g.fill();
      return createImageBitmap(canvas, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    }

    /** The leaflets of the one-sample sweep: small and thinly set, which a hard cut thins at a distance. */
    async function leaflets(): Promise<ImageBitmap> {
      const canvas = new OffscreenCanvas(256, 256);
      const g = canvas.getContext('2d')!;
      g.fillStyle = '#ffffff';
      let seed = 12345;
      const next = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
      for (let i = 0; i < 90; i++) {
        const a = next() * Math.PI * 2, d = Math.sqrt(next()) * 115;
        g.beginPath();
        g.ellipse(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 5 + next() * 4, 2 + next() * 2, next() * Math.PI, 0, Math.PI * 2);
        g.fill();
      }
      return createImageBitmap(canvas, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    }

    /** The post pass's display curve, undone: a pixel is the blend of samples in linear light, so its share is counted there. */
    const linear = (v: number) => (v / 255) ** 2.2;

    /**
     * The share of a box of `side` pixels the card covers, counted softly: a pixel's share is how far it is from the
     * background toward the card's own colour, on the green channel, where the two differ by a wide margin. A hard
     * threshold would count a half-covered pixel as all or none, which is the very thing alpha to coverage is not.
     */
    function softShare(p: Pixels, side: number, background: number, card: number): number {
      const half = Math.round(side / 2), b = linear(background), c = linear(card);
      let sum = 0, all = 0;
      for (let y = MID - half; y < MID + half; y++)
        for (let x = MID - half; x < MID + half; x++) {
          all++;
          sum += Math.min(1, Math.max(0, (linear(p.rgb[(y * p.width + x) * 3 + 1]) - b) / (c - b)));
        }
      return sum / all;
    }

    /** Twelve sizes from full to `smallest`, evenly on a log scale, each at sixteen sub-pixel phases, as the one-sample sweep does. */
    async function sweep(make: () => Promise<ImageBitmap>, antialias: 'msaa' | undefined, smallest: number) {
      r.look = { ...r.look, antialias };
      r.setCardImages([await make()]);
      await r.prepare();
      const bare = await drawn(square());
      const background = green(bare, 12, 12), albedo = green(bare, MID, MID);
      const phases = Array.from({ length: 16 }, (_, j) => [((j % 4) + 0.5) / 4 - 0.5, (Math.floor(j / 4) + 0.5) / 4 - 0.5]);
      const averaged = async (k: number) => {
        let sum = 0;
        for (const [px, py] of phases) sum += softShare(await drawn(square(1, {}, 1, at(k, px / PX_PER_UNIT, py / PX_PER_UNIT))), SQUARE_PX * k + 4, background, albedo) * ((SQUARE_PX * k + 4) / (SQUARE_PX * k)) ** 2;
        return sum / phases.length;
      };
      const full = await averaged(1);
      // the sweep is relative, so a card that was not cut at all would pass it: the full-size share is held to the mask's own
      const probe = new OffscreenCanvas(256, 256).getContext('2d')!;
      probe.drawImage(await make(), 0, 0);
      const alpha = probe.getImageData(0, 0, 256, 256).data;
      let inside = 0;
      for (let i = 3; i < alpha.length; i += 4) if (alpha[i] >= 128) inside++;
      const mask = inside / 65536;
      const rows: string[] = [];
      let worst = 0;
      for (let i = 0; i < 12; i++) {
        const k = Math.exp((Math.log(smallest) * i) / 11);
        const little = await averaged(k), error = (little - full) / full;
        worst = Math.max(worst, Math.abs(error));
        rows.push(`${k.toFixed(3)} ${little.toFixed(4)} ${(error * 100).toFixed(1)}%`);
      }
      if (import.meta.env.VITE_SWEEP) console.log(`SWEEP ${antialias ?? 'one sample'} full ${full.toFixed(4)}\n${rows.join('\n')}`);
      return { full, worst, rows, mask };
    }

    it('counts a big solid disc at four samples over the sweep to within 5% of its full-size share: the instrument', async () => {
      const { full, worst, rows, mask } = await sweep(bigDisc, 'msaa', 0.317);
      expect(Math.abs(full - mask) / mask, `the card at full size covers ${full.toFixed(4)} and its mask ${mask.toFixed(4)}`).toBeLessThan(0.1);
      expect(worst, `full ${full.toFixed(4)}; size, share, error:\n${rows.join('\n')}`).toBeLessThan(0.05);
    });

    it('holds the coverage of a spray of leaflets at four samples over twelve sizes from full to 0.317, within 10% of the full-size share, where one sample holds only to 0.434', async () => {
      const { full, worst, rows, mask } = await sweep(leaflets, 'msaa', 0.317);
      expect(Math.abs(full - mask) / mask, `the card at full size covers ${full.toFixed(4)} and its mask ${mask.toFixed(4)}`).toBeLessThan(0.1);
      expect(worst, `full ${full.toFixed(4)}; size, share, error:\n${rows.join('\n')}`).toBeLessThan(0.1);
    });

    it('shows partial pixels along a card\'s edge at four samples, and almost none at one: the coverage is what is drawn, not a step', async () => {
      const between = (p: Pixels, bare: Pixels) => {
        const bg = green(bare, 12, 12), card = green(bare, MID, MID), margin = (card - bg) * 0.1;
        // inside the square, clear of its own outline, which four samples soften as well
        const half = Math.floor(SQUARE_PX / 2) - 4;
        let n = 0;
        for (let y = MID - half; y < MID + half; y++)
          for (let x = MID - half; x < MID + half; x++) {
            const g = p.rgb[(y * p.width + x) * 3 + 1];
            if (g > bg + margin && g < card - margin) n++;
          }
        return n;
      };
      r.setCardImages([await disc()]);
      const counts: number[] = [];
      for (const antialias of [undefined, 'msaa'] as const) {
        r.look = { ...r.look, antialias };
        await r.prepare();
        counts.push(between(await drawn(square(1), `edge ${antialias ?? 'one'}`), await drawn(square())));
      }
      // the disc's edge, a circle of some 100 pixels' radius, is some three hundred pixels long
      expect(counts[0], 'one sample cuts hard').toBeLessThan(10);
      expect(counts[1], `four samples: ${counts[1]} pixels strictly between the background and the card`).toBeGreaterThan(100);
    });
  });

  describe('the refusals', () => {
    it('refuse, by name, what cannot be a card', async () => {
      r.setCardImages([await disc()]);
      const noUvs: Mesh = { ...card(), uvs: new Float32Array(0) };
      expect(() => r.setStatic([{ ...square(1), mesh: noUvs }])).toThrow(/card.*uvs/);
      const flow = new Float32Array(PATTERN_STRIDE);
      packFlow(flow, 0, { kind: FLOW_RIPPLE, scale: 1, speed: 0, glow: 0, second: [1, 1, 1] });
      expect(() => r.setStatic([square(1, { patterns: flow })])).toThrow(/card.*flow/);
      const tex = packTexture(new Float32Array(TEXTURE_STRIDE), 0, { layer: 1, repeat: 0.1, albedo: 1, shade: 0 });
      expect(() => r.setStatic([square(1, { texture: tex })])).toThrow(/card.*texture/);
      expect(() => r.setStatic([square(1, { card: { layer: 0 } })])).toThrow(/card.*layer/);
      expect(() => r.setStatic([square(1, { card: { layer: 1.5 } })])).toThrow(/card.*layer/);
      expect(() => r.setStatic([square(1, { card: { layer: 1, cut: Number.NaN } })])).toThrow(/card.*cut/);
      // a texture that names no layer is not a texture
      expect(() => r.setStatic([square(1, { texture: new Float32Array(TEXTURE_STRIDE) })])).not.toThrow();
      // and the images are refused by name, as the ground's layers are
      const odd = new OffscreenCanvas(48, 48);
      odd.getContext('2d')!.fillRect(0, 0, 48, 48);
      expect(() => r.setCardImages([])).toThrow(/setCardImages/);
      expect(() => r.setCardImages([fake(odd)])).toThrow(/setCardImages.*power of two/);
    });
  });
});

/** An image of the canvas's size, to be refused before it is read: only its width and height are looked at. */
function fake(c: OffscreenCanvas): ImageBitmap {
  return { width: c.width, height: c.height, close() {} } as unknown as ImageBitmap;
}
