/**
 * The environment's bake, on a real device: that it lands, and that it asks
 * nothing of the device that the device need not give.
 *
 * The split-sum table is drawn by a shader with no bindings at all, and the
 * bake used to ask that pipeline for its bind group layout at group nought
 * and set an empty group made from it. A pipeline whose shader has no groups
 * has no layout at nought to give: Chrome hands one back regardless, Firefox
 * says so and makes the group invalid, and an invalid group set in a pass
 * makes the pass invalid, and the pass shares its encoder with the sky and
 * every face of the prefilter. So in Firefox the whole bake was dropped:
 * nothing of the sky in any scene, and nothing said about it but three lines
 * in a console nobody had open.
 *
 * Chrome lets it through, so a test that ran the bake in Chrome and looked
 * for an error would never have seen it. This holds the bake to the rule
 * itself: no pipeline is asked for a group its shader does not have.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, halfToFloat, readbackLayer, type Gpu } from '../../gpu/context';
import { bakeEnvironment, type Environment } from '../env';

describe("the environment's bake", () => {
  let gpu: Gpu;
  let env: Environment;
  /** Every time a pipeline was asked for a group its shader has none of, as "label: group n". */
  const askedAmiss: string[] = [];
  let failure: GPUError | null = null;
  let restore = () => {};

  beforeAll(async () => {
    gpu = await createDevice();
    const { device } = gpu;
    // what groups each pipeline's shader has, noted as the bake makes them
    const codeOf = new WeakMap<GPUShaderModule, string>();
    const groupsOf = new WeakMap<GPURenderPipeline, Set<number>>();
    const makeModule = device.createShaderModule.bind(device);
    device.createShaderModule = (d) => {
      const m = makeModule(d);
      codeOf.set(m, d.code);
      return m;
    };
    const makePipeline = device.createRenderPipelineAsync.bind(device);
    device.createRenderPipelineAsync = async (d) => {
      const p = await makePipeline(d);
      const code = (codeOf.get(d.vertex.module) ?? '') + (d.fragment ? (codeOf.get(d.fragment.module) ?? '') : '');
      groupsOf.set(p, new Set([...code.matchAll(/@group\((\d+)\)/g)].map((m) => +m[1])));
      return p;
    };
    const ask = GPURenderPipeline.prototype.getBindGroupLayout;
    GPURenderPipeline.prototype.getBindGroupLayout = function (this: GPURenderPipeline, index: number) {
      const groups = groupsOf.get(this);
      if (groups && !groups.has(index)) askedAmiss.push(`${this.label}: group ${index}`);
      return ask.call(this, index);
    };
    restore = () => { GPURenderPipeline.prototype.getBindGroupLayout = ask; };

    device.pushErrorScope('validation');
    env = bakeEnvironment(gpu, 'studio', { size: 32, mips: 3, brdfSize: 32 });
    await env.samples;
    await gpu.queue.onSubmittedWorkDone();
    failure = await device.popErrorScope();
  });

  afterAll(() => { restore(); env?.dispose(); gpu?.device.destroy(); });

  it('asks no pipeline for a group its shader does not have', () => {
    expect(askedAmiss).toEqual([]);
  });

  it('raises no validation error', () => {
    expect(failure?.message ?? null).toBe(null);
  });

  it('lands: a split-sum table that is not black, and a sky in the cube', async () => {
    const table = Array.from(new Uint16Array(await readbackLayer(gpu.device, env.brdf, 0, 0, 32, 8)), halfToFloat);
    // the scale's column runs up to about one where the view is square on and the surface smooth
    expect(Math.max(...table.filter((_, i) => i % 4 === 0))).toBeGreaterThan(0.5);
    let most = 0;
    for (let face = 0; face < 6; face++) {
      const half = new Uint16Array(await readbackLayer(gpu.device, env.specular, face, 0, 32, 8));
      for (let i = 0; i < half.length; i++) if (i % 4 !== 3) most = Math.max(most, halfToFloat(half[i]));
    }
    expect(most, 'the brightest thing in the sky').toBeGreaterThan(1);
  });
});
