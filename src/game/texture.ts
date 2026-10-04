/**
 * The ground texture: an image sampled by world position under a placement's
 * colour, so flat ground (a green, a fairway, a rough) can carry the grain of
 * turf without a tile of geometry for it. Layers of one array are bound once
 * to the scene, a placement says which layer, how often it repeats, and how
 * much of it shows as colour and as shade; a placement that says nothing is
 * drawn exactly as it was.
 *
 * This file holds what is only the texture's: the limits on what may be
 * uploaded and the refusals by name, the packing of a placement's four
 * floats, and the pieces of WGSL spliced into the scene shader for the
 * textured build alone. The other builds are the text they were before, to
 * the byte, and a game that never sets a texture compiles none of it.
 */

/** Four floats a placement: the layer (counted from one, nought for none), the repeat, the albedo strength and the shade strength. */
export const TEXTURE_STRIDE = 4;

/** The most layers one texture array may have: a ground kind each, with room. */
export const TEXTURE_LAYERS_MOST = 8;
/** The largest side of a layer, in texels. */
export const TEXTURE_SIDE_MOST = 1024;

/** What a game says of a placement's texture. */
export interface TexturePlacement {
  /** Which layer of the array, counted from one. Nought draws the placement untextured. */
  layer: number;
  /** How many times the layer tiles across a unit of the world, along x and along y. */
  repeat: number;
  /** How far the layer's colour, about its mid-grey, modulates the placement's own: 0 leaves it, 1 is the layer's whole swing. */
  albedo: number;
  /** How far the layer's alpha, about its mid-grey, lights and shades the placement before the toon bands are cut: 0 leaves it, 1 is the layer's whole swing. */
  shade: number;
}

/** Writes a placement's four floats at `offset` in `out`, for a group's `texture`; the caller says where each starts. Returns `out`. */
export function packTexture(out: Float32Array, offset: number, p: TexturePlacement): Float32Array {
  out[offset] = p.layer;
  out[offset + 1] = p.repeat;
  out[offset + 2] = p.albedo;
  out[offset + 3] = p.shade;
  return out;
}

/** What a layer must be to be uploaded: the part of an `ImageBitmap` that is checked. */
export interface LayerSize {
  width: number;
  height: number;
}

/**
 * Refuses, by name, a set of layers that cannot be one array: none, too many,
 * not square, not a power of two (the mips and the repeat want one), too big,
 * or of different sizes (an array has one size). Returns the side.
 */
export function checkLayers(layers: readonly LayerSize[]): number {
  if (layers.length === 0) throw new Error('setGroundTexture: no layers; pass null to take the texture away');
  if (layers.length > TEXTURE_LAYERS_MOST) throw new Error(`setGroundTexture: ${layers.length} layers, and at most ${TEXTURE_LAYERS_MOST} are allowed`);
  const side = layers[0].width;
  layers.forEach((l, i) => {
    if (l.width !== l.height) throw new Error(`setGroundTexture: layer ${i} is ${l.width} by ${l.height}, and a layer must be square`);
    if (l.width < 1 || (l.width & (l.width - 1)) !== 0) throw new Error(`setGroundTexture: layer ${i} is ${l.width} across, and a layer must be a power of two`);
    if (l.width > TEXTURE_SIDE_MOST) throw new Error(`setGroundTexture: layer ${i} is ${l.width} across, and at most ${TEXTURE_SIDE_MOST} is allowed`);
    if (l.width !== side) throw new Error(`setGroundTexture: layer ${i} is ${l.width} across and layer 0 is ${side}, and every layer must be the same size`);
  });
  return side;
}

/** How many mip levels a square of `side` texels has, down to one texel. */
export function mipLevels(side: number): number {
  return Math.floor(Math.log2(side)) + 1;
}

/** Whether any placement of a group's `texture`, `TEXTURE_STRIDE` floats each, names a layer: what makes a group draw through the textured build. */
export function usesTexture(texture: Float32Array | undefined): boolean {
  if (!texture) return false;
  for (let i = 0; i + TEXTURE_STRIDE <= texture.length; i += TEXTURE_STRIDE) if (texture[i] > 0.5) return true;
  return false;
}

/** The scene shader's pieces, as the textured build changes them: each a place where a placement's texture is read, and what is put there. */
export const TEXTURE_SPLICES = {
  /** The array and its own sampler, at the two bindings after the occlusion's. */
  bindings: {
    from: '@group(0) @binding(9) var occlusionMap: texture_2d<f32>;\n',
    to: '@group(0) @binding(9) var occlusionMap: texture_2d<f32>;\n@group(0) @binding(10) var groundTexture: texture_2d_array<f32>;\n@group(0) @binding(11) var groundSampler: sampler;\n',
  },
  /** The fragment stage is handed the placement's four floats, flat. */
  struct: {
    from: '@location(6) @interpolate(flat) second: vec3f,\n',
    to: '@location(6) @interpolate(flat) second: vec3f,\n  @location(7) @interpolate(flat) tex: vec4f,\n',
  },
  input: {
    from: '@location(9) pattern: vec4f, @location(10) second: vec4f,\n',
    to: '@location(9) pattern: vec4f, @location(10) second: vec4f,\n  // the placement\'s texture: layer, repeat, albedo strength and shade strength, nought where it has none\n  @location(11) tex: vec4f,\n',
  },
  vertex: {
    from: '  out.second = second.rgb;\n',
    to: '  out.second = second.rgb;\n  out.tex = tex;\n',
  },
  /**
   * The sample, taken in uniform control flow, before anything branches: the
   * layer by the world's x and y times the repeat, its strength faded to
   * nothing as the texels shrink below a pixel (a far field of grain settles
   * to the flat colour and not to a grey mip), and the colour modulated about
   * mid-grey after the pattern mix, so the game's palette stays the game's.
   */
  albedo: {
    from: '  let a = rough * rough;\n',
    to: `  let groundUv = in.world.xy * in.tex.y;
  let groundSide = f32(textureDimensions(groundTexture).x);
  let groundLayer = clamp(i32(in.tex.x + 0.5) - 1, 0, i32(textureNumLayers(groundTexture)) - 1);
  let groundSample = textureSample(groundTexture, groundSampler, groundUv, groundLayer);
  let groundTexels = log2(max(max(fwidth(groundUv.x), fwidth(groundUv.y)), 1e-6) * groundSide);
  let groundFade = (1.0 - smoothstep(2.0, 6.0, groundTexels)) * select(0.0, 1.0, in.tex.x > 0.5);
  f0 = f0 * mix(vec3f(1.0), groundSample.rgb * 2.0, clamp(in.tex.z, 0.0, 1.0) * groundFade);
  let a = rough * rough;
`,
  },
  /** The alpha as height, shade about mid-grey, on the sun's light before the toon ramp cuts it, so the band's edge moves with it. */
  shade: {
    from: '  let sunSpec = ggx(',
    to: '  lit = lit * mix(1.0, groundSample.a * 2.0, clamp(in.tex.w, 0.0, 1.0) * groundFade);\n  let sunSpec = ggx(',
  },
} as const;
