/**
 * OOS iteration 3, item 1 — the LATE-GUARD rule as its adversarial review re-specified it
 * (`/tmp/review-iter3-2026-09-22.md` findings 1 and 3), and the sweeps that bound it.
 *
 * Iteration 3 shipped a two-shape rule: `position > 0 AND (some prior sibling READS an operand
 * ROOT, OR — for an insertion — no prior sibling BINDS one)`. The review showed both disjuncts
 * misfire on correct code, and that the repo's own real-world corpus contains a gold the rule
 * flags (`sympy__sympy-17139`). Shape (b) degenerated to "not the first statement", because
 * nothing ever binds a parameter.
 *
 * The rule now has ONE shape, and every clause of it is a suppression: a preceding sibling
 * DEREFERENCES the operand's exact dotted path — `p.attr`, `p[…]`, `p.method(…)`, a use the value
 * the guard rejects would have made fail — and nothing in front BINDS that path's root and
 * nothing in front NARROWS it with an exiting guard of its own.
 *
 * The consequence is measured below and is not comfortable: the tightened rule is silent on all
 * three of iteration 1's recorded overfits as well. That is why `late_guard` is no longer a
 * `POOL_SUSPECT_SIGNAL` — a signal with no positive evidence on the records cannot be the
 * evidence that a pool holds no gold.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createGuardMemory } from '../../../../src/synth/search/bases.js';
import { POOL_SUSPECT_SIGNALS, decide, mutationRefused, newlyLateGuards, structuralRejection, suspicionSignals } from '../../../../src/synth/search/guard.js';
import { analyse, guardClauses, isLateGuard } from '../../../../src/synth/py/index.js';
import type { VerifyOutcome } from '../../../../src/synth/search/types.js';
import { REPO_ROOT, candidate, committedBase, failure, goal as goalOf, plausibleOutcome, scriptedAsk, siteAt, sourceFile, summary, throwingAsk } from './helpers.js';

const LADDER = join(REPO_ROOT, 'bench/data/ladder/tasks');
const QUIXBUGS = join(REPO_ROOT, 'bench/data/quixbugs');
const read = (p: string): string => readFileSync(p, 'utf8');

/** A one-file patch as `newlyLateGuards` reads it. */
function lateGuardsOf(path: string, before: string, after: string): string[] {
  return newlyLateGuards({ files: [{ path, before, after }] }).map((x) => `${x.fn}:${x.guard.test}`);
}

/** A function's first guard clause, for the structural facts. */
function firstClause(src: string, fn?: string) {
  const mod = analyse(src);
  const block = fn === undefined ? mod.blocks[0]! : mod.blocks.find((b) => b.name === fn)!;
  return guardClauses(mod, block)[0]!;
}

// ---------------------------------------------------------------------------------------
// The structural facts
// ---------------------------------------------------------------------------------------

describe('guardClauses reads the placement, not the condition', () => {
  it('a guard clause is an `if` with no elif/else whose body leaves the suite; `while` and an ordinary branch are not', () => {
    const mod = analyse(['def f(xs, k):', '    """doc"""', '    if not xs:', '        return None', '    total = 0', '    while k > 0:', '        k -= 1', '    if k == 0:', '        total += 1', '    else:', '        total -= 1', '    return total', ''].join('\n'));
    const clauses = guardClauses(mod, mod.blocks[0]!);
    expect(clauses.map((g) => g.test)).toEqual(['not xs']);
    // the docstring is not a position, so the guard is at the top of the block and never late
    expect(clauses[0]).toMatchObject({ position: 0, operands: ['xs'], roots: ['xs'] });
    expect(isLateGuard(clauses[0]!)).toBe(false);
  });

  it('a condition over nothing but builtins and literals has no operand to be placed relative to', () => {
    const g = firstClause(['def f(a):', '    a = a + 1', '    if True:', '        return 0', '    return a', ''].join('\n'));
    expect(g).toMatchObject({ position: 1, operands: [], roots: [] });
    expect(isLateGuard(g)).toBe(false);
  });

  /**
   * The rule is not vacuous: a parameter that a statement in front DEREFERENCES, with nothing
   * binding or narrowing it, is exactly the shape the signal exists for.
   */
  it('a guard behind a dereference of its own operand, with no bind and no narrowing, IS late', () => {
    const before = ['def f(x):', '    x.run()', '    return x', ''].join('\n');
    const after = ['def f(x):', '    x.run()', '    if x is None:', '        return None', '    return x', ''].join('\n');
    expect(lateGuardsOf('m.py', before, after)).toEqual(['f:x is None']);
    const g = firstClause(after);
    expect(g.perOperand['x']).toEqual({ derefs: 1, binds: 0, narrows: 0, reads: 1 });
  });
});

