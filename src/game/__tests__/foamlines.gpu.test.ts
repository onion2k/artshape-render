/**
 * Clear water's foam lines on a real device: given a shore field, the foam is a line of even width round the shore
 * whatever its slope, with a gap and a second line beyond, where foam cut by the depth is as wide as the shore is
 * gentle. An island with a sheer west side and a shelving east side stands in water over a flat bed, seen from
 * straight above, and the white along a row through it is measured on both sides. Frames written by VITE_FRAME_DIR.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, FULL_ECONOMY, GameRenderer, type GameGroup } from '../renderer';
import { LightPool } from '../lights';
import type { ShoreField } from '../shore';
import { readPixels, saveFrame, type Pixels } from './frame';
import { MUD, box, one, quad, water } from './clearscene';

const W = 192, H = 192;
const DISTANCE = 301.5, FOV = 3;
const PX_PER_UNIT = H / (2 * DISTANCE * Math.tan((FOV / 2) * (Math.PI / 180)));
/** The island: a block from the bed to a little over the water, x from -1 to 1, and a ramp off its east side down to the bed. */
const WEST = -1, EAST = 1, NORTH = 1.5, TOP = 0.3, BED = -1, RAMP_END = 5;
/** Where the ramp crosses the water, which is the island's east shore. */
const SHORE_EAST = EAST + ((RAMP_END - EAST) * TOP) / (TOP - BED);
const FOAM = 0.5, GAP = 0.4, SECOND = 0.3;

/**
 * The island, or the same island turned about: its block moved east by the ramp's share above the water and the ramp
 * off its west side instead, so both its waterlines are where they were and only which side is sheer changes. The
 * noise that breaks the foam is the same at the same place, so a side drawn both ways tells the slope from the noise.
 */
function island(turned = false): GameGroup[] {
  const above = SHORE_EAST - EAST;
  const [w, e] = turned ? [WEST + above, SHORE_EAST] : [WEST, EAST];
  const block = new Float32Array([e - w, 0, 0, 0, 0, 2 * NORTH, 0, 0, 0, 0, TOP - BED, 0, (w + e) / 2, 0, BED, 1]);
  const ramp = turned
    ? quad([[w - (RAMP_END - EAST), -NORTH, BED], [w, -NORTH, TOP], [w, NORTH, TOP], [w - (RAMP_END - EAST), NORTH, BED]])
    : quad([[EAST, -NORTH, TOP], [RAMP_END, -NORTH, BED], [RAMP_END, NORTH, BED], [EAST, NORTH, TOP]]);
  return [
    { mesh: quad([[-7, -7, BED], [7, -7, BED], [7, 7, BED], [-7, 7, BED]]), matrices: one, albedo: MUD, roughness: 0.9 },
    { mesh: box(), matrices: block, albedo: MUD, roughness: 0.9 },
    { mesh: ramp, matrices: one, albedo: MUD, roughness: 0.9 },
  ];
}

/** The field the island's waterline gives: the distance from each texel's middle to the rectangle it draws on the water. */
function field(size: number): ShoreField {
  const min: [number, number] = [-7, -7], max: [number, number] = [7, 7];
  const distances = new Float32Array(size * size);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const x = min[0] + ((i + 0.5) / size) * (max[0] - min[0]), y = min[1] + ((j + 0.5) / size) * (max[1] - min[1]);
      const dx = Math.max(WEST - x, 0, x - SHORE_EAST), dy = Math.max(-NORTH - y, 0, y - NORTH);
      distances[j * size + i] = Math.hypot(dx, dy);
    }
  return { size, distances, min, max };
}

/** Whether a pixel is the foam's white. */
const white = (p: Pixels, x: number, y: number) => {
  const o = (y * p.width + x) * 3;
  return p.rgb[o] > 200 && p.rgb[o + 1] > 200 && p.rgb[o + 2] > 200;
};
const column = (x: number) => Math.round(W / 2 + x * PX_PER_UNIT);

/** The runs of white along a row going out from a shore, in pixels: the first run, the gap after it, and the run after that. */
function runs(p: Pixels, row: number, from: number, step: 1 | -1) {
  let x = from;
  // from the shore's own column, the first pixels may still be the island; start at the first white, if there is one near
  while (!white(p, x, row) && Math.abs(x - from) < 6) x += step;
  if (!white(p, x, row)) return [0, 0, 0];
  const out: number[] = [];
  let last = true, n = 0;
  for (; x >= 0 && x < W && out.length < 3; x += step) {
    const now = white(p, x, row);
    if (now === last) n++;
    else { out.push(n); n = 1; last = now; }
  }
  while (out.length < 3) out.push(0);
  return out;
}

