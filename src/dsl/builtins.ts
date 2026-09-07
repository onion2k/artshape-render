import {
  arc, bezier3, bow, catmullRom, ellipse, helix, lissajous, logSpiral, rose, sine, superellipse,
  torusKnot, type Curve,
} from '../geom/curve';
import type { Vec2, Vec3 } from '../geom/types';
import { leaf } from '../parts/leaf';
import { enamels, enamelNames, metalNames } from '../render/materials';
import {
  chevronOutline, circleOutline, fanOutline, keystoneOutline, lozengeOutline, polygonOutline,
  scallopOutline, stadiumOutline, sunburstOutline, tombstoneOutline, zigguratOutline,
  type LeafShape, type PetalEdge, type PetalShape,
} from '../geom/outline';
import { bead, bell, bud, collar, egg, pod, rivet } from '../parts/fastener';
import { petal } from '../parts/petal';
import { pearl } from '../parts/pearl';
import { gem, type GemCut } from '../parts/gem';
import { setting, type SettingStyle } from '../parts/setting';
import { shank } from '../parts/ring';
import { clasp } from '../parts/clasp';
import { jumpRing } from '../parts/jumpring';
import { leverBack } from '../parts/leverback';
import { bust, earringStand, easel, ringStand } from '../parts/display';
import { sword } from '../parts/sword';
import { axe } from '../parts/axe';
import { shield } from '../parts/shield';
import { branch, stem } from '../parts/stem';
import { band, blade, wire, type Section } from '../parts/wire';
import { bar, disc, gusset, plate } from '../parts/panel';
import { helicoidPart, mobiusPart, patchPart, ripplePart, saddlePart, shellPart } from '../parts/surface';
import { ENGRAVING_PATTERNS, type Engraving, type Inscription, type Part } from '../parts/types';
import {
  along, branching, compose, dihedral, helical, jitterSymmetry, mirror, nested, phyllotaxis, radial, ring, spray,
  sphereShell, type Symmetry,
} from '../pattern/symmetry';
import { DslError, type Span } from './lexer';

/**
 * A closed 2D outline, as a value a plate can be cut to. Plain data on purpose,
 * so the evaluator's memo key sees through it.
 */
export interface Outline { loop: Vec2[] }

/**
 * A number with play in it: uniform between centre - spread and centre +
 * spread. Where a plain number is wanted it is sampled once; a symmetry
 * that grows copies one by one draws a fresh sample for each, which is
 * what makes a grown form look grown.
 *
 * Every draw is seeded from the numbers themselves and the sketch's seed,
 * so the same rnd() written twice agrees — a tree's leaves follow its limbs
 * — and a sketch renders the same on every compile.
 */
export interface Jitter { centre: number; spread: number; seed: number }

export type Value = number | string | Vec3 | Curve | Outline | Engraving | Inscription | Part | Symmetry | Jitter;

export const isJitter = (v: Value): v is Jitter =>
  typeof v === 'object' && v !== null && typeof (v as Jitter).spread === 'number' && typeof (v as Jitter).centre === 'number';

/** A small fast PRNG (mulberry32) over a 32-bit seed. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mix numbers and a name into one 32-bit seed. */
function hashSeed(parts: Array<number | string>): number {
  let h = 2166136261;
  const mix = (n: number) => { h ^= n; h = Math.imul(h, 16777619) >>> 0; };
  for (const p of parts) {
    if (typeof p === 'string') { for (let i = 0; i < p.length; i++) mix(p.charCodeAt(i)); }
    else {
      const f = new Float64Array([p]);
      const u = new Uint32Array(f.buffer);
      mix(u[0]); mix(u[1]);
    }
  }
  return h >>> 0;
}

/**
 * Draws from a jitter, one stream per use. `stream` tells a builtin's
 * different parameters apart, so a spread and a twist written with the same
 * rnd() do not move in step.
 */
export function sampler(j: Jitter, stream = ''): () => number {
  const next = mulberry(hashSeed([j.centre, j.spread, j.seed, stream]));
  return () => j.centre + (next() * 2 - 1) * j.spread;
}

/** The single value a jitter stands for where only one number is wanted. */
export const sampleOnce = (j: Jitter, stream = ''): number => sampler(j, stream)();

export const isVec = (v: Value): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number');

export const isSymmetry = (v: Value): v is Symmetry =>
  Array.isArray(v) && (v.length === 0 || v[0] instanceof Float32Array);

export const isCurve = (v: Value): v is Curve =>
  typeof v === 'object' && v !== null && typeof (v as Curve).at === 'function';

export const isOutline = (v: Value): v is Outline =>
  typeof v === 'object' && v !== null && Array.isArray((v as Outline).loop);

export const isEngraving = (v: Value): v is Engraving =>
  typeof v === 'object' && v !== null && typeof (v as Engraving).pattern === 'string';

export const isInscription = (v: Value): v is Inscription =>
  typeof v === 'object' && v !== null && typeof (v as Inscription).script === 'string';

export const isPart = (v: Value): v is Part =>
  typeof v === 'object' && v !== null && 'mesh' in (v as Part) && 'anchors' in (v as Part);

export interface CallArg {
  name?: string;
  value: Value;
  span: Span;
}

/**
 * Argument reader for builtin calls.
 *
 * The point of `done()` is the error it produces: an unrecognised argument name
 * is the single most common thing to get wrong in a language like this, and
 * silently falling back to a default would leave someone staring at a shape that
 * ignored what they wrote.
 */
export type ParamKind = 'number' | 'word' | 'flag' | 'point' | 'path' | 'outline' | 'symmetry' | 'points';

/** What a builtin asked for, as recorded by a probe call. */
export interface ParamInfo {
  name: string;
  kind: ParamKind;
  required: boolean;
  fallback?: number | string | boolean;
  /** For words drawn from a fixed set. */
  choices?: readonly string[];
}

export class Args {
  private used = new Set<number>();
  /** Set on a probe: every read is noted and answered with a stand-in value. */
  recorder?: ParamInfo[];

  constructor(
    private callee: string,
    private args: CallArg[],
    readonly span: Span,
    private known: string[],
    /** The sketch's seed, mixed into every rnd() made here. */
    readonly seed = 0,
  ) {
    // Check names up front, not in done(). Otherwise a misspelled argument reads
    // as a missing one — "leaf needs width" when what was written was "widht" —
    // and points the writer at the wrong problem entirely.
    for (const arg of args) {
      if (arg.name && !known.includes(arg.name)) {
        throw new DslError(
          `${callee} has no "${arg.name}" — it takes ${known.join(', ')}`,
          arg.span,
        );
      }
    }
  }

