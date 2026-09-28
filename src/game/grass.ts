/**
 * Grass, as a game describes it and as it grows, without a device.
 *
 * A game hands over a field: a grid over its ground saying which kind of
 * grass grows in each cell (none, where the cup is cut or a rail stands)
 * and how high the ground is there, a table of kinds, and a seed. The
 * blades are never listed. Each kind's blades sit on a jittered lattice
 * anchored to the grid, a chunk of sixteen cells at a time, and where each
 * stands, and everything else about it, comes from a hash of its place in
 * that lattice and the seed. The GPU grows them again every frame from the
 * same hash (`grass-pass.ts`), so a field of a million blades costs no
 * memory and no time at boot; this is the same growth in TypeScript, which
 * the tests read, and a test on a device holds the two to each other. A
 * change to one that is not made to the other fails that test.
 *
 * Here too is what is kept at a distance, the wind's gusts, and the
 * trample: the pure halves of what the pass draws, each tested under node,
 * since on a device a blade in the cup or a track that never recovers has
 * no symptom but the picture.
 */
import type { Vec3 } from '../geom/types';

export type Rgb = [number, number, number];

/** One kind of grass: a mown green, a fairway, a rough. Lengths are in the world's own units. */
export interface GrassKind {
  /** Blades a square unit. */
  density: number;
  /** A blade's height, and how much it varies either way as a fraction of it. */
  height: number;
  heightSpread?: number;
  /** A blade's width at its root. It is widened to a pixel on screen, whatever this says. */
  width: number;
  /** The colour at the root, which is the darkening into the ground, and at the tip. */
  base: Rgb;
  tip: Rgb;
  /** How much each blade's colour differs from the next, as a fraction. */
  variation?: number;
  roughness?: number;
  /** How far a blade leans at rest: nought upright, one lying down. */
  lean?: number;
  /** How much the wind moves it: nought for a mown green's stiff short blades, one for long grass. */
  give?: number;
  /**
   * Mown in stripes: bands `width` across at `angle` radians from the X
   * axis, shifted along their normal by `offset`, leaning each way in turn
   * and made lighter and darker by `shade` between them.
   */
  stripes?: { width: number; angle: number; offset?: number; shade: number };
}

/** A field of grass: a grid over the ground, what grows in each cell and how high it is there. */
export interface GrassField {
  /** The grid's corner, in world X and Y, the size of a cell, and how many there are each way. */
  origin: [number, number];
  cell: number;
  cols: number;
  rows: number;
  /** Row by row from the origin: one more than the index of the kind in each cell, nought for none. */
  mask: Uint8Array;
  /** The ground's height in each cell, which its blades stand on. */
  heights: Float32Array;
  /** At most eight. */
  kinds: GrassKind[];
  /** What grows beyond the grid, out to the far distance, and at what height. Left out, nothing. */
  outside?: { kind: number; height: number };
  seed: number;
}

/** Where the game may press the grass down, and how long a press takes to stand again, in seconds. */
export interface TrampleRect {
  origin: [number, number];
  cell: number;
  cols: number;
  rows: number;
  recovery?: number;
}

export interface GrassOptions {
  /** Blades drawn a frame at most. More than this are not drawn. */
  capacity?: number;
  /** Every blade inside `near`; one triangle past `mid`; none past `far`. From the tallest kind if left out. */
  near?: number;
  mid?: number;
  far?: number;
  /** Whether the blades cast into the sun's shadow map. Off by default: see the spec. */
  shadows?: boolean;
  trample?: TrampleRect;
  /** How dark a blade pressed flat goes, as a share of its colour. */
  pressShade?: number;
}

/** The wind: which way it blows across the ground, how hard (1 bends long grass a radian at a gust's peak), and its gusts' size and speed. */
export interface Wind {
  direction: [number, number];
  strength: number;
  gustSize: number;
  gustSpeed: number;
}

export const STILL: Wind = { direction: [1, 0], strength: 0, gustSize: 20, gustSpeed: 4 };

