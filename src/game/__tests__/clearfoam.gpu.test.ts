/**
 * Clear water's foam options on a real device, from straight above a pond with a shore field: how crisp the line's
 * edge is, and whether the depth band rings a thing standing in the water as the field rings the shore. Each is asked
 * for, and a water that asks for neither draws as before (held by `cleargolden`). Frames written by VITE_FRAME_DIR.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, FULL_ECONOMY, GameRenderer, type GameGroup } from '../renderer';
import { LightPool } from '../lights';
import { MeshBuilder } from '../../mesh/types';
import type { ShoreField } from '../shore';
import { readPixels, saveFrame, type Pixels } from './frame';
import { MUD, one, quad, water } from './clearscene';

const W = 192, H = 192;
const DISTANCE = 301.5, FOV = 3;
const PX_PER_UNIT = H / (2 * DISTANCE * Math.tan((FOV / 2) * (Math.PI / 180)));
const BED = -1, WEST = -1, EAST = 1, NORTH = 1.5, TOP = 0.3;
/** The mound stands well clear of the island's shore, so the field rings nothing round it. */
const MOUND_X = -4, MOUND_TOP = 0.3, MOUND_HALF = 0.5;
const FOAM = 0.5;

/** The pond: a flat bed, a block of an island, and a mound with sloping sides that stands up through the surface. */
function pond(): GameGroup[] {
  const block = new Float32Array([EAST - WEST, 0, 0, 0, 0, 2 * NORTH, 0, 0, 0, 0, TOP - BED, 0, 0, 0, BED, 1]);
  // a box one unit each way, its top at one: the island's block
  const b = new MeshBuilder();
  const face = (p: [number, number, number][], n: [number, number, number]) => {
    const a = b.vertexCount;
    for (const [x, y, z] of p) b.vertex(x, y, z, n[0], n[1], n[2], 0, 0);
    b.quad(a, a + 1, a + 2, a + 3);
  };
  const h = 0.5;
  face([[-h, -h, 1], [h, -h, 1], [h, h, 1], [-h, h, 1]], [0, 0, 1]);
  face([[-h, -h, 0], [h, -h, 0], [h, -h, 1], [-h, -h, 1]], [0, -1, 0]);
  face([[h, h, 0], [-h, h, 0], [-h, h, 1], [h, h, 1]], [0, 1, 0]);
  face([[h, -h, 0], [h, h, 0], [h, h, 1], [h, -h, 1]], [1, 0, 0]);
  face([[-h, h, 0], [-h, -h, 0], [-h, -h, 1], [-h, h, 1]], [-1, 0, 0]);
  // the mound: a square frustum, a unit of run for a unit of rise, from the bed up to over the surface
  const m = new MeshBuilder();
  const half = (z: number) => MOUND_HALF + (MOUND_TOP - z);
  const ring = (z: number) => { const s = half(z); return [[-s, -s, z], [s, -s, z], [s, s, z], [-s, s, z]] as [number, number, number][]; };
  const lo = ring(BED), hi = ring(MOUND_TOP);
  const side = (i: number, j: number, n: [number, number, number]) => {
    const a = m.vertexCount;
    for (const [x, y, z] of [lo[i], lo[j], hi[j], hi[i]]) m.vertex(x + MOUND_X, y, z, n[0], n[1], n[2], 0, 0);
    m.quad(a, a + 1, a + 2, a + 3);
  };
  const k = Math.SQRT1_2;
  side(0, 1, [0, -k, k]); side(1, 2, [k, 0, k]); side(2, 3, [0, k, k]); side(3, 0, [-k, 0, k]);
  const top = m.vertexCount;
  for (const [x, y, z] of hi) m.vertex(x + MOUND_X, y, z, 0, 0, 1, 0, 0);
  m.quad(top, top + 1, top + 2, top + 3);
  return [
    { mesh: quad([[-7, -7, BED], [7, -7, BED], [7, 7, BED], [-7, 7, BED]]), matrices: one, albedo: MUD, roughness: 0.9 },
    { mesh: b.build(), matrices: block, albedo: MUD, roughness: 0.9 },
    { mesh: m.build(), matrices: one, albedo: MUD, roughness: 0.9 },
  ];
}

/** A field of the island's shore only: the distance from each texel to the island's footprint. */
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

const grey = (p: Pixels, x: number, y: number) => {
  const o = (y * p.width + x) * 3;
  return (p.rgb[o] + p.rgb[o + 1] + p.rgb[o + 2]) / 3;
};
const white = (p: Pixels, x: number, y: number) => {
  const o = (y * p.width + x) * 3;
  return p.rgb[o] > 200 && p.rgb[o + 1] > 200 && p.rgb[o + 2] > 200;
};
const col = (x: number) => Math.round(W / 2 + x * PX_PER_UNIT);
const row = (y: number) => Math.round(H / 2 - y * PX_PER_UNIT);

