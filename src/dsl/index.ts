import { Assembly } from '../assembly/assembly';
import { evaluate, type CompileOptions, type Sketch } from './eval';
import { DslError, formatError } from './lexer';
import { parse } from './parser';

export { DslError, formatError } from './lexer';
export { BUILTIN_NAMES, PART_NAMES } from './builtins';
export type { CompileOptions, Sketch } from './eval';

export interface CompileResult {
  sketch?: Sketch;
  error?: { message: string; line: number; column: number; start: number; end: number; formatted: string };
}

/**
 * Source to Assembly.
 *
 * Errors are values rather than exceptions, because the editor recompiles on
 * every keystroke and a half-typed sketch is the normal state, not a failure.
 */
export function compile(source: string, options: CompileOptions = {}): CompileResult {
  try {
    const resolve = options.resolve;
    return { sketch: evaluate(parse(source), { resolve }) };
  } catch (error) {
    if (error instanceof DslError) {
      return {
        error: {
          message: error.message,
          line: error.span.line,
          column: error.span.column,
          start: error.span.start,
          end: error.span.end,
          formatted: formatError(source, error),
        },
      };
    }
    throw error;
  }
}

/** Compile, or fall back to an empty assembly so the viewer always has something. */
export function compileOrEmpty(source: string): { assembly: Assembly; result: CompileResult } {
  const result = compile(source);
  return { assembly: result.sketch?.assembly ?? new Assembly('empty'), result };
}