  private find(name: string, positional: number): CallArg | undefined {
    for (let i = 0; i < this.args.length; i++) {
      if (this.args[i].name === name) { this.used.add(i); return this.args[i]; }
    }
    let seen = -1;
    for (let i = 0; i < this.args.length; i++) {
      if (this.args[i].name) continue;
      seen++;
      if (seen === positional) { this.used.add(i); return this.args[i]; }
    }
    return undefined;
  }

  private record(info: ParamInfo) {
    if (!this.recorder!.some((p) => p.name === info.name)) this.recorder!.push(info);
  }

  num(name: string, positional: number, fallback?: number): number {
    if (this.recorder) {
      this.record({ name, kind: 'number', required: fallback === undefined, fallback });
      return fallback === undefined || Number.isNaN(fallback) ? 1 : fallback;
    }
    const arg = this.find(name, positional);
    if (!arg) {
      if (fallback !== undefined) return fallback;
      throw new DslError(`${this.callee} needs "${name}"`, this.span);
    }
    if (isJitter(arg.value)) return sampleOnce(arg.value, `${this.callee}.${name}`);
    if (typeof arg.value !== 'number') {
      throw new DslError(`"${name}" must be a number in ${this.callee}`, arg.span);
    }
    return arg.value;
  }

  /**
   * A number to draw again and again: a fresh sample per call from an
   * rnd(), or the same value every time from a plain number. For the
   * builtins that make many copies and want each a little different.
   */
  sampler(name: string, positional: number, fallback?: number): () => number {
    if (this.recorder) {
      this.record({ name, kind: 'number', required: fallback === undefined, fallback });
      return () => (fallback === undefined || Number.isNaN(fallback) ? 1 : fallback);
    }
    const arg = this.find(name, positional);
    if (!arg) {
      if (fallback !== undefined) return () => fallback;
      throw new DslError(`${this.callee} needs "${name}"`, this.span);
    }
    if (isJitter(arg.value)) return sampler(arg.value, `${this.callee}.${name}`);
    if (typeof arg.value !== 'number') {
      throw new DslError(`"${name}" must be a number in ${this.callee}`, arg.span);
    }
    const value = arg.value;
    return () => value;
  }

  /** Like num(), but for a tessellation count that a generator divides by — segments, sides and the like are never 0 or negative. */
  count(name: string, positional: number, fallback: number): number {
    const n = this.num(name, positional, fallback);
    if (this.recorder) return n;
    if (n < 1) throw new DslError(`"${name}" must be at least 1 in ${this.callee}`, this.span);
    return n;
  }

  flag(name: string, positional: number, fallback: boolean): boolean {
    if (this.recorder) {
      this.record({ name, kind: 'flag', required: false, fallback });
      return fallback;
    }
    const arg = this.find(name, positional);
    if (!arg) return fallback;
    if (typeof arg.value === 'number') return arg.value !== 0;
    if (arg.value === 'yes' || arg.value === 'true') return true;
    if (arg.value === 'no' || arg.value === 'false') return false;
    throw new DslError(`"${name}" must be yes or no in ${this.callee}`, arg.span);
  }

  word(name: string, positional: number, fallback: string, choices?: readonly string[]): string {
    if (this.recorder) {
      this.record({ name, kind: 'word', required: false, fallback, choices });
      return fallback;
    }
    const arg = this.find(name, positional);
    if (!arg) return fallback;
    if (typeof arg.value !== 'string') {
      throw new DslError(`"${name}" must be a word in ${this.callee}`, arg.span);
    }
    return arg.value;
  }

  vec(name: string, positional: number, fallback?: Vec3): Vec3 {
    if (this.recorder) {
      this.record({ name, kind: 'point', required: fallback === undefined });
      return fallback ?? [0, 0, 0];
    }
    const arg = this.find(name, positional);
    if (!arg) {
      if (fallback) return fallback;
      throw new DslError(`${this.callee} needs a point for "${name}"`, this.span);
    }
    if (!isVec(arg.value)) {
      throw new DslError(`"${name}" must be a point like (0, 10, 2)`, arg.span);
    }
    return arg.value;
  }

  curve(name: string, positional: number): Curve {
    if (this.recorder) {
      this.record({ name, kind: 'path', required: true });
      return arc(1, 0, Math.PI * 2, 0);
    }
    const arg = this.find(name, positional);
    if (!arg) throw new DslError(`${this.callee} needs a path`, this.span);
    if (!isCurve(arg.value)) {
      throw new DslError(
        `"${name}" must be a path — try spiral, arc, circle, ellipse, helix, bezier, through, bow, lissajous, rhodonea, sine, knot or superellipse`,
        arg.span,
      );
    }
    return arg.value;
  }

  outline(name: string, positional: number, required = true): Outline | undefined {
    if (this.recorder) {
      this.record({ name, kind: 'outline', required });
      return required ? { loop: polygonOutline(4, 1) } : undefined;
    }
    const arg = this.find(name, positional);
    if (!arg) {
      if (!required) return undefined;
      throw new DslError(`${this.callee} needs an outline for "${name}"`, this.span);
    }
    if (!isOutline(arg.value)) {
      throw new DslError(
        `"${name}" must be an outline — try fan, chevron, sunburst, ziggurat, keystone, scallop, lozenge, polygon, roundel, stadium or card`,
        arg.span,
      );
    }
    return arg.value;
  }

  symmetry(name: string, positional: number): Symmetry {
    if (this.recorder) {
      this.record({ name, kind: 'symmetry', required: true });
      return radial(1);
    }
    const arg = this.find(name, positional);
    if (!arg) throw new DslError(`${this.callee} needs a symmetry for "${name}"`, this.span);
    if (!isSymmetry(arg.value)) {
      throw new DslError(`"${name}" must be a symmetry, like ring(8, radius: 20)`, arg.span);
    }
    return arg.value;
  }

  rest(): Value[] {
    if (this.recorder) {
      this.record({ name: this.known[this.known.length - 1] ?? 'values', kind: 'points', required: true });
      return [];
    }
    const out: Value[] = [];
    for (let i = 0; i < this.args.length; i++) {
      if (this.used.has(i) || this.args[i].name) continue;
      this.used.add(i);
      out.push(this.args[i].value);
    }
    return out;
  }

  done() {
    for (let i = 0; i < this.args.length; i++) {
      if (this.used.has(i)) continue;
      const arg = this.args[i];
      throw new DslError(
        `${this.callee} was given more values than it takes — it takes ${this.known.join(', ')}`,
        arg.span,
      );
    }
  }
}

type Builtin = (args: Args) => Value;

const define = (known: string[], fn: (a: Args) => Value) =>
  ({ known, fn }) as { known: string[]; fn: Builtin };

