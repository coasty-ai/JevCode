import { describe, expect, it } from 'vitest';
import { PyIndentationError, PyTokenizeError } from '../../../../src/synth/py/errors.js';
import { codeTokens, indentWidth, lineStartOffsets, renderTokens, tokenize, tokenizeFragment, untokenize } from '../../../../src/synth/py/tokenize.js';
import type { Token } from '../../../../src/synth/py/tokenize.js';
import { FIXTURE_NAMES, cpythonTokens, fixture, rng } from './helpers.js';

const brief = (toks: readonly Token[]): [string, string, number, number, number, number][] => toks.map((t) => [t.type, t.text, t.line, t.col, t.endLine, t.endCol]);
const types = (toks: readonly Token[]): string => codeTokens(toks).map((t) => `${t.type}:${t.text}`).join(' ');

/** Structural invariants every token list must satisfy. */
function checkInvariants(src: string, toks: readonly Token[]): void {
  const starts = lineStartOffsets(src);
  let prevEnd = 0;
  for (const t of toks) {
    expect(src.slice(t.start, t.end)).toBe(t.text);
    expect(t.start).toBeGreaterThanOrEqual(prevEnd);
    expect(t.pre).toBe(src.slice(prevEnd, t.start));
    expect(t.pre).toMatch(/^[ \t\f\r\n\\]*$/);
    if (t.type !== 'ENDMARKER' && t.type !== 'DEDENT') expect(starts[t.line - 1]! + t.col).toBe(t.start);
    prevEnd = t.end;
  }
  expect(toks[toks.length - 1]?.type).toBe('ENDMARKER');
  expect(untokenize(toks)).toBe(src);
}

describe('tokenize: fixtures against CPython 3.9 tokenize output', () => {
  for (const name of FIXTURE_NAMES) {
    it(`${name}.py tokenizes identically (type, text, positions)`, () => {
      const src = fixture(name);
      const mine = brief(tokenize(src));
      expect(mine).toEqual(cpythonTokens(name));
    });
    it(`${name}.py round-trips through untokenize and satisfies the position invariants`, () => {
      const src = fixture(name);
      checkInvariants(src, tokenize(src));
    });
  }
});

