/**
 * The painted edge on a real device: a mesh with `paint` (`painted` in `mesh/paint.ts`) drawn in a toon look has a
 * stroke of pale paint along its ridges, from the build compiled when the first such group is handed in. Each test
 * holds one claim the picture rests on. The stroke lies only along the block's convex edges, within a few pixels of
 * them. Each knob moves some pixels and none outside the thing. A quiet mesh, a mesh with no paint, a physically
 * based look and a ball beside a painted block are drawn as they would be plain, to the byte. And the stroke's
 * strength and band, read back in linear light from a boulder, are the sums in `paint.ts` worked out from the mesh
 * and the camera, so the shader cannot drift from the sums a test under node holds.
 *
 * VITE_FRAME_DIR writes the block with and without paint, to be looked at.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, halfToFloat, readbackLayer, type Gpu } from '../../gpu/context';
import { at as place, block, built, annulus, disc, frustum, tubeIn } from '../../mesh/lowpoly';
import { PAINT_STRIDE, painted, split } from '../../mesh/paint';
import type { Mesh } from '../../mesh/types';
import { boulder } from '../../parts/lowpoly';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, FULL_ECONOMY, GameRenderer, type GameGroup, type Look } from '../renderer';
import { LightPool } from '../lights';
import { PAINT_DEFAULT, paintBand, paintStrength, paintWidth, type PaintSet } from '../paint';
import { differing, readPixels, saveFrame, type Pixels } from './frame';

const SIZE = 192;

/** A placement: scaled by s, turned by `turn` about z, at (x, y, z). */
const at = (s: number, x: number, y: number, z: number, turn = 0) => {
  const c = Math.cos(turn), n = Math.sin(turn);
  return new Float32Array([c * s, n * s, 0, 0, -n * s, c * s, 0, 0, 0, 0, s, 0, x, y, z, 1]);
};

const BLOCK_SPLIT = split(built((b) => block(b, place(0, 0, 0), -0.5, 0.5, -0.5, 0.5, 0, 1, true)));
const BLOCK = painted(BLOCK_SPLIT);
const HOLE = split(built((b) => {
  const o = place(0, 0, 0);
  annulus(b, o, 10, 0.75, 1.5, 1);
  tubeIn(b, o, 10, 0.75, 0.6, 1);
  disc(b, o, 10, 0.75, 0.6);
  frustum(b, o, 10, 1.5, 1.5, 0, 1, { top: false, bottom: true });
}));
const ROCK = split(boulder(1, { seed: 3 }).parts[0].mesh);
const BALL_SPLIT = split(built((b) => {
  const rings = 12, segments = 16;
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * Math.PI;
    for (let j = 0; j <= segments; j++) {
      const th = (j / segments) * Math.PI * 2;
      const x = Math.sin(phi) * Math.cos(th), y = Math.sin(phi) * Math.sin(th), z = Math.cos(phi);
      b.vertex(x, y, z, x, y, z, 0, 0);
    }
  }
  const row = segments + 1;
  for (let i = 0; i < rings; i++) for (let j = 0; j < segments; j++) b.quad(i * row + j, (i + 1) * row + j, (i + 1) * row + j + 1, i * row + j + 1);
}));
const GREY: [number, number, number] = [0.5, 0.5, 0.5];
const YAW = 0.5;
/** The block as a placement: 40 across, turned, standing a little below the camera's target. */
const blockAt = (x = 0): Float32Array => at(40, x, 0, -20, YAW);