/** Kinds a field may have. The pass's table of them is this long. */
export const MAX_KINDS = 8;
/** Cells a side a grid may have, which is a mask and a height texture that size. */
export const MAX_SIDE = 1024;
/** Cells a side of a chunk: what the CPU culls, and a workgroup of the GPU's grows. */
export const CHUNK = 16;
/** Lattice points a side a chunk may have: the lattice coordinates are packed a byte each into a blade's key. */
export const MAX_LATTICE = 255;
/** Presses a frame, at most. */
export const PRESSES_A_FRAME = 64;
/** Texels a trample may have: sixteen bytes each. */
export const MAX_TRAMPLE = 1024 * 1024;
/** The share of the kept rank over which a blade shrinks to nothing, rather than blinking out. */
export const BAND = 0.1;
/** The most a blade bends, from rest, the wind and a press together: eighty degrees. */
export const MAX_BEND = 1.4;
/** How far past its rank a blade is widened, at most, to hold the field's colour as it thins. */
const MOST_WIDENED = 3;
/** The default capacity: four megabytes of blades. */
export const CAPACITY = 262144;

/** A field that cannot be what it says is refused here, where it is handed over, rather than drawn wrong. */
export function checkField(f: GrassField, options: GrassOptions = {}): void {
  const whole = (n: number) => Number.isInteger(n) && n > 0;
  if (!whole(f.cols) || !whole(f.rows) || f.cols > MAX_SIDE || f.rows > MAX_SIDE)
    throw new Error(`grass: a field is 1 to ${MAX_SIDE} cells a side, not ${f.cols} by ${f.rows}`);
  if (!(f.cell > 0)) throw new Error(`grass: a cell must have a size, not ${f.cell}`);
  const n = f.cols * f.rows;
  if (f.mask.length !== n) throw new Error(`grass: the mask has ${f.mask.length} cells where the field has ${n}`);
  if (f.heights.length !== n) throw new Error(`grass: the heights have ${f.heights.length} cells where the field has ${n}`);
  if (!f.kinds.length || f.kinds.length > MAX_KINDS) throw new Error(`grass: a field has 1 to ${MAX_KINDS} kinds, not ${f.kinds.length}`);
  for (let i = 0; i < n; i++) {
    if (f.mask[i] > f.kinds.length) throw new Error(`grass: the mask names kind ${f.mask[i] - 1} at cell ${i}, and there are ${f.kinds.length}`);
    if (!Number.isFinite(f.heights[i])) throw new Error(`grass: the height at cell ${i} is not a number`);
  }
  const size = CHUNK * f.cell;
  f.kinds.forEach((k, i) => {
    if (!(k.density > 0)) throw new Error(`grass: kind ${i} has a density of ${k.density}`);
    if (Math.round(size * Math.sqrt(k.density)) > MAX_LATTICE)
      throw new Error(`grass: kind ${i}'s density is more than a chunk holds: at most ${Math.floor((MAX_LATTICE / size) ** 2)} a square unit at this cell size`);
    if (!(k.height > 0)) throw new Error(`grass: kind ${i} has a height of ${k.height}`);
    if (!(k.width > 0)) throw new Error(`grass: kind ${i} has a width of ${k.width}`);
  });
  if (f.outside && (!Number.isInteger(f.outside.kind) || f.outside.kind < 0 || f.outside.kind >= f.kinds.length || !Number.isFinite(f.outside.height)))
    throw new Error(`grass: the outside names kind ${f.outside.kind}, and there are ${f.kinds.length}`);
  const { near, mid, far } = levels(f, options);
  if (!(near > 0 && near <= mid && mid <= far)) throw new Error(`grass: near, mid and far must rise from nought: ${near}, ${mid}, ${far}`);
  if (options.capacity !== undefined && !(Number.isInteger(options.capacity) && options.capacity > 0 && options.capacity <= 16 * CAPACITY))
    throw new Error(`grass: capacity is 1 to ${16 * CAPACITY} blades, not ${options.capacity}`);
  const t = options.trample;
  if (t && (!whole(t.cols) || !whole(t.rows) || t.cols * t.rows > MAX_TRAMPLE || t.cols > 8192 || t.rows > 8192 || !(t.cell > 0) || (t.recovery !== undefined && !(t.recovery > 0))))
    throw new Error(`grass: a trample is at most ${MAX_TRAMPLE} texels of a size, with a recovery, not ${t.cols} by ${t.rows} of ${t.cell}`);
}

