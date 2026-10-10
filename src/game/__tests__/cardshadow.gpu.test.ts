/**
 * Cut-out cards on a real device, the depth passes: a square wearing a disc mask casts the shadow of its disc, from
 * the sun and from a spot, and darkens the contact occlusion of what is beside it as a disc does, and not as the
 * square it is cut from. Without this a leaf's shadow is a tile, and the ground round every leaf is dark in a square.
 *
 * Every card here is a horizontal square held above flat ground, seen from almost straight above, so that a point of
 * the shadow is a point on the screen. The sun's shadow of a flat card is the card moved along the light, and a
 * spot's is the card scaled from the lamp, so where the middle and the corner of the shadow fall is worked out here
 * from the light, not read off the picture. The shaded and the lit value are measured in the same scene, from the
 * same square drawn uncut, so that the card is held to the ground's own two values and not to a number written here.
 * VITE_FRAME_DIR writes the frames.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { MeshBuilder, type Mesh } from '../../mesh/types';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, FULL_ECONOMY, GameRenderer, type FrameMode, type GameGroup } from '../renderer';
import { LightPool } from '../lights';
import { meanIn, readPixels, saveFrame, type Pixels } from './frame';

const W = 192, H = 192;
const SIDE = 8;
const GREEN: [number, number, number] = [0.3, 0.5, 0.2];
const GROUND: [number, number, number] = [0.7, 0.7, 0.7];
/** How far out along a diagonal the shadow's corner is read: outside the disc by two, inside the square. */
const CORNER = SIDE / 2 - 0.8;

function card(): Mesh {
  const b = new MeshBuilder();
  const s = SIDE / 2;
  b.vertex(-s, -s, 0, 0, 0, 1, 0, 0);
  b.vertex(s, -s, 0, 0, 0, 1, 1, 0);
  b.vertex(s, s, 0, 0, 0, 1, 1, 1);
  b.vertex(-s, s, 0, 0, 0, 1, 0, 1);
  b.quad(0, 1, 2, 3);
  return b.build();
}

/** A flat floor a hundred across, facing up, at nought. */
function floor(): Mesh {
  const b = new MeshBuilder();
  b.vertex(-50, -50, 0, 0, 0, 1, 0, 0);
  b.vertex(50, -50, 0, 0, 0, 1, 1, 0);
  b.vertex(50, 50, 0, 0, 0, 1, 1, 1);
  b.vertex(-50, 50, 0, 0, 0, 1, 0, 1);
  b.quad(0, 1, 2, 3);
  return b.build();
}

const at = (x: number, y: number, z: number) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);

/** A toon look with its bands hard and flat, so a band's edge is a step and a texel inside one is its value. */
const HARD = { gloss: 0, sheen: 0, smoothShading: 0, occlusionTint: 0, form: 0 };