describe('the painted edge on the game renderer', () => {
  let gpu: Gpu;
  let r: GameRenderer;
  let target: GPUTexture;
  let base: Look;
  const view = () => target.createView();

  beforeAll(async () => {
    gpu = await createDevice();
    r = new GameRenderer(gpu, 8, 8, 64);
    await r.ready;
    target = gpu.device.createTexture({ size: [SIZE, SIZE], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const env = bakeEnvironment(gpu, 'daylight', { size: 32, mips: 3 });
    await env.samples;
    r.setEnvironment(env.specular, env.brdf, env.mips);
    r.resize(SIZE, SIZE);
    r.setStatic([]);
    r.setLights(new LightPool(8));
    r.economy = { ...FULL_ECONOMY, shadows: true };
    base = { ...r.look, background: [0, 0, 0], sunDir: [0.4, -0.5, 0.75], sunColour: [2, 2, 2], shading: 'toon' };
    r.camera.fov = 32; r.camera.near = 0.5; r.camera.far = 4000;
    r.camera.position = [0, -160, 60];
    r.camera.target = [0, 0, -10];
    r.camera.update();
  });

  afterAll(() => { r?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  const group = (mesh: GameGroup['mesh'], matrices = blockAt(), albedo = GREY): GameGroup => ({ mesh, matrices, albedo, roughness: 0.8 });

  async function draw(groups: GameGroup[], look: Partial<Look> = {}, name = ''): Promise<Pixels> {
    r.look = { ...base, ...look };
    r.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
    r.setDynamic(groups);
    await r.prepare();
    r.frame(view());
    const px = await readPixels(gpu, target);
    if (name) await saveFrame(`painted ${name}`, px);
    return px;
  }

  /** The pixels a plain frame covers: anything drawn against the black background. */
  const covered = (px: Pixels) => {
    const out = new Set<number>();
    for (let i = 0; i < px.width * px.height; i++) if (px.rgb[i * 3] + px.rgb[i * 3 + 1] + px.rgb[i * 3 + 2] > 0) out.add(i);
    return out;
  };
  const changed = (a: Pixels, b: Pixels) => {
    const out: number[] = [];
    for (let i = 0; i < a.width * a.height; i++) if ([0, 1, 2].some((k) => a.rgb[i * 3 + k] !== b.rgb[i * 3 + k])) out.push(i);
    return out;
  };

  /** A world point on the screen, in pixels from the top left of the frame. */
  function project(p: [number, number, number]): [number, number] {
    const m = r.camera.viewProjection;
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    return [(x / w * 0.5 + 0.5) * SIZE, (1 - (y / w * 0.5 + 0.5)) * SIZE];
  }

  it('paints the block along its convex edges, and nowhere but within a few pixels of one', async () => {
    const plain = await draw([group(BLOCK_SPLIT)], {}, 'block plain');
    const paint = await draw([group(BLOCK)], {}, 'block default');
    const m = blockAt();
    const world = (c: [number, number, number]): [number, number, number] => [m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12], m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13], m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14]];
    const corners: [number, number, number][] = [];
    for (const z of [0, 1]) for (const y of [-0.5, 0.5]) for (const x of [-0.5, 0.5]) corners.push([x, y, z]);
    const screen = corners.map((c) => project(world(c)));
    // the twelve edges: the corners that differ in exactly one of the three coordinates
    const edges: [number, number][] = [];
    for (let a = 0; a < 8; a++) for (const bit of [1, 2, 4]) if (!(a & bit)) edges.push([a, a | bit]);
    expect(edges.length).toBe(12);
    const distance = (px: number, py: number) => Math.min(...edges.map(([a, b]) => {
      const [ax, ay] = screen[a], [bx, by] = screen[b];
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    }));
    const diff = changed(plain, paint);
    const farthest = Math.max(...diff.map((i) => distance((i % SIZE) + 0.5, Math.floor(i / SIZE) + 0.5)));
    console.log(`painted block: ${diff.length} pixels differ, the farthest ${farthest.toFixed(2)} px from a projected edge`);
    expect(differing(plain, paint)).toBe(diff.length);
    expect(diff.length, 'pixels the paint changed').toBeGreaterThan(100);
    expect(farthest, 'the farthest from a projected convex edge, in pixels').toBeLessThanOrEqual(8);
  });

  /** Each knob of the table: the set it is moved in, where it goes, and the mesh that has something for it to do. */
  const KNOBS: { knob: keyof PaintSet; to: PaintSet[keyof PaintSet]; context?: PaintSet; mesh?: Mesh }[] = [
    { knob: 'width', to: 6 },
    { knob: 'widthFacet', to: 0 },
    { knob: 'widthPx', to: 12 },
    { knob: 'shareCap', to: 0.05 },
    { knob: 'fadePx', to: 400 },
    { knob: 'gate', to: 2 },
    { knob: 'ramp', to: 2 },
    { knob: 'ridgeUp', to: 1.5 },
    { knob: 'edgeAa', to: 3 },
    { knob: 'feather', to: 0.5 },
    { knob: 'featherWidth', to: 4, context: { feather: 0.5 } },
    { knob: 'swell', to: 0 },
    { knob: 'swellScale', to: 100 },
    { knob: 'taper', to: 0.9, context: { broken: 0.5 } },
    { knob: 'broken', to: 0.5 },
    { knob: 'brokenScale', to: 2, context: { broken: 0.5 } },
    { knob: 'vertexFade', to: 0 },
    { knob: 'fadeReach', to: 3 },
    { knob: 'light', to: 0 },
    { knob: 'lightColour', to: [1, 0, 0] },
    { knob: 'sun', to: 0 },
    { knob: 'up', to: 0 },
    { knob: 'upPow', to: 1 },
    { knob: 'litCut', to: 1 },
    { knob: 'markValue', to: 0 },
    { knob: 'markScale', to: 1, context: { markAlong: 0 } },
    { knob: 'markEnd', to: 0 },
    { knob: 'markHue', to: 0 },
    { knob: 'markHueColour', to: [0, 0, 1] },
    { knob: 'markAlong', to: 0 },
    { knob: 'dark', to: 1, mesh: painted(HOLE) },
    { knob: 'darkFactor', to: 0, context: { dark: 1 }, mesh: painted(HOLE) },
    { knob: 'facet', to: 0.5 },
  ];

  it('has a case for every knob of the table', () => {
    expect(KNOBS.map((k) => k.knob).sort()).toEqual(Object.keys(PAINT_DEFAULT).sort());
  });

  for (const { knob, to, context, mesh } of KNOBS) {
    it(`the ${knob} knob moves some pixels of the thing and none outside it`, async () => {
      const thing = mesh ?? BLOCK;
      const sets = (set: PaintSet) => ({ paint: [set] });
      const plain = await draw([group(mesh ? { ...mesh, paint: undefined } : BLOCK_SPLIT)]);
      const before = await draw([group(thing)], sets({ ...context }));
      const after = await draw([group(thing)], sets({ ...context, [knob]: to }));
      const diff = changed(before, after);
      const inside = covered(plain);
      console.log(`knob ${knob} to ${JSON.stringify(to)}: ${diff.length} pixels`);
      expect(diff.length, `pixels the ${knob} moved`).toBeGreaterThan(0);
      expect(diff.filter((i) => !inside.has(i)), 'pixels it moved outside the thing').toEqual([]);
    });
  }

  it('draws a look that names no paint as the default set, to the byte', async () => {
    const absent = await draw([group(BLOCK)]);
    const named = await draw([group(BLOCK)], { paint: [{ ...PAINT_DEFAULT }, {}, {}, {}] });
    expect(differing(absent, named)).toBe(0);
  });

  it('draws a quiet mesh as the plain build draws it, to the byte', async () => {
    const plain = await draw([group(BLOCK_SPLIT)]);
    const quiet = await draw([group(painted(BLOCK_SPLIT, { quiet: true }))], { paint: [{ light: 3, dark: 1, facet: 1 }] });
    expect(differing(plain, quiet)).toBe(0);
    // and a mesh that is not quiet, in the same look, is not the plain frame
    expect(differing(plain, await draw([group(BLOCK)], { paint: [{ light: 3, dark: 1, facet: 1 }] }))).toBeGreaterThan(100);
  });

  it('draws a ball beside a painted block as it draws it with no painted group in the scene', async () => {
    const ball = group(BALL_SPLIT, at(25, -55, 0, -10));
    const alone = await draw([ball]);
    const beside = await draw([group(BLOCK, blockAt(50)), ball]);
    const mine = covered(alone);
    expect(mine.size, 'pixels of the ball').toBeGreaterThan(500);
    const moved = changed(alone, beside).filter((i) => mine.has(i));
    expect(moved).toEqual([]);
    // the block is there, and painted: the frames differ where the block is
    expect(differing(alone, beside)).toBeGreaterThan(1000);
  });

  it('draws a painted group plain in a physically based look, to the byte', async () => {
    const plain = await draw([group(BLOCK_SPLIT)], { shading: 'pbr' });
    const paint = await draw([group(BLOCK)], { shading: 'pbr' });
    expect(differing(plain, paint)).toBe(0);
    // while the same group in a toon look is painted
    expect(differing(await draw([group(BLOCK_SPLIT)]), await draw([group(BLOCK)]))).toBeGreaterThan(100);
  });

  it('bakes a painted group in the static half as it draws it each frame, to the byte', async () => {
    r.look = { ...base };
    r.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
    r.setDynamic([]);
    r.setStatic([group(BLOCK)]);
    await r.prepare();
    r.frame(view(), 'redraw');
    const redrawn = await readPixels(gpu, target);
    r.frame(view(), 'keep');
    const kept = await readPixels(gpu, target);
    r.setStatic([]);
    expect(differing(redrawn, kept)).toBe(0);
    expect(differing(redrawn, await draw([group(BLOCK_SPLIT)])), 'and it is painted').toBeGreaterThan(100);
  });

  it('draws a painted group at four samples a pixel, painted', async () => {
    const plain = await draw([group(BLOCK_SPLIT)], { antialias: 'msaa' });
    const paint = await draw([group(BLOCK)], { antialias: 'msaa' });
    expect(differing(plain, paint)).toBeGreaterThan(100);
  });

  it('refuses paint of the wrong length, naming the counts', () => {
    const wrong = { ...BLOCK, paint: BLOCK.paint.subarray(0, BLOCK.paint.length - PAINT_STRIDE) };
    const vertices = BLOCK.positions.length / 3;
    expect(() => r.setDynamic([group(wrong)])).toThrow(`${PAINT_STRIDE} floats of paint a vertex, and this one has ${wrong.paint.length} floats of paint for ${vertices} vertices`);
    r.setDynamic([]);
  });

  it('makes nothing for a renderer that is never handed paint', async () => {
    const fresh = new GameRenderer(gpu, 8, 8, 64);
    await fresh.ready;
    const env = bakeEnvironment(gpu, 'daylight', { size: 32, mips: 3 });
    await env.samples;
    fresh.setEnvironment(env.specular, env.brdf, env.mips);
    fresh.resize(SIZE, SIZE);
    fresh.look = { ...base };
    fresh.setDynamic([group(BLOCK_SPLIT)]);
    await fresh.prepare();
    expect(fresh.frame(view())).toBe(true);
    const inner = fresh as unknown as { paintBuild: unknown; paintBuffer: unknown; paintBind: unknown; scenePipelines: Map<string, unknown> };
    expect(inner.paintBuild).toBeNull();
    expect(inner.paintBuffer).toBeNull();
    expect(inner.paintBind).toBeNull();
    expect([...inner.scenePipelines.keys()].filter((k) => k.includes('painted'))).toEqual([]);
    fresh.dispose();
  });

  /** The boulder's strength and band, read back in linear light, against the sums in `paint.ts`. */
  describe('the sums on the device', () => {
    const SCALE = 40;
    const ROCK_PAINT = painted(ROCK);
    const probe: PaintSet = {
      width: 2, widthFacet: 0, widthPx: 0, shareCap: 0, fadePx: 0, swell: 0, broken: 0, vertexFade: 0,
      sun: 0, up: 0, upPow: 1, litCut: 0, markValue: 0, markEnd: 0, markHue: 0, feather: 0, facet: 0, dark: 0,
      light: 1, lightColour: [1, 1, 1], edgeAa: 0.01,
    };

    async function linear(set: PaintSet): Promise<Float32Array> {
      await draw([group(ROCK_PAINT, at(SCALE, 0, 0, -10, 0.3), [0.2, 0.2, 0.2])], { paint: [set] });
      const half = new Uint16Array(await readbackLayer(gpu.device, r.hdr.colour!, 0, 0, SIZE, 8));
      const out = new Float32Array(SIZE * SIZE * 3);
      for (let i = 0; i < SIZE * SIZE; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = halfToFloat(half[i * 4 + k]);
      return out;
    }

    /** What the CPU says of each pixel the boulder covers: its triangle, and its three barycentrics, by the frame's own projection. */
    function covering() {
      const m = r.camera.viewProjection;
      const matrix = at(SCALE, 0, 0, -10, 0.3);
      const world = (i: number) => {
        const x = ROCK_PAINT.positions[i * 3], y = ROCK_PAINT.positions[i * 3 + 1], z = ROCK_PAINT.positions[i * 3 + 2];
        return [matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12], matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13], matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]];
      };
      const clip = (p: number[]) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14], m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15]];
      const tris = ROCK_PAINT.indices.length / 3;
      const best = new Float32Array(SIZE * SIZE).fill(Infinity);
      const owner = new Int32Array(SIZE * SIZE).fill(-1);
      const second = new Float32Array(SIZE * SIZE).fill(Infinity);
      const screen = (t: number) => [0, 1, 2].map((v) => {
        const c = clip(world(t * 3 + v));
        return { x: (c[0] / c[3] * 0.5 + 0.5) * SIZE, y: (1 - (c[1] / c[3] * 0.5 + 0.5)) * SIZE, z: c[2] / c[3], w: c[3] };
      });
      /** The barycentrics of (px, py) in triangle t, perspective-correct, whether the point is inside it or not. */
      const bary = (v: ReturnType<typeof screen>, px: number, py: number) => {
        const [a, b, c] = v;
        const den = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
        const l0 = ((b.y - c.y) * (px - c.x) + (c.x - b.x) * (py - c.y)) / den;
        const l1 = ((c.y - a.y) * (px - c.x) + (a.x - c.x) * (py - c.y)) / den;
        const l2 = 1 - l0 - l1;
        const p = [l0 / a.w, l1 / b.w, l2 / c.w];
        const s = p[0] + p[1] + p[2];
        return { screen: [l0, l1, l2], persp: p.map((x) => x / s), z: l0 * a.z + l1 * b.z + l2 * c.z };
      };
      for (let t = 0; t < tris; t++) {
        const v = screen(t);
        const x0 = Math.max(0, Math.floor(Math.min(v[0].x, v[1].x, v[2].x))), x1 = Math.min(SIZE - 1, Math.ceil(Math.max(v[0].x, v[1].x, v[2].x)));
        const y0 = Math.max(0, Math.floor(Math.min(v[0].y, v[1].y, v[2].y))), y1 = Math.min(SIZE - 1, Math.ceil(Math.max(v[0].y, v[1].y, v[2].y)));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const q = bary(v, x + 0.5, y + 0.5);
          if (Math.min(...q.screen) < 0) continue;
          const i = y * SIZE + x;
          if (q.z < best[i]) { second[i] = best[i]; best[i] = q.z; owner[i] = t; } else second[i] = Math.min(second[i], q.z);
        }
      }
      /** The three distances to the edges at a pixel, and their footprints by the pixel's partners in its quad. */
      const measure = (t: number, x: number, y: number) => {
        const v = screen(t);
        const heights = [0, 1, 2].map((k) => ROCK_PAINT.paint[(t * 3 + k) * PAINT_STRIDE + 4 + k] * SCALE);
        const dist = (px: number, py: number) => { const q = bary(v, px, py).persp; return q.map((b, k) => b * heights[k]); };
        const here = dist(x + 0.5, y + 0.5);
        const right = dist(x % 2 === 0 ? x + 1.5 : x - 0.5, y + 0.5);
        const down = dist(x + 0.5, y % 2 === 0 ? y + 1.5 : y - 0.5);
        const foot = here.map((d, k) => Math.hypot(right[k] - d, down[k] - d));
        const facet = Math.min(...heights);
        const edge = [0, 1, 2].map((k) => ({ fold: ROCK_PAINT.paint[t * 3 * PAINT_STRIDE + k], upShare: (ROCK_PAINT.paint[t * 3 * PAINT_STRIDE + 12 + k] % 1) * 4 - 1 }));
        return { here, foot, facet, edge, margin: Math.min(...bary(v, x + 0.5, y + 0.5).screen) };
      };
      return { owner, best, second, measure };
    }

    const encode = (c: number) => Math.round(255 * Math.min(Math.max(c, 0), 1) ** (1 / 2.2));

    for (const edgeAa of [0.01, 1]) {
      it(`the band and strength of a boulder, at an edge's antialiasing of ${edgeAa}, are the sums in paint.ts to within two levels`, async () => {
        const set = { ...probe, edgeAa };
        const none = await linear({ ...set, light: 0 });
        // every edge carries the stroke and the band is the whole face: the amount is one everywhere
        const all = await linear({ ...set, width: 1e4, gate: -10, ramp: 1, ridgeUp: -10 });
        const real = await draw([group(ROCK_PAINT, at(SCALE, 0, 0, -10, 0.3), [0.2, 0.2, 0.2])], { paint: [set] }, `boulder aa ${edgeAa}`);
        const { owner, best, second, measure } = covering();
        const stats = { checked: 0, full: 0, empty: 0, between: 0, worst: 0, skipped: 0 };
        for (let i = 0; i < SIZE * SIZE; i++) {
          if (owner[i] < 0) continue;
          const x = i % SIZE, y = Math.floor(i / SIZE);
          const m = measure(owner[i], x, y);
          // a pixel near a triangle's border or under another triangle's is the rasteriser's and not the sum's
          if (m.margin < 0.03 || second[i] - best[i] < 1e-4) { stats.skipped++; continue; }
          let amount = 0;
          for (let k = 0; k < 3; k++) {
            const w = paintWidth(set.width!, 0, 0, 0, m.facet, m.foot[k]);
            // a pixel whose distance is within a footprint of the band's edge is as the rasteriser's derivatives say: skipped
            if (edgeAa < 0.5 && Math.abs(m.here[k] - w) < 1.2 * m.foot[k]) { amount = NaN; break; }
            amount = Math.max(amount, paintBand(m.here[k], w, m.foot[k], edgeAa) * paintStrength(m.edge[k].fold, set.gate ?? PAINT_DEFAULT.gate, set.ramp ?? PAINT_DEFAULT.ramp, m.edge[k].upShare, set.ridgeUp ?? PAINT_DEFAULT.ridgeUp));
          }
          if (Number.isNaN(amount)) { stats.skipped++; continue; }
          for (let k = 0; k < 3; k++) {
            const want = encode(none[i * 3 + k] + amount * (all[i * 3 + k] - none[i * 3 + k]));
            const got = real.rgb[i * 3 + k];
            stats.worst = Math.max(stats.worst, Math.abs(got - want));
          }
          stats.checked++;
          if (amount > 0.999) stats.full++; else if (amount < 0.001) stats.empty++; else stats.between++;
        }
        console.log(`boulder sums at edgeAa ${edgeAa}: ${JSON.stringify(stats)}`);
        expect(stats.checked, 'pixels checked').toBeGreaterThan(2000);
        expect(stats.full, 'pixels on the stroke').toBeGreaterThan(100);
        expect(stats.empty, 'pixels off it').toBeGreaterThan(500);
        if (edgeAa >= 0.5) expect(stats.between, 'pixels on the band\'s edge or a fold\'s ramp').toBeGreaterThan(50);
        expect(stats.worst, 'the worst pixel, in levels').toBeLessThanOrEqual(2);
      });
    }
  });
});
