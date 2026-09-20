/**
 * VerifyQueue, vocabularyOf and passesVocab (docs/JEV-ONLY-DESIGN.md §2.3, §3, §6 row queue.ts).
 * Offline: no Jev, no Python; the QuixBugs `gcd` program and its JSON tests come from bench/data.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { Json } from '../../../../src/core/types.js';
import { analyse, blockAt, scopeAt } from '../../../../src/synth/py/index.js';
import type { Base, VerifyJob } from '../../../../src/synth/search/types.js';
import {
  canonicalText,
  isUnchanged,
  jobFor,
  missingFromVocab,
  missingFromVocabByPath,
  namesInProse,
  passesVocab,
  SOURCE_ORDER_PRIOR,
  triedKey,
  VerifyQueue,
  vocabulariesOf,
  vocabularyOf,
} from '../../../../src/synth/sieve/queue.js';
import type { Candidate, CandidateSourceName, FailureView, LineEdit, Site, SourceFile, TestRunSummary } from '../../../../src/synth/types.js';
import { applyCandidate } from '../../../../src/synth/verify/apply.js';
import { quixbugsTestId } from '../../../../src/synth/verify/quixbugs.js';

const here = dirname(fileURLToPath(import.meta.url));
const QUIXBUGS = join(here, '../../../../bench/data/quixbugs');

// ---------------------------------------------------------------------------------------
// Local fixtures (no other in-progress module is imported)
// ---------------------------------------------------------------------------------------

function sourceFile(path: string, src: string): SourceFile {
  return { path, src, mod: analyse(src) };
}

function siteFor(file: SourceFile, line: number, kind: 'replace' | 'insert' = 'replace'): Site {
  const lineText = file.mod.lines[line - 1] ?? '';
  const b = blockAt(file.mod, line);
  return {
    file,
    line,
    kind,
    currentLine: kind === 'insert' ? '' : lineText,
    indent: /^\s*/.exec(lineText)?.[0] ?? '',
    block: b === undefined ? null : { name: b.name, startLine: b.startLine, endLine: b.endLine },
    scope: scopeAt(file.mod, line),
    evidence: { notes: [] },
  };
}

let nextId = 0;
function cand(site: Site, text: string, over: Partial<Pick<Candidate, 'id' | 'source' | 'prior' | 'op'>> & { extraEdits?: LineEdit[] } = {}): Candidate {
  const c: Candidate = { id: over.id ?? `c${nextId++}`, site, text, source: over.source ?? 'mutation', op: over.op ?? 'test' };
  if (over.prior !== undefined) c.prior = over.prior;
  if (over.extraEdits !== undefined) c.extraEdits = over.extraEdits;
  return c;
}

function summary(passed: number, failing: string[] = []): TestRunSummary {
  return {
    command: 'python3 run_tests.py',
    passed,
    failed: failing.length,
    errors: 0,
    skipped: 0,
    total: passed + failing.length,
    failing,
    passing: [],
    failures: [],
    exitCode: failing.length > 0 ? 1 : 0,
    timedOut: false,
    durationMs: 10,
    outputTail: '',
  };
}

function baseFor(file: SourceFile, passed: number, origin: 'committed' | 'improved' = 'committed'): Base {
  return { id: `${origin}-${passed}`, origin, fromGoal: null, files: new Map([[file.path, file]]), summary: summary(passed), depth: origin === 'committed' ? 0 : 1 };
}

const GCD_BUGGY = readFileSync(join(QUIXBUGS, 'programs/gcd.py'), 'utf8');
const GCD_TESTS = JSON.parse(readFileSync(join(QUIXBUGS, 'tests/gcd.json'), 'utf8')) as { input: Json; expected: Json }[];
const GCD_FILE = sourceFile('gcd.py', GCD_BUGGY);
/** `return gcd(a % b, b)` is line 5 (index.json bugLine). */
const GCD_SITE = siteFor(GCD_FILE, 5);
const GCD_BASE = baseFor(GCD_FILE, 1);