/** Curves. A wire or blade path is one of these. */
const CURVES = {
  spiral: define(['start', 'turns', 'growth', 'rise'], (a) =>
    logSpiral(a.num('start', 0), a.num('turns', 1), a.num('growth', 2, 2.4), a.num('rise', 3, 0))),

  arc: define(['radius', 'from', 'to', 'z'], (a) =>
    arc(a.num('radius', 0), a.num('from', 1, 0), a.num('to', 2, Math.PI), a.num('z', 3, 0))),

  circle: define(['radius', 'z'], (a) =>
    arc(a.num('radius', 0), 0, Math.PI * 2, a.num('z', 1, 0))),

  ellipse: define(['rx', 'ry', 'z'], (a) =>
    ellipse(a.num('rx', 0), a.num('ry', 1), a.num('z', 2, 0))),

  helix: define(['radius', 'height', 'turns'], (a) =>
    helix(a.num('radius', 0), a.num('height', 1), a.num('turns', 2, 1))),

  bezier: define(['a', 'b', 'c', 'd'], (a) =>
    bezier3(a.vec('a', 0), a.vec('b', 1), a.vec('c', 2), a.vec('d', 3))),

  bow: define(['a', 'b', 'sag'], (a) =>
    bow(a.vec('a', 0), a.vec('b', 1), a.num('sag', 2))),

  lissajous: define(['width', 'height', 'a', 'b', 'phase', 'rise'], (a) =>
    lissajous(
      a.num('width', 0), a.num('height', 1), a.num('a', 2, 1), a.num('b', 3, 2),
      a.num('phase', -1, Math.PI / 2), a.num('rise', -1, 0),
    )),

  // not "rose": that is a gem cut, and a bare word in a sketch
  rhodonea: define(['radius', 'petals', 'rise'], (a) =>
    rose(a.num('radius', 0), a.num('petals', 1, 5), a.num('rise', -1, 0))),

  sine: define(['length', 'amplitude', 'waves', 'rise'], (a) =>
    sine(a.num('length', 0), a.num('amplitude', 1), a.num('waves', 2, 3), a.num('rise', -1, 0))),

  knot: define(['radius', 'tube', 'p', 'q'], (a) =>
    torusKnot(a.num('radius', 0), a.num('tube', 1), a.num('p', 2, 2), a.num('q', 3, 3))),

  superellipse: define(['rx', 'ry', 'n', 'z'], (a) =>
    superellipse(a.num('rx', 0), a.num('ry', 1), a.num('n', 2, 2.5), a.num('z', -1, 0))),

  through: define(['points'], (a) => {
    const points = a.rest();
    if (points.length < 2) throw new DslError('through() needs at least two points', a.span);
    for (const p of points) {
      if (!isVec(p)) throw new DslError('through() takes points like (0, 10, 2)', a.span);
    }
    return catmullRom(points as Vec3[]);
  }),
};

/**
 * Outlines. A plate is cut to one of these. The deco set first, then the plain
 * geometric shapes the other flat parts are already cut from.
 */
const OUTLINES = {
  fan: define(['radius', 'spread', 'blades', 'bladeDepth', 'inner', 'segments'], (a) => ({
    loop: fanOutline(a.num('radius', 0), {
      spread: a.num('spread', -1, Math.PI),
      blades: a.num('blades', -1, 0),
      bladeDepth: a.num('bladeDepth', -1, 0.12),
      inner: a.num('inner', -1, 0),
      segments: a.count('segments', -1, 48),
    }),
  })),

  chevron: define(['width', 'rise', 'bar'], (a) => ({
    loop: chevronOutline(a.num('width', 0), a.num('rise', 1), a.num('bar', 2)),
  })),

  sunburst: define(['radius', 'rays', 'inner', 'tip', 'rotate'], (a) => ({
    loop: sunburstOutline(a.num('radius', 0), a.count('rays', 1, 12), {
      inner: a.num('inner', -1, 0.55),
      tip: a.num('tip', -1, 0),
      rotate: a.num('rotate', -1, Math.PI / 2),
    }),
  })),

  ziggurat: define(['width', 'height', 'steps', 'top'], (a) => {
    const width = a.num('width', 0);
    return { loop: zigguratOutline(width, a.num('height', 1), a.count('steps', 2, 3), a.num('top', -1, width * 0.4)) };
  }),

  keystone: define(['width', 'height', 'flare', 'corner', 'segments'], (a) => ({
    loop: keystoneOutline(
      a.num('width', 0), a.num('height', 1), a.num('flare', 2, 0.4),
      a.num('corner', -1, 0), a.count('segments', -1, 6),
    ),
  })),

  scallop: define(['radius', 'lobes', 'depth', 'segments'], (a) => {
    const radius = a.num('radius', 0);
    return { loop: scallopOutline(radius, a.count('lobes', 1, 8), a.num('depth', 2, radius * 0.1), a.count('segments', -1, 96)) };
  }),

  lozenge: define(['length', 'width', 'bulge', 'segments'], (a) => ({
    loop: lozengeOutline(a.num('length', 0), a.num('width', 1), a.num('bulge', 2, 0), a.count('segments', -1, 8)),
  })),

  polygon: define(['sides', 'radius', 'rotate'], (a) => ({
    loop: polygonOutline(a.count('sides', 0, 6), a.num('radius', 1), a.num('rotate', 2, Math.PI / 2)),
  })),

  roundel: define(['radius', 'segments'], (a) => ({
    loop: circleOutline(a.num('radius', 0), a.count('segments', -1, 64)),
  })),

  stadium: define(['length', 'width', 'segments'], (a) => ({
    loop: stadiumOutline(a.num('length', 0), a.num('width', 1), a.count('segments', -1, 14)),
  })),

  card: define(['width', 'height', 'corner', 'segments'], (a) => ({
    loop: tombstoneOutline(a.num('width', 0), a.num('height', 1), a.num('corner', 2, 0), a.count('segments', -1, 8)),
  })),
};

/**
 * Engravings. `part x = ... engraved hatch(scale: 0.6, depth: 0.05)` cuts the
 * pattern into x's surface. Each takes the same three: the pitch of its
 * features in millimetres, how deep the grooves go (negative raises them),
 * and a turn in the surface.
 */
const engravingOf = (pattern: Engraving['pattern'], defaultAngle = 0) =>
  define(['scale', 'depth', 'angle'], (a): Engraving => ({
    pattern,
    scale: a.num('scale', 0, 1),
    depth: a.num('depth', 1, 0.06),
    angle: a.num('angle', 2, defaultAngle),
  }));

const ENGRAVINGS = Object.fromEntries(
  ENGRAVING_PATTERNS.map((name) => [name, engravingOf(name, name === 'crosshatch' ? Math.PI / 4 : 0)]),
) as Record<Engraving['pattern'], ReturnType<typeof define>>;

const FONTS = ['serif', 'sans', 'mono'] as const;

/**
 * Lettering. `engraved text("1928", size: 4, depth: 0.08)` cuts the string
 * into a part's surface; `runes("odin")` spells it in Elder Futhark from the
 * Latin. Both centre on the face; `at` shifts the line from that middle, in
 * the face's own millimetres.
 */
