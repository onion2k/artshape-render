import { describe, expect, it } from 'vitest';
import { DslError } from '../lexer';
import { parse } from '../parser';

const parseOneForm = (src: string) => {
  const program = parse(src);
  const form = program.statements.find((s) => s.kind === 'form');
  if (!form || form.kind !== 'form') throw new Error('no form in source');
  return form.actions;
};

describe('parse: statements', () => {
  it('parses use, material, let, part, unit and form', () => {
    const program = parse(`
      use rose, thistle
      material gold polished
      let n = 6
      part p = leaf(length: n)
      unit u { place p }
      form f { place p }
    `);
    expect(program.statements.map((s) => s.kind)).toEqual([
      'use', 'material', 'let', 'part', 'unit', 'form',
    ]);
  });

  it('collects a comma-separated use list', () => {
    const program = parse('use a, b, c\nform f { }');
    expect(program.statements[0]).toMatchObject({ kind: 'use', names: ['a', 'b', 'c'] });
  });

  it('parses a two-word metal and a finish', () => {
    const program = parse('material rose gold polished\nform f { }');
    expect(program.statements[0]).toMatchObject({ kind: 'material', words: ['rose', 'gold', 'polished'] });
  });

  it('rejects a statement that starts with an unknown keyword', () => {
    expect(() => parse('bogus x = 1')).toThrow(/expected use, material, seed, let, part, unit or form/);
  });

  it('rejects an unclosed block', () => {
    expect(() => parse('form f { place x')).toThrow(/unclosed block/);
  });

  it('requires a name after "part"', () => {
    expect(() => parse('part = leaf()')).toThrow(DslError);
  });
});

describe('parse: expressions', () => {
  it('parses a call with positional and named arguments', () => {
    const [action] = parseOneForm('form f { place leaf(30, width: 12) }');
    expect(action.kind).toBe('place');
    if (action.kind !== 'place') throw new Error();
    expect(action.part).toMatchObject({
      kind: 'call',
      callee: 'leaf',
      args: [
        { name: undefined, value: { kind: 'number', value: 30 } },
        { name: 'width', value: { kind: 'number', value: 12 } },
      ],
    });
  });

  it('parses a three-number group as a vector', () => {
    const [action] = parseOneForm('form f { place p at (1, 2, 3) }');
    if (action.kind !== 'place') throw new Error();
    expect(action.placement.at).toMatchObject({ kind: 'vector' });
  });

  it('a one-element group is just a parenthesised expression, not a vector', () => {
    const [action] = parseOneForm('form f { place leaf(width: (1 + 2)) }');
    if (action.kind !== 'place') throw new Error();
    const arg = (action.part as { args: { value: unknown }[] }).args[0];
    expect(arg.value).toMatchObject({ kind: 'binary', op: '+' });
  });

  it('rejects a group of the wrong size for a point', () => {
    expect(() => parse('form f { place p at (1, 2) }')).toThrow(/a point needs three numbers, found 2/);
  });

  it('respects * and / over + and -', () => {
    const [action] = parseOneForm('form f { place leaf(width: 1 + 2 * 3) }');
    if (action.kind !== 'place') throw new Error();
    const arg = (action.part as { args: { value: unknown }[] }).args[0];
    expect(arg.value).toMatchObject({
      kind: 'binary', op: '+',
      left: { kind: 'number', value: 1 },
      right: { kind: 'binary', op: '*' },
    });
  });

  it('is left-associative for operators of equal precedence', () => {
    const [action] = parseOneForm('form f { place leaf(width: 10 - 2 - 3) }');
    if (action.kind !== 'place') throw new Error();
    const arg = (action.part as { args: { value: unknown }[] }).args[0];
    // (10 - 2) - 3, not 10 - (2 - 3)
    expect(arg.value).toMatchObject({
      kind: 'binary', op: '-',
      left: { kind: 'binary', op: '-' },
      right: { kind: 'number', value: 3 },
    });
  });

  it('parses unary minus at any depth', () => {
    const [action] = parseOneForm('form f { place leaf(width: -1 * -2) }');
    if (action.kind !== 'place') throw new Error();
    const arg = (action.part as { args: { value: unknown }[] }).args[0];
    expect(arg.value).toMatchObject({
      kind: 'binary', op: '*',
      left: { kind: 'unary', op: '-' },
      right: { kind: 'unary', op: '-' },
    });
  });

  it('reads a bare identifier as a word value, not a call', () => {
    const [action] = parseOneForm('form f { place leaf(shape: ovate) }');
    if (action.kind !== 'place') throw new Error();
    const arg = (action.part as { args: { value: unknown }[] }).args[0];
    expect(arg.value).toMatchObject({ kind: 'ident', name: 'ovate' });
  });
});

describe('parse: actions', () => {
  it('parses place with modifiers', () => {
    const [action] = parseOneForm(
      'form f { place p at (1, 0, 0) turn 10deg pitch 5deg roll 2deg scale 2 offset 1 flip as q }',
    );
    if (action.kind !== 'place') throw new Error();
    expect(action.placement).toMatchObject({
      turn: { kind: 'number' }, pitch: { kind: 'number' }, roll: { kind: 'number' },
      scale: { kind: 'number' }, offset: { kind: 'number' }, flip: true, as: 'q',
    });
  });

  it('parses fasten with an explicit anchor and a target', () => {
    const [, action] = parseOneForm('form f { place a\n fasten b.tip to a.boss }');
    expect(action.kind).toBe('fasten');
    if (action.kind !== 'fasten') throw new Error();
    expect(action.partAnchor).toBe('tip');
    expect(action.target).toEqual({ part: 'a', anchor: 'boss' });
  });

  it('defaults a fasten to the part\'s own first anchor', () => {
    const [, action] = parseOneForm('form f { place a\n fasten b to a.boss }');
    if (action.kind !== 'fasten') throw new Error();
    expect(action.partAnchor).toBeUndefined();
  });

  it('requires "to" after the part being fastened', () => {
    expect(() => parse('form f { place a\n fasten b a.boss }')).toThrow(/expected "to"/);
  });

  it('parses repeat with a symmetry call', () => {
    const [action] = parseOneForm('form f { repeat p around ring(8, radius: 20) }');
    expect(action.kind).toBe('repeat');
    if (action.kind !== 'repeat') throw new Error();
    expect(action.symmetry).toMatchObject({ kind: 'call', callee: 'ring' });
  });

  it('requires "around" after the thing being repeated', () => {
    expect(() => parse('form f { repeat p ring(8) }')).toThrow(/expected "around"/);
  });

  it('rejects an action that is none of place, fasten or repeat', () => {
    expect(() => parse('form f { turn 5deg }')).toThrow(/expected place, fasten or repeat/);
  });

  it('lets a material clause on a placement span up to two words plus a finish', () => {
    const [action] = parseOneForm('form f { place p in rose gold polished }');
    if (action.kind !== 'place') throw new Error();
    expect(action.placement.material).toEqual(['rose', 'gold', 'polished']);
  });
});

describe('parse: spans', () => {
  it('gives every node a span that points back into the source', () => {
    const program = parse('let n = 42');
    const stmt = program.statements[0];
    if (stmt.kind !== 'let') throw new Error();
    expect(stmt.value.span).toMatchObject({ start: 8, end: 10 });
  });
});
