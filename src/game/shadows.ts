/**
 * Where a shadow map looks from.
 *
 * Two kinds. The sun's is orthographic and fitted to a box the game names —
 * the arena — so that every texel of the map is spent on ground something
 * can stand on; the box's corners are projected into the light's view and
 * the frustum is the smallest one round them. A spotlight's is a perspective
 * from the lamp along its aim, as wide as its cone and as deep as its reach,
 * which is the frustum the light itself throws.
 *
 * Both map depth to [0, 1] as WebGPU clips it, and both are column-major
 * like everything else here.
 */
import { lookAt, multiply, perspective } from '../gpu/camera';

export interface Box {
  min: [number, number, number];
  max: [number, number, number];
}

/** An up that is not along the direction, for a basis with no degenerate case. */
function upFor(d: [number, number, number]): [number, number, number] {
  return Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
}

/**
 * The sun's map: an orthographic view along `toLight` (the direction from the
 * scene toward the light, as the shader has it), fitted round `box`. The
 * near plane is pulled back a little past the box so a caster at its very
 * edge still casts, and the far plane pushed out the same.
 */
export function sunShadowMatrix(out: Float32Array, toLight: [number, number, number], box: Box) {
  const l = Math.hypot(toLight[0], toLight[1], toLight[2]) || 1;
  const d: [number, number, number] = [toLight[0] / l, toLight[1] / l, toLight[2] / l];
  const centre: [number, number, number] = [
    (box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2,
  ];
  const reach = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
  const eye: [number, number, number] = [centre[0] + d[0] * reach, centre[1] + d[1] * reach, centre[2] + d[2] * reach];
  const view = new Float32Array(16);
  lookAt(view, eye, centre, upFor(d));

  // the box's corners in the light's view; the frustum is their extent
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? box.max[0] : box.min[0];
    const y = i & 2 ? box.max[1] : box.min[1];
    const z = i & 4 ? box.max[2] : box.min[2];
    const vx = view[0] * x + view[4] * y + view[8] * z + view[12];
    const vy = view[1] * x + view[5] * y + view[9] * z + view[13];
    const vz = view[2] * x + view[6] * y + view[10] * z + view[14];
    lo = [Math.min(lo[0], vx), Math.min(lo[1], vy), Math.min(lo[2], vz)];
    hi = [Math.max(hi[0], vx), Math.max(hi[1], vy), Math.max(hi[2], vz)];
  }
  // view z runs negative away from the eye: near is the largest z, far the smallest
  const pad = reach * 0.05;
  const near = -hi[2] - pad;
  const far = -lo[2] + pad;
  const proj = new Float32Array(16);
  orthographic(proj, lo[0] - pad, hi[0] + pad, lo[1] - pad, hi[1] + pad, near, far);
  multiply(out, proj, view);
}

/** How the sun's map is fitted to the view: the side of the square of ground it covers, in world units. */
export interface SunFit {
  reach: number;
}

/**
 * The sun's map fitted to the view and not to the whole box: a square `reach` across, in the light's own plane, over the
 * ground ahead of the camera (from a tenth of the reach behind it to nine tenths ahead), so a long hole's shadows are as
 * sharp as a short one's. The light looks from the box's own place along `toLight`, which does not move with the camera,
 * and the square moves across it by whole texels of a map `mapSize` across, so a still edge stays on its texel as the
 * camera slides and does not swim. Its depth spans the whole box, so every caster the box holds still casts. Where the
 * square is bigger than the box is across, it sits on the box, and where it is smaller it is kept inside it, so no texel
 * is spent on nothing.
 */
/** The light's view and its square, made once: the fit is worked out every frame, and a frame makes nothing. */
const FIT_VIEW = new Float32Array(16), FIT_PROJ = new Float32Array(16);

