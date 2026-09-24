/**
 * Which gold hunks do the FAIL_TO_PASS tests actually need? (design §9 R4's `hunk-subsets`, $0.)
 * For the multi-hunk oracle instances, apply a subset of the gold hunks (or a hand-reduced variant)
 * to a private worktree, apply the test patch, run the F2P test(s) with the instance's bench venv and
 * record pass/fail. A subset that passes is a "test-equivalent" target smaller than the gold patch.
 *
 * Usage: node --env-file=.env node_modules/.bin/tsx experiments/reach/hunk-subsets.mts [--only a,b]
 * Output: experiments/reach/out/hunk-subsets.json
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyHunksToLines, parseHunks, privateWorktree, sh, splitLines, venvPython } from './lib.mts';
import type { Hunk } from './lib.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT_DIR = join(HERE, 'out');

interface Record_ {
  instance_id: string;
  repo: string;
  base_commit: string;
  fail_to_pass: string[];
  test_patch: string;
  spec: { test_cmd: string };
}

interface Variant {
  name: string;
  /** hunk indices of the parsed gold diff to apply, or a function producing the patched files */
  hunks?: number[];
  custom?: (base: Map<string, string[]>, hunks: Hunk[]) => Map<string, string[]>;
}

/** Per instance: the variants to test. Indices refer to parseHunks(gold) order. */
const VARIANTS: Record<string, Variant[]> = {
  'psf__requests-2931': [
    { name: 'gold (both hunks)', hunks: [0, 1] },
    { name: 'hunk 0 only: `return data` (mutation unwrap_call reaches it)', hunks: [0] },
    { name: 'hunk 1 only: params guard', hunks: [1] },
  ],
  'sympy__sympy-15345': [
    { name: 'gold (dict entries + alias)', hunks: [0, 1] },
    { name: 'alias `_print_MinMaxBase = _print_Function` only', hunks: [1] },
    { name: 'dict entries only', hunks: [0] },
    {
      name: 'Max entry + alias (no Min line)',
      custom: (base, hunks) => {
        const h0 = hunks[0]!;
        const onlyMax: Hunk = { ...h0, added: h0.added.filter((l) => !l.includes('"Min"')), addedCode: h0.addedCode.filter((l) => !l.includes('"Min"')) };
        const out = new Map(base);
        out.set(h0.file, applyHunksToLines(base.get(h0.file)!, [onlyMax, hunks[1]!]));
        return out;
      },
    },
  ],
  'django__django-15128': [
    { name: 'gold (all hunks)', hunks: 'all' as unknown as number[] },
    {
      name: 'functional minimum: combine() call with exclude + `exclude=None` param + `if exclude is None: exclude = {}` + comprehension filter (no renames, no docstrings, no deletion)',
      custom: (base, hunks) => {
        const file = hunks[0]!.file;
        const lines = [...base.get(file)!];
        const out = new Map(base);
        // bottom-up edits by content, so old numbering is not needed
        const idx = (pred: (l: string) => boolean, from = 0): number => {
          const k = lines.findIndex((l, i) => i >= from && pred(l));
          if (k < 0) throw new Error(`line not found: ${pred.toString()}`);
          return k;
        };
        // comprehension filter inside bump_prefix's change_aliases call
        const enumLine = idx((l) => l.includes('for pos, alias in enumerate(self.alias_map)'));
        lines.splice(enumLine + 1, 0, `${' '.repeat(12)}if alias not in exclude`);
        // guard before the change_aliases call
        const callLine = idx((l) => l.trim() === 'self.change_aliases({', enumLine - 5);
        lines.splice(callLine, 0, `${' '.repeat(8)}if exclude is None:`, `${' '.repeat(12)}exclude = {}`);
        // signature
        const sig = idx((l) => l.includes('def bump_prefix(self, outer_query):'));
        lines[sig] = lines[sig]!.replace('def bump_prefix(self, outer_query):', 'def bump_prefix(self, outer_query, exclude=None):');
        // the combine() insertion
        const combine = idx((l) => l.trim() === "raise TypeError('Cannot combine queries with different distinct fields.')");
        lines.splice(combine + 2, 0, `${' '.repeat(8)}initial_alias = self.get_initial_alias()`, `${' '.repeat(8)}rhs.bump_prefix(self, exclude={initial_alias})`);
        out.set(file, lines);
        return out;
      },
    },
    {
      name: 'combine() insertion only (call passes exclude= to the old signature)',
      hunks: [0],
    },
  ],
  'django__django-15563': [
    { name: 'gold (compiler.py 4 hunks + subqueries.py)', hunks: 'all' as unknown as number[] },
    { name: 'compiler.py hunks only (subqueries.py unchanged)', custom: (base, hunks) => applyFileSubset(base, hunks.filter((h) => h.file.endsWith('compiler.py'))) },
  ],
  'sympy__sympy-19954': [
    { name: 'gold (3 hunks)', hunks: 'all' as unknown as number[] },
    { name: 'first hunk only (`blocks_remove_mask = ...`)', hunks: [0] },
    {
      name: 'one-line alternative: iterate `reversed(list(enumerate(rep_blocks)))` so the in-loop `del` cannot shift later indices',
      custom: (base, hunks) => oneLine(base, hunks[0]!.file, 'for i, r in enumerate(rep_blocks):', 'for i, r in reversed(list(enumerate(rep_blocks))):'),
    },
  ],
  'sympy__sympy-11618': [
    { name: 'gold (14-line dimension-padding branch)', hunks: 'all' as unknown as number[] },
    {
      name: 'one-line alternative + import: `zip(...)` → `zip_longest(..., fillvalue=0)` in distance()',
      custom: (base, hunks) => {
        const file = hunks[0]!.file;
        const lines = [...base.get(file)!];
        const k = lines.findIndex((l, i) => i >= hunks[0]!.oldLine - 3 && l.includes('return sqrt(sum([(a - b)**2 for a, b in zip('));
        if (k < 0) throw new Error('distance return not found');
        lines[k] = lines[k]!.replace('zip(', 'zip_longest(');
        lines[k + 1] = lines[k + 1]!.replace('else p)]))', 'else p, fillvalue=0)]))');
        const imp = lines.findIndex((l) => l.startsWith('from sympy.core import'));
        lines.splice(imp < 0 ? 0 : imp, 0, 'from itertools import zip_longest');
        const out = new Map(base);
        out.set(file, lines);
        return out;
      },
    },
  ],
  'sympy__sympy-12096': [
    { name: 'gold (`*[i.evalf(prec) for i in self.args]`)', hunks: 'all' as unknown as number[] },
    {
      name: 'one-line alternative: `.evalf(prec)` appended to the `_imp_` result (`Float(self._imp_(*self.args).evalf(prec), prec)`)',
      custom: (base, hunks) => oneLine(base, hunks[0]!.file, 'return Float(self._imp_(*self.args), prec)', 'return Float(self._imp_(*self.args).evalf(prec), prec)'),
    },
  ],
};

