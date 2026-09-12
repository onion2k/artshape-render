/**
 * A lamp of the rig: a light standing in the scene rather than a disc in the
 * sky, throwing a cone, held to the tracer.
 *
 * Three things have to be true of it, and the third is the one worth the
 * device. It has to have an edge — a pool on the table and darkness outside
 * it, or it is not a cone. It has to cast — the bead's shadow on the table,
 * or it is not a light with a place. And the raster and the tracer have to
 * agree about all of it, because they work it out differently: the raster
 * from a shadow map and a blocker search, the tracer by firing rays at a
 * sphere of light, and where the two disagree the tracer is the reference.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { Renderer } from '../renderer';
import { compile } from '../../dsl/index';
import { groupByMesh } from '../../assembly/groups';

const SIZE = 256;
/** Where the lamp hangs, and what it looks at. */
const LAMP: [number, number, number] = [40, -28, 55];
const AIM: [number, number, number] = [0, 0, 3];

describe('a lamp in the rig', () => {
  let gpu: Gpu; let renderer: Renderer; let target: GPUTexture;
  const view = () => target.createView();

  beforeAll(async () => {
    gpu = await createDevice();
    renderer = new Renderer(gpu);
    await renderer.ready;
    target = gpu.device.createTexture({ size: [SIZE, SIZE], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    // the bead hangs clear of the table, so that its shadow is beside it and
    // not under it: a squat thing sitting on a surface under a high lamp
    // throws a shadow its own base covers, which is a lighting arrangement
    // and not a test of one
    const r = compile('part b = bead(radius: 6, point: 3) in silver satin\nform f {\n  place b at (0, 0, 12)\n}\n');
    renderer.setSize(SIZE, SIZE);
    renderer.setInstanced(groupByMesh(r.sketch!.assembly));
    renderer.setTable('matte');
    renderer.frameBounds({ min: [-40, -40, 0], max: [40, 40, 12] });
    renderer.setFocus(90, 90);
    // a nearly dark room: what lights this scene is the lamp
    renderer.setEnvironmentImage({ width: 8, height: 4, data: new Float32Array(8 * 4 * 4).fill(0.02) }, 0.02);
    await renderer.setEnvironment('image').samples;
    renderer.setKeyLight({ elevation: 1, azimuth: 0, strength: 0, warmth: 0, size: 0.05 });
    renderer.setRig([{
      elevation: 0, azimuth: 0, strength: 2.6, warmth: 0.1, size: 3,
      at: LAMP, aim: AIM, cone: [16, 26],
    }]);
  });
  afterAll(() => { renderer.dispose(); target.destroy(); gpu.device.destroy(); });

  async function pixels(): Promise<Uint8Array> {
    await gpu.queue.onSubmittedWorkDone();
    const buffer = gpu.device.createBuffer({ size: SIZE * 4 * SIZE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = gpu.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: SIZE * 4 }, [SIZE, SIZE, 1]);
    gpu.queue.submit([enc.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(buffer.getMappedRange()).slice();
    buffer.unmap(); buffer.destroy();
    return px;
  }

  /** The mean brightness of a patch of the frame round a world point. */
  function at(px: Uint8Array, p: [number, number, number], r = 4): number {
    renderer.camera.update();
    const m = renderer.camera.viewProjection;
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    const cx = Math.round((((m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w) * 0.5 + 0.5) * SIZE);
    const cy = Math.round((1 - (((m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w) * 0.5 + 0.5)) * SIZE);
    let sum = 0, n = 0;
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
      const o = (y * SIZE + x) * 4;
      sum += (px[o] + px[o + 1] + px[o + 2]) / 3; n++;
    }
    return sum / Math.max(n, 1);
  }

  async function raster(): Promise<Uint8Array> {
    renderer.setQuality('final'); renderer.setMoving(false);
    const deadline = performance.now() + 20_000;
    do { renderer.render(view); await new Promise((r) => setTimeout(r, 10)); } while (renderer.pending && performance.now() < deadline);
    renderer.requestRender(); renderer.render(view);
    return pixels();
  }
  async function traced(samples: number): Promise<Uint8Array> {
    renderer.setQuality('traced'); renderer.setMoving(false);
    for (let i = 0; i < 20000 && renderer.traceSamples < samples; i++) { renderer.requestRender(); renderer.render(view); await new Promise((r) => setTimeout(r, 1)); }
    const px = await pixels();
    renderer.setQuality('draft');
    return px;
  }

  /**
   * Four places on the table, along the line the lamp throws the bead's
   * shadow down: in the pool on the lamp's side, in the shadow, the shadow's
   * mirror image on the lit side — the fair comparison, since a pool falls
   * off from its middle either way — and well outside the cone.
   */
  const LIT: [number, number, number] = [8.2, -5.8, 0.2];
  const SHADE: [number, number, number] = [-3.3, 2.3, 0.2];
  const MIRROR: [number, number, number] = [3.3, -2.3, 0.2];
  const OUTSIDE: [number, number, number] = [-18, 12.7, 0.2];

  it('pools where it is aimed and leaves the rest of the table dark', async () => {
    const px = await raster();
    expect(at(px, LIT)).toBeGreaterThan(60);
    // past the cone's edge what light the table has is the room's, and the
    // room here is nearly out
    expect(at(px, OUTSIDE)).toBeLessThan(at(px, LIT) * 0.35);
  });

  it('casts the bead onto the table', async () => {
    const px = await raster();
    // against its mirror image in the pool, not against the pool's middle:
    // a lamp falls off from where it is aimed, and that fall is not a shadow
    expect(at(px, SHADE)).toBeLessThan(at(px, MIRROR) * 0.75);
  });

  it('agrees with the tracer about the pool, the shadow and the edge', async () => {
    const a = await raster();
    const b = await traced(200);
    for (const [name, p] of [['lit', LIT], ['shade', SHADE], ['mirror', MIRROR], ['outside', OUTSIDE]] as const) {
      expect(Math.abs(at(a, p) - at(b, p)), `${name}: raster ${at(a, p).toFixed(1)} against traced ${at(b, p).toFixed(1)}`).toBeLessThan(8);
    }
  });
});