/** FailureViews as `verify/quixbugs.ts` builds them from the runner's JSON: call = `gcd(13, 13)`, expected = repr. */
function gcdFailures(): FailureView[] {
  return GCD_TESTS.slice(1).map((t) => ({ testId: quixbugsTestId('gcd', t.input), call: quixbugsTestId('gcd', t.input), expected: JSON.stringify(t.expected), actual: 'RecursionError: maximum recursion depth exceeded' }));
}

// ---------------------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------------------

describe('VerifyQueue ordering: (base passed desc, p desc, source prior desc), stable insertion tiebreak', () => {
  const improved = baseFor(GCD_FILE, 3, 'improved');
  const committed = GCD_BASE; // passed 1
  const table: { label: string; base: Base; p: number; prior: number; text: string }[] = [
    { label: 'committed, p 0.9, prior 0.6', base: committed, p: 0.9, prior: 0.6, text: '    return gcd(b, a % b)' },
    { label: 'improved, p 0.1, prior 0.1', base: improved, p: 0.1, prior: 0.1, text: '    return gcd(b, a)' },
    { label: 'committed, p 0.9, prior 0.4 (same p, lower prior)', base: committed, p: 0.9, prior: 0.4, text: '    return gcd(a, b)' },
    { label: 'committed, p 0.2, prior 0.6', base: committed, p: 0.2, prior: 0.6, text: '    return gcd(a % b, a)' },
    { label: 'improved, p 0.5, prior 0.6', base: improved, p: 0.5, prior: 0.6, text: '    return gcd(b % a, a)' },
    { label: 'committed, p 0.9, prior 0.6 (exact tie, inserted later)', base: committed, p: 0.9, prior: 0.6, text: '    return gcd(b, b % a)' },
  ];

  it('pops in key order with ties broken by insertion order', () => {
    const q = new VerifyQueue();
    for (const row of table) {
      const c = cand(GCD_SITE, row.text, { prior: row.prior });
      expect(q.add(jobFor(c, row.base, row.p))).toBe('queued');
    }
    expect(q.size).toBe(6);
    const order = q.pop(6).map((j) => j.candidate.text.trim());
    expect(order).toEqual([
      'return gcd(b % a, a)', // improved base first (3 passed), then by p
      'return gcd(b, a)',
      'return gcd(b, a % b)', // committed: p 0.9 prior 0.6, inserted first
      'return gcd(b, b % a)', // exact tie → insertion order
      'return gcd(a, b)', // p 0.9, prior 0.4
      'return gcd(a % b, a)', // p 0.2
    ]);
    expect(q.size).toBe(0);
    expect(q.popped).toBe(6);
  });

  it('recomputes the key from the job fields and ignores a stale `key`', () => {
    const q = new VerifyQueue();
    const stale: VerifyJob = { ...jobFor(cand(GCD_SITE, '    return gcd(b, a % b)'), GCD_BASE, 0.1), key: [99, 99, 99] };
    q.add(stale);
    q.add(jobFor(cand(GCD_SITE, '    return gcd(a, b)'), GCD_BASE, 0.8));
    const [first, second] = q.pop(2);
    expect(first?.candidate.text.trim()).toBe('return gcd(a, b)');
    expect(second?.key).toEqual([1, 0.1, SOURCE_ORDER_PRIOR.mutation]);
  });

  it('pop(n) returns fewer when the queue runs out and peek does not consume', () => {
    const q = new VerifyQueue();
    q.add(jobFor(cand(GCD_SITE, '    return gcd(b, a % b)'), GCD_BASE));
    expect(q.peek()?.candidate.text.trim()).toBe('return gcd(b, a % b)');
    expect(q.size).toBe(1);
    expect(q.pop(5)).toHaveLength(1);
    expect(q.pop(5)).toHaveLength(0);
    expect(q.peek()).toBeUndefined();
  });

  it('jobFor: p defaults to the source prior (SIEVE mode) and the prior to the §3 source order', () => {
    const sources: CandidateSourceName[] = ['mutation', 'template', 'donor', 'composite', 'token_beam'];
    const priors = sources.map((s) => jobFor(cand(GCD_SITE, '    return gcd(b, a % b)', { source: s }), GCD_BASE).p);
    expect(priors).toEqual([...priors].sort((a, b) => b - a));
    const j = jobFor(cand(GCD_SITE, '    return gcd(b, a % b)', { prior: 0.33 }), GCD_BASE);
    expect(j).toMatchObject({ p: 0.33, sourcePrior: 0.33, key: [1, 0.33, 0.33] });
  });
});

