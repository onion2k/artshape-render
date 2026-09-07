/**
 * A signed-distance atlas of glyphs, for cutting lettering into a surface.
 *
 * Each glyph is drawn once into a square cell — a character in a font, or a
 * rune from the stroke table below — and turned into a signed distance field,
 * so the shader can read how far a pixel is from the letter's edge and bevel
 * the cut there, at any size, with no more than a bilinear lookup. Cells are
 * all one size, which makes packing a grid and lookup arithmetic.
 *
 * The drawing is done by a `Rasteriser` so the atlas itself has no canvas in
 * it: the browser one uses a 2D context, and tests hand in a fake.
 */

export type Font = 'serif' | 'sans' | 'mono';

/** What identifies one cell: a character in a font, or a rune by its Latin name. */
export type GlyphKey = { kind: 'char'; char: string; font: Font } | { kind: 'rune'; rune: string };

export const keyOf = (k: GlyphKey) => (k.kind === 'char' ? `${k.font}:${k.char}` : `rune:${k.rune}`);

/** Coverage of a glyph drawn into a cell, and how far the pen moves after it. */
export interface Raster {
  /** cellPx * cellPx bytes, 255 inside the letter. */
  coverage: Uint8Array;
  /** Pen advance in em (fractions of the font size). */
  advance: number;
}

export interface Rasteriser {
  draw(key: GlyphKey, cellPx: number, fontPx: number): Raster;
}

/** Layout of one cell: where the glyph's origin sits and how far it may reach, all in em. */
export const CELL = {
  px: 64,
  fontPx: 40,
  /** the pen origin (baseline, left) inside the cell, in px */
  originX: 12,
  originY: 48,
  /** distance beyond which the field saturates, in px */
  spread: 8,
};

export interface GlyphRect {
  /** Atlas texture coordinates of the cell, 0..1. */
  u0: number; v0: number; u1: number; v1: number;
  /** Pen advance in em. */
  advance: number;
}

export class GlyphAtlas {
  private cells = new Map<string, { index: number; advance: number }>();
  private data: Uint8Array;
  columns: number;
  rows: number;
  /** Set when the pixel data changed since it was last uploaded. */
  dirty = false;

  constructor(private rasteriser: Rasteriser, columns = 16, rows = 4) {
    this.columns = columns;
    this.rows = rows;
    this.data = new Uint8Array(columns * CELL.px * rows * CELL.px).fill(0);
  }

  get width() { return this.columns * CELL.px; }
  get height() { return this.rows * CELL.px; }
  get pixels(): Uint8Array { return this.data; }
  get count() { return this.cells.size; }

  /** Make sure every key has a cell, growing the atlas when it is full. */
  ensure(keys: GlyphKey[]) {
    for (const key of keys) {
      const id = keyOf(key);
      if (this.cells.has(id)) continue;
      const index = this.cells.size;
      if (index >= this.columns * this.rows) this.grow();
      const raster = this.rasteriser.draw(key, CELL.px, CELL.fontPx);
      const field = distanceField(raster.coverage, CELL.px, CELL.spread);
      this.blit(field, index);
      this.cells.set(id, { index, advance: raster.advance });
      this.dirty = true;
    }
  }

  rect(key: GlyphKey): GlyphRect | undefined {
    const cell = this.cells.get(keyOf(key));
    if (!cell) return undefined;
    const col = cell.index % this.columns;
    const row = Math.floor(cell.index / this.columns);
    return {
      u0: col / this.columns, v0: row / this.rows,
      u1: (col + 1) / this.columns, v1: (row + 1) / this.rows,
      advance: cell.advance,
    };
  }

  private blit(field: Uint8Array, index: number) {
    const col = index % this.columns;
    const row = Math.floor(index / this.columns);
    const w = this.width;
    for (let y = 0; y < CELL.px; y++) {
      const src = y * CELL.px;
      const dst = (row * CELL.px + y) * w + col * CELL.px;
      this.data.set(field.subarray(src, src + CELL.px), dst);
    }
  }

  /** Double the row count, keeping every cell where it was. */
  private grow() {
    const old = this.data;
    const oldRows = this.rows;
    this.rows *= 2;
    this.data = new Uint8Array(this.width * this.height).fill(0);
    this.data.set(old.subarray(0, this.width * oldRows * CELL.px));
  }
}

/**
 * Signed distance to the coverage edge, encoded 0..255 with 128 on the edge
 * and the field saturating `spread` pixels either side. Inside is above 128.
 *
 * Exact Euclidean transform, one pass per axis (Felzenszwalb and
 * Huttenlocher), run once from the inside and once from the outside.
 */
