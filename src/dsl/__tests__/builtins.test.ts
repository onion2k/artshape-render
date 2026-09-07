import { describe, expect, it } from 'vitest';
import { type Span } from '../lexer';
import { Args, BUILTIN_NAMES, BUILTINS, PART_NAMES, signature } from '../builtins';
import type { CallArg, Value } from '../builtins';

const SPAN: Span = { start: 0, end: 1, line: 1, column: 1 };

const arg = (value: Value, name?: string): CallArg => ({ name, value, span: SPAN });

describe('Args', () => {
  it('reads a positional argument by index', () => {
    const a = new Args('f', [arg(5)], SPAN, ['width']);
    expect(a.num('width', 0)).toBe(5);
  });

  it('reads a named argument ahead of a positional one at the same slot', () => {
    const a = new Args('f', [arg(9, 'width')], SPAN, ['width']);
    expect(a.num('width', 0)).toBe(9);
  });

  it('falls back when the argument is absent', () => {
    const a = new Args('f', [], SPAN, ['width']);
    expect(a.num('width', 0, 42)).toBe(42);
  });

  it('throws when a required argument is absent', () => {
    const a = new Args('f', [], SPAN, ['width']);
    expect(() => a.num('width', 0)).toThrow(/f needs "width"/);
  });

  it('throws when a numeric argument is given the wrong type', () => {
    const a = new Args('f', [arg('gold')], SPAN, ['width']);
    expect(() => a.num('width', 0)).toThrow(/"width" must be a number in f/);
  });

  it('throws up front on an argument name the callee does not know', () => {
    expect(() => new Args('f', [arg(1, 'bogus')], SPAN, ['width']))
      .toThrow(/f has no "bogus" — it takes width/);
  });

  it('reads a flag from yes/no words as well as booleans and numbers', () => {
    const yes = new Args('f', [arg('yes')], SPAN, ['on']);
    expect(yes.flag('on', 0, false)).toBe(true);
    const no = new Args('f', [arg('no')], SPAN, ['on']);
    expect(no.flag('on', 0, true)).toBe(false);
    const num = new Args('f', [arg(0)], SPAN, ['on']);
    expect(num.flag('on', 0, true)).toBe(false);
  });

  it('reads a point, and rejects anything else for it', () => {
    const a = new Args('f', [arg([1, 2, 3] as Value)], SPAN, ['at']);
    expect(a.vec('at', 0)).toEqual([1, 2, 3]);
    const bad = new Args('f', [arg(5)], SPAN, ['at']);
    expect(() => bad.vec('at', 0)).toThrow(/must be a point/);
  });

  it('collects unnamed trailing arguments with rest()', () => {
    const a = new Args('f', [arg([1, 0, 0] as Value), arg([2, 0, 0] as Value)], SPAN, ['points']);
    expect(a.rest()).toEqual([[1, 0, 0], [2, 0, 0]]);
  });

  it('done() throws on an argument nothing consumed', () => {
    const a = new Args('f', [arg(1), arg(2)], SPAN, ['width']);
    a.num('width', 0);
    expect(() => a.done()).toThrow(/was given more values than it takes/);
  });

  it('done() is silent once every argument has been read', () => {
    const a = new Args('f', [arg(1)], SPAN, ['width']);
    a.num('width', 0);
    expect(() => a.done()).not.toThrow();
  });
});

describe('signature', () => {
  it('is undefined for a name that is not a builtin', () => {
    expect(signature('nope')).toBeUndefined();
  });

  it('lists every parameter a builtin declares, in its declared order', () => {
    const sig = signature('leaf')!;
    expect(sig.map((p) => p.name)).toEqual(BUILTINS.leaf.known);
  });

  it('marks a parameter with no fallback as required', () => {
    const sig = signature('leaf')!;
    const length = sig.find((p) => p.name === 'length')!;
    expect(length.required).toBe(true);
    expect(length.kind).toBe('number');
  });

  it('records the fallback of an optional parameter', () => {
    const sig = signature('leaf')!;
    const thickness = sig.find((p) => p.name === 'thickness')!;
    expect(thickness.required).toBe(false);
    expect(thickness.fallback).toBeCloseTo(1.1);
  });

  it('records the choices for a word parameter checked against a fixed set', () => {
    const sig = signature('leaf')!;
    const shape = sig.find((p) => p.name === 'shape')!;
    expect(shape.kind).toBe('word');
    expect(shape.choices).toContain('ovate');
    expect(shape.choices).toContain('lanceolate');
  });

  it('records enamel as a word with the enamel names as its choices', () => {
    const sig = signature('leaf')!;
    const enamel = sig.find((p) => p.name === 'enamel')!;
    expect(enamel.choices).toContain('cobalt');
  });

  it('marks a path parameter as required with kind path', () => {
    const sig = signature('wire')!;
    const path = sig.find((p) => p.name === 'path')!;
    expect(path.kind).toBe('path');
    expect(path.required).toBe(true);
  });

  it('marks a symmetry-taking builtin\'s symmetry parameters', () => {
    const sig = signature('compose')!;
    expect(sig.map((p) => p.kind)).toEqual(['symmetry', 'symmetry']);
  });

  it('never throws while probing, whatever the builtin does with stand-in values', () => {
    for (const name of BUILTIN_NAMES) expect(() => signature(name)).not.toThrow();
  });

  it('caches the result of a probe', () => {
    expect(signature('leaf')).toBe(signature('leaf'));
  });
});

describe('builtin registry', () => {
  it('lists parts as a subset of every builtin name', () => {
    for (const name of PART_NAMES) expect(BUILTIN_NAMES).toContain(name);
  });

  it('has no duplicate names between curves, parts and symmetries', () => {
    expect(new Set(BUILTIN_NAMES).size).toBe(BUILTIN_NAMES.length);
  });
});
