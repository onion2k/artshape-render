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
 * A spotlight's map: from the lamp, along its aim, a little wider than its
 * outer cone so the soft edge of the cone is inside the map, out to its
 * reach. `outerDegrees` is the half-angle the light itself carries.
 */
export function spotShadowMatrix(
  out: Float32Array,
  position: [number, number, number],
  direction: [number, number, number],
  outerDegrees: number,
  reach: number,
  near = 20,
) {
  const l = Math.hypot(direction[0], direction[1], direction[2]) || 1;
  const d: [number, number, number] = [direction[0] / l, direction[1] / l, direction[2] / l];
  const target: [number, number, number] = [position[0] + d[0], position[1] + d[1], position[2] + d[2]];
  const view = new Float32Array(16);
  lookAt(view, position, target, upFor(d));
  const proj = new Float32Array(16);
  const fov = Math.min(Math.PI * 0.94, (2 * outerDegrees * Math.PI) / 180 * 1.08);
  perspective(proj, fov, 1, Math.max(1, near), Math.max(near + 1, reach));
  multiply(out, proj, view);
}