/** The distances the field thins over: what the options say, or else from its tallest kind. */
export function levels(f: GrassField, options: GrassOptions = {}): { near: number; mid: number; far: number } {
  const tallest = Math.max(...f.kinds.map((k) => k.height * (1 + (k.heightSpread ?? 0.3))));
  const h = tallest / 1.3;
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  return { near: options.near ?? round(50 * h), mid: options.mid ?? round(110 * h), far: options.far ?? round(375 * h) };
}

/**
 * A 32-bit integer hash, the particles' and the pass's own: every blade's
 * chance is read from it rather than from a generator, so nothing has to
 * remember a state and the GPU needs nothing handed to it but the seed.
 */
export function hash(n: number): number {
  let x = (Math.imul(n >>> 0, 747796405) + 2891336453) >>> 0;
  x = Math.imul(((x >>> ((x >>> 28) + 4)) ^ x) >>> 0, 277803737) >>> 0;
  return ((x >>> 22) ^ x) >>> 0;
}

/** A hash as a number from nought to under one, from its top 24 bits: exact in a 32-bit float, so the GPU has the same. */
export function unit(h: number): number {
  return (h >>> 8) / 16777216;
}

/** A blade's key: its chunk, its kind and its place in the chunk's lattice, hashed with the seed. */
export function bladeKey(seed: number, cx: number, cy: number, kind: number, a: number, b: number): number {
  let h = hash(seed);
  h = hash((h + (cx >>> 0)) >>> 0);
  h = hash((h + (cy >>> 0)) >>> 0);
  return hash((h + ((kind << 16) | (a << 8) | b)) >>> 0);
}

/** How many lattice points a side a chunk `size` units across has for `kind`. */
export function lattice(kind: GrassKind, size: number): number {
  return Math.max(1, Math.min(MAX_LATTICE, Math.round(size * Math.sqrt(kind.density))));
}

/**
 * A blade as it grows: where its root is, which kind it is, its id, and
 * its rank for thinning. The id is its key with the kind in its lowest
 * three bits, which is all the GPU keeps of a blade besides where it
 * stands: everything else about it is hashed from the id again.
 */
export interface Blade {
  x: number;
  y: number;
  z: number;
  kind: number;
  id: number;
  rank: number;
}

/** A blade's id: its key with its kind in the lowest three bits. */
export function bladeId(key: number, kind: number): number {
  return ((key & ~7) | kind) >>> 0;
}

/**
 * Every blade of `kind` in chunk (cx, cy), before any is thinned by
 * distance. The chunk's lattice point (a, b) is jittered within its own
 * square to a 256th of it, so which cell it lands in is integer arithmetic,
 * the same on the GPU to the cell; only the position within the cell is
 * float, and a 32-bit float's.
 */
export function bladesIn(f: GrassField, cx: number, cy: number, kind: number): Blade[] {
  const size = CHUNK * f.cell;
  const n = lattice(f.kinds[kind], size);
  const out: Blade[] = [];
  for (let b = 0; b < n; b++)
    for (let a = 0; a < n; a++) {
      const key = bladeKey(f.seed, cx, cy, kind, a, b);
      const at = bladeAt(f, cx, cy, n, key, a, b);
      if (!at || at.kind !== kind) continue;
      const id = bladeId(key, kind);
      out.push({ x: at.x, y: at.y, z: at.z, kind, id, rank: unit(hash((id + 1) >>> 0)) });
    }
  return out;
}

/** Where the blade of `key` at lattice point (a, b) stands, and what grows there: none if nothing does. */
function bladeAt(f: GrassField, cx: number, cy: number, n: number, key: number, a: number, b: number) {
  const h = hash(key);
  const qa = a * 256 + (h & 255), qb = b * 256 + ((h >>> 8) & 255);
  const gx = cx * CHUNK + Math.floor((qa * CHUNK) / (256 * n));
  const gy = cy * CHUNK + Math.floor((qb * CHUNK) / (256 * n));
  let kind: number, z: number;
  if (gx >= 0 && gy >= 0 && gx < f.cols && gy < f.rows) {
    kind = f.mask[gy * f.cols + gx] - 1;
    z = f.heights[gy * f.cols + gx];
  } else if (f.outside) {
    kind = f.outside.kind;
    z = f.outside.height;
  } else return null;
  if (kind < 0) return null;
  const fr = Math.fround;
  const size = fr(CHUNK * f.cell), span = fr(256 * n);
  const x = fr(fr(fr(cx + fr(fr(qa) / span)) * size) + fr(f.origin[0]));
  const y = fr(fr(fr(cy + fr(fr(qb) / span)) * size) + fr(f.origin[1]));
  return { x, y, z, kind };
}