const inscriptionOf = (script: Inscription['script']) =>
  define(['text', 'size', 'depth', 'angle', 'at', 'font'], (a): Inscription => {
    const at = a.vec('at', -1, [NaN, NaN, NaN]);
    return {
      script,
      text: a.word('text', 0, ''),
      size: a.num('size', 1, 4),
      depth: a.num('depth', 2, 0.08),
      angle: a.num('angle', -1, 0),
      font: oneOf(a, 'font', FONTS, 'serif'),
      at: Number.isNaN(at[0]) ? undefined : [at[0], at[1]],
    };
  });

const INSCRIPTIONS = { text: inscriptionOf('text'), runes: inscriptionOf('runes') };

/** Play. rnd(22deg, 3deg) is somewhere between 19 and 25 degrees, the same somewhere every compile. */
const RANDOM = {
  rnd: define(['centre', 'spread', 'seed'], (a): Jitter => ({
    centre: a.num('centre', 0),
    spread: Math.abs(a.num('spread', 1, 0)),
    seed: hashSeed([a.seed, a.num('seed', 2, 0)]),
  })),
};

/** An argument that may be absent (NaN) or deliberately zero — 0 must survive. */
const optional = (v: number) => (Number.isNaN(v) ? undefined : v);

/** An enamel colour by its trade name, checked here so a misspelling names the choices. */
function enamelName(a: Args): string | undefined {
  const name = a.word('enamel', -1, '', enamelNames);
  if (!name) return undefined;
  if (!enamels[name]) {
    throw new DslError(`there is no enamel called "${name}" — try ${enamelNames.join(', ')}`, a.span);
  }
  return name;
}

/** One of a fixed set of words, named in the error when it is not. */
function oneOf<T extends string>(a: Args, name: string, allowed: readonly T[], fallback: T): T {
  const word = a.word(name, -1, fallback, allowed);
  if (!allowed.includes(word as T)) {
    throw new DslError(`there is no ${name} called "${word}" — try ${allowed.join(', ')}`, a.span);
  }
  return word as T;
}

const GEM_CUTS = ['brilliant', 'oval', 'pear', 'marquise', 'trillion', 'step', 'baguette', 'rose', 'cabochon'] as const;
const SETTING_STYLES = ['claw', 'bezel'] as const;
const LEAF_SHAPES = ['ovate', 'lanceolate', 'elliptic', 'obovate', 'cordate', 'orbicular', 'linear', 'deltoid', 'spatulate'] as const;
const PETAL_SHAPES = ['round', 'pointed', 'spoon', 'strap', 'lip', 'quill'] as const;
const PETAL_EDGES = ['entire', 'toothed', 'fringed', 'crenate', 'notched'] as const;
const SECTIONS = ['round', 'square', 'hex', 'octagon', 'flat', 'lens'] as const;
const ORIENTS = ['outward', 'flat'] as const;

/** A metal for the vein wires of an enamelled plate; pearls are not wire. */
function veinMetalName(a: Args): string | undefined {
  const name = a.word('veinMetal', -1, '', metalNames);
  if (!name) return undefined;
  if (!metalNames.includes(name)) {
    throw new DslError(`there is no metal called "${name}" for veins — try ${metalNames.join(', ')}`, a.span);
  }
  return name;
}

