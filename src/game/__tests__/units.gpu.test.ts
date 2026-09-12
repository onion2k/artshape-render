/**
 * The same scene, in millimetres and in metres, on a real device.
 *
 * This is the game path's answer to the still-life path's "renderer in other
 * units" test, and it is the check that catches a length written into the
 * library by hand. A lamp over a slab over a floor, in mist, drawn twice: once
 * modelled in millimetres with `mmPerUnit` 1, once a thousand times smaller in
 * number with `mmPerUnit` 1000. The two frames are the same picture, so they
 * must be the same pixels.
 *
 * The third frame is the control, and it is why the test bites: the metre
 * world drawn by a renderer that was told nothing about the unit, which is
 * what the path did before this. It differs, badly, and the test says by how
 * much.
 *
 * `VITE_FRAME_DIR=/some/dir npm run test:gpu` writes the three out as PNGs.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server } from '@vitest/browser/context';
import { createDevice, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { compile } from '../../dsl/index';
import { groupByMesh } from '../../assembly/groups';
import { GameRenderer, type GameGroup, type Look } from '../renderer';
import { LightPool } from '../lights';
import { noFog, type Fog } from '../fog';

const SIZE = 192;
const FRAME_DIR: string | undefined = import.meta.env.VITE_FRAME_DIR;
/** Millimetres in a metre: the scale the whole test turns on. */
const MM = 1000;

function meshOf(src: string) {
  const { sketch, error } = compile(src);
  if (error) throw new Error(error.formatted);
  return groupByMesh(sketch!.assembly)[0].mesh;
}
function at(x: number, y: number, z: number): Float32Array {
  const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1;
  m[12] = x; m[13] = y; m[14] = z; return m;
}

const FLOOR = `material silver satin
part floor = plate(card(width: 5000, height: 5000, corner: 2), thickness: 10)
form f { place floor }
`;
const SLAB = `material silver satin
part slab = plate(card(width: 700, height: 700, corner: 2), thickness: 20)
form s { place slab }
`;

/** The scene in millimetres: a floor, and a slab floating over it. */
function scene(): GameGroup[] {
  return [
    { mesh: meshOf(FLOOR), matrices: at(0, 0, 0), albedo: [0.35, 0.34, 0.33], roughness: 0.7 },
    { mesh: meshOf(SLAB), matrices: at(0, -200, 900), albedo: [0.6, 0.58, 0.55], roughness: 0.5 },
  ];
}

/** The same groups a thousand times smaller in number: metres, told as such. */
function inMetres(groups: GameGroup[]): GameGroup[] {
  const k = 1 / MM;
  return groups.map((g) => {
    const matrices = new Float32Array(g.matrices);
    for (let i = 12; i < matrices.length; i += 16) { matrices[i] *= k; matrices[i + 1] *= k; matrices[i + 2] *= k; }
    return { ...g, mesh: { ...g.mesh, positions: g.mesh.positions.map((v) => v * k) }, matrices };
  });
}

/** The lamp, in the unit `u` millimetres make one of. */
function lamp(renderer: GameRenderer, u: number) {
  const pool = new LightPool(8);
  pool.add({
    position: [0, 0, 2400 / u], radius: 4200 / u, colour: [1, 0.95, 0.88], intensity: 26,
    direction: [0, 0, -1], cone: [15, 32],
  });
  renderer.setLights(pool, [0]);
}

/** The look and the fog, as a game working in that unit would write them. */
function stage(renderer: GameRenderer, u: number) {
  const look: Look = {
    ...renderer.look,
    ambient: 0.1, background: [0.01, 0.01, 0.013],
    sunDir: [0.2, 0.3, 0.93], sunColour: [0.04, 0.045, 0.06],
    // a length, and so smaller in metres; and a thing per length, and so larger
    falloffHalf: 1400 / u,
    spotSoftness: (1 / 500) * u,
  };
  const fog: Fog = {
    ...noFog(u),
    // per world unit, so it is the one that multiplies where the rest divide
    density: 5e-4 * u,
    base: 0, height: 900 / u, reach: 7000 / u,
    colour: [1, 0.98, 0.95], ambient: 0.05, anisotropy: 0.55, steps: 28, cones: 1,
  };
  renderer.look = look;
  renderer.fog = fog;
  renderer.economy = { ...renderer.economy, post: false };
  renderer.setSunShadow({ min: [-3000 / u, -3000 / u, -100 / u], max: [3000 / u, 3000 / u, 2600 / u] });
  renderer.camera.position = [1200 / u, -3000 / u, 1700 / u];
  renderer.camera.target = [0, 0, 300 / u];
  renderer.camera.near = 20 / u;
  renderer.camera.far = 12000 / u;
  renderer.resize(SIZE, SIZE);
}

