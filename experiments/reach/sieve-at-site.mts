/**
 * The sieve at the gold site, for the two cheapest issue oracles (django-15315: 0.4 s, sympy-12096:
 * 0.25 s): every candidate the SEEDS sources enumerate at the gold site(s) (ENUMERATE_CAP 254 per
 * source, engine corpus) is applied to a private worktree lane and the issue-oracle script is run
 * with the oracle's own runner (src/synth/oracle/runner.ts runRepro + evaluateCriterion). Counts
 * passers, failures, syntax errors and timeouts: what the design's SIEVE mode (§2.4) would face and
 * find at the gold site. $0.00 Jev.
 *
 * Usage: node --env-file=.env node_modules/.bin/tsx experiments/reach/sieve-at-site.mts [--only a,b] [--lanes 4]
 * Output: experiments/reach/out/sieve-at-site.json
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDonorSource } from '../../src/synth/donor/index.ts';
import { createMutationSource } from '../../src/synth/mutate/index.ts';
import { chunksWithContext, evaluateCriterion, extractBlocks, runRepro } from '../../src/synth/oracle/index.ts';
import type { Criterion, ReproRunOptions } from '../../src/synth/oracle/index.ts';
import { createCompositeSource } from '../../src/synth/search/composite.ts';
import { ENUMERATE_CAP, isTestPath, taskIdentifiers, testLiterals } from '../../src/synth/search/subgoal.ts';
import { canonicalText } from '../../src/synth/sieve/queue.ts';
import { createTemplateSource } from '../../src/synth/templates/index.ts';
import type { Candidate, EnumerateOptions, FailureView, SourceFile } from '../../src/synth/types.ts';
import { applyCandidate } from '../../src/synth/verify/apply.ts';
import type { VerifyRunFn } from '../../src/synth/verify/types.ts';
import { loadFile, parseHunks, privateWorktree, replaceSiteAt, sh, venvPython } from './lib.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT_DIR = join(HERE, 'out');
const MAX_WORKSPACE_PY_FILES = 400;

interface Record_ {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
}

/** Oracle set-up per instance: the labelled reproduction block and the code-built criterion (experiments/oracle/results.json). */
const ORACLES: Record<string, { block: number; criterion: Criterion; packageName: string; framework: 'django' | null; sites: (hunks: ReturnType<typeof parseHunks>) => { file: string; line: number }[] }> = {
  'django__django-15315': {
    block: 0,
    criterion: { form: 'no_exception' },
    packageName: 'django',
    framework: 'django',
    // the 5 physical lines of the `return hash((...))` statement: the engine's replace sites are physical lines
    sites: (hunks) => Array.from({ length: hunks[0]!.removed.length }, (_, k) => ({ file: hunks[0]!.file, line: hunks[0]!.oldLine + k })),
  },
  'sympy__sympy-12096': {
    block: 0,
    criterion: { form: 'differs_from_actual', actual: 'f(g(2))' },
    packageName: 'sympy',
    framework: null,
    sites: (hunks) => [{ file: hunks[0]!.file, line: hunks[0]!.oldLine }],
  },
};

const run: VerifyRunFn = (command, opts) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    execFile('/bin/sh', ['-c', command], { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: opts.maxOutputBytes * 8, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
      resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: e === null ? 0 : typeof e.code === 'number' ? e.code : null, timedOut: e?.killed === true, durationMs: Date.now() - t0 });
    });
  });

interface Outcome {
  source: string;
  op: string;
  site: string;
  text: string;
  status: 'pass' | 'fail' | 'syntax_error' | 'timeout' | 'error';
  detail: string;
  ms: number;
}

const argv = process.argv.slice(2);
const onlyArg = argv.find((a) => a.startsWith('--only='));
const only = onlyArg === undefined ? null : onlyArg.slice('--only='.length).split(',');
const lanesArg = argv.find((a) => a.startsWith('--lanes='));
const LANES = lanesArg === undefined ? 4 : Number(lanesArg.slice('--lanes='.length));

