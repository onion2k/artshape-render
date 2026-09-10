/**
 * Shadows, on a real device: a box over a floor, and the floor under it
 * darker than the floor beside it — for the sun, for a spotlight, and not
 * at all when the maps are turned off. Pixel checks, like the rest of the
 * game suite, because a shadow that is not there has no other symptom.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { compile } from '../../dsl/index';
import { groupByMesh } from '../../assembly/groups';
import { GameRenderer, type GameGroup } from '../renderer';
import { LightPool } from '../lights';

const SIZE = 256;

function meshOf(source: string) {
  const { sketch, error } = compile(source);
  if (error) throw new Error(error.formatted);
  const groups = groupByMesh(sketch!.assembly);
  return groups[0].mesh;
}

/** A placement: identity, moved to a point. */
function at(x: number, y: number, z: number): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

const FLOOR = `material silver satin
part floor = plate(card(width: 400, height: 400, corner: 10), thickness: 6)
form f { place floor }
`;
const BOX = `material silver satin
part box = plate(card(width: 90, height: 90, corner: 4), thickness: 50)
form b { place box }
`;

describe('shadows on the game renderer', () => {
  let gpu: Gpu;
  let renderer: GameRenderer;
  let target: GPUTexture;
  const view = () => target.createView();

  beforeAll(async () => {
    gpu = await createDevice();
    renderer = new GameRenderer(gpu, 16, 8);
    await renderer.ready;
    target = gpu.device.createTexture({
      size: [SIZE, SIZE], format: gpu.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const env = bakeEnvironment(gpu, 'studio', { size: 64, mips: 4 });
    await env.samples;
    renderer.setEnvironment(env.specular, env.brdf, env.mips);
    renderer.resize(SIZE, SIZE);
    // The floor, and a box hanging 90 above it with its centre over the
    // origin. The DSL builds a plate about its own centre, so a placement
    // at the origin is a plate centred there — the first version of this
    // moved each by half its width and drew half a floor.
    const floor: GameGroup = { mesh: meshOf(FLOOR), matrices: at(0, 0, 0), albedo: [0.8, 0.8, 0.8], roughness: 0.7 };
    const box: GameGroup = { mesh: meshOf(BOX), matrices: at(0, 0, 90), albedo: [0.8, 0.8, 0.8], roughness: 0.7 };
    renderer.setStatic([floor]);
    renderer.setDynamic([box]);
    // from high enough that the floor either side of the box is in view
    renderer.camera.position = [0, -200, 600];
    renderer.camera.target = [0, 0, 0];
    // A dim environment, so what lights the floor is the sun or the lamp;
    // and lights that carry to this scale, because the look's default half
    // distance of fifty is a piece of jewellery's and here a lamp is four
    // hundred from the floor it lights.
    renderer.look = { ...renderer.look, ambient: 0.02, background: [0, 0, 0], falloffHalf: 600 };
  });

  afterAll(() => { renderer?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  /** Where a world point lands on the target, in pixels. */
  function pixelOf(p: [number, number, number]): [number, number] {
    renderer.camera.update();
    const m = renderer.camera.viewProjection;
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    return [Math.round((x / w * 0.5 + 0.5) * SIZE), Math.round((0.5 - y / w * 0.5) * SIZE)];
  }

  /** Mean brightness of a 5×5 patch of the target. */
  async function readAt([cx, cy]: [number, number]): Promise<number> {
    await gpu.queue.onSubmittedWorkDone();
    const bytesPerRow = Math.ceil((SIZE * 4) / 256) * 256;
    const buffer = gpu.device.createBuffer({ size: bytesPerRow * SIZE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = gpu.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow, rowsPerImage: SIZE }, [SIZE, SIZE, 1]);
    gpu.queue.submit([enc.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(buffer.getMappedRange().slice(0));
    buffer.unmap(); buffer.destroy();
    let sum = 0, n = 0;
    for (let y = cy - 2; y <= cy + 2; y++) {
      for (let x = cx - 2; x <= cx + 2; x++) {
        const o = y * bytesPerRow + x * 4;
        sum += px[o] + px[o + 1] + px[o + 2]; n += 3;
      }
    }
    return sum / n;
  }

  // The floor's top is at 6. The lights stand off to +x, so the box's
  // shadow falls to -x, on floor the camera can see past the box: a point
  // straight under the box is a point the box is in front of, and reads as
  // the box — which is what the first version of this test measured.
  const UNDER: [number, number, number] = [-75, 0, 6];
  const BESIDE: [number, number, number] = [150, 0, 6];

  it('the sun casts: the floor in the box\'s shadow is darker than the floor beside it', async () => {
    renderer.look = { ...renderer.look, sunDir: [0.55, 0, 0.83], sunColour: [3, 3, 3] };
    renderer.setLights(new LightPool(16));
    renderer.setSunShadow({ min: [-250, -250, -20], max: [250, 250, 200] });
    renderer.frame(view());
    const under = await readAt(pixelOf(UNDER));
    const beside = await readAt(pixelOf(BESIDE));
    expect(beside).toBeGreaterThan(20);
    expect(under).toBeLessThan(beside * 0.6);
  });

  it('and does not, with no box to fit the map to', async () => {
    // the same two points, map off: the shadowed one comes back up, and the
    // one that was never shadowed does not move
    renderer.frame(view());
    const underMapped = await readAt(pixelOf(UNDER));
    const besideMapped = await readAt(pixelOf(BESIDE));
    renderer.setSunShadow(null);
    renderer.frame(view());
    const under = await readAt(pixelOf(UNDER));
    const beside = await readAt(pixelOf(BESIDE));
    expect(underMapped).toBeLessThan(under * 0.6);
    expect(Math.abs(beside - besideMapped)).toBeLessThan(beside * 0.15);
  });

  it('a floor lit straight on does not shadow itself', async () => {
    // acne: a flat floor under the sun, with the box moved away, must be as
    // bright with the map as without it, everywhere
    renderer.move(0, at(0, 0, 900), 1);
    renderer.setSunShadow({ min: [-250, -250, -20], max: [250, 250, 1000] });
    renderer.frame(view());
    const mapped = await readAt(pixelOf(UNDER));
    renderer.setSunShadow(null);
    renderer.frame(view());
    const flat = await readAt(pixelOf(UNDER));
    renderer.move(0, at(0, 0, 90), 1);
    expect(mapped).toBeGreaterThan(flat * 0.9);
  });

  it('a spotlight casts, when asked to, and not otherwise', async () => {
    renderer.look = { ...renderer.look, sunColour: [0, 0, 0] };
    renderer.setSunShadow(null);
    const pool = new LightPool(16);
    pool.add({ position: [120, 0, 380], radius: 900, colour: [1, 1, 1], intensity: 40, direction: [-120, 0, -380], cone: [30, 50] });

    renderer.setLights(pool, [0]);
    renderer.frame(view());
    const shadowed = await readAt(pixelOf(UNDER));
    const besideShadowed = await readAt(pixelOf(BESIDE));

    renderer.setLights(pool, []);
    renderer.frame(view());
    const open = await readAt(pixelOf(UNDER));

    expect(besideShadowed).toBeGreaterThan(20);
    expect(open).toBeGreaterThan(20);
    expect(shadowed).toBeLessThan(open * 0.6);
  });

  it('gives the flat picture when the ladder turns shadows off', async () => {
    const pool = new LightPool(16);
    pool.add({ position: [120, 0, 380], radius: 900, colour: [1, 1, 1], intensity: 40, direction: [-120, 0, -380], cone: [30, 50] });
    renderer.setLights(pool, [0]);
    renderer.economy = { ...renderer.economy, shadows: false };
    renderer.frame(view());
    const off = await readAt(pixelOf(UNDER));
    renderer.economy = { ...renderer.economy, shadows: true };
    renderer.setLights(pool, []);
    renderer.frame(view());
    const open = await readAt(pixelOf(UNDER));
    expect(Math.abs(off - open)).toBeLessThan(open * 0.15);
  });
});