async function disc(): Promise<ImageBitmap> {
  const canvas = new OffscreenCanvas(64, 64);
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(32, 32, 12, 0, Math.PI * 2);
  g.fill();
  return createImageBitmap(canvas, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

describe('the shadow and the occlusion of a cut-out card', () => {
  let gpu: Gpu;
  let env: ReturnType<typeof bakeEnvironment>;
  let r: GameRenderer;
  let target: GPUTexture;

  beforeAll(async () => {
    gpu = await createDevice();
    env = bakeEnvironment(gpu, 'daylight', { size: 32, mips: 3 });
    await env.samples;
    target = gpu.device.createTexture({ size: [W, H], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    r = await make();
    r.setCardImages([await disc()]);
  });

  async function make(): Promise<GameRenderer> {
    const renderer = new GameRenderer(gpu, 16, 8, 256, 1);
    await renderer.ready;
    renderer.setEnvironment(env.specular, env.brdf, env.mips);
    renderer.resize(W, H);
    renderer.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
    renderer.camera.fov = 6; renderer.camera.near = 100; renderer.camera.far = 600;
    renderer.camera.target = [0, 0, 0];
    renderer.camera.position = [0, -5, 300];
    return renderer;
  }

  afterAll(() => { r?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  /** The lab's lights for the sun: up and a little to +x, so a flat card held at `z` throws its shadow `z * 0.4 / 0.9165` to -x. */
  const SUN_LOOK = { sunDir: [0.4, 0, 0.9165] as [number, number, number], sunColour: [3, 3, 3] as [number, number, number] };

  beforeEach(() => {
    r.look = { ...r.look, shading: 'pbr', antialias: undefined, background: [0.02, 0.02, 0.03], occlusion: 0, sunColour: [0, 0, 0], ambient: 0.2, exposure: 1, falloffHalf: 600 };
    r.economy = { ...FULL_ECONOMY, shadows: true };
    r.setLights(new LightPool(16));
    r.setSunShadow(null);
    r.setStatic([]);
    r.setDynamic([]);
  });

  /** Where a world point lands on the target, in pixels. */
  function pixelOf(p: [number, number, number]): [number, number] {
    r.camera.update();
    const m = r.camera.viewProjection;
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    return [Math.round((x / w * 0.5 + 0.5) * W), Math.round((0.5 - y / w * 0.5) * H)];
  }

  /** The mean of the channels in a block of pixels about a world point on the ground. */
  function value(p: Pixels, point: [number, number, number], size = 3): number {
    const [x, y] = pixelOf(point);
    const [a, b, c] = meanIn(p, x - size, y - size, x + size + 1, y + size + 1);
    return (a + b + c) / 3;
  }

  async function draw(name = '', mode: FrameMode = 'redraw'): Promise<Pixels> {
    gpu.device.pushErrorScope('validation');
    const drew = r.frame(target.createView(), mode, 0);
    const error = await gpu.device.popErrorScope();
    expect(error?.message ?? null).toBeNull();
    expect(drew).toBe(true);
    const px = await readPixels(gpu, target);
    if (name) await saveFrame(`cardshadow ${name}`, px);
    return px;
  }

  const ground = (): GameGroup => ({ mesh: floor(), matrices: at(0, 0, 0), albedo: GROUND, roughness: 0.9 });
  /** The card, or the same square uncut, held at a height over the ground. */
  const held = (z: number, cut: boolean): GameGroup => ({ mesh: card(), matrices: at(0, 0, z), albedo: GREEN, roughness: 0.9, ...(cut ? { card: { layer: 1 } } : {}) });

  async function drawn(card: GameGroup, name = ''): Promise<Pixels> {
    r.setStatic([ground(), card]);
    await r.prepare();
    return draw(name);
  }

  /** The four corners of a square's shadow, read at `CORNER` out along each diagonal from its middle. */
  const cornersAt = (m: [number, number]): [number, number, number][] => [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) => [m[0] + sx * CORNER, m[1] + sy * CORNER, 0]);

  /** The checks that the shadow of the cut card is the disc: the middle as shaded as the square's, the corners as lit as the open floor. */
  function expectRound(square: Pixels, cut: Pixels, middle: [number, number], open: [number, number, number], label: string) {
    const shade = value(square, [middle[0], middle[1], 0]);
    const lit = value(square, open);
    // the shadow has to be there to be told from the light
    expect(lit - shade, `${label}: the square's shadow is darker than the open floor (shade ${shade}, lit ${lit})`).toBeGreaterThan(25);
    const gap = lit - shade;
    expect(value(cut, [middle[0], middle[1], 0]), `${label}: the middle of the disc's shadow`).toBeLessThan(shade + gap * 0.25);
    for (const c of cornersAt(middle)) {
      expect(value(square, c), `${label}: the square's shadow fills its corner`).toBeLessThan(shade + gap * 0.25);
      expect(value(cut, c), `${label}: the corner of the cut card's shadow is lit`).toBeGreaterThan(lit - gap * 0.25);
    }
  }

  describe('the sun', () => {
    // The sun is up and a little to +x: a flat card held at `Z` throws its shadow `Z * 0.4 / 0.9` to -x.
    const SUN: [number, number, number] = [0.4, 0, 0.9165];
    const Z = 20;
    const MIDDLE: [number, number] = [-(Z * SUN[0]) / SUN[2], 0];
    const OPEN: [number, number, number] = [12, 9, 0];

    for (const shading of ['pbr', 'toon'] as const) {
      it(`casts a round shadow from a disc-masked square: the middle in shade, the square's corner lit (${shading})`, async () => {
        r.look = { ...r.look, shading, sunDir: SUN, sunColour: [3, 3, 3], ...(shading === 'toon' ? HARD : {}) };
        r.setSunShadow({ min: [-60, -60, -10], max: [60, 60, 60] });
        const square = await drawn(held(Z, false), `sun square ${shading}`);
        const cut = await drawn(held(Z, true), `sun disc ${shading}`);
        expectRound(square, cut, MIDDLE, OPEN, `sun ${shading}`);
      });
    }
  });

  describe('the images and the builds', () => {
    const Z = 20, MIDDLE: [number, number] = [-(Z * 0.4) / 0.9165, 0], OPEN: [number, number, number] = [12, 9, 0];
    const lit = () => { r.look = { ...r.look, ...SUN_LOOK }; r.setSunShadow({ min: [-60, -60, -10], max: [60, 60, 60] }); };

    it('read the images they are given: a solid image makes the shadow the square, and the disc again makes it round', async () => {
      lit();
      const corner = cornersAt(MIDDLE)[0];
      const round = await drawn(held(Z, true));
      const reference = await drawn(held(Z, false));
      const gap = value(round, OPEN) - value(reference, [MIDDLE[0], MIDDLE[1], 0]);
      expect(gap).toBeGreaterThan(25);
      expect(value(round, corner), 'round with the disc').toBeGreaterThan(value(round, OPEN) - gap * 0.25);
      // the reference was the group with no card, so the card is handed in again
      r.setStatic([ground(), held(Z, true)]);
      await r.prepare();
      const solid = new OffscreenCanvas(64, 64);
      const g = solid.getContext('2d')!;
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, 64, 64);
      r.setCardImages([await createImageBitmap(solid, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })]);
      expect(value(await draw(), corner), 'a solid image casts the square').toBeLessThan(value(reference, [MIDDLE[0], MIDDLE[1], 0]) + gap * 0.25);
      r.setCardImages([await disc()]);
      expect(value(await draw(), corner), 'and the disc, set again, the round').toBeGreaterThan(value(round, OPEN) - gap * 0.25);
    });

    it('re-bake a kept frame\'s shadows when the cut builds land: square at first, round after', async () => {
      const shared = r;
      r = await make();
      try {
        r.look = { ...r.look, shading: 'pbr', background: [0.02, 0.02, 0.03], occlusion: 0, ambient: 0.2, exposure: 1, ...SUN_LOOK };
        r.setLights(new LightPool(16));
        r.setSunShadow({ min: [-60, -60, -10], max: [60, 60, 60] });
        r.economy = { ...FULL_ECONOMY, shadows: true };
        r.setCardImages([await disc()]);
        const corner = cornersAt(MIDDLE)[0];
        r.setStatic([ground(), held(Z, false)]);
        await r.prepare();
        const reference = await draw();
        const shade = value(reference, [MIDDLE[0], MIDDLE[1], 0]), open = value(reference, OPEN);
        r.setStatic([ground(), held(Z, true)]);
        const early = await draw('', 'keep');
        expect(value(early, corner), 'baked before the builds landed: the square\'s shadow').toBeLessThan(shade + (open - shade) * 0.25);
        await r.prepare();
        const late = await draw('kept round', 'keep');
        expect(value(late, corner), 'and the kept half baked again once they have').toBeGreaterThan(open - (open - shade) * 0.25);
      } finally {
        r.dispose();
        r = shared;
      }
    });
  });

  describe('a spot', () => {
    // A lamp above and to +x of the card, looking down at it: the shadow of a flat card at height h is the card scaled
    // about the lamp's foot by P / (P - h), and so its middle is the card's, moved out from the foot.
    const LAMP: [number, number, number] = [50, 0, 120];
    const Z = 20;
    const SCALE = LAMP[2] / (LAMP[2] - Z);
    const MIDDLE: [number, number] = [LAMP[0] + (0 - LAMP[0]) * SCALE, 0];

    it('casts a round shadow from a disc-masked square, as the sun does', async () => {
      const pool = new LightPool(16);
      pool.add({ position: LAMP, radius: 900, colour: [1, 1, 1], intensity: 12, direction: [MIDDLE[0] - LAMP[0], 0, -LAMP[2]], cone: [16, 24] });
      r.setLights(pool, [0]);
      // a hard edge, as the shadows test has it: the default widens it with the distance from the lamp
      r.look = { ...r.look, spotSoftness: 0 };
      const square = await drawn(held(Z, false), 'spot square');
      const cut = await drawn(held(Z, true), 'spot disc');
      // the shadow is scaled, so its square is a little wider and its corner read a little further out
      expectRound(square, cut, MIDDLE, [6, -9, 0], 'spot');
    });
  });

  describe('the contact occlusion', () => {
    /** A card held close to the ground, and the open ground under the environment alone, shaded by the occlusion. */
    const Z = 1;
    const look = { occlusion: 3, occlusionRadius: 2.5, occlusionDirect: 0 };
    const FAR: [number, number, number] = [-20, 14, 0];

    it('is round: the ground at the card\'s corner is as bright as with no card, and the square darkens it', async () => {
      r.look = { ...r.look, ambient: 0.8, ...look };
      const without = await drawnWithout('occlusion none');
      const square = await drawn(held(Z, false), 'occlusion square');
      const cut = await drawn(held(Z, true), 'occlusion disc');
      const open = value(without, FAR);
      // Beside the card, where the ground is seen outside its square (a hand's width from the disc, past the occlusion's
      // reach of it) and in the square's corners, where it is seen through the cut. The square's depth darkens the first
      // of these and, being the card's depth there and not the ground's, the second is drawn from it.
      const edge: [number, number, number][] = [[SIDE / 2 + 0.6, 0, 0], [-SIDE / 2 - 0.6, 0, 0], [0, SIDE / 2 + 0.6, 0], [0, -SIDE / 2 - 0.6, 0]];
      const points = [...cornersAt([0, 0]), ...edge];
      for (const c of points) {
        const bare = value(without, c);
        expect(Math.abs(bare - open), 'the open ground is level').toBeLessThan(open * 0.08 + 1);
        expect(value(cut, c), `the ground at (${c[0]}, ${c[1]}) is within a few levels of the ground with no card (square ${value(square, c)})`).toBeGreaterThan(bare - Math.max(3, bare * 0.04));
      }
      // the square's depth does darken them, so the check above is one the cut has to earn
      expect(Math.min(...points.map((c) => value(square, c) - value(without, c))), 'the uncut square darkens the ground it is beside').toBeLessThan(-8);
    });

    /** The ground alone. */
    async function drawnWithout(name: string): Promise<Pixels> {
      r.setStatic([ground()]);
      await r.prepare();
      return draw(name);
    }
  });
});