describe('the game path in other units', () => {
  let gpu: Gpu;
  let target: GPUTexture;
  let env: { specular: GPUTexture; brdf: GPUTexture; mips: number };
  const made: GameRenderer[] = [];

  beforeAll(async () => {
    gpu = await createDevice();
    target = gpu.device.createTexture({
      label: 'units target', size: [SIZE, SIZE], format: gpu.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const baked = bakeEnvironment(gpu, 'studio', { size: 32, mips: 3 });
    await baked.samples;
    env = { specular: baked.specular, brdf: baked.brdf, mips: baked.mips };
  });

  afterAll(() => {
    for (const r of made) r.dispose();
    target?.destroy();
    gpu?.device.destroy();
  });

  /** A renderer told the world is `mmPerUnit` millimetres to the unit. */
  async function renderer(mmPerUnit: number): Promise<GameRenderer> {
    const r = new GameRenderer(gpu, 8, 8, 64, mmPerUnit);
    made.push(r);
    await r.ready;
    r.setEnvironment(env.specular, env.brdf, env.mips);
    r.setDynamic([]);
    return r;
  }

  async function shot(name: string, groups: GameGroup[], unit: number, told: number): Promise<Uint8Array> {
    const r = await renderer(told);
    stage(r, unit);
    r.setStatic(groups);
    lamp(r, unit);
    r.frame(target.createView(), 'redraw', 1 / 60);
    await gpu.queue.onSubmittedWorkDone();

    const row = Math.ceil((SIZE * 4) / 256) * 256;
    const buf = gpu.device.createBuffer({ size: row * SIZE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = gpu.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: row, rowsPerImage: SIZE }, [SIZE, SIZE, 1]);
    gpu.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const packed = new Uint8Array(buf.getMappedRange().slice(0));
    buf.unmap(); buf.destroy();
    const px = new Uint8Array(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++) px.set(packed.subarray(y * row, y * row + SIZE * 4), y * SIZE * 4);
    await save(name, px);
    return px;
  }

  async function save(name: string, px: Uint8Array) {
    if (!FRAME_DIR) return;
    const c = document.createElement('canvas');
    c.width = SIZE; c.height = SIZE;
    const g = c.getContext('2d')!;
    const img = g.createImageData(SIZE, SIZE);
    const bgr = gpu.format.startsWith('bgra');
    for (let i = 0; i < SIZE * SIZE; i++) {
      const o = i * 4;
      img.data.set(bgr ? [px[o + 2], px[o + 1], px[o], 255] : [px[o], px[o + 1], px[o + 2], 255], o);
    }
    g.putImageData(img, 0, 0);
    await server.commands.writeFile(`${FRAME_DIR}/${name}.png`, c.toDataURL('image/png').split(',')[1], 'base64');
  }

  /** Mean absolute difference per channel, 0..255. */
  function difference(a: Uint8Array, b: Uint8Array): number {
    let sum = 0; let n = 0;
    for (let i = 0; i < a.length; i += 4) {
      for (let c = 0; c < 3; c++) { sum += Math.abs(a[i + c] - b[i + c]); n++; }
    }
    return sum / n;
  }

  it('draws a scene modelled in metres as it drew it in millimetres', async () => {
    const mm = await shot('units-mm', scene(), 1, 1);
    const metres = await shot('units-metres', inMetres(scene()), MM, MM);
    // the same bar the still-life path is held to: within a step of 8-bit
    expect(difference(mm, metres)).toBeLessThan(2);
  });

  it('and differs from the same scene drawn by a renderer not told the unit', async () => {
    const metres = await shot('units-metres-again', inMetres(scene()), MM, MM);
    const ignored = await shot('units-ignored', inMetres(scene()), MM, 1);
    // the spot's near plane, its soft bias and its gravity are all lengths:
    // left in millimetres in a world of metres they are off by a thousand
    expect(difference(metres, ignored)).toBeGreaterThan(2);
  });
});
