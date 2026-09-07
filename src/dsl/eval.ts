import { detail } from '../mesh/detail';
import { Assembly, type Placement as Placed } from '../assembly/assembly';
import { solderFillet, type FilletCache } from '../assembly/fillet';
import { identity, multiply, rotationAbout, translation, uniformScale, type Mat4 } from '../geom/transform';
import type { Vec3 } from '../geom/types';
import { finishes, metals } from '../render/materials';
import type { Part } from '../parts/types';
import type { Action, Expr, Placement, Program } from './ast';
import { parse } from './parser';
import { Args, BUILTINS, ENGRAVING_NAMES, isEngraving, isInscription, isJitter, sampleOnce, isOutline, isPart, isSymmetry, isVec, type CallArg, type Value } from './builtins';
import { DslError, type Span } from './lexer';
/**
 * Part geometry survives across compiles. The editor recompiles on every
 * keystroke and a subject switch compiles from scratch, and a pierced leaf
 * costs the better part of a second to mesh, so a call with the same arguments
 * hands back the same mesh. Only arguments that are plain values take part —
 * numbers, words, points, paths — and each hit is a fresh Part object, since a
 * sketch writes its material onto the Part it declares.
 */
const partMemo = new Map<string, Part>();
const PART_MEMO_LIMIT = 400;

/**
 * The key of the call that made a value, on values the memo could not key
 * by content — a curve is functions — so a wire along a spiral is the same
 * wire on the next compile, and its mesh stays where the renderer put it.
 */
const MADE_BY = Symbol('madeBy');

function memoValue(value: unknown, depth: number): string | null {
  if (depth > 6) return null;
  if (value && typeof value === 'object' && MADE_BY in value) return (value as Record<symbol, string>)[MADE_BY];
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const v of value) {
      const k = memoValue(v, depth + 1);
      if (k === null) return null;
      parts.push(k);
    }
    return `[${parts.join(',')}]`;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && !('mesh' in value)) {
    const keys = Object.keys(value).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const k = memoValue((value as Record<string, unknown>)[key], depth + 1);
      if (k === null) return null;
      parts.push(`${JSON.stringify(key)}:${k}`);
    }
    return `{${parts.join(',')}}`;
  }
  return null;
}

function partMemoKey(callee: string, args: CallArg[]): string | null {
  const parts: string[] = [];
  for (const a of args) {
    const k = memoValue(a.value, 0);
    if (k === null) return null;
    parts.push(`${a.name ?? ''}=${k}`);
  }
  // a part built at one detail is not the part at another
  return `${callee}@${detail()}(${parts.join(';')})`;
}

/**
 * Fillets, like parts, outlive a compile: a fillet is keyed by its size and
 * material alone, and detail, so the solder round a stud is the same mesh on
 * the next keystroke, and the renderer keeps its bake. Emptied when it grows
 * past the part memo's limit, or detail changes.
 */
const filletMemo: FilletCache = new Map();
let filletDetail = detail();

function rememberPart(key: string, part: Part) {
  if (partMemo.size >= PART_MEMO_LIMIT) {
    const oldest = partMemo.keys().next().value;
    if (oldest !== undefined) partMemo.delete(oldest);
  }
  partMemo.set(key, { ...part, material: undefined });
}


export interface CompileOptions {
  /**
   * Where `use` looks for another sketch's source.
   *
   * Passed in rather than reached for, so the language does not have to know
   * that the library it is importing from happens to be the example set.
   */
  resolve?: (name: string) => string | undefined;
}

interface Context {
  resolve?: (name: string) => string | undefined;
  /** Names part-way through being imported, so a circle is caught rather than hung on. */
  importing: Set<string>;
  /** One evaluation per sketch per compile, however many times it is used. */
  cache: Map<string, Sketch>;
}

export interface Sketch {
  assembly: Assembly;
  /** Where each part was declared, for finding every placement of it. */
  partSpans: Map<Part, Span>;
  /** Default material for anything that did not name its own. */
  metal?: string;
  finish?: string;
  formName: string;
}

/**
 * Walk the program and build an Assembly.
 *
 * Part declarations are evaluated once and the resulting Part is shared by every
 * placement of it, which is what keeps a sketch instanced: `repeat sector around
 * ring(16)` produces sixteen matrices, not sixteen meshes.
 */
export function evaluate(program: Program, options: CompileOptions = {}): Sketch {
  return evaluateIn(program, {
    resolve: options.resolve,
    importing: new Set(),
    cache: new Map(),
  });
}

