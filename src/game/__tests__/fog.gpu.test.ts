/**
 * Fog with a volume, on a real device. The two things it has to do that
 * distance fog cannot: light the empty air the sun shines through, and stop
 * lighting it where something is in the way. So a black frame with nothing
 * in it goes grey when the fog comes on; the air under a slab is darker than
 * the air beside it, which is a shaft of light and the whole point; the
 * layer lies at a height and can be raised past the camera; and looking
 * toward the sun is brighter than looking away from it.
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

/**
 * A slab 400 across in x and long enough in y to cover the whole of a
 * march: half the sky, with its edge over x = 0.
 *
 * Two things about where it goes, both learned the hard way. A card is
 * centred in x but runs from zero to its height in y, so a 2600-long slab
 * placed at y = -900 covers -900 to 1700 and not -2200 to 1400; placed at
 * the origin it covers none of the ground behind the camera, the rays march
 * through sunlight the whole way, and the shadowed patch reads as bright as
 * the lit one. And it has to be long enough to cover the whole march: at 900
 * long the rays ran out from under it two thirds of the way along and came
 * back into the sun.
 */
/** A wide plate to put in the way of the rays, close to the camera. */
const BLOCKER = `material silver satin
part blocker = plate(card(width: 1600, height: 2600, corner: 2), thickness: 8)
form b { place blocker }
`;

const SLAB = `material silver satin
part slab = plate(card(width: 400, height: 2600, corner: 2), thickness: 8)
form s { place slab }
`;

