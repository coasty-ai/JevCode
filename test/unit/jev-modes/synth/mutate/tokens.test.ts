import { describe, expect, it } from 'vitest';
import { binaryOps, bracketSignature, frag, isBalanced, lineToks, primaryEnd, primaryStart, render, splice, tokenKey } from '../../../../../src/jev-modes/synth/mutate/tokens.js';

const toks = (s: string) => lineToks(s);
const texts = (s: string, from: number, to: number) => render(toks(s).slice(from, to));

describe('token model', () => {
  it('renders back the line with its original spacing and drops comments', () => {
    expect(render(toks('dp[i, j] = dp[i - 1, j] + 1  # note'))).toBe('dp[i, j] = dp[i - 1, j] + 1');
    expect(render(toks('  x=1'))).toBe('x=1');
  });
  it('tokenKey ignores spacing so a+1 and a + 1 are one candidate', () => {
    expect(tokenKey(toks('a+1'))).toBe(tokenKey(toks('a + 1')));
    expect(tokenKey(toks('a + 1'))).not.toBe(tokenKey(toks('a + 2')));
  });
  it('frag builds tokens for an inserted piece with a controlled leading space', () => {
    expect(render(splice(toks('f(x)'), 3, 3, frag('+ 1', ' '), false))).toBe('f(x + 1)');
    expect(render(splice(toks('return x'), 1, 2, frag('y')))).toBe('return y');
  });
  it('primaryStart/primaryEnd span identifiers with trailers, groups and unary minus', () => {
    const line = 'a.b[i](x) + -c[0] < (d + e)';
    const t = toks(line);
    const plus = t.findIndex((k) => k.text === '+');
    expect(texts(line, primaryStart(t, plus), plus)).toBe('a.b[i](x)');
    expect(texts(line, plus + 1, primaryEnd(t, plus + 1))).toBe('-c[0]');
    const lt = t.findIndex((k) => k.text === '<');
    expect(texts(line, lt + 1, primaryEnd(t, lt + 1))).toBe('(d + e)');
    expect(primaryStart(t, 0)).toBe(-1);
    expect(primaryEnd(toks('+ 1'), 0)).toBe(-1);
  });
  it('binaryOps finds comparison, membership and identity operators but not for-in or unary minus', () => {
    const ops = (s: string) => binaryOps(toks(s), new Set(['<', '-', 'in', 'not in', 'is', 'is not', 'and'])).map((o) => o.text);
    expect(ops('for x in xs if x < -1 and y not in ys')).toEqual(['<', 'and', 'not in']);
    expect(ops('[x for x in xs if x is not None]')).toEqual(['is not']);
    expect(ops('a - b - -c')).toEqual(['-', '-']);
    expect(ops('f(*args, **kw)')).toEqual([]);
  });
  it('bracketSignature and isBalanced handle continuation lines', () => {
    expect(bracketSignature(toks('f(a, b)'))).toBe('|');
    expect(bracketSignature(toks('x = min('))).toBe('|(');
    expect(bracketSignature(toks('), nextnode)'))).toBe('))|');
    expect(bracketSignature(toks(') + f('))).toBe(')|(');
    expect(bracketSignature(toks('f(a]'))).toBe('!');
    expect(isBalanced(toks('x = (a + b'), 0, 2)).toBe(true);
    expect(isBalanced(toks('x = (a + b'), 2, 6)).toBe(false);
  });
});
