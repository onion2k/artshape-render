/**
 * The WebGPU device and the handful of helpers everything else shares.
 *
 * Deliberately thin. The renderer owns its own bakes and passes and wants to
 * talk to the API directly; what it needs from a layer is a device, a canvas,
 * shader compilation that fails loudly, and buffers that come out the right
 * size. Anything more would be an engine, and an engine is what was just
 * removed.
 */

/**
 * What the renderer and its bakes need of the GPU: a device, its queue and
 * the format frames are composited to. No canvas: a renderer over this alone
 * draws into any texture view of that format.
 */
export interface Gpu {
  device: GPUDevice;
  queue: GPUQueue;
  format: GPUTextureFormat;
  /** What the browser will say about the adapter, which is little, but enough to tell one machine's verdict from another's. */
  adapter: AdapterInfo;
}

/**
 * The adapter, as far as the browser tells. Vendor and architecture are
 * normalised words (`intel`, `gen-12lp`); `description` is the driver's own
 * string when there is one; `fallback` is a software renderer, which is the
 * slowest thing there is. `key` joins them, for keeping a verdict against.
 */
export interface AdapterInfo {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  fallback: boolean;
  key: string;
}

export function adapterInfo(adapter: GPUAdapter): AdapterInfo {
  const info = adapter.info;
  const vendor = info?.vendor ?? '', architecture = info?.architecture ?? '', device = info?.device ?? '', description = info?.description ?? '';
  const fallback = !!(info?.isFallbackAdapter ?? (adapter as { isFallbackAdapter?: boolean }).isFallbackAdapter);
  const key = [vendor, architecture, device, description, fallback ? 'fallback' : ''].filter(Boolean).join('/') || 'unknown';
  return { vendor, architecture, device, description, fallback, key };
}

/** The same, presented on a canvas: what the viewer adds for the page. */
export interface GpuContext extends Gpu {
  canvas: HTMLCanvasElement;
  context: GPUCanvasContext;
}

/** A device with no canvas, for rendering into textures. `format` defaults to the browser's preferred canvas format. */
export async function createDevice(onLost?: (info: GPUDeviceLostInfo) => void, format?: GPUTextureFormat): Promise<Gpu> {
  if (!navigator.gpu) {
    throw new Error('WebGPU is not available in this browser');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('WebGPU: no adapter');
  // the defaults stop at 256 MB a buffer and 128 MB a storage binding, which a
  // dense mesh's traced scene passes at a few million triangles; the adapter
  // usually allows far more, and asking costs nothing
  const { maxBufferSize, maxStorageBufferBindingSize } = adapter.limits;
  const device = await adapter.requestDevice({ requiredLimits: { maxBufferSize, maxStorageBufferBindingSize } });
  device.addEventListener('uncapturederror', (e) => {
    console.error('WebGPU error:', (e as GPUUncapturedErrorEvent).error.message);
  });
  // A lost device is silent otherwise: the canvas goes magenta and every call
  // after it is a no-op. Say so, loudly, with the reason the browser gives.
  device.lost.then((info) => {
    if (info.reason === 'destroyed') return;
    console.error(`WebGPU device lost (${info.reason}): ${info.message}`);
    onLost?.(info);
  });
  return { device, queue: device.queue, format: format ?? navigator.gpu.getPreferredCanvasFormat(), adapter: adapterInfo(adapter) };
}

export async function createContext(canvas: HTMLCanvasElement, onLost?: (info: GPUDeviceLostInfo) => void): Promise<GpuContext> {
  const gpu = await createDevice(onLost);
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('WebGPU: no canvas context');
  // COPY_SRC so a frame can be read back for a capture; it costs nothing otherwise
  context.configure({ device: gpu.device, format: gpu.format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  return { ...gpu, canvas, context };
}

/** Compile a shader module and surface any diagnostics as an error, not a silent black frame. */
export function shader(device: GPUDevice, code: string, label: string): GPUShaderModule {
  const module = device.createShaderModule({ code, label });
  module.getCompilationInfo().then((info) => {
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length) {
      console.error(`shader "${label}" failed:\n` + errors.map((m) => `  ${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));
    }
  });
  return module;
}

export function bufferFrom(device: GPUDevice, data: ArrayBufferView, usage: GPUBufferUsageFlags, label?: string): GPUBuffer {
  // buffer sizes must be multiples of 4; pad a lone f32 wear array of odd length
  const size = Math.ceil(data.byteLength / 4) * 4;
  const buffer = device.createBuffer({ size, usage, mappedAtCreation: true, label });
  const dst = new Uint8Array(buffer.getMappedRange());
  dst.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  buffer.unmap();
  return buffer;
}

export function emptyBuffer(device: GPUDevice, size: number, usage: GPUBufferUsageFlags, label?: string): GPUBuffer {
  return device.createBuffer({ size: Math.max(4, Math.ceil(size / 4) * 4), usage, label });
}

/**
 * The oversized triangle, as a vertex stage. `uv` is in texture space — (0, 0)
 * at the first row in memory — which is what every sampling pass wants, and
 * what keeps cube faces and lookup tables laid out exactly as they were.
 */
export const FULLSCREEN_VERT = `
struct FsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vsFullscreen(@builtin(vertex_index) i: u32) -> FsOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var out: FsOut;
  out.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(p.x, 1.0 - p.y);
  return out;
}
`;

/** Read a whole 2D layer of a texture back to the CPU. `bytesPerTexel` must give rows aligned to 256 bytes. */
export async function readbackLayer(
  device: GPUDevice,
  texture: GPUTexture,
  layer: number,
  mip: number,
  size: number,
  bytesPerTexel: number,
): Promise<ArrayBuffer> {
  const bytesPerRow = Math.ceil((size * bytesPerTexel) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture, mipLevel: mip, origin: { x: 0, y: 0, z: layer } },
    { buffer, bytesPerRow, rowsPerImage: size },
    { width: size, height: size, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const packed = buffer.getMappedRange().slice(0);
  buffer.unmap();
  buffer.destroy();
  if (bytesPerRow === size * bytesPerTexel) return packed;
  // strip the row padding
  const out = new Uint8Array(size * size * bytesPerTexel);
  const src = new Uint8Array(packed);
  for (let y = 0; y < size; y++) out.set(src.subarray(y * bytesPerRow, y * bytesPerRow + size * bytesPerTexel), y * size * bytesPerTexel);
  return out.buffer;
}

/** IEEE half to float. */
export function halfToFloat(h: number): number {
  const s = (h & 0x8000) ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}
