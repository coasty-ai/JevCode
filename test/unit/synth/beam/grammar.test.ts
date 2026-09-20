import { describe, expect, it } from 'vitest';
import { END, analysePrefix, legalNext, lineKindOf } from '../../../../src/synth/beam/grammar.js';
import type { LineKind } from '../../../../src/synth/beam/grammar.js';
import { detokenize, toks } from '../../../../src/synth/beam/tokens.js';
import type { Tok } from '../../../../src/synth/beam/tokens.js';

const legal = (prefix: string, next: string, kind: LineKind = 'unknown', attributeOnly = false): boolean => {
  const t: Tok | typeof END = next === END ? END : toks(next)[0]!;
  return legalNext(toks(prefix), kind)(t, attributeOnly);
};

describe('grammar: legality table', () => {
  const table: [prefix: string, next: string, kind: LineKind, expected: boolean, why: string][] = [
    // statement starts
    ['', 'return', 'simple', true, 'simple statement keyword may open a simple line'],
    ['', 'x', 'simple', true, 'an expression or assignment may open a simple line'],
    ['', 'if', 'header', true, 'a header must start with a compound keyword'],
    ['', 'return', 'header', false, 'a header cannot become a return'],
    ['', 'x', 'header', false, 'a header cannot become an expression'],
    ['', 'else', 'simple', false, 'else needs a body: never a simple line'],
    ['', 'if', 'simple', true, 'one-liner `if x: return` is a simple line'],
    ['', ')', 'unknown', false, 'a closer cannot open a line'],
    ['', '+', 'unknown', false, 'a binary operator cannot open a line'],
    ['', '-', 'unknown', true, 'unary minus can open an expression'],
    // after values
    ['x', 'y', 'unknown', false, 'identifier cannot follow identifier'],
    ['x', '+', 'unknown', true, 'operator after a value'],
    ['x', '(', 'unknown', true, 'call after a name'],
    ['1', '(', 'unknown', false, 'a number is not callable'],
    ['x', '.', 'unknown', true, 'attribute access after a value'],
    ['x', 'in', 'unknown', true, '`in` after a value'],
    ['x', 'not', 'unknown', true, '`not in` starts after a value'],
    ['x not', 'in', 'unknown', true, '`in` after `not` after a value'],
    ['x', 'if', 'unknown', true, 'ternary `if` after a value'],
    ['x', 'return', 'unknown', false, 'statement keyword cannot follow a value'],
    // operators: never two in a row, unary minus allowed once
    ['x +', '*', 'unknown', false, 'two operators in a row'],
    ['x +', '-', 'unknown', true, 'unary minus after a binary operator'],
    ['x + -', '-', 'unknown', false, 'no second unary minus'],
    ['x + -', '1', 'unknown', true, 'operand after unary minus'],
    ['x =', '-', 'unknown', true, 'negative literal after assignment'],
    ['x +', ')', 'unknown', false, 'closer right after an operator'],
    // brackets
    ['f(', ')', 'unknown', true, 'empty call'],
    ['f(', ']', 'unknown', false, 'mismatched closer'],
    ['f(x', ']', 'unknown', false, 'mismatched closer with content'],
    ['f(x,', ')', 'unknown', true, 'trailing comma before closer'],
    ['a[', ':', 'unknown', true, 'slice starting at the beginning'],
    ['a[1', ':', 'unknown', true, 'slice colon after a value inside brackets'],
    ['a[1:', ']', 'unknown', true, 'open-ended slice'],
    ['f(1', ':', 'unknown', false, 'no colon inside a call'],
    ['{1', ':', 'unknown', true, 'dict key colon'],
    ['f(', '*', 'unknown', true, 'unpacking after an opener'],
    ['f(', '**', 'unknown', true, 'kwargs unpacking after an opener'],
    ['x +', '*', 'unknown', false, 'no unpacking after a binary operator'],
    ['x.', 'y', 'unknown', true, 'identifier after a dot'],
    ['x.', '1', 'unknown', false, 'a number cannot follow a dot'],
    ['x.', '(', 'unknown', false, 'an opener cannot follow a dot'],
    // keywords
    ['for', 'i', 'unknown', true, 'loop target after for'],
    ['for', '1', 'unknown', false, 'a literal cannot be a loop target'],
    ['for i', 'in', 'unknown', true, '`in` after the loop target'],
    ['lambda x', ':', 'unknown', true, 'lambda colon'],
    ['lambda x:', 'x', 'unknown', true, 'lambda body'],
    ['x is', 'not', 'unknown', true, '`is not`'],
    ['x is', 'None', 'unknown', true, 'literal after `is`'],
    ['else', ':', 'unknown', true, 'else colon'],
    ['try', 'x', 'unknown', false, 'try takes only a colon'],
    ['try', ':', 'unknown', true, 'try colon'],
    ['pass', 'x', 'unknown', false, 'nothing may follow pass'],
    ['return', 'not', 'unknown', true, '`not` starts the returned expression'],
    // header colons and one-liners
    ['if x', ':', 'header', true, 'header colon after the condition'],
    ['if x:', 'return', 'header', false, 'a header line ends at its colon'],
    ['if x:', 'return', 'simple', true, 'one-liner body on a simple line'],
    ['if f(lambda: 0)', ':', 'header', true, 'a lambda inside brackets does not steal the header colon'],
    ['x', ':', 'simple', true, 'annotation colon after a lone name'],
    ['x = y', ':', 'simple', false, 'no colon in a plain assignment'],
  ];
  for (const [prefix, next, kind, expected, why] of table) {
    it(`${JSON.stringify(prefix)} → ${JSON.stringify(next)} [${kind}] is ${expected ? 'legal' : 'illegal'}: ${why}`, () => {
      expect(legal(prefix, next, kind)).toBe(expected);
    });
  }
});

