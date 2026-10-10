/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import leafAlpha from './fixtures/leaf-alpha-256.b64?raw';
import { CARD_COVERAGE_SPLICES, CARD_CUT, CARD_SPLICES, DEPTH_CUT_SPLICES, cardLevels, checkCards, coverage, coverageAlpha, downsample } from '../cards';
import { TEXTURE_LAYERS_MOST, TEXTURE_SIDE_MOST } from '../texture';
import { DEPTH_CUT_WGSL, DEPTH_WGSL, sceneSource, sceneWith } from '../shaders';

const sq = (n: number) => ({ width: n, height: n });

describe('checkCards refuses what cannot be a card array, by name', () => {
  it('accepts a good set and says its side', () => {
    expect(checkCards([sq(256)])).toBe(256);
    expect(checkCards([sq(64), sq(64), sq(64)])).toBe(64);
    expect(checkCards(Array.from({ length: TEXTURE_LAYERS_MOST }, () => sq(TEXTURE_SIDE_MOST)))).toBe(TEXTURE_SIDE_MOST);
  });
  it('refuses none, and null', () => {
    expect(() => checkCards([])).toThrow(/setCardImages: no layers/);
    expect(() => checkCards(null)).toThrow(/setCardImages: no layers/);
  });
  it('refuses more than eight', () => {
    expect(() => checkCards(Array.from({ length: 9 }, () => sq(16)))).toThrow(/setCardImages: 9 layers, and at most 8/);
  });
  it('refuses a layer that is not square', () => {
    expect(() => checkCards([sq(64), { width: 64, height: 32 }])).toThrow(/layer 1 is 64 by 32, and a layer must be square/);
  });
  it('refuses a side that is not a power of two', () => {
    expect(() => checkCards([sq(100)])).toThrow(/100 across, and a layer must be a power of two/);
  });
  it('refuses a side over 1024', () => {
    expect(() => checkCards([sq(2048)])).toThrow(/2048 across, and at most 1024/);
  });
  it('refuses mixed sizes', () => {
    expect(() => checkCards([sq(64), sq(128)])).toThrow(/layer 1 is 128 across and layer 0 is 64, and every layer must be the same size/);
  });
});

/**
 * A disc filling most of a square: alpha 255 inside, 0 outside, with an anti-aliased edge a texel wide. Its middle is a
 * little off the square's, as a drawn leaf's is: a disc dead in the middle has its texels in fours and eights, and at
 * eight texels a side its coverage moves in steps of six per cent that no scale can land between.
 */
function disc(side: number): Uint8Array {
  const a = new Uint8Array(side * side);
  const cx = (side - 1) / 2 + side * 0.013, cy = (side - 1) / 2 - side * 0.007, r = side * 0.42;
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) a[y * side + x] = Math.round(255 * Math.min(1, Math.max(0, r - Math.hypot(x - cx, y - cy) + 0.5)));
  return a;
}
/**
 * The real leaf card of the kit's Tree (CC0, Quaternius; the image `Leaves_NormalTree_C.png`), its alpha box-filtered
 * from 1024 to 256 by 256 and kept as base64 text, which node reads without a plugin or a node type.
 */
const LEAF = Uint8Array.from(atob(leafAlpha.trim()), (c) => c.charCodeAt(0));

/** The share over `cut` at each of `levels` mips, scaled to keep the top's share (or by 1 where `keep` is false). */
function chain(top: Uint8Array, side: number, cut: number, levels: number, keep: boolean): number[] {
  const target = coverage(top, cut);
  const out = [target];
  let level = top, s = side;
  for (let k = 1; k < levels; k++) {
    level = downsample(level, s);
    s >>= 1;
    const scale = keep ? coverageAlpha(level, cut, target) : 1;
    out.push(coverage(level, cut, scale));
  }
  return out;
}

