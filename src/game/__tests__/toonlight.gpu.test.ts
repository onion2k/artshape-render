/**
 * The toon look's own light, on a real device: the bands' edges eased, the
 * shade tinted, a rim, and a sky and a ground light. Each asked for as
 * nothing draws as a look that never mentions it, a physically based look
 * ignores all four, and each moves only what it says: the soft edge only
 * near where the bands meet, the tint only the shade and the sun's shadow
 * and not what is in the sun, the rim only toward the edge of a thing and
 * not where it faces the camera, and the sky and ground light the top of a
 * ball toward the one and its underside toward the other. The grass is lit
 * by the same fragment stage, and takes them too. VITE_FRAME_DIR writes
 * each off and on, to be looked at.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { MeshBuilder, type Mesh } from '../../mesh/types';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, FULL_ECONOMY, GameRenderer, type GameGroup, type Look } from '../renderer';
import { LightPool } from '../lights';
import type { GrassField, GrassKind } from '../grass';
import { differing, readPixels, saveFrame, type Pixels } from './frame';

const SIZE = 192;

function ballMesh(): Mesh {
  const b = new MeshBuilder();
  const rings = 32, segments = 48;
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * Math.PI;
    for (let j = 0; j <= segments; j++) {
      const th = (j / segments) * Math.PI * 2;
      const x = Math.sin(phi) * Math.cos(th), y = Math.sin(phi) * Math.sin(th), z = Math.cos(phi);
      b.vertex(x, y, z, x, y, z, j / segments, i / rings);
    }
  }
  const row = segments + 1;
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < segments; j++) b.quad(i * row + j, (i + 1) * row + j, (i + 1) * row + j + 1, i * row + j + 1);
  return b.build();
}

function plane(size: number): Mesh {
  const b = new MeshBuilder();
  const s = size / 2;
  b.vertex(-s, -s, 0, 0, 0, 1, 0, 0);
  b.vertex(s, -s, 0, 0, 0, 1, 1, 0);
  b.vertex(s, s, 0, 0, 0, 1, 1, 1);
  b.vertex(-s, s, 0, 0, 0, 1, 0, 1);
  b.quad(0, 1, 2, 3);
  return b.build();
}

/** Mid grey, lit so that nothing is held at white, where a change would not show. */
const GREY: [number, number, number] = [0.6, 0.6, 0.6];
const ball: GameGroup = { mesh: ballMesh(), matrices: new Float32Array([40, 0, 0, 0, 0, 40, 0, 0, 0, 0, 40, 0, 0, 0, 0, 1]), albedo: GREY, roughness: 0.6 };
/** A ball over a floor, high enough that its shadow lands on the floor clear of it. */
const floor: GameGroup = { mesh: plane(600), matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -70, 1]), albedo: GREY, roughness: 0.9 };
/** A blue-violet shade, as a sunny day's. */
const SHADE: [number, number, number] = [0.35, 0.4, 0.9];

const BLADES: GrassKind = { density: 1.5, height: 16, width: 2, base: [0.2, 0.5, 0.15], tip: [0.4, 0.8, 0.3], lean: 0.2, give: 0.2 };
function field(): GrassField {
  const cols = 16, rows = 16;
  return { origin: [-80, -80], cell: 10, cols, rows, mask: new Uint8Array(cols * rows).fill(1), heights: new Float32Array(cols * rows).fill(-70), kinds: [BLADES], seed: 2 };
}

