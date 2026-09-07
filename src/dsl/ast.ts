import type { Span } from './lexer';

export type Expr =
  | { kind: 'number'; value: number; span: Span }
  | { kind: 'string'; value: string; span: Span }
  | { kind: 'ident'; name: string; span: Span }
  | { kind: 'vector'; items: Expr[]; span: Span }
  | { kind: 'call'; callee: string; args: Arg[]; span: Span }
  | { kind: 'unary'; op: '-'; operand: Expr; span: Span }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/'; left: Expr; right: Expr; span: Span };

export interface Arg {
  /** Present for `radius: 5.5`, absent for positional. */
  name?: string;
  value: Expr;
  span: Span;
}

/** Modifiers shared by place and fasten. */
export interface Placement {
  at?: Expr;
  /** About Z, the axis a flat form is laid out in. */
  turn?: Expr;
  /** About Y and X, for lifting a part out of the plane. */
  pitch?: Expr;
  roll?: Expr;
  scale?: Expr;
  offset?: Expr;
  flip?: boolean;
  /** Raw words; a metal name may be two of them. */
  material?: string[];
  /** Radiance of a light, in sky units, overriding its material's. */
  glow?: Expr;
  as?: string;
  span: Span;
}

export type Action =
  | { kind: 'place'; part: Expr; placement: Placement; span: Span }
  | {
      kind: 'fasten';
      part: Expr;
      /** Which anchor of the part being fastened. Defaults to its first. */
      partAnchor?: string;
      target: { part: string; anchor: string };
      placement: Placement;
      span: Span;
    }
  | { kind: 'repeat'; subject: Expr; symmetry: Expr; span: Span };

export type Stmt =
  | { kind: 'use'; names: string[]; span: Span }
  | { kind: 'material'; words: string[]; span: Span }
  | { kind: 'let'; name: string; value: Expr; span: Span }
  | { kind: 'seed'; value: Expr; span: Span }
  | { kind: 'part'; name: string; value: Expr; material?: string[]; glow?: Expr; engravings: Expr[]; span: Span }
  | { kind: 'unit'; name: string; actions: Action[]; span: Span }
  | { kind: 'form'; name: string; actions: Action[]; span: Span };

export interface Program {
  statements: Stmt[];
}