const records = (JSON.parse(readFileSync(join(ROOT, 'bench/data/swebench-verified-30.json'), 'utf8')) as Record_[]).filter((r) => r.instance_id in ORACLES && (only === null || only.includes(r.instance_id)));
const gold = JSON.parse(readFileSync(join(ROOT, 'bench/data/swebench-verified-30.gold.json'), 'utf8')) as Record<string, string>;
const oracleRows = (JSON.parse(readFileSync(join(ROOT, 'experiments/oracle/results.json'), 'utf8')) as { rows: { instance_id: string; goal?: { test_id: string; call: string; expected: string; actual: string } }[] }).rows;
mkdirSync(OUT_DIR, { recursive: true });

const summary: Record<string, unknown>[] = [];
for (const rec of records) {
  const cfg = ORACLES[rec.instance_id]!;
  const python = venvPython(rec.instance_id);
  if (python === null) throw new Error(`${rec.instance_id}: no venv`);
  const lanes = Array.from({ length: LANES }, (_, k) => privateWorktree(rec.instance_id, rec.repo, rec.base_commit, `-lane${k}`));
  const ex = extractBlocks(rec.problem_statement.split('\r\n').join('\n'));
  const block = ex.blocks.find((b) => b.index === cfg.block);
  if (block === undefined) throw new Error(`${rec.instance_id}: block ${cfg.block} not extracted`);
  const chunks = chunksWithContext(block, ex).chunks;
  const optsFor = (ws: string): ReproRunOptions => ({ workspace: ws, packageName: cfg.packageName, framework: cfg.framework, python, timeoutMs: 30_000 });

  // sanity: base fails, gold passes
  const base = await runRepro(run, chunks, optsFor(lanes[0]!));
  const baseVerdict = evaluateCriterion(cfg.criterion, base);
  const gp = join('/tmp/jevonly/reach', `${rec.instance_id}.gold.patch`);
  writeFileSync(gp, gold[rec.instance_id] ?? '');
  sh('git', ['apply', gp], lanes[0]!);
  const goldRun = await runRepro(run, chunks, optsFor(lanes[0]!));
  const goldVerdict = evaluateCriterion(cfg.criterion, goldRun);
  sh('git', ['checkout', '--', '.'], lanes[0]!);
  console.log(`${rec.instance_id}: base ${baseVerdict.pass ? 'PASS (bad oracle)' : 'fails'} (${base.durationMs} ms: ${baseVerdict.actual.slice(0, 80)}); gold ${goldVerdict.pass ? 'passes' : 'FAILS'} (${goldRun.durationMs} ms)`);
  if (baseVerdict.pass || !goldVerdict.pass) throw new Error('oracle sanity check failed');

  // candidates at the gold site(s): SEEDS sources at the engine cap, engine corpus
  const ws0 = lanes[0]!;
  const allPaths = sh('git', ['ls-files', '*.py'], ws0).split('\n').filter((p) => p.endsWith('.py') && !isTestPath(p)).sort();
  const corpus = new Map<string, SourceFile>();
  for (const p of allPaths.slice(0, MAX_WORKSPACE_PY_FILES)) {
    try {
      corpus.set(p, loadFile(ws0, p));
    } catch {
      // unparsable
    }
  }
  const row = oracleRows.find((o) => o.instance_id === rec.instance_id);
  const failures: FailureView[] = row?.goal === undefined ? [] : [{ testId: row.goal.test_id, call: row.goal.call, expected: row.goal.expected, actual: row.goal.actual }];
  const opts: EnumerateOptions = { cap: ENUMERATE_CAP, testLiterals: testLiterals(failures), taskIdentifiers: taskIdentifiers(rec.problem_statement), corpus };
  const hunks = parseHunks(gold[rec.instance_id] ?? '');
  const mutation = createMutationSource();
  const template = createTemplateSource();
  const donor = createDonorSource();
  // donor-body units off: see reach-oracle-9.mts (one call did not return in 6 min at a sympy def site)
  const composite = createCompositeSource({ singles: [mutation, template, donor], donorUnits: false, signatureUnits: false });
  const jobs: { c: Candidate; source: string; site: string }[] = [];
  const seen = new Set<string>();
  for (const s of cfg.sites(hunks)) {
    const file = corpus.get(s.file) ?? loadFile(ws0, s.file);
    const site = replaceSiteAt(file, s.line);
    for (const [name, src] of [['mutation', mutation], ['template', template], ['donor', donor], ['composite', composite]] as const) {
      const t0 = Date.now();
      const cands = src.enumerate(site, opts);
      console.log(`  ${s.file}:${s.line} ${name}: ${cands.length} candidates (${Date.now() - t0} ms)`);
      for (const c of cands) {
        const key = `${s.line}\u0000${canonicalText(c)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        jobs.push({ c, source: name, site: `${s.file}:${s.line}` });
      }
    }
  }
  console.log(`  ${jobs.length} distinct candidates to run on ${LANES} lanes`);

  const outcomes: Outcome[] = [];
  let next = 0;
  const worker = async (lane: string): Promise<void> => {
    for (;;) {
      const k = next++;
      const job = jobs[k];
      if (job === undefined) return;
      const t0 = Date.now();
      let applied;
      try {
        applied = applyCandidate(job.c);
      } catch (e) {
        outcomes.push({ source: job.source, op: job.c.op, site: job.site, text: canonicalText(job.c).slice(0, 160), status: 'error', detail: String(e).slice(0, 120), ms: 0 });
        continue;
      }
      const originals = new Map<string, string>();
      for (const f of applied.files) {
        originals.set(f.path, readFileSync(join(lane, f.path), 'utf8'));
        writeFileSync(join(lane, f.path), f.after);
      }
      let status: Outcome['status'] = 'fail';
      let detail = '';
      try {
        const r = await runRepro(run, chunks, optsFor(lane));
        const v = evaluateCriterion(cfg.criterion, r);
        const exc = r.statements.find((st) => st.exception !== null)?.exception ?? null;
        if (r.status === 'timeout') status = 'timeout';
        else if (exc !== null && (exc.type === 'SyntaxError' || exc.type === 'IndentationError')) status = 'syntax_error';
        else if (r.statements.some((st) => st.kind === 'syntax_error')) status = 'syntax_error';
        else if (r.status !== 'ran') status = 'error';
        else status = v.pass ? 'pass' : 'fail';
        detail = (exc === null ? v.actual : `${exc.type}: ${exc.message}`).slice(0, 120);
      } catch (e) {
        status = 'error';
        detail = String(e).slice(0, 120);
      } finally {
        for (const [p, src] of originals) writeFileSync(join(lane, p), src);
      }
      outcomes.push({ source: job.source, op: job.c.op, site: job.site, text: canonicalText(job.c).slice(0, 160), status, detail, ms: Date.now() - t0 });
      if (outcomes.length % 100 === 0) console.log(`  ${outcomes.length}/${jobs.length} run; passers so far ${outcomes.filter((o) => o.status === 'pass').length}`);
    }
  };
  const t0 = Date.now();
  await Promise.all(lanes.map((l) => worker(l)));
  const wall = Date.now() - t0;
  const count = (st: Outcome['status']): number => outcomes.filter((o) => o.status === st).length;
  const passers = outcomes.filter((o) => o.status === 'pass');
  const ms = outcomes.map((o) => o.ms).sort((a, b) => a - b);
  const median = ms[Math.floor(ms.length / 2)] ?? 0;
  console.log(`  done: ${outcomes.length} run in ${(wall / 1000).toFixed(0)} s (median ${median} ms per run at ${LANES} lanes); pass ${passers.length}, fail ${count('fail')}, syntax_error ${count('syntax_error')}, timeout ${count('timeout')}, error ${count('error')}`);
  for (const p of passers) console.log(`    PASS [${p.source}/${p.op}] ${p.site}: ${p.text}`);
  summary.push({ instance: rec.instance_id, criterion: cfg.criterion, base_ms: base.durationMs, gold_ms: goldRun.durationMs, candidates: jobs.length, by_source: Object.fromEntries(['mutation', 'template', 'donor', 'composite'].map((s) => [s, jobs.filter((j) => j.source === s).length])), lanes: LANES, wall_ms: wall, median_run_ms: median, pass: passers.length, fail: count('fail'), syntax_error: count('syntax_error'), timeout: count('timeout'), error: count('error'), passers, outcomes });
  writeFileSync(join(OUT_DIR, `sieve-at-site.${rec.instance_id}.json`), JSON.stringify(summary.at(-1), null, 1));
}
writeFileSync(join(OUT_DIR, 'sieve-at-site.json'), JSON.stringify({ ran_at: new Date().toISOString(), spend_usd: 0, instances: summary.map((s) => ({ ...s, outcomes: undefined })) }, null, 1));
console.log(`\nwritten ${join(OUT_DIR, 'sieve-at-site.json')}`);
