import { describe, expect, it } from 'vitest';
import { DslError } from '../lexer';
import { parse } from '../parser';
import { evaluate } from '../eval';

const build = (src: string) => evaluate(parse(src));
const buildErr = (src: string): DslError => {
  try {
    build(src);
    throw new Error('expected the sketch to fail to compile');
  } catch (e) {
    if (e instanceof DslError) return e;
    throw e;
  }
};

describe('evaluate: parts and placement', () => {
  it('builds a single placement from one place action', () => {
    const sketch = build('part p = leaf(length: 20, width: 10)\nform f { place p }');
    expect(sketch.assembly.placements).toHaveLength(1);
    expect(sketch.assembly.placements[0].part.name).toBe('p');
    expect(sketch.formName).toBe('f');
  });

  it('shares one Part between every placement of it', () => {
    const sketch = build('part p = leaf(length: 20, width: 10)\nform f { place p\n place p at (5, 0, 0) }');
    const [a, b] = sketch.assembly.placements;
    expect(a.part).toBe(b.part);
  });

  it('applies at/turn/scale as a matrix, translation last', () => {
    const sketch = build('part p = leaf(length: 20, width: 10)\nform f { place p at (5, 0, 0) }');
    const m = sketch.assembly.placements[0].matrix;
    // column-major 4x4: translation is the last column
    expect([m[12], m[13], m[14]]).toEqual([5, 0, 0]);
  });

  it('reports the last form as the sketch result even with several forms', () => {
    const sketch = build(`
      part p = leaf(length: 20, width: 10)
      form a { place p }
      form b { place p at (5, 0, 0)\n place p at (10, 0, 0) }
    `);
    expect(sketch.formName).toBe('b');
    expect(sketch.assembly.placements).toHaveLength(2);
  });
});

describe('evaluate: repeat', () => {
  it('multiplies a unit under a symmetry', () => {
    const sketch = build(`
      part p = leaf(length: 20, width: 10)
      unit u { place p }
      form f { repeat u around ring(6, radius: 10) }
    `);
    expect(sketch.assembly.placements).toHaveLength(6);
  });

  it('multiplies a bare part the same as a one-part unit', () => {
    const sketch = build(`
      part p = leaf(length: 20, width: 10)
      form f { repeat p around ring(4, radius: 10) }
    `);
    expect(sketch.assembly.placements).toHaveLength(4);
  });

  it('rejects repeating an undeclared unit', () => {
    const err = buildErr('form f { repeat nope around ring(4, radius: 10) }');
    expect(err.message).toMatch(/there is no unit called "nope"/);
  });

  it('rejects a symmetry expression that is not actually a symmetry', () => {
    const err = buildErr('part p = leaf(length: 20, width: 10)\nform f { repeat p around 5 }');
    expect(err.message).toMatch(/expected a symmetry after "around"/);
  });
});

describe('evaluate: fasten', () => {
  it('seats a part onto a named anchor of a placed part', () => {
    const sketch = build(`
      part petal = leaf(length: 20, width: 10, boss: 2)
      part stud = rivet(head: 3, height: 1, shank: 2, grip: 1)
      form f { place petal\n fasten stud to petal.boss }
    `);
    // the petal, the stud, and the fillet solderFillet adds where they meet
    expect(sketch.assembly.placements).toHaveLength(3);
    expect(sketch.assembly.placements[1].part.name).toBe('stud');
  });

  it('rejects fastening to a part that has not been placed yet', () => {
    const err = buildErr(`
      part petal = leaf(length: 20, width: 10, boss: 2)
      part stud = rivet(head: 3, height: 1, shank: 2, grip: 1)
      form f { fasten stud to petal.boss }
    `);
    expect(err.message).toMatch(/nothing called "petal" has been placed yet/);
  });

  it('rejects fastening to an anchor the target does not have', () => {
    const err = buildErr(`
      part petal = leaf(length: 20, width: 10)
      part stud = rivet(head: 3, height: 1, shank: 2, grip: 1)
      form f { place petal\n fasten stud to petal.nope }
    `);
    expect(err.message).toMatch(/"petal" has no anchor "nope"/);
  });

  it('rejects fastening by an anchor the fastened part does not have', () => {
    const err = buildErr(`
      part petal = leaf(length: 20, width: 10, boss: 2)
      part stud = rivet(head: 3, height: 1, shank: 2, grip: 1)
      form f { place petal\n fasten stud.nope to petal.boss }
    `);
    expect(err.message).toMatch(/"stud" has no anchor "nope"/);
  });
});