export function sunShadowFitted(
  out: Float32Array,
  toLight: [number, number, number],
  box: Box,
  eye: [number, number, number],
  target: [number, number, number],
  fit: SunFit,
  mapSize: number,
) {
  const l = Math.hypot(toLight[0], toLight[1], toLight[2]) || 1;
  const d: [number, number, number] = [toLight[0] / l, toLight[1] / l, toLight[2] / l];
  const centre: [number, number, number] = [
    (box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2,
  ];
  const span = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
  const from: [number, number, number] = [centre[0] + d[0] * span, centre[1] + d[1] * span, centre[2] + d[2] * span];
  const view = FIT_VIEW;
  lookAt(view, from, centre, upFor(d));
  const toView = (x: number, y: number, z: number): [number, number, number] => [
    view[0] * x + view[4] * y + view[8] * z + view[12],
    view[1] * x + view[5] * y + view[9] * z + view[13],
    view[2] * x + view[6] * y + view[10] * z + view[14],
  ];
  // the box in the light's view: its extent across, and its depth, which the map keeps whole
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const v = toView(i & 1 ? box.max[0] : box.min[0], i & 2 ? box.max[1] : box.min[1], i & 4 ? box.max[2] : box.min[2]);
    lo = [Math.min(lo[0], v[0]), Math.min(lo[1], v[1]), Math.min(lo[2], v[2])];
    hi = [Math.max(hi[0], v[0]), Math.max(hi[1], v[1]), Math.max(hi[2], v[2])];
  }
  // the ground the square is laid over: four tenths of the reach ahead of the camera, along the ground, or what it looks at
  // when it looks nearly straight down and has no ahead
  const fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2];
  const across = Math.hypot(fx, fy);
  const z = Math.min(box.max[2], Math.max(box.min[2], target[2]));
  const at: [number, number, number] =
    across > 0.1 * Math.hypot(fx, fy, fz)
      ? [eye[0] + (fx / across) * fit.reach * 0.4, eye[1] + (fy / across) * fit.reach * 0.4, z]
      : [target[0], target[1], z];
  const [ax, ay] = toView(at[0], at[1], at[2]);
  const side = Math.max(fit.reach, 1e-6);
  const texel = side / mapSize;
  // kept on the box: centred on it where the square is wider than it, and inside it where it is narrower
  const keep = (c: number, a: number, b: number) =>
    side >= b - a ? (a + b) / 2 : Math.min(b - side / 2, Math.max(a + side / 2, c));
  const cx = Math.round(keep(ax, lo[0], hi[0]) / texel) * texel;
  const cy = Math.round(keep(ay, lo[1], hi[1]) / texel) * texel;
  const pad = span * 0.05;
  const proj = FIT_PROJ;
  orthographic(proj, cx - side / 2, cx + side / 2, cy - side / 2, cy + side / 2, -hi[2] - pad, -lo[2] + pad);
  multiply(out, proj, view);
}

/** Orthographic with depth to [0, 1], column-major, eye looking down -z. */
export function orthographic(out: Float32Array, left: number, right: number, bottom: number, top: number, near: number, far: number) {
  out.fill(0);
  out[0] = 2 / (right - left);
  out[5] = 2 / (top - bottom);
  out[10] = -1 / (far - near);
  out[12] = -(right + left) / (right - left);
  out[13] = -(top + bottom) / (top - bottom);
  out[14] = -near / (far - near);
  out[15] = 1;
}

/**
 * How near the lamp a spot's map starts, as a fraction of its reach, when the
 * caller does not say. It must be a fraction and not a length: a near plane
 * is where a perspective map spends its depth precision, and a constant
 * number of world units is a different fraction of the frustum in every unit
 * the caller might work in. A three-hundredth is 20 mm at the arena's 6.5 m
 * lamp, which is what this was before it was relative.
 */
const NEAR_FRACTION = 1 / 325;

/**
 * A spotlight's map: from the lamp, along its aim, a little wider than its
 * outer cone so the soft edge of the cone is inside the map, out to its
 * reach. `outerDegrees` is the half-angle the light itself carries.
 *
 * `near` is in the caller's world units, and every floor here is a fraction
 * of the reach rather than a length, so that the same lamp described in
 * metres and in millimetres gets the same frustum.
 */
export function spotShadowMatrix(
  out: Float32Array,
  position: [number, number, number],
  direction: [number, number, number],
  outerDegrees: number,
  reach: number,
  near = reach * NEAR_FRACTION,
) {
  const l = Math.hypot(direction[0], direction[1], direction[2]) || 1;
  const d: [number, number, number] = [direction[0] / l, direction[1] / l, direction[2] / l];
  const target: [number, number, number] = [position[0] + d[0], position[1] + d[1], position[2] + d[2]];
  const view = new Float32Array(16);
  lookAt(view, position, target, upFor(d));
  const proj = new Float32Array(16);
  const fov = Math.min(Math.PI * 0.94, (2 * outerDegrees * Math.PI) / 180 * 1.08);
  const span = Math.max(reach, 1e-6);
  const n = Math.max(near, span * 1e-4);
  perspective(proj, fov, 1, n, Math.max(span, n * 1.01));
  multiply(out, proj, view);
}