/** Parts. Each call makes real geometry, so results are cached by the caller. */
const PARTS = {
  leaf: define(
    ['length', 'width', 'thickness', 'shape', 'bevel', 'piercings', 'veins', 'teeth',
     'toothDepth', 'lobes', 'spread', 'droop', 'cup', 'keel', 'curl', 'curlBias', 'twist',
     'relief', 'reliefVeins', 'boss', 'segments', 'enamel', 'veinMetal'],
    (a) => leaf({
      length: a.num('length', 0),
      width: a.num('width', 1),
      thickness: a.num('thickness', 2, 1.1),
      shape: oneOf(a, 'shape', LEAF_SHAPES, 'ovate') as LeafShape,
      bevel: a.num('bevel', -1, NaN) || undefined,
      piercings: a.num('piercings', -1, 0) || undefined,
      veins: a.num('veins', -1, 0) || undefined,
      teeth: a.num('teeth', -1, 0) || undefined,
      toothDepth: a.num('toothDepth', -1, NaN) || undefined,
      lobes: a.num('lobes', -1, 0) || undefined,
      spread: a.num('spread', -1, NaN) || undefined,
      droop: a.num('droop', -1, 0.18),
      cup: a.num('cup', -1, 0) || undefined,
      keel: a.num('keel', -1, 0) || undefined,
      curl: a.num('curl', -1, 0) || undefined,
      curlBias: a.num('curlBias', -1, 1),
      twist: a.num('twist', -1, 0) || undefined,
      relief: optional(a.num('relief', -1, NaN)),
      reliefVeins: a.num('reliefVeins', -1, 0) || undefined,
      bossBore: a.num('boss', -1, 0) || undefined,
      segments: a.count('segments', -1, 64),
      enamel: enamelName(a),
      veinMetal: veinMetalName(a),
    })),

  gem: define(['cut', 'width', 'length', 'depth', 'facets', 'table', 'segments'], (a) =>
    gem({
      cut: oneOf(a, 'cut', GEM_CUTS, 'brilliant') as GemCut,
      width: a.num('width', 0),
      length: a.num('length', -1, 0) || undefined,
      depth: a.num('depth', -1, 0) || undefined,
      facets: a.num('facets', -1, 0) || undefined,
      table: a.num('table', -1, 0) || undefined,
      segments: a.count('segments', -1, 40),
    })),

  setting: define(['width', 'style', 'claws', 'height', 'wall', 'grip', 'segments'], (a) =>
    setting({
      width: a.num('width', 0),
      style: oneOf(a, 'style', SETTING_STYLES, 'claw') as SettingStyle,
      claws: a.num('claws', -1, 0) || undefined,
      height: a.num('height', -1, 0) || undefined,
      wall: a.num('wall', -1, 0) || undefined,
      grip: a.num('grip', -1, 0) || undefined,
      segments: a.count('segments', -1, 32),
    })),

  wire: define(['path', 'radius', 'section', 'tip', 'twist', 'flatten', 'closed', 'sections', 'sides', 'enamel'], (a) =>
    wire({
      enamel: enamelName(a),
      path: a.curve('path', 0),
      radius: a.num('radius', 1),
      section: oneOf(a, 'section', SECTIONS, 'round') as Section,
      tipScale: a.num('tip', -1, 0.2),
      twistTurns: a.num('twist', -1, 0) / (Math.PI * 2) || undefined,
      flatten: a.flag('flatten', -1, false),
      closed: a.flag('closed', -1, false),
      sections: a.count('sections', -1, 128),
      sides: a.count('sides', -1, 12),
    })),

  blade: define(['path', 'width', 'thickness', 'twist', 'sections', 'sides', 'enamel'], (a) =>
    blade({
      enamel: enamelName(a),
      path: a.curve('path', 0),
      width: a.num('width', 1),
      thickness: a.num('thickness', 2, 1),
      twistTurns: a.num('twist', -1, 0) / (Math.PI * 2) || undefined,
      sections: a.count('sections', -1, 96),
      sides: a.count('sides', -1, 16),
    })),

  rivet: define(['head', 'height', 'shank', 'grip', 'tail', 'segments'], (a) =>
    rivet({
      headDiameter: a.num('head', 0),
      headHeight: a.num('height', 1),
      shankDiameter: a.num('shank', 2),
      grip: a.num('grip', 3),
      tailSpread: a.num('tail', -1, NaN) || undefined,
      segments: a.count('segments', -1, 24),
    })),

  bead: define(['radius', 'point', 'bore', 'enamel', 'segments'], (a) =>
    bead({
      radius: a.num('radius', 0),
      point: a.num('point', 1, NaN) || undefined,
      bore: a.num('bore', -1, 0) || undefined,
      enamel: enamelName(a),
      segments: a.count('segments', -1, 24),
    })),

  egg: define(['radius', 'height', 'taper', 'enamel', 'segments'], (a) =>
    egg({
      radius: a.num('radius', 0),
      height: a.num('height', 1, 0) || undefined,
      taper: a.num('taper', -1, NaN) || undefined,
      enamel: enamelName(a),
      segments: a.count('segments', -1, 48),
    })),

  pearl: define(['radius', 'oblate', 'segments'], (a) =>
    pearl({
      radius: a.num('radius', 0),
      oblate: a.num('oblate', -1, 0) || undefined,
      segments: a.count('segments', -1, 48),
    })),

  band: define(['radius', 'width', 'thickness', 'segments'], (a) =>
    band({
      radius: a.num('radius', 0),
      width: a.num('width', 1),
      thickness: a.num('thickness', 2, 0.8),
      segments: a.count('segments', -1, 128),
    })),

  pod: define(['length', 'width', 'whorls', 'whorlDepth', 'ribs', 'ribDepth', 'segments'], (a) =>
    pod({
      length: a.num('length', 0),
      width: a.num('width', 1),
      whorls: a.num('whorls', -1, 0) || undefined,
      whorlDepth: a.num('whorlDepth', -1, NaN) || undefined,
      ribs: a.num('ribs', -1, 0) || undefined,
      ribDepth: a.num('ribDepth', -1, NaN) || undefined,
      segments: a.count('segments', -1, 32),
    })),

  bell: define(['length', 'mouth', 'throat', 'wall', 'flare', 'lobes', 'lobeDepth', 'rows', 'segments', 'enamel'], (a) =>
    bell({
      enamel: enamelName(a),
      length: a.num('length', 0),
      mouth: a.num('mouth', 1),
      throat: a.num('throat', 2),
      wall: a.num('wall', -1, NaN) || undefined,
      flare: a.num('flare', -1, 2.2),
      lobes: a.num('lobes', -1, 0) || undefined,
      lobeDepth: a.num('lobeDepth', -1, NaN) || undefined,
      rows: a.num('rows', -1, 24),
      segments: a.count('segments', -1, 40),
    })),

  petal: define(
    ['length', 'width', 'thickness', 'shape', 'edge', 'edgeDepth', 'edgeCount', 'bevel',
     'veins', 'cup', 'keel', 'curl', 'curlBias', 'twist', 'ruffle', 'ruffleWaves',
     'droop', 'relief', 'reliefVeins', 'boss', 'segments', 'enamel', 'veinMetal'],
    (a) => petal({
      length: a.num('length', 0),
      width: a.num('width', 1),
      thickness: a.num('thickness', 2, 0.7),
      shape: oneOf(a, 'shape', PETAL_SHAPES, 'round') as PetalShape,
      edge: oneOf(a, 'edge', PETAL_EDGES, 'entire') as PetalEdge,
      edgeDepth: a.num('edgeDepth', -1, 0.06),
      edgeCount: a.num('edgeCount', -1, 0) || undefined,
      bevel: a.num('bevel', -1, NaN) || undefined,
      veins: a.num('veins', -1, 0) || undefined,
      cup: a.num('cup', -1, 0) || undefined,
      keel: a.num('keel', -1, 0) || undefined,
      curl: a.num('curl', -1, 0) || undefined,
      curlBias: a.num('curlBias', -1, 1),
      twist: a.num('twist', -1, 0) || undefined,
      ruffle: a.num('ruffle', -1, 0) || undefined,
      ruffleWaves: a.num('ruffleWaves', -1, 5),
      droop: a.num('droop', -1, 0),
      relief: optional(a.num('relief', -1, NaN)),
      reliefVeins: a.num('reliefVeins', -1, 0) || undefined,
      bossBore: a.num('boss', -1, 0) || undefined,
      segments: a.count('segments', -1, 72),
      enamel: enamelName(a),
      veinMetal: veinMetalName(a),
    })),

  stem: define(['path', 'radius', 'tip', 'nodes', 'swell', 'from', 'to', 'sections', 'sides', 'enamel'], (a) =>
    stem({
      enamel: enamelName(a),
      path: a.curve('path', 0),
      radius: a.num('radius', 1),
      tipScale: a.num('tip', -1, 0.35),
      nodes: a.num('nodes', -1, 0) || undefined,
      nodeSwell: a.num('swell', -1, 0.28),
      from: a.num('from', -1, 0.12),
      to: a.num('to', -1, 0.92),
      sections: a.count('sections', -1, 96),
      sides: a.count('sides', -1, 10),
    })),

  branch: define(
    ['path', 'radius', 'tip', 'limbs', 'limbLength', 'limbAngle', 'limbSag', 'limbTaper',
     'from', 'to', 'sections', 'sides', 'enamel'],
    (a) => branch({
      enamel: enamelName(a),
      path: a.curve('path', 0),
      radius: a.num('radius', 1),
      tipScale: a.num('tip', -1, 0.35),
      limbs: a.num('limbs', -1, 3),
      limbLength: a.num('limbLength', -1, 0.42),
      limbAngle: a.num('limbAngle', -1, 0.85),
      limbSag: a.num('limbSag', -1, 0.18),
      limbTaper: a.num('limbTaper', -1, 0.55),
      from: a.num('from', -1, 0.12),
      to: a.num('to', -1, 0.92),
      sections: a.count('sections', -1, 96),
      sides: a.count('sides', -1, 10),
    })),

  bud: define(['length', 'width', 'lobes', 'lobeDepth', 'point', 'swell', 'rows', 'segments'], (a) =>
    bud({
      length: a.num('length', 0),
      width: a.num('width', 1),
      lobes: a.num('lobes', -1, 5),
      lobeDepth: a.num('lobeDepth', -1, 0.1),
      point: a.num('point', -1, 0.22),
      swell: a.num('swell', -1, 1),
      rows: a.num('rows', -1, 40),
      segments: a.count('segments', -1, 36),
    })),

  bar: define(['length', 'width', 'thickness', 'bore', 'intermediate', 'bevel'], (a) =>
    bar({
      length: a.num('length', 0),
      width: a.num('width', 1),
      thickness: a.num('thickness', 2, 1.2),
      bore: a.num('bore', 3, 2),
      intermediate: a.num('intermediate', -1, 0) || undefined,
      bevel: a.num('bevel', -1, NaN) || undefined,
    })),

  disc: define(['radius', 'thickness', 'sides', 'bore', 'bolts', 'boltCircle', 'boltBore', 'bevel'], (a) =>
    disc({
      radius: a.num('radius', 0),
      thickness: a.num('thickness', 1, 1.2),
      sides: a.num('sides', -1, 0) || undefined,
      bore: a.num('bore', -1, 0) || undefined,
      bolts: a.num('bolts', -1, 0) || undefined,
      boltCircleRadius: a.num('boltCircle', -1, NaN) || undefined,
      boltBore: a.num('boltBore', -1, NaN) || undefined,
      bevel: a.num('bevel', -1, NaN) || undefined,
    })),

  plate: define(['outline', 'thickness', 'cut', 'bore', 'bevel', 'enamel', 'tiers', 'shrink'], (a) =>
    plate({
      outline: a.outline('outline', 0)!.loop,
      thickness: a.num('thickness', 1, 1.2),
      holes: [a.outline('cut', -1, false)?.loop].filter((h): h is Vec2[] => !!h),
      bore: a.num('bore', -1, 0) || undefined,
      bevel: a.num('bevel', -1, NaN) || undefined,
      enamel: enamelName(a),
      tiers: a.count('tiers', -1, 1),
      shrink: a.num('shrink', -1, 0.2),
    })),

  // mathematical solids: sheets shaped by a function, thickened into shells
  saddle: define(['width', 'depth', 'rise', 'thickness', 'segments', 'enamel'], (a) =>
    saddlePart({
      width: a.num('width', 0), depth: a.num('depth', 1), rise: a.num('rise', 2, 4),
      thickness: a.num('thickness', -1, 0.8), segments: a.count('segments', -1, 48), enamel: enamelName(a),
    })),

  ripple: define(['width', 'depth', 'amplitude', 'waves', 'thickness', 'segments', 'enamel'], (a) =>
    ripplePart({
      width: a.num('width', 0), depth: a.num('depth', 1), amplitude: a.num('amplitude', 2, 1.5), waves: a.num('waves', 3, 2),
      thickness: a.num('thickness', -1, 0.8), segments: a.count('segments', -1, 64), enamel: enamelName(a),
    })),

  helicoid: define(['radius', 'height', 'turns', 'thickness', 'segments', 'enamel'], (a) =>
    helicoidPart({
      radius: a.num('radius', 0), height: a.num('height', 1), turns: a.num('turns', 2, 1),
      thickness: a.num('thickness', -1, 0.8), segments: a.count('segments', -1, 96), enamel: enamelName(a),
    })),

  mobius: define(['radius', 'width', 'twists', 'thickness', 'segments', 'enamel'], (a) =>
    mobiusPart({
      radius: a.num('radius', 0), width: a.num('width', 1), twists: a.count('twists', -1, 1),
      thickness: a.num('thickness', -1, 0.8), segments: a.count('segments', -1, 120), enamel: enamelName(a),
    })),

  // not "shell": that is the sphere-shell symmetry
  seashell: define(['radius', 'tube', 'turns', 'growth', 'height', 'thickness', 'segments', 'enamel'], (a) =>
    shellPart({
      radius: a.num('radius', 0), tube: a.num('tube', 1), turns: a.num('turns', -1, 3),
      growth: a.num('growth', -1, 2.2), height: a.num('height', -1, NaN) || undefined,
      thickness: a.num('thickness', -1, 0.6), segments: a.num('segments', -1, NaN) || undefined, enamel: enamelName(a),
    })),

  patch: define(['points', 'thickness', 'segments', 'enamel'], (a) => {
    const thickness = a.num('thickness', -1, 0.8);
    const segments = a.count('segments', -1, 32);
    const enamel = enamelName(a);
    const points = a.rest();
    if (a.recorder) return patchPart({ net: Array.from({ length: 16 }, (_, i) => [i % 4, Math.floor(i / 4), 0] as Vec3), thickness, segments, enamel });
    if (points.length !== 16 || !points.every(isVec)) {
      throw new DslError('patch() takes 16 points, a 4 by 4 net row by row, like (0, 0, 0), (10, 0, 2), …', a.span);
    }
    return patchPart({ net: points as Vec3[], thickness, segments, enamel });
  }),

  gusset: define(['radius', 'thickness', 'bore', 'fillet', 'lighten', 'bevel'], (a) =>
    gusset({
      radius: a.num('radius', 0),
      thickness: a.num('thickness', 1, 1.2),
      bore: a.num('bore', 2, 2),
      fillet: a.num('fillet', -1, NaN) || undefined,
      lighten: a.num('lighten', -1, 0) || undefined,
      bevel: a.num('bevel', -1, NaN) || undefined,
    })),

  collar: define(['inner', 'wall', 'length', 'belly', 'segments'], (a) =>
    collar({
      innerRadius: a.num('inner', 0),
      wall: a.num('wall', 1),
      length: a.num('length', 2),
      belly: a.num('belly', -1, 0.6),
      segments: a.count('segments', -1, 24),
    })),

  shank: define(['size', 'width', 'thickness', 'shoulder', 'shoulderSpread', 'gap', 'segments'], (a) =>
    shank({
      size: a.num('size', 0),
      width: a.num('width', 1),
      thickness: a.num('thickness', 2),
      shoulder: a.num('shoulder', -1, 0) || undefined,
      shoulderSpread: a.num('shoulderSpread', -1, 0.9),
      gap: a.num('gap', -1, 0) || undefined,
      segments: a.count('segments', -1, 96),
    })),

  clasp: define(['radius', 'hookRadius', 'sweep', 'tip', 'sections', 'sides'], (a) =>
    clasp({
      radius: a.num('radius', 0),
      hookRadius: a.num('hookRadius', 1),
      sweep: a.num('sweep', -1, Math.PI * 2 * 0.72),
      tip: a.num('tip', -1, 0.55),
      sections: a.count('sections', -1, 64),
      sides: a.count('sides', -1, 12),
    })),

  jumpRing: define(['radius', 'wireRadius', 'gap', 'sections', 'sides'], (a) =>
    jumpRing({
      radius: a.num('radius', 0),
      wireRadius: a.num('wireRadius', 1),
      gap: a.num('gap', -1, 0) || undefined,
      sections: a.count('sections', -1, 64),
      sides: a.count('sides', -1, 12),
    })),

  leverBack: define(['radius', 'wireRadius', 'gap', 'leverWidth', 'leverThickness', 'sections', 'sides'], (a) =>
    leverBack({
      radius: a.num('radius', 0),
      wireRadius: a.num('wireRadius', -1, NaN) || undefined,
      gap: a.num('gap', -1, 0.8),
      leverWidth: a.num('leverWidth', -1, NaN) || undefined,
      leverThickness: a.num('leverThickness', -1, NaN) || undefined,
      sections: a.count('sections', -1, 64),
      sides: a.count('sides', -1, 12),
    })),

  ringStand: define(['baseRadius', 'baseHeight', 'postRadius', 'postHeight', 'segments'], (a) =>
    ringStand({
      baseRadius: a.num('baseRadius', 0),
      baseHeight: a.num('baseHeight', -1, NaN) || undefined,
      postRadius: a.num('postRadius', -1, NaN) || undefined,
      postHeight: a.num('postHeight', -1, NaN) || undefined,
      segments: a.count('segments', -1, 48),
    })),

  earringStand: define(
    ['baseRadius', 'baseHeight', 'postRadius', 'postHeight', 'barLength', 'barRadius', 'segments'],
    (a) =>
      earringStand({
        baseRadius: a.num('baseRadius', 0),
        baseHeight: a.num('baseHeight', -1, NaN) || undefined,
        postRadius: a.num('postRadius', -1, NaN) || undefined,
        postHeight: a.num('postHeight', -1, NaN) || undefined,
        barLength: a.num('barLength', -1, NaN) || undefined,
        barRadius: a.num('barRadius', -1, NaN) || undefined,
        segments: a.count('segments', -1, 48),
      }),
  ),

  bust: define(['height', 'baseRadius', 'shoulderRadius', 'shoulderSpan', 'neckRadius', 'segments'], (a) =>
    bust({
      height: a.num('height', 0),
      baseRadius: a.num('baseRadius', -1, NaN) || undefined,
      shoulderRadius: a.num('shoulderRadius', -1, NaN) || undefined,
      shoulderSpan: a.num('shoulderSpan', -1, NaN) || undefined,
      neckRadius: a.num('neckRadius', -1, NaN) || undefined,
      segments: a.count('segments', -1, 64),
    })),

  easel: define(
    ['width', 'height', 'cornerRadius', 'thickness', 'bevel', 'pegRadius', 'pegLength', 'legDepth', 'segments'],
    (a) =>
      easel({
        width: a.num('width', 0),
        height: a.num('height', 1),
        cornerRadius: a.num('cornerRadius', -1, NaN) || undefined,
        thickness: a.num('thickness', -1, NaN) || undefined,
        bevel: a.num('bevel', -1, NaN) || undefined,
        pegRadius: a.num('pegRadius', -1, NaN) || undefined,
        pegLength: a.num('pegLength', -1, NaN) || undefined,
        legDepth: a.num('legDepth', -1, NaN) || undefined,
        segments: a.count('segments', -1, 10),
      }),
  ),

  sword: define(
    [
      'bladeLength', 'bladeWidth', 'bladeThickness', 'bladeTaper', 'runeCount', 'runeSize',
      'gripLength', 'gripRadius', 'wrapTurns', 'wrapRadius', 'guardWidth', 'guardThickness',
      'pommelRadius', 'enamel', 'segments',
    ],
    (a) =>
      sword({
        bladeLength: a.num('bladeLength', 0),
        bladeWidth: a.num('bladeWidth', -1, NaN) || undefined,
        bladeThickness: a.num('bladeThickness', -1, NaN) || undefined,
        bladeTaper: a.num('bladeTaper', -1, NaN) || undefined,
        // fixed defaults, not derived from another field, so 0 (rune-free,
        // wrap-free) reads straight through instead of being coalesced away
        runeCount: a.num('runeCount', -1, 0),
        runeSize: a.num('runeSize', -1, NaN) || undefined,
        gripLength: a.num('gripLength', -1, NaN) || undefined,
        gripRadius: a.num('gripRadius', -1, NaN) || undefined,
        wrapTurns: a.num('wrapTurns', -1, 7),
        wrapRadius: a.num('wrapRadius', -1, NaN) || undefined,
        guardWidth: a.num('guardWidth', -1, NaN) || undefined,
        guardThickness: a.num('guardThickness', -1, NaN) || undefined,
        pommelRadius: a.num('pommelRadius', -1, NaN) || undefined,
        enamel: enamelName(a),
        segments: a.count('segments', -1, 24),
      }),
  ),

  axe: define(
    [
      'haftLength', 'haftRadius', 'headReach', 'headHeight', 'headThickness', 'doubleBit', 'haft',
      'wrapTurns', 'wrapRadius', 'wrapFrom', 'wrapLength', 'enamel', 'segments',
    ],
    (a) =>
      axe({
        haftLength: a.num('haftLength', 0),
        haftRadius: a.num('haftRadius', -1, NaN) || undefined,
        headReach: a.num('headReach', -1, NaN) || undefined,
        headHeight: a.num('headHeight', -1, NaN) || undefined,
        headThickness: a.num('headThickness', -1, NaN) || undefined,
        doubleBit: a.flag('doubleBit', -1, false),
        haft: a.flag('haft', -1, true),
        // a fixed default, so 0 (no binding) reads straight through
        wrapTurns: a.num('wrapTurns', -1, 0),
        wrapRadius: a.num('wrapRadius', -1, NaN) || undefined,
        wrapFrom: a.num('wrapFrom', -1, NaN) || undefined,
        wrapLength: a.num('wrapLength', -1, NaN) || undefined,
        enamel: enamelName(a),
        segments: a.count('segments', -1, 24),
      }),
  ),

  shield: define(
    ['radius', 'domeHeight', 'bossRadius', 'bossHeight', 'wall', 'gripWidth', 'gripRadius', 'segments'],
    (a) => {
      // domeHeight/bossHeight are legitimately 0 (a flat face; no boss), so
      // an explicit 0 has to survive rather than fall back to the part's
      // own non-zero default the way plain `|| undefined` would collapse it
      const domeHeight = a.num('domeHeight', -1, NaN);
      const bossHeight = a.num('bossHeight', -1, NaN);
      return shield({
        radius: a.num('radius', 0),
        domeHeight: Number.isNaN(domeHeight) ? undefined : domeHeight,
        bossRadius: a.num('bossRadius', -1, NaN) || undefined,
        bossHeight: Number.isNaN(bossHeight) ? undefined : bossHeight,
        wall: a.num('wall', -1, NaN) || undefined,
        gripWidth: a.num('gripWidth', -1, NaN) || undefined,
        gripRadius: a.num('gripRadius', -1, NaN) || undefined,
        segments: a.count('segments', -1, 48),
      });
    },
  ),
};