describe('evaluate: material', () => {
  it('reports the sketch-level default metal and finish', () => {
    const sketch = build('material gold polished\npart p = leaf(length: 20, width: 10)\nform f { place p }');
    expect(sketch.metal).toBe('gold');
    expect(sketch.finish).toBe('polished');
  });

  it('lets a part declare its own material', () => {
    const sketch = build(`
      material gold polished
      part p = leaf(length: 20, width: 10) in silver satin
      form f { place p }
    `);
    expect(sketch.assembly.placements[0].part.material).toEqual({ metal: 'silver', finish: 'satin' });
  });

  it('resolves a two-word metal ahead of a one-word metal plus finish', () => {
    const sketch = build('material rose gold polished\npart p = leaf(length: 20, width: 10)\nform f { place p }');
    expect(sketch.metal).toBe('rose gold');
    expect(sketch.finish).toBe('polished');
  });

  it('rejects an unknown metal', () => {
    const err = buildErr('material unobtainium polished\npart p = leaf(length: 20, width: 10)\nform f { place p }');
    expect(err.message).toMatch(/there is no metal called "unobtainium"/);
  });

  it('rejects giving one part two different materials', () => {
    const err = buildErr(`
      part p = leaf(length: 20, width: 10) in gold polished
      part q = p
      form f { place q in silver satin }
    `);
    expect(err.message).toMatch(/already in gold/);
  });
});

describe('evaluate: names and scope', () => {
  it('resolves a let binding inside an argument', () => {
    const sketch = build('let w = 10\npart p = leaf(length: 20, width: w)\nform f { place p }');
    expect(sketch.assembly.placements).toHaveLength(1);
  });

  it('lets a later let silently rebind a name (no redeclaration guard outside use)', () => {
    // claim() only refuses a name use() has taken; a plain let may be rebound
    const sketch = build('let n = 1\nlet n = 2\npart p = leaf(length: n, width: 10)\nform f { place p }');
    expect(sketch.assembly.placements).toHaveLength(1);
  });

  it('rejects using a unit or form name as a value inside an expression', () => {
    const err = buildErr(`
      part p = leaf(length: 20, width: 10)
      unit u { place p }
      part q = leaf(length: u, width: 10)
      form f { place q }
    `);
    expect(err.message).toMatch(/is a unit or form/);
  });

  it('rejects calling an unknown builtin, with a suggestion for a near miss', () => {
    const err = buildErr('part p = laef(length: 20, width: 10)\nform f { place p }');
    expect(err.message).toMatch(/did you mean "leaf"/);
  });

  it('requires at least one form', () => {
    const err = buildErr('part p = leaf(length: 20, width: 10)');
    expect(err.message).toMatch(/a sketch needs at least one form/);
  });
});

describe('evaluate: use', () => {
  const resolve = (sketches: Record<string, string>) => (name: string) => sketches[name];

  it('imports another sketch\'s last form under the used name', () => {
    const sketches = {
      flower: 'part p = leaf(length: 20, width: 10)\nform bloom { place p }',
    };
    const sketch = evaluate(parse('use flower\nform f { place flower }'), { resolve: resolve(sketches) });
    expect(sketch.assembly.placements).toHaveLength(1);
  });

  it('rejects an import cycle', () => {
    const sketches = {
      a: 'use b\nform fa { place b }',
      b: 'use a\nform fb { place a }',
    };
    expect(() => evaluate(parse('use a\nform f { place a }'), { resolve: resolve(sketches) }))
      .toThrow(/already being used/);
  });

  it('rejects using a sketch that does not resolve', () => {
    expect(() => evaluate(parse('use nope\nform f { }'), { resolve: resolve({}) }))
      .toThrow(/there is no sketch called "nope"/);
  });

  it('rejects redeclaring a name already brought in by use', () => {
    const sketches = { flower: 'part p = leaf(length: 20, width: 10)\nform bloom { place p }' };
    expect(() => evaluate(parse('use flower\nform flower { }'), { resolve: resolve(sketches) }))
      .toThrow(/already defined here by "use"/);
  });
});