/**
 * Bring in another sketch as a single form.
 *
 * Only its result comes across — the form it finally builds, bound to the name
 * it was imported under. Not its parts, not its units, not its intermediate
 * forms. A sketch's insides are its own business, and importing them would make
 * every name in every sketch a name in every other one.
 */
function importSketch(name: string, span: Span, ctx: Context): Assembly {
  const cached = ctx.cache.get(name);
  if (cached) return cached.assembly;

  if (ctx.importing.has(name)) {
    throw new DslError(`"${name}" is already being used — sketches cannot use each other in a circle`, span);
  }
  const source = ctx.resolve?.(name);
  if (source === undefined) {
    throw new DslError(`there is no sketch called "${name}" to use`, span);
  }

  ctx.importing.add(name);
  let sketch: Sketch;
  try {
    // the inner error carries a span into source the writer cannot see, so it is
    // reported against the "use" line with its own location quoted
    sketch = evaluateIn(parse(source), ctx);
  } catch (error) {
    if (error instanceof DslError) {
      throw new DslError(`in the sketch "${name}", line ${error.span.line}: ${error.message}`, span);
    }
    throw error;
  } finally {
    ctx.importing.delete(name);
  }

  // An imported flower keeps its own metals. Anything it left to its own default
  // is stamped with that default here, because the moment it lands the default
  // means whatever the importing sketch says instead — and a rose imported into
  // a gold bouquet should still be rose gold.
  const seen = new Set<Part>();
  for (const placement of sketch.assembly.placements) {
    if (seen.has(placement.part)) continue;
    seen.add(placement.part);
    if (!placement.part.material) {
      placement.part.material = { metal: sketch.metal, finish: sketch.finish };
    }
  }

  ctx.cache.set(name, sketch);
  return sketch.assembly;
}

