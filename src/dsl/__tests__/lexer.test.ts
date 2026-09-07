import { describe, expect, it } from 'vitest';
import { DslError, formatError, tokenize } from '../lexer';

describe('tokenize', () => {
  it('splits idents, numbers, strings and punctuation', () => {
    const tokens = tokenize('leaf(width: 3.5) "gold"');
    expect(tokens.map((t) => t.kind)).toEqual([
      'ident', 'punct', 'ident', 'punct', 'number', 'punct', 'string', 'eof',
    ]);
    expect(tokens.map((t) => t.text)).toEqual([
      'leaf', '(', 'width', ':', '3.5', ')', 'gold', '',
    ]);
  });

  it('skips whitespace and comments', () => {
    const tokens = tokenize('  a   # a comment\n  b');
    expect(tokens.map((t) => t.text)).toEqual(['a', 'b', '']);
  });

  it('converts a bare number as-is', () => {
    const [n] = tokenize('42');
    expect(n.value).toBe(42);
    expect(n.text).toBe('42');
  });

  it('converts degrees to radians', () => {
    const [n] = tokenize('30deg');
    expect(n.value).toBeCloseTo(Math.PI / 6);
    expect(n.text).toBe('30deg');
  });

  it('converts turns to radians', () => {
    const [n] = tokenize('0.5turns');
    expect(n.value).toBeCloseTo(Math.PI);
  });

  it('leaves a plain mm suffix at the same magnitude', () => {
    const [n] = tokenize('12mm');
    expect(n.value).toBe(12);
  });

  it('rejects an unknown unit', () => {
    expect(() => tokenize('5furlongs')).toThrow(DslError);
    expect(() => tokenize('5furlongs')).toThrow(/unknown unit "furlongs"/);
  });

  it('rejects an unterminated string', () => {
    expect(() => tokenize('"gold')).toThrow(/unterminated string/);
  });

  it('rejects a string spanning a newline', () => {
    expect(() => tokenize('"gold\nsatin"')).toThrow(/unterminated string/);
  });

  it('rejects an unexpected character', () => {
    expect(() => tokenize('a $ b')).toThrow(/unexpected character "\$"/);
  });

  it('tracks line and column across newlines', () => {
    const tokens = tokenize('a\nb  c');
    const [, b, c] = tokens;
    expect(b.span).toMatchObject({ line: 2, column: 1 });
    expect(c.span).toMatchObject({ line: 2, column: 4 });
  });

  it('does not treat a hyphen inside a name as a token break', () => {
    // names cannot contain hyphens at all: "a-b" lexes as three tokens, not one
    const tokens = tokenize('a-b');
    expect(tokens.map((t) => t.text)).toEqual(['a', '-', 'b', '']);
  });

  it('always terminates with an eof token', () => {
    const tokens = tokenize('');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].kind).toBe('eof');
  });
});

describe('formatError', () => {
  it('renders the offending line with a caret under the span', () => {
    const source = 'part x = leaf(widht: 3)';
    let error: DslError;
    try {
      tokenize('5furlongs');
      throw new Error('should have thrown');
    } catch (e) {
      error = e as DslError;
    }
    const formatted = formatError(source, error);
    expect(formatted).toContain('line 1:');
    expect(formatted.split('\n')).toHaveLength(3);
  });
});