/**
 * Which kinds grow in each chunk of the grid, a bit each, so the CPU sends
 * the GPU only chunks with something in them; and the lowest and highest
 * the ground goes, outside included, which bound every chunk's box. Worked
 * out once when a field is set, not every frame.
 */
export function chunkKinds(f: GrassField): { cols: number; rows: number; bits: Uint8Array; lo: number; hi: number } {
  const cols = Math.ceil(f.cols / CHUNK), rows = Math.ceil(f.rows / CHUNK);
  const bits = new Uint8Array(cols * rows);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < f.heights.length; i++) { lo = Math.min(lo, f.heights[i]); hi = Math.max(hi, f.heights[i]); }
  if (f.outside) { lo = Math.min(lo, f.outside.height); hi = Math.max(hi, f.outside.height); }
  for (let j = 0; j < f.rows; j++)
    for (let i = 0; i < f.cols; i++) {
      const m = f.mask[j * f.cols + i];
      if (m) bits[Math.floor(j / CHUNK) * cols + Math.floor(i / CHUNK)] |= 1 << (m - 1);
    }
  return { cols, rows, bits, lo, hi };
}

/**
 * The six planes of a camera's frustum from its view-projection (column
 * major, depth nought to one as WebGPU clips it), each as a normal and a
 * distance, normalised, inside where it is positive: left, right, bottom,
 * top, near, far.
 */
export function frustumPlanes(m: Float32Array, out = new Float32Array(24)): Float32Array {
  const row = (i: number) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
  const [r0, r1, r2, r3] = [row(0), row(1), row(2), row(3)];
  const planes = [
    r3.map((v, k) => v + r0[k]), r3.map((v, k) => v - r0[k]),
    r3.map((v, k) => v + r1[k]), r3.map((v, k) => v - r1[k]),
    r2, r3.map((v, k) => v - r2[k]),
  ];
  planes.forEach((p, i) => {
    const l = Math.hypot(p[0], p[1], p[2]) || 1;
    out.set([p[0] / l, p[1] / l, p[2] / l, p[3] / l], i * 4);
  });
  return out;
}

/**
 * The chunks the camera sees within `far`, as entries of four integers
 * (chunk x, chunk y, kind, lattice a side), one for each kind grown in the
 * chunk, into `out`: how many. Beyond the grid, only if the field has an
 * outside. When `out` is full the rest are left out, never grown into.
 */
export function visibleChunks(f: GrassField, chunks: ReturnType<typeof chunkKinds>, planes: Float32Array, eye: Vec3 | number[], far: number, out: Int32Array): number {
  const size = CHUNK * f.cell;
  const cap = Math.floor(out.length / 4);
  const lo = chunks.lo;
  const hi = chunks.hi + Math.max(...f.kinds.map((k) => k.height * (1 + (k.heightSpread ?? 0.3)))) + size * 0.25;
  const [ox, oy] = f.origin;
  let x0 = Math.floor((eye[0] - far - ox) / size), x1 = Math.floor((eye[0] + far - ox) / size);
  let y0 = Math.floor((eye[1] - far - oy) / size), y1 = Math.floor((eye[1] + far - oy) / size);
  if (!f.outside) {
    x0 = Math.max(x0, 0); y0 = Math.max(y0, 0);
    x1 = Math.min(x1, chunks.cols - 1); y1 = Math.min(y1, chunks.rows - 1);
  }
  const lattices = f.kinds.map((k) => lattice(k, size));
  let count = 0;
  for (let cy = y0; cy <= y1; cy++)
    for (let cx = x0; cx <= x1; cx++) {
      const bx = ox + cx * size, by = oy + cy * size;
      // the nearest point of the chunk's box to the eye, and whether that is within reach
      const nx = Math.max(bx, Math.min(eye[0], bx + size)), ny = Math.max(by, Math.min(eye[1], by + size)), nz = Math.max(lo, Math.min(eye[2], hi));
      if (Math.hypot(nx - eye[0], ny - eye[1], nz - eye[2]) > far) continue;
      if (!boxInFrustum(planes, bx, by, lo, bx + size, by + size, hi)) continue;
      const inGrid = cx >= 0 && cy >= 0 && cx < chunks.cols && cy < chunks.rows;
      let bits = inGrid ? chunks.bits[cy * chunks.cols + cx] : 0;
      const whollyIn = inGrid && (cx + 1) * CHUNK <= f.cols && (cy + 1) * CHUNK <= f.rows;
      if (f.outside && !whollyIn) bits |= 1 << f.outside.kind;
      for (let k = 0; bits; k++, bits >>= 1) {
        if (!(bits & 1)) continue;
        if (count >= cap) return count;
        out.set([cx, cy, k, lattices[k]], count * 4);
        count++;
      }
    }
  return count;
}