describe('tokenize: tricky constructs', () => {
  it('nested f-strings with different quotes, conversions and nested format specs are one STRING', () => {
    const toks = codeTokens(tokenize(`s = f"{d['k']} {f'{x}'} {x:>{w}} {y!r} {z=} {{lit}}"\n`));
    expect(toks.map((t) => t.type)).toEqual(['NAME', 'OP', 'STRING']);
    expect(toks[2]!.text).toBe(`f"{d['k']} {f'{x}'} {x:>{w}} {y!r} {z=} {{lit}}"`);
  });
  it('3.12-style same-quote nesting inside a replacement field is one STRING (deviation from 3.9)', () => {
    const toks = codeTokens(tokenize(`s = f"{d["k"]} {f"{x}"}" + f"{x:'>10}"\n`));
    expect(toks.map((t) => t.type)).toEqual(['NAME', 'OP', 'STRING', 'OP', 'STRING']);
    expect(toks[2]!.text).toBe(`f"{d["k"]} {f"{x}"}"`);
    expect(toks[4]!.text).toBe(`f"{x:'>10}"`);
  });
  it('triple-quoted f-string with a dict literal and a newline inside the braces', () => {
    const src = 'x = f"""{\n  {"a": 1}["a"]\n}"""\n';
    const toks = codeTokens(tokenize(src));
    expect(toks.map((t) => t.type)).toEqual(['NAME', 'OP', 'STRING']);
    expect(toks[2]!.line).toBe(1);
    expect(toks[2]!.endLine).toBe(3);
  });
  it('every string prefix and quote style', () => {
    const src = `a = r'\\d' + R"x" + b'y' + B"z" + u'q' + f'{a}' + F"{b}" + rb'\\x' + Rb"c" + bR'd' + BR"e" + fr'{x}\\n' + rF"{y}" + '''t''' + """u"""\n`;
    const toks = codeTokens(tokenize(src));
    expect(toks.filter((t) => t.type === 'STRING')).toHaveLength(15);
    expect(toks.filter((t) => t.type === 'ERRORTOKEN')).toHaveLength(0);
  });
  it('a prefix that is not followed by a quote is a NAME', () => {
    expect(types(tokenize('rb = fr + b\n'))).toBe('NAME:rb OP:= NAME:fr OP:+ NAME:b');
  });
  it('numbers: hex/bin/oct/underscored/float/exponent/imaginary/leading-dot/trailing-dot', () => {
    const src = 'x = 0x_FF + 0b1010 + 0o17 + 1_000_000 + 3.14e-2 + .5 + 1. + 2j + 1.5J + 1E+5 + 0xDEAD_BEEF\n';
    const nums = codeTokens(tokenize(src)).filter((t) => t.type === 'NUMBER').map((t) => t.text);
    expect(nums).toEqual(['0x_FF', '0b1010', '0o17', '1_000_000', '3.14e-2', '.5', '1.', '2j', '1.5J', '1E+5', '0xDEAD_BEEF']);
  });
  it('`1if` splits into NUMBER and NAME like CPython; `0777` splits into 0 and 777', () => {
    expect(types(tokenize('x = 1if y else 0777\n'))).toBe('NAME:x OP:= NUMBER:1 NAME:if NAME:y NAME:else NUMBER:0 NUMBER:777');
  });
  it('all multi-character operators, walrus, arrow, ellipsis', () => {
    const src = 'a := 1; b **= 2; c //= 3; d -> e; ...; f >>= 1; g <<= 2; h @= i; j ^= k; l != m; n <= o >= p == q; r ** s // t << u >> v\n';
    const ops = codeTokens(tokenize(src)).filter((t) => t.type === 'OP').map((t) => t.text);
    for (const op of ['**=', '//=', '>>=', '<<=', '...', '!=', '**', '->', ':=', '//', '<=', '>=', '==', '<<', '>>', '@=', '^=']) expect(ops).toContain(op);
  });
  it('a lone `!` is an ERRORTOKEN (3.9 behaviour)', () => {
    expect(types(tokenize('x!y\n'))).toBe('NAME:x ERRORTOKEN:! NAME:y');
  });
  it('decorators, lambda, dict/set comprehensions, chained comparisons', () => {
    const src = '@dec.orator(1)\ndef f(x): return {k: v for k, v in x.items() if 0 < k <= 9}\ng = lambda a, *b, **c: {a for a in b}\n';
    const toks = tokenize(src);
    expect(types(toks)).toBe(
      'OP:@ NAME:dec OP:. NAME:orator OP:( NUMBER:1 OP:) NAME:def NAME:f OP:( NAME:x OP:) OP:: NAME:return OP:{ NAME:k OP:: NAME:v NAME:for NAME:k OP:, NAME:v NAME:in NAME:x OP:. NAME:items OP:( OP:) NAME:if NUMBER:0 OP:< NAME:k OP:<= NUMBER:9 OP:} NAME:g OP:= NAME:lambda NAME:a OP:, OP:* NAME:b OP:, OP:** NAME:c OP:: OP:{ NAME:a NAME:for NAME:a NAME:in NAME:b OP:}',
    );
    expect(toks.filter((t) => t.type === 'NEWLINE')).toHaveLength(3);
    expect(toks.filter((t) => t.type === 'INDENT')).toHaveLength(0);
  });
  it('unicode identifiers', () => {
    expect(types(tokenize("λ = 'ünïcode'; naïve_1 = 1\n"))).toBe("NAME:λ OP:= STRING:'ünïcode' OP:; NAME:naïve_1 OP:= NUMBER:1");
  });
});