/** Symmetries. Everything a form repeats around. */
const SYMMETRIES = {
  radial: define(['count', 'phase'], (a) => radial(a.num('count', 0), a.num('phase', 1, 0))),

  ring: define(['count', 'radius', 'phase', 'z', 'tilt', 'scale'], (a) =>
    ring(a.num('count', 0), a.num('radius', 1, 0), {
      phase: a.num('phase', -1, 0),
      z: a.num('z', -1, 0),
      tilt: a.num('tilt', -1, 0),
      scale: a.num('scale', -1, 1),
    })),

  dihedral: define(['count'], (a) => dihedral(a.num('count', 0))),

  mirror: define([], (a) => { a.done(); return mirror(); }),

  helical: define(['count', 'radius', 'rise', 'turns', 'tilt', 'taper'], (a) =>
    helical(a.num('count', 0), a.num('radius', 1), a.num('rise', 2), a.num('turns', 3, 1), {
      tilt: a.num('tilt', -1, 0),
      taper: a.num('taper', -1, 1),
    })),

  phyllotaxis: define(['count', 'spacing', 'rise', 'tilt', 'fade', 'taper', 'start'], (a) => {
    const tilt = a.num('tilt', -1, 0);
    const fade = a.num('fade', -1, 0);
    return phyllotaxis(a.num('count', 0), a.num('spacing', 1), {
      rise: a.num('rise', -1, 0),
      // fade is why a flower is not a rosette: inner courses stand up, outer lie flat
      tilt: fade === 0 ? tilt : (t: number) => tilt * Math.pow(1 - t, fade),
      taper: a.num('taper', -1, 1),
      startIndex: a.num('start', -1, 0),
    });
  }),

  shell: define(['count', 'radius', 'orient', 'lean', 'turns'], (a) =>
    sphereShell(a.num('count', 0), a.num('radius', 1), {
      orient: oneOf(a, 'orient', ORIENTS, 'flat') as 'outward' | 'flat',
      lean: a.num('lean', -1, 0),
      turns: a.num('turns', -1, 1),
    })),

  along: define(['path', 'count', 'from', 'to', 'taper', 'tilt', 'fade', 'alternate'], (a) => {
    const tilt = a.num('tilt', -1, 0);
    const fade = a.num('fade', -1, 0);
    return along(a.curve('path', 0), a.num('count', 1), {
      from: a.num('from', -1, 0),
      to: a.num('to', -1, 1),
      taper: a.num('taper', -1, 1),
      tilt: fade === 0 ? tilt : (t: number) => tilt * Math.pow(1 - t, fade),
      alternate: a.flag('alternate', -1, false),
    });
  }),

  spray: define(['count', 'radius', 'lean', 'rise', 'taper', 'spin'], (a) =>
    spray(a.num('count', 0), a.num('radius', 1), {
      lean: a.num('lean', -1, 0.5),
      rise: a.num('rise', -1, 0),
      taper: a.num('taper', -1, 1),
      spin: a.num('spin', -1, 0),
    })),

  // not "branch": that is a part. A tree of placements: a twig at each twig's
  // tip. Its measures are drawn afresh for every twig, so an rnd() here is
  // a different length or lean on each — a grown thing rather than a drawn one.
  tree: define(['depth', 'count', 'length', 'spread', 'shrink', 'twist', 'tips', 'phase'], (a) =>
    branching(a.count('depth', 0, 3), a.count('count', 1, 2), a.sampler('length', 2), a.sampler('spread', 3, 0.5), a.sampler('shrink', 4, 0.7), {
      twist: a.sampler('twist', -1, 0),
      tipsOnly: a.flag('tips', -1, false),
      phase: a.num('phase', -1, 0),
    })),

  // play added to any symmetry: each copy turned, tilted, shifted and scaled
  // by its own draw within the amounts given
  jitter: define(['symmetry', 'turn', 'tilt', 'shift', 'scale', 'seed'], (a) => {
    const sym = a.symmetry('symmetry', 0);
    const amounts = { turn: a.num('turn', -1, 0), tilt: a.num('tilt', -1, 0), shift: a.num('shift', -1, 0), scale: a.num('scale', -1, 0) };
    const seed = hashSeed([a.seed, a.num('seed', -1, 0), amounts.turn, amounts.tilt, amounts.shift, amounts.scale]);
    return jitterSymmetry(sym, amounts, seed);
  }),

  nested: define(['count', 'factor', 'spin'], (a) =>
    nested(a.num('count', 0), a.num('factor', 1), a.num('spin', 2, 0))),

  compose: define(['outer', 'inner'], (a) =>
    compose(a.symmetry('outer', 0), a.symmetry('inner', 1))),
};