/** `file` with the single line containing `from` replaced by `to` (same indentation). */
function oneLine(base: Map<string, string[]>, file: string, from: string, to: string): Map<string, string[]> {
  const lines = [...base.get(file)!];
  const k = lines.findIndex((l) => l.includes(from));
  if (k < 0) throw new Error(`line not found: ${from}`);
  lines[k] = lines[k]!.replace(from, to);
  const out = new Map(base);
  out.set(file, lines);
  return out;
}

function applyFileSubset(base: Map<string, string[]>, hunks: Hunk[]): Map<string, string[]> {
  const out = new Map(base);
  const byFile = new Map<string, Hunk[]>();
  for (const h of hunks) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h]);
  for (const [file, hs] of byFile) out.set(file, applyHunksToLines(base.get(file)!, hs));
  return out;
}

/** Test command for the instance's F2P tests, run with the venv python from the worktree root. */
function testCommand(rec: Record_, python: string): { cmd: string; args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = { ...process.env as Record<string, string>, PYTHONDONTWRITEBYTECODE: '1' };
  if (rec.repo === 'sympy/sympy') {
    // bin/test puts the checkout first on sys.path itself; one test file per instance here
    const files = [...new Set((rec.test_patch.match(/^\+\+\+ b\/(\S+)/gm) ?? []).map((m) => m.slice('+++ b/'.length)))];
    // `-k` restricts to the F2P test: sympy/utilities/tests/test_lambdify.py has an unrelated RecursionError under this venv at gold too
    const kw = rec.fail_to_pass.map((t) => t.split(' ')[0] ?? t);
    return { cmd: python, args: ['bin/test', '-C', ...files, ...kw.flatMap((k) => ['-k', k])], env: { ...env, PYTHONWARNINGS: 'ignore::UserWarning,ignore::SyntaxWarning' } };
  }
  if (rec.repo === 'django/django') {
    const labels = rec.fail_to_pass.map((t) => {
      const m = /^(\S+) \(([^)]+)\)$/.exec(t);
      return m === null ? t : `${m[2]}.${m[1]}`;
    });
    return { cmd: python, args: ['tests/runtests.py', '--settings=test_sqlite', '--parallel', '1', ...labels], env };
  }
  return { cmd: python, args: ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', ...rec.fail_to_pass], env };
}

interface Result {
  instance: string;
  variant: string;
  pass: boolean;
  ms: number;
  tail: string;
}

