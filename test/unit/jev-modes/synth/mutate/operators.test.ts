import { describe, expect, it } from 'vitest';
import { OPERATOR_NAMES, OPERATOR_PRIORS, applyOperator, lineInfo, lineToks, primaries, render, statementTemplates } from '../../../../../src/jev-modes/synth/mutate/index.js';
import type { OperatorName } from '../../../../../src/jev-modes/synth/mutate/index.js';
import { ctx } from './helpers.js';

/** Rendered outputs of one operator on one line (unfiltered, so tests see exactly what the operator proposes). */
function run(op: OperatorName, line: string, over = {}): string[] {
  return applyOperator(op, lineToks(line), ctx(over)).map(render);
}

describe('line analysis', () => {
  it('finds head keyword, assignment position, header colon and protected names', () => {
    const info = lineInfo(lineToks('for i, count in enumerate(arr, start=1):'));
    expect(info.head).toBe('for');
    expect(info.headerColon).toBe(true);
    expect(info.assignAt).toBe(-1);
    const protectedNames = [...info.protectedIdx].map((k) => info.toks[k]!.text);
    expect(protectedNames).toEqual(['i', 'count', 'start']);
    expect(lineInfo(lineToks('x += f(y)')).assignAt).toBe(1);
    expect(lineInfo(lineToks('def f(a, b=1):')).protectedIdx.has(1)).toBe(true);
  });
  it('enumerates nested primaries', () => {
    const t = lineToks('return gcd(a % b, len(xs))');
    expect(primaries(lineInfo(t)).map((p) => render(t.slice(p.start, p.end)))).toEqual(['gcd(a % b, len(xs))', 'a', 'b', 'len(xs)', 'xs']);
  });
});

