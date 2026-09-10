/**
 * Point lights for the game path, packed the way the shader reads them.
 *
 * Mostly no shadows. A light that casts one is a different and far larger
 * cost, and an arena's flashes, glowing bullets and explosions do not need
 * them; a handful of spotlights may carry a map each — see the renderer's
 * setLights — and the rest cast nothing. What they do need is to be many: measured on a desktop GPU at 1080p, a forward
 * loop carries about 0.018 ms a light with the radius cull, so a couple of
 * hundred are comfortable, five hundred is the whole scene budget, and past
 * that the loop wants replacing with tiles or clusters.
 *
 * The pool is fixed at construction and the live count moves, which is the
 * same trick the chess set uses for its men: a buffer whose size changes is
 * a buffer that must be rebuilt, and a game changes its light count every
 * frame.
 */

/** One light. `radius` is where it fades to nothing, and where the cull cuts it. */
export interface PointLight {
  position: [number, number, number];
  radius: number;
  colour: [number, number, number];
  intensity: number;
  /**
   * Which way it points. Leave it out for a light that throws in every
   * direction, which is what every light was before cones existed.
   */
  direction?: [number, number, number];
  /**
   * The cone, as two half-angles in degrees: full strength within the first,
   * nothing at all past the second, and a smooth edge between. Ignored
   * without a direction.
   */
  cone?: [number, number];
  /**
   * Which spot shadow layer this light reads, or none. The renderer writes
   * this itself for the lights it is told to shadow; a game does not set it.
   */
  shadow?: number;
}

/**
 * Sixteen floats a light: position and radius, colour and intensity,
 * direction and the cosine of the outer angle, then the cosine of the inner
 * and three spare.
 *
 * It was eight before spotlights. The extra eight are half of them padding,
 * which is the price of the shader reading vec4s: an odd number of floats
 * between the vectors would cost more in alignment rules than the padding
 * costs in bandwidth.
 */
export const LIGHT_STRIDE = 16;

/**
 * A fixed pool of lights, written into one array the renderer uploads whole.
 *
 * Writing is by index rather than by pushing, so a game can keep its own
 * light-to-entity mapping and update in place; `count` says how many the
 * shader should walk.
 */
export class LightPool {
  readonly data: Float32Array<ArrayBuffer>;
  readonly capacity: number;
  private live = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.data = new Float32Array(this.capacity * LIGHT_STRIDE);
  }

  /** How many lights the renderer will walk. */
  get count() { return this.live; }

  /** Forget them all, without touching what was written. */
  clear() { this.live = 0; }

  /**
   * Write one light at `index`, growing the live count to cover it. Returns
   * whether it fit: a caller that runs out of pool should know rather than
   * silently lose the light.
   */
  set(index: number, light: PointLight): boolean {
    if (index < 0 || index >= this.capacity) return false;
    const o = index * LIGHT_STRIDE;
    const d = this.data;
    d[o] = light.position[0]; d[o + 1] = light.position[1]; d[o + 2] = light.position[2];
    d[o + 3] = Math.max(light.radius, 1e-4);
    d[o + 4] = light.colour[0]; d[o + 5] = light.colour[1]; d[o + 6] = light.colour[2];
    d[o + 7] = light.intensity;
    if (light.direction) {
      const [dx, dy, dz] = light.direction;
      const len = Math.hypot(dx, dy, dz) || 1;
      d[o + 8] = dx / len; d[o + 9] = dy / len; d[o + 10] = dz / len;
      const [inner, outer] = light.cone ?? [180, 180];
      d[o + 11] = Math.cos((Math.min(outer, 180) * Math.PI) / 180);
      d[o + 12] = Math.cos((Math.min(inner, outer) * Math.PI) / 180);
    } else {
      // A cosine can never be below -1, so an outer edge of -2 admits every
      // direction and the shader's cone term folds to one without a branch.
      d[o + 8] = 0; d[o + 9] = 0; d[o + 10] = -1;
      d[o + 11] = -2; d[o + 12] = -1;
    }
    d[o + 13] = light.shadow ?? -1; d[o + 14] = 0; d[o + 15] = 0;
    if (index >= this.live) this.live = index + 1;
    return true;
  }

  /** Append, if there is room. Returns the index written, or -1. */
  add(light: PointLight): number {
    if (this.live >= this.capacity) return -1;
    const at = this.live;
    this.set(at, light);
    return at;
  }

  /** Read one back, for a game that keeps its lights here rather than beside. */
  get(index: number): PointLight | null {
    if (index < 0 || index >= this.live) return null;
    const o = index * LIGHT_STRIDE;
    const d = this.data;
    const light: PointLight = {
      position: [d[o], d[o + 1], d[o + 2]],
      radius: d[o + 3],
      colour: [d[o + 4], d[o + 5], d[o + 6]],
      intensity: d[o + 7],
    };
    if (d[o + 13] >= 0) light.shadow = d[o + 13];
    if (d[o + 11] > -1.5) {
      light.direction = [d[o + 8], d[o + 9], d[o + 10]];
      light.cone = [
        (Math.acos(clamp(d[o + 12], -1, 1)) * 180) / Math.PI,
        (Math.acos(clamp(d[o + 11], -1, 1)) * 180) / Math.PI,
      ];
    }
    return light;
  }
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
