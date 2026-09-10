/**
 * Cones in the fog, on a real device.
 *
 * A lamp in mist should light the air it shines through, in the shape of its
 * own beam, and stop lighting it where something stands in the way. So: the
 * air under a spotlight goes bright when the cones come on and stays dark
 * when they do not; the air beside the beam stays dark either way; and the
 * same lamp put behind a slab lights nothing, because a cone that shines
 * through solid matter is worse than no cone at all.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { compile } from '../../dsl/index';
import { groupByMesh } from '../../assembly/groups';
import { GameRenderer, type GameGroup } from '../renderer';
import { LightPool } from '../lights';
import { NO_FOG } from '../fog';

const SIZE = 256;

function meshOf(src: string) {
  const { sketch, error } = compile(src);
  if (error) throw new Error(error.formatted);
  return groupByMesh(sketch!.assembly)[0].mesh;
}
function at(x: number, y: number, z: number): Float32Array {
  const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1;
  m[12] = x; m[13] = y; m[14] = z; return m;
}
/** A lid to hold a beam off the air below it. Centred in x, from zero in y. */
const LID = `material silver satin
part lid = plate(card(width: 500, height: 3000, corner: 2), thickness: 10)
form l { place lid }
`;

describe('cones in the fog', () => {
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
    renderer.setDynamic([]);
    renderer.setSunShadow({ min: [-1500, -1500, -100], max: [1500, 2200, 1200] });
    // night: no sun, no sky, nothing in the air but what the lamps put there
    renderer.look = {
      ...renderer.look, ambient: 0, background: [0, 0, 0],
      sunDir: [0, 0, 1], sunColour: [0, 0, 0], falloffHalf: 600,
    };
    renderer.camera.position = [0, -1400, 150];
    renderer.camera.target = [0, 0, 150];
    renderer.camera.near = 1;
    renderer.camera.far = 6000;
    renderer.economy = { ...renderer.economy, post: false };
  });

  afterAll(() => { renderer?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  async function read(): Promise<{ px: Uint8Array; row: number }> {
    await gpu.queue.onSubmittedWorkDone();
    const row = Math.ceil((SIZE * 4) / 256) * 256;
    const buf = gpu.device.createBuffer({ size: row * SIZE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = gpu.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: row, rowsPerImage: SIZE }, [SIZE, SIZE, 1]);
    gpu.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(buf.getMappedRange().slice(0));
    buf.unmap(); buf.destroy();
    return { px, row };
  }
  const patch = (f: { px: Uint8Array; row: number }, x0: number, y0: number, n = 18) => {
    let s = 0;
    for (let y = y0; y < y0 + n; y++) for (let x = x0; x < x0 + n; x++) {
      const o = y * f.row + x * 4; s += (f.px[o] + f.px[o + 1] + f.px[o + 2]) / 3;
    }
    return s / (n * n);
  };

  const MIST = { ...NO_FOG, density: 9e-4, base: 0, height: 400, colour: [1, 1, 1] as [number, number, number], ambient: 0, anisotropy: 0.2, reach: 3000, steps: 40 };

  /** One spotlight, hanging at x and aimed straight down, with a map of its own. */
  function lamp(x: number) {
    const pool = new LightPool(8);
    pool.add({
      position: [x, 200, 700], radius: 1600, colour: [1, 1, 1], intensity: 30,
      direction: [0, 0, -1], cone: [14, 26],
    });
    renderer.setLights(pool, [0]);
  }

  /** The air just under a lamp hung at x, and the air well to the side of it. */
  const UNDER = [104, 128] as const;
  const BESIDE = [16, 128] as const;

  it('lights the air under a lamp, and only when the cones are on', async () => {
    renderer.setStatic([]);
    lamp(0);
    renderer.fog = { ...MIST, cones: 0 };
    renderer.frame(view(), 'redraw', 1 / 60);
    const off = await read();
    renderer.fog = { ...MIST, cones: 1 };
    renderer.frame(view(), 'redraw', 1 / 60);
    const on = await read();
    expect(patch(off, ...UNDER)).toBeLessThan(2);
    expect(patch(on, ...UNDER)).toBeGreaterThan(patch(off, ...UNDER) + 12);
  });

  it('keeps the beam a beam: the air beside it stays dark', async () => {
    renderer.setStatic([]);
    lamp(0);
    renderer.fog = { ...MIST, cones: 1 };
    renderer.frame(view(), 'redraw', 1 / 60);
    const f = await read();
    expect(patch(f, ...BESIDE)).toBeLessThan(patch(f, ...UNDER) * 0.35);
  });

  it('cuts the cone with whatever stands in it', async () => {
    // the same lamp, once in the open and once over a lid that takes its
    // light before the light reaches the air being looked at
    renderer.setStatic([]);
    lamp(0);
    renderer.fog = { ...MIST, cones: 1 };
    renderer.frame(view(), 'redraw', 1 / 60);
    const open = await read();

    renderer.setStatic([{ mesh: meshOf(LID), matrices: at(0, -1000, 430), albedo: [0.5, 0.5, 0.5], roughness: 0.8 } as GameGroup]);
    lamp(0);
    renderer.frame(view(), 'redraw', 1 / 60);
    const shut = await read();
    renderer.setStatic([]);

    expect(patch(open, ...UNDER)).toBeGreaterThan(12);
    expect(patch(shut, ...UNDER)).toBeLessThan(patch(open, ...UNDER) * 0.5);
  });
});
