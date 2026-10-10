/**
 * Cut-out cards: a flat piece of mesh (a leaf, a flower, a blade of weed) whose uvs pick a texel from one layer of the
 * renderer's card images, and whose fragments are thrown away where that texel's alpha is under a cut. A tree of a few
 * hundred cards is then a tree, where a tree of a few hundred opaque squares is a pile of tiles.
 *
 * This file holds what is only the cards' and needs no device: the refusals by name of a set of images that cannot be
 * the array, the scale that keeps a mip level's coverage equal to the top level's (or the leaves thin to nothing at a
 * distance, which is the first thing seen of a card tree that has none), and the pieces of WGSL spliced into the scene
 * shader and the depth shader for the carded builds alone. Every other build is the text it was, to the byte, and a game
 * that sets no card image compiles none of it. The shadow and occlusion depth shader is made from these pieces in
 * `shaders.ts` (`DEPTH_CUT_WGSL`), because it is `DEPTH_WGSL` with them put in and this file does not import that one.
 *
 * Which layer a group wears, and its cut, ride in an instance buffer of their own at location 11: two floats, the
 * layer counted from one and the cut. A group has one image, so every placement carries the same two, and the renderer
 * writes the pair for each placement all the same, rather than bind one with an array stride of nought. The location is the
 * one the ground texture's four floats use; the two builds are exclusive, so neither is ever given the other's.
 */
import { TEXTURE_LAYERS_MOST, TEXTURE_SIDE_MOST, type LayerSize } from './texture';

/** Two floats a placement: the layer (counted from one) and the cut, under which a texel's alpha is thrown away. */
export const CARD_STRIDE = 2;
/** The cut a group gets when it names none. */
export const CARD_CUT = 0.5;

/**
 * Refuses, by name, a set of card images that cannot be one array: none, too many, not square, not a power of two
 * (the mips want one), too big, or of different sizes. The limits are the ground texture's, said there once. Returns
 * the side.
 */
export function checkCards(layers: readonly LayerSize[] | null): number {
  if (!layers || layers.length === 0) throw new Error('setCardImages: no layers; pass null to take the cards away');
  if (layers.length > TEXTURE_LAYERS_MOST) throw new Error(`setCardImages: ${layers.length} layers, and at most ${TEXTURE_LAYERS_MOST} are allowed`);
  const side = layers[0].width;
  layers.forEach((l, i) => {
    if (l.width !== l.height) throw new Error(`setCardImages: layer ${i} is ${l.width} by ${l.height}, and a layer must be square`);
    if (l.width < 1 || (l.width & (l.width - 1)) !== 0) throw new Error(`setCardImages: layer ${i} is ${l.width} across, and a layer must be a power of two`);
    if (l.width > TEXTURE_SIDE_MOST) throw new Error(`setCardImages: layer ${i} is ${l.width} across, and at most ${TEXTURE_SIDE_MOST} is allowed`);
    if (l.width !== side) throw new Error(`setCardImages: layer ${i} is ${l.width} across and layer 0 is ${side}, and every layer must be the same size`);
  });
  return side;
}

/** An alpha channel: bytes (0 to 255, as an `rgba8unorm` image is) or floats (0 to 1). */
export type Alpha = Uint8Array | Float32Array;

/** The most a mip level's alpha is ever scaled by: a leaf thinned to a speck is not to be made solid. */
export const COVERAGE_SCALE_MOST = 64;

/** The share of texels whose alpha, times `scale`, is at or over `cut` (0 to 1). */
export function coverage(alpha: Alpha, cut: number, scale = 1): number {
  const unit = alpha instanceof Uint8Array ? 255 : 1;
  const over = cut * unit / scale;
  let n = 0;
  for (let i = 0; i < alpha.length; i++) if (alpha[i] >= over) n++;
  return alpha.length === 0 ? 0 : n / alpha.length;
}

/** The next mip level of a square alpha of `side` texels, by a box filter: each texel is the mean of its four, rounded where the alpha is bytes. */
export function downsample<A extends Alpha>(alpha: A, side: number): A {
  const half = Math.max(1, side >> 1);
  const out = (alpha instanceof Uint8Array ? new Uint8Array(half * half) : new Float32Array(half * half)) as A;
  const round = alpha instanceof Uint8Array;
  for (let y = 0; y < half; y++)
    for (let x = 0; x < half; x++) {
      const x1 = Math.min(side - 1, x * 2 + 1), y1 = Math.min(side - 1, y * 2 + 1);
      const sum = alpha[y * 2 * side + x * 2] + alpha[y * 2 * side + x1] + alpha[y1 * side + x * 2] + alpha[y1 * side + x1];
      out[y * half + x] = round ? Math.round(sum / 4) : sum / 4;
    }
  return out;
}