describe('grammar: END_OF_LINE legality', () => {
  const table: [prefix: string, kind: LineKind, expected: boolean, why: string][] = [
    ['', 'unknown', false, 'an empty line is not a fix'],
    ['return gcd(b, a % b)', 'simple', true, 'complete return with balanced brackets'],
    ['return gcd(b, a % b', 'simple', false, 'unbalanced brackets'],
    ['return', 'simple', true, 'bare return'],
    ['return x +', 'simple', false, 'dangling operator'],
    ['break', 'simple', true, 'bare break'],
    ['x = 1', 'simple', true, 'assignment'],
    ['x =', 'simple', false, 'assignment without a value'],
    ['if x:', 'header', true, 'header ends at its colon'],
    ['if x', 'header', false, 'header without its colon'],
    ['if x: return y', 'header', false, 'a header must not carry a body'],
    ['if x: return y', 'simple', true, 'one-liner is a complete simple line'],
    ['if x:', 'simple', false, 'a bare header cannot replace a simple line'],
    ['if x', 'simple', false, 'condition without colon is not a statement'],
    ['if x', 'unknown', true, 'measured unconstrained behaviour keeps the superset'],
    ['lambda x', 'simple', false, 'lambda waiting for its colon'],
    ['f = lambda x: x + 1', 'simple', true, 'lambda closed'],
    ['while queue:', 'header', true, 'while header'],
    ['else:', 'header', true, 'else header'],
    ['x.', 'simple', false, 'dangling dot'],
    ['a[1:]', 'simple', true, 'slice closed'],
  ];
  for (const [prefix, kind, expected, why] of table) {
    it(`END after ${JSON.stringify(prefix)} [${kind}] is ${expected ? 'legal' : 'illegal'}: ${why}`, () => {
      expect(legal(prefix, END, kind)).toBe(expected);
    });
  }
});

describe('grammar: attribute-only tokens and prefix analysis', () => {
  it('attribute-only tokens are legal only after a dot', () => {
    expect(legal('x.', 'append', 'unknown', true)).toBe(true);
    expect(legal('x +', 'append', 'unknown', true)).toBe(false);
    expect(legal('', 'append', 'unknown', true)).toBe(false);
    expect(legal('x +', 'append', 'unknown', false)).toBe(true);
  });
  it('analysePrefix tracks brackets, header colon and lambdas per depth', () => {
    expect(analysePrefix(toks('f(a, [1,')).stack).toEqual([')', ']']);
    expect(analysePrefix(toks('if x:')).headerColon).toBe(true);
    expect(analysePrefix(toks('x = {1: 2}')).headerColon).toBe(false);
    const nested = analysePrefix(toks('if f(lambda'));
    expect(nested.lambdaOpen).toBe(true);
    expect(nested.lambdaHere).toBe(true);
    const closed = analysePrefix(toks('if f(lambda: 0)'));
    expect(closed.lambdaOpen).toBe(false);
    // a lambda abandoned inside a closed bracket no longer blocks the line
    expect(analysePrefix(toks('f(lambda)')).lambdaOpen).toBe(false);
  });
  it('every legal path of a measured fix line is admitted token by token', () => {
    for (const [line, kind] of [
      ['return gcd(b, a % b)', 'simple'],
      ['while k < len(arr) and arr[k] > arr[k - 1]:', 'header'],
      ['memo[i, j] = max(memo[i, j], value + memo[i - 1, j - weight])', 'simple'],
      ['if all(n % p for p in primes):', 'header'],
      ['return [x for x in arr if x < pivot]', 'simple'],
      ["print(', '.join(str(x) for x in xs))", 'simple'],
      ['nodesvisited.add(node)', 'simple'],
      ['rest_subsets = subsequences(k + 1, n, length - 1)', 'simple'],
      ['x = -1 if a is None else a[0]', 'simple'],
    ] as [string, LineKind][]) {
      const ts = toks(line);
      for (let k = 0; k < ts.length; k++) {
        const ok = legalNext(ts.slice(0, k), kind);
        expect(ok(ts[k]!), `${line}: token ${k} ${JSON.stringify(ts[k]!.text)} after ${JSON.stringify(detokenize(ts.slice(0, k)))}`).toBe(true);
      }
      expect(legalNext(ts, kind)(END), `${line}: END`).toBe(true);
    }
  });
});

describe('grammar: lineKindOf', () => {
  it('classifies headers, simple statements, one-liners and inserts', () => {
    expect(lineKindOf('    if b == 0:')).toBe('header');
    expect(lineKindOf('for i in range(n):')).toBe('header');
    expect(lineKindOf('else:')).toBe('header');
    expect(lineKindOf('def f(a, b):')).toBe('header');
    expect(lineKindOf('async def f(a, b):')).toBe('header');
    expect(lineKindOf('async with lock:')).toBe('header');
    expect(lineKindOf('async for x in xs: pass')).toBe('simple');
    expect(lineKindOf('return a')).toBe('simple');
    expect(lineKindOf('x = {1: 2}')).toBe('simple');
    expect(lineKindOf('if x: return y')).toBe('simple');
    expect(lineKindOf('')).toBe('simple');
    expect(lineKindOf('@decorator')).toBe('unknown');
  });
});
