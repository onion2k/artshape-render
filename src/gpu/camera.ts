/**
 * A perspective camera and an orbit control, both with +Z up.
 *
 * Everything in this project agrees that Z is up: parts revolve about Z,
 * symmetries turn about Z, the environment hangs its key light at +Z. The
 * camera agrees too, and its projection maps depth to WebGPU's [0, 1].
 */

import type { Vec3 } from '../geom/types';

export type Mat4 = Float32Array;

export class Camera {
  position: Vec3 = [90, 60, 50];
  target: Vec3 = [0, 0, 0];
  fov = 32;   // vertical, degrees
  aspect = 1;
  near = 0.5;
  far = 4000;
  /** Tilt of the horizon: a turn about the line of sight, radians, positive clockwise. */
  roll = 0;
  /**
   * Lens shift, as fractions of half the frame: the image slid across the
   * sensor without turning the camera, which is how an architectural lens
   * keeps verticals vertical while looking up at a tall thing. (0, 0.3) is
   * a rise: the frame takes in 30% of its half-height more above.
   */
  shift: [number, number] = [0, 0];

  readonly view: Mat4 = new Float32Array(16);
  readonly projection: Mat4 = new Float32Array(16);
  readonly viewProjection: Mat4 = new Float32Array(16);

  update() {
    lookAt(this.view, this.position, this.target, [0, 0, 1]);
    if (this.roll) rollView(this.view, this.roll);
    perspective(this.projection, (this.fov * Math.PI) / 180, this.aspect, this.near, this.far, this.shift);
    multiply(this.viewProjection, this.projection, this.view);
  }

  /** The vertical field of view a lens of this focal length gives on a 24 mm tall frame. */
  static fovForLens(mm: number): number {
    return (2 * Math.atan(12 / Math.max(mm, 1)) * 180) / Math.PI;
  }
  static lensForFov(fovDeg: number): number {
    return 12 / Math.tan((fovDeg * Math.PI) / 360);
  }

  /** Camera right and up axes in world space, from the view matrix's rows. */
  get right(): Vec3 { return [this.view[0], this.view[4], this.view[8]]; }
  get up(): Vec3 { return [this.view[1], this.view[5], this.view[9]]; }
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export interface OrbitOptions {
  element: HTMLElement;
  ease?: number;
  inertia?: number;
  minDistance?: number;
  maxDistance?: number;
  minPolar?: number;
  maxPolar?: number;
  rotateSpeed?: number;
  zoomSpeed?: number;
  panSpeed?: number;
}

/**
 * Spherical about +Z: polar down from the zenith, azimuth round the XY plane.
 * Drag turns the subject, so the camera goes the other way; wheel dollies;
 * right button, middle button or shift pans in the screen plane.
 */
export class Orbit {
  enabled = true;
  minDistance: number;
  maxDistance: number;

  private camera: Camera;
  private element: HTMLElement;
  private ease: number;
  private inertia: number;
  private minPolar: number;
  private maxPolar: number;
  private rotateSpeed: number;
  private zoomSpeed: number;
  private panSpeed: number;

  private radius = 1;
  /** How far the camera sits from its target right now. */
  get distance() { return this.radius; }
  private azimuth = 0;
  private polar = Math.PI / 3;
  private toRadius = 1;
  private toAzimuth = 0;
  private toPolar = Math.PI / 3;

  /** Where the orbit stands now, for a panel that shows it. */
  get currentAzimuth() { return this.azimuth; }
  get currentPolar() { return this.polar; }
  /** Send the orbit somewhere, easing as a drag would. Angles in radians, polar from the zenith. */
  setSpherical(to: { azimuth?: number; polar?: number; radius?: number }) {
    if (to.azimuth !== undefined) this.toAzimuth = to.azimuth;
    if (to.polar !== undefined) this.toPolar = clamp(to.polar, this.minPolar, this.maxPolar);
    if (to.radius !== undefined) this.toRadius = clamp(to.radius, this.minDistance, this.maxDistance);
  }

  private spinDelta = { azimuth: 0, polar: 0 };
  private panDelta: Vec3 = [0, 0, 0];
  private dolly = 1;

  private pointer: number | null = null;
  private panning = false;
  private lastX = 0;
  private lastY = 0;

  constructor(camera: Camera, opts: OrbitOptions) {
    this.camera = camera;
    this.element = opts.element;
    this.ease = opts.ease ?? 0.18;
    this.inertia = opts.inertia ?? 0.72;
    this.minDistance = opts.minDistance ?? 0.1;
    this.maxDistance = opts.maxDistance ?? Infinity;
    // never quite reach a pole: the view is degenerate where forward and up align
    this.minPolar = opts.minPolar ?? 0.05;
    this.maxPolar = opts.maxPolar ?? Math.PI - 0.05;
    this.rotateSpeed = opts.rotateSpeed ?? 1;
    this.zoomSpeed = opts.zoomSpeed ?? 1;
    this.panSpeed = opts.panSpeed ?? 1;
    this.readFromCamera();

    this.element.addEventListener('pointerdown', this.onPointerDown);
    this.element.addEventListener('wheel', this.onWheel, { passive: false });
    this.element.addEventListener('contextmenu', this.onContextMenu);
  }

  /** True while the camera is still easing toward where the user sent it. */
  get moving(): boolean {
    return Math.abs(this.spinDelta.azimuth) > 1e-6 || Math.abs(this.spinDelta.polar) > 1e-6
      || Math.abs(this.dolly - 1) > 1e-9
      || Math.hypot(this.panDelta[0], this.panDelta[1], this.panDelta[2]) > 1e-6
      || Math.abs(this.toAzimuth - this.azimuth) > 1e-5
      || Math.abs(this.toPolar - this.polar) > 1e-5
      || Math.abs(this.toRadius - this.radius) > this.radius * 1e-5;
  }

