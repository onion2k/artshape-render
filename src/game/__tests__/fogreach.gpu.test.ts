/**
 * The far end of the march, on a real device.
 *
 * A march that runs out of reach rather than running into something has to
 * taper. Without it the fog reaches full strength at a fixed distance from
 * the eye and stops — and the set of points a fixed distance from the eye is
 * a sphere, which is an arc ruled across the frame, straight enough over a
 * narrow view to look like somebody drew it there. This is the test that
 * says so: a ground plane four times the fog's reach, an arena-like camera
 * well above it, and the fog's own contribution measured as the difference
 * between a frame with it and a frame without.
 *
 * The measure is the sharpest step between neighbouring bands of the frame.
 * Untapered the same scene reads 8.2 levels against a range of 46; tapered
 * it is 5.1 against 40, and the transition is spread over twice as many
 * rows. The bound below sits between the two.
 */
/// <reference types="vite/client" />
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { compile } from '../../dsl/index';
import { groupByMesh } from '../../assembly/groups';
import { GameRenderer, type GameGroup } from '../renderer';
import { LightPool } from '../lights';
import { NO_FOG } from '../fog';

const SIZE = 384;
const BANDS = 48;

function meshOf(src: string) {
  const { sketch, error } = compile(src);
  if (error) throw new Error(error.formatted);
  return groupByMesh(sketch!.assembly)[0].mesh;
}
function at(x: number, y: number, z: number): Float32Array {
  const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1;
  m[12] = x; m[13] = y; m[14] = z; return m;
}
/** Ground far wider than the fog reaches, so the march runs out rather than landing. */
const GROUND = `material silver satin
part g = plate(card(width: 40000, height: 40000, corner: 2), thickness: 20)
form f { place g }
`;

describe('the far end of a fog march', () => {
  let gpu: Gpu; let renderer: GameRenderer; let target: GPUTexture;
  const view = () => target.createView();

  beforeAll(async () => {
    gpu = await createDevice();
    renderer = new GameRenderer(gpu, 8, 8, 64);
    await renderer.ready;
    target = gpu.device.createTexture({ size: [SIZE, SIZE], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const env = bakeEnvironment(gpu, 'studio', { size: 32, mips: 3 });
    await env.samples;
    renderer.setEnvironment(env.specular, env.brdf, env.mips);
    renderer.resize(SIZE, SIZE);
    renderer.setStatic([{ mesh: meshOf(GROUND), matrices: at(0, -20000, 0), albedo: [0.5, 0.5, 0.5], roughness: 0.9 } as GameGroup]);
    renderer.setDynamic([]);
    renderer.setLights(new LightPool(8));
    renderer.setSunShadow({ min: [-14000, -14000, -200], max: [14000, 14000, 1500] });
    renderer.look = { ...renderer.look, ambient: 0.2, background: [0.2, 0.22, 0.26], sunDir: [0.2, 0.6, 0.35], sunColour: [1.6, 1.2, 0.9] };
    renderer.camera.position = [0, -3000, 2200];
    renderer.camera.target = [0, 1500, 0];
    renderer.camera.near = 1;
    renderer.camera.far = 40000;
    // the post chain would put bloom and grain on top of what is being measured
    renderer.economy = { ...renderer.economy, post: false };
  });

  afterAll(() => { renderer?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  async function read(): Promise<number[][]> {
    await gpu.queue.onSubmittedWorkDone();
    const row = Math.ceil((SIZE * 4) / 256) * 256;
    const buf = gpu.device.createBuffer({ size: row * SIZE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = gpu.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: row, rowsPerImage: SIZE }, [SIZE, SIZE, 1]);
    gpu.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(buf.getMappedRange().slice(0));
    buf.unmap(); buf.destroy();
    const out: number[][] = [];
    for (let y = 0; y < SIZE; y++) {
      const r: number[] = [];
      for (let x = 0; x < SIZE; x++) { const o = y * row + x * 4; r.push((px[o] + px[o + 1] + px[o + 2]) / 3); }
      out.push(r);
    }
    return out;
  }

  /** The fog's own contribution, in bands, and the sharpest step in it. */
  async function contribution(mist: typeof NO_FOG) {
    renderer.fog = { ...mist, density: 0 };
    renderer.frame(view(), 'redraw', 1 / 60);
    const off = await read();
    renderer.fog = mist;
    renderer.frame(view(), 'redraw', 1 / 60);
    const on = await read();
    const k = SIZE / BANDS;
    const cell = (img: number[][], gy: number, gx: number) => {
      let s = 0;
      for (let y = gy * k; y < (gy + 1) * k; y++) for (let x = gx * k; x < (gx + 1) * k; x++) s += img[y][x];
      return s / (k * k);
    };
    const d: number[][] = [];
    for (let gy = 0; gy < BANDS; gy++) {
      const r: number[] = [];
      for (let gx = 0; gx < BANDS; gx++) r.push(cell(on, gy, gx) - cell(off, gy, gx));
      d.push(r);
    }
    const flat = d.flat();
    let worst = 0;
    for (let gx = 2; gx < BANDS - 2; gx++) {
      for (let gy = 2; gy < BANDS - 3; gy++) worst = Math.max(worst, Math.abs(d[gy + 1][gx] - d[gy][gx]));
    }
    return { worst, range: Math.max(...flat) - Math.min(...flat) };
  }

  it('fades out where it runs out of reach, instead of stopping at an arc', async () => {
    const MIST = { ...NO_FOG, density: 2.6e-4, base: 0, height: 300, ambient: 0.3, anisotropy: 0.62, reach: 9000, steps: 28 };
    renderer.fog = { ...MIST, density: 0 };
    renderer.frame(view(), 'redraw', 1 / 60);
    const off = await read();
    renderer.fog = MIST;
    renderer.frame(view(), 'redraw', 1 / 60);
    const on = await read();

    // the fog's own contribution, in bands, so that the grain and the
    // half-size march are averaged away and what is left is its shape
    const k = SIZE / BANDS;
    const cell = (img: number[][], gy: number, gx: number) => {
      let s = 0;
      for (let y = gy * k; y < (gy + 1) * k; y++) for (let x = gx * k; x < (gx + 1) * k; x++) s += img[y][x];
      return s / (k * k);
    };
    const d: number[][] = [];
    for (let gy = 0; gy < BANDS; gy++) {
      const r: number[] = [];
      for (let gx = 0; gx < BANDS; gx++) r.push(cell(on, gy, gx) - cell(off, gy, gx));
      d.push(r);
    }
    const flat = d.flat();
    const range = Math.max(...flat) - Math.min(...flat);
    let worst = 0;
    for (let gx = 2; gx < BANDS - 2; gx++) {
      for (let gy = 2; gy < BANDS - 3; gy++) worst = Math.max(worst, Math.abs(d[gy + 1][gx] - d[gy][gx]));
    }
    // there is fog at all, and it has no step in it worth calling an edge
    expect(range).toBeGreaterThan(20);
    expect(worst).toBeLessThan(6.5);
  });
});