// ---------------------------------------------------------------------------------------
// Dedupe and unchanged-line removal
// ---------------------------------------------------------------------------------------

describe('dedupe by canonical text per site', () => {
  it('the same text with different spacing or a trailing comment at the same site is a duplicate', () => {
    const q = new VerifyQueue();
    expect(q.add(jobFor(cand(GCD_SITE, '    return gcd(b, a % b)'), GCD_BASE))).toBe('queued');
    expect(q.add(jobFor(cand(GCD_SITE, '    return gcd(b,a%b)'), GCD_BASE))).toBe('duplicate');
    expect(q.add(jobFor(cand(GCD_SITE, '    return gcd(b, a % b)  # swap'), GCD_BASE))).toBe('duplicate');
    expect(q.dropped.duplicate).toBe(2);
    expect(q.size).toBe(1);
  });

  it('a repeated candidate id is a duplicate even with a different text', () => {
    const q = new VerifyQueue();
    q.add(jobFor(cand(GCD_SITE, '    return gcd(b, a % b)', { id: 'same' }), GCD_BASE));
    expect(q.add(jobFor(cand(GCD_SITE, '    return gcd(a, b)', { id: 'same' }), GCD_BASE))).toBe('duplicate');
    expect(q.has('same')).toBe(true);
  });

  it('distinct identifiers with the same token shape are NOT merged (normaliseLine would have folded them)', () => {
    const q = new VerifyQueue();
    expect(q.add(jobFor(cand(GCD_SITE, '    return gcd(b, a % b)'), GCD_BASE))).toBe('queued');
    expect(q.add(jobFor(cand(GCD_SITE, '    return gcd(a, b % a)'), GCD_BASE))).toBe('queued');
    expect(canonicalText({ text: '    return gcd(b, a % b)' })).not.toBe(canonicalText({ text: 'return gcd(a, b % a)' }));
    expect(q.size).toBe(2);
  });

  it('the same text at a different site (or as an insert) is a different job', () => {
    const q = new VerifyQueue();
    const otherSite = siteFor(GCD_FILE, 3); // `return a`
    const insertSite = siteFor(GCD_FILE, 5, 'insert');
    expect(q.add(jobFor(cand(GCD_SITE, '    return gcd(b, a % b)'), GCD_BASE))).toBe('queued');
    expect(q.add(jobFor(cand(otherSite, '        return gcd(b, a % b)'), GCD_BASE))).toBe('queued');
    expect(q.add(jobFor(cand(insertSite, '        return gcd(b, a % b)'), GCD_BASE))).toBe('queued');
    expect(q.size).toBe(3);
  });

  it('extra edits take part in the canonical text', () => {
    const q = new VerifyQueue();
    const extra: LineEdit[] = [{ path: 'gcd.py', line: 2, kind: 'replace', text: '    if b == 0 or a == 0:' }];
    expect(q.add(jobFor(cand(GCD_SITE, '    return gcd(b, a % b)'), GCD_BASE))).toBe('queued');
    expect(q.add(jobFor(cand(GCD_SITE, '    return gcd(b, a % b)', { extraEdits: extra }), GCD_BASE))).toBe('queued');
  });
});