describe('coverage-preserving mips', () => {
  it('downsample is a box filter that halves the side', () => {
    const a = Uint8Array.from([0, 100, 200, 255, 10, 20, 30, 40, 0, 0, 0, 0, 255, 255, 255, 255]);
    expect(Array.from(downsample(a, 4))).toEqual([Math.round((0 + 100 + 10 + 20) / 4), Math.round((200 + 255 + 30 + 40) / 4), 128, 128]);
  });
  it('knows a float alpha from a byte one', () => {
    const f = Float32Array.from([0, 1, 1, 0]), b = Uint8Array.from([0, 255, 255, 0]);
    expect(coverage(f, 0.5)).toBe(0.5);
    expect(coverage(b, 0.5)).toBe(0.5);
  });
  it('keeps a disc within 2% of its top level over six mips', () => {
    const shares = chain(disc(256), 256, 0.5, 6, true);
    for (const s of shares) expect(Math.abs(s - shares[0])).toBeLessThan(0.02);
  });
  it('keeps the real leaf within 2% of its top level over six mips', () => {
    expect(LEAF.length).toBe(256 * 256);
    const shares = chain(LEAF, 256, 0.5, 6, true);
    expect(shares[0]).toBeGreaterThan(0.1);
    for (const s of shares) expect(Math.abs(s - shares[0])).toBeLessThan(0.02);
  });
  it('holds at another cut, and for a float alpha', () => {
    const f = Float32Array.from(LEAF, (v) => v / 255);
    const target = coverage(f, 0.3);
    let level: Float32Array = f, side = 256;
    for (let k = 1; k < 6; k++) {
      level = downsample(level, side) as Float32Array;
      side >>= 1;
      expect(Math.abs(coverage(level, 0.3, coverageAlpha(level, 0.3, target)) - target)).toBeLessThan(0.02);
    }
  });
  it('without the scale the leaf thins by more than 2% by the fifth mip, which is what the scale is for', () => {
    const shares = chain(LEAF, 256, 0.5, 6, false);
    expect(shares[0] - shares[5]).toBeGreaterThan(0.02);
  });
  it('is one where nothing needs scaling, and never asks for more than it can get', () => {
    const d = disc(64), share = coverage(d, 0.5);
    expect(coverage(d, 0.5, coverageAlpha(d, 0.5, share))).toBe(share);
    expect(coverageAlpha(d, 0.5, share)).toBeLessThanOrEqual(1);
    expect(coverageAlpha(new Uint8Array(64), 0.5, 0.5)).toBe(1);
  });
});