/** Whether a box is at least partly inside every plane: its corner furthest along each plane's normal is inside. */
function boxInFrustum(p: Float32Array, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
  for (let i = 0; i < 24; i += 4) {
    const x = p[i] >= 0 ? x1 : x0, y = p[i + 1] >= 0 ? y1 : y0, z = p[i + 2] >= 0 ? z1 : z0;
    if (p[i] * x + p[i + 1] * y + p[i + 2] * z + p[i + 3] < 0) return false;
  }
  return true;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * The share of blades kept at distance `d`: all of them inside `near`, then
 * falling with the square of the distance, so each ring out from the camera
 * holds about as many as the one before and a field to the horizon costs
 * what its near part does, and faded to none by `far`. `density` is the
 * economy's: half keeps the blades of the lower half of the ranks, which is
 * the same blades the distance would take, and never another set.
 */
export function keep(d: number, near: number, far: number, density = 1): number {
  const base = d <= near ? 1 : (near / d) ** 2;
  return base * (1 - smoothstep(far * 0.75, far, d)) * density;
}

/**
 * How tall a blade of `rank` stands where `kept` of them are kept, as a
 * share of its height: whole well within the kept ranks, shrinking to
 * nothing over the band past them, so a blade sinks into the ground as the
 * camera draws back rather than blinking out.
 */
export function shrink(rank: number, kept: number): number {
  return Math.max(0, Math.min(1, (kept * (1 + BAND) - rank) / BAND));
}

/** How much wider a kept blade is drawn where only `kept` of them are, so the field's colour holds as it thins. */
export function widen(kept: number): number {
  return Math.min(MOST_WIDENED, 1 / Math.sqrt(Math.max(kept, 1 / MOST_WIDENED ** 2)));
}

function noise2(u: number, v: number): number {
  const iu = Math.floor(u), iv = Math.floor(v);
  const fu = u - iu, fv = v - iv;
  const su = fu * fu * (3 - 2 * fu), sv = fv * fv * (3 - 2 * fv);
  const at = (i: number, j: number) => unit(hash((hash(i >>> 0) + (j >>> 0)) >>> 0));
  const a = at(iu, iv) + (at(iu + 1, iv) - at(iu, iv)) * su;
  const b = at(iu, iv + 1) + (at(iu + 1, iv + 1) - at(iu, iv + 1)) * su;
  return a + (b - a) * sv;
}

/**
 * How much of a gust is at (x, y) at `time`, nought to one: two octaves of
 * value noise over the ground, carried downwind at the gust's speed, so a
 * gust is seen to cross the field. Only `time` moves it, which is the
 * game's own, so the same moment is the same picture.
 */
export function gust(x: number, y: number, wind: Wind, time: number): number {
  const l = Math.hypot(wind.direction[0], wind.direction[1]);
  const [dx, dy] = l > 0 ? [wind.direction[0] / l, wind.direction[1] / l] : [1, 0];
  const size = Math.max(wind.gustSize, 1e-6);
  const u = (x * dx + y * dy - wind.gustSpeed * time) / size, v = (-x * dy + y * dx) / size;
  return 0.65 * noise2(u, v) + 0.35 * noise2(2 * u + 5.2, 2 * v + 1.3);
}

/**
 * How far the wind bends a blade of `give` at (x, y), in radians: the gust
 * there, and a flutter at the blade's own `phase` so neighbours are not in
 * step. Nothing, when the wind is still.
 */
export function bend(give: number, wind: Wind, x: number, y: number, time: number, phase = 0): number {
  const s = give * wind.strength;
  if (!s) return 0;
  return s * (0.25 + 0.75 * gust(x, y, wind, time)) + 0.1 * s * Math.sin(2 * Math.PI * (3 * time + phase));
}

/**
 * The colour a blade of `kind` averages to, root to tip: what the game
 * should paint the ground under it, so the gaps between blades and the
 * fade past the far distance do not show. A blade's colour runs along
 * u^0.7, which averages to 1/1.7 of the way. Weighing it by the blade's
 * area, widest at its dark root, was tried and matched the screen worse
 * (seven levels off the bare ground against one and a half), since from
 * three-quarters above more of a blade's upper part is seen than its area
 * says; `grass.gpu.test.ts` holds the match on screen.
 */
export function grassGround(kind: GrassKind): Rgb {
  return [0, 1, 2].map((c) => kind.base[c] + (kind.tip[c] - kind.base[c]) / 1.7) as Rgb;
}

/**
 * Where the grass has been pressed down: a grid over the ground the game
 * says the ball can reach, each texel holding when it was pressed, how
 * deep, and which way the blades lie. The depth at any moment is worked out
 * from how long ago that was, here and in the pass alike, so recovering
 * costs nothing while nothing is pressed and a paused game holds its track.
 *
 * It is allocated once and never grown. What a frame pressed is sent to the
 * GPU as one rectangle, taken by `take`.
 */
export class Trample {
  /** Four floats a texel, row by row: when it was pressed, how deep, and the way it lies. */
  readonly data: Float32Array;
  readonly recovery: number;
  private presses = 0;
  private dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;

  constructor(readonly rect: TrampleRect) {
    this.data = new Float32Array(rect.cols * rect.rows * 4);
    this.recovery = rect.recovery ?? 6;
  }

  /**
   * Press a disc of `radius` at (x, y) at `time`, the blades lying toward
   * (dx, dy): full inside half the radius, softening to nothing at it. A
   * texel is written only where this presses deeper than what is left of
   * the last press there, so a light touch never erases a fresh track.
   * False, and nothing done, off the grid or past the frame's presses.
   */
  press(x: number, y: number, radius: number, dx: number, dy: number, time: number): boolean {
    const { origin, cell, cols, rows } = this.rect;
    if (this.presses >= PRESSES_A_FRAME || !(radius > 0)) return false;
    const i0 = Math.max(0, Math.floor((x - radius - origin[0]) / cell)), i1 = Math.min(cols, Math.ceil((x + radius - origin[0]) / cell));
    const j0 = Math.max(0, Math.floor((y - radius - origin[1]) / cell)), j1 = Math.min(rows, Math.ceil((y + radius - origin[1]) / cell));
    if (i0 >= i1 || j0 >= j1) return false;
    this.presses++;
    const l = Math.hypot(dx, dy);
    const [ux, uy] = l > 0 ? [dx / l, dy / l] : [0, 0];
    for (let j = j0; j < j1; j++)
      for (let i = i0; i < i1; i++) {
        const d = Math.hypot(origin[0] + (i + 0.5) * cell - x, origin[1] + (j + 0.5) * cell - y);
        const depth = 1 - smoothstep(radius * 0.5, radius, d);
        if (depth <= 0 || depth <= this.depth(i, j, time)) continue;
        this.data.set([time, depth, ux, uy], (j * cols + i) * 4);
      }
    const d = this.dirty;
    this.dirty = d ? { x0: Math.min(d.x0, i0), y0: Math.min(d.y0, j0), x1: Math.max(d.x1, i1), y1: Math.max(d.y1, j1) } : { x0: i0, y0: j0, x1: i1, y1: j1 };
    return true;
  }

  /** How deep texel (i, j) is pressed at `time`: nothing before it was pressed, and nothing once it has recovered. */
  depth(i: number, j: number, time: number): number {
    const o = (j * this.rect.cols + i) * 4;
    const when = this.data[o], depth = this.data[o + 1];
    if (depth <= 0 || time < when) return 0;
    return depth * (1 - smoothstep(0, this.recovery, time - when));
  }

  /** How deep the grass at (x, y) is pressed at `time`. */
  depthAt(x: number, y: number, time: number): number {
    const t = this.texel(x, y);
    return t ? this.depth(t[0], t[1], time) : 0;
  }

  /** Which way the grass at (x, y) was last pressed to lie. */
  direction(x: number, y: number): [number, number] {
    const t = this.texel(x, y);
    if (!t) return [0, 0];
    const o = (t[1] * this.rect.cols + t[0]) * 4;
    return [this.data[o + 2], this.data[o + 3]];
  }

  private texel(x: number, y: number): [number, number] | null {
    const { origin, cell, cols, rows } = this.rect;
    const i = Math.floor((x - origin[0]) / cell), j = Math.floor((y - origin[1]) / cell);
    return i >= 0 && j >= 0 && i < cols && j < rows ? [i, j] : null;
  }

  /** Nothing pressed anywhere, for a new hole; all of it to be sent again. */
  clear() {
    this.data.fill(0);
    this.dirty = { x0: 0, y0: 0, x1: this.rect.cols, y1: this.rect.rows };
  }

  /** The texels pressed since the last take, ends exclusive, or none; and a new frame's presses begin. */
  take(): { x0: number; y0: number; x1: number; y1: number } | null {
    const d = this.dirty;
    this.dirty = null;
    this.presses = 0;
    return d;
  }
}

/** Floats in the pass's uniform: see `grassUniform` for what is where. */
export const GRASS_FLOATS = 60;
/** Floats a kind in the pass's table of kinds: five vec4s. */
export const KIND_FLOATS = 20;

/** What the pass is told each frame besides the field: where the eye is and what it sees, and the game's own moment. */
export interface GrassFrame {
  eye: Vec3 | number[];
  planes: Float32Array;
  /** World units a pixel spans at a distance of one, so a blade can be widened to a pixel wherever it is. */
  pixel: number;
  /** The economy's share of the blades. */
  density: number;
  wind: Wind;
  time: number;
}

/**
 * The pass's uniform, as the WGSL struct `Grass` reads it: the eye and the
 * near distance; the grid's origin, cell and the middle distance; its size,
 * a chunk's and the far distance; the outside's kind (-1 for none) and
 * height, the density and a pixel's span; the seed and the capacity as
 * integers; the wind; its gusts' speed, the time, the press's shade and
 * the trample's recovery; the trample's rectangle and whether there is
 * one; and the six planes of the frustum.
 */
export function grassUniform(out: Float32Array, f: GrassField, options: GrassOptions, frame: GrassFrame, capacity: number): Float32Array {
  const { near, mid, far } = levels(f, options);
  const w = frame.wind;
  const l = Math.hypot(w.direction[0], w.direction[1]);
  const t = options.trample;
  out.fill(0);
  out.set([frame.eye[0], frame.eye[1], frame.eye[2], near], 0);
  out.set([f.origin[0], f.origin[1], f.cell, mid], 4);
  out.set([f.cols, f.rows, CHUNK * f.cell, far], 8);
  out.set([f.outside ? f.outside.kind : -1, f.outside?.height ?? 0, frame.density, frame.pixel], 12);
  new Uint32Array(out.buffer, out.byteOffset + 16 * 4, 2).set([f.seed >>> 0, capacity >>> 0]);
  out.set([l > 0 ? w.direction[0] / l : 1, l > 0 ? w.direction[1] / l : 0, w.strength, Math.max(w.gustSize, 1e-6)], 20);
  out.set([w.gustSpeed, frame.time, options.pressShade ?? 0.7, t?.recovery ?? 6], 24);
  if (t) {
    out.set([t.origin[0], t.origin[1], t.cell, 1], 28);
    out.set([t.cols, t.rows], 32);
  }
  out.set(frame.planes.subarray(0, 24), 36);
  return out;
}

/**
 * The table of kinds, as the WGSL array of `Kind` reads it, five vec4s
 * each: the root colour and height; the tip colour and the height's
 * spread; the width, the variation, the roughness and the lean at rest;
 * the give, and the stripes' width (nought for none), angle and offset;
 * and the stripes' shade.
 */
export function kindsUniform(kinds: GrassKind[], out = new Float32Array(MAX_KINDS * KIND_FLOATS)): Float32Array {
  out.fill(0);
  kinds.forEach((k, i) => {
    const o = i * KIND_FLOATS, st = k.stripes;
    out.set([...k.base, k.height, ...k.tip, k.heightSpread ?? 0.3, k.width, k.variation ?? 0.15, k.roughness ?? 0.85, k.lean ?? 0.2,
      k.give ?? 1, st ? st.width : 0, st?.angle ?? 0, st?.offset ?? 0, st?.shade ?? 0], o);
  });
  return out;
}
