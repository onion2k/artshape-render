/**
 * The wash: air from a few sources, pushing the particles under it. A game
 * hands the renderer where a rotor's hub is and how hard it blows, and the
 * smoke beneath it is driven down and out as it would be by the real thing.
 *
 * The field is a sum written once here and once as WGSL built from the same
 * constants, so the shader cannot drift from what a test under node holds
 * it to; `wash.gpu.test.ts` holds the shader's to this on a device. Without
 * it the air would live in a shader string alone, where the only test is a
 * picture, and a falloff that reached past its source, or a column that
 * never ended, would be found by a player.
 *
 * Nothing here is asked for by a game that does not call `setWash`: with no
 * wash set the update pass skips all of it, and draws as it always did.
 */

/** A source of air, in the game's own units, as `GameRenderer.setWash` takes it. */
export interface Wash {
  /** Where the air comes from: a rotor's hub, say. World units. */
  position: [number, number, number];
  /** How wide the column of air is at the source. */
  radius: number;
  /** How fast the air moves at the source, world units a second. */
  speed: number;
  /** How far down from the source it reaches before it has spread and died. */
  reach: number;
}

/** How many washes a frame may have: what `setWash` is given past this is left out. */
export const WASH_CAPACITY = 4;
/** Floats a wash packs to: where and how wide, then how fast and how far. Two vec4s. */
export const WASH_STRIDE = 8;

/**
 * How much wider the column is at the end of its reach than at its source,
 * as a fraction of the radius: air leaving a rotor spreads as it falls, and
 * a column of one width all the way down would read as a pipe.
 */
export const WASH_SPREAD = 1.5;
/**
 * How far down its reach the air has begun to turn outward, as a share of
 * the reach. Above it the air is straight down; from it the air bends, and by
 * the end of the reach it is blowing flat across the ground.
 */
export const WASH_TURN_FROM = 0.3;
/**
 * How much of the air's own speed a floating particle settles to, and a
 * falling one. Smoke has no weight to keep it from the air and takes nearly
 * all of it; a drop is too heavy to be moved much by a breeze, and is let
 * feel a twenty-fifth. They are told apart by gravity, as drag is.
 */
export const WASH_FOLLOW_FLOAT = 0.9;
export const WASH_FOLLOW_FALL = 0.04;
/**
 * The shortest across the column that has a direction, in millimetres, below
 * which a point is on the axis and there is no outward to blow: converted to
 * the game's units where it is used.
 */
export const WASH_EPSILON_MM = 1;

