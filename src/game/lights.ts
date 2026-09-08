/**
 * Point lights for the game path, packed the way the shader reads them.
 *
 * No shadows. A light that casts one is a different and far larger cost, and
 * an arena's flashes, glowing bullets and explosions do not need them. What
 * they do need is to be many: measured on a desktop GPU at 1080p, a forward
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
}

/** Eight floats a light: position, radius, colour, intensity. */
export const LIGHT_STRIDE = 8;

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
    return {
      position: [d[o], d[o + 1], d[o + 2]],
      radius: d[o + 3],
      colour: [d[o + 4], d[o + 5], d[o + 6]],
      intensity: d[o + 7],
    };
  }
}
