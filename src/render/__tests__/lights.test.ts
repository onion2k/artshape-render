import { describe, expect, it } from 'vitest';
import { lightNames, metals } from '../materials';
import { evaluate } from '../../dsl/eval';
import { parse } from '../../dsl/parser';

describe('light materials', () => {
  it('every neon and diode is a light with a colour and a glow', () => {
    expect(lightNames.length).toBeGreaterThanOrEqual(12);
    for (const n of lightNames) {
      const m = metals[n];
      expect(m.model).toBe('light');
      expect(m.colour).toBeDefined();
      expect(m.glow).toBeGreaterThan(0);
    }
    // a diode is a point of light, so it is brighter than a tube
    expect(metals['red diode'].glow!).toBeGreaterThan(metals['red neon'].glow!);
  });

  it('a two-word light name resolves as a material in a sketch', () => {
    const sketch = evaluate(parse('part t = wire(path: circle(radius: 10), radius: 1, closed: yes) in pink neon\nform f { place t }'));
    expect(sketch.assembly.placements[0].part.material).toEqual({ metal: 'pink neon', finish: undefined });
  });
});

describe('tables', () => {
  it('offers velvet and silk beside the hard surfaces', async () => {
    const { tableNames } = await import('../viewer');
    expect(tableNames).toEqual(['matte', 'oak', 'walnut', 'slate', 'linen', 'velvet', 'silk']);
  });
});
