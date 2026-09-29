/**
 * The toy finish on a real device: what a toon look is drawn with unless it
 * says otherwise. A clean highlight on what is smooth, the sky in a clear
 * coat toward a smooth thing's edge, one smooth ramp of light where the
 * bands stepped, and the occlusion darkening toward the shade's colour; and
 * the soft tone, which a game asks for, bringing a colour lit past one
 * toward white with its hue. Each part is held to moving only what it says,
 * against the same look with that part at nought, and the ramp and the tone
 * are held to their sums in `toon.ts`. A physically based look takes none of
 * it. VITE_FRAME_DIR writes each on and off, to be looked at.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, halfToFloat, readbackLayer, type Gpu } from '../../gpu/context';
import { MeshBuilder, type Mesh } from '../../mesh/types';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, FULL_ECONOMY, GameRenderer, type GameEconomy, type GameGroup, type Look } from '../renderer';
import { LightPool } from '../lights';
import type { GrassField, GrassKind } from '../grass';
import { TOON_SUN, softTone, toonRamp } from '../toon';
import { differing, readPixels, saveFrame, type Pixels } from './frame';

const SIZE = 192;

function ballMesh(): Mesh {
  const b = new MeshBuilder();
  const rings = 48, segments = 64;
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * Math.PI;
    for (let j = 0; j <= segments; j++) {
      const th = (j / segments) * Math.PI * 2;
      const x = Math.sin(phi) * Math.cos(th), y = Math.sin(phi) * Math.sin(th), z = Math.cos(phi);
      b.vertex(x, y, z, x, y, z, j / segments, i / rings);
    }
  }
  const row = segments + 1;
  for (let i = 0; i < rings; i++) for (let j = 0; j < segments; j++) b.quad(i * row + j, (i + 1) * row + j, (i + 1) * row + j + 1, i * row + j + 1);
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

/** A placement: scaled by s, turned by `turn` about z, at (x, y, z). */
const at = (s: number, x: number, y: number, z: number, turn = 0) => {
  const c = Math.cos(turn), n = Math.sin(turn);
  return new Float32Array([c * s, n * s, 0, 0, -n * s, c * s, 0, 0, 0, 0, s, 0, x, y, z, 1]);
};

/** A unit box standing on its base, each face its own four corners, so every edge is hard. */
function boxMesh(): Mesh {
  const b = new MeshBuilder();
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, -1, 0], [0, 0, 1]], [[0, 1, 0], [-1, 0, 0], [0, 0, 1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [n, u, v] of faces) {
    const base = b.vertexCount;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = [0, 1, 2].map((k) => (n[k] + su * u[k] + sv * v[k]) / 2 + (k === 2 ? 0.5 : 0));
      b.vertex(p[0], p[1], p[2], n[0], n[1], n[2], 0, 0);
    }
    b.quad(base, base + 1, base + 2, base + 3);
  }
  return b.build();
}

const BALL = ballMesh();
const GREY: [number, number, number] = [0.6, 0.6, 0.6];
/** A smooth ball, as a toy's plastic is. */
const ball = (roughness = 0.3, albedo = GREY): GameGroup => ({ mesh: BALL, matrices: at(40, 0, 0, 0), albedo, roughness });
/** Matte ground under it, far enough down that the ball's shadow lands clear of it. */
const floor: GameGroup = { mesh: plane(600), matrices: at(1, 0, 0, -70), albedo: GREY, roughness: 0.9 };
/** The same ground with the ball resting on it, for the occlusion where they meet. */
const under: GameGroup = { mesh: plane(600), matrices: at(1, 0, 0, -40), albedo: GREY, roughness: 0.9 };
const SHADE: [number, number, number] = [0.36, 0.38, 0.78];
/** The finish's four parts, each at nought: the bands, the glint and the grey occlusion toon always had. */
const BARE: Partial<Look> = { gloss: 0, sheen: 0, smoothShading: 0, occlusionTint: 0 };