describe('unchanged-line removal', () => {
  it('a replace candidate equal to the current line after trimming is dropped', () => {
    const q = new VerifyQueue();
    expect(isUnchanged(cand(GCD_SITE, 'return gcd(a % b, b)'))).toBe(true);
    expect(q.add(jobFor(cand(GCD_SITE, '  return gcd(a % b, b)   '), GCD_BASE))).toBe('unchanged');
    expect(q.add(jobFor(cand(GCD_SITE, '    return gcd(a%b,b)'), GCD_BASE))).toBe('unchanged');
    expect(q.dropped.unchanged).toBe(2);
    expect(q.size).toBe(0);
  });
  it('the current line plus an extra edit is a change; an empty insert is not', () => {
    const q = new VerifyQueue();
    const extra: LineEdit[] = [{ path: 'gcd.py', line: 2, kind: 'replace', text: '    if b == 0 or a == 0:' }];
    expect(q.add(jobFor(cand(GCD_SITE, '    return gcd(a % b, b)', { extraEdits: extra }), GCD_BASE))).toBe('queued');
    expect(q.add(jobFor(cand(siteFor(GCD_FILE, 5, 'insert'), '   '), GCD_BASE))).toBe('unchanged');
    expect(q.add(jobFor(cand(siteFor(GCD_FILE, 5, 'insert'), '        a, b = b, a'), GCD_BASE))).toBe('queued');
  });
});

// ---------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------

