import { describe, expect, it } from 'vitest';
import { meanRadiance, parseHdr } from '../hdr';
import { agxJs, inverseTonemap } from '../post';

/** Encode floats as a Radiance file, run-length as every real file is. */
function encodeHdr(width: number, height: number, rgb: (x: number, y: number) => [number, number, number], rle = true): ArrayBuffer {
  const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`;
  const bytes: number[] = [...header].map((c) => c.charCodeAt(0));
  for (let y = 0; y < height; y++) {
    const line = new Uint8Array(width * 4);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgb(x, y);
      const m = Math.max(r, g, b);
      if (m < 1e-32) continue;
      const e = Math.ceil(Math.log2(m));
      const scale = 256 / Math.pow(2, e);
      line[x * 4] = Math.min(255, Math.floor(r * scale));
      line[x * 4 + 1] = Math.min(255, Math.floor(g * scale));
      line[x * 4 + 2] = Math.min(255, Math.floor(b * scale));
      line[x * 4 + 3] = e + 128;
    }
    if (!rle) { bytes.push(...line); continue; }
    bytes.push(2, 2, (width >> 8) & 0xff, width & 0xff);
    for (let c = 0; c < 4; c++) {
      let x = 0;
      while (x < width) {
        // a run where the value repeats, a literal otherwise
        let run = 1;
        while (x + run < width && run < 127 && line[(x + run) * 4 + c] === line[x * 4 + c]) run++;
        if (run >= 3) { bytes.push(128 + run, line[x * 4 + c]); x += run; continue; }
        let lit = 1;
        while (x + lit < width && lit < 128 && !(x + lit + 2 < width && line[(x + lit) * 4 + c] === line[(x + lit + 1) * 4 + c] && line[(x + lit) * 4 + c] === line[(x + lit + 2) * 4 + c])) lit++;
        bytes.push(lit);
        for (let k = 0; k < lit; k++) bytes.push(line[(x + k) * 4 + c]);
        x += lit;
      }
    }
  }
  return new Uint8Array(bytes).buffer;
}

describe('parseHdr', () => {
  const probe = (x: number, y: number): [number, number, number] => [0.5 + x * 0.1, 2 * (y + 1), x === 5 ? 40 : 0.01];

  it('decodes a run-length file to within the format\'s own precision', () => {
    const img = parseHdr(encodeHdr(16, 4, probe));
    expect(img.width).toBe(16);
    expect(img.height).toBe(4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 16; x++) {
        const want = probe(x, y);
        const o = (y * 16 + x) * 4;
        for (let c = 0; c < 3; c++) {
          const got = img.data[o + c];
          const scale = Math.max(...want);
          expect(Math.abs(got - want[c])).toBeLessThanOrEqual(scale / 128);
        }
        expect(img.data[o + 3]).toBe(1);
      }
    }
  });

  it('decodes a flat file too', () => {
    const img = parseHdr(encodeHdr(4, 2, probe, false));
    expect(img.data[0]).toBeCloseTo(0.5, 1);
  });

  it('refuses something that is not Radiance', () => {
    expect(() => parseHdr(new TextEncoder().encode('PNG\n').buffer)).toThrow(/not a Radiance/);
  });

  it('mean radiance weights the rows by the sphere they cover', () => {
    // bright only at the poles: they cover little of the sphere
    const polar = parseHdr(encodeHdr(8, 8, (_, y) => (y === 0 || y === 7 ? [10, 10, 10] : [1, 1, 1])));
    expect(meanRadiance(polar)).toBeLessThan(3);
    expect(meanRadiance(polar)).toBeGreaterThan(1);
  });
});

describe('inverseTonemap', () => {
  it('brings a page colour back to itself through AgX', () => {
    for (const rgb of [[0.043, 0.047, 0.055], [0.5, 0.5, 0.5], [0.8, 0.6, 0.3], [0.1, 0.3, 0.6]] as [number, number, number][]) {
      const linear = inverseTonemap(rgb, 1);
      const back = agxJs(linear);
      const srgb = back.map((v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
      for (let k = 0; k < 3; k++) expect(srgb[k]).toBeCloseTo(rgb[k], 2);
    }
  });

  it('and through the ACES fit', () => {
    const linear = inverseTonemap([0.5, 0.5, 0.5], 0);
    const aces = (x: number) => { const a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14; return (x * (a * x + b)) / (x * (c * x + d) + e); };
    const srgb = 1.055 * Math.pow(aces(linear[0]), 1 / 2.4) - 0.055;
    expect(srgb).toBeCloseTo(0.5, 2);
  });
});