// ---------------------------------------------------------------------------------------
// Review findings 1 and 3: every one of these correct shapes must be SILENT
// ---------------------------------------------------------------------------------------

/** The review's own table, verbatim as minimal Python. Each entry fired on `c469c9e`. */
const CORRECT_SHAPES: readonly { name: string; before: string; after: string; why: string }[] = [
  {
    name: 'an attribute guard behind an unrelated attribute call (finding 1: the `self` root collapse)',
    why: '`self.logger.debug(…)` says nothing about `self.handler`; the root must not stand in for the path',
    before: 'def f(self):\n    pass\n',
    after: 'def f(self):\n    self.logger.debug("x")\n    if self.handler is None:\n        return None\n    return self.handler\n',
  },
  {
    name: '`len()` in front of an emptiness guard (finding 1)',
    why: 'the prior read cannot fail on the value the guard rejects, so it is not evidence',
    before: 'def f(xs):\n    n = len(xs)\n    return n\n',
    after: 'def f(xs):\n    n = len(xs)\n    if not xs:\n        raise ValueError("e")\n    return n\n',
  },
  {
    name: 'a guard that is only VALID after a narrowing guard (finding 1: the isinstance case)',
    why: '`"key" not in v` is meaningful only once `v` is a Mapping; the prior guard is a narrowing',
    before: 'def f(v):\n    if not isinstance(v, dict):\n        return None\n    return v\n',
    after: 'def f(v):\n    if not isinstance(v, dict):\n        return None\n    if "key" not in v:\n        raise KeyError("k")\n    return v\n',
  },
  {
    name: 'a guard the code PROVES cannot be hoisted (finding 1: bind in front)',
    why: '`xs = list(xs)` binds the operand, so the position was not a choice',
    before: 'def f(xs):\n    xs = list(xs)\n    xs.sort()\n    return xs\n',
    after: 'def f(xs):\n    xs = list(xs)\n    xs.sort()\n    if not xs:\n        return None\n    return xs\n',
  },
  {
    name: 'a second parameter guard after a first (finding 1: shape (b) degenerating)',
    why: 'nothing ever binds a parameter, so the old shape (b) made every non-first guard late',
    before: 'def f(a, b):\n    if a is None:\n        raise ValueError("a")\n    return a / b\n',
    after: 'def f(a, b):\n    if a is None:\n        raise ValueError("a")\n    if b == 0:\n        raise ValueError("b")\n    return a / b\n',
  },
  {
    name: 'a guard on a loop variable inside the loop body (finding 1)',
    why: 'the `for` target is the parent, not a sibling, so nothing binds it at this level',
    before: 'def f(items):\n    for item in items:\n        seen(item)\n    return items\n',
    after: 'def f(items):\n    for item in items:\n        seen(item)\n        if item is None:\n            continue\n    return items\n',
  },
  {
    name: 'a guard behind a try/except that only passes the operand to a call (finding 1)',
    why: '`os.stat(path)` reads `path` as an argument; it does not dereference it',
    before: 'def f(path):\n    try:\n        st = os.stat(path)\n    except OSError:\n        st = None\n    return st\n',
    after: 'def f(path):\n    try:\n        st = os.stat(path)\n    except OSError:\n        st = None\n    if path is None:\n        raise ValueError("p")\n    return st\n',
  },
  {
    name: 'a guard behind a comprehension over the operand (finding 1)',
    why: 'iterating a list cannot fail on empty, which is what the guard rejects',
    before: 'def f(rows):\n    names = [r.name for r in rows]\n    return names\n',
    after: 'def f(rows):\n    names = [r.name for r in rows]\n    if not rows:\n        return []\n    return names\n',
  },
  { name: '`with … as x` (finding 3)', why: 'the binder\'s own target was scored as a read', before: 'def f(p):\n    head()\n    with open(p) as x:\n        pass\n    return x\n', after: 'def f(p):\n    head()\n    with open(p) as x:\n        pass\n    if not x:\n        return None\n    return x\n' },
  { name: '`except E as x` (finding 3)', why: 'the binder\'s own target was scored as a read', before: 'def f():\n    try:\n        go()\n    except Error as x:\n        pass\n    return x\n', after: 'def f():\n    try:\n        go()\n    except Error as x:\n        pass\n    if not x:\n        return None\n    return x\n' },
  { name: '`import mod as x` (finding 3)', why: 'an import reads no local', before: 'def f():\n    head()\n    import mod as x\n    return x\n', after: 'def f():\n    head()\n    import mod as x\n    if not x:\n        return None\n    return x\n' },
  { name: 'a walrus target (finding 3)', why: 'the name before `:=` is a target, not a read', before: 'def f(src):\n    head()\n    if (x := next(src)) is None:\n        pass\n    return x\n', after: 'def f(src):\n    head()\n    if (x := next(src)) is None:\n        pass\n    if not x:\n        return None\n    return x\n' },
  { name: 'an in-place mutation in front (finding 3)', why: '`x.append(1)` binds the operand', before: 'def f(x):\n    x.append(1)\n    return x\n', after: 'def f(x):\n    x.append(1)\n    if not x:\n        return None\n    return x\n' },
  { name: '`global x` (finding 3)', why: 'a scope declaration reads nothing', before: 'def f():\n    head()\n    global x\n    return x\n', after: 'def f():\n    head()\n    global x\n    if not x:\n        return None\n    return x\n' },
  { name: 'a subscript assignment in front (finding 3)', why: '`x[0] = 1` is a bind, not a hoistable gap', before: 'def f(x):\n    x[0] = 1\n    return x\n', after: 'def f(x):\n    x[0] = 1\n    if not x:\n        return None\n    return x\n' },
  { name: '`del x[0]` (finding 3)', why: '`del` is a bind, not a hoistable gap', before: 'def f(x):\n    del x[0]\n    return x\n', after: 'def f(x):\n    del x[0]\n    if not x:\n        return None\n    return x\n' },
];

