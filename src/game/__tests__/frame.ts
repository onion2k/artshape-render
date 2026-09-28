/**
 * What a GPU test needs to look at a frame: its pixels read back, and the
 * frame written out as a PNG for a person to look at when VITE_FRAME_DIR
 * names a directory. Every GPU test before this one carried its own copy of
 * both; the new ones share this, so the padding of a row to 256 bytes and
 * the swap of a BGRA canvas format are got right once.
 *
 * For the browser run only: it reaches the test server to write files.
 */
/// <reference types="vite/client" />
import { server } from '@vitest/browser/context';
import type { Gpu } from '../../gpu/context';

const FRAME_DIR: string | undefined = import.meta.env.VITE_FRAME_DIR;

/** A frame's pixels, row by row from the top, as [r, g, b] each. */
export type Pixels = { width: number; height: number; rgb: Uint8Array };

/** The pixels of `texture`, a target of `gpu.format`, read back once the queue has finished with it. */
export async function readPixels(gpu: Gpu, texture: GPUTexture): Promise<Pixels> {
  const { width, height } = texture;
  await gpu.queue.onSubmittedWorkDone();
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buffer = gpu.device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = gpu.device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, [width, height, 1]);
  gpu.queue.submit([enc.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const px = new Uint8Array(buffer.getMappedRange());
  const bgr = gpu.format.startsWith('bgra');
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const o = y * bytesPerRow + x * 4, i = (y * width + x) * 3;
      rgb[i] = bgr ? px[o + 2] : px[o];
      rgb[i + 1] = px[o + 1];
      rgb[i + 2] = bgr ? px[o] : px[o + 2];
    }
  buffer.unmap();
  buffer.destroy();
  return { width, height, rgb };
}

/** How many pixels of two frames of the same size differ at all. */
export function differing(a: Pixels, b: Pixels): number {
  let n = 0;
  for (let i = 0; i < a.rgb.length; i += 3)
    if (a.rgb[i] !== b.rgb[i] || a.rgb[i + 1] !== b.rgb[i + 1] || a.rgb[i + 2] !== b.rgb[i + 2]) n++;
  return n;
}

/** The mean colour of the pixels in a rectangle, 0 to 255 each. */
export function meanIn(p: Pixels, x0: number, y0: number, x1: number, y1: number): [number, number, number] {
  const s = [0, 0, 0];
  let n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * p.width + x) * 3;
      s[0] += p.rgb[i]; s[1] += p.rgb[i + 1]; s[2] += p.rgb[i + 2];
      n++;
    }
  return [s[0] / n, s[1] / n, s[2] / n];
}

/** Write the frame out as `name`.png, when a directory for frames was named; otherwise nothing. */
export async function saveFrame(name: string, p: Pixels): Promise<void> {
  if (!FRAME_DIR) return;
  const c = document.createElement('canvas');
  c.width = p.width;
  c.height = p.height;
  const g = c.getContext('2d')!;
  const img = g.createImageData(p.width, p.height);
  for (let i = 0, j = 0; i < p.rgb.length; i += 3, j += 4) img.data.set([p.rgb[i], p.rgb[i + 1], p.rgb[i + 2], 255], j);
  g.putImageData(img, 0, 0);
  await server.commands.writeFile(`${FRAME_DIR}/${name}.png`, c.toDataURL('image/png').split(',')[1], 'base64');
}