describe('clear water foam lines', () => {
  let gpu: Gpu;
  let env: ReturnType<typeof bakeEnvironment>;
  let r: GameRenderer;
  let target: GPUTexture;

  beforeAll(async () => {
    gpu = await createDevice();
    env = bakeEnvironment(gpu, 'daylight', { size: 32, mips: 3 });
    await env.samples;
    target = gpu.device.createTexture({ size: [W, H], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    r = new GameRenderer(gpu, 8, 8, 256, 100);
    await r.ready;
    r.setEnvironment(env.specular, env.brdf, env.mips);
    r.resize(W, H);
    r.setLights(new LightPool(8));
  });

  afterAll(() => { r?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  beforeEach(() => {
    r.look = { ...r.look, shading: 'pbr', antialias: undefined, background: [0.02, 0.02, 0.03], occlusion: 0, sunColour: [1, 1, 1], ambient: 1, exposure: 1 };
    r.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
    r.economy = { ...FULL_ECONOMY, shadows: false };
    r.camera.fov = FOV; r.camera.near = 100; r.camera.far = 600;
    r.camera.target = [0, 0, 0];
    r.camera.position = [0, -0.01, DISTANCE];
    r.time = 0;
    r.setStatic([...island(), water()]);
    r.setShoreField(null);
  });

  async function draw(name: string): Promise<Pixels> {
    await r.prepare();
    gpu.device.pushErrorScope('validation');
    expect(r.frame(target.createView(), 'redraw', 0)).toBe(true);
    expect(r.frame(target.createView(), 'redraw', 0)).toBe(true);
    const error = await gpu.device.popErrorScope();
    expect(error?.message ?? null).toBeNull();
    const p = await readPixels(gpu, target);
    await saveFrame(`foam lines ${name}`, p);
    return p;
  }

  const LOOK = { clarity: 1, foamWidth: FOAM, foamGap: GAP, foamWidth2: SECOND, glitter: 0, refraction: 0, caustics: 0 };

  it('rings the island in a line as wide on its shelving side as its sheer one, a gap and a second line beyond', async () => {
    r.look = { ...r.look, clear: LOOK };
    r.setShoreField(field(128));
    const p = await draw('field');
    r.setStatic([...island(true), water()]);
    const q = await draw('field turned');
    // each side of the island measured as it is and turned about: sheer and shelving at the same place
    const west: number[][] = [], east: number[][] = [], westTurned: number[][] = [], eastTurned: number[][] = [];
    for (let y = -0.8; y <= 0.8; y += 0.2) {
      const row = Math.round(H / 2 - y * PX_PER_UNIT);
      west.push(runs(p, row, column(WEST), -1));
      east.push(runs(p, row, column(SHORE_EAST), 1));
      westTurned.push(runs(q, row, column(WEST), -1));
      eastTurned.push(runs(q, row, column(SHORE_EAST), 1));
    }
    const mean = (rs: number[][], k: number) => rs.reduce((s, r) => s + r[k], 0) / rs.length;
    const sheer = [...west, ...eastTurned], shelving = [...east, ...westTurned];
    // the line is its width, give or take the drifting noise that breaks it, which moves its edge by up to 0.55 of the
    // width either way, and whose cells are wider than this island, so it may move it the same way all round; and a
    // pixel for the edge's easing
    for (const [side, rs] of [['sheer', sheer], ['shelving', shelving]] as const) {
      expect(mean(rs, 0), `the ${side} side's line, in pixels`).toBeGreaterThan(FOAM * PX_PER_UNIT * 0.45 - 1);
      expect(mean(rs, 0), `the ${side} side's line, in pixels`).toBeLessThan(FOAM * PX_PER_UNIT * 1.55 + 1);
      expect(mean(rs, 1), `the ${side} side's gap, in pixels`).toBeGreaterThan(GAP * PX_PER_UNIT * 0.5);
      expect(mean(rs, 2), `the ${side} side's second line, in pixels`).toBeGreaterThan(SECOND * PX_PER_UNIT * 0.5);
    }
    expect(Math.abs(mean(west, 0) - mean(westTurned, 0)), 'the west line as wide shelving as sheer').toBeLessThanOrEqual(1);
    expect(Math.abs(mean(east, 0) - mean(eastTurned, 0)), 'the east line as wide sheer as shelving').toBeLessThanOrEqual(1);
  });

  it('is a band as wide as the shore is gentle without a field, as it was', async () => {
    r.look = { ...r.look, clear: { ...LOOK, foamWidth: 0.15 } };
    const p = await draw('no field');
    const row = Math.round(H / 2);
    const sheer = runs(p, row, column(WEST), -1)[0], shelving = runs(p, row, column(SHORE_EAST), 1)[0];
    // the sheer side's water is too deep for foam a pixel out from it, and the shelving side's thin for a band
    expect(sheer, 'the band by the sheer side, in pixels').toBeLessThanOrEqual(1);
    expect(shelving, 'the band on the shelving side, in pixels').toBeGreaterThanOrEqual(4);
  });

  it('is taken back to the band when the field is taken away, and a new field replaces the old', async () => {
    r.look = { ...r.look, clear: LOOK };
    r.setShoreField(field(64));
    r.setShoreField(field(128));
    const withField = await draw('field again');
    r.setShoreField(null);
    const without = await draw('field taken away');
    const row = Math.round(H / 2);
    expect(runs(withField, row, column(SHORE_EAST), 1)[0]).toBeLessThan(runs(without, row, column(SHORE_EAST), 1)[0]);
  });

  it('rings only what its field covers, and is the band outside it', async () => {
    r.look = { ...r.look, clear: { ...LOOK, foamWidth: 0.15 } };
    const band = await draw('no field, for the half');
    // a field over the west half of the water only, which ends short of the island's shelving side
    const whole = field(128);
    const half: ShoreField = { size: 64, distances: new Float32Array(64 * 64), min: [-7, -7], max: [0, 7] };
    for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) half.distances[j * 64 + i] = whole.distances[j * 2 * 128 + i];
    r.setShoreField(half);
    const p = await draw('half field');
    const row = Math.round(H / 2);
    expect(runs(p, row, column(WEST), -1)[0], 'a line by the sheer side, in the field').toBeGreaterThan(0.15 * PX_PER_UNIT * 0.45 - 1);
    expect(Math.abs(runs(p, row, column(SHORE_EAST), 1)[0] - runs(band, row, column(SHORE_EAST), 1)[0]), 'the band by the shelving side, outside it').toBeLessThanOrEqual(1);
  });

  it('refuses a field that is not one', () => {
    expect(() => r.setShoreField({ ...field(4), distances: new Float32Array(3) })).toThrow(/16 distances/);
  });
});
