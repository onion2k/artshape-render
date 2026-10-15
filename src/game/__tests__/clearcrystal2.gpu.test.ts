/**
 * Clear water's round two options on a real device (crystal-2, October 2026): `sunLane` and `sunLaneWidth`, a specular
 * lobe toward the true sun that brightens the water where the sun's reflection lies and nowhere else; `causticGlow`,
 * the sun's own light along the caustic lines, which shows them over a bed too dark for the old term to; and
 * `foamGrain`, a finer noise that holes the foam line and touches no water outside it. Each is asked for, and a water
 * that asks for none draws as v0.42.0 did (held by `cleargolden`). Without these a lane could light the water away from
 * the sun, or under a sun below the horizon or in a shadow, a glow could light the dark bed everywhere and not along
 * the lines, and a grain could eat the water round the foam, all unseen. Frames written by VITE_FRAME_DIR.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, FULL_ECONOMY, GameRenderer, PATTERN_STRIDE, type GameGroup } from '../renderer';
import { LightPool } from '../lights';
import { FLOW_CLEAR, packFlow } from '../flow';
import type { ShoreField } from '../shore';
import { differing, readPixels, saveFrame, type Pixels } from './frame';
import { HALF, MUD, bed, box, one, quad, sheet, water } from './clearscene';

const luma = (p: Pixels, i: number) => 0.2126 * p.rgb[i * 3] + 0.7152 * p.rgb[i * 3 + 1] + 0.0722 * p.rgb[i * 3 + 2];

describe("clear water's round two options", () => {
  let gpu: Gpu;
  let env: ReturnType<typeof bakeEnvironment>;

  beforeAll(async () => {
    gpu = await createDevice();
    env = bakeEnvironment(gpu, 'daylight', { size: 32, mips: 3 });
    await env.samples;
  });
  afterAll(() => gpu?.device.destroy());

  /** A renderer and a target of `w` by `h`, the look plain: no tone, bloom or vignette, so a pixel is what the pass wrote. */
  async function rig(w: number, h: number) {
    const target = gpu.device.createTexture({ size: [w, h], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const renderer = new GameRenderer(gpu, 8, 8, 256, 100);
    await renderer.ready;
    renderer.setEnvironment(env.specular, env.brdf, env.mips);
    renderer.resize(w, h);
    renderer.setLights(new LightPool(8));
    renderer.look = { ...renderer.look, shading: 'pbr', antialias: undefined, background: [0.02, 0.02, 0.03], occlusion: 0, sunColour: [1, 1, 1], ambient: 1, exposure: 1 };
    renderer.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
    renderer.economy = { ...FULL_ECONOMY, shadows: false };
    return { renderer, target, dispose: () => { renderer.dispose(); target.destroy(); } };
  }

  async function draw(r: GameRenderer, target: GPUTexture, name: string): Promise<Pixels> {
    await r.prepare();
    gpu.device.pushErrorScope('validation');
    expect(r.frame(target.createView(), 'redraw', 0)).toBe(true);
    expect(r.frame(target.createView(), 'redraw', 0)).toBe(true);
    const error = await gpu.device.popErrorScope();
    expect(error?.message ?? null).toBeNull();
    const p = await readPixels(gpu, target);
    await saveFrame(`crystal2 ${name}`, p);
    return p;
  }

  describe('the sun\'s lane', () => {
    const W = 192;
    const ELEVATION = 20 * (Math.PI / 180);
    const TOWARD: [number, number, number] = [0, Math.cos(ELEVATION), Math.sin(ELEVATION)];
    const CAM = { position: [0, -12, 4] as [number, number, number], target: [0, 4, 0] as [number, number, number] };
    /** Nothing but the lane's own light in the difference between two frames: no foam, glitter, bend or caustics. */
    const ONLY = { foamWidth: 0, glitter: 0, refraction: 0, caustics: 0 };
    const LANE = { sunLane: 0.6, sunLaneWidth: 60 };
    let r: GameRenderer;
    let target: GPUTexture;
    let dispose: () => void;

    beforeAll(async () => {
      ({ renderer: r, target, dispose } = await rig(W, W));
      r.camera.fov = 40; r.camera.near = 1; r.camera.far = 200;
      r.camera.position = [...CAM.position]; r.camera.target = [...CAM.target];
    });
    afterAll(() => dispose?.());

    beforeEach(() => {
      r.look = { ...r.look, sunDir: TOWARD, exposure: 0.5, clear: ONLY };
      r.economy = { ...FULL_ECONOMY, shadows: false };
      r.setSunShadow(null);
      r.time = 1;
      r.setStatic([sheet(24)]);
    });

    /** What the lane adds, a pixel at a time: the frame with the lane less the frame without it. */
    async function gain(clear: object, name: string): Promise<{ add: Float32Array; off: Pixels; on: Pixels }> {
      r.look = { ...r.look, clear: { ...ONLY } };
      const off = await draw(r, target, `${name} off`);
      r.look = { ...r.look, clear: { ...ONLY, ...clear } };
      const on = await draw(r, target, `${name} on`);
      const add = new Float32Array(W * W);
      for (let i = 0; i < add.length; i++) add[i] = luma(on, i) - luma(off, i);
      return { add, off, on };
    }

    /** Where the still plane's point is on the screen, through the renderer's own view and projection. */
    function onScreen(x: number, y: number): [number, number] {
      const vp = r.camera.viewProjection;
      const c = [0, 1, 2, 3].map((row) => vp[row] * x + vp[4 + row] * y + vp[12 + row]);
      return [(c[0] / c[3] * 0.5 + 0.5) * W - 0.5, (0.5 - (c[1] / c[3]) * 0.5) * W - 0.5];
    }
    /**
     * The mass of the gain: how much, the column of its centre and the row of its brightest pixel (not of its centre,
     * which the lens drags toward the near water where a row spans more of it), and the brightest pixel's gain.
     */
    function mass(add: Float32Array) {
      let m = 0, sx = 0, peak = 0, at = 0;
      for (let i = 0; i < add.length; i++) {
        const a = Math.max(add[i], 0);
        m += a; sx += a * (i % W);
        if (a > peak) { peak = a; at = i; }
      }
      return { m, x: sx / m, y: Math.floor(at / W), peak };
    }

    it('brightens the water where the sun\'s reflection lies and not away from it, and adds light only', async () => {
      const { add } = await gain(LANE, 'lane toward');
      const { m, x, y, peak } = mass(add);
      // a mirror sends the view down by the sun's height back up to the sun, so the lane lies where the camera looks
      // down at the sun's elevation, in the sun's direction: a height of four over the tan of twenty degrees out
      const out = CAM.position[2] / Math.tan(ELEVATION);
      const [ex, ey] = onScreen(0, CAM.position[1] + out);
      console.log(`the lane: peak ${peak.toFixed(1)}, centre (${x.toFixed(1)}, ${y.toFixed(1)}), expected (${ex.toFixed(1)}, ${ey.toFixed(1)})`);
      expect(peak, 'a lane that can be seen').toBeGreaterThan(15);
      expect(Math.abs(x - ex), 'centred across the view, under the sun').toBeLessThan(6);
      expect(Math.abs(y - ey), 'at the row the mirror puts the sun on').toBeLessThan(8);
      expect(m, 'light was added').toBeGreaterThan(0);
      // it falls away from the sun's row as the lobe does: at 60 rows nearer, twelve degrees further from the sun's own
      // height, a lobe of power 60 has a quarter of its peak, and the far water, seven degrees short, two thirds
      const column = (row: number) => Math.max(add[row * W + Math.round(ex)], add[row * W + Math.round(ex) - 1]);
      expect(column(Math.round(ey) + 60) / column(Math.round(ey)), 'nearer the camera, a quarter').toBeGreaterThan(0.1);
      expect(column(Math.round(ey) + 60) / column(Math.round(ey))).toBeLessThan(0.5);
      expect(column(Math.round(ey) - 30) / column(Math.round(ey)), 'further, two thirds').toBeGreaterThan(0.4);
      expect(column(Math.round(ey) - 30) / column(Math.round(ey))).toBeLessThan(0.9);
      expect(Math.min(...add), 'no pixel darkened').toBeGreaterThan(-1.01);
    });

    it('draws nothing when the sun is behind the camera, below the horizon, or the lane has no width or no strength', async () => {
      const off = await draw(r, target, 'lane none');
      const same = async (clear: object, sun: [number, number, number], what: string) => {
        r.look = { ...r.look, sunDir: sun, clear: { ...ONLY } };
        const base = await draw(r, target, `${what} base`);
        r.look = { ...r.look, sunDir: sun, clear: { ...ONLY, ...clear } };
        expect(differing(await draw(r, target, what), base), what).toBe(0);
      };
      // so that nothing drawn is not simply a lane that is never drawn: toward the sun, the same lane lights the water
      r.look = { ...r.look, sunDir: TOWARD, clear: { ...ONLY, ...LANE } };
      expect(differing(await draw(r, target, 'lane precondition'), off), 'the lane toward the sun is drawn').toBeGreaterThan(500);
      await same(LANE, [0, -Math.cos(ELEVATION), Math.sin(ELEVATION)], 'the sun behind the camera');
      await same(LANE, [0, Math.cos(ELEVATION), -Math.sin(ELEVATION)], 'the sun below the horizon');
      await same({ sunLane: 0.6 }, TOWARD, 'a strength and no width');
      await same({ sunLaneWidth: 60 }, TOWARD, 'a width and no strength');
      await same({ sunLane: 0, sunLaneWidth: 60 }, TOWARD, 'the strength named nought');
      // and it is not drawn by default: the frame with none named is the one the toward-sun tests subtracted from
      r.look = { ...r.look, sunDir: TOWARD, clear: ONLY };
      expect(differing(await draw(r, target, 'lane none again'), off)).toBe(0);
    });

    it('draws nothing in the sun\'s shadow', async () => {
      // a slab held over the water between the sun and the lane's middle, so its shadow falls on it
      r.economy = { ...FULL_ECONOMY, shadows: true };
      r.setSunShadow({ min: [-8, -8, -1], max: [8, 8, 6] });
      const out = CAM.position[2] / Math.tan(ELEVATION);
      const laneY = CAM.position[1] + out;
      const height = 2;
      const slab: GameGroup = { mesh: box(), matrices: new Float32Array([6, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0.2, 0, 0, laneY + height / Math.tan(ELEVATION), height, 1]), albedo: [0.3, 0.3, 0.3], roughness: 0.9 };
      const centre = onScreen(0, laneY);
      const window = (add: Float32Array) => {
        let s = 0;
        for (let j = Math.round(centre[1]) - 4; j <= Math.round(centre[1]) + 4; j++)
          for (let i = Math.round(centre[0]) - 12; i <= Math.round(centre[0]) + 12; i++) s += Math.max(add[j * W + i], 0);
        return s;
      };
      r.setStatic([sheet(24)]);
      const lit = window((await gain(LANE, 'lane lit')).add);
      r.setStatic([sheet(24), slab]);
      const shaded = window((await gain(LANE, 'lane shaded')).add);
      console.log(`the lane at its middle: ${lit.toFixed(0)} in the sun, ${shaded.toFixed(0)} in the slab's shadow`);
      expect(lit, 'the lane in the sun').toBeGreaterThan(300);
      expect(shaded, 'and in the shadow, a tenth of that at the most').toBeLessThan(lit * 0.1);
    });

    it('is broader at a lower power, and brighter at a higher strength', async () => {
      const lit = async (clear: object, name: string) => {
        const { add } = await gain(clear, name);
        let n = 0;
        for (const a of add) if (a > 6) n++;
        return { n, ...mass(add) };
      };
      const [broad, mid, tight] = [await lit({ sunLane: 0.6, sunLaneWidth: 15 }, 'lane 15'), await lit(LANE, 'lane 60'), await lit({ sunLane: 0.6, sunLaneWidth: 200 }, 'lane 200')];
      console.log(`pixels over 6 levels: ${broad.n} at 15, ${mid.n} at 60, ${tight.n} at 200`);
      expect(broad.n, 'a power of 15 lights more of the sheet than 60').toBeGreaterThan(mid.n * 1.3);
      expect(mid.n, 'and 60 more than 200').toBeGreaterThan(tight.n * 1.3);
      const half = await lit({ sunLane: 0.3, sunLaneWidth: 60 }, 'lane 0.3');
      // the frame is encoded for the screen, so twice the light is less than twice the level
      expect(mid.peak / half.peak, 'twice the strength, more light').toBeGreaterThan(1.4);
      expect(mid.peak / half.peak).toBeLessThan(2.4);
    });

    it('breaks into the fine waves: on a water with swell and the detail layer the lane is not a smooth ramp', async () => {
      // along the lane's row the flat water's gain is a smooth bell; the waves' slopes tip the mirror's direction pixel by pixel
      const rough = (add: Float32Array, y: number) => {
        let worst = 0;
        for (let x = 20; x < W - 20; x++) worst = Math.max(worst, Math.abs(add[y * W + x + 1] - add[y * W + x]));
        return worst;
      };
      const out = CAM.position[2] / Math.tan(ELEVATION);
      const row = Math.round(onScreen(0, CAM.position[1] + out)[1]);
      const flatGain = await gain(LANE, 'lane flat');
      expect(mass(flatGain.add).peak, 'the flat water\'s lane is there').toBeGreaterThan(15);
      const flat = rough(flatGain.add, row);
      r.setStatic([sheet(96, FLOW_CLEAR, 0.5)]);
      const waved = rough((await gain({ ...LANE, detailPixels: 8 }, 'lane waved')).add, row);
      console.log(`the steepest step along the lane's row: ${flat.toFixed(1)} flat, ${waved.toFixed(1)} on waves with the detail layer`);
      expect(flat, 'the flat water\'s lane is smooth').toBeLessThan(3);
      expect(waved, 'the waves\' lane is broken').toBeGreaterThan(Math.max(flat * 2.5, 4));
    });
  });

  describe('the caustics\' glow', () => {
    const W = 192, H = 192;
    const FOV = 3;
    const ONLY = { foamWidth: 0, glitter: 0, refraction: 0, mirror: 0, clarity: 2, causticScale: 1.5 };
    let r: GameRenderer;
    let target: GPUTexture;
    let dispose: () => void;

    /** A flat bed `depth` under the water, of `albedo`, and the water over it with a black deep colour. */
    function bedUnder(depth: number, albedo: [number, number, number]): GameGroup[] {
      const floor = quad([[-HALF, -HALF, -depth], [HALF, -HALF, -depth], [HALF, HALF, -depth], [-HALF, HALF, -depth]]);
      const surface = water();
      return [
        { mesh: floor, matrices: one, albedo, roughness: 0.9 },
        { ...surface, patterns: packFlow(new Float32Array(PATTERN_STRIDE), 0, { kind: FLOW_CLEAR, scale: 0.4, speed: 0.5, glow: 0, second: [0, 0, 0] }) },
      ];
    }
    /** How much the brightness varies over a patch of the bed: lit lines vary, a plain bed does not. */
    function spread(p: Pixels, half = 40) {
      const ls: number[] = [];
      for (let j = H / 2 - half; j < H / 2 + half; j++) for (let i = W / 2 - half; i < W / 2 + half; i++) ls.push(luma(p, j * W + i));
      const mean = ls.reduce((a, b) => a + b, 0) / ls.length;
      return { sd: Math.sqrt(ls.reduce((a, b) => a + (b - mean) ** 2, 0) / ls.length), max: Math.max(...ls), mean };
    }

    beforeAll(async () => {
      ({ renderer: r, target, dispose } = await rig(W, H));
      r.camera.fov = FOV; r.camera.near = 100; r.camera.far = 600;
      r.camera.target = [0, 0, 0]; r.camera.position = [0, -30, 300];
    });
    afterAll(() => dispose?.());
    beforeEach(() => {
      r.look = { ...r.look, sunDir: [0.3, 0, 0.95], exposure: 0.5, clear: ONLY };
      r.time = 1;
      r.setStatic(bedUnder(1, [0, 0, 0]));
    });

    it('lights the caustic lines on a bed too dark for the old term to, and nothing else', async () => {
      r.look = { ...r.look, clear: { ...ONLY, caustics: 1 } };
      const old = await draw(r, target, 'glow old term');
      r.look = { ...r.look, clear: { ...ONLY, caustics: 1, causticGlow: 0 } };
      expect(differing(await draw(r, target, 'glow named nought'), old), 'nought named is nought unnamed').toBe(0);
      r.look = { ...r.look, clear: { ...ONLY, caustics: 1, causticGlow: 1 } };
      const full = await draw(r, target, 'glow 1');
      r.look = { ...r.look, clear: { ...ONLY, caustics: 1, causticGlow: 0.5 } };
      const half = await draw(r, target, 'glow 0.5');
      const [a, b, c] = [spread(old), spread(half), spread(full)];
      console.log(`the dark bed's spread: old term sd ${a.sd.toFixed(2)} max ${a.max.toFixed(1)}; glow 0.5 sd ${b.sd.toFixed(2)} max ${b.max.toFixed(1)}; glow 1 sd ${c.sd.toFixed(2)} max ${c.max.toFixed(1)}`);
      expect(a.sd, 'the old term cannot show a line over a black bed').toBeLessThan(2);
      expect(c.sd, 'the glow shows them').toBeGreaterThan(10);
      expect(c.max - c.mean, 'as bright cores').toBeGreaterThan(40);
      expect(b.sd, 'half the glow, half the light').toBeGreaterThan(a.sd + 3);
      // the frame is encoded for the screen, so twice the light is about 2^(1/2.2) times the spread
      expect(c.sd / b.sd, 'and more with more').toBeGreaterThan(1.2);
      expect(c.sd / b.sd).toBeLessThan(1.7);
      // it only adds: no pixel is darker with it
      let darker = 0;
      for (let i = 0; i < W * H; i++) if (luma(full, i) < luma(old, i) - 1) darker++;
      expect(darker, 'pixels the glow darkened').toBe(0);
    });

    it('is the caustics\' own: none with the caustics at nought, none under a sun below the horizon', async () => {
      r.look = { ...r.look, clear: { ...ONLY, caustics: 0 } };
      const plain = await draw(r, target, 'glow no caustics');
      r.look = { ...r.look, clear: { ...ONLY, caustics: 0, causticGlow: 1 } };
      expect(differing(await draw(r, target, 'glow no caustics, glow'), plain), 'no caustics, no glow').toBe(0);
      // so that nothing drawn is not simply a glow that is never drawn: with the sun up it lights the lines
      r.look = { ...r.look, clear: { ...ONLY, caustics: 1 } };
      const day = await draw(r, target, 'glow day');
      r.look = { ...r.look, clear: { ...ONLY, caustics: 1, causticGlow: 1 } };
      expect(differing(await draw(r, target, 'glow day, glow'), day), 'the glow is drawn under a sun above the horizon').toBeGreaterThan(500);
      r.look = { ...r.look, sunDir: [0.3, 0, -0.95], clear: { ...ONLY, caustics: 1 } };
      const night = await draw(r, target, 'glow below horizon');
      r.look = { ...r.look, sunDir: [0.3, 0, -0.95], clear: { ...ONLY, caustics: 1, causticGlow: 1 } };
      expect(differing(await draw(r, target, 'glow below horizon, glow'), night), 'no sun, no glow').toBe(0);
    });

    it('keeps the old term on a bright bed, the glow beside it', async () => {
      r.setStatic(bedUnder(1, [0.7, 0.62, 0.42]));
      r.look = { ...r.look, clear: { ...ONLY, caustics: 1 } };
      const old = await draw(r, target, 'glow sand old');
      r.look = { ...r.look, clear: { ...ONLY, caustics: 1, causticGlow: 0.6 } };
      const glow = await draw(r, target, 'glow sand 0.6');
      expect(spread(glow).sd, 'more contrast on sand with it').toBeGreaterThan(spread(old).sd * 1.2);
      expect(spread(glow).mean, 'and more light').toBeGreaterThan(spread(old).mean);
      // beside the old term and not in its place: no pixel is darker with the glow than without
      let darker = 0;
      for (let i = 0; i < W * H; i++) if (luma(glow, i) < luma(old, i) - 1) darker++;
      // and the old term is kept: measured, the glow lights the sand by 3.5 levels on average beside it, and by 1.3 where
      // it stands in the old term's place
      const gained = spread(glow).mean - spread(old).mean;
      console.log(`the sand lit ${gained.toFixed(2)} levels more by the glow`);
      expect(gained, 'the old term is kept beside the glow').toBeGreaterThan(2.5);
      expect(darker, 'pixels the glow darkened').toBe(0);
    });
  });

  describe('the foam\'s grain', () => {
    const W = 192, H = 192;
    const DISTANCE = 301.5, FOV = 3;
    const PX_PER_UNIT = H / (2 * DISTANCE * Math.tan((FOV / 2) * (Math.PI / 180)));
    const BED = -1, WEST = -1, EAST = 1, NORTH = 1.5, TOP = 0.3;
    const FOAM = 0.5;
    const LOOK = { clarity: 1, foamWidth: FOAM, glitter: 0, refraction: 0, caustics: 0 };
    const col = (x: number) => Math.round(W / 2 + x * PX_PER_UNIT);
    const row = (y: number) => Math.round(H / 2 - y * PX_PER_UNIT);
    const white = (p: Pixels, x: number, y: number) => {
      const o = (y * p.width + x) * 3;
      return p.rgb[o] > 200 && p.rgb[o + 1] > 200 && p.rgb[o + 2] > 200;
    };
    let r: GameRenderer;
    let target: GPUTexture;
    let dispose: () => void;

    /** A flat bed and an island of a block standing 0.3 over the surface: its shore is where the foam lies. */
    function pond(): GameGroup[] {
      const block = new Float32Array([EAST - WEST, 0, 0, 0, 0, 2 * NORTH, 0, 0, 0, 0, TOP - BED, 0, 0, 0, BED, 1]);
      return [
        { mesh: quad([[-7, -7, BED], [7, -7, BED], [7, 7, BED], [-7, 7, BED]]), matrices: one, albedo: MUD, roughness: 0.9 },
        { mesh: box(), matrices: block, albedo: MUD, roughness: 0.9 },
      ];
    }
    /** A field of the island's shore: the distance from each texel to the island's footprint. */
    function field(size: number): ShoreField {
      const min: [number, number] = [-7, -7], max: [number, number] = [7, 7];
      const distances = new Float32Array(size * size);
      for (let j = 0; j < size; j++)
        for (let i = 0; i < size; i++) {
          const x = min[0] + ((i + 0.5) / size) * (max[0] - min[0]), y = min[1] + ((j + 0.5) / size) * (max[1] - min[1]);
          distances[j * size + i] = Math.hypot(Math.max(WEST - x, 0, x - EAST), Math.max(-NORTH - y, 0, y - NORTH));
        }
      return { size, distances, min, max };
    }
    /** Where each kind of foam lies, and open water well clear of it: [x0, x1, y0, y1] in world units. */
    type Box = [number, number, number, number];
    const SHORE = { foam: [EAST, EAST + 1.4, -1.3, 1.3] as Box, open: [EAST + 2.2, 6.5, -6, 6] as Box };
    /** The depth band of a ramp of mud without a field: foam three units wide, so its white core is a wide strip of the west edge. */
    const RAMP = { foam: [-7, -4.6, -6, 6] as Box, open: [4, 6.5, -6, 6] as Box };
    /** White pixels where the line lies. */
    function froth(p: Pixels, [x0, x1, y0, y1]: Box): number {
      let n = 0;
      for (let y = y0; y <= y1; y += 0.02) for (let x = x0; x <= x1; x += 0.02) if (white(p, col(x), row(y))) n++;
      return n;
    }
    /** Pixels that differ in the open water, well clear of the line. */
    function openWater(a: Pixels, b: Pixels, [x0, x1, y0, y1]: Box): number {
      let n = 0;
      for (let y = y0; y <= y1; y += 0.05) for (let x = x0; x <= x1; x += 0.05) {
        const [i, j] = [col(x), row(y)];
        if (i < 0 || j < 0 || i >= W || j >= H) continue;
        const o = (j * W + i) * 3;
        if (a.rgb[o] !== b.rgb[o] || a.rgb[o + 1] !== b.rgb[o + 1] || a.rgb[o + 2] !== b.rgb[o + 2]) n++;
      }
      return n;
    }

    beforeAll(async () => {
      ({ renderer: r, target, dispose } = await rig(W, H));
      r.camera.fov = FOV; r.camera.near = 100; r.camera.far = 600;
      r.camera.target = [0, 0, 0]; r.camera.position = [0, -0.01, DISTANCE];
    });
    afterAll(() => dispose?.());
    beforeEach(() => {
      r.look = { ...r.look, exposure: 1, clear: LOOK };
      r.time = 0;
      r.setStatic([...pond(), water()]);
    });

    for (const kind of ['with a shore field', 'without one'] as const) {
      it(`holes the foam ${kind} and leaves the water outside it untouched`, async () => {
        const where = kind === 'without one' ? RAMP : SHORE;
        r.setShoreField(kind === 'without one' ? null : field(128));
        // with no field the foam is the depth band, so the bed is a ramp of mud and the band is made wide
        const look = kind === 'without one' ? { ...LOOK, foamWidth: 3 } : LOOK;
        if (kind === 'without one') r.setStatic([bed()[0], water()]);
        r.look = { ...r.look, clear: look };
        const plain = await draw(r, target, `grain ${kind} none`);
        r.look = { ...r.look, clear: { ...look, foamGrain: 0 } };
        expect(differing(await draw(r, target, `grain ${kind} nought`), plain), 'nought named is nought unnamed').toBe(0);
        r.look = { ...r.look, clear: { ...look, foamGrain: 0.3 } };
        const fine = await draw(r, target, `grain ${kind} 0.3`);
        r.look = { ...r.look, clear: { ...look, foamGrain: 1 } };
        const coarse = await draw(r, target, `grain ${kind} 1`);
        const [a, b, c] = [froth(plain, where.foam), froth(fine, where.foam), froth(coarse, where.foam)];
        console.log(`the foam's white pixels ${kind}: ${a} plain, ${b} at 0.3, ${c} at 1`);
        expect(a, 'there is foam to hole').toBeGreaterThan(200);
        // the depth band's grain is as wide as its own line, so a strip of it a few cells across may be whole at a grain of 0.3
        if (kind === 'with a shore field') expect(b, 'a grain of 0.3 holes some of it').toBeLessThan(a * 0.97);
        else expect(b, 'and none of it more').toBeLessThanOrEqual(a);
        expect(c, 'a grain of 1 holes more').toBeLessThan(b * 0.9);
        expect(c, 'and leaves some froth').toBeGreaterThan(a * 0.05);
        expect(openWater(coarse, plain, where.open), 'the open water is the same pixels').toBe(0);
        expect(openWater(fine, plain, where.open)).toBe(0);
      });
    }
  });
});