/**
 * The scale to multiply a mip level's alpha by so that the share of its texels at or over `cut` is `target`, the top
 * level's share: coverage-preserving mips (Castano, 2010). A box filter blurs a leaf's edge into the middle of the
 * alpha range, so under a fixed cut the card thins with each level and the tree goes bald at a distance; scaling the
 * level's alpha up, found by a binary search for the scale that gets there (coverage only ever rises with the scale, and goes
 * in whole texels, so the nearer side of the step is taken), puts back what the filter took. `alpha` is the level, bytes or floats, `cut` is 0 to 1 whichever, and the
 * level's side is not needed: only the share is. Returns 1 when there is nothing to keep (a target of nought, or a
 * level that no scale up to `COVERAGE_SCALE_MOST` brings to the target), and never more than that. Stored alpha is clamped at one, so a scale over one only moves the texels it takes over the cut.
 */
export function coverageAlpha(alpha: Alpha, cut: number, target: number): number {
  if (!(target > 0) || alpha.length === 0) return 1;
  if (coverage(alpha, cut, COVERAGE_SCALE_MOST) < target) return 1;
  let lo = 0, hi = COVERAGE_SCALE_MOST;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (coverage(alpha, cut, mid) >= target) hi = mid;
    else lo = mid;
  }
  // the search ends either side of a step in a whole number of texels: take whichever side is nearer the target
  return target - coverage(alpha, cut, lo) < coverage(alpha, cut, hi) - target ? Math.max(lo, Number.EPSILON) : hi;
}

/**
 * Every mip level of one card image, `rgba` bytes at the top (`side` across, not premultiplied), the levels below it
 * made here and not by the mips' blit, so that the alpha can be scaled to keep its coverage. The colour is a box
 * filter as the blit's is. The alpha is box-filtered from the level above's *unscaled* alpha (scaling each from the
 * last would compound the error), then multiplied, clamped at one, by the scale `coverageAlpha` finds for the share of
 * texels at or over `cut` to equal the top's.
 *
 * The cut is a group's own (`GameGroup.card.cut`) but the levels are the image's, shared by every group that wears
 * it, so coverage is kept at one cut: `CARD_CUT`, the one a group gets when it names none. That is the right
 * compromise because it is the cut nearly every card is drawn at, and a card kept at a nearby cut still thins or
 * fattens by far less than the unscaled chain, whose loss is at every cut.
 */
export function cardLevels(rgba: Uint8Array<ArrayBuffer>, side: number, cut = CARD_CUT): Uint8Array<ArrayBuffer>[] {
  const top = new Uint8Array(side * side);
  for (let i = 0; i < top.length; i++) top[i] = rgba[i * 4 + 3];
  const target = coverage(top, cut);
  const out = [rgba];
  let colour = rgba, alpha = top, s = side;
  while (s > 1) {
    const half = s >> 1;
    const next = new Uint8Array(half * half * 4);
    for (let y = 0; y < half; y++)
      for (let x = 0; x < half; x++) {
        const a = (y * 2 * s + x * 2) * 4, b = a + 4, c = a + s * 4, d = c + 4;
        for (let k = 0; k < 3; k++) next[(y * half + x) * 4 + k] = Math.round((colour[a + k] + colour[b + k] + colour[c + k] + colour[d + k]) / 4);
      }
    alpha = downsample(alpha, s);
    const scale = coverageAlpha(alpha, cut, target);
    for (let i = 0; i < alpha.length; i++) next[i * 4 + 3] = Math.min(255, Math.round(alpha[i] * scale));
    out.push(next);
    colour = next;
    s = half;
  }
  return out;
}

/**
 * The scene shader's pieces, as the carded build changes them: each a place where a card is read, and what is put
 * there. The alpha is sampled first of anything in the fragment stage, in uniform control flow (the sample takes
 * derivatives), and `discard` follows it; the back of a card is lit as a front is, by turning its normal.
 */
export const CARD_SPLICES = {
  /** The array and its own repeat sampler (a leaf card's uvs run past one), at the two bindings after the ground texture's. */
  bindings: {
    from: '@group(0) @binding(9) var occlusionMap: texture_2d<f32>;\n',
    to: '@group(0) @binding(9) var occlusionMap: texture_2d<f32>;\n@group(0) @binding(12) var cardImages: texture_2d_array<f32>;\n@group(0) @binding(13) var cardSampler: sampler;\n',
  },
  /** The fragment stage is handed the uv, and the layer and cut flat. */
  struct: {
    from: '@location(6) @interpolate(flat) second: vec3f,\n',
    to: '@location(6) @interpolate(flat) second: vec3f,\n  @location(7) uv: vec2f,\n  @location(8) @interpolate(flat) card: vec2f,\n',
  },
  input: {
    from: '@location(9) pattern: vec4f, @location(10) second: vec4f,\n',
    to: '@location(9) pattern: vec4f, @location(10) second: vec4f,\n  // the card\'s uv, from the mesh; and its layer and cut, per placement\n  @location(2) uv: vec2f, @location(11) card: vec2f,\n',
  },
  vertex: {
    from: '  out.second = second.rgb;\n',
    to: '  out.second = second.rgb;\n  out.uv = uv;\n  out.card = card;\n',
  },
  /** The sample, the cut and the face, before the fragment stage reads its normal. */
  fragment: {
    from: '@fragment fn fsMain(in: VsOut) -> @location(0) vec4f {\n  let n = normalize(in.normal);\n',
    to: `@fragment fn fsMain(in: VsOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let cardLayer = clamp(i32(in.card.x + 0.5) - 1, 0, i32(textureNumLayers(cardImages)) - 1);
  let cardAlpha = textureSample(cardImages, cardSampler, in.uv, cardLayer).a;
  if (cardAlpha < in.card.y) {
    discard;
  }
  let n = select(-normalize(in.normal), normalize(in.normal), front);
`,
  },
} as const;