describe('cardLevels, the chain the renderer writes', () => {
  /** An rgba image of white whose alpha is `alpha`. */
  const rgba = (alpha: Uint8Array) => {
    const out = new Uint8Array(alpha.length * 4).fill(255);
    alpha.forEach((a, i) => { out[i * 4 + 3] = a; });
    return out;
  };
  const alphaOf = (level: Uint8Array) => Uint8Array.from({ length: level.length / 4 }, (_, i) => level[i * 4 + 3]);

  it('has a level to a single texel, each half the side, and the top as it was handed in', () => {
    const top = rgba(LEAF);
    const levels = cardLevels(top, 256);
    expect(levels.length).toBe(9);
    levels.forEach((l, k) => expect(l.length).toBe((256 >> k) ** 2 * 4));
    expect(levels[0]).toBe(top);
  });
  it('keeps the real leaf within 2% of its top level at every level down to the sixth', () => {
    const levels = cardLevels(rgba(LEAF), 256);
    const measure = (k: number) => coverage(alphaOf(levels[k]), CARD_CUT);
    const target = measure(0);
    expect(target).toBeGreaterThan(0.1);
    for (let k = 1; k < 6; k++) expect(Math.abs(measure(k) - target), `level ${k}`).toBeLessThan(0.02);
  });
  it('thins a mask of fine features without the scale, and not with it', () => {
    // single texels set at random, one in eight: a box filter takes each to a quarter, under the cut
    const dots = new Uint8Array(64 * 64);
    let seed = 7;
    for (let i = 0; i < dots.length; i++) dots[i] = ((seed = (seed * 1664525 + 1013904223) >>> 0) >>> 29) === 0 ? 255 : 0;
    const levels = cardLevels(rgba(dots), 64);
    const target = coverage(dots, CARD_CUT);
    expect(target).toBeGreaterThan(0.08);
    expect(coverage(downsample(dots, 64), CARD_CUT), 'the plain box chain has lost a good part of it').toBeLessThan(target * 0.7);
    // the dots are all alike, so coverage moves in a few big steps as the scale rises, and the nearer is taken
    expect(Math.abs(coverage(alphaOf(levels[1]), CARD_CUT) - target)).toBeLessThan(0.06);
  });
  it('box-filters the colour as the blit does, and only scales the alpha, clamped at one', () => {
    const top = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) { top[i * 4] = i * 10; top[i * 4 + 1] = 200; top[i * 4 + 2] = 5; top[i * 4 + 3] = i % 2 ? 255 : 0; }
    const [, one] = cardLevels(top, 4);
    const mean = (ch: number, x: number, y: number) => Math.round((top[(y * 8 + x * 2) * 4 + ch] + top[(y * 8 + x * 2 + 1) * 4 + ch] + top[(y * 8 + 4 + x * 2) * 4 + ch] + top[(y * 8 + 4 + x * 2 + 1) * 4 + ch]) / 4);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
      expect(one[(y * 2 + x) * 4]).toBe(mean(0, x, y));
      expect(one[(y * 2 + x) * 4 + 1]).toBe(200);
      expect(one[(y * 2 + x) * 4 + 3]).toBeLessThanOrEqual(255);
    }
  });
  it('is the top alone for one texel, and handles an image with no alpha to keep', () => {
    expect(cardLevels(new Uint8Array([1, 2, 3, 4]), 1).length).toBe(1);
    const clear = cardLevels(new Uint8Array(4 * 4 * 4), 4);
    for (const l of clear) expect(Array.from(alphaOf(l)).every((a) => a === 0)).toBe(true);
  });
});

describe('the carded build', () => {
  const words = ['CARDED', 'front_facing', 'discard', 'cardImages', 'cardSampler'];
  it('is in no build that is not carded, nor in the flowing or textured ones', () => {
    for (const toon of [false, true])
      for (const shadows of [false, true])
        for (const patterned of [false, true])
          for (const flowing of [false, true])
            for (const textured of [false, true]) {
              if (flowing && textured) continue;
              const text = sceneSource({ toon, shadows, patterned, flowing, textured });
              for (const w of words) expect(text, `${w} in a build that is not carded`).not.toContain(w);
            }
    for (const w of words) expect(DEPTH_WGSL).not.toContain(w);
  });
  it('has every splice, and the constant', () => {
    const text = sceneSource({ carded: true });
    expect(text).toContain('const CARDED: bool = true;');
    for (const s of Object.values(CARD_SPLICES)) expect(text).toContain(s.to);
    for (const w of ['front_facing', 'discard', 'cardImages', 'cardSampler']) expect(text).toContain(w);
  });
  it('reads the card in uniform control flow, before it discards or branches', () => {
    const text = sceneSource({ carded: true });
    const fs = text.slice(text.indexOf('@fragment fn fsMain'));
    expect(fs.indexOf('textureSample(cardImages')).toBeGreaterThan(0);
    expect(fs.indexOf('textureSample(cardImages')).toBeLessThan(fs.indexOf('discard'));
    expect(fs.indexOf('discard')).toBeLessThan(fs.indexOf('if (PATTERNED)'));
  });
  it('turns the normal of a back face', () => {
    expect(sceneSource({ carded: true })).toMatch(/select\(-normalize\(in\.normal\), normalize\(in\.normal\), front\)/);
  });
  it('is the other builds with the splices put in, and nothing else changed', () => {
    for (const toon of [false, true]) for (const shadows of [false, true]) {
      let plain = sceneSource({ toon, shadows, patterned: false });
      for (const s of Object.values(CARD_SPLICES)) plain = plain.replace(s.from, () => s.to);
      expect(sceneSource({ toon, shadows, carded: true }).replace('const CARDED: bool = true;\n', '')).toBe(plain);
    }
  });
  it('is exclusive with the flowing and textured builds, by name', () => {
    expect(() => sceneSource({ carded: true, flowing: true })).toThrow(/carded build cannot also be the flowing build/);
    expect(() => sceneSource({ carded: true, textured: true })).toThrow(/carded build cannot also be the textured build/);
  });
  it('needs a vertex stage that has the card to give it', () => {
    expect(() => sceneWith('@vertex fn vsMain() {}', { carded: true })).toThrow(/carded build/);
  });
  it('has a depth shader that discards under the cut', () => {
    for (const s of Object.values(DEPTH_CUT_SPLICES)) expect(DEPTH_CUT_WGSL).toContain(s.to);
    expect(DEPTH_CUT_WGSL).toContain('discard');
    expect(DEPTH_CUT_WGSL).toContain('@location(2) uv: vec2f');
  });
});

