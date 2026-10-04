/**
 * Mip levels for a texture array, drawn rather than copied. An `ImageBitmap`
 * goes into level zero of a layer with `copyExternalImageToTexture`, and
 * nothing else in the package writes an image to a texture, so nothing could
 * make the levels below it: without them a far field of grain is sampled
 * texel by texel and shimmers. Each level is a fullscreen pass that reads the
 * one above through a linear filter, which for a power of two is the box
 * average of four texels, and that is all the levels need to be.
 */

const BLIT_WGSL = `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vsMain(@builtin(vertex_index) i: u32) -> VsOut {
  // one triangle that covers the target
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var out: VsOut;
  out.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(p.x, 1.0 - p.y);
  return out;
}
@fragment fn fsMain(in: VsOut) -> @location(0) vec4f {
  return textureSampleLevel(src, samp, in.uv, 0.0);
}
`;

/** The texel format of a ground texture: not sRGB, since the layers are modulation and a height, not light. */
export const GROUND_FORMAT: GPUTextureFormat = 'rgba8unorm';

/** Makes the mip levels of rgba8unorm textures, with one pipeline made the first time and kept. */
export class MipBlitter {
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;

  constructor(private device: GPUDevice) {
    const module = device.createShaderModule({ label: 'mip blit', code: BLIT_WGSL });
    this.pipeline = device.createRenderPipeline({
      label: 'mip blit',
      layout: 'auto',
      vertex: { module, entryPoint: 'vsMain' },
      fragment: { module, entryPoint: 'fsMain', targets: [{ format: GROUND_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    this.sampler = device.createSampler({ label: 'mip blit', magFilter: 'linear', minFilter: 'linear' });
  }

  /**
   * Fills every level above zero of every layer of `texture` from the level
   * below it. The texture must have been made with `RENDER_ATTACHMENT` and
   * `TEXTURE_BINDING` usage, and be square; `levels` is its mip count.
   */
  generate(texture: GPUTexture, layers: number, levels: number) {
    const encoder = this.device.createCommandEncoder({ label: 'mip blit' });
    for (let layer = 0; layer < layers; layer++) {
      for (let level = 1; level < levels; level++) {
        const view = (l: number) => texture.createView({ dimension: '2d', baseMipLevel: l, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
        const bind = this.device.createBindGroup({
          layout: this.pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: view(level - 1) }, { binding: 1, resource: this.sampler }],
        });
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: view(level), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, bind);
        pass.draw(3);
        pass.end();
      }
    }
    this.device.queue.submit([encoder.finish()]);
  }
}