describe('vocabularyOf / passesVocab', () => {
  const vocab = vocabularyOf(GCD_FILE, gcdFailures(), 'Fix the gcd function so that `gcd(a, b)` returns the greatest common divisor.');

  it('the QuixBugs gcd fix passes the file + tests vocabulary', () => {
    const gold = cand(GCD_SITE, '    return gcd(b, a % b)');
    expect(passesVocab(gold, vocab)).toBe(true);
    expect(missingFromVocab(gold, vocab)).toEqual([]);
  });

  it('a candidate with a made-up name fails, naming the missing token', () => {
    const fake = cand(GCD_SITE, '    return gcd(b, remainder)');
    expect(passesVocab(fake, vocab)).toBe(false);
    expect(missingFromVocab(fake, vocab)).toEqual(['remainder']);
    const fakeExtra = cand(GCD_SITE, '    return gcd(b, a % b)', { extraEdits: [{ path: 'gcd.py', line: 2, kind: 'insert', text: '    frobnicate(a)' }] });
    expect(missingFromVocab(fakeExtra, vocab)).toEqual(['frobnicate']);
  });

  it('keywords, builtins, builtin-type methods and self/cls are always allowed', () => {
    expect(passesVocab(cand(GCD_SITE, '    return max(a, b) if b is None else abs(a)'), vocab)).toBe(true);
    expect(passesVocab(cand(GCD_SITE, '    return [a].append(b)'), vocab)).toBe(true);
    expect(passesVocab(cand(GCD_SITE, '    return self.gcd(cls, b)'), vocab)).toBe(true);
  });

  it('names come from the failing tests and from code-like or quoted words of the task text, not from prose', () => {
    const file = sourceFile('m.py', 'def f(x):\n    return x\n');
    const tests: FailureView[] = [{ testId: 'tests/test_m.py::test_f', call: 'f(Widget(3))', expected: "'ok'", actual: "AttributeError: 'Widget' object has no attribute 'colour'" }];
    const v = vocabularyOf(file, tests, 'The parser should accept a `metavar` option and honour exclude_dirs. See saferepr() and the value in "quoted words" here.');
    for (const present of ['f', 'x', 'test_f', 'Widget', 'colour', 'metavar', 'exclude_dirs', 'saferepr', 'quoted', 'words']) expect(v.has(present)).toBe(true);
    for (const absent of ['parser', 'should', 'accept', 'option', 'honour', 'See', 'the', 'value', 'here']) expect(v.has(absent)).toBe(false);
  });

  it('namesInProse: dotted paths on both sides of a dot, calls, camelCase; a sentence-final word is prose', () => {
    expect(namesInProse('Call module.helper then stop.')).toEqual(expect.arrayContaining(['module', 'helper']));
    expect(namesInProse('Call module.helper then stop.')).not.toContain('stop');
    expect(namesInProse('Use getValue and MyClass and run().')).toEqual(expect.arrayContaining(['getValue', 'MyClass', 'run']));
  });

  it('the queue drops vocabulary failures only for files that have a vocabulary', () => {
    const q = new VerifyQueue({ vocab: new Map([['gcd.py', vocab]]) });
    expect(q.add(jobFor(cand(GCD_SITE, '    return gcd(b, remainder)'), GCD_BASE))).toBe('vocab');
    expect(q.add(jobFor(cand(GCD_SITE, '    return gcd(b, a % b)'), GCD_BASE))).toBe('queued');
    const other = sourceFile('other.py', 'def g(x):\n    return x\n');
    expect(q.add(jobFor(cand(siteFor(other, 2), '    return frobnicate(x)'), baseFor(other, 0)))).toBe('queued');
    expect(q.dropped.vocab).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------
// Tried exclusion and carry-over
// ---------------------------------------------------------------------------------------

describe('tried exclusion via sha12 of the applied diff', () => {
  it('a candidate whose applied diff was run before is dropped; popped jobs carry the hash', () => {
    const gold = cand(GCD_SITE, '    return gcd(b, a % b)');
    const hash = triedKey(applyCandidate(gold, GCD_BASE.files).diff);
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
    const q = new VerifyQueue({ tried: new Set([hash]) });
    expect(q.add(jobFor(gold, GCD_BASE))).toBe('tried');
    // a different candidate id with the same edit is the same diff → also tried
    expect(q.add(jobFor(cand(GCD_SITE, '    return gcd(b, a % b)', { id: 'other-id', source: 'donor' }), GCD_BASE))).toBe('tried');
    expect(q.add(jobFor(cand(GCD_SITE, '    return gcd(a, b)'), GCD_BASE))).toBe('queued');
    const [job] = q.pop(1);
    expect(job?.diffHash).toBe(triedKey(applyCandidate(job!.candidate, GCD_BASE.files).diff));
    expect(q.dropped.tried).toBe(2);
  });

  it('a candidate whose site is stale on the base is dropped as apply_failed', () => {
    const edited = sourceFile('gcd.py', GCD_BUGGY.replace('return gcd(a % b, b)', 'return gcd(b, a)'));
    const improved = baseFor(edited, 2, 'improved');
    const q = new VerifyQueue();
    // the site still describes the committed text, which the improved base no longer has on line 5
    expect(q.add(jobFor(cand(GCD_SITE, '    return gcd(b, a % b)'), improved))).toBe('apply_failed');
    expect(q.dropped.apply_failed).toBe(1);
  });
});

describe('carry-over across two steps', () => {
  it('jobs not popped come back in key order and are re-enqueued by candidate id next step', () => {
    const step1 = new VerifyQueue();
    const texts = ['    return gcd(b, a % b)', '    return gcd(a, b)', '    return gcd(b, a)', '    return gcd(a % b, a)', '    return gcd(b % a, a)'];
    const cands = texts.map((t, i) => cand(GCD_SITE, t, { id: `k${i}` }));
    cands.forEach((c, i) => step1.add(jobFor(c, GCD_BASE, 0.9 - i * 0.1)));
    const ran = step1.pop(2);
    expect(ran.map((j) => j.candidate.id)).toEqual(['k0', 'k1']);
    const carried = step1.carryOver();
    expect(carried.map((j) => j.candidate.id)).toEqual(['k2', 'k3', 'k4']);
    expect(step1.size).toBe(0);
    expect(step1.has('k2')).toBe(false);

    // next step: the run memory now holds the two hashes that ran; the source re-enumerates everything
    const tried = new Set(ran.map((j) => j.diffHash));
    const step2 = new VerifyQueue({ tried, carried });
    expect(step2.size).toBe(3);
    expect(step2.toArray().map((j) => [j.candidate.id, j.p])).toEqual([['k2', 0.7], ['k3', 0.6], ['k4', 0.5]]);
    const again = step2.addAll(cands.map((c) => jobFor(c, GCD_BASE))); // SIEVE p = source prior this time
    expect(again.queued).toEqual([]);
    expect(again.dropped).toMatchObject({ tried: 2, duplicate: 3 });
    // the carried Jev p wins over the re-enumerated source prior
    expect(step2.pop(1)[0]).toMatchObject({ candidate: { id: 'k2' }, p: 0.7 });
  });

  it('a carried job that was run through another path meanwhile is dropped as tried', () => {
    const q1 = new VerifyQueue();
    const c = cand(GCD_SITE, '    return gcd(b, a % b)');
    q1.add(jobFor(c, GCD_BASE));
    const carried = q1.carryOver();
    const q2 = new VerifyQueue({ tried: new Set([carried[0]!.diffHash]), carried });
    expect(q2.size).toBe(0);
    expect(q2.dropped.tried).toBe(1);
  });
});

describe('the same candidate on two bases (§2.3 `for base in mem.bases`)', () => {
  it('is queued once per base, improved base first; ids are per base', () => {
    const improved = baseFor(GCD_FILE, 3, 'improved');
    const c = cand(GCD_SITE, '    return gcd(b, a % b)', { id: 'mutation:swap:abc' });
    const q = new VerifyQueue();
    expect(q.add(jobFor(c, GCD_BASE))).toBe('queued');
    expect(q.add(jobFor(c, improved))).toBe('queued');
    expect(q.add(jobFor(cand(GCD_SITE, '    return gcd(b,a%b)'), improved))).toBe('duplicate');
    expect(q.size).toBe(2);
    expect(q.has('mutation:swap:abc')).toBe(true);
    expect(q.has('mutation:swap:abc', improved.id)).toBe(true);
    expect(q.has('mutation:swap:abc', 'no-such-base')).toBe(false);
    const [first, second] = q.pop(2);
    expect(first?.base.id).toBe(improved.id);
    expect(second?.base.id).toBe(GCD_BASE.id);
    expect(q.has('mutation:swap:abc')).toBe(false);
  });

  it('a candidate run on the committed base is still enqueued on the improved base when its diff differs', () => {
    // the partial edit sits inside the 3-line diff context of the site, so the two diffs differ
    const edited = sourceFile('gcd.py', GCD_BUGGY.replace('return a', 'return abs(a)'));
    const improved = baseFor(edited, 2, 'improved');
    const c = cand(GCD_SITE, '    return gcd(b, a % b)');
    const onCommitted = triedKey(applyCandidate(c, GCD_BASE.files).diff);
    const q = new VerifyQueue({ tried: new Set([onCommitted]) });
    expect(q.add(jobFor(c, GCD_BASE))).toBe('tried');
    expect(q.add(jobFor(c, improved))).toBe('queued');
  });
});

describe('vocabulary per edited file', () => {
  const a = sourceFile('a.py', 'def f(x):\n    return g(x)\n');
  const b = sourceFile('b.py', 'from a import f\n\ndef caller(widgets):\n    return f(widgets)\n');
  const vocabA = vocabularyOf(a, [], '');
  const vocabB = vocabularyOf(b, [], '');
  const siteA = siteFor(a, 1);
  const base: Base = { id: 'committed-0', origin: 'committed', fromGoal: null, files: new Map([['a.py', a], ['b.py', b]]), summary: summary(0), depth: 0 };
  /** a composite signature + call-site unit: `f(x, widgets)` in a.py, `f(widgets, widgets)` in b.py */
  const unit = cand(siteA, 'def f(x, widgets):', { source: 'composite', extraEdits: [{ path: 'b.py', line: 4, kind: 'replace', text: '    return f(widgets, widgets)' }] });

  it('checks each edit against the vocabulary of the file it writes to', () => {
    expect(missingFromVocab(unit, vocabA)).toEqual(['widgets']); // a.py alone does not know `widgets`
    expect(missingFromVocabByPath(unit, new Map([['a.py', vocabA], ['b.py', vocabB]]))).toEqual(['widgets']);
    const vocabAWithTests = vocabularyOf(a, [{ testId: 'test_f', call: 'f(1, widgets)', expected: '1', actual: '2' }], '');
    expect(missingFromVocabByPath(unit, new Map([['a.py', vocabAWithTests], ['b.py', vocabB]]))).toEqual([]);
    const q = new VerifyQueue({ vocab: new Map([['a.py', vocabAWithTests], ['b.py', vocabB]]) });
    expect(q.add(jobFor(unit, base))).toBe('queued');
  });

  it('vocabulariesOf builds the per-path map for a base', () => {
    const m = vocabulariesOf(base.files, [], '');
    expect([...m.keys()]).toEqual(['a.py', 'b.py']);
    expect(m.get('b.py')?.has('caller')).toBe(true);
    expect(m.get('a.py')?.has('caller')).toBe(false);
  });

  it('an edit into a file without a vocabulary is not checked', () => {
    const q = new VerifyQueue({ vocab: new Map([['b.py', vocabB]]) });
    expect(q.add(jobFor(cand(siteA, 'def frobnicate(x):', { source: 'composite' }), base))).toBe('queued');
    const bad = cand(siteA, 'def f(x):', { source: 'composite', extraEdits: [{ path: 'b.py', line: 4, kind: 'replace', text: '    return frobnicate(widgets)' }] });
    expect(q.add(jobFor(bad, base))).toBe('vocab');
  });
});

describe('robustness', () => {
  it('a candidate whose edits cancel out (empty applied diff) is unchanged', () => {
    const line2 = GCD_FILE.mod.lines[1] ?? '';
    const q = new VerifyQueue();
    const c = cand(GCD_SITE, GCD_SITE.currentLine, { extraEdits: [{ path: 'gcd.py', line: 2, kind: 'replace', text: line2 }] });
    expect(isUnchanged(c)).toBe(false); // the extra edit looks like a change until it is applied
    expect(q.add(jobFor(c, GCD_BASE))).toBe('unchanged');
  });

  it('a non-finite p sorts after every finite one, deterministically', () => {
    const q = new VerifyQueue();
    q.add(jobFor(cand(GCD_SITE, '    return gcd(b, a % b)'), GCD_BASE, Number.NaN));
    q.add(jobFor(cand(GCD_SITE, '    return gcd(a, b)'), GCD_BASE, 0.05));
    q.add(jobFor(cand(GCD_SITE, '    return gcd(b, a)'), GCD_BASE, Number.POSITIVE_INFINITY));
    expect(q.toArray().map((j) => [j.candidate.text.trim(), j.key[1]])).toEqual([
      ['return gcd(a, b)', 0.05],
      ['return gcd(b, a % b)', 0],
      ['return gcd(b, a)', 0],
    ]);
  });

  it('addCandidates: the §2.3 `addAll(cands, p = sourcePrior)` form, with a number or a per-candidate p', () => {
    const q = new VerifyQueue();
    const cands = [cand(GCD_SITE, '    return gcd(b, a % b)'), cand(GCD_SITE, '    return gcd(a, b)', { source: 'donor' })];
    const sieve = q.addCandidates(cands, GCD_BASE);
    expect(sieve.queued.map((j) => j.p)).toEqual([SOURCE_ORDER_PRIOR.mutation, SOURCE_ORDER_PRIOR.donor]);
    const q2 = new VerifyQueue();
    const ranked = q2.addCandidates(cands, GCD_BASE, (c) => (c.source === 'donor' ? 0.9 : 0.2));
    expect(q2.pop(2).map((j) => [j.candidate.source, j.p])).toEqual([['donor', 0.9], ['mutation', 0.2]]);
    expect(ranked.dropped).toEqual({ duplicate: 0, unchanged: 0, tried: 0, vocab: 0, apply_failed: 0 });
    const q3 = new VerifyQueue();
    expect(q3.addCandidates(cands, GCD_BASE, 0.5).queued.every((j) => j.p === 0.5)).toBe(true);
  });
});

describe('addAll summary', () => {
  it('reports queued jobs and a count per drop reason', () => {
    const q = new VerifyQueue({ vocab: new Map([['gcd.py', vocabularyOf(GCD_FILE, gcdFailures(), '')]]) });
    const r = q.addAll([
      jobFor(cand(GCD_SITE, '    return gcd(b, a % b)'), GCD_BASE),
      jobFor(cand(GCD_SITE, '    return gcd(b,a%b)'), GCD_BASE),
      jobFor(cand(GCD_SITE, '    return gcd(a % b, b)'), GCD_BASE),
      jobFor(cand(GCD_SITE, '    return gcd(b, remainder)'), GCD_BASE),
    ]);
    expect(r.queued.map((j) => j.candidate.text.trim())).toEqual(['return gcd(b, a % b)']);
    expect(r.dropped).toEqual({ duplicate: 1, unchanged: 1, tried: 0, vocab: 1, apply_failed: 0 });
  });
});
