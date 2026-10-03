/**
 * Particles and sprites fogged by their own distance, on a real device.
 *
 * The march fogs each pixel to the depth the scene wrote, and a particle
 * writes none, so one drawn in front of open sky was fogged as if it stood at
 * the fog's reach. `GameRenderer.particleFog = 'own'` draws them after the fog,
 * each fogged in its own shader by the distance to the fragment. Held here:
 * that a game which does not ask draws the same pixels it did at v0.24.0;
 * that the cause is cured, and that a particle comes out as an opaque surface
 * of its colour does at its distance; that a hill still hides what is behind
 * it, with four samples a pixel and with one; that the WGSL is the TypeScript
 * in `fog.ts`; and the rest of the checklist.
 *
 * "The same to the pixel" is held two ways. In the run, `'behind'` set out
 * loud draws the same as leaving it alone. Against the old code, a hash of
 * the pixels of four scenes was written at 9cf02e5, before any of the change,
 * into `particlefog-golden.json` under the adapter's key, and is checked here;
 * a hash is a fact about one GPU's rounding, so an adapter with none skips
 * that test and says so, and `VITE_GOLDEN=1` writes this adapter's, which is
 * only to be done on the old code.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server } from '@vitest/browser/context';
import { createDevice, shader, type Gpu } from '../../gpu/context';
import { Camera } from '../../gpu/camera';
import { MeshBuilder, type Mesh } from '../../mesh/types';
import { bakeEnvironment } from '../../render/env';
import { FULL_ECONOMY, GameRenderer, type GameGroup } from '../renderer';
import { LightPool } from '../lights';
import { FOG_AHEAD_WGSL, FOG_PHASE_WGSL, FOG_STRUCT_WGSL, FOG_FLOATS, NO_FOG, fogAhead, fogUniform, type Fog } from '../fog';
import { SPRITE_CAPACITY, SPRITE_STRIDE, type Emit } from '../particles';
import { differing, readPixels, saveFrame, type Pixels } from './frame';

const SIZE = 193;
const MID = (SIZE - 1) / 2;
const GOLDEN = 'src/game/__tests__/particlefog-golden.json';
const WRITE_GOLDEN = !!import.meta.env.VITE_GOLDEN;

/** A unit box standing on its base, each face its own four corners. */
function box(): Mesh {
  const b = new MeshBuilder();
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, -1, 0], [0, 0, 1]],
    [[0, 1, 0], [-1, 0, 0], [0, 0, 1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [n, u, v] of faces) {
    const base = b.vertexCount;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = [0, 1, 2].map((k) => (n[k] + su * u[k] + sv * v[k]) / 2 + (k === 2 ? 0.5 : 0));
      b.vertex(p[0], p[1], p[2], n[0], n[1], n[2], 0, 0);
    }
    b.quad(base, base + 1, base + 2, base + 3);
  }
  return b.build();
}

/** A box `w` by `d` by `h`, its base centre at `x`, `y`, `z`: in millimetres until scaled. */
function block(w: number, d: number, h: number, x: number, y: number, z: number, albedo: [number, number, number], u = 1): GameGroup {
  const m = new Float32Array(16);
  m[0] = w * u; m[5] = d * u; m[10] = h * u; m[12] = x * u; m[13] = y * u; m[14] = z * u; m[15] = 1;
  return { mesh: box(), matrices: m, albedo, roughness: 0.9 };
}

/** A wall across the whole view at distance `d` from the eye, which is at height 120. */
const wall = (d: number, u = 1) => block(8000, 200, 8000, 0, d + 100, 120 - 4000, [0.5, 0.45, 0.4], u);

/** The haze: its lengths in millimetres and its density a millimetre, in a world of `mm` millimetres to the unit as `noFog` does it. */
function haze(mm = 1): Fog {
  return { ...NO_FOG, density: 8e-4 * mm, base: 0, height: 300 / mm, reach: 1200 / mm, colour: [0.6, 0.7, 0.85], ambient: 0.6, anisotropy: 0, steps: 48, cones: 0 };
}