describe('the toon look\'s own light on the game renderer', () => {
  let gpu: Gpu;
  let r: GameRenderer;
  let target: GPUTexture;
  let base: Look;

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
    r.camera.position = [0, -160, 60];
    r.camera.target = [0, 0, -10];
    // on the bands, with the toy finish off: the toon light was made for them, and each part of it is held here by
    // what it does to them; toy.gpu.test.ts holds the finish
    base = { ...r.look, background: [0, 0, 0], sunDir: [0.4, -0.5, 0.75], sunColour: [2, 2, 2], shading: 'toon', gloss: 0, sheen: 0, smoothShading: 0, occlusionTint: 0 };
    r.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
  });

  afterAll(() => { r?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  async function draw(look: Partial<Look>, groups: GameGroup[] = [ball], name = ''): Promise<Pixels> {
    r.look = { ...base, ...look };
    r.setDynamic(groups);
    r.frame(target.createView());
    const px = await readPixels(gpu, target);
    if (name) await saveFrame(`toon light ${name}`, px);
    return px;
  }

  const at = (px: Pixels, i: number) => [px.rgb[i * 3], px.rgb[i * 3 + 1], px.rgb[i * 3 + 2]];
  const lum = (px: Pixels, i: number) => px.rgb[i * 3] + px.rgb[i * 3 + 1] + px.rgb[i * 3 + 2];
  /** The pixels a frame against black covers. */
  const covered = (px: Pixels) => [...Array(px.width * px.height).keys()].filter((i) => lum(px, i) > 12);
  const mean = (px: Pixels, pixels: number[]) => {
    const s = [0, 0, 0];
    for (const i of pixels) for (let k = 0; k < 3; k++) s[k] += px.rgb[i * 3 + k];
    return s.map((v) => v / Math.max(1, pixels.length));
  };
  const unchanged = (a: Pixels, b: Pixels, pixels: number[]) => pixels.filter((i) => at(a, i).some((c, k) => c !== at(b, i)[k])).length;

  it('draws each asked for as nothing as a look that never mentions it', async () => {
    const nothing = await draw({});
    const said = await draw({ bandSoftness: 0, rim: 0, rimColour: [1, 0, 0], rimWidth: 0.8, shadeColour: undefined, skyLight: undefined, groundLight: undefined, form: 0 });
    expect(differing(nothing, said)).toBe(0);
    expect(covered(nothing).length).toBeGreaterThan(3000);
  });

  it('leaves a physically based look as it was, whatever of the toon light it asks for', async () => {
    const pbr: Partial<Look> = { shading: 'pbr' };
    const plain = await draw(pbr, [ball, floor]);
    r.setSunShadow({ min: [-300, -300, -80], max: [300, 300, 60] });
    const all = { ...pbr, bandSoftness: 0.1, shadeColour: SHADE, rim: 1, skyLight: [0, 0, 1] as [number, number, number], groundLight: [1, 0, 0] as [number, number, number], form: 2 };
    const shadowed = await draw(pbr, [ball, floor]);
    expect(differing(shadowed, await draw(all, [ball, floor]))).toBe(0);
    r.setSunShadow(null);
    expect(differing(plain, await draw(all, [ball, floor]))).toBe(0);
  });

  it('eases the bands into each other near where they meet, and nowhere else', async () => {
    const hard = await draw({}, [ball], 'bands hard');
    const soft = await draw({ bandSoftness: 0.1 }, [ball], 'bands soft');
    // How long the stair is: pixels on the ball, three in from its outline,
    // with a neighbour more than ten levels from them, which is a band's edge
    // drawn as a step. Where the edge meets the outline the surface turns
    // away and any ramp is squeezed into a pixel, which is the outline's
    // business and not the band's.
    const onBall = new Set(covered(hard));
    const deep = (i: number) => [-3, 0, 3].every((dy) => [-3, 0, 3].every((dx) => onBall.has(i + dy * SIZE + dx)));
    const stair = (px: Pixels) => [...onBall].filter((i) => deep(i)
      && Math.max(Math.abs(px.rgb[i * 3] - px.rgb[(i + 1) * 3]), Math.abs(px.rgb[i * 3] - px.rgb[(i + SIZE) * 3])) > 10).length;
    expect(stair(hard), 'a hard band\'s edge, pixels of it').toBeGreaterThan(80);
    expect(stair(soft), 'eased').toBeLessThan(stair(hard) / 10);
    // and more than six pixels from a hard band's edge, on the ball or off it, nothing moves: 0.1 of the sun's
    // share is a few pixels of this ball
    const edge = new Uint8Array(SIZE * SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) {
      const x = i % SIZE, y = Math.floor(i / SIZE);
      if (x + 1 >= SIZE || y + 1 >= SIZE) continue;
      if (Math.max(Math.abs(hard.rgb[i * 3] - hard.rgb[(i + 1) * 3]), Math.abs(hard.rgb[i * 3] - hard.rgb[(i + SIZE) * 3])) > 10) edge[i] = 1;
    }
    const far = [...Array(SIZE * SIZE).keys()].filter((i) => {
      const x = i % SIZE, y = Math.floor(i / SIZE);
      for (let dy = -6; dy <= 6; dy++)
        for (let dx = -6; dx <= 6; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < SIZE && yy < SIZE && edge[yy * SIZE + xx]) return false;
        }
      return true;
    });
    expect(far.filter((i) => onBall.has(i)).length, 'pixels on the ball far from a band\'s edge').toBeGreaterThan(2000);
    expect(unchanged(hard, soft, far)).toBe(0);
  });

  it('tints the shade and the sun\'s shadow toward the shade colour, and leaves what is in the sun as it was', async () => {
    r.setSunShadow({ min: [-300, -300, -80], max: [300, 300, 60] });
    const grey = await draw({}, [ball, floor], 'shade grey');
    const tinted = await draw({ shadeColour: SHADE }, [ball, floor], 'shade tinted');
    r.setSunShadow(null);
    const unshadowed = await draw({}, [ball, floor]);
    // the sun's shadow on the floor: darker with the map than without
    const shadow = [...Array(SIZE * SIZE).keys()].filter((i) => lum(unshadowed, i) - lum(grey, i) > 45);
    expect(shadow.length, 'pixels of the ball\'s shadow on the floor').toBeGreaterThan(300);
    const blueness = (px: Pixels, pixels: number[]) => { const [R, , B] = mean(px, pixels); return B - R; };
    expect(blueness(grey, shadow), 'a grey shadow').toBeLessThan(10);
    expect(blueness(tinted, shadow), 'a blue-violet one').toBeGreaterThan(30);
    // what the sun reaches in full is the colour it always was: the floor in the sun, the commonest colour of all
    const count = new Map<number, number>();
    const key = (px: Pixels, i: number) => (px.rgb[i * 3] << 16) | (px.rgb[i * 3 + 1] << 8) | px.rgb[i * 3 + 2];
    for (let i = 0; i < SIZE * SIZE; i++) count.set(key(grey, i), (count.get(key(grey, i)) ?? 0) + 1);
    const commonest = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const sunny = [...Array(SIZE * SIZE).keys()].filter((i) => key(grey, i) === commonest);
    expect(sunny.length, 'pixels in the full sun').toBeGreaterThan(5000);
    expect(unchanged(grey, tinted, sunny)).toBe(0);
  });

  it('puts a rim toward the edge of a thing, and leaves where it faces the camera as it was', async () => {
    const plain = await draw({}, [ball], 'rim off');
    const rimmed = await draw({ rim: 0.8, rimColour: [1, 0.9, 0.7], rimWidth: 0.4 }, [ball], 'rim on');
    const on = covered(plain);
    const xs = on.map((i) => i % SIZE), ys = on.map((i) => Math.floor(i / SIZE));
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const radius = (Math.max(...xs) - Math.min(...xs)) / 2;
    const from = (i: number) => Math.hypot((i % SIZE) - cx, Math.floor(i / SIZE) - cy) / radius;
    const middle = on.filter((i) => from(i) < 0.5);
    const edge = on.filter((i) => from(i) > 0.92 && from(i) < 0.99);
    expect(middle.length).toBeGreaterThan(500);
    expect(unchanged(plain, rimmed, middle), 'where the ball faces the camera').toBe(0);
    const brighter = (i: number) => lum(rimmed, i) - lum(plain, i);
    expect(edge.reduce((s, i) => s + brighter(i), 0) / edge.length, 'toward the edge, brighter by').toBeGreaterThan(60);
  });

  it('lights the top of a ball by the sky and its underside by the ground', async () => {
    const dark: Partial<Look> = { sunColour: [0, 0, 0] };
    const plain = await draw(dark, [ball], 'sky and ground off');
    const lit = await draw({ ...dark, skyLight: [0.2, 0.35, 0.9], groundLight: [0.9, 0.5, 0.15] }, [ball], 'sky and ground on');
    const on = covered(lit);
    const ys = on.map((i) => Math.floor(i / SIZE));
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    const top = on.filter((i) => Math.floor(i / SIZE) < y0 + (y1 - y0) * 0.15);
    const bottom = on.filter((i) => Math.floor(i / SIZE) > y1 - (y1 - y0) * 0.15);
    const tilt = (px: Pixels, pixels: number[]) => { const [R, , B] = mean(px, pixels); return B - R; };
    expect(tilt(lit, top), 'the top, toward the sky').toBeGreaterThan(40);
    expect(tilt(lit, bottom), 'the underside, toward the ground').toBeLessThan(-40);
    // where the environment's grey was nearly even either way
    expect(Math.abs(tilt(plain, top) - tilt(plain, bottom))).toBeLessThan(40);
  });

  it('shades the top band by the sun a surface takes against flat ground, and leaves flat ground and the lower bands as they were', async () => {
    // lit by the sun alone, so each band is one colour and can be told by it
    const sunOnly: Partial<Look> = { ambient: 0 };
    const plain = await draw(sunOnly, [ball, floor], 'form off');
    const formed = await draw({ ...sunOnly, form: 1.5 }, [ball, floor], 'form on');
    // the ball's two brightest levels as a plain toon look draws it: the top band, and the one below it
    const onBall = covered(await draw(sunOnly, [ball]));
    const count = new Map<number, number>();
    for (const i of onBall) count.set(lum(plain, i), (count.get(lum(plain, i)) ?? 0) + 1);
    const levels = [...count.entries()].filter(([, n]) => n > 150).map(([l]) => l).sort((a, b) => b - a);
    const [top, mid] = levels;
    const inTop = onBall.filter((i) => lum(plain, i) === top),
      inMid = onBall.filter((i) => lum(plain, i) === mid);
    expect(inTop.length, 'pixels of the top band').toBeGreaterThan(500);
    expect(inMid.length, 'and of the one below').toBeGreaterThan(300);
    // turned from the sun more than flat ground is, darker; facing it more, brighter; the lower band as it was
    expect(inTop.filter((i) => lum(formed, i) < top - 6).length, 'darker, turned from the sun').toBeGreaterThan(300);
    expect(inTop.filter((i) => lum(formed, i) > top + 6).length, 'brighter, facing it').toBeGreaterThan(100);
    expect(unchanged(plain, formed, inMid), 'the band below').toBe(0);
    // and never darker than the band below, so the top band meets it without a step down
    expect(Math.min(...inTop.map((i) => lum(formed, i)))).toBeGreaterThanOrEqual(mid - 3);
    // flat ground in the sun takes what flat ground takes, so it is as it was: the floor's commonest colour
    const floorCount = new Map<number, number>();
    const key = (px: Pixels, i: number) => (px.rgb[i * 3] << 16) | (px.rgb[i * 3 + 1] << 8) | px.rgb[i * 3 + 2];
    const onFloor = [...Array(SIZE * SIZE).keys()].filter((i) => !onBall.includes(i));
    for (const i of onFloor) floorCount.set(key(plain, i), (floorCount.get(key(plain, i)) ?? 0) + 1);
    const commonest = [...floorCount.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const sunnyFloor = onFloor.filter((i) => key(plain, i) === commonest);
    expect(sunnyFloor.length, 'pixels of flat ground in the sun').toBeGreaterThan(5000);
    expect(unchanged(plain, formed, sunnyFloor)).toBe(0);
  });

  it('lights the grass by the same light, since it is shaded by the same fragment stage', async () => {
    const look: Partial<Look> = { sunColour: [1.5, 1.5, 1.5] };
    await r.setGrass(field());
    const grass = await draw(look, [floor], 'grass plain');
    const shaded = await draw({ ...look, skyLight: [1.2, 0.2, 0.2], shadeColour: SHADE, rim: 0.5, bandSoftness: 0.1 }, [floor], 'grass lit');
    await r.setGrass(null);
    const bare = await draw(look, [floor]);
    const blades = [...Array(SIZE * SIZE).keys()].filter((i) => lum(grass, i) !== lum(bare, i));
    expect(blades.length, 'pixels of blades').toBeGreaterThan(2000);
    const redness = (px: Pixels) => { const [R, G] = mean(px, blades); return R - G; };
    expect(redness(shaded) - redness(grass), 'the blades take the red sky').toBeGreaterThan(30);
  });
});