describe('the toy finish on the game renderer', () => {
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
    base = { ...r.look, background: [0, 0, 0], sunDir: [0.4, -0.5, 0.75], sunColour: [2, 2, 2], shading: 'toon' };
    aim();
  });

  afterAll(() => { r?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  function aim() {
    r.camera.fov = 32; r.camera.near = 0.5; r.camera.far = 4000;
    r.camera.position = [0, -160, 60];
    r.camera.target = [0, 0, -10];
  }

  async function draw(look: Partial<Look>, groups: GameGroup[] = [ball()], name = '', tone: 'clamp' | 'soft' = 'clamp'): Promise<Pixels> {
    r.look = { ...base, ...look };
    r.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone };
    r.setDynamic(groups);
    await r.prepare();
    r.frame(target.createView());
    const px = await readPixels(gpu, target);
    if (name) await saveFrame(`toy ${name}`, px);
    return px;
  }

  const lum = (px: Pixels, i: number) => px.rgb[i * 3] + px.rgb[i * 3 + 1] + px.rgb[i * 3 + 2];
  const all = (px: Pixels) => [...Array(px.width * px.height).keys()];
  /** The pixels a frame against black covers. */
  const covered = (px: Pixels) => all(px).filter((i) => lum(px, i) > 12);
  const mean = (px: Pixels, pixels: number[]) => {
    const s = [0, 0, 0];
    for (const i of pixels) for (let k = 0; k < 3; k++) s[k] += px.rgb[i * 3 + k];
    return s.map((v) => v / Math.max(1, pixels.length));
  };
  const changed = (a: Pixels, b: Pixels, pixels: number[]) => pixels.filter((i) => [0, 1, 2].some((k) => a.rgb[i * 3 + k] !== b.rgb[i * 3 + k]));
  /** The ball's outline: its middle and radius on the frame, from the pixels it covers against black. */
  function outline(px: Pixels) {
    const on = covered(px);
    const xs = on.map((i) => i % SIZE), ys = on.map((i) => Math.floor(i / SIZE));
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const radius = (Math.max(...xs) - Math.min(...xs)) / 2;
    return { on, from: (i: number) => Math.hypot((i % SIZE) - cx, Math.floor(i / SIZE) - cy) / radius };
  }

  it('leaves a physically based look as it was, whatever of the finish it asks for', async () => {
    const pbr: Partial<Look> = { shading: 'pbr', occlusion: 2, occlusionRadius: 20, shadeColour: SHADE };
    r.setSunShadow({ min: [-300, -300, -80], max: [300, 300, 60] });
    const plain = await draw({ ...pbr, ...BARE }, [ball(), under]);
    for (const part of [{ gloss: 2 }, { sheen: 2 }, { smoothShading: 1 }, { occlusionTint: 1 }, {}]) {
      expect(differing(plain, await draw({ ...pbr, ...part }, [ball(), under])), JSON.stringify(part)).toBe(0);
    }
    r.setSunShadow(null);
  });

  it('draws a toon look that says nothing of the finish with all of it, and each part is gone where it says nought', async () => {
    const look: Partial<Look> = { occlusion: 3, occlusionRadius: 30, shadeColour: SHADE };
    const toy = await draw(look, [ball(), under], 'on');
    await draw({ ...look, ...BARE }, [ball(), under], 'bare');
    for (const part of ['gloss', 'sheen', 'smoothShading', 'occlusionTint'] as const) {
      expect(differing(toy, await draw({ ...look, [part]: 0 }, [ball(), under])), `${part} at nought`).toBeGreaterThan(20);
    }
  });

  it('puts one clean highlight on a smooth thing, white at its middle, and none on a matte one', async () => {
    // a dark ball, so nothing but the highlight comes near white
    const dark: [number, number, number] = [0.2, 0.2, 0.2];
    const off = await draw({ gloss: 0 }, [ball(0.3, dark)], 'gloss off');
    const on = await draw({}, [ball(0.3, dark)], 'gloss on');
    const { on: onBall, from } = outline(off);
    const lift = (i: number) => lum(on, i) - lum(off, i);
    // the highlight: what it lifts clearly, which is one compact spot on the ball and not at its edge
    const spot = onBall.filter((i) => lift(i) > 60);
    expect(spot.length, 'pixels of the highlight').toBeGreaterThan(40);
    const cx = spot.reduce((a, i) => a + (i % SIZE), 0) / spot.length, cy = spot.reduce((a, i) => a + Math.floor(i / SIZE), 0) / spot.length;
    const radius = (Math.max(...onBall.map((i) => i % SIZE)) - Math.min(...onBall.map((i) => i % SIZE))) / 2;
    const middle = Math.round(cy) * SIZE + Math.round(cx);
    expect(from(middle), 'its middle, on the ball and not at its edge').toBeLessThan(0.8);
    const spread = Math.max(...spot.map((i) => Math.hypot((i % SIZE) - cx, Math.floor(i / SIZE) - cy)));
    expect(spread / radius, 'how far it reaches from its middle, of the ball\'s radius').toBeLessThan(0.45);
    expect(Math.max(...spot.map((i) => Math.min(on.rgb[i * 3], on.rgb[i * 3 + 1], on.rgb[i * 3 + 2]))), 'white at its middle').toBeGreaterThan(235);
    // the glint it replaces was small and dim: the highlight is a highlight
    expect(Math.max(...spot.map(lift))).toBeGreaterThan(150);
    // a matte thing takes none, however glossy the look: gloss at nought would bring the glint back, which is not this
    expect(differing(await draw({}, [ball(0.85)]), await draw({ gloss: 2 }, [ball(0.85)]))).toBe(0);
  });

  it('keeps a highlight the same brightness as a small smooth ball moves across a pixel, rather than sparkling', async () => {
    // a ball some ten pixels across, as a golf ball is at the play view, mirror-smooth, moved an eighth of a pixel at a time
    r.camera.position = [0, -900, 300];
    r.camera.target = [0, 0, 0];
    r.camera.update();
    const pixel = (2 * Math.tan((r.camera.fov * Math.PI) / 360) * Math.hypot(900, 300)) / SIZE;
    const peaks: number[] = [];
    for (let k = 0; k < 8; k++) {
      const small: GameGroup = { mesh: BALL, matrices: at(18, (k / 8) * pixel, 0, 0), albedo: [0.1, 0.1, 0.1], roughness: 0.03 };
      const off = await draw({ gloss: 0, sheen: 0 }, [small]);
      const on = await draw({ sheen: 0 }, [small], k === 0 ? 'small ball' : '');
      peaks.push(Math.max(...all(on).map((i) => lum(on, i) - lum(off, i))));
    }
    aim();
    expect(Math.min(...peaks), 'the highlight is there at every step').toBeGreaterThan(90);
    expect(Math.max(...peaks) / Math.min(...peaks), `the brightest of it, step by step: ${peaks.join(', ')}`).toBeLessThan(1.35);
  });

  it('puts the sky in a smooth thing toward its edge, not where it faces the camera, and in nothing matte', async () => {
    const off = await draw({ sheen: 0 }, [ball(0.2)], 'sheen off');
    const on = await draw({}, [ball(0.2)], 'sheen on');
    const { on: onBall, from } = outline(off);
    const middle = onBall.filter((i) => from(i) < 0.4);
    const edge = onBall.filter((i) => from(i) > 0.85 && from(i) < 0.97);
    const lift = (pixels: number[]) => pixels.reduce((s, i) => s + lum(on, i) - lum(off, i), 0) / pixels.length;
    expect(middle.length).toBeGreaterThan(300);
    expect(lift(middle), 'where it faces the camera').toBeLessThan(2);
    expect(lift(edge), 'toward its edge').toBeGreaterThan(12);
    // and bluer there, as the sky is
    const [R0, , B0] = mean(off, edge), [R1, , B1] = mean(on, edge);
    expect(B1 - B0).toBeGreaterThan(R1 - R0);
    expect(differing(await draw({ sheen: 0 }, [ball(0.85)]), await draw({}, [ball(0.85)])), 'a matte ball').toBe(0);
  });

  it('shades a ball in one smooth ramp where the bands stepped, and leaves flat ground in the sun and in the shadow as it was', async () => {
    // a matte ball, which has no glint for a stair of its own
    const bands: Partial<Look> = { smoothShading: 0, gloss: 0, sheen: 0 };
    const unshadowed = await draw(bands, [ball(1), floor]);
    r.setSunShadow({ min: [-300, -300, -80], max: [300, 300, 60] });
    const steps = await draw(bands, [ball(1), floor], 'ramp off');
    const ramp = await draw({ gloss: 0, sheen: 0 }, [ball(1), floor], 'ramp on');
    r.setSunShadow(null);
    const onBall = outline(await draw({}, [ball()])).on;
    // how long the stair is: pixels on the ball with a neighbour more than ten levels from them
    const inside = new Set(onBall);
    const deep = (i: number) => [-3, 0, 3].every((dy) => [-3, 0, 3].every((dx) => inside.has(i + dy * SIZE + dx)));
    const stair = (px: Pixels) => onBall.filter((i) => deep(i) && Math.max(Math.abs(px.rgb[i * 3] - px.rgb[(i + 1) * 3]), Math.abs(px.rgb[i * 3] - px.rgb[(i + SIZE) * 3])) > 10).length;
    expect(stair(steps), 'the bands\' edges, pixels of them').toBeGreaterThan(80);
    expect(stair(ramp), 'none in the ramp').toBeLessThan(5);
    // The floor where the ball is not. In the full sun, which is where the frame with the ball's shadow is the frame
    // without it, flat ground takes what it always took; deep in the ball's shadow, three pixels in from its edge,
    // where the sun's share is nought, it is the deepest band. Between, in the shadow's soft edge, the bands stepped
    // and the ramp does not, which is the ramp's business.
    const onFloor = all(steps).filter((i) => !inside.has(i));
    const same = (a: Pixels, b: Pixels, i: number) => [0, 1, 2].every((k) => a.rgb[i * 3 + k] === b.rgb[i * 3 + k]);
    // the ramp shades by every share of the sun below flat ground's, so where its frame with the shadow is its frame
    // without, the sun reaches in full; the bands hold the soft edge's outer half at the top band too, and cannot say
    r.setSunShadow(null);
    const rampUnshadowed = await draw({ gloss: 0, sheen: 0 }, [ball(1), floor]);
    const inSun = onFloor.filter((i) => same(steps, unshadowed, i) && same(ramp, rampUnshadowed, i));
    const shade = new Set(onFloor.filter((i) => lum(unshadowed, i) - lum(steps, i) > 45));
    const inShadow = [...shade].filter((i) => [-3, 0, 3].every((dy) => [-3, 0, 3].every((dx) => shade.has(i + dy * SIZE + dx))));
    expect(inSun.length, 'flat ground in the sun').toBeGreaterThan(5000);
    expect(inShadow.length, 'flat ground deep in the ball\'s shadow').toBeGreaterThan(300);
    expect(changed(steps, ramp, inSun)).toEqual([]);
    expect(changed(steps, ramp, inShadow)).toEqual([]);
  });

  it('lights a surface by the ramp in toon.ts, at every angle to the sun and with the form light', async () => {
    // a row of tiles facing the camera, each turned further toward the sun, lit by it alone
    const sunDir: [number, number, number] = [1, -1, 0.5];
    const l = sunDir.map((c) => c / Math.hypot(...sunDir));
    const flat = Math.max(l[2], 0.1);
    const TILE = plane(1);
    const turns = [-40, -30, -20, -10, 0, 10, 20, 30, 40].map((d) => (d * Math.PI) / 180);
    const tiles: GameGroup[] = turns.map((t, k) => {
      // stood up and turned t about z from facing -y: its across is (cos t, sin t, 0), its up is z, and its face,
      // the third column, (sin t, -cos t, 0)
      const c = Math.cos(t), s = Math.sin(t);
      const m = new Float32Array([c * 16, s * 16, 0, 0, 0, 0, 16, 0, s * 16, -c * 16, 0, 0, (k - 4) * 20, 0, 0, 1]);
      return { mesh: TILE, matrices: m, albedo: [0.5, 0.5, 0.5], roughness: 0.9 };
    });
    r.camera.position = [0, -360, 0];
    r.camera.target = [0, 0, 0];
    r.camera.update();
    const project = (p: number[]) => {
      const m = r.camera.viewProjection;
      const o = [0, 1, 3].map((row) => m[row] * p[0] + m[4 + row] * p[1] + m[8 + row] * p[2] + m[12 + row]);
      return Math.round((0.5 - (o[1] / o[2]) * 0.5) * SIZE - 0.5) * SIZE + Math.round(((o[0] / o[2]) * 0.5 + 0.5) * SIZE - 0.5);
    };
    for (const form of [0, 2.5]) {
      const px = await draw({ sunDir, ambient: 0, gloss: 0, sheen: 0, form }, tiles, `ramp tiles form ${form}`);
      turns.forEach((t, k) => {
        const n = [Math.sin(t), -Math.cos(t), 0];
        const x = Math.max(0, n[0] * l[0] + n[1] * l[1] + n[2] * l[2]);
        const want = Math.round(255 * Math.min(1, 0.5 * toonRamp(x, flat, form) * 2 * TOON_SUN) ** (1 / 2.2));
        const i = project([(k - 4) * 20, 0, 0]);
        expect(Math.abs(px.rgb[i * 3] - want), `tile ${k}, ${x.toFixed(3)} of the sun, form ${form}: ${px.rgb[i * 3]} against ${want}`).toBeLessThanOrEqual(1);
      });
    }
    aim();
  });

  it('darkens where the occlusion is toward the shade\'s colour, only there, and only when there is a shade colour', async () => {
    // a block standing on the ground, which makes a crease the whole way round its foot
    const block: GameGroup = { mesh: boxMesh(), matrices: at(30, 0, 10, -40, 0.4), albedo: GREY, roughness: 0.9 };
    const shut: Partial<Look> = { occlusion: 3, occlusionRadius: 30, occlusionDirect: 0.5 };
    const grey = await draw({ ...shut, shadeColour: SHADE, occlusionTint: 0 }, [block, under], 'occlusion grey');
    const tinted = await draw({ ...shut, shadeColour: SHADE }, [block, under], 'occlusion tinted');
    const open = await draw({ ...shut, occlusion: 0, shadeColour: SHADE }, [block, under]);
    // deep in the crease: darker with the occlusion than without by a fifth of the light or more
    const occluded = all(open).filter((i) => lum(open, i) - lum(grey, i) > 0.2 * lum(open, i));
    expect(occluded.length, 'pixels deep in the occlusion').toBeGreaterThan(100);
    const blueness = (px: Pixels, pixels: number[]) => { const [R, , B] = mean(px, pixels); return B - R; };
    expect(blueness(tinted, occluded) - blueness(grey, occluded), 'bluer, as the shade is').toBeGreaterThan(8);
    // and no darker than the grey, since it is the colour of the dark that moves and not how dark it is
    expect(mean(tinted, occluded).reduce((a, b) => a + b), 'as bright').toBeGreaterThan(mean(grey, occluded).reduce((a, b) => a + b) * 0.9);
    // and far from the block, where nothing shuts out the sky, exactly as it was: the ground in the frame's lower corners
    const corners = all(open).filter((i) => Math.floor(i / SIZE) > SIZE - 20 && (i % SIZE < 20 || i % SIZE >= SIZE - 20));
    expect(changed(open, grey, corners), 'the corners are clear of the occlusion').toEqual([]);
    expect(changed(grey, tinted, corners)).toEqual([]);
    // with no shade colour there is nothing to tint toward
    expect(differing(await draw({ ...shut, occlusionTint: 0 }, [block, under]), await draw(shut, [block, under]))).toBe(0);
    // and it tints the sky's light as well as the sun's: with no sun at all, the crease still goes bluer
    const dark: Partial<Look> = { ...shut, sunColour: [0, 0, 0], shadeColour: SHADE };
    const skyGrey = await draw({ ...dark, occlusionTint: 0 }, [block, under]);
    const skyTinted = await draw(dark, [block, under]);
    expect(blueness(skyTinted, occluded) - blueness(skyGrey, occluded), 'the sky\'s light, bluer').toBeGreaterThan(4);
  });

  it('puts no highlight on what is in another thing\'s shadow', async () => {
    // a plate held over the ball toward the sun, so the ball is in its shadow and the camera still sees it
    const plate: GameGroup = { mesh: plane(200), matrices: at(1, 60, -75, 112), albedo: GREY, roughness: 0.9 };
    r.setSunShadow({ min: [-300, -300, -80], max: [300, 300, 200] });
    // at the gloss and at twice it, not at nought, which would bring the glint back
    const once = await draw({}, [ball(0.2), plate], 'gloss in shadow');
    const twice = await draw({ gloss: 2 }, [ball(0.2), plate]);
    const lit = await draw({}, [ball(0.2)]);
    const litTwice = await draw({ gloss: 2 }, [ball(0.2)]);
    r.setSunShadow(null);
    expect(differing(lit, litTwice), 'in the sun, twice the gloss shows').toBeGreaterThan(100);
    expect(differing(once, twice), 'in the plate\'s shadow, none').toBe(0);
  });

  it('shuts the sheen out where the occlusion is, as it shuts out the sky\'s light', async () => {
    // a smooth block on smooth ground, so both take the sheen; and no sun, so the occlusion governs all the light
    // there is and the crease between them is deep
    const block: GameGroup = { mesh: boxMesh(), matrices: at(30, 0, 10, -40, 0.4), albedo: GREY, roughness: 0.2 };
    const ground: GameGroup = { ...under, roughness: 0.3 };
    const shut: Partial<Look> = { occlusion: 3, occlusionRadius: 30, sunColour: [0, 0, 0] };
    const open = await draw({ ...shut, occlusion: 0, sheen: 0 }, [block, ground]);
    const occludedOnly = await draw({ ...shut, sheen: 0 }, [block, ground], 'crease');
    const crease = all(open).filter((i) => lum(open, i) - lum(occludedOnly, i) > 0.2 * lum(open, i));
    expect(crease.length, 'pixels deep in the crease').toBeGreaterThan(100);
    // in linear light, which is what the occlusion scales: on the screen's curve a little light added to something
    // dark shows as more than the same added to something bright
    const linear = (px: Pixels, i: number) => [0, 1, 2].reduce((s, k) => s + (px.rgb[i * 3 + k] / 255) ** 2.2, 0);
    const lift = async (look: Partial<Look>) => {
      const without = await draw({ ...look, sheen: 0 }, [block, ground]);
      const with_ = await draw(look, [block, ground]);
      return crease.reduce((s, i) => s + linear(with_, i) - linear(without, i), 0) / crease.length;
    };
    const inTheOpen = await lift({ ...shut, occlusion: 0 });
    const inTheCrease = await lift(shut);
    expect(inTheOpen, 'the sheen there with nothing shutting it out').toBeGreaterThan(0.01);
    // every pixel of the crease is a fifth darker for the occlusion or more, and so is its sheen
    expect(inTheCrease, 'and with the occlusion').toBeLessThan(inTheOpen * 0.85);
  });

  it('shows a colour lit past one by the soft tone in toon.ts, keeping its hue where the clamp holds it flat', async () => {
    // flat ground lit by the sun alone takes exactly its colour times the sun, so what the tone is handed is known
    // an orange, which keeps its hue, and a cream, which is white light enough to go to white when it is lit far past one
    const sunDir: [number, number, number] = [0, 0, 1];
    for (const colour of [[0.9, 0.45, 0.08], [0.9, 0.85, 0.75]] as [number, number, number][]) {
      const ground: GameGroup = { mesh: plane(600), matrices: at(1, 0, 0, -40), albedo: colour, roughness: 0.9 };
      for (const sun of [1, 2.5, 4, 8, 30]) {
        const px = await draw({ sunDir, sunColour: [sun, sun, sun], ambient: 0 }, [ground], '', 'soft');
        const i = (SIZE / 2) * SIZE + SIZE / 2;
        const want = softTone(colour.map((c) => c * sun * TOON_SUN) as [number, number, number]).map((c) => Math.round(255 * c ** (1 / 2.2)));
        for (let k = 0; k < 3; k++) expect(Math.abs(px.rgb[i * 3 + k] - want[k]), `${colour} in a sun of ${sun}, channel ${k}: ${px.rgb[i * 3 + k]} against ${want[k]}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('holds the highlight under a blinding sun inside what a half float has, with nothing that is not a number', async () => {
    const white: GameGroup = { mesh: BALL, matrices: at(40, 0, 0, 0), albedo: [1, 1, 1], roughness: 0.03 };
    await draw({ sunColour: [4e4, 4e4, 4e4], gloss: 2, sheen: 2 }, [white]);
    const half = new Uint16Array(await readbackLayer(gpu.device, r.hdr.colour!, 0, 0, SIZE, 8));
    let most = 0, bad = 0;
    for (let i = 0; i < half.length; i++) {
      if ((i & 3) === 3) continue;
      const v = halfToFloat(half[i]);
      if (!Number.isFinite(v)) bad++;
      else most = Math.max(most, v);
    }
    expect(bad).toBe(0);
    expect(most).toBeLessThanOrEqual(60000);
    expect(most, 'and the sun did reach it').toBeGreaterThan(1000);
  });

  it('draws at a pixel and at an odd size, and the ball has no hole in it', async () => {
    r.look = { ...base };
    r.setDynamic([ball()]);
    const tiny = gpu.device.createTexture({ size: [1, 1], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    r.resize(1, 1);
    expect(r.frame(tiny.createView())).toBe(true);
    const odd = gpu.device.createTexture({ size: [333, 217], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    r.resize(333, 217);
    r.frame(odd.createView());
    const px = await readPixels(gpu, odd);
    tiny.destroy();
    odd.destroy();
    r.resize(SIZE, SIZE);
    // the ball fills the middle of the frame: a black pixel there is a colour that was not a number
    let black = 0, n = 0;
    for (let y = 90; y < 130; y++)
      for (let x = 150; x < 185; x++) {
        const i = (y * 333 + x) * 3;
        n++;
        if (px.rgb[i] + px.rgb[i + 1] + px.rgb[i + 2] === 0) black++;
      }
    expect(n).toBeGreaterThan(1000);
    expect(black).toBe(0);
  });

  it('draws the same picture in millimetres and in tenths of a metre', async () => {
    const mm = await draw({}, [ball(), floor]);
    const own = new GameRenderer(gpu, 8, 8, 64, 100);
    await own.ready;
    const env = bakeEnvironment(gpu, 'daylight', { size: 32, mips: 3 });
    await env.samples;
    own.setEnvironment(env.specular, env.brdf, env.mips);
    own.resize(SIZE, SIZE);
    own.setStatic([]);
    own.setLights(new LightPool(8));
    own.economy = { ...FULL_ECONOMY, shadows: true };
    own.look = { ...own.look, background: [0, 0, 0], sunDir: [0.4, -0.5, 0.75], sunColour: [2, 2, 2], shading: 'toon' };
    own.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
    own.camera.fov = 32; own.camera.near = 0.005; own.camera.far = 40;
    own.camera.position = [0, -1.6, 0.6];
    own.camera.target = [0, 0, -0.1];
    own.setDynamic([{ ...ball(), matrices: at(0.4, 0, 0, 0) }, { ...floor, matrices: at(0.01, 0, 0, -0.7) }]);
    own.frame(target.createView());
    const metres = await readPixels(gpu, target);
    own.dispose();
    env.dispose();
    let far = 0;
    for (let i = 0; i < mm.rgb.length; i++) if (Math.abs(mm.rgb[i] - metres.rgb[i]) > 2) far++;
    expect(far, 'channels more than two levels apart').toBeLessThan(mm.rgb.length / 500);
  });

  it('keeps a kept frame as a redrawn one, and gives the same frame after each rung is stepped down and back', async () => {
    r.look = { ...base, occlusion: 2, occlusionRadius: 20, shadeColour: SHADE };
    r.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'soft' };
    r.setStatic([ball(), under]);
    r.setDynamic([]);
    r.frame(target.createView(), 'redraw');
    const redrawn = await readPixels(gpu, target);
    r.frame(target.createView(), 'keep');
    r.frame(target.createView(), 'keep');
    expect(differing(redrawn, await readPixels(gpu, target)), 'kept').toBe(0);
    const rungs: Partial<GameEconomy>[] = [{ shadows: false }, { points: false }, { post: false }, { occlusion: false }, { fog: false }, { particles: false }, { antialias: 'none' }];
    for (const rung of rungs) {
      r.economy = { ...FULL_ECONOMY, shadows: true, ...rung };
      r.frame(target.createView());
      r.economy = { ...FULL_ECONOMY, shadows: true };
      r.frame(target.createView());
      expect(differing(redrawn, await readPixels(gpu, target)), JSON.stringify(rung)).toBe(0);
    }
    r.setStatic([]);
  });

  it('leaves the grass unglossed, since a blade is matte', async () => {
    const kind: GrassKind = { density: 1.5, height: 16, width: 2, base: [0.2, 0.5, 0.15], tip: [0.4, 0.8, 0.3], lean: 0.2, give: 0.2 };
    const cols = 16, rows = 16;
    const field: GrassField = { origin: [-80, -80], cell: 10, cols, rows, mask: new Uint8Array(cols * rows).fill(1), heights: new Float32Array(cols * rows).fill(-70), kinds: [kind], seed: 2 };
    await r.setGrass(field);
    // at twice the gloss and the sheen, not at nought, which would bring the glint back
    const on = await draw({}, [floor], 'grass');
    const more = await draw({ gloss: 2, sheen: 2 }, [floor]);
    await r.setGrass(null);
    const bare = await draw({}, [floor]);
    const blades = all(on).filter((i) => lum(on, i) !== lum(bare, i));
    expect(blades.length, 'the blades are drawn').toBeGreaterThan(2000);
    // The grass itself moves a pixel or so from one frame to the next with nothing changed, where two blades meet at
    // the same depth (it did in v0.21.0 too, and is not the finish's): so a few pixels, and the blades alike on the whole.
    expect(differing(on, more)).toBeLessThanOrEqual(3);
    const total = (px: Pixels) => blades.reduce((s, i) => s + lum(px, i), 0) / blades.length;
    expect(Math.abs(total(on) - total(more))).toBeLessThan(0.2);
  });

  it('draws grass matte whatever its roughness, with no highlight, no sheen and no tint in a crease', async () => {
    // Blades are drawn by the million, and the three cost ooergolf's rough a quarter of a millisecond compiled into
    // them and scarcely seen: so they are not built in. A smooth blade, which the finish would have glossed.
    const kind: GrassKind = { density: 1.5, height: 16, width: 2, base: [0.2, 0.5, 0.15], tip: [0.4, 0.8, 0.3], lean: 0.2, give: 0.2, roughness: 0.2 };
    const cols = 16, rows = 16;
    const field: GrassField = { origin: [-80, -80], cell: 10, cols, rows, mask: new Uint8Array(cols * rows).fill(1), heights: new Float32Array(cols * rows).fill(-70), kinds: [kind], seed: 2 };
    // a block standing in the grass, so the blades round its foot are in a crease
    const block: GameGroup = { mesh: boxMesh(), matrices: at(30, 0, 10, -60, 0.4), albedo: GREY, roughness: 0.9 };
    const shut: Partial<Look> = { occlusion: 3, occlusionRadius: 30, occlusionDirect: 0.5, shadeColour: SHADE };
    await r.setGrass(field);
    // the least gloss there is, which still takes the glint away as any gloss does, against the most
    const least = await draw({ ...shut, gloss: 1e-6, sheen: 0, occlusionTint: 0 }, [floor, block], 'grass matte');
    const most = await draw({ ...shut, gloss: 2, sheen: 2, occlusionTint: 1 }, [floor, block], 'grass finished');
    await r.setGrass(null);
    const bare = await draw({ ...shut, gloss: 1e-6, sheen: 0, occlusionTint: 0 }, [floor, block]);
    const blades = all(least).filter((i) => lum(least, i) !== lum(bare, i));
    expect(blades.length, 'the blades are drawn').toBeGreaterThan(2000);
    // a pixel or so where two blades meet at the same depth, as above
    expect(changed(least, most, blades).length).toBeLessThanOrEqual(3);
  });
});
