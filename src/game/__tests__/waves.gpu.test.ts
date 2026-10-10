/**
 * Clear water's swells on a real device: the surface is drawn where `heightAt` says it stands, so what a game floats on
 * it rides the very water that is drawn. A strip of water is seen nearly edge-on through a long lens, against the dark,
 * and the top of what is drawn, column by column, is held to the height the sums give there, at three times. With no
 * waves, the strip's top is flat. Frames written by VITE_FRAME_DIR.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { MeshBuilder } from '../../mesh/types';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, FULL_ECONOMY, GameRenderer, PATTERN_STRIDE, type GameGroup } from '../renderer';
import { LightPool } from '../lights';
import { FLOW_CLEAR, packFlow } from '../flow';
import { GRAVITY_MM, heightAt, type GerstnerWave } from '../waves';
import { readPixels, saveFrame, type Pixels } from './frame';
import { DEEP, SHALLOW, one } from './clearscene';

const W = 192, H = 192;
const MM_PER_UNIT = 100;
const G = GRAVITY_MM / MM_PER_UNIT;
/** The strip: long in x, the way the wave goes, and a unit deep, finely cut so its vertices can follow the wave. */
const LONG = 2.5, DEEP_HALF = 0.5, CUTS = 500;
const SWELL: GerstnerWave[] = [{ direction: 0, wavelength: 1.6, amplitude: 0.3, steepness: 0.5 }];

function strip(): GameGroup {
  const b = new MeshBuilder();
  for (let i = 0; i <= CUTS; i++) {
    const x = -LONG + (2 * LONG * i) / CUTS;
    b.vertex(x, -DEEP_HALF, 0, 0, 0, 1, 0, 0);
    b.vertex(x, DEEP_HALF, 0, 0, 0, 1, 0, 0);
  }
  for (let i = 0; i < CUTS; i++) b.quad(i * 2, i * 2 + 2, i * 2 + 3, i * 2 + 1);
  const patterns = packFlow(new Float32Array(PATTERN_STRIDE), 0, { kind: FLOW_CLEAR, scale: 0.4, speed: 0.5, glow: 0, second: DEEP });
  return { mesh: b.build(), matrices: one, albedo: SHALLOW, roughness: 0.1, patterns };
}

/** The first row from the top, in each column, that is not the dark behind: the top of the water drawn there. */
function tops(p: Pixels): number[] {
  const out: number[] = [];
  // the dark behind, as the top corner has it
  const behind = p.rgb[0] + p.rgb[1] + p.rgb[2];
  for (let x = 0; x < p.width; x++) {
    let top = -1;
    for (let y = 0; y < p.height && top < 0; y++) {
      const o = (y * p.width + x) * 3;
      if (Math.abs(p.rgb[o] + p.rgb[o + 1] + p.rgb[o + 2] - behind) > 60) top = y;
    }
    out.push(top);
  }
  return out;
}

describe('clear water that swells', () => {
  let gpu: Gpu;
  let env: ReturnType<typeof bakeEnvironment>;
  let r: GameRenderer;
  let target: GPUTexture;

  beforeAll(async () => {
    gpu = await createDevice();
    env = bakeEnvironment(gpu, 'daylight', { size: 32, mips: 3 });
    await env.samples;
    target = gpu.device.createTexture({ size: [W, H], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    r = new GameRenderer(gpu, 8, 8, 256, MM_PER_UNIT);
    await r.ready;
    r.setEnvironment(env.specular, env.brdf, env.mips);
    r.resize(W, H);
    r.setLights(new LightPool(8));
    // three hundred units off, a little above, through a lens a third of a degree across: a pixel is under a hundredth of a unit
    r.camera.fov = 0.3; r.camera.near = 100; r.camera.far = 600;
    r.camera.target = [0, 0, 0];
    r.camera.position = [0, -300, 6];
    r.look = { ...r.look, shading: 'pbr', antialias: undefined, background: [0.02, 0.02, 0.03], occlusion: 0, ambient: 1, exposure: 1 };
    r.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
    r.economy = { ...FULL_ECONOMY, shadows: false };
    r.setStatic([strip()]);
  });

  afterAll(() => { r?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  async function draw(name: string): Promise<Pixels> {
    await r.prepare();
    gpu.device.pushErrorScope('validation');
    expect(r.frame(target.createView(), 'redraw', 0)).toBe(true);
    expect(r.frame(target.createView(), 'redraw', 0)).toBe(true);
    const error = await gpu.device.popErrorScope();
    expect(error?.message ?? null).toBeNull();
    const p = await readPixels(gpu, target);
    await saveFrame(`waves ${name}`, p);
    return p;
  }

  /** Where the far edge of the strip should top each column, from the sums: the highest of it that falls there. */
  function expected(t: number): number[] {
    r.camera.update();
    const m = r.camera.viewProjection;
    const rows = new Array<number>(W).fill(Infinity);
    for (let x = -1.2; x <= 1.2; x += 0.0005) {
      const z = heightAt(SWELL, x, DEEP_HALF, t, G);
      const w = m[3] * x + m[7] * DEEP_HALF + m[11] * z + m[15];
      const sx = ((m[0] * x + m[4] * DEEP_HALF + m[8] * z + m[12]) / w + 1) * 0.5 * W;
      const sy = (1 - (m[1] * x + m[5] * DEEP_HALF + m[9] * z + m[13]) / w) * 0.5 * H;
      const column = Math.floor(sx);
      // a pixel is drawn where its centre is under the edge
      if (column >= 0 && column < W) rows[column] = Math.min(rows[column], Math.ceil(sy - 0.5));
    }
    return rows;
  }

  for (const t of [0, 0.7, 2.3])
    it(`stands where the sums say it does, at ${t} s`, async () => {
      r.look = { ...r.look, clear: { foamWidth: 0, glitter: 0, refraction: 0, caustics: 0, waves: SWELL } };
      r.time = t;
      const drawn = tops(await draw(`at ${t}`));
      const want = expected(t);
      let checked = 0, worst = 0;
      for (let c = 8; c < W - 8; c++) {
        if (!Number.isFinite(want[c])) continue;
        worst = Math.max(worst, Math.abs(drawn[c] - want[c]));
        checked++;
      }
      expect(checked, 'the columns checked').toBeGreaterThan(150);
      // a pixel here is 0.0082 units, so within a pixel is within a hundredth of a unit
      expect(worst, 'the furthest the drawn top is from the sums, in pixels').toBeLessThanOrEqual(1);
      // and it is a swell, not a flat top: the crests and troughs are many pixels apart
      const seen = drawn.slice(8, W - 8);
      expect(Math.max(...seen) - Math.min(...seen), 'from trough to crest, in pixels').toBeGreaterThan(40);
    });

  it('lies flat with no waves', async () => {
    r.look = { ...r.look, clear: { foamWidth: 0, glitter: 0, refraction: 0, caustics: 0 } };
    r.time = 0.7;
    const seen = tops(await draw('none')).slice(8, W - 8);
    expect(Math.min(...seen)).toBeGreaterThan(0);
    expect(Math.max(...seen) - Math.min(...seen)).toBeLessThanOrEqual(1);
  });
});