function evaluateIn(program: Program, ctx: Context): Sketch {
  if (filletDetail !== detail() || filletMemo.size > PART_MEMO_LIMIT) { filletMemo.clear(); filletDetail = detail(); }
  const scope = new Map<string, Value>();
  /** The sketch's seed: mixed into every rnd(), so "seed 7" reshuffles them all. */
  let seed = 0;
  const settle = (v: Value): Value => (isJitter(v) ? sampleOnce(v, 'arithmetic') : v);
  const units = new Map<string, Assembly>();
  const forms = new Map<string, Assembly>();
  const partCache = new Map<Expr, Part>();
  const partSpans = new Map<Part, Span>();
  const partMaterials = new Map<Part, { metal?: string; finish?: string }>();

  /**
   * Names taken by `use`. Checking the other direction matters as much: the
   * import happens first, so without this a later "form rose" would quietly
   * replace an imported one and the sketch would look almost right.
   */
  const imported = new Set<string>();

  let defaultMetal: string | undefined;
  let defaultFinish: string | undefined;
  let lastForm: string | undefined;

  // --- expressions ---

  function evalExpr(expr: Expr): Value {
    // every Expr kind is handled; TypeScript proves the switch exhaustive
    switch (expr.kind) {
      case 'number': return expr.value;
      case 'string': return expr.value;

      case 'ident': {
        const value = scope.get(expr.name);
        if (value === undefined) {
          if (units.has(expr.name) || forms.has(expr.name)) {
            throw new DslError(
              `"${expr.name}" is a unit or form — use it with "repeat" or "place"`,
              expr.span,
            );
          }
          // a bare word is a value in its own right, for things like orient: radial
          if (BUILTINS[expr.name]) {
            throw new DslError(
              `"${expr.name}" is a shape, so it needs arguments like ${expr.name}(...)` +
              ` — write "${expr.name}" in quotes if you meant it as a plain word`,
              expr.span,
            );
          }
          return expr.name;
        }
        return value;
      }

      case 'vector': {
        const items = expr.items.map((e) => evalExpr(e));
        for (const item of items) {
          if (typeof item !== 'number') {
            throw new DslError('a point is made of three numbers', expr.span);
          }
        }
        return items as Vec3;
      }

      case 'unary': {
        const value = settle(evalExpr(expr.operand));
        if (typeof value !== 'number') throw new DslError('cannot negate this', expr.span);
        return -value;
      }

      case 'binary': {
        // arithmetic on an rnd() works on its one sampled value
        const left = settle(evalExpr(expr.left));
        const right = settle(evalExpr(expr.right));
        if (typeof left !== 'number' || typeof right !== 'number') {
          throw new DslError(`cannot use "${expr.op}" on these`, expr.span);
        }
        switch (expr.op) {
          case '+': return left + right;
          case '-': return left - right;
          case '*': return left * right;
          case '/':
            if (right === 0) throw new DslError('division by zero', expr.span);
            return left / right;
        }
        break;
      }

      case 'call': {
        const builtin = BUILTINS[expr.callee];
        if (!builtin) {
          throw new DslError(`there is no "${expr.callee}" — ${suggest(expr.callee)}`, expr.span);
        }
        const args: CallArg[] = expr.args.map((a) => ({
          name: a.name,
          value: evalExpr(a.value),
          span: a.span,
        }));
        const memoKey = partMemoKey(expr.callee, args);
        const memoised = memoKey === null ? undefined : partMemo.get(memoKey);
        // a hit means this exact call once ran clean, so its arguments need no checking
        if (memoised) return { ...memoised, material: undefined };
        const reader = new Args(expr.callee, args, expr.span, builtin.known, seed);
        const result = builtin.fn(reader);
        reader.done();
        if (memoKey !== null && isPart(result)) rememberPart(memoKey, result);
        else if (memoKey !== null && result && typeof result === 'object' && memoValue(result, 0) === null && !Object.isFrozen(result)) {
          // keyed by its making only where its content cannot key it; the
          // sketch's seed is part of the making, for anything that drew on it
          Object.defineProperty(result, MADE_BY, { value: `${memoKey}#${seed}`, enumerable: false });
        }
        return result;
      }
    }
  }

  /** Resolve an expression that must yield a Part, caching by syntax node. */
  function evalPart(expr: Expr): Part {
    if (expr.kind === 'ident') {
      const value = scope.get(expr.name);
      if (value !== undefined && isPart(value)) return value;
      throw new DslError(`"${expr.name}" is not a part`, expr.span);
    }
    const cached = partCache.get(expr);
    if (cached) return cached;
    const value = evalExpr(expr);
    if (!isPart(value)) {
      throw new DslError('this is not a part', expr.span);
    }
    partCache.set(expr, value);
    return value;
  }

  // --- placement modifiers into a matrix ---

  function placementMatrix(placement: Placement): Mat4 {
    let m = identity();
    const scale = placement.scale ? num(placement.scale) : 1;
    if (scale !== 1) m = multiply(uniformScale(scale), m);
    if (placement.roll) m = multiply(rotationAbout([1, 0, 0], num(placement.roll)), m);
    if (placement.pitch) m = multiply(rotationAbout([0, 1, 0], num(placement.pitch)), m);
    if (placement.turn) m = multiply(rotationAbout([0, 0, 1], num(placement.turn)), m);
    if (placement.at) {
      const at = evalExpr(placement.at);
      if (!isVec(at)) throw new DslError('"at" needs a point like (0, 10, 2)', placement.at.span);
      m = multiply(translation(at), m);
    }
    return m;
  }

  const num = (expr: Expr): number => {
    const value = evalExpr(expr);
    if (typeof value !== 'number') throw new DslError('expected a number here', expr.span);
    return value;
  };

  /**
   * Split material words into metal and finish, longest metal name first.
   * "rose gold polished" is a two-word metal and a finish, not the reverse.
   */
  function resolveMaterial(words: string[], span: Span): { metal?: string; finish?: string } {
    if (words.length >= 2 && metals[`${words[0]} ${words[1]}`]) {
      return { metal: `${words[0]} ${words[1]}`, finish: words[2] };
    }
    if (words.length > 2) {
      throw new DslError(`"${words.join(' ')}" is not a metal and a finish`, span);
    }
    return { metal: words[0], finish: words[1] };
  }

  function applyMaterial(part: Part, words: string[] | undefined, span: Span) {
    if (!words || !words.length) return;
    const placement = resolveMaterial(words, span);
    checkMaterial(placement, span);
    // Material lives on the Part, and Parts are shared, so recording it twice with
    // different values would silently repaint every other placement of the piece.
    const existing = partMaterials.get(part);
    if (existing && (existing.metal !== placement.metal || existing.finish !== placement.finish)) {
      throw new DslError(
        `"${part.name}" is already in ${existing.metal ?? 'the default metal'}` +
        ` — give it its own "part" declaration to use a second material`,
        span,
      );
    }
    partMaterials.set(part, { metal: placement.metal, finish: placement.finish });
    part.material = { metal: placement.metal, finish: placement.finish };
  }

  /** A light's radiance, on the part, with the same one-value-per-part rule as its material. */
  function applyGlow(part: Part, expr: Expr | undefined) {
    if (!expr) return;
    const value = evalExpr(expr);
    if (typeof value !== 'number' || value < 0) {
      throw new DslError('"glow" is a brightness: 1 is as bright as the sky, 0 is off', expr.span);
    }
    if (part.glow !== undefined && part.glow !== value) {
      throw new DslError(
        `"${part.name}" already glows at ${part.glow} — give it its own "part" declaration to glow differently`,
        expr.span,
      );
    }
    part.glow = value;
  }

  function checkMaterial(m: { metal?: string; finish?: string }, span: Span) {
    if (m.metal && !metals[m.metal]) {
      throw new DslError(
        `there is no metal called "${m.metal}" — try ${Object.keys(metals).join(', ')}`,
        span,
      );
    }
    if (m.finish && !finishes[m.finish]) {
      throw new DslError(
        `there is no finish called "${m.finish}" — try ${Object.keys(finishes).join(', ')}`,
        span,
      );
    }
  }

  // --- actions ---

  function runActions(assembly: Assembly, actions: Action[]) {
    const placed = new Map<string, Placed>();
    const fillets = filletMemo;

    for (const action of actions) {
      if (action.kind === 'place') {
        const name = action.placement.as ?? nameOf(action.part);

        // a unit or form placed by name is merged in whole
        if (action.part.kind === 'ident' && !scope.has(action.part.name)) {
          const sub = units.get(action.part.name) ?? forms.get(action.part.name);
          if (sub) {
            assembly.merge(sub, placementMatrix(action.placement), action.span);
            continue;
          }
        }

        const part = evalPart(action.part);
        applyMaterial(part, action.placement.material, action.span);
        applyGlow(part, action.placement.glow);
        const placement = assembly.place(part, placementMatrix(action.placement), action.span);
        if (name) placed.set(name, placement);
        continue;
      }

      if (action.kind === 'fasten') {
        const owner = placed.get(action.target.part);
        if (!owner) {
          throw new DslError(
            `nothing called "${action.target.part}" has been placed yet` +
            (placed.size ? ` — placed so far: ${[...placed.keys()].join(', ')}` : ''),
            action.span,
          );
        }
        const anchor = owner.anchors.find((a) => a.name === action.target.anchor);
        if (!anchor) {
          throw new DslError(
            `"${action.target.part}" has no anchor "${action.target.anchor}"` +
            ` — it has ${owner.anchors.map((a) => a.name).join(', ') || 'none'}`,
            action.span,
          );
        }

        const part = evalPart(action.part);
        applyMaterial(part, action.placement.material, action.span);
        const anchorName = action.partAnchor ?? part.anchors[0]?.name;
        if (!anchorName) {
          throw new DslError(`"${part.name}" has no anchors to fasten by`, action.span);
        }
        if (!part.anchors.some((a) => a.name === anchorName)) {
          throw new DslError(
            `"${part.name}" has no anchor "${anchorName}"` +
            ` — it has ${part.anchors.map((a) => a.name).join(', ')}`,
            action.span,
          );
        }

        const placement = assembly.connect(anchor, part, anchorName, {
          align: action.placement.flip ? 'opposed' : 'same',
          roll: action.placement.turn ? num(action.placement.turn) : 0,
          offset: action.placement.offset ? num(action.placement.offset) : 0,
          scale: action.placement.scale ? num(action.placement.scale) : 1,
        }, action.span);
        solderFillet(assembly, owner, anchor, placement, anchorName, fillets);
        const name = action.placement.as ?? nameOf(action.part);
        if (name) placed.set(name, placement);
        continue;
      }

      // repeat
      const symmetry = evalExpr(action.symmetry);
      if (!isSymmetry(symmetry)) {
        throw new DslError(
          'expected a symmetry after "around" — try ring(8, radius: 20)',
          action.symmetry.span,
        );
      }

      let sub: Assembly | undefined;
      if (action.subject.kind === 'ident' && !scope.has(action.subject.name)) {
        sub = units.get(action.subject.name) ?? forms.get(action.subject.name);
        if (!sub) {
          throw new DslError(
            `there is no unit called "${action.subject.name}"`,
            action.subject.span,
          );
        }
      } else {
        const part = evalPart(action.subject);
        sub = new Assembly(part.name);
        sub.place(part);
      }
      assembly.repeat(sub, symmetry, action.span);
    }
  }

  /** Refuse to redefine a name that `use` has already brought in. */
  function claim(name: string, span: Span) {
    if (imported.has(name)) {
      throw new DslError(
        `"${name}" is already defined here by "use", so it cannot be declared again`,
        span,
      );
    }
  }

  // --- statements ---

  for (const statement of program.statements) {
    switch (statement.kind) {
      case 'use': {
        for (const name of statement.names) {
          if (forms.has(name) || units.has(name) || scope.has(name)) {
            throw new DslError(
              `"${name}" is already defined here, so it cannot be used from elsewhere`,
              statement.span,
            );
          }
          forms.set(name, importSketch(name, statement.span, ctx));
          imported.add(name);
        }
        break;
      }

      case 'material': {
        const m = resolveMaterial(statement.words, statement.span);
        checkMaterial(m, statement.span);
        defaultMetal = m.metal;
        defaultFinish = m.finish;
        break;
      }

      case 'seed': {
        const value = evalExpr(statement.value);
        if (typeof value !== 'number') throw new DslError('"seed" takes a number', statement.value.span);
        seed = value;
        break;
      }

      case 'let':
        claim(statement.name, statement.span);
        scope.set(statement.name, evalExpr(statement.value));
        break;

      case 'part': {
        claim(statement.name, statement.span);
        const value = evalExpr(statement.value);
        if (!isPart(value)) {
          throw new DslError(
            `"${statement.name}" is not a part — ${describeValue(value)}`,
            statement.value.span,
          );
        }
        value.name = statement.name;
        applyMaterial(value, statement.material, statement.span);
        applyGlow(value, statement.glow);
        for (const expr of statement.engravings) {
          const engraving = evalExpr(expr);
          if (isEngraving(engraving)) value.engraving = engraving;
          else if (isInscription(engraving)) value.inscription = engraving;
          else {
            throw new DslError(
              `"engraved" needs a pattern or lettering — try ${ENGRAVING_NAMES.join(', ')}`,
              expr.span,
            );
          }
        }
        scope.set(statement.name, value);
        partSpans.set(value, statement.span);
        break;
      }

      case 'unit': {
        claim(statement.name, statement.span);
        const assembly = new Assembly(statement.name);
        runActions(assembly, statement.actions);
        assembly.enclose(statement.span);
        units.set(statement.name, assembly);
        break;
      }

      case 'form': {
        claim(statement.name, statement.span);
        const assembly = new Assembly(statement.name);
        runActions(assembly, statement.actions);
        forms.set(statement.name, assembly);
        lastForm = statement.name;
        break;
      }
    }
  }

  if (!lastForm) {
    throw new DslError('a sketch needs at least one form', {
      start: 0, end: 1, line: 1, column: 1,
    });
  }

  return {
    assembly: forms.get(lastForm)!,
    partSpans,
    metal: defaultMetal,
    finish: defaultFinish,
    formName: lastForm,
  };
}