describe('the foam of clear water, crisper and round things in it', () => {
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
    r.setStatic([...pond(), water()]);
    r.setShoreField(field(128));
  });

  async function draw(name: string): Promise<Pixels> {
    await r.prepare();
    gpu.device.pushErrorScope('validation');
    expect(r.frame(target.createView(), 'redraw', 0)).toBe(true);
    expect(r.frame(target.createView(), 'redraw', 0)).toBe(true);
    const error = await gpu.device.popErrorScope();
    expect(error?.message ?? null).toBeNull();
    const p = await readPixels(gpu, target);
    await saveFrame(`foam options ${name}`, p);
    return p;
  }

  const LOOK = { clarity: 1, foamWidth: FOAM, foamGap: 0.4, foamWidth2: 0.3, glitter: 0, refraction: 0, caustics: 0 };
  const same = (a: Pixels, b: Pixels) => a.rgb.every((v, i) => v === b.rgb[i]);

  /** Pixels along rows out from the island's east shore that are neither the lines' white nor the water beside them. */
  function between(p: Pixels): number {
    let n = 0;
    for (let y = -1; y <= 1; y += 0.1) {
      const j = row(y), from = col(EAST + 1.0), to = col(EAST + 4.0);
      const level = (x: number) => grey(p, x, j);
      const water0 = level(col(EAST + 5.0));
      let core = water0;
      for (let x = from; x <= to; x++) core = Math.max(core, level(x));
      for (let x = from; x <= to; x++) {
        const s = (level(x) - water0) / Math.max(core - water0, 1);
        if (s > 0.2 && s < 0.8) n++;
      }
    }
    return n;
  }

  it('draws the line\'s edge crisper with a smaller softness, and as it was with the default named', async () => {
    r.look = { ...r.look, clear: { ...LOOK, foamWidth: 1.8, foamWidth2: 0 } };
    const plain = await draw('soft unset');
    r.look = { ...r.look, clear: { ...LOOK, foamWidth: 1.8, foamWidth2: 0, foamSoft: 0.06 } };
    expect(same(await draw('soft named default'), plain), 'the default named is the default').toBe(true);
    r.look = { ...r.look, clear: { ...LOOK, foamWidth: 1.8, foamWidth2: 0, foamSoft: 0.01 } };
    const crisp = await draw('soft 0.01');
    r.look = { ...r.look, clear: { ...LOOK, foamWidth: 1.8, foamWidth2: 0, foamSoft: 0.3 } };
    const soft = await draw('soft 0.3');
    const [a, b, c] = [between(crisp), between(plain), between(soft)];
    expect(a, 'a crisp edge has fewer pixels between water and foam').toBeLessThan(b * 0.8);
    expect(c, 'and a soft one more').toBeGreaterThan(b * 1.2);
  });

  it('rings a mound standing through the surface only with foamEverywhere, and the shore the same either way', async () => {
    r.look = { ...r.look, clear: LOOK };
    const plain = await draw('everywhere off');
    r.look = { ...r.look, clear: { ...LOOK, foamEverywhere: false } };
    expect(same(await draw('everywhere named off'), plain), 'false is the default').toBe(true);
    r.look = { ...r.look, clear: { ...LOOK, foamEverywhere: true } };
    const ringed = await draw('everywhere on');
    // the square ring of water round the mound, from its waterline out to where the water is as deep as the foam is wide;
    // the thin band the field's foam leaves round a thing ends a little way out from the waterline, so the count is of
    // what is past it
    const inner = MOUND_HALF + MOUND_TOP + 0.2, outer = MOUND_HALF + MOUND_TOP + FOAM - 0.1;
    const count = (p: Pixels) => {
      let n = 0;
      for (let y = -4; y <= 4; y += 0.05) for (let x = MOUND_X - 4; x <= MOUND_X + 4; x += 0.05) {
        const d = Math.max(Math.abs(x - MOUND_X), Math.abs(y));
        if (d > inner && d < outer && white(p, col(x), row(y))) n++;
      }
      return n;
    };
    expect(count(plain), 'next to no foam out round the mound without it').toBeLessThan(10);
    expect(count(ringed), 'a ring of foam out round it with it').toBeGreaterThan(count(plain) + 60);
    // the island's own lines are not doubled: the field's lines in the ringed frame are the plain frame's
    let moved = 0;
    for (let y = -1.4; y <= 1.4; y += 0.1) for (let x = WEST - 1.4; x <= EAST + 1.4; x += 0.05) {
      const j = row(y), i = col(x);
      if (white(ringed, i, j) !== white(plain, i, j)) moved++;
    }
    expect(moved, 'the shore\'s lines are the same pixels').toBe(0);
  });
});