describe('operators', () => {
  it('relational_swap covers the six relational operators and the is/in flips', () => {
    expect(run('relational_swap', 'while lo <= hi:')).toEqual(['while lo < hi:', 'while lo > hi:', 'while lo >= hi:', 'while lo == hi:', 'while lo != hi:']);
    expect(run('relational_swap', 'if x is None:')).toEqual(['if x is not None:', 'if x == None:']);
    expect(run('relational_swap', 'if x not in seen:')).toEqual(['if x in seen:']);
    expect(run('relational_swap', 'for x in xs:')).toEqual([]);
  });
  it('boundary_shift moves the operator and the literal together', () => {
    expect(run('boundary_shift', 'if len(arr) == 0:')).toContain('if len(arr) <= 1:');
    expect(run('boundary_shift', 'if 0 < k:')).toContain('if 1 <= k:');
    expect(run('boundary_shift', 'if a < b:')).toEqual([]);
  });
  it('arithmetic_swap and augassign_swap', () => {
    expect(run('arithmetic_swap', 'x = a % b')).toEqual(['x = a + b', 'x = a - b', 'x = a * b', 'x = a / b', 'x = a // b', 'x = a ** b']);
    expect(run('arithmetic_swap', 'n ^= n - 1')).toContain('n ^= n + 1');
    expect(run('augassign_swap', 'n ^= n - 1')).toContain('n &= n - 1');
    expect(run('augassign_swap', 'n ^= n - 1')).toContain('n = n - 1');
    expect(run('augassign_swap', 'x = y')).toEqual(['x += y', 'x -= y']);
    expect(run('arithmetic_swap', 'f(-1)')).toEqual([]);
  });
  it('boolean_swap and keyword_flip', () => {
    expect(run('boolean_swap', 'if a and b or c:')).toEqual(['if a or b or c:', 'if a and b and c:']);
    expect(run('keyword_flip', 'return True')).toEqual(['return False']);
  });
  it('off_by_one_literal shifts integer literals only', () => {
    expect(run('off_by_one_literal', 'x = arr[0] + 1.5')).toEqual(['x = arr[1] + 1.5', 'x = arr[-1] + 1.5']);
    expect(run('off_by_one_literal', "s = 'a1'")).toEqual([]);
  });
  it('off_by_one_atom adds and removes ±1 on names and calls in operand position', () => {
    expect(run('off_by_one_atom', 'return binsearch(mid, end)')).toContain('return binsearch(mid + 1, end)');
    expect(run('off_by_one_atom', 'dp[i, j] = dp[i - 1, j] + 1')).toContain('dp[i, j] = dp[i - 1, j - 1] + 1');
    expect(run('off_by_one_atom', 'dp[i, j] = dp[i - 1, j] + 1')).toContain('dp[i, j] = dp[i, j] + 1');
    expect(run('off_by_one_atom', 'return [1] + (len(digit_list)) * [0] + [1]')).toContain('return [1] + (len(digit_list) - 1) * [0] + [1]');
    // targets, for-loop variables and the whole condition are not operands
    expect(run('off_by_one_atom', 'for x in arr:')).toEqual(['for x in arr + 1:', 'for x in arr - 1:']);
    expect(run('off_by_one_atom', 'if done:')).toEqual([]);
  });
  it('index_flip flips 0/-1, swaps pairs and slice halves, and exchanges two subscripts', () => {
    expect(run('index_flip', 'return xs[0]')).toEqual(['return xs[-1]', 'return xs[1]']);
    expect(run('index_flip', 'a[i, k] + a[j, k]')).toContain('a[i, k] + a[k, j]');
    expect(run('index_flip', 'if perm[j] < perm[i]:')).toContain('if perm[i] < perm[j]:');
    expect(run('index_flip', 'x[a:b]')).toContain('x[b:a]');
  });
  it('slice_tweak adds slices with scope bounds and shifts existing bounds', () => {
    const out = run('slice_tweak', 'for x in arr:', { valueNames: ['arr', 'k'] });
    expect(out).toContain('for x in arr[k:]:');
    expect(out).toContain('for x in arr[1:]:');
    expect(run('slice_tweak', 'return f(a[1:], b)', { valueNames: ['a', 'b'] })).toContain('return f(a[1:], b[1:])');
    expect(run('slice_tweak', 'return a[1:]')).toContain('return a');
    expect(run('slice_tweak', 'return a[1:]')).toContain('return a[:1]');
    expect(run('slice_tweak', 'return a[1:]')).toContain('return a[1 + 1:]');
  });
  it('argument_swap permutes call, tuple and subscript parts pairwise', () => {
    expect(run('argument_swap', 'return gcd(a % b, b)')).toEqual(['return gcd(b, a % b)']);
    expect(run('argument_swap', 'op(token, a, b)')).toEqual(['op(a, token, b)', 'op(b, a, token)', 'op(token, b, a)']);
    expect(run('argument_swap', 'steps.append((start, helper))')).toEqual(['steps.append((helper, start))']);
    expect(run('argument_swap', 'f(a,)')).toEqual([]);
  });
  it('operand_swap swaps the operands of comparisons and arithmetic', () => {
    expect(run('operand_swap', 'result = result + alphabet[i]')).toEqual(['result = alphabet[i] + result']);
    expect(run('operand_swap', 'if perm[j] < perm[i]:')).toEqual(['if perm[i] < perm[j]:']);
    expect(run('operand_swap', 'x = a + a')).toEqual([]);
  });
  it('negation toggles not on conditions, removes not, negates operands of and/or, flips unary minus', () => {
    const out = run('negation', 'if a and not b:');
    expect(out).toContain('if not a and not b:');
    expect(out).toContain('if a and b:');
    expect(out).toContain('if a and not not b:'.replace('not not ', ''));
    expect(run('negation', 'while not done:')).toContain('while done:');
    expect(run('negation', 'f(x, -y, 1)')).toEqual(expect.arrayContaining(['f(-x, -y, 1)', 'f(x, y, 1)', 'f(x, -y, -1)']));
    expect(run('negation', 'f(0)')).toEqual([]);
  });
  it('constant_substitution draws from the literal pool and rewrites empty containers', () => {
    expect(run('constant_substitution', 'return []', { valueNames: ['n'] })).toEqual(['return [[]]', 'return None', 'return [0]', 'return ()', 'return [n]']);
    expect(run('constant_substitution', 'x = 1', { valueNames: ['n'] })).toEqual(['x = 0', 'x = 2', 'x = -1', 'x = 10', 'x = n']);
    expect(run('constant_substitution', 'x = -1', { valueNames: [] })).toEqual(['x = -0', 'x = -2', 'x = -10']);
    expect(run('constant_substitution', 'return None')).toEqual(['return 0', 'return []', 'return False', "return ''"]);
  });
  it('string_substitution replaces string literals from the pool', () => {
    expect(run('string_substitution', "sep = ','")).toEqual(["sep = ''", "sep = 'x'"]);
  });
  it('identifier_substitution prefers family and stem names and treats True/False/None as slots', () => {
    expect(run('identifier_substitution', 'while lo <= hi:', { valueNames: ['arr', 'x', 'lo', 'hi'] })).toEqual(['while hi <= hi:', 'while arr <= hi:', 'while x <= hi:', 'while lo <= lo:', 'while lo <= arr:', 'while lo <= x:']);
    expect(run('identifier_substitution', 'while True:', { valueNames: ['queue'] })).toEqual(['while queue:']);
    expect(run('identifier_substitution', 'for i, count in enumerate(arr):', { valueNames: ['arr', 'counts'] })).toEqual(['for i, count in enumerate(counts):']);
    expect(run('identifier_substitution', 'x.successor = y', { valueNames: ['x', 'y'] })).toEqual(['y.successor = y', 'x.successor = x']);
  });
  it('call_substitution and attribute_substitution', () => {
    expect(run('call_substitution', 'if any(p for p in ps):')[0]).toBe('if all(p for p in ps):');
    expect(run('call_substitution', 'return x.f(1)')).toEqual([]);
    expect(run('attribute_substitution', 'if hare.successor is None:')).toEqual(['if hare.successors is None:', 'if hare.append is None:', 'if hare.add is None:']);
  });
  it('wrap_call wraps values and squares operands', () => {
    expect(run('wrap_call', 'longest = length + 1', { valueNames: ['longest', 'length'] })).toContain('longest = max(longest, length + 1)');
    expect(run('wrap_call', 'x = x + y')).toContain('x = max(0, x + y)');
    expect(run('wrap_call', 'while abs(x - approx) > epsilon:')).toContain('while abs(x - approx ** 2) > epsilon:');
    expect(run('wrap_call', 'return []')).toEqual([]);
  });
  it('unwrap_call drops a single-argument call or replaces a call with a name', () => {
    expect(run('unwrap_call', 'yield flatten(x)')).toContain('yield x');
    expect(run('unwrap_call', 'return get(a, b) + c', { valueNames: ['distance'] })).toContain('return distance + c');
    expect(run('unwrap_call', 'steps.append(x)')).toEqual([]);
    expect(run('unwrap_call', 'if any(x for x in xs):')).not.toContain('if x for x in xs:');
  });
  it('drop_term removes one operand of + - * and/or', () => {
    expect(run('drop_term', 'return 1 + f(x)')).toEqual(['return f(x)', 'return 1']);
    expect(run('drop_term', 'if a and b:')).toEqual(['if b:', 'if a:']);
  });
  it('return_tweak proposes names, predicates, literals and edits of the returned value', () => {
    const out = run('return_tweak', 'return True', { valueNames: ['depth'] });
    expect(out).toEqual(expect.arrayContaining(['return depth', 'return [depth]', 'return depth == 0', 'return not depth', 'return depth + True', 'return None', 'return True + 1', 'return True[0]']));
    expect(run('return_tweak', 'return [[first] + s for s in rest]', { valueNames: ['rest'] })).toContain('return rest + [[first] + s for s in rest]');
    expect(run('return_tweak', 'x = 1')).toEqual([]);
  });
  it('condition_extension adds guards from the line, the scope and sibling comparisons', () => {
    const out = run('condition_extension', 'if hare.successor is None:', { valueNames: ['node'], comparisons: ['k < n'] });
    expect(out).toContain('if hare is None or hare.successor is None:');
    expect(out).toContain('if hare.successor is None or not node:');
    expect(out).toContain('if hare.successor is None and k < n:');
    expect(run('condition_extension', 'while True:', { valueNames: ['queue'] })).toContain('while queue:');
    expect(run('condition_extension', 'x = 1')).toEqual([]);
  });
  it('drop_index, method_to_assign and binop_with_identifier', () => {
    expect(run('drop_index', 'w[u, v] = min(', { valueNames: ['w_by_node'] })).toEqual(['w[u] = min(', 'w[v] = min(', 'w = min(']);
    expect(run('drop_index', 'weight_by_edge[u, v] = 1', { valueNames: ['weight_by_node'] })).toContain('weight_by_node[v] = 1');
    expect(run('method_to_assign', 'g[node].update(g[u])')).toEqual(['g[node] = g[u]', 'g[node] = [g[u]]', 'g[node] += g[u]']);
    expect(run('method_to_assign', 'x = y')).toEqual(['x.append(y)', 'x.add(y)', 'x.update(y)']);
    expect(run('binop_with_identifier', 'return kth(above, k)', { valueNames: ['k', 'num'] })).toEqual(['return kth(above - k, k)', 'return kth(above + k, k)', 'return kth(above - num, k)', 'return kth(above + num, k)', 'return kth(above, k - num)', 'return kth(above, k + num)']);
  });
  it('statement_template only fires on an empty (insert) line', () => {
    expect(run('statement_template', 'x = 1')).toEqual([]);
    const out = statementTemplates(ctx({ valueNames: ['lines', 'text'] })).map(render);
    expect(out).toEqual(expect.arrayContaining(['lines.append(text)', 'text = lines', 'return lines', 'lines.pop()']));
    expect(out.length).toBe(2 * 6 + 2 * 4);
  });
  it('protects def parameters, lambda parameters and as-targets from value operators', () => {
    const def = 'def pad(text: str, width: int, *args, **kw) -> str:';
    const info = lineInfo(lineToks(def));
    expect([...info.protectedIdx].map((k) => info.toks[k]!.text)).toEqual(['pad', 'text', 'str', 'width', 'int', 'args', 'kw']);
    for (const op of ['off_by_one_atom', 'negation', 'slice_tweak', 'wrap_call', 'binop_with_identifier', 'unwrap_call', 'argument_arity'] as const) {
      for (const cand of run(op, def)) expect(cand.startsWith('def pad(text: str, width')).toBe(true);
    }
    expect(run('identifier_substitution', 'def pad(text: str, width: int):', { valueNames: ['text', 'width', 'n'] })).toEqual([]);
    const lam = 'ranked = sorted(freqs.items(), key=lambda kv: kv[1])';
    for (const op of ['off_by_one_atom', 'negation', 'slice_tweak', 'wrap_call', 'binop_with_identifier'] as const) {
      for (const cand of run(op, lam)) expect(cand).toContain('lambda kv:');
    }
    expect(run('identifier_substitution', 'with open(p) as fh:', { valueNames: ['p', 'q'] })).toEqual(['with open(q) as fh:']);
    // defaults are still values
    expect(run('off_by_one_literal', 'def f(a, b=1):')).toEqual(['def f(a, b=2):', 'def f(a, b=0):']);
  });
  it('argument_swap never moves a keyword argument before a positional one', () => {
    expect(run('argument_swap', 'sorted(xs, key=f)')).toEqual([]);
    expect(run('argument_swap', 'g(a, b, key=f, reverse=True)')).toEqual(['g(b, a, key=f, reverse=True)', 'g(a, b, reverse=True, key=f)']);
    expect(run('argument_swap', 'f(*args, x)')).toEqual([]);
  });
  it('off_by_one_atom parenthesises the shift next to a tighter operator', () => {
    const out = run('off_by_one_atom', 'start = number * size');
    expect(out).toContain('start = (number - 1) * size');
    expect(out).toContain('start = number * (size + 1)');
    expect(out).toContain('start = number * size - 1');
    expect(run('off_by_one_atom', 'x = a + b')).not.toContain('x = (a + 1) + b');
  });
  it('constant_substitution shifts float literals by a decade and from the float pool', () => {
    expect(run('constant_substitution', '"free_over": 500.0,')).toEqual(['"free_over": 0.5,', '"free_over": 2.0,', '"free_over": 5000.0,', '"free_over": 50.0,']);
    expect(run('constant_substitution', 'x = 0.0', { floatLiterals: [] })).toEqual([]);
  });
  it('call_substitution keeps builtins with builtins and user functions with user functions', () => {
    const callNames = ['letter_grade', 'weighted_average', 'student_average', 'rank', 'report', 'ValueError', 'len', 'sum', 'zip', 'sorted', 'max'];
    expect(run('call_substitution', 'return total / len(weights)', { callNames }).slice(0, 4)).toEqual(['return total / sum(weights)', 'return total / zip(weights)', 'return total / sorted(weights)', 'return total / max(weights)']);
    expect(run('call_substitution', 'return rank(xs)', { callNames })[0]).toBe('return letter_grade(xs)');
  });
  it('attribute_substitution puts methods first for a call and last for a plain attribute', () => {
    const over = { attrNames: ['balance', 'history', 'deposit', 'withdraw', 'append'], methodNames: ['deposit', 'withdraw', 'append'] };
    expect(run('attribute_substitution', 'dst.withdraw(amount)', over)).toEqual(['dst.deposit(amount)', 'dst.append(amount)', 'dst.balance(amount)', 'dst.history(amount)']);
    expect(run('attribute_substitution', 'x = dst.balance', over)).toEqual(['x = dst.history', 'x = dst.deposit', 'x = dst.withdraw', 'x = dst.append']);
  });
  it('argument_arity drops one positional argument or appends a literal / compatible name before the keywords', () => {
    expect(run('argument_arity', 'parts = text.strip().split("-", 1)', { valueNames: [] })).toEqual(['parts = text.strip(0).split("-", 1)', 'parts = text.strip(1).split("-", 1)', 'parts = text.strip(-1).split("-", 1)', 'parts = text.strip().split(1)', 'parts = text.strip().split("-")', 'parts = text.strip().split("-", 1, 0)', 'parts = text.strip().split("-", 1, -1)']);
    expect(run('argument_arity', 'x = q.pop()', { valueNames: ['i'] })).toEqual(['x = q.pop(0)', 'x = q.pop(1)', 'x = q.pop(-1)', 'x = q.pop(i)']);
    expect(run('argument_arity', 'cells.append(pad(cell, width))', { valueNames: ['fill', 'width', 'cell'] })).toContain('cells.append(pad(cell, width, fill))');
    expect(run('argument_arity', 'sorted(xs, key=f)', { valueNames: ['ys'] })).toEqual(['sorted(xs, 0, key=f)', 'sorted(xs, 1, key=f)', 'sorted(xs, -1, key=f)', 'sorted(xs, ys, key=f)']);
    // a bare generator argument, a def header and a tuple are left alone
    expect(run('argument_arity', 'if any(n % p > 0 for p in primes):')).toEqual([]);
    expect(run('argument_arity', 'def f(a):')).toEqual([]);
    expect(run('argument_arity', 'x = (a, b)')).toEqual([]);
  });
  it('collapse_collection_to_element keeps one element of a tuple / list / set literal or a bare tuple value, never of a call, a header or a dict', () => {
    expect(run('collapse_collection_to_element', 'return hash((a, b))')).toEqual(['return hash(a)', 'return hash(b)']);
    // attribute names inside an element are fine (django-15315's `self.creation_counter`)
    expect(run('collapse_collection_to_element', 'return hash((self.x, self.y if f(a, b) else None))')).toEqual(['return hash(self.x)', 'return hash(self.y if f(a, b) else None)']);
    expect(run('collapse_collection_to_element', 'x = [a, b, c]')).toEqual(['x = [a]', 'x = [b]', 'x = [c]']);
    expect(run('collapse_collection_to_element', 'x = {a, b}')).toEqual(['x = {a}', 'x = {b}']);
    expect(run('collapse_collection_to_element', 'return a, b')).toEqual(['return a', 'return b']);
    expect(run('collapse_collection_to_element', 'x = a, b')).toEqual(['x = a', 'x = b']);
    for (const l of ['f(a, b)', 'x = d[a, b]', 'def f(a, b):', 'for a, b in xs:', 'd = {a: 1, b: 2}', 'g(key=1, other=2)', 'x = (a for a in xs)', 'x = (a,)', 'x = [a]']) expect(run('collapse_collection_to_element', l), l).toEqual([]);
    // bounded: more than six elements is not a collection worth collapsing element by element
    expect(run('collapse_collection_to_element', 'x = (a, b, c, d, e, f, g)')).toEqual([]);
  });
  it('every operator has a prior in (0, 1] and never proposes the input line', () => {
    const lines = ['while lo <= hi:', 'return gcd(a % b, b)', 'dp[i, j] = dp[i - 1, j] + 1', 'x.y.append((a, b))', 'if not a and b is None or c not in d:'];
    for (const op of OPERATOR_NAMES) {
      expect(OPERATOR_PRIORS[op]).toBeGreaterThan(0);
      expect(OPERATOR_PRIORS[op]).toBeLessThanOrEqual(1);
      for (const l of lines) expect(run(op, l)).not.toContain(l);
    }
  });
});