const nameOf = (expr: Expr) => (expr.kind === 'ident' ? expr.name : undefined);

function describeValue(value: Value): string {
  if (typeof value === 'number') return 'it is a number';
  if (typeof value === 'string') return 'it is a word';
  if (isVec(value)) return 'it is a point';
  if (isSymmetry(value)) return 'it is a symmetry';
  if (isOutline(value)) return 'it is an outline';
  if (isEngraving(value)) return 'it is an engraving';
  if (isInscription(value)) return 'it is lettering';
  if (isJitter(value)) return 'it is a random number';
  return 'it is a path';
}

/** Nearest builtin by edit distance, which catches the usual near-misses. */
function suggest(name: string): string {
  let best = '';
  let bestScore = Infinity;
  for (const candidate of Object.keys(BUILTINS)) {
    const score = distance(name, candidate);
    if (score < bestScore) { bestScore = score; best = candidate; }
  }
  return bestScore <= Math.max(2, Math.floor(name.length / 3))
    ? `did you mean "${best}"?`
    : `known shapes are ${Object.keys(BUILTINS).join(', ')}`;
}

function distance(a: string, b: string): number {
  const rows = Array.from({ length: b.length + 1 }, (_, i) => [i, ...Array(a.length).fill(0)]);
  for (let j = 0; j <= a.length; j++) rows[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[j - 1] === b[i - 1] ? 0 : 1),
      );
    }
  }
  return rows[b.length][a.length];
}
