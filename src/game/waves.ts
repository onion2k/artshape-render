/**
 * Gerstner waves: a few long, gentle swells that move clear water's surface itself, where its twelve fine waves only
 * turn its shading. Each lifts and carries the surface's points round in a circle, so its crests come out sharper than
 * its troughs, as water's do.
 *
 * The sums are here twice, once in TypeScript and once in the clear pass's WGSL, from the same packing: a game floats
 * a bobber, a boat or a duck on the very surface that is drawn by asking `heightAt`. Without this, what floats would
 * ride a surface of its own and sink into the drawn one or hover over it.
 *
 * A wave goes at the speed deep water gives its length, so a game names only its length and not its speed, and the
 * swell looks like water whatever the world's units.
 */

export interface GerstnerWave {
  /** The way the wave travels, in radians round from the world's +x toward +y. */
  direction: number;
  /** From crest to crest, in world units. */
  wavelength: number;
  /** How far a crest rises over the still surface, and a trough falls under it, in world units. */
  amplitude: number;
  /**
   * How sharp its crests are, from nought (a sine) to one (a crest come to a point). The steepnesses of a water's waves
   * should add up to no more than one, or the surface folds over itself where their crests meet.
   */
  steepness: number;
}

/** The most waves a clear water may have. */
export const WAVE_SLOTS = 4;

/** How many floats the waves are packed into: two vec4s a slot. */
export const WAVE_FLOATS = WAVE_SLOTS * 8;

/** Gravity in millimetres a second squared, turned into the world's own units by the renderer's `mmPerUnit`. */
export const GRAVITY_MM = 9810;

/** How fast a wave of this length goes in deep water, in world units a second, under `gravity`. */
export function waveSpeed(wavelength: number, gravity: number): number {
  return Math.sqrt((gravity * wavelength) / (2 * Math.PI));
}

/** Refuses a list of waves the clear pass cannot draw, naming why. */
export function checkWaves(waves: readonly GerstnerWave[]): void {
  if (waves.length > WAVE_SLOTS) throw new Error(`clear water has ${waves.length === 5 ? 'five' : waves.length} waves; it may have ${WAVE_SLOTS} at the most`);
  for (const w of waves) {
    if (![w.direction, w.wavelength, w.amplitude, w.steepness].every(Number.isFinite) || w.wavelength <= 0) {
      throw new Error(`a wave of length ${w.wavelength} is not a wave: every figure must be a number, and its length more than nought`);
    }
  }
}

/**
 * Writes the waves into `out` as the clear pass reads them, each as its direction's x and y, its wave number (two pi
 * over its length), its amplitude, its steepness and how fast its phase turns, in radians a second; the slots not used
 * are noughts, which move nothing. Returns `out`.
 */
export function packWaves(out: Float32Array, waves: readonly GerstnerWave[], gravity: number): Float32Array {
  checkWaves(waves);
  out.fill(0, 0, WAVE_FLOATS);
  waves.forEach((w, i) => {
    const k = (2 * Math.PI) / w.wavelength;
    out.set([Math.cos(w.direction), Math.sin(w.direction), k, w.amplitude, Math.min(Math.max(w.steepness, 0), 1), Math.sqrt(gravity * k), 0, 0], i * 8);
  });
  return out;
}

/**
 * Where the still surface's point (`x`, `y`) is carried at time `t`: `out` is how far it moves in x and y, how far it
 * rises, and the slope of the surface there along x and along y. The same sum as the clear pass's vertex stage.
 */
export function gerstnerAt(waves: readonly GerstnerWave[], x: number, y: number, t: number, gravity: number, out: Float64Array): Float64Array {
  let dx = 0,
    dy = 0,
    h = 0,
    sx = 0,
    sy = 0,
    squash = 0;
  for (const w of waves) {
    const k = (2 * Math.PI) / w.wavelength;
    const ux = Math.cos(w.direction),
      uy = Math.sin(w.direction);
    const s = Math.min(Math.max(w.steepness, 0), 1);
    const phase = k * (ux * x + uy * y) - Math.sqrt(gravity * k) * t;
    const c = Math.cos(phase),
      sn = Math.sin(phase);
    // the point goes round a circle: forward at the crest's foot and back at its far side, so the crest is gathered in
    dx += (s / k) * ux * c;
    dy += (s / k) * uy * c;
    h += w.amplitude * sn;
    sx += ux * k * w.amplitude * c;
    sy += uy * k * w.amplitude * c;
    squash += s * sn;
  }
  // the slope over the ground the points were gathered into, which is less where they bunch at a crest
  const across = Math.max(1 - squash, 1e-3);
  out[0] = dx;
  out[1] = dy;
  out[2] = h;
  out[3] = sx / across;
  out[4] = sy / across;
  return out;
}

const scratch = new Float64Array(5);

/**
 * How high the surface stands over the world's point (`x`, `y`) at time `t`: what floats there floats at this height.
 * The surface's points are carried sideways as well as up, so the point that has come to (`x`, `y`) is found first, by
 * Newton's method on where each is carried.
 */
export function heightAt(waves: readonly GerstnerWave[], x: number, y: number, t: number, gravity: number): number {
  if (waves.length === 0) return 0;
  let px = x,
    py = y;
  for (let i = 0; i < 8; i++) {
    gerstnerAt(waves, px, py, t, gravity, scratch);
    const ex = px + scratch[0] - x,
      ey = py + scratch[1] - y;
    if (Math.abs(ex) + Math.abs(ey) < 1e-9) break;
    // how the carried point moves as the still one does: one, less each wave's gathering along its own way
    let a = 1,
      b = 0,
      d = 1;
    for (const w of waves) {
      const k = (2 * Math.PI) / w.wavelength;
      const ux = Math.cos(w.direction),
        uy = Math.sin(w.direction);
      const s = Math.min(Math.max(w.steepness, 0), 1);
      const g = s * Math.sin(k * (ux * px + uy * py) - Math.sqrt(gravity * k) * t);
      a -= g * ux * ux;
      b -= g * ux * uy;
      d -= g * uy * uy;
    }
    const det = a * d - b * b;
    if (Math.abs(det) < 1e-9) break;
    px -= (d * ex - b * ey) / det;
    py -= (a * ey - b * ex) / det;
  }
  gerstnerAt(waves, px, py, t, gravity, scratch);
  return scratch[2];
}

/**
 * The same sum in WGSL, for the clear pass's vertex stage: the waves are `cw.waves`, two vec4s a slot as `packWaves`
 * writes them. It gives how far the point moves in x, y and z, and the surface's normal there.
 */
export const WAVES_WGSL = `
const WAVE_SLOTS: u32 = ${WAVE_SLOTS}u;
struct Swell { moved: vec3f, normal: vec3f, any: bool };
fn gerstner(p: vec2f, t: f32) -> Swell {
  var s: Swell;
  s.moved = vec3f(0.0);
  var tilt = vec2f(0.0);
  var squash = 0.0;
  s.any = false;
  for (var i = 0u; i < WAVE_SLOTS; i++) {
    let a = cw.waves[i * 2u];
    let b = cw.waves[i * 2u + 1u];
    if (a.w == 0.0 && b.x == 0.0) { continue; }
    s.any = true;
    let phase = a.z * dot(a.xy, p) - b.y * t;
    let c = cos(phase);
    let sn = sin(phase);
    s.moved += vec3f(a.xy * (b.x / a.z) * c, a.w * sn);
    tilt += a.xy * a.z * a.w * c;
    squash += b.x * sn;
  }
  s.normal = normalize(vec3f(-tilt, max(1.0 - squash, 1.0e-3)));
  return s;
}
`;