describe('the carded build at four samples, for alpha to coverage', () => {
  const text = (extra = {}) => sceneSource({ carded: true, coverage: true, ...extra });
  const fs = (t: string) => t.slice(t.indexOf('@fragment fn fsMain'));
  it('throws nothing away, and puts the sharpened coverage out as the alpha', () => {
    for (const toon of [false, true]) {
      const t = text({ toon });
      expect(t).toContain('const CARDED: bool = true;');
      expect(fs(t)).not.toContain('discard');
      for (const s of Object.values(CARD_COVERAGE_SPLICES)) expect(t).toContain(s.to);
      expect(t).toContain('cardCover');
      expect(t).toContain('fwidth(cardAlpha)');
      expect(t).toMatch(/return vec4f\(finite\(colour \* frame\.exposure\), cardCover\);/);
      expect(t).not.toMatch(/frame\.exposure\), 1\.0\)/);
    }
  });
  it('reads the card and its derivatives before any branch, and turns the normal of a back face', () => {
    const f = fs(text());
    expect(f.indexOf('textureSampleLevel(cardImages')).toBeGreaterThan(0);
    expect(f.indexOf('fwidth(cardAlpha)')).toBeGreaterThan(f.indexOf('textureSampleLevel(cardImages'));
    expect(f.indexOf('fwidth(cardAlpha)')).toBeLessThan(f.indexOf('if (PATTERNED)'));
    expect(f.slice(0, f.indexOf('fwidth(cardAlpha)'))).not.toMatch(/\bif\b/);
    expect(f).toMatch(/select\(-normalize\(in\.normal\), normalize\(in\.normal\), front\)/);
  });
  it('is a different text from the one-sample carded build, which keeps its discard', () => {
    expect(text()).not.toBe(sceneSource({ carded: true }));
    expect(fs(sceneSource({ carded: true }))).toContain('discard');
    expect(sceneSource({ carded: true })).not.toContain('cardCover');
  });
  it('is not a build of anything that is not a card, by name; and the others are the text they were', () => {
    expect(() => sceneSource({ coverage: true })).toThrow(/coverage build is a carded build/);
    expect(sceneSource({ coverage: false, toon: true })).toBe(sceneSource({ toon: true }));
    expect(sceneSource({ carded: true, coverage: false })).toBe(sceneSource({ carded: true }));
  });
  it('leaves the depth shader\'s discard as it was', () => {
    expect(DEPTH_CUT_WGSL).toContain('discard');
    expect(DEPTH_CUT_WGSL).not.toContain('cardCover');
  });
});