/** One sprite as `setSprites` takes it. */
function sprites(...list: { at: [number, number, number]; size: number; colour: [number, number, number]; alpha: number }[]): Float32Array {
  const out = new Float32Array(Math.max(1, list.length) * SPRITE_STRIDE);
  list.forEach((s, i) => out.set([...s.at, s.size, ...s.colour, s.alpha], i * SPRITE_STRIDE));
  return out;
}

/** The decoded half float. */
function half(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

/** The frame before the tone map, as floats, four a pixel. */
async function readHdr(gpu: Gpu, texture: GPUTexture): Promise<Float32Array> {
  const { width, height } = texture;
  await gpu.queue.onSubmittedWorkDone();
  const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
  const buffer = gpu.device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = gpu.device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, [width, height, 1]);
  gpu.queue.submit([enc.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const raw = new Uint16Array(buffer.getMappedRange().slice(0));
  buffer.unmap(); buffer.destroy();
  const out = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width * 4; x++) out[y * width * 4 + x] = half(raw[y * (bytesPerRow / 2) + x]);
  return out;
}

/** A hash of the pixels, which says only whether two frames are the same. */
function fnv(p: Pixels): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < p.rgb.length; i++) h = Math.imul(h ^ p.rgb[i], 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

describe('particles and sprites fogged by their own distance', () => {
  let gpu: Gpu;
  let env: { specular: GPUTexture; brdf: GPUTexture; mips: number };
  const renderers: { r: GameRenderer; target: GPUTexture }[] = [];

  beforeAll(async () => {
    gpu = await createDevice();
    const baked = bakeEnvironment(gpu, 'studio', { size: 32, mips: 3 });
    await baked.samples;
    env = baked;
  });
  afterAll(() => {
    for (const x of renderers) { x.r.dispose(); x.target.destroy(); }
    gpu?.device.destroy();
  });

  interface Options {
    msaa?: boolean;
    own?: boolean;
    mm?: number;
    size?: number;
    fog?: Partial<Fog> | null;
    groups?: GameGroup[];
  }

  /**
   * A renderer over black, the haze on, the post chain made flat so the
   * frame is the colours that were asked for, looking level along +y from
   * height 120. Ready, and with whatever the options ask compiled.
   */
  async function make(o: Options = {}) {
    const u = 1 / (o.mm ?? 1);
    const r = new GameRenderer(gpu, 8, 8, 4096, o.mm ?? 1);
    await r.ready;
    const size = o.size ?? SIZE;
    const target = gpu.device.createTexture({ size: [size, size], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    renderers.push({ r, target });
    r.setEnvironment(env.specular, env.brdf, env.mips);
    r.resize(size, size);
    r.setStatic(o.groups ?? []);
    r.setDynamic([]);
    r.setLights(new LightPool(8));
    r.look = { ...r.look, ambient: 0.4, sunDir: [0.3, -0.5, 0.8], sunColour: [0.5, 0.5, 0.5], background: [0, 0, 0], ...(o.msaa ? { antialias: 'msaa' as const } : {}) };
    r.post = { ...r.post, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
    r.camera.position = [0, 0, 120 * u];
    r.camera.target = [0, 1000 * u, 120 * u];
    r.camera.near = 1 * u; r.camera.far = 6000 * u;
    r.gravity = 981 * u;
    if (o.fog !== null) r.fog = { ...haze(o.mm ?? 1), ...o.fog };
    if (o.own) r.particleFog = 'own';
    await r.prepare();
    return { r, view: target.createView(), target, size, u };
  }
  type Scene = Awaited<ReturnType<typeof make>>;

  /** `frames` of a sixtieth of a second, the last one read as pixels. */
  async function shot(s: Scene, frames = 1, mode: 'redraw' | 'keep' = 'redraw'): Promise<Pixels> {
    for (let i = 0; i < frames; i++) s.r.frame(s.view, mode, 1 / 60);
    return readPixels(gpu, s.target);
  }
  /** The same, read before the tone map: the colour at the middle pixel, and its alpha channel left out. */
  async function centre(s: Scene, frames = 1, mode: 'redraw' | 'keep' = 'redraw'): Promise<[number, number, number]> {
    for (let i = 0; i < frames; i++) s.r.frame(s.view, mode, 1 / 60);
    const h = await readHdr(gpu, s.r.hdr.colour!);
    const i = (MID * s.size + MID) * 4;
    return [h[i], h[i + 1], h[i + 2]];
  }
  const near = (a: number[], b: number[], tol: number) => a.every((v, k) => Math.abs(v - b[k]) <= tol * Math.max(Math.abs(b[k]), 0.02));
  const rel = (a: number[], b: number[]) => Math.max(...a.map((v, k) => Math.abs(v - b[k]) / Math.max(Math.abs(b[k]), 0.02)));

  /** What the TypeScript says a thing of colour `c` at `at` comes out as in the haze, over black behind it, at opacity `a`. */
  function expected(c: [number, number, number], at: [number, number, number], a = 1, o: { fog?: Partial<Fog>; mm?: number } = {}) {
    const u = 1 / (o.mm ?? 1);
    const fog = { ...haze(o.mm ?? 1), ...o.fog };
    const look = { sunDir: [0.3, -0.5, 0.8] as [number, number, number], sunColour: [0.5, 0.5, 0.5] as [number, number, number] };
    const f = fogAhead(fog, [0, 0, 120 * u], at, look.sunDir, look.sunColour);
    return c.map((v, k) => (v * f.through + f.scattered[k]) * a);
  }

  // The same sky, wall and smoke for the hash and the in-run comparisons.
  const SMOKE: Emit = { position: [-110, 520, 0], velocity: [0, 0, 70], spread: 25, count: 220, life: 3, size: 16, growth: 6, colour: [0.08, 0.07, 0.07], fade: [0.75, 0.75, 0.78], alpha: 0.7, gravity: -0.1 };
  const PUFFS = sprites(
  { at: [-120, 700, 330], size: 70, colour: [0.9, 0.3, 0.1], alpha: 0.9 },
  { at: [20, 900, 140], size: 110, colour: [0.2, 0.2, 0.25], alpha: 0.8 },
  { at: [90, 100, 130], size: 22, colour: [1, 1, 1], alpha: 0.6 },
);
const HILL: GameGroup[] = [
    block(6000, 6000, 1, 0, 600, -1, [0.1, 0.42, 0.08]),
    block(300, 150, 250, 20, 420, 0, [0.58, 0.3, 0.13]),
  ];

  /** A scene with the haze, a hill, some sprites and some smoke, ten frames in. */
  async function golden(kind: 'plain' | 'msaa' | 'keep' | 'fogless', own = false): Promise<Pixels> {
    const s = await make({ msaa: kind === 'msaa', groups: HILL, own, fog: kind === 'fogless' ? { density: 0 } : {} });
    s.r.camera.position = [0, -600, 160];
    s.r.camera.target = [0, 500, 120];
    s.r.setSprites(PUFFS, 3);
    s.r.emit(SMOKE);
    return shot(s, 10, kind === 'keep' ? 'keep' : 'redraw');
  }
  const KINDS = ['plain', 'msaa', 'keep', 'fogless'] as const;

  describe('a game that does not ask', () => {
    it('leaves the option at behind, and compiles none of what \'own\' needs', async () => {
      const s = await make();
      expect(s.r.particleFog).toBe('behind');
      s.r.setSprites(PUFFS, 3);
      await shot(s, 3);
      expect((s.r.particles as unknown as { own: unknown }).own).toBeNull();
      expect((s.r as unknown as { resolvePipeline: unknown }).resolvePipeline ?? null).toBeNull();
    });

    it('draws the same to the pixel with behind said as with nothing said, in every look', async () => {
      for (const kind of KINDS) {
        const plain = await golden(kind);
        const s = await make({ msaa: kind === 'msaa', groups: HILL, fog: kind === 'fogless' ? { density: 0 } : {} });
        s.r.particleFog = 'behind';
        s.r.camera.position = [0, -600, 160];
        s.r.camera.target = [0, 500, 120];
        s.r.setSprites(PUFFS, 3);
        s.r.emit(SMOKE);
        const said = await shot(s, 10, kind === 'keep' ? 'keep' : 'redraw');
        expect(differing(plain, said), kind).toBe(0);
      }
    });

    it('draws the same pixels as the code at v0.24.0 did, on an adapter with a record of them', async (ctx) => {
      const key = gpu.adapter.key;
      const found: Record<string, string> = {};
      for (const kind of KINDS) {
        const p = await golden(kind);
        await saveFrame(`particlefog-behind-${kind}`, p);
        found[kind] = fnv(p);
      }
      const file = await server.commands.readFile(GOLDEN).catch(() => '');
      const all = file.trim() ? (JSON.parse(file) as Record<string, Record<string, string>>) : {};
      if (WRITE_GOLDEN) {
        all[key] = found;
        await server.commands.writeFile(GOLDEN, JSON.stringify(all, null, 2) + '\n');
        return;
      }
      if (!all[key]) { console.warn(`particlefog: no pixels of v0.24.0 are kept for ${key}, so nothing was held to them`); return ctx.skip(); }
      expect(found).toEqual(all[key]);
    });
  });

  describe('own', () => {
    const sprite = (d: number, colour: [number, number, number] = [0.05, 0.05, 0.05], alpha = 1) => sprites({ at: [0, d, 120], size: 80, colour, alpha });

    it('keeps a sprite in front of open sky fogged as at its distance, where behind all but loses it', async () => {
      const d = 450;
      const sky = await centre(await make());
      const behind = await make();
      behind.r.setSprites(sprite(d), 1);
      const b = await centre(behind);
      const own = await make({ own: true });
      own.r.setSprites(sprite(d), 1);
      const o = await centre(own);
      await saveFrame('particlefog-cause-own', await readPixels(gpu, own.target));
      await saveFrame('particlefog-cause-behind', await readPixels(gpu, behind.target));
      const want = expected([0.05, 0.05, 0.05], [0, d, 120]);
      expect(rel(o, want), 'own, against the closed form').toBeLessThan(0.015);
      // behind: the dark sprite is multiplied by what the sky's ray lets through and has the sky's own haze added, so nearly the sky's colour
      expect(rel(b, sky), 'behind, against the sky').toBeLessThan(0.12);
      // and own is far from the sky, which is the whole of the difference: a sixth less
      expect(o[0]).toBeLessThan(sky[0] * 0.8);
    });

    /** The middle pixel of an opaque wall at `d` in the haze, and of an opaque sprite of the wall's own lit colour at `d`: the two to compare. */
    async function surfaceAndSprite(d: number) {
      // the wall's colour as lit, before any fog, is what the sprite is made
      const c = await centre(await make({ groups: [wall(d)], fog: { density: 0 } }));
      const surface = await centre(await make({ groups: [wall(d)], own: true }));
      const s = await make({ own: true });
      s.r.setSprites(sprites({ at: [0, d, 120], size: 120, colour: c, alpha: 1 }), 1);
      return { c, surface, particle: await centre(s) };
    }

    it('comes out as an opaque surface of its colour does at the same distance, in the same fog', async () => {
      // The march steps along a ray started at a dither, in a half-size texture
      // read back bilinearly; the sprite is the closed form itself, and a hair
      // under opaque at its middle. Measured 0.00%, 0.08% and 0.00% apart at
      // 150, 450 and 700, so one percent is over ten times that wobble, and
      // under a sixth of the 6% the march's taper makes of it past two thirds of
      // the reach (below), and a seventieth of what a particle fogged by the sky
      // behind it is out by (the cause, above). It holds to two thirds of the
      // reach, where the taper begins.
      for (const d of [150, 450, 700]) {
        const { c, surface, particle } = await surfaceAndSprite(d);
        console.log(`d ${d}: opaque surface ${surface.map((v) => v.toFixed(4))} against sprite ${particle.map((v) => v.toFixed(4))}: ${(rel(particle, surface) * 100).toFixed(2)}% apart`);
        expect(rel(particle, surface), `at ${d}`).toBeLessThan(0.01);
        expect(rel(particle, expected(c, [0, d, 120])), `at ${d}, against the closed form`).toBeLessThan(0.015);
      }
    });

    it('is a little hazier than the surface past two thirds of the reach, where the march tapers and the closed form does not', async () => {
      const { surface, particle } = await surfaceAndSprite(1100);
      console.log(`d 1100: surface ${surface.map((v) => v.toFixed(4))} sprite ${particle.map((v) => v.toFixed(4))}: ${(rel(particle, surface) * 100).toFixed(2)}% apart`);
      // the difference is real and small, and said in the docs of `fogAhead`; this holds the doc to the picture (6% measured)
      expect(rel(particle, surface)).toBeGreaterThan(0.02);
      expect(rel(particle, surface)).toBeLessThan(0.15);
    });

    it('fogs a particle as it fogs a sprite: by its distance, over what is behind it, at its own opacity', async () => {
      // a particle's fog is worked out at the corners of its quad and blended across it, which is exact at the middle for a quad that is
      // small against its distance: here a half-width of a tenth, and of a fifth, of the distance, which measured 0.11%, 0.05% and 0.17% off
      for (const [d, size, tolerance] of [[450, 45, 0.005], [150, 15, 0.005], [200, 40, 0.01]] as const) {
        const e: Emit = { position: [0, d, 120], velocity: [0, 0, 0], spread: 0, count: 1, life: 4, size, colour: [0.9, 0.5, 0.2], alpha: 1, gravity: 0 };
        // what it covers of the pixel, as the particle draws it, is the colour it has unfogged over black
        const bare = await make({ fog: { density: 0 } });
        bare.r.emit(e);
        const a = (await centre(bare, 12))[0] / 0.9;
        expect(a).toBeGreaterThan(0.2);
        expect(a).toBeLessThan(0.9);
        // and the sky behind it is the fog's own, since the march runs over empty sky to the reach
        const sky = await centre(await make({ own: true }), 12);
        const s = await make({ own: true });
        s.r.emit(e);
        const got = await centre(s, 12);
        const want = expected([0.9, 0.5, 0.2], [0, d, 120], a).map((v, k) => v + sky[k] * (1 - a));
        console.log(`particle at ${d}, half-width ${size}: ${(rel(got, want) * 100).toFixed(2)}% from the closed form`);
        expect(rel(got, want), `at ${d}, half-width ${size}`).toBeLessThan(tolerance);
      }
    });

    it('is the closed form at a spread of distances, and the same at four samples a pixel', async () => {
      for (const d of [150, 450, 800]) {
        for (const msaa of [false, true]) {
          const s = await make({ own: true, msaa });
          s.r.setSprites(sprite(d, [0.6, 0.2, 0.1]), 1);
          expect(rel(await centre(s), expected([0.6, 0.2, 0.1], [0, d, 120])), `${d} ${msaa ? 'x4' : 'x1'}`).toBeLessThan(0.015);
        }
      }
    });

    it('is still hidden by a hill in front of it, with four samples a pixel and with one', async () => {
      for (const msaa of [false, true]) {
        const wallOnly = await make({ own: true, msaa, groups: [wall(300)] });
        const hidden = await make({ own: true, msaa, groups: [wall(300)] });
        hidden.r.setSprites(sprite(600, [1, 0, 0]), 1);
        const clear = await centre(wallOnly), under = await centre(hidden);
        expect(near(under, clear, 1e-4), `behind the wall ${msaa ? 'x4' : 'x1'}: ${under} against ${clear}`).toBe(true);
        // and in front of it, the very same sprite shows
        const shown = await make({ own: true, msaa, groups: [wall(300)] });
        shown.r.setSprites(sprite(150, [1, 0, 0]), 1);
        const seen = await centre(shown);
        expect(seen[0] / clear[0], `in front of the wall ${msaa ? 'x4' : 'x1'}`).toBeGreaterThan(1.3);
      }
    });

    it('hides smoke behind a hill at the edge of the hill too, not only in its middle', async () => {
      for (const msaa of [false, true]) {
        const hill = [block(100, 100, 150, 0, 350, 0, [0.4, 0.4, 0.4])];
        const without = await make({ own: true, msaa, groups: hill });
        const withSmoke = await make({ own: true, msaa, groups: hill });
        withSmoke.r.setSprites(sprites({ at: [0, 700, 200], size: 160, colour: [1, 0, 0], alpha: 1 }), 1);
        const a = await shot(without), b = await shot(withSmoke);
        await saveFrame(`particlefog-hill-edge-${msaa ? 'x4' : 'x1'}`, b);
        let changed = 0;
        for (let i = 0; i < a.rgb.length; i += 3) if (a.rgb[i] !== b.rgb[i] || a.rgb[i + 1] !== b.rgb[i + 1] || a.rgb[i + 2] !== b.rgb[i + 2]) changed++;
        // the smoke shows around the hill, where some pixels change, and not on it, where the middle one does not
        expect(changed).toBeGreaterThan(200);
        const mid = (MID * SIZE + MID) * 3;
        expect(Math.abs(a.rgb[mid] - b.rgb[mid]) + Math.abs(a.rgb[mid + 1] - b.rgb[mid + 1])).toBe(0);
      }
    });

    it('is not fogged a second time by the march: a sprite and a particle are drawn after it', async () => {
      // with the fog thick, a sprite fogged twice would sit near the fog's own colour; fogged once it is the closed form
      const thick = { density: 3e-3 };
      const s = await make({ own: true, fog: thick });
      s.r.setSprites(sprite(250, [1, 1, 1]), 1);
      expect(rel(await centre(s), expected([1, 1, 1], [0, 250, 120], 1, { fog: thick }))).toBeLessThan(0.015);
    });

    it('is the same as behind, to the pixel, with no fog, and with the fog rung off', async () => {
      for (const msaa of [false, true]) {
        const frames = async (own: boolean, setup: (s: Scene) => void) => {
          const s = await make({ own, msaa, groups: HILL });
          s.r.camera.position = [0, -600, 160]; s.r.camera.target = [0, 500, 120];
          s.r.setSprites(PUFFS, 3); s.r.emit(SMOKE);
          setup(s);
          return shot(s, 8);
        };
        const none = (s: Scene) => { s.r.fog = { ...s.r.fog, density: 0 }; };
        const off = (s: Scene) => { s.r.economy = { ...FULL_ECONOMY, fog: false }; };
        expect(differing(await frames(false, none), await frames(true, none)), `no fog${msaa ? ' x4' : ''}`).toBe(0);
        expect(differing(await frames(false, off), await frames(true, off)), `fog rung off${msaa ? ' x4' : ''}`).toBe(0);
      }
    });

    it('draws nothing with the particles rung off, and the same frame when it is back on', async () => {
      const s = await make({ own: true });
      s.r.setSprites(sprite(300, [1, 0, 0]), 1);
      const on = await shot(s, 2);
      s.r.economy = { ...FULL_ECONOMY, particles: false };
      const off = await shot(s, 2);
      // the same number of frames, since the fog's dither moves with them
      const empty = await make({ own: true });
      empty.r.economy = { ...FULL_ECONOMY, particles: false };
      const emptyPx = await shot(empty, 4);
      expect(differing(off, emptyPx)).toBe(0);
      s.r.economy = { ...FULL_ECONOMY, particles: true };
      // and on again, it is the frame a renderer that was never off draws at the same step
      const never = await make({ own: true });
      never.r.setSprites(sprite(300, [1, 0, 0]), 1);
      expect(differing(await shot(s, 2), await shot(never, 6))).toBe(0);
      expect(differing(on, off)).toBeGreaterThan(100);
    });

    it('is the same frame in keep as in redraw, and moves what moves', async () => {
      const run = async (mode: 'redraw' | 'keep') => {
        const s = await make({ own: true, groups: HILL });
        s.r.camera.position = [0, -600, 160]; s.r.camera.target = [0, 500, 120];
        s.r.setSprites(PUFFS, 3); s.r.emit(SMOKE);
        return shot(s, 6, mode);
      };
      expect(differing(await run('redraw'), await run('keep'))).toBe(0);
      // a sprite moved between two kept frames is seen to move
      const s = await make({ own: true, groups: HILL });
      s.r.setSprites(sprites({ at: [-60, 400, 150], size: 30, colour: [1, 0, 0], alpha: 1 }), 1);
      const a = await shot(s, 2, 'keep');
      s.r.setSprites(sprites({ at: [60, 400, 150], size: 30, colour: [1, 0, 0], alpha: 1 }), 1);
      const b = await shot(s, 2, 'keep');
      expect(differing(a, b)).toBeGreaterThan(50);
    });

    it('takes a full pool and a full list of sprites, and drops what is past them, with no GPU error', async () => {
      gpu.device.pushErrorScope('validation');
      const s = await make({ own: true });
      expect(s.r.setSprites(new Float32Array((SPRITE_CAPACITY + 40) * SPRITE_STRIDE), SPRITE_CAPACITY + 40)).toBeUndefined();
      for (let i = 0; i < 40; i++) s.r.emit({ ...SMOKE, count: 4096 });
      await shot(s, 3);
      expect(s.r.particles.live).toBeLessThanOrEqual(s.r.particles.capacity);
      expect(await gpu.device.popErrorScope()).toBeNull();
    });

    it('draws the same picture twice from the same steps', async () => {
      const run = async () => {
        const s = await make({ own: true, groups: HILL });
        s.r.camera.position = [0, -600, 160]; s.r.camera.target = [0, 500, 120];
        s.r.setSprites(PUFFS, 3); s.r.emit(SMOKE);
        return shot(s, 20);
      };
      const a = await run();
      await saveFrame('particlefog-own', a);
      expect(differing(a, await run())).toBe(0);
    });

    it('is a different picture from behind where there is open sky behind the smoke', async () => {
      const behind = await golden('plain');
      const own = await golden('plain', true);
      expect(differing(behind, own)).toBeGreaterThan(500);
    });

    it('is the same picture in a world a hundred times smaller', async () => {
      const big = await make({ own: true });
      big.r.setSprites(sprite(450, [0.6, 0.2, 0.1]), 1);
      const a = await centre(big);
      const mm = 100, u = 1 / mm;
      const small = await make({ own: true, mm });
      small.r.setSprites(sprites({ at: [0, 450 * u, 120 * u], size: 80 * u, colour: [0.6, 0.2, 0.1], alpha: 1 }), 1);
      expect(rel(await centre(small), a)).toBeLessThan(0.01);
      expect(rel(a, expected([0.6, 0.2, 0.1], [0, 450, 120]))).toBeLessThan(0.015);
    });

    it('survives a resize to one pixel, an odd size and back, at four samples', async () => {
      gpu.device.pushErrorScope('validation');
      const s = await make({ own: true, msaa: true, size: 64 });
      s.r.setSprites(sprite(300, [1, 0, 0]), 1);
      for (const [w, h] of [[1, 1], [37, 53], [64, 64]] as const) {
        s.r.resize(w, h);
        s.r.frame(s.target.createView({ baseMipLevel: 0 }), 'redraw', 1 / 60);
      }
      await gpu.queue.onSubmittedWorkDone();
      expect(await gpu.device.popErrorScope()).toBeNull();
    });

    it('is dropped with the renderer, with nothing of its own left to destroy', async () => {
      const s = await make({ own: true, msaa: true });
      s.r.setSprites(sprite(300), 1);
      await shot(s, 2);
      gpu.device.pushErrorScope('validation');
      s.r.dispose();
      await gpu.queue.onSubmittedWorkDone();
      expect(await gpu.device.popErrorScope()).toBeNull();
      renderers.splice(renderers.findIndex((x) => x.r === s.r), 1);
      s.target.destroy();
    });
  });

  describe('the closed form', () => {
    it('is the same in the WGSL as in the TypeScript, at a set of points', async () => {
      const camera = new Camera();
      camera.position = [10, -40, 120];
      camera.target = [0, 800, 100];
      camera.update();
      const fog: Fog = { ...haze(), height: 250, base: 20, anisotropy: 0.5, ambient: 0.35, colour: [0.55, 0.7, 0.9] };
      const sunDir: [number, number, number] = [0.3, -0.5, 0.8], sunColour: [number, number, number] = [1.6, 1.4, 1.1];
      const points: [number, number, number][] = [
        [10, 410, 120], [10, 410, 121e-6 + 120], [10, 900, 120], [200, 300, 20], [-100, 700, -300], [10, -40, 500],
        [10, -40, 120.001], [10, 20, 125], [10, 1190, 600], [10, 1300, 120], [10, 5000, 20], [300, 600, 20],
        [10, 200, 20], [-500, 200, 800], [10, 600, 20.5], [0, 450, 90], [10, 150, 18], [10, 150, 22], [60, 950, 140],
      ];
      const data = new Float32Array(FOG_FLOATS);
      fogUniform(data, fog, camera, null, sunDir, sunColour, 0, 0);
      const { device } = gpu;
      const module = shader(device, `
        @group(0) @binding(0) var<uniform> fog: Fog;
        @group(0) @binding(1) var<storage, read> points: array<vec4f>;
        @group(0) @binding(2) var<storage, read_write> result: array<vec4f>;
        ${FOG_STRUCT_WGSL}
        ${FOG_PHASE_WGSL}
        ${FOG_AHEAD_WGSL}
        @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
          result[id.x] = fogAhead(points[id.x].xyz);
        }`, 'fog ahead probe');
      const pipe = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
      const make1 = (d: Float32Array<ArrayBuffer>, usage: number) => {
        const b = device.createBuffer({ size: Math.max(16, d.byteLength), usage: usage | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(b, 0, d);
        return b;
      };
      const pts = new Float32Array(points.length * 4);
      points.forEach((p, i) => pts.set([...p, 0], i * 4));
      const ub = make1(data as Float32Array<ArrayBuffer>, GPUBufferUsage.UNIFORM);
      const pb = make1(pts, GPUBufferUsage.STORAGE);
      const out = device.createBuffer({ size: pts.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const read = device.createBuffer({ size: pts.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ub } }, { binding: 1, resource: { buffer: pb } }, { binding: 2, resource: { buffer: out } }] });
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipe); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(points.length); pass.end();
      enc.copyBufferToBuffer(out, 0, read, 0, pts.byteLength);
      device.queue.submit([enc.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const got = new Float32Array(read.getMappedRange().slice(0));
      read.unmap();
      for (const b of [ub, pb, out, read]) b.destroy();
      points.forEach((p, i) => {
        const want = fogAhead(fog, camera.position as [number, number, number], p, sunDir, sunColour);
        const label = `point ${i} ${p}`;
        expect(got[i * 4 + 3], `${label}: through`).toBeCloseTo(want.through, 5);
        for (let k = 0; k < 3; k++) expect(got[i * 4 + k], `${label}: scattered ${k}`).toBeCloseTo(want.scattered[k], 5);
      });
    });
  });
});