/** The step from nothing to one, eased at both ends: the shader's own `smoothstep`. */
function smooth(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * How the air moves at `point`, the sum of every wash's. A wash blows straight
 * down under its source and turns outward as it nears the end of its reach;
 * it is weaker across the column and further down it, and nothing above the
 * source, past its reach or past the column's edge. `epsilon` is the width
 * under which a point is on the axis.
 */
export function washVelocity(washes: readonly Wash[], point: readonly [number, number, number], epsilon = 1e-6): [number, number, number] {
  let vx = 0, vy = 0, vz = 0;
  for (const w of washes) {
    const depth = w.position[2] - point[2];
    const t = depth / w.reach;
    if (depth < 0 || t >= 1) continue;
    const dx = point[0] - w.position[0], dy = point[1] - w.position[1];
    const across = Math.hypot(dx, dy);
    const width = w.radius * (1 + WASH_SPREAD * t);
    if (across >= width) continue;
    const strength = w.speed * (1 - smooth(0, 1, across / width)) * (1 - t);
    const turn = smooth(WASH_TURN_FROM, 1, t) * (Math.PI / 2);
    const out = strength * Math.sin(turn) / Math.max(across, epsilon);
    vx += dx * out; vy += dy * out; vz -= strength * Math.cos(turn);
  }
  return [vx, vy, vz];
}

/** How much of the air's speed a particle with this gravity settles to: smoke close to all of it, a drop hardly any. */
export function washFollow(gravity: number): number {
  const heavy = Math.min(1, Math.max(0, gravity));
  return WASH_FOLLOW_FLOAT + (WASH_FOLLOW_FALL - WASH_FOLLOW_FLOAT) * heavy;
}

/**
 * The washes packed for the GPU, `WASH_STRIDE` floats each, into `out`. A
 * wash that could blow nothing (no speed, no width, no reach) or is not a
 * number is left out and not counted as dropped, since it was never going to
 * do anything; of the rest, no more than `WASH_CAPACITY` are kept, the first
 * in order, and the others counted.
 */
export function packWashes(washes: readonly Wash[], out: Float32Array): { count: number; dropped: number } {
  let count = 0, dropped = 0;
  for (const w of washes) {
    const nums = [...w.position, w.radius, w.speed, w.reach];
    if (!nums.every(Number.isFinite) || w.radius <= 0 || w.speed <= 0 || w.reach <= 0) continue;
    if (count >= WASH_CAPACITY) { dropped++; continue; }
    out.set(nums, count * WASH_STRIDE);
    out[count * WASH_STRIDE + 6] = 0;
    out[count * WASH_STRIDE + 7] = 0;
    count++;
  }
  return { count, dropped };
}

const num = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

/**
 * The same field as WGSL. It reads a uniform array named `washes`, two vec4f
 * to a wash as `packWashes` lays them out, which the module including it
 * declares: the update pass does, and so does the test that holds this to
 * `washVelocity`.
 */
export const WASH_WGSL = `
fn washAt(p: vec3f, count: u32, epsilon: f32) -> vec3f {
  var v = vec3f(0.0);
  for (var i = 0u; i < count; i++) {
    let a = washes[i * 2u];
    let b = washes[i * 2u + 1u];
    let depth = a.z - p.z;
    let t = depth / b.y;
    if (depth < 0.0 || t >= 1.0) { continue; }
    let d = p.xy - a.xy;
    let across = length(d);
    let width = a.w * (1.0 + ${num(WASH_SPREAD)} * t);
    if (across >= width) { continue; }
    let strength = b.x * (1.0 - smoothstep(0.0, 1.0, across / width)) * (1.0 - t);
    let turn = smoothstep(${num(WASH_TURN_FROM)}, 1.0, t) * 1.5707963267949;
    let outward = strength * sin(turn) / max(across, epsilon);
    v += vec3f(d * outward, -strength * cos(turn));
  }
  return v;
}
fn washFollow(gravity: f32) -> f32 {
  return mix(${num(WASH_FOLLOW_FLOAT)}, ${num(WASH_FOLLOW_FALL)}, clamp(gravity, 0.0, 1.0));
}
`;

/**
 * Where the wind sits in the wash's uniform, in floats: after the washes, in
 * a vec4 of its own. Held in the same buffer so that a game that sets no wind
 * has one binding and one upload, as it had before the wind.
 */
export const WIND_AT = WASH_CAPACITY * WASH_STRIDE;

/**
 * The wind written to `out` at `WIND_AT`, a velocity in world units a second.
 * Returns whether it blows at all: a wind of nothing, or one that is not a
 * number in any of its parts (which is refused whole, as no wind and not as
 * the parts that were numbers), is written as noughts and says no, and the
 * update then skips every sum of it.
 */
export function packWind(out: Float32Array, wind: readonly [number, number, number]): boolean {
  const ok = wind.every(Number.isFinite) && wind.some((v) => v !== 0);
  for (let k = 0; k < 4; k++) out[WIND_AT + k] = ok && k < 3 ? wind[k] : 0;
  return ok;
}

/**
 * The air's velocity at `point`: the wind, which is the same everywhere, and
 * the wash's air on top of it. What a particle's drag pulls its velocity
 * toward, scaled by `washFollow`. `airAt` in `AIR_WGSL` is its WGSL, and
 * `wind.gpu.test.ts` holds the two equal.
 */
export function airVelocity(wind: readonly [number, number, number], washes: readonly Wash[], point: readonly [number, number, number], epsilon = 1e-6): [number, number, number] {
  const w = washVelocity(washes, point, epsilon);
  return [wind[0] + w[0], wind[1] + w[1], wind[2] + w[2]];
}

/** `airVelocity` in WGSL, after `WASH_WGSL`, which it calls: the wind is handed in, and `count` washes are read from `washes`. */
export const AIR_WGSL = `
fn airAt(p: vec3f, count: u32, epsilon: f32, wind: vec3f) -> vec3f {
  return wind + washAt(p, count, epsilon);
}
`;
