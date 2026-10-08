/**
 * The sky a game sees past everything it draws: a gradient by how high a pixel's ray looks, from a horizon colour at the
 * level to a zenith colour overhead, and a colour of its own below the level. Without it the frame clears to one flat
 * colour, and a game seen from low, toward its horizon, has a sky like a wall.
 *
 * It is the thing without its picture: the colour for a ray (`skyColour`), the packing of its uniform (`packSky`), and the
 * WGSL of the pass (`SKY_WGSL`), which reads the same constants. `GameRenderer` draws it first in the scene pass, where
 * nothing has been drawn and the depth is clear, and only when `look.sky` is set; asked for nothing, the frame clears to
 * `look.background` as it always did.
 */
import { FINITE_WGSL } from './shaders';

export type Rgb = [number, number, number];

export interface Sky {
  /** The colour straight up, in the frame's linear light before the tone map, as `background` is. */
  zenith: Rgb;
  /** The colour at the level. */
  horizon: Rgb;
  /**
   * How high a ray looks, as the sine of its elevation, by the time the sky is all zenith: the gradient is a smooth step
   * from the level to here. Left out, `SKY_HEIGHT`.
   */
  height?: number;
  /** The colour below the level, which a game sees only past the edge of its ground. Left out, the horizon's. */
  below?: Rgb;
}

/** How high the sky turns to its zenith, by default: the sine of thirty degrees. */
export const SKY_HEIGHT = 0.5;
/** How far below the level the horizon turns to the colour below it, as a sine: a soft line and not a hard one. */
export const SKY_BELOW = 0.04;
/** The floats of the sky's uniform: the inverse of the view and projection, the camera, the size, and the three colours. */
export const SKY_FLOATS = 16 + 4 + 4 + 4 + 4 + 4;

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
// as WGSL's mix is written, which is exactly each end at nought and one
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t, a[2] * (1 - t) + b[2] * t];

/** The sky's colour for a ray whose unit direction's up component is `up`: the sine of how high it looks. */
export function skyColour(sky: Sky, up: number): Rgb {
  const height = sky.height !== undefined && sky.height > 0 ? sky.height : SKY_HEIGHT;
  if (up >= 0) return mix(sky.horizon, sky.zenith, smooth(0, height, up));
  return mix(sky.horizon, sky.below ?? sky.horizon, smooth(0, SKY_BELOW, -up));
}

/** The inverse of `m` into `out`, both column-major; false where `m` has none, and `out` is left as it was. */
export function invertInto(out: Float32Array, a: Float32Array): boolean {
  const b00 = a[0] * a[5] - a[1] * a[4], b01 = a[0] * a[6] - a[2] * a[4];
  const b02 = a[0] * a[7] - a[3] * a[4], b03 = a[1] * a[6] - a[2] * a[5];
  const b04 = a[1] * a[7] - a[3] * a[5], b05 = a[2] * a[7] - a[3] * a[6];
  const b06 = a[8] * a[13] - a[9] * a[12], b07 = a[8] * a[14] - a[10] * a[12];
  const b08 = a[8] * a[15] - a[11] * a[12], b09 = a[9] * a[14] - a[10] * a[13];
  const b10 = a[9] * a[15] - a[11] * a[13], b11 = a[10] * a[15] - a[11] * a[14];
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det || !Number.isFinite(det)) return false;
  det = 1 / det;
  const o = [
    a[5] * b11 - a[6] * b10 + a[7] * b09, a[2] * b10 - a[1] * b11 - a[3] * b09,
    a[13] * b05 - a[14] * b04 + a[15] * b03, a[10] * b04 - a[9] * b05 - a[11] * b03,
    a[6] * b08 - a[4] * b11 - a[7] * b07, a[0] * b11 - a[2] * b08 + a[3] * b07,
    a[14] * b02 - a[12] * b05 - a[15] * b01, a[8] * b05 - a[10] * b02 + a[11] * b01,
    a[4] * b10 - a[5] * b08 + a[7] * b06, a[1] * b08 - a[0] * b10 - a[3] * b06,
    a[12] * b04 - a[13] * b02 + a[15] * b00, a[9] * b02 - a[8] * b04 - a[11] * b00,
    a[5] * b07 - a[4] * b09 - a[6] * b06, a[0] * b09 - a[1] * b07 + a[2] * b06,
    a[13] * b01 - a[12] * b03 - a[14] * b00, a[8] * b03 - a[9] * b01 + a[10] * b00,
  ];
  for (let i = 0; i < 16; i++) out[i] = o[i] * det;
  return true;
}

/**
 * The sky's uniform into `out` (`SKY_FLOATS` long): the inverse of the camera's view and projection, its place, the
 * frame's size in pixels, and the colours with the height and whether there is a colour below. False where the camera's
 * matrix has no inverse, and then the pass is not drawn.
 */
export function packSky(out: Float32Array, sky: Sky, viewProjection: Float32Array, eye: Rgb, width: number, height: number): boolean {
  if (!invertInto(out, viewProjection)) return false;
  out.set(eye, 16);
  out[19] = 0;
  out[20] = width;
  out[21] = height;
  out[22] = sky.height !== undefined && sky.height > 0 ? sky.height : SKY_HEIGHT;
  out[23] = SKY_BELOW;
  out.set(sky.zenith, 24);
  out[27] = 0;
  out.set(sky.horizon, 28);
  out[31] = 0;
  out.set(sky.below ?? sky.horizon, 32);
  out[35] = 0;
  return true;
}

/**
 * The pass: one triangle over the frame at the far plane, each pixel's ray carried back through the inverse of the view
 * and projection to the far plane, and its colour by how high it looks, as `skyColour` has it.
 */
export const SKY_WGSL = FINITE_WGSL + `
struct Sky {
  inverse: mat4x4f,
  eye: vec3f, pad0: f32,
  size: vec2f, height: f32, below: f32,
  zenith: vec3f, pad1: f32,
  horizon: vec3f, pad2: f32,
  under: vec3f, pad3: f32,
};
@group(0) @binding(0) var<uniform> sky: Sky;

@vertex fn vsMain(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((v << 1u) & 2u), f32(v & 2u)) * 2.0 - 1.0;
  return vec4f(p, 1.0, 1.0);
}

@fragment fn fsMain(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let ndc = vec2f(pos.x / sky.size.x * 2.0 - 1.0, 1.0 - pos.y / sky.size.y * 2.0);
  let far = sky.inverse * vec4f(ndc, 1.0, 1.0);
  let dir = normalize(far.xyz / far.w - sky.eye);
  var colour: vec3f;
  if (dir.z >= 0.0) {
    colour = mix(sky.horizon, sky.zenith, smoothstep(0.0, sky.height, dir.z));
  } else {
    colour = mix(sky.horizon, sky.under, smoothstep(0.0, sky.below, -dir.z));
  }
  return vec4f(finite(colour), 1.0);
}
`;
