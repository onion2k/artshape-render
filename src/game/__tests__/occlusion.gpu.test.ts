/**
 * Screen-space occlusion, on a real device: a box standing on a floor, lit
 * by the environment alone, and the floor against the box darker than the
 * floor out in the open — and not, with the strength at nothing or the rung
 * off. The lights take only `occlusionDirect` of it.
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
  return groupByMesh(sketch!.assembly)[0].mesh;
}

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

describe('occlusion on the game renderer', () => {
  let gpu: Gpu;
  let renderer: GameRenderer;
  let target: GPUTexture;
  const view = () => target.createView();

  beforeAll(async () => {
    gpu = await createDevice();
    renderer = new GameRenderer(gpu, 8, 8);
    await renderer.ready;
    target = gpu.device.createTexture({
      size: [SIZE, SIZE], format: gpu.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const env = bakeEnvironment(gpu, 'studio', { size: 64, mips: 4 });
    await env.samples;
    renderer.setEnvironment(env.specular, env.brdf, env.mips);
    renderer.resize(SIZE, SIZE);
    // the floor's top at 6 and the box standing on it: plates are built about their centre
    const floor: GameGroup = { mesh: meshOf(FLOOR), matrices: at(0, 0, 0), albedo: [0.8, 0.8, 0.8], roughness: 0.8 };
    const box: GameGroup = { mesh: meshOf(BOX), matrices: at(0, 100, 31), albedo: [0.8, 0.8, 0.8], roughness: 0.8 };
    renderer.setStatic([floor]);
    renderer.setDynamic([box]);
    renderer.setLights(new LightPool(8));
    renderer.camera.position = [0, -200, 600];
    renderer.camera.target = [0, 0, 0];
    renderer.post = { bloom: 0, threshold: 1, knee: 0.5, vignette: 0, grain: 0 };
  });

  afterAll(() => { renderer?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  function pixelOf(p: [number, number, number]): [number, number] {
    renderer.camera.update();
    const m = renderer.camera.viewProjection;
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    return [Math.round((x / w * 0.5 + 0.5) * SIZE), Math.round((0.5 - y / w * 0.5) * SIZE)];
  }

  /** Mean brightness of a 5×5 patch round each of the points, in one read. */
  async function readAt(...points: [number, number, number][]): Promise<number[]> {
    await gpu.queue.onSubmittedWorkDone();
    const bytesPerRow = Math.ceil((SIZE * 4) / 256) * 256;
    const buffer = gpu.device.createBuffer({ size: bytesPerRow * SIZE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = gpu.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow, rowsPerImage: SIZE }, [SIZE, SIZE, 1]);
    gpu.queue.submit([enc.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(buffer.getMappedRange().slice(0));
    buffer.unmap(); buffer.destroy();
    return points.map((p) => {
      const [cx, cy] = pixelOf(p);
      let sum = 0, n = 0;
      for (let y = cy - 2; y <= cy + 2; y++) {
        for (let x = cx - 2; x <= cx + 2; x++) {
          const o = y * bytesPerRow + x * 4;
          sum += px[o] + px[o + 1] + px[o + 2]; n += 3;
        }
      }
      return sum / n;
    });
  }

  // A line of floor running up to the foot of the box's -y face, the face
  // the camera looks at, and floor out in the open as far from the camera.
  // The occlusion is of what the screen shows: floor beside a face the
  // camera cannot see has nothing on screen near it to be shaded by, which
  // is what the first version of this test measured. A card runs up from
  // its placement in y and is centred in x, so the floor is y 0 to 400 and
  // the box's face is at y = 100; the line stops short of it.
  const LINE: [number, number, number][] = Array.from({ length: 16 }, (_, i) => [0, 66 + i * 2, 6]);
  const OPEN: [number, number, number] = [165, 90, 6];
  const darkest = (values: number[]) => Math.min(...values.slice(0, LINE.length));

  it('darkens the floor against the box and not the floor in the open, under the environment', async () => {
    renderer.look = { ...renderer.look, ambient: 0.25, sunColour: [0, 0, 0], background: [0, 0, 0], occlusion: 0, occlusionRadius: 60 };
    renderer.frame(view());
    const plain = await readAt(...LINE, OPEN);
    renderer.look = { ...renderer.look, occlusion: 2 };
    renderer.frame(view());
    const shaded = await readAt(...LINE, OPEN);
    expect(darkest(plain)).toBeGreaterThan(20);
    expect(darkest(shaded)).toBeLessThan(darkest(plain) * 0.9);
    const open = shaded[LINE.length], plainOpen = plain[LINE.length];
    expect(Math.abs(open - plainOpen)).toBeLessThan(plainOpen * 0.03 + 1);
  });

  it('draws none with the rung off, whatever the strength', async () => {
    renderer.look = { ...renderer.look, ambient: 0.25, sunColour: [0, 0, 0], occlusion: 0 };
    renderer.frame(view());
    const plain = darkest(await readAt(...LINE));
    renderer.look = { ...renderer.look, occlusion: 1 };
    renderer.economy = { ...renderer.economy, occlusion: false };
    renderer.frame(view());
    const off = darkest(await readAt(...LINE));
    renderer.economy = { ...renderer.economy, occlusion: true };
    expect(Math.abs(off - plain)).toBeLessThan(plain * 0.03 + 1);
  });

  it('leaves the lights alone with occlusionDirect at nothing, and shades them with it at one', async () => {
    // the sun alone, from overhead and unshadowed, so the floor against the
    // box is lit exactly as the open floor is
    const sunOnly = { ambient: 0, sunDir: [0, 0, 1] as [number, number, number], sunColour: [0.6, 0.6, 0.6] as [number, number, number] };
    renderer.look = { ...renderer.look, ...sunOnly, occlusion: 0, occlusionDirect: 0.25 };
    renderer.frame(view());
    const plain = darkest(await readAt(...LINE));
    renderer.look = { ...renderer.look, occlusion: 2, occlusionDirect: 0 };
    renderer.frame(view());
    const untouched = darkest(await readAt(...LINE));
    renderer.look = { ...renderer.look, occlusionDirect: 1 };
    renderer.frame(view());
    const shaded = darkest(await readAt(...LINE));
    expect(plain).toBeGreaterThan(20);
    expect(Math.abs(untouched - plain)).toBeLessThan(plain * 0.03 + 1);
    expect(shaded).toBeLessThan(plain * 0.9);
  });
});