describe('volumetric fog on the game renderer', () => {
  let gpu: Gpu;
  let renderer: GameRenderer;
  let target: GPUTexture;
  const view = () => target.createView();

  beforeAll(async () => {
    gpu = await createDevice();
    renderer = new GameRenderer(gpu, 8, 8, 64);
    await renderer.ready;
    target = gpu.device.createTexture({
      size: [SIZE, SIZE], format: gpu.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const env = bakeEnvironment(gpu, 'studio', { size: 32, mips: 3 });
    await env.samples;
    renderer.setEnvironment(env.specular, env.brdf, env.mips);
    renderer.resize(SIZE, SIZE);

    // Nothing but a slab, floating high and off to one side, with its edge
    // over the origin: everything left of x = 0 and below it is in its
    // shadow, and everything right of it is in the sun.
    const slab: GameGroup = { mesh: meshOf(SLAB), matrices: at(-200, -900, 420), albedo: [0.5, 0.5, 0.5], roughness: 0.8 };
    renderer.setStatic([slab]);
    renderer.setDynamic([]);
    renderer.setLights(new LightPool(8));
    renderer.setSunShadow({ min: [-900, -1000, -50], max: [900, 1800, 600] });
    // straight down, so the slab's shadow is the slab's own footprint
    renderer.look = {
      ...renderer.look, ambient: 0, background: [0, 0, 0],
      sunDir: [0, 0, 1], sunColour: [1, 1, 1],
    };
    // Looking along +y from outside, level, at head height: the frame is
    // mostly empty air with the slab across the top of it.
    renderer.camera.position = [0, -800, 150];
    renderer.camera.target = [0, 0, 150];
    renderer.camera.near = 1;
    renderer.camera.far = 4000;
    renderer.fog = { ...NO_FOG };
  });

  afterAll(() => { renderer?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  async function read(): Promise<{ px: Uint8Array; row: number }> {
    await gpu.queue.onSubmittedWorkDone();
    const row = Math.ceil((SIZE * 4) / 256) * 256;
    const buffer = gpu.device.createBuffer({ size: row * SIZE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = gpu.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: row, rowsPerImage: SIZE }, [SIZE, SIZE, 1]);
    gpu.queue.submit([enc.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(buffer.getMappedRange().slice(0));
    buffer.unmap(); buffer.destroy();
    return { px, row };
  }
  const lum = (f: { px: Uint8Array; row: number }, x: number, y: number) => {
    const o = y * f.row + x * 4;
    return (f.px[o] + f.px[o + 1] + f.px[o + 2]) / 3;
  };
  const patch = (f: { px: Uint8Array; row: number }, x0: number, y0: number, n = 20) => {
    let s = 0;
    for (let y = y0; y < y0 + n; y++) for (let x = x0; x < x0 + n; x++) s += lum(f, x, y);
    return s / (n * n);
  };

  /** Draw with these fog settings and read the frame back. */
  const shot = async (over: Partial<typeof NO_FOG> = {}) => {
    renderer.fog = { ...NO_FOG, ...over };
    renderer.frame(view(), 'redraw', 1 / 60);
    return read();
  };

  // A mist a hundred units deep on the ground, thick enough to see: the
  // camera is at 150 and the ground at 0, so the bottom of the frame looks
  // through it and the top does not.
  const MIST = { density: 0.0016, base: 0, height: 260, ambient: 0, anisotropy: 0.4, reach: 1600, steps: 48 };
  // Where the shadowed and the sunlit air sit in the frame: either side of
  // the middle and below it, so that neither ray meets the slab and both
  // stay on their own side of its edge for the whole march.
  const DARK = [40, 150] as const;
  const LIT = [200, 150] as const;

  it('leaves the frame alone at no density, and with the rung off', async () => {
    const none = await shot({ density: 0 });
    renderer.economy = { ...renderer.economy, fog: false };
    const off = await shot(MIST);
    renderer.economy = { ...renderer.economy, fog: true };
    expect(patch(none, ...DARK)).toBeLessThan(1);
    expect(Math.abs(patch(off, ...LIT) - patch(none, ...LIT))).toBeLessThan(1);
  });

  it('lights the empty air, and more of it the denser it is', async () => {
    const clear = await shot({ density: 0 });
    const thin = await shot({ ...MIST, density: 0.0004 });
    const thick = await shot(MIST);
    expect(patch(clear, ...LIT)).toBeLessThan(1);
    expect(patch(thin, ...LIT)).toBeGreaterThan(patch(clear, ...LIT) + 3);
    expect(patch(thick, ...LIT)).toBeGreaterThan(patch(thin, ...LIT) + 8);
  });

  it('goes dark where the sun cannot reach it: a shaft, not a wash', async () => {
    const f = await shot(MIST);
    const lit = patch(f, ...LIT);
    const dark = patch(f, ...DARK);
    expect(lit).toBeGreaterThan(12);
    expect(dark).toBeLessThan(lit * 0.5);
  });

  it('washes the shadow out again when the sky lights the fog too', async () => {
    // the ambient term is what a real mist has and a shaft in a vacuum does
    // not: it lifts the shadowed air without touching the lit air much
    const shafts = await shot(MIST);
    const washed = await shot({ ...MIST, ambient: 1.2 });
    expect(patch(washed, ...DARK)).toBeGreaterThan(patch(shafts, ...DARK) + 5);
  });

  it('lies at a height: raised past the camera it fogs the top of the frame', async () => {
    // the low layer is thickest at the bottom of the frame, and a layer put
    // up at 700 is thickest at the top — the same fog, lifted
    const low = await shot({ ...MIST, base: 0, height: 120, ambient: 0.8 });
    const high = await shot({ ...MIST, base: 700, height: 120, ambient: 0.8 });
    const bottom = (f: Parameters<typeof patch>[0]) => patch(f, 118, 226, 24);
    const top = (f: Parameters<typeof patch>[0]) => patch(f, 118, 6, 24);
    expect(bottom(low)).toBeGreaterThan(top(low) + 4);
    expect(top(high)).toBeGreaterThan(bottom(high) + 4);
  });

  it('stops at what the scene stopped at, and fogs the short way less', async () => {
    // The fog reads the depth buffer to know where its ray ends. With a
    // plate in the way the march is a fraction of what it was over open sky,
    // and there is correspondingly less air to light. Without this the fog
    // would march its full length through solid matter and nobody would
    // notice until something solid failed to hold the mist off.
    const lit = async (over: Partial<typeof NO_FOG>) => patch(await shot(over), ...LIT);
    const openClear = await lit({ density: 0 });
    const openFog = await lit(MIST);

    const blocker: GameGroup = { mesh: meshOf(BLOCKER), matrices: at(0, -700, 100), albedo: [0.5, 0.5, 0.5], roughness: 0.8 };
    renderer.setDynamic([blocker]);
    const shutClear = await lit({ density: 0 });
    const shutFog = await lit(MIST);
    renderer.setDynamic([]);

    expect(openFog - openClear).toBeGreaterThan(10);
    expect(shutFog - shutClear).toBeLessThan((openFog - openClear) * 0.6);
  });

  it('glows toward the sun and not away from it', async () => {
    // the sun put along the line of sight rather than overhead: forward
    // scattering is then the difference between looking into it and away
    renderer.look = { ...renderer.look, sunDir: [0, 1, 0.15] };
    const toward = await shot({ ...MIST, anisotropy: 0.85 });
    renderer.look = { ...renderer.look, sunDir: [0, -1, 0.15] };
    const away = await shot({ ...MIST, anisotropy: 0.85 });
    renderer.look = { ...renderer.look, sunDir: [0, 0, 1] };
    expect(patch(toward, ...LIT)).toBeGreaterThan(patch(away, ...LIT) * 2);
  });
});