export function distanceField(coverage: Uint8Array, size: number, spread: number): Uint8Array {
  const inside = new Float64Array(size * size);
  const outside = new Float64Array(size * size);
  const FAR = 1e12;
  for (let i = 0; i < size * size; i++) {
    const on = coverage[i] >= 128;
    inside[i] = on ? 0 : FAR;
    outside[i] = on ? FAR : 0;
  }
  edt2d(inside, size);
  edt2d(outside, size);
  const out = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) {
    // distance is positive outside the letter; the half-pixel keeps the edge
    // on the edge rather than a half-pixel into the paper
    const d = Math.sqrt(inside[i]) - Math.sqrt(outside[i]);
    const v = 0.5 - 0.5 * Math.max(-1, Math.min(1, d / spread));
    out[i] = Math.round(v * 255);
  }
  return out;
}

/** Squared Euclidean distance transform of a grid of 0 / FAR, in place. */
function edt2d(f: Float64Array, size: number) {
  const line = new Float64Array(size);
  const d = new Float64Array(size);
  const v = new Int32Array(size);
  const z = new Float64Array(size + 1);
  const edt1d = () => {
    let k = 0;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < size; q++) {
      let s = ((line[q] + q * q) - (line[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((line[q] + q * q) - (line[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < size; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + line[v[k]];
    }
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) line[x] = f[y * size + x];
    edt1d();
    for (let x = 0; x < size; x++) f[y * size + x] = d[x];
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) line[y] = f[y * size + x];
    edt1d();
    for (let y = 0; y < size; y++) f[y * size + x] = d[y];
  }
}

/*
 * Elder Futhark, as strokes in a unit box (x right, y up), and the Latin
 * letters that stand for each. Runes are straight lines by nature — they
 * were cut across the grain of wood — so a stroke table draws them exactly,
 * whatever fonts the machine has.
 */
type Stroke = [number, number, number, number];
export const RUNES: Record<string, Stroke[]> = {
  f: [[0.3, 0, 0.3, 1], [0.3, 0.7, 0.7, 0.9], [0.3, 0.5, 0.7, 0.7]],
  u: [[0.25, 0, 0.25, 1], [0.25, 1, 0.7, 0.62], [0.7, 0.62, 0.7, 0]],
  th: [[0.3, 0, 0.3, 1], [0.3, 0.78, 0.7, 0.55], [0.7, 0.55, 0.3, 0.32]],
  a: [[0.3, 0, 0.3, 1], [0.3, 1, 0.72, 0.8], [0.3, 0.78, 0.72, 0.58]],
  r: [[0.3, 0, 0.3, 1], [0.3, 1, 0.7, 0.8], [0.7, 0.8, 0.3, 0.55], [0.3, 0.55, 0.72, 0]],
  k: [[0.7, 1, 0.3, 0.5], [0.3, 0.5, 0.7, 0]],
  g: [[0.2, 0.15, 0.8, 0.85], [0.2, 0.85, 0.8, 0.15]],
  w: [[0.3, 0, 0.3, 1], [0.3, 1, 0.7, 0.8], [0.7, 0.8, 0.3, 0.55]],
  h: [[0.25, 0, 0.25, 1], [0.75, 0, 0.75, 1], [0.25, 0.65, 0.75, 0.35]],
  n: [[0.5, 0, 0.5, 1], [0.25, 0.7, 0.75, 0.3]],
  i: [[0.5, 0, 0.5, 1]],
  j: [[0.3, 0.9, 0.55, 0.65], [0.55, 0.65, 0.3, 0.4], [0.7, 0.1, 0.45, 0.35], [0.45, 0.35, 0.7, 0.6]],
  ei: [[0.5, 0, 0.5, 1], [0.5, 1, 0.75, 0.82], [0.5, 0, 0.25, 0.18]],
  p: [[0.3, 0, 0.3, 1], [0.3, 1, 0.65, 0.8], [0.65, 0.8, 0.65, 0.2], [0.65, 0.2, 0.3, 0]],
  z: [[0.5, 0, 0.5, 1], [0.5, 0.62, 0.2, 0.92], [0.5, 0.62, 0.8, 0.92]],
  s: [[0.7, 1, 0.35, 0.66], [0.35, 0.66, 0.65, 0.34], [0.65, 0.34, 0.3, 0]],
  t: [[0.5, 0, 0.5, 1], [0.5, 1, 0.2, 0.76], [0.5, 1, 0.8, 0.76]],
  b: [[0.3, 0, 0.3, 1], [0.3, 1, 0.66, 0.78], [0.66, 0.78, 0.3, 0.52], [0.3, 0.52, 0.66, 0.26], [0.66, 0.26, 0.3, 0]],
  e: [[0.25, 0, 0.25, 1], [0.75, 0, 0.75, 1], [0.25, 1, 0.5, 0.75], [0.5, 0.75, 0.75, 1]],
  m: [[0.25, 0, 0.25, 1], [0.75, 0, 0.75, 1], [0.25, 1, 0.75, 0.5], [0.75, 1, 0.25, 0.5]],
  l: [[0.4, 0, 0.4, 1], [0.4, 1, 0.76, 0.74]],
  ng: [[0.5, 0.78, 0.72, 0.5], [0.72, 0.5, 0.5, 0.22], [0.5, 0.22, 0.28, 0.5], [0.28, 0.5, 0.5, 0.78]],
  d: [[0.25, 0, 0.25, 1], [0.75, 0, 0.75, 1], [0.25, 1, 0.75, 0], [0.25, 0, 0.75, 1]],
  o: [[0.5, 1, 0.75, 0.75], [0.75, 0.75, 0.5, 0.5], [0.5, 0.5, 0.25, 0.75], [0.25, 0.75, 0.5, 1], [0.42, 0.58, 0.22, 0], [0.58, 0.58, 0.78, 0]],
};

/** Spell Latin text in runes: digraphs first, then letters; unknown ones are dropped and spaces kept. */
export function transliterate(text: string): (string | ' ')[] {
  const out: (string | ' ')[] = [];
  const s = text.toLowerCase();
  const substitute: Record<string, string> = { c: 'k', q: 'k', v: 'w', y: 'ei', x: 'ks' };
  let i = 0;
  while (i < s.length) {
    const two = s.slice(i, i + 2);
    if (RUNES[two]) { out.push(two); i += 2; continue; }
    const ch = s[i];
    if (ch === ' ') out.push(' ');
    else if (RUNES[ch]) out.push(ch);
    else if (substitute[ch]) {
      const sub = substitute[ch];
      if (sub === 'ks') out.push('k', 's');
      else out.push(sub);
    }
    i++;
  }
  return out;
}

/** The browser's rasteriser: fonts through fillText, runes through stroked lines. */
export class CanvasRasteriser implements Rasteriser {
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

  constructor() {
    this.canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(CELL.px, CELL.px)
      : document.createElement('canvas');
    this.canvas.width = CELL.px;
    this.canvas.height = CELL.px;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  }

  draw(key: GlyphKey, cellPx: number, fontPx: number): Raster {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, cellPx, cellPx);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    let advance: number;
    if (key.kind === 'char') {
      ctx.font = `${fontPx}px ${FAMILIES[key.font]}`;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.fillText(key.char, CELL.originX, CELL.originY);
      advance = ctx.measureText(key.char).width / fontPx;
    } else {
      const strokes = RUNES[key.rune] ?? [];
      ctx.lineWidth = fontPx * 0.11;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      // a rune stands a full em tall on the baseline, and 0.7 em wide
      const w = fontPx * 0.7, h = fontPx;
      for (const [x0, y0, x1, y1] of strokes) {
        ctx.moveTo(CELL.originX + x0 * w, CELL.originY - y0 * h);
        ctx.lineTo(CELL.originX + x1 * w, CELL.originY - y1 * h);
      }
      ctx.stroke();
      advance = 0.85;
    }
    const img = ctx.getImageData(0, 0, cellPx, cellPx).data;
    const coverage = new Uint8Array(cellPx * cellPx);
    for (let i = 0; i < coverage.length; i++) coverage[i] = img[i * 4 + 3];
    return { coverage, advance };
  }
}

const FAMILIES: Record<Font, string> = {
  serif: 'Georgia, "Times New Roman", "Hiragino Mincho ProN", serif',
  sans: '"Helvetica Neue", Helvetica, Arial, "Hiragino Sans", sans-serif',
  mono: 'Menlo, Consolas, "Courier New", monospace',
};

/**
 * Lay a string out along a baseline: one placed cell per glyph, in em from
 * the pen's start, so the caller can scale to millimetres. Runes come as
 * their names; characters as themselves.
 */
export interface PlacedGlyph {
  key: GlyphKey;
  /** The cell's box in em, relative to the line's start, y up. */
  x0: number; y0: number; x1: number; y1: number;
  /** Where in the cell's box the atlas cell maps: identical for every glyph, kept for the shader. */
  rect: GlyphRect;
}

export function layout(atlas: GlyphAtlas, keys: (GlyphKey | ' ')[]): { glyphs: PlacedGlyph[]; width: number } {
  atlas.ensure(keys.filter((k): k is GlyphKey => k !== ' '));
  const glyphs: PlacedGlyph[] = [];
  let pen = 0;
  const em = CELL.fontPx;
  for (const key of keys) {
    if (key === ' ') { pen += 0.3; continue; }
    const rect = atlas.rect(key)!;
    // the cell's box in em: the origin sits originX px in and originY px down
    glyphs.push({
      key,
      x0: pen - CELL.originX / em,
      x1: pen + (CELL.px - CELL.originX) / em,
      y0: -(CELL.px - CELL.originY) / em,
      y1: CELL.originY / em,
      rect,
    });
    pen += rect.advance;
  }
  return { glyphs, width: pen };
}