export const BUILTINS: Record<string, { known: string[]; fn: Builtin }> = {
  ...CURVES, ...OUTLINES, ...ENGRAVINGS, ...INSCRIPTIONS, ...PARTS, ...SYMMETRIES, ...RANDOM,
};

export const ENGRAVING_NAMES = [...Object.keys(ENGRAVINGS), ...Object.keys(INSCRIPTIONS)];

export const OUTLINE_NAMES = Object.keys(OUTLINES);
export const CURVE_NAMES = Object.keys(CURVES);
export const SYMMETRY_NAMES = Object.keys(SYMMETRIES);

export const PART_NAMES = Object.keys(PARTS);

const signatures = new Map<string, ParamInfo[]>();

/**
 * What a builtin takes, with defaults, learned by calling it.
 *
 * The argument reads inside each builtin are the one true record of its
 * parameters, so rather than keep a second table in step with them the probe
 * runs the builtin once with a recording Args that answers every read with a
 * stand-in. Whatever the builtin then does with those stand-ins is discarded.
 * The result is ordered by the declared list, which is also the positional order.
 */
export function signature(name: string): ParamInfo[] | undefined {
  const builtin = BUILTINS[name];
  if (!builtin) return undefined;
  let sig = signatures.get(name);
  if (sig) return sig;
  const args = new Args(name, [], { start: 0, end: 0, line: 1, column: 1 }, builtin.known);
  args.recorder = [];
  try { builtin.fn(args); } catch { /* stand-in values need not make a shape */ }
  const read = new Map(args.recorder.map((p) => [p.name, p]));
  sig = builtin.known.map((n) => read.get(n) ?? { name: n, kind: 'number' as const, required: false });
  signatures.set(name, sig);
  return sig;
}
export const BUILTIN_NAMES = Object.keys(BUILTINS);