describe('tokenize: lines, indentation, continuation', () => {
  it('backslash continuation emits no token and keeps the logical line', () => {
    const toks = tokenize('x = 1 + \\\n    2\n');
    expect(brief(toks)).toEqual([
      ['NAME', 'x', 1, 0, 1, 1],
      ['OP', '=', 1, 2, 1, 3],
      ['NUMBER', '1', 1, 4, 1, 5],
      ['OP', '+', 1, 6, 1, 7],
      ['NUMBER', '2', 2, 4, 2, 5],
      ['NEWLINE', '\n', 2, 5, 2, 6],
      ['ENDMARKER', '', 3, 0, 3, 0],
    ]);
    expect(toks[4]!.pre).toBe(' \\\n    ');
    expect(untokenize(toks)).toBe('x = 1 + \\\n    2\n');
  });
  it('newlines inside brackets are NL, blank and comment-only lines are NL and never indent', () => {
    const toks = tokenize('f(1,\n  2)\n\nif x:\n    y = 1\n  # odd comment\n\n    z = 2\n');
    expect(toks.filter((t) => t.type === 'NL')).toHaveLength(4);
    expect(toks.filter((t) => t.type === 'INDENT')).toHaveLength(1);
    expect(toks.filter((t) => t.type === 'DEDENT')).toHaveLength(1);
    const comment = toks.find((t) => t.type === 'COMMENT')!;
    expect([comment.line, comment.col, comment.text]).toEqual([6, 2, '# odd comment']);
  });
  it('INDENT carries the whitespace, DEDENT sits at the first token of the dedenting line', () => {
    const toks = tokenize('def f():\n    if a:\n        return 1\n    return 2\n');
    const indents = toks.filter((t) => t.type === 'INDENT');
    expect(indents.map((t) => [t.text, t.line, t.col, t.endCol])).toEqual([['    ', 2, 0, 4], ['        ', 3, 0, 8]]);
    const dedents = toks.filter((t) => t.type === 'DEDENT');
    expect(dedents.map((t) => [t.line, t.col])).toEqual([[4, 4], [5, 0]]);
  });
  it('tabs advance to the next multiple of 8: a tab and eight spaces are the same level', () => {
    expect(indentWidth('\t')).toBe(8);
    expect(indentWidth('  \t')).toBe(8);
    expect(indentWidth('\t  ')).toBe(10);
    expect(indentWidth('\f  ')).toBe(2);
    const toks = tokenize('if x:\n\ty = 1\n        z = 2\n');
    expect(toks.filter((t) => t.type === 'INDENT').map((t) => t.text)).toEqual(['\t']);
    expect(toks.filter((t) => t.type === 'DEDENT')).toHaveLength(1);
  });
  it('inconsistent dedent throws PyIndentationError with the line', () => {
    let err: unknown;
    try {
      tokenize('if x:\n    y = 1\n  z = 2\n');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PyIndentationError);
    expect(err).toBeInstanceOf(PyTokenizeError);
    const e = err as PyIndentationError;
    expect(e.kind).toBe('inconsistent_dedent');
    expect(e.line).toBe(3);
    expect(e.col).toBe(2);
  });
  it('CRLF line endings are kept in NEWLINE/NL tokens', () => {
    const src = 'if x:\r\n    y = 1\r\n\r\nz = 2\r\n';
    const toks = tokenize(src);
    expect(toks.filter((t) => t.type === 'NEWLINE').map((t) => [t.text, t.line, t.col, t.endCol])).toEqual([['\r\n', 1, 5, 7], ['\r\n', 2, 9, 11], ['\r\n', 4, 5, 7]]);
    expect(toks.find((t) => t.type === 'NL')!.text).toBe('\r\n');
    expect(untokenize(toks)).toBe(src);
  });
  it('missing trailing newline: synthetic NEWLINE then DEDENT/ENDMARKER on the next line', () => {
    expect(brief(tokenize('def f():\n    return 1'))).toEqual([
      ['NAME', 'def', 1, 0, 1, 3],
      ['NAME', 'f', 1, 4, 1, 5],
      ['OP', '(', 1, 5, 1, 6],
      ['OP', ')', 1, 6, 1, 7],
      ['OP', ':', 1, 7, 1, 8],
      ['NEWLINE', '\n', 1, 8, 1, 9],
      ['INDENT', '    ', 2, 0, 2, 4],
      ['NAME', 'return', 2, 4, 2, 10],
      ['NUMBER', '1', 2, 11, 2, 12],
      ['NEWLINE', '', 2, 12, 2, 13],
      ['DEDENT', '', 3, 0, 3, 0],
      ['ENDMARKER', '', 3, 0, 3, 0],
    ]);
  });
  it('comment-only file without newline, empty file, whitespace-only tail', () => {
    expect(brief(tokenize('# only'))).toEqual([
      ['COMMENT', '# only', 1, 0, 1, 6],
      ['NL', '', 1, 6, 1, 6],
      ['NEWLINE', '', 1, 6, 1, 7],
      ['ENDMARKER', '', 2, 0, 2, 0],
    ]);
    expect(brief(tokenize(''))).toEqual([['ENDMARKER', '', 1, 0, 1, 0]]);
    const ws = tokenize('x\n   ');
    expect(brief(ws)).toEqual([
      ['NAME', 'x', 1, 0, 1, 1],
      ['NEWLINE', '\n', 1, 1, 1, 2],
      ['ENDMARKER', '', 2, 0, 2, 0],
    ]);
    expect(untokenize(ws)).toBe('x\n   ');
  });
  it('form feed resets the indentation column', () => {
    const toks = tokenize('x = 1\n\f\ny = 2\n');
    expect(toks.filter((t) => t.type === 'INDENT' || t.type === 'DEDENT')).toHaveLength(0);
    expect(untokenize(toks)).toBe('x = 1\n\f\ny = 2\n');
  });
  it('multi-line strings report start and end positions across lines', () => {
    const toks = codeTokens(tokenize("s = '''a\nb'''\nt = 'abc\\\ndef'\n"));
    expect(brief(toks)).toEqual([
      ['NAME', 's', 1, 0, 1, 1],
      ['OP', '=', 1, 2, 1, 3],
      ['STRING', "'''a\nb'''", 1, 4, 2, 4],
      ['NAME', 't', 3, 0, 3, 1],
      ['OP', '=', 3, 2, 3, 3],
      ['STRING', "'abc\\\ndef'", 3, 4, 4, 4],
    ]);
  });
});

