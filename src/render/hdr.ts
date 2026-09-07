/**
 * Radiance HDR files (.hdr, .pic): the format every light probe comes in.
 *
 * A text header, then scanlines of RGBE pixels — three mantissas and one
 * shared exponent per pixel — either flat or, in every file made since the
 * nineties, run-length encoded a channel at a time. Decoded to linear RGB
 * floats. The image is taken to be an equirectangular map: longitude across,
 * latitude down, the horizon in the middle.
 */

export interface HdrImage {
  width: number;
  height: number;
  /** RGBA floats, row 0 at the top. */
  data: Float32Array;
}

export function parseHdr(buffer: ArrayBuffer): HdrImage {
  const bytes = new Uint8Array(buffer);
  let pos = 0;
  const line = () => {
    let end = pos;
    while (end < bytes.length && bytes[end] !== 0x0a) end++;
    const text = String.fromCharCode(...bytes.subarray(pos, end));
    pos = end + 1;
    return text;
  };
  const magic = line();
  if (!magic.startsWith('#?')) throw new Error('not a Radiance HDR file');
  let format = '';
  for (;;) {
    const l = line();
    if (l === '') break;
    if (l.startsWith('FORMAT=')) format = l.slice(7);
    if (pos >= bytes.length) throw new Error('HDR header never ends');
  }
  if (format && format !== '32-bit_rle_rgbe') throw new Error(`HDR format ${format} is not supported`);
  const dims = line().trim().match(/^-Y (\d+) \+X (\d+)$/);
  if (!dims) throw new Error('only top-down, left-to-right HDR files are supported');
  const height = parseInt(dims[1], 10);
  const width = parseInt(dims[2], 10);

  const data = new Float32Array(width * height * 4);
  const rgbe = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    if (width >= 8 && width < 32768 && bytes[pos] === 2 && bytes[pos + 1] === 2 && (bytes[pos + 2] & 0x80) === 0) {
      // new-style run-length: a scanline header, then each channel in runs
      const w = (bytes[pos + 2] << 8) | bytes[pos + 3];
      if (w !== width) throw new Error('HDR scanline width does not match');
      pos += 4;
      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < width) {
          let count = bytes[pos++];
          if (count > 128) {
            count -= 128;
            const value = bytes[pos++];
            for (let k = 0; k < count; k++) rgbe[(x++) * 4 + c] = value;
          } else {
            for (let k = 0; k < count; k++) rgbe[(x++) * 4 + c] = bytes[pos++];
          }
        }
      }
    } else {
      // flat pixels (old-style runs are rare enough to be left out)
      rgbe.set(bytes.subarray(pos, pos + width * 4));
      pos += width * 4;
    }
    for (let x = 0; x < width; x++) {
      const e = rgbe[x * 4 + 3];
      const scale = e === 0 ? 0 : Math.pow(2, e - 128 - 8);
      const o = (y * width + x) * 4;
      data[o] = rgbe[x * 4] * scale;
      data[o + 1] = rgbe[x * 4 + 1] * scale;
      data[o + 2] = rgbe[x * 4 + 2] * scale;
      data[o + 3] = 1;
    }
  }
  return { width, height, data };
}

/**
 * Mean radiance over the sphere, each row weighted by how much of the sphere
 * it covers, so a probe can be brought to the scale the presets are drawn at.
 */
export function meanRadiance(img: HdrImage): number {
  let sum = 0, weight = 0;
  for (let y = 0; y < img.height; y++) {
    const w = Math.cos(((y + 0.5) / img.height - 0.5) * Math.PI);
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * 4;
      sum += w * (0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2]);
      weight += w;
    }
  }
  return weight > 0 ? sum / weight : 0;
}