const argv = process.argv.slice(2);
const onlyArg = argv.find((a) => a.startsWith('--only='));
const only = onlyArg === undefined ? null : onlyArg.slice('--only='.length).split(',');
const records = (JSON.parse(readFileSync(join(ROOT, 'bench/data/swebench-verified-30.json'), 'utf8')) as Record_[]).filter((r) => r.instance_id in VARIANTS && (only === null || only.includes(r.instance_id)));
const gold = JSON.parse(readFileSync(join(ROOT, 'bench/data/swebench-verified-30.gold.json'), 'utf8')) as Record<string, string>;
mkdirSync(OUT_DIR, { recursive: true });
const results: Result[] = [];

for (const rec of records) {
  const python = venvPython(rec.instance_id);
  if (python === null) {
    console.log(`${rec.instance_id}: no venv`);
    continue;
  }
  const ws = privateWorktree(rec.instance_id, rec.repo, rec.base_commit);
  const hunks = parseHunks(gold[rec.instance_id] ?? '');
  const files = [...new Set(hunks.map((h) => h.file))];
  const base = new Map<string, string[]>();
  for (const f of files) base.set(f, splitLines(readFileSync(join(ws, f), 'utf8')));
  // the test patch touches test files only (disjoint from the gold files on these instances)
  const tp = join('/tmp/jevonly/reach', `${rec.instance_id}.test.patch`);
  writeFileSync(tp, rec.test_patch);
  sh('git', ['apply', tp], ws);
  // which package does the venv import from this worktree? (PYTHONPATH puts the worktree first)
  const pkg = rec.repo === 'psf/requests' ? 'requests' : rec.repo === 'django/django' ? 'django' : 'sympy';
  const where = sh(python, ['-c', `import ${pkg}; print(${pkg}.__file__)`], ws, 60_000).trim();
  const env = { PYTHONPATH: ws };
  const whereEnv = sh('/bin/sh', ['-c', `PYTHONPATH='${ws}' '${python}' -c 'import ${pkg}; print(${pkg}.__file__)'`], ws, 60_000).trim();
  console.log(`${rec.instance_id}: ${pkg} resolves to ${where} (plain) / ${whereEnv} (PYTHONPATH=worktree)`);
  if (!realpathSync(whereEnv).startsWith(realpathSync(ws))) throw new Error(`${rec.instance_id}: PYTHONPATH does not put the worktree first`);
  for (const v of VARIANTS[rec.instance_id] ?? []) {
    const patched = v.custom !== undefined ? v.custom(base, hunks) : applyFileSubset(base, (v.hunks as unknown) === 'all' ? hunks : (v.hunks ?? []).map((i) => hunks[i]!));
    for (const [f, lines] of patched) writeFileSync(join(ws, f), `${lines.join('\n')}\n`);
    const { cmd, args, env: tenv } = testCommand(rec, python);
    const t0 = Date.now();
    let pass = false;
    let tail = '';
    try {
      const out = sh('/bin/sh', ['-c', `cd '${ws}' && ${Object.entries({ ...tenv, ...env }).filter(([k]) => k === 'PYTHONPATH' || k === 'PYTHONWARNINGS' || k === 'PYTHONDONTWRITEBYTECODE').map(([k, val]) => `${k}='${val}'`).join(' ')} '${cmd}' ${args.map((a) => `'${a}'`).join(' ')} 2>&1`], ws, 600_000);
      tail = out.slice(-600);
      // sympy: "tests finished: N passed[, M failed][, K exceptions], in T seconds"; django: a final "OK" / "FAILED (...)"; pytest: "N passed" / "N failed"
      if (rec.repo === 'sympy/sympy') pass = /tests finished: \d+ passed/.test(out) && !/\d+ (failed|exceptions?|expected to fail but passed)/.test(out);
      else if (rec.repo === 'django/django') pass = /^OK\b/m.test(out) && !/^FAILED/m.test(out);
      else pass = /\b\d+ passed\b/.test(out) && !/\b\d+ (failed|error)/.test(out);
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      tail = `${err.stdout ?? ''}${err.stderr ?? ''}`.slice(-600) || (err.message ?? '').slice(-600);
      pass = false;
    }
    const ms = Date.now() - t0;
    results.push({ instance: rec.instance_id, variant: v.name, pass, ms, tail });
    console.log(`  ${pass ? 'PASS' : 'FAIL'} ${ms} ms  ${v.name}`);
    // restore the gold files to base (test patch stays)
    for (const f of files) writeFileSync(join(ws, f), `${base.get(f)!.join('\n')}\n`);
  }
  sh('git', ['checkout', '--', '.'], ws);
}
writeFileSync(join(OUT_DIR, 'hunk-subsets.json'), JSON.stringify({ ran_at: new Date().toISOString(), spend_usd: 0, results }, null, 1));
console.log(`\nwritten ${join(OUT_DIR, 'hunk-subsets.json')}`);
