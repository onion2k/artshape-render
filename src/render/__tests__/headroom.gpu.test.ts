/**
 * Headroom: how dense a mesh the renderer takes before something gives —
 * a stage that takes seconds, a buffer over a device limit, a bake that
 * never lands. A parametric shell at rising density, each stage timed and
 * printed, so the numbers are on record when the budgets are set. The
 * largest size runs only under VITE_HEADROOM=full, with a test timeout to
 * match: `VITE_HEADROOM=full npx vitest run --config vitest.browser.config.ts
 * src/render/__tests__/headroom.gpu.test.ts --testTimeout=180000`.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { Renderer } from '../renderer';
import { surface, shell } from '../../mesh/surface';

const SIZE = 512;
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

describe('headroom', () => {
  let gpu: Gpu;
  let renderer: Renderer;
  let target: GPUTexture;
  const errors: string[] = [];
  const consoleError = console.error;

  beforeAll(async () => {
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); consoleError(...args); };
    gpu = await createDevice();
    const a = (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }))!.limits;
    console.log(`adapter: maxBufferSize ${a.maxBufferSize / 1e6} MB, maxStorageBufferBindingSize ${a.maxStorageBufferBindingSize / 1e6} MB, maxComputeWorkgroupsPerDimension ${a.maxComputeWorkgroupsPerDimension}`);
    const l = gpu.device.limits;
    console.log(`limits: maxBufferSize ${l.maxBufferSize / 1e6} MB, maxStorageBufferBindingSize ${l.maxStorageBufferBindingSize / 1e6} MB, maxUniformBufferBindingSize ${l.maxUniformBufferBindingSize / 1e3} kB`);
    renderer = new Renderer(gpu);
    await renderer.ready;
    renderer.setSize(SIZE, SIZE);
    target = gpu.device.createTexture({ label: 'headroom target', size: [SIZE, SIZE], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    renderer.setEnvironment('studio');
    renderer.setKeyLight({ elevation: Math.PI / 4, azimuth: -Math.PI / 4, strength: 1, warmth: 0.3, size: 0.08 });
    renderer.setMaterial('gold', 'polished');
    await renderer.setEnvironment('studio').samples;
  });

  afterAll(() => {
    console.error = consoleError;
    renderer?.dispose();
    target?.destroy();
    gpu?.device.destroy();
  });

  // the largest, eleven million triangles and a quarter of a minute, on request: VITE_HEADROOM=full
  const sizes = import.meta.env.VITE_HEADROOM === 'full' ? [300, 600, 1200, 2400] : [300, 600, 1200];
  for (const segments of sizes) {
    it(`a shell at ${segments}×${segments / 2}`, async () => {
      const t = { generate: 0, upload: 0, first: 0, bake: 0, probe: 0, traceBuild: 0, traceSample: 0 };
      const view = () => target.createView();
      const timed = async (key: keyof typeof t, f: () => unknown) => {
        const t0 = performance.now();
        await f();
        await gpu.queue.onSubmittedWorkDone();
        t[key] = Math.round(performance.now() - t0);
      };
      let mesh!: ReturnType<typeof surface>;
      await timed('generate', () => { mesh = surface(shell(18, 6, 3, 1.4, 30), { thickness: 0.6, segmentsU: segments, segmentsV: segments / 2 }); });
      const triangles = mesh.indices.length / 3;
      const groups = [{ mesh, matrices: IDENTITY }];
      renderer.setQuality('draft');
      await timed('upload', () => { renderer.setInstanced(groups); });
      const b = { min: [-30, -30, -20] as [number, number, number], max: [30, 30, 40] as [number, number, number] };
      renderer.frameBounds(b);
      renderer.setFocus(100, 100);
      await timed('first', () => { expect(renderer.render(view)).toBe(true); });
      // the bake lands in chunks; each marks a frame due
      await timed('bake', async () => {
        for (let i = 0; i < 200; i++) {
          renderer.render(view);
          await new Promise((r) => setTimeout(r, 10));
          if (!renderer.pending) break;
        }
      });
      await timed('probe', () => { renderer.requestRender(); renderer.render(view); });
      renderer.setQuality('traced');
      renderer.setMoving(false);
      // the scene builds off the thread; frames keep coming from the raster path until it lands
      await timed('traceBuild', async () => {
        for (let i = 0; i < 3000 && renderer.traceSamples === 0; i++) {
          renderer.requestRender();
          renderer.render(view);
          await new Promise((r) => setTimeout(r, 10));
        }
      });
      expect(renderer.traceSamples).toBeGreaterThan(0);
      await timed('traceSample', () => { renderer.render(view); });
      renderer.setQuality('draft');
      console.log(`${segments}: ${(triangles / 1e6).toFixed(2)} M triangles, ${(mesh.positions.length / 3 / 1e6).toFixed(2)} M vertices — ` + Object.entries(t).map(([k, v]) => `${k} ${v} ms`).join(', ') + `, samples ${renderer.traceSamples}`);
      const unique = [...new Set(errors.map((e) => e.split('\n')[0]))];
      errors.length = 0;
      expect(unique, unique.join('\n')).toEqual([]);
    });
  }
});