/**
 * The carded build's fragment stage at four samples a pixel, which asks for alpha to coverage and so throws nothing
 * away: the alpha the card's texel has is sharpened about the cut by how fast it changes across the pixel (Golus's
 * anti-aliased alpha test), `(a - cut) / fwidth(a) + 0.5` held to 0..1, and is the fragment's alpha, which the pipeline
 * turns into the share of the pixel's four samples that are covered. Up close the ramp is one pixel across and the edge
 * is as crisp as a hard cut. The sharpening alone does not hold a sparse mask's coverage at a distance, though: it
 * measured the same 11.8% thin as the hard cut at a third of the size, because the loss is in the trilinear blend of
 * two levels, each of which has had its alpha scaled to keep its own coverage (see `cardLevels`), and the blend of two
 * sparse masks has less of the mask over the cut than either. So this build reads the one level nearest the pixel's
 * footprint (the level the hardware would pick, rounded, from the uv's own derivatives) and not a blend of two: each
 * level keeps its coverage, and the sweep holds. The price is that the level changes in steps with distance, where a
 * trilinear read is smooth; under alpha to coverage the step is a change of a card's softness, not of its share.
 * The sample and its derivatives come before any branch, in uniform control flow. The
 * target's alpha is written with it, and nothing downstream reads that: every pass after the scene takes the colour's
 * `rgb`, the fog's blend keeps what is there, and the last pass writes an alpha of one.
 */
export const CARD_COVERAGE_SPLICES = {
  fragment: {
    from: CARD_SPLICES.fragment.from,
    to: `@fragment fn fsMain(in: VsOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let cardLayer = clamp(i32(in.card.x + 0.5) - 1, 0, i32(textureNumLayers(cardImages)) - 1);
  let cardSize = vec2f(textureDimensions(cardImages));
  let cardDx = dpdx(in.uv) * cardSize;
  let cardDy = dpdy(in.uv) * cardSize;
  let cardLod = round(max(0.0, 0.5 * log2(max(max(dot(cardDx, cardDx), dot(cardDy, cardDy)), 1e-8))));
  let cardAlpha = textureSampleLevel(cardImages, cardSampler, in.uv, cardLayer, cardLod).a;
  let cardCover = clamp((cardAlpha - in.card.y) / max(fwidth(cardAlpha), 1e-4) + 0.5, 0.0, 1.0);
  let n = select(-normalize(in.normal), normalize(in.normal), front);
`,
  },
  /** The scene's one return, which is where the coverage becomes the alpha. */
  result: {
    from: '  return vec4f(finite(colour * frame.exposure), 1.0);\n}\n',
    to: '  return vec4f(finite(colour * frame.exposure), cardCover);\n}\n',
  },
} as const;

/**
 * The depth shader's pieces for a card, which the sun's and the spots' maps and the occlusion prepass are drawn with:
 * the same uv, layer and cut, the same alpha, and a fragment stage that throws away what the colour pass does, so a
 * card casts the shadow of its leaves and not of its square. The bindings are in the group the pass makes for it.
 */
export const DEPTH_CUT_SPLICES = {
  bindings: {
    from: '@group(0) @binding(0) var<uniform> viewProj: mat4x4f;\n',
    to: '@group(0) @binding(0) var<uniform> viewProj: mat4x4f;\n@group(0) @binding(1) var cardImages: texture_2d_array<f32>;\n@group(0) @binding(2) var cardSampler: sampler;\nstruct CutOut {\n  @builtin(position) pos: vec4f,\n  @location(0) uv: vec2f,\n  @location(1) @interpolate(flat) card: vec2f,\n};\n',
  },
  input: {
    from: '  @location(4) m0: vec4f, @location(5) m1: vec4f, @location(6) m2: vec4f, @location(7) m3: vec4f,\n) -> @builtin(position) vec4f {\n',
    to: '  @location(2) uv: vec2f, @location(11) card: vec2f,\n  @location(4) m0: vec4f, @location(5) m1: vec4f, @location(6) m2: vec4f, @location(7) m3: vec4f,\n) -> CutOut {\n',
  },
  output: {
    from: '  return viewProj * (model * vec4f(position, 1.0));\n}\n',
    to: `  var out: CutOut;
  out.pos = viewProj * (model * vec4f(position, 1.0));
  out.uv = uv;
  out.card = card;
  return out;
}
@fragment fn fsMain(in: CutOut) {
  let cardLayer = clamp(i32(in.card.x + 0.5) - 1, 0, i32(textureNumLayers(cardImages)) - 1);
  if (textureSample(cardImages, cardSampler, in.uv, cardLayer).a < in.card.y) {
    discard;
  }
}
`,
  },
} as const;