  /** Adopt whatever position the camera has been moved to, without easing. */
  forcePosition() {
    this.readFromCamera();
    this.spinDelta.azimuth = 0;
    this.spinDelta.polar = 0;
    this.panDelta = [0, 0, 0];
    this.dolly = 1;
    this.apply();
  }

  update() {
    if (!this.enabled) return;
    this.toAzimuth += this.spinDelta.azimuth;
    this.toPolar = clamp(this.toPolar + this.spinDelta.polar, this.minPolar, this.maxPolar);
    this.toRadius = clamp(this.toRadius * this.dolly, this.minDistance, this.maxDistance);
    const t = this.camera.target;
    this.camera.target = [t[0] + this.panDelta[0], t[1] + this.panDelta[1], t[2] + this.panDelta[2]];

    this.azimuth += (this.toAzimuth - this.azimuth) * this.ease;
    this.polar += (this.toPolar - this.polar) * this.ease;
    this.radius += (this.toRadius - this.radius) * this.ease;
    this.apply();

    this.spinDelta.azimuth *= this.inertia;
    this.spinDelta.polar *= this.inertia;
    this.panDelta = [this.panDelta[0] * this.inertia, this.panDelta[1] * this.inertia, this.panDelta[2] * this.inertia];
    this.dolly = 1;
  }

  remove() {
    this.element.removeEventListener('pointerdown', this.onPointerDown);
    this.element.removeEventListener('wheel', this.onWheel);
    this.element.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
  }

  private apply() {
    const sin = Math.sin(this.polar);
    const t = this.camera.target;
    this.camera.position = [
      t[0] + this.radius * sin * Math.cos(this.azimuth),
      t[1] + this.radius * sin * Math.sin(this.azimuth),
      t[2] + this.radius * Math.cos(this.polar),
    ];
    this.camera.update();
  }

  private readFromCamera() {
    const p = this.camera.position, t = this.camera.target;
    const dx = p[0] - t[0], dy = p[1] - t[1], dz = p[2] - t[2];
    const r = Math.max(Math.hypot(dx, dy, dz), 1e-6);
    this.radius = this.toRadius = clamp(r, this.minDistance, this.maxDistance);
    this.azimuth = this.toAzimuth = Math.atan2(dy, dx);
    this.polar = this.toPolar = clamp(Math.acos(clamp(dz / r, -1, 1)), this.minPolar, this.maxPolar);
  }

  private onContextMenu = (e: Event) => e.preventDefault();

  private onPointerDown = (e: PointerEvent) => {
    if (!this.enabled || this.pointer !== null) return;
    this.pointer = e.pointerId;
    this.panning = e.button === 1 || e.button === 2 || e.shiftKey;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.element.setPointerCapture?.(e.pointerId);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    e.preventDefault();
  };

  private onPointerMove = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    const height = this.element.clientHeight || 1;

    if (this.panning) {
      const reach = this.radius * Math.tan(((this.camera.fov / 2) * Math.PI) / 180);
      const across = (2 * dx * reach * this.panSpeed) / height;
      const along = (2 * dy * reach * this.panSpeed) / height;
      const r = this.camera.right, u = this.camera.up;
      this.panDelta = [
        -r[0] * across + u[0] * along,
        -r[1] * across + u[1] * along,
        -r[2] * across + u[2] * along,
      ];
      return;
    }
    this.spinDelta.azimuth -= (2 * Math.PI * dx * this.rotateSpeed) / height;
    this.spinDelta.polar -= (2 * Math.PI * dy * this.rotateSpeed) / height;
  };

  private onPointerUp = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) return;
    this.pointer = null;
    this.element.releasePointerCapture?.(e.pointerId);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    const step = Math.pow(0.95, this.zoomSpeed);
    this.dolly *= e.deltaY < 0 ? step : e.deltaY > 0 ? 1 / step : 1;
  };
}

// ---- matrices, column-major ----

export function lookAt(out: Mat4, eye: Vec3, target: Vec3, up: Vec3) {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
}

/**
 * Perspective with depth mapped to [0, 1], as WebGPU clips it. A shift
 * slides the image across the frame by that fraction of its half-size: the
 * terms sit in the z column so they survive the perspective divide.
 */
export function perspective(out: Mat4, fovY: number, aspect: number, near: number, far: number, shift: [number, number] = [0, 0]) {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[8] = 2 * shift[0];
  out[9] = 2 * shift[1];
  out[10] = far / (near - far);
  out[11] = -1;
  out[14] = (near * far) / (near - far);
}

/** Turn a view matrix about its own line of sight: the horizon tilts, nothing else moves. */
export function rollView(view: Mat4, roll: number) {
  const c = Math.cos(roll), s = Math.sin(roll);
  // rows 0 and 1 of the view are the camera's right and up; mix them
  for (let col = 0; col < 4; col++) {
    const x = view[col * 4], y = view[col * 4 + 1];
    view[col * 4] = c * x - s * y;
    view[col * 4 + 1] = s * x + c * y;
  }
}

export function multiply(out: Mat4, a: Mat4, b: Mat4) {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let rw = 0; rw < 4; rw++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + rw] * b[c * 4 + k];
      r[c * 4 + rw] = s;
    }
  }
  out.set(r);
}
