export type TokenKind =
  | 'ident' | 'number' | 'string'
  | 'punct' | 'eof';

export interface Span {
  start: number;
  end: number;
  line: number;
  column: number;
}

export interface Token {
  kind: TokenKind;
  text: string;
  /** Numbers arrive already converted: 30deg is radians, 0.5turns is radians. */
  value?: number;
  span: Span;
}

export class DslError extends Error {
  constructor(message: string, readonly span: Span) {
    super(message);
    this.name = 'DslError';
  }
}

const PUNCT = ['(', ')', '{', '}', ',', ':', '.', '=', '+', '-', '*', '/'];

/** Suffixes let a sketch say what it means instead of pre-multiplying by pi. */
const UNITS: Record<string, number> = {
  mm: 1,
  deg: Math.PI / 180,
  rad: 1,
  turn: Math.PI * 2,
  turns: Math.PI * 2,
};

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;

  const span = (start: number, end: number): Span => ({
    start, end, line, column: start - lineStart + 1,
  });

  while (i < source.length) {
    const c = source[i];

    if (c === '\n') { i++; line++; lineStart = i; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }

    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }

    if (c === '"') {
      const start = i;
      i++;
      let text = '';
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\n') throw new DslError('unterminated string', span(start, i));
        text += source[i++];
      }
      if (i >= source.length) throw new DslError('unterminated string', span(start, i));
      i++;
      tokens.push({ kind: 'string', text, span: span(start, i) });
      continue;
    }

    if (isDigit(c) || (c === '.' && isDigit(source[i + 1] ?? ''))) {
      const start = i;
      while (i < source.length && (isDigit(source[i]) || source[i] === '.')) i++;
      const raw = source.slice(start, i);
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) {
        throw new DslError(`"${raw}" is not a number`, span(start, i));
      }
      // optional unit suffix, glued to the digits
      let unit = '';
      const unitStart = i;
      while (i < source.length && isAlpha(source[i])) unit += source[i++];
      if (unit && !(unit in UNITS)) {
        throw new DslError(
          `unknown unit "${unit}" — try ${Object.keys(UNITS).join(', ')}`,
          span(unitStart, i),
        );
      }
      tokens.push({
        kind: 'number',
        text: raw + unit,
        value: numeric * (unit ? UNITS[unit] : 1),
        span: span(start, i),
      });
      continue;
    }

    if (isAlpha(c)) {
      const start = i;
      // No hyphens: they would make "span-2" a single name rather than a subtraction
      while (i < source.length && (isAlpha(source[i]) || isDigit(source[i]))) i++;
      tokens.push({ kind: 'ident', text: source.slice(start, i), span: span(start, i) });
      continue;
    }

    if (PUNCT.includes(c)) {
      tokens.push({ kind: 'punct', text: c, span: span(i, i + 1) });
      i++;
      continue;
    }

    throw new DslError(`unexpected character "${c}"`, span(i, i + 1));
  }

  tokens.push({ kind: 'eof', text: '', span: span(i, i) });
  return tokens;
}

const isDigit = (c: string) => c >= '0' && c <= '9';
const isAlpha = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';

/** Render an error against its source line, with a caret under the offending span. */
export function formatError(source: string, error: DslError): string {
  const lines = source.split('\n');
  const text = lines[error.span.line - 1] ?? '';
  const caret = ' '.repeat(Math.max(error.span.column - 1, 0)) +
    '^'.repeat(Math.max(error.span.end - error.span.start, 1));
  return `line ${error.span.line}: ${error.message}\n  ${text}\n  ${caret}`;
}