describe('tokenize: errors and error tokens', () => {
  const kindOf = (src: string): string => {
    try {
      tokenize(src);
    } catch (e) {
      return e instanceof PyTokenizeError ? `${e.kind}@${e.line}` : 'other';
    }
    return 'none';
  };
  it('EOF inside brackets or after a trailing continuation', () => {
    expect(kindOf('f(1')).toBe('eof_in_statement@2');
    expect(kindOf('f(1,\n  2,\n')).toBe('eof_in_statement@3');
    expect(kindOf('x = \\\n')).toBe('eof_in_statement@2');
  });
  it('EOF inside a triple-quoted string', () => {
    expect(kindOf("s = '''abc\n")).toBe('eof_in_string@2');
    expect(kindOf('s = f"""{x\n')).toBe('eof_in_string@2');
  });
  it('unterminated single-quoted string yields ERRORTOKEN for the quote and NAME for a prefix', () => {
    expect(types(tokenize("s = 'abc\n"))).toBe("NAME:s OP:= ERRORTOKEN:' NAME:abc");
    expect(types(tokenize('s = f"abc\n'))).toBe('NAME:s OP:= NAME:f ERRORTOKEN:" NAME:abc');
    expect(types(tokenize('s = f"{x}\n'))).toBe('NAME:s OP:= NAME:f ERRORTOKEN:" OP:{ NAME:x OP:}');
  });
  it('unknown characters are ERRORTOKENs, a lone CR is not a newline', () => {
    expect(types(tokenize('a $ b ? c\n'))).toBe('NAME:a ERRORTOKEN:$ NAME:b ERRORTOKEN:? NAME:c');
    expect(types(tokenize('x = 1\ry = 2\n'))).toBe('NAME:x OP:= NUMBER:1 ERRORTOKEN:\r NAME:y OP:= NUMBER:2');
  });
  it('an extra closing bracket does not turn the following lines into a continuation', () => {
    const toks = tokenize('x = 1)\ny = 2\n');
    expect(toks.filter((t) => t.type === 'NEWLINE')).toHaveLength(2);
  });
});

