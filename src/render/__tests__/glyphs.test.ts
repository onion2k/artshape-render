import { describe, expect, it } from 'vitest';
import {
  CELL, distanceField, GlyphAtlas, layout, RUNES, transliterate, type GlyphKey, type Rasteriser,
} from '../glyphs';

/** Draws every glyph as a filled square in the middle of the cell, advance 0.6 em. */
class SquareRasteriser implements Rasteriser {
  drawn: string[] = [];
  draw(key: GlyphKey, cellPx: number) {
    this.drawn.push(key.kind === 'char' ? key.char : key.rune);
    const coverage = new Uint8Array(cellPx * cellPx);
    for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) coverage[y * cellPx + x] = 255;
    return { coverage, advance: 0.6 };
  }
}

describe('distanceField', () => {
  it('is above half inside the shape, below outside, and half on the edge', () => {
    const size = 32;
    const cov = new Uint8Array(size * size);
    for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) cov[y * size + x] = 255;
    const f = distanceField(cov, size, 6);
    expect(f[16 * size + 16]).toBe(255);          // deep inside: saturated
    expect(f[2 * size + 2]).toBe(0);              // far outside: saturated
    expect(f[16 * size + 8]).toBeGreaterThan(128); // just inside the left edge
    expect(f[16 * size + 7]).toBeLessThan(128);    // just outside it
    // one pixel in from the edge is one sixth of the way to saturation
    expect(Math.abs(f[16 * size + 9] - Math.round(255 * (0.5 + 0.5 * (1 / 6))))).toBeLessThanOrEqual(22);
  });

  it('falls off linearly with distance until it saturates', () => {
    const size = 32;
    const cov = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < 16; x++) cov[y * size + x] = 255;
    const f = distanceField(cov, size, 8);
    const row = 16 * size;
    for (let x = 16; x < 23; x++) expect(f[row + x]).toBeGreaterThan(f[row + x + 1]);
    expect(f[row + 30]).toBe(0);
  });
});

describe('GlyphAtlas', () => {
  it('rasterises each glyph once and hands back its cell', () => {
    const r = new SquareRasteriser();
    const atlas = new GlyphAtlas(r);
    const a: GlyphKey = { kind: 'char', char: 'A', font: 'serif' };
    atlas.ensure([a, a, { kind: 'rune', rune: 'f' }]);
    expect(r.drawn).toEqual(['A', 'f']);
    const rect = atlas.rect(a)!;
    expect(rect.u0).toBe(0);
    expect(rect.u1).toBeCloseTo(1 / atlas.columns);
    expect(rect.advance).toBe(0.6);
    expect(atlas.rect({ kind: 'char', char: 'A', font: 'sans' })).toBeUndefined();
  });

  it('writes the field into the right cell and marks itself dirty', () => {
    const atlas = new GlyphAtlas(new SquareRasteriser());
    expect(atlas.dirty).toBe(false);
    atlas.ensure([{ kind: 'char', char: 'B', font: 'serif' }, { kind: 'char', char: 'C', font: 'serif' }]);
    expect(atlas.dirty).toBe(true);
    // the second cell's centre is the square's inside
    const cx = CELL.px + 32, cy = 32;
    expect(atlas.pixels[cy * atlas.width + cx]).toBe(255);
    // and the corner of the cell is far outside
    expect(atlas.pixels[2 * atlas.width + CELL.px + 2]).toBe(0);
  });

  it('grows when full, keeping every earlier cell where it was', () => {
    const atlas = new GlyphAtlas(new SquareRasteriser(), 2, 1);
    const keys: GlyphKey[] = ['A', 'B', 'C'].map((c) => ({ kind: 'char', char: c, font: 'serif' }));
    atlas.ensure(keys.slice(0, 2));
    const before = atlas.rect(keys[0])!;
    const pixel = atlas.pixels[32 * atlas.width + 32];
    atlas.ensure([keys[2]]);
    expect(atlas.rows).toBe(2);
    expect(atlas.count).toBe(3);
    const after = atlas.rect(keys[0])!;
    expect(after.u0).toBe(before.u0);
    expect(after.v0).toBe(0);
    expect(atlas.pixels[32 * atlas.width + 32]).toBe(pixel);
    expect(atlas.rect(keys[2])!.v0).toBeCloseTo(0.5);
  });
});

describe('transliterate', () => {
  it('takes digraphs before letters and substitutes what the futhark lacks', () => {
    expect(transliterate('thing')).toEqual(['th', 'i', 'ng']);
    expect(transliterate('cave')).toEqual(['k', 'a', 'w', 'e']);
    expect(transliterate('ax y')).toEqual(['a', 'k', 's', ' ', 'ei']);
  });

  it('drops what it cannot spell', () => {
    expect(transliterate('a1!b')).toEqual(['a', 'b']);
  });

  it('has a stroke table for every rune it can produce', () => {
    for (const r of transliterate('abcdefghijklmnopqrstuvwxyz thing')) {
      if (r !== ' ') expect(RUNES[r], r).toBeDefined();
    }
    for (const strokes of Object.values(RUNES)) {
      for (const s of strokes) for (const v of s) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    }
  });
});

describe('layout', () => {
  it('advances the pen by each glyph and by a gap for a space', () => {
    const atlas = new GlyphAtlas(new SquareRasteriser());
    const k = (c: string): GlyphKey => ({ kind: 'char', char: c, font: 'serif' });
    const line = layout(atlas, [k('A'), k('B'), ' ', k('C')]);
    expect(line.glyphs.length).toBe(3);
    expect(line.width).toBeCloseTo(0.6 * 3 + 0.3);
    expect(line.glyphs[1].x0).toBeCloseTo(0.6 - CELL.originX / CELL.fontPx);
    expect(line.glyphs[2].x0).toBeCloseTo(1.5 - CELL.originX / CELL.fontPx);
    // every cell box is the same size, with the baseline inside it
    for (const g of line.glyphs) {
      expect(g.x1 - g.x0).toBeCloseTo(CELL.px / CELL.fontPx);
      expect(g.y0).toBeLessThan(0);
      expect(g.y1).toBeGreaterThan(1);
    }
  });
});