describe('review findings 1 and 3: the rule is silent on every correct shape the review lists', () => {
  for (const c of CORRECT_SHAPES) {
    it(c.name, () => {
      expect({ case: c.name, fires: lateGuardsOf('m.py', c.before, c.after) }).toEqual({ case: c.name, fires: [] });
    });
  }

  /**
   * Review finding 1's headline: a gold in this repository's own real-world corpus.
   * `bench/data/swebench-verified-30.gold.json` → `sympy__sympy-17139` inserts
   * `if not rv.exp.is_real: return rv` behind `if not (rv.is_Pow and rv.base.func == f): return rv`.
   * `rv.exp` is only meaningful once `rv.is_Pow` holds, so the prior guard is a narrowing.
   */
  it('sympy__sympy-17139: the gold patch is silent (a prior exiting guard on the same root is a narrowing)', () => {
    const before = ['def _f(rv):', '    if not (rv.is_Pow and rv.base.func == f):', '        return rv', '', '    if (rv.exp < 0) == True:', '        return rv', '    return rv', ''].join('\n');
    const after = ['def _f(rv):', '    if not (rv.is_Pow and rv.base.func == f):', '        return rv', '    if not rv.exp.is_real:', '        return rv', '', '    if (rv.exp < 0) == True:', '        return rv', '    return rv', ''].join('\n');
    expect(lateGuardsOf('sympy/simplify/fu.py', before, after)).toEqual([]);
    const mod = analyse(after);
    const clause = guardClauses(mod, mod.blocks.find((b) => b.name === '_f')!).find((c) => c.test === 'not rv.exp.is_real')!;
    // it IS at position > 0 and it IS dereferenced in front (`rv.exp < 0` is later, `rv.is_Pow`
    // is earlier) — the narrowing is what keeps it silent
    expect(clause.position).toBeGreaterThan(0);
    expect(clause.perOperand['rv.exp.is_real']?.narrows).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------
// What the tightening costs: the three records the signal was built for
// ---------------------------------------------------------------------------------------

describe('the iteration-1 replay after the tightening (why `late_guard` left POOL_SUSPECT_SIGNALS)', () => {
  const STATS_SRC = read(join(LADDER, 'stats/src/stats.py'));
  const STATS_OVERFIT = STATS_SRC.replace('    return (ordered[mid - 1] + ordered[mid]) / 2', '    if not ordered:\n        raise ValueError("median of empty sequence")\n    return (ordered[mid - 1] + ordered[mid]) / 2');
  const BUCKET_SRC = read(join(LADDER, 'token_bucket/src/bucket.py'));
  const BUCKET_OVERFIT = BUCKET_SRC.replace('        if self.refill_per_second <= 0.0:', '        if cost > self.capacity or self.refill_per_second <= 0.0:');
  const DC_SRC = read(join(QUIXBUGS, 'programs/detect_cycle.py'));
  const DC_OVERFIT = DC_SRC.replace('        hare = hare.successor.successor', '        if not hare.successor.successor:\n            break\n        hare = hare.successor.successor');

  it('`stats` is now silent: `ordered = sorted(values)` BINDS the operand in front of the guard', () => {
    expect(lateGuardsOf('src/stats.py', STATS_SRC, STATS_OVERFIT)).toEqual([]);
    const g = analyse(STATS_OVERFIT).blocks.find((b) => b.name === 'median')!;
    const clause = guardClauses(analyse(STATS_OVERFIT), g).find((c) => c.test === 'not ordered')!;
    // the dereference is there (`ordered[mid]`), and so is the bind that suppresses it
    expect(clause.perOperand['ordered']).toMatchObject({ derefs: 1, binds: 1 });
  });

  it('`token_bucket` is now silent: `if self.tokens >= cost` only PLAIN-READS `cost`, and `self.sync(now)` is not a dereference of `self.capacity`', () => {
    expect(lateGuardsOf('src/bucket.py', BUCKET_SRC, BUCKET_OVERFIT)).toEqual([]);
    const mod = analyse(BUCKET_OVERFIT);
    const clause = guardClauses(mod, mod.blocks.find((b) => b.name === 'wait_for')!).find((c) => c.test.startsWith('cost >'))!;
    expect(clause.perOperand['cost']).toMatchObject({ derefs: 0, reads: 1 });
    expect(clause.perOperand['self.capacity']).toMatchObject({ derefs: 0 });
  });

  it('`detect_cycle` is now silent: nothing in front dereferences `hare.successor.successor` (the prior guard dereferences `hare`)', () => {
    expect(lateGuardsOf('detect_cycle.py', DC_SRC, DC_OVERFIT)).toEqual([]);
    const mod = analyse(DC_OVERFIT);
    const clause = guardClauses(mod, mod.blocks[0]!).find((c) => c.test === 'not hare.successor.successor')!;
    expect(clause.perOperand['hare.successor.successor']).toMatchObject({ derefs: 0 });
  });

  it('so the signal is not swept-clean-AND-positive, and is a lone-passer signal only', () => {
    expect([...POOL_SUSPECT_SIGNALS]).toEqual(['mutates_new_argument']);
    expect(POOL_SUSPECT_SIGNALS.has('late_guard')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// The sweeps
// ---------------------------------------------------------------------------------------

interface GoldPatch {
  name: string;
  path: string;
  before: string;
  after: string;
}

function quixbugsGolds(): GoldPatch[] {
  const out: GoldPatch[] = [];
  for (const f of readdirSync(join(QUIXBUGS, 'programs')).filter((x) => x.endsWith('.py'))) {
    if (!existsSync(join(QUIXBUGS, 'correct', f))) continue;
    out.push({ name: `quixbugs/${f}`, path: f, before: read(join(QUIXBUGS, 'programs', f)), after: read(join(QUIXBUGS, 'correct', f)) });
  }
  return out;
}

function ladderGolds(): GoldPatch[] {
  const out: GoldPatch[] = [];
  const walk = (dir: string, rel = ''): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), `${rel}${e.name}/`) : e.name.endsWith('.py') ? [`${rel}${e.name}`] : []));
  for (const task of readdirSync(LADDER)) {
    const goldDir = join(LADDER, task, 'gold');
    const srcDir = join(LADDER, task, 'src');
    if (!existsSync(goldDir) || !existsSync(srcDir)) continue;
    for (const f of walk(goldDir)) {
      if (!existsSync(join(srcDir, f))) continue;
      out.push({ name: `ladder/${task}/${f}`, path: `src/${f}`, before: read(join(srcDir, f)), after: read(join(goldDir, f)) });
    }
  }
  return out;
}

/** Every Python hunk of a unified diff, as the before/after image of its own context window. */
function hunkPatches(id: string, diff: string): GoldPatch[] {
  const out: GoldPatch[] = [];
  let path = '';
  let before: string[] = [];
  let after: string[] = [];
  const flush = (): void => {
    if (path.endsWith('.py') && (before.length > 0 || after.length > 0)) out.push({ name: `${id} ${path}`, path, before: `${before.join('\n')}\n`, after: `${after.join('\n')}\n` });
    before = [];
    after = [];
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ')) continue;
    if (line.startsWith('+++ b/')) {
      flush();
      path = line.slice('+++ b/'.length);
      continue;
    }
    if (line.startsWith('@@') || line.startsWith('diff --git') || line.startsWith('index ')) {
      if (line.startsWith('@@')) flush();
      continue;
    }
    if (line.startsWith('-')) before.push(line.slice(1));
    else if (line.startsWith('+')) after.push(line.slice(1));
    else if (line.startsWith(' ')) {
      before.push(line.slice(1));
      after.push(line.slice(1));
    }
  }
  flush();
  return out;
}

function swebenchGolds(): GoldPatch[] {
  const golds = JSON.parse(read(join(REPO_ROOT, 'bench/data/swebench-verified-30.gold.json'))) as Record<string, string>;
  return Object.entries(golds).flatMap(([id, diff]) => hunkPatches(id, diff));
}

describe('gold sweeps: every corpus in the repository', () => {
  const corpora: readonly [string, GoldPatch[]][] = [
    ['quixbugs', quixbugsGolds()],
    ['ladder', ladderGolds()],
    ['swebench-verified-30', swebenchGolds()],
  ];

  it('covers the 41 QuixBugs programs, every ladder task, and all 30 SWE-bench Verified instances (the four fresh django ones included)', () => {
    expect(quixbugsGolds()).toHaveLength(41);
    const tasks = new Set(ladderGolds().map((p) => p.name.split('/')[1]));
    expect(tasks.size).toBeGreaterThanOrEqual(26);
    for (const t of ['token_bucket', 'stats', 'deadline_queue', 'route_match', 'csv_schema']) expect(tasks.has(t)).toBe(true);
    const ids = new Set(swebenchGolds().map((p) => p.name.split(' ')[0]));
    for (const i of ['sympy__sympy-17139', 'django__django-14787', 'django__django-16100', 'django__django-14725', 'django__django-15375']) expect(ids.has(i)).toBe(true);
  });

  for (const [name, golds] of corpora) {
    it(`${name}: no gold patch adds a late guard`, () => {
      const firing = golds.filter((p) => lateGuardsOf(p.path, p.before, p.after).length > 0).map((p) => `${p.name}: ${lateGuardsOf(p.path, p.before, p.after).join(', ')}`);
      expect(firing).toEqual([]);
    });
  }

  it('and no gold is refused by a structural rule (the none-exit rejection and the `raises`-goal mutation rule stay silent too)', () => {
    const raisesEverything = goalOf([failure('t', 'ValueError raised', 'ValueError not raised')]);
    const refused = [...quixbugsGolds(), ...ladderGolds()].filter((p) => {
      const applied = { files: [{ path: p.path, before: p.before, after: p.after }] };
      return structuralRejection(applied) !== null || mutationRefused(applied, raisesEverything);
    });
    expect(refused.map((p) => p.name)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// The signal is still wired to the lone-passer advisory
// ---------------------------------------------------------------------------------------

describe('a genuine late guard is still a lone-passer signal', () => {
  const SRC = ['def handle(conn):', '    conn.open()', '    return conn.read()', ''].join('\n');
  const FILE = sourceFile('svc.py', SRC);
  const TEST = 'tests/test_svc.py::test_none_conn';
  const BASE = committedBase(FILE, summary({ passed: 3, failing: [TEST], failures: [{ testId: TEST, call: TEST, expected: 'None', actual: 'AttributeError' }] }));
  const GOAL = goalOf([failure(TEST, 'None', 'AttributeError')], { suspectedFiles: ['svc.py'] });

  const late = (): VerifyOutcome =>
    plausibleOutcome(candidate(siteAt(FILE, 3, 'insert'), '    if conn is None:\n        return None', { id: 'late_one', source: 'template', op: 'guard_none_return' }), BASE);

  it('`late_guard` reaches `suspicionSignals`, so the advisory is asked about it', () => {
    expect(suspicionSignals(late(), GOAL)).toContain('late_guard');
  });

  it('and a sole passer carrying it is never dropped — Jev keeps it and it commits', async () => {
    const mem = createGuardMemory(BASE);
    const ask = scriptedAsk((questions) => Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul' as const, noul: 0.9 }])));
    const d = await decide([late()], mem, GOAL, ask);
    expect(d.kind).toBe('commit');
    expect(d.signals).toContain('late_guard');
  });

  it('the sweep is a code-only property: a clean lone passer asks nobody', async () => {
    const mem = createGuardMemory(BASE);
    const clean = plausibleOutcome(candidate(siteAt(FILE, 2), '    conn.open()', { id: 'noop_clean' }), BASE);
    await expect(decide([clean], mem, GOAL, throwingAsk)).resolves.toMatchObject({ kind: 'commit', signals: [] });
  });
});