describe('untokenize and token editing', () => {
  it('editing a token text and re-rendering keeps every other byte', () => {
    const src = fixture('knapsack');
    const toks = tokenize(src);
    const lt = toks.find((t) => t.type === 'OP' && t.text === '<' && t.line === 12)!;
    const edited = toks.map((t) => (t === lt ? { ...t, text: '<=' } : t));
    expect(untokenize(edited)).toBe(src.replace('if weight < j:', 'if weight <= j:'));
  });
  it('renderTokens joins with single spaces where the source had whitespace or line breaks', () => {
    const toks = codeTokens(tokenize('memo[i, j] = max(\n    memo[i, j],\n    value + memo[i - 1, j - weight]\n)\n'));
    expect(renderTokens(toks)).toBe('memo[i, j] = max( memo[i, j], value + memo[i - 1, j - weight] )');
  });
});

describe('tokenizeFragment (lenient)', () => {
  it('accepts unbalanced brackets, bare indentation and unterminated strings without throwing', () => {
    expect(tokenizeFragment('    foo(a,').map((t) => t.type)).toEqual(['NAME', 'OP', 'NAME', 'OP']);
    // the failed triple quote becomes an ERRORTOKEN, the remaining two quotes a valid empty STRING
    expect(tokenizeFragment("x = '''abc").map((t) => t.type)).toEqual(['NAME', 'OP', 'ERRORTOKEN', 'STRING', 'NAME']);
    expect(tokenizeFragment('a\nb').map((t) => t.type)).toEqual(['NAME', 'NL', 'NAME']);
    expect(tokenizeFragment('x = 1 \\\n  + 2').map((t) => t.text)).toEqual(['x', '=', '1', '+', '2']);
  });
  it('emits no NEWLINE, INDENT, DEDENT or ENDMARKER and preserves positions', () => {
    const toks = tokenizeFragment('  if a < b:  # c');
    expect(toks.map((t) => [t.type, t.text, t.col])).toEqual([
      ['NAME', 'if', 2],
      ['NAME', 'a', 5],
      ['OP', '<', 7],
      ['NAME', 'b', 9],
      ['OP', ':', 10],
      ['COMMENT', '# c', 13],
    ]);
  });
});

describe('tokenize: round-trip property', () => {
  it('every line-prefix of every fixture either round-trips exactly or raises a typed error', () => {
    let roundTrips = 0;
    let typedErrors = 0;
    for (const name of FIXTURE_NAMES) {
      const src = fixture(name);
      const lines = src.split('\n');
      for (let k = 1; k <= lines.length; k++) {
        const prefix = lines.slice(0, k).join('\n');
        try {
          const toks = tokenize(prefix);
          checkInvariants(prefix, toks);
          roundTrips++;
        } catch (e) {
          if (!(e instanceof PyTokenizeError)) throw e;
          typedErrors++;
        }
      }
    }
    expect(roundTrips).toBeGreaterThan(150);
    expect(typedErrors).toBeGreaterThan(5);
  });
  it('random line deletions and duplications round-trip or raise a typed error', () => {
    const random = rng(20260920);
    let ok = 0;
    for (let round = 0; round < 120; round++) {
      const name = FIXTURE_NAMES[Math.floor(random() * FIXTURE_NAMES.length)]!;
      const lines = fixture(name).split('\n');
      const at = Math.floor(random() * lines.length);
      if (random() < 0.5) lines.splice(at, 1);
      else lines.splice(at, 0, lines[at]!);
      const src = lines.join('\n');
      try {
        checkInvariants(src, tokenize(src));
        ok++;
      } catch (e) {
        if (!(e instanceof PyTokenizeError)) throw e;
      }
    }
    expect(ok).toBeGreaterThan(60);
  });
});
