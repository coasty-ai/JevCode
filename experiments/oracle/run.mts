/**
 * Experiment: an oracle from the issue text on the 30 SWE-bench Verified instances (Jev-only).
 *
 *   env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/oracle/run.mts [--only id,id] [--limit n] [--extract-only] [--labels] [--skip-gold]
 *
 * Per instance: (a) code extracts candidate blocks (src/jev-modes/synth/oracle/extract.ts); (b) ONE Jev
 * request judges is_reproduction / shows_expected / shows_actual per block, the failure kind and
 * the traceback frames (questions.ts), compared with experiments/oracle/labels.json; (c) the chosen
 * block runs at base_commit in /tmp/jevonly/repos/<instance_id> (worktrees of the bare clones under
 * /tmp/jevonly/cache, all verified clean at base_commit) with the instance's bench venv python
 * (~/.jevcode/runs/bench-work/<run>/<instance>/<condition>/workspace/.venv, built by the local
 * evaluator's spec install; the newest that imports the package) and the code-built criterion is
 * evaluated; (d) for oracles that fail on base, the gold patch is applied with `git apply`, the
 * script re-run, and the patch reverted with `git apply -R`; (e) cost and time are recorded.
 * `--labels` uses the hand labels instead of Jev (no request) to separate the runner's reach from
 * Jev's picks. Output: experiments/oracle/results.json and experiments/oracle/table.md.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';
import type { Answer, Json } from '../../src/core/types.ts';
import { createJevDecider } from '../../src/jev/client.ts';
import { buildCriterion, chooseBlocks, chunksWithContext, evaluateCriterion, extractBlocks, isRunnable, oracleQuestions, readOracleAnswers, reproductionGoal, verifyRepro } from '../../src/jev-modes/synth/oracle/index.ts';
import type { BlockChoice, BuiltCriterion, CodeBlock, Extraction, FailureKind, OracleJudgement, ReproRunResult, Verdict } from '../../src/jev-modes/synth/oracle/index.ts';
import type { VerifyRunFn } from '../../src/jev-modes/synth/verify/types.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIR = join(ROOT, 'experiments/oracle');
const REPOS = '/tmp/jevonly/repos';
const SPEND_CAP = 1.5;
const MODEL = 'typesafe/jev-1.13-20260917';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const value = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const only = value('--only')?.split(',') ?? null;
const limit = Number(value('--limit') ?? '30');
const extractOnly = flag('--extract-only');
const useLabels = flag('--labels');
const skipGold = flag('--skip-gold');

interface Record_ {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  fail_to_pass: string[];
  spec: { test_cmd: string };
}
interface Label {
  repro: number[];
  expected: number[];
  actual: number[];
  kind: FailureKind;
  also_ok: FailureKind[];
  note: string;
}

const records = (JSON.parse(readFileSync(join(ROOT, 'bench/data/swebench-verified-30.json'), 'utf8')) as Record_[]).filter((r) => only === null || only.includes(r.instance_id)).slice(0, limit);
const gold = JSON.parse(readFileSync(join(ROOT, 'bench/data/swebench-verified-30.gold.json'), 'utf8')) as Record<string, string>;
const labels = JSON.parse(readFileSync(join(DIR, 'labels.json'), 'utf8')) as Record<string, Label>;

const PACKAGE: Record<string, string> = { 'sympy/sympy': 'sympy', 'django/django': 'django', 'pytest-dev/pytest': '_pytest', 'pylint-dev/pylint': 'pylint', 'psf/requests': 'requests' };
const IMPORT_CHECK: Record<string, string> = { 'sympy/sympy': 'sympy', 'django/django': 'django', 'pytest-dev/pytest': 'pytest', 'pylint-dev/pylint': 'pylint', 'psf/requests': 'requests' };

// ---------------------------------------------------------------------------------------- process runner (child_process here; the engine's sandbox in production)
const run: VerifyRunFn = (command, opts) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    execFile('/bin/sh', ['-c', command], { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: opts.maxOutputBytes * 8, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number | string; killed?: boolean; signal?: string }) | null;
      resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: e === null ? 0 : typeof e.code === 'number' ? e.code : null, timedOut: e?.killed === true, durationMs: Date.now() - t0 });
    });
  });

async function sh(cmd: string, cwd: string, timeoutMs = 120_000): Promise<{ ok: boolean; out: string }> {
  const r = await run(cmd, { cwd, timeoutMs, maxOutputBytes: 1 << 20 });
  return { ok: r.exitCode === 0, out: `${r.stdout}\n${r.stderr ?? ''}`.trim() };
}

/** The newest bench-work venv for the instance whose python imports the package. */
async function venvPython(r: Record_): Promise<string | null> {
  const pattern = join(homedir(), '.jevcode/runs/bench-work/*', r.instance_id, '*/workspace/.venv/bin/python');
  const cands = globSync(pattern).sort().reverse();
  for (const py of cands) {
    const res = await sh(`'${py}' -c 'import ${IMPORT_CHECK[r.repo] ?? ''}'`, '/tmp', 60_000);
    if (res.ok) return py;
  }
  return null;
}

/** pytest's `_pytest/_version.py` is generated by setuptools_scm at install time; a plain checkout lacks it. */
async function ensurePytestVersion(r: Record_, py: string, workspace: string): Promise<string | null> {
  if (r.repo !== 'pytest-dev/pytest') return null;
  const p = join(workspace, 'src/_pytest/_version.py');
  if (existsSync(p)) return null;
  const v = await sh(`'${py}' -c 'import pytest; print(pytest.__version__)'`, '/tmp', 60_000);
  const version = v.ok ? v.out.trim().split('\n').at(-1) ?? '0.0' : '0.0';
  writeFileSync(p, `# generated by experiments/oracle/run.mts (setuptools_scm writes this at install time)\nversion = ${JSON.stringify(version)}\nversion_tuple = (0, 0)\n`);
  return `wrote src/_pytest/_version.py (${version})`;
}

// ---------------------------------------------------------------------------------------- Jev
const key = process.env['OPENROUTER_API_KEY'] ?? '';
const jev = key === '' || useLabels || extractOnly ? null : createJevDecider({ baseUrl: 'https://openrouter.ai/api/alpha/decisions', apiKey: key, model: MODEL, pinned: true }, { redact: (s) => s });
if (jev === null && !useLabels && !extractOnly) throw new Error('OPENROUTER_API_KEY missing (or pass --labels)');
const signal = new AbortController().signal;
let spent = 0;
const latencies: number[] = [];

/** Answers built from the hand labels (--labels): a stand-in decider, so the runner's reach is measured without Jev. */
function labelAnswers(ex: Extraction, label: Label, set: ReturnType<typeof oracleQuestions>): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  for (const b of ex.blocks) {
    out[`is_reproduction_${b.index}`] = { type: 'noul', noul: label.repro.includes(b.index) ? 0.95 : 0.05 };
    out[`shows_expected_${b.index}`] = { type: 'noul', noul: label.expected.includes(b.index) ? 0.95 : 0.05 };
    out[`shows_actual_${b.index}`] = { type: 'noul', noul: label.actual.includes(b.index) ? 0.95 : 0.05 };
  }
  const probs: Record<string, number> = {};
  for (const k of Object.keys(set.questions['failure_kind']?.type === 'choice' ? (set.questions['failure_kind'] as { criteria: Record<string, Json> }).criteria : {})) probs[k] = k === label.kind ? 0.9 : 0.1 / 5;
  out['failure_kind'] = { type: 'choice', choice: label.kind, probabilities: probs, confidence: 0.9 };
  set.frames.forEach((_, k) => {
    out[`frame_in_fix_${k}`] = { type: 'noul', noul: 0.5 };
  });
  return out;
}

// ---------------------------------------------------------------------------------------- per instance
type Outcome = 'no_blocks' | 'no_pick' | 'not_runnable' | 'no_criterion' | 'env_error' | 'passes_on_base' | 'fails_on_gold' | 'valid' | 'valid_weak';

interface Row {
  instance_id: string;
  repo: string;
  n_blocks: number;
  block_kinds: string[];
  n_tracebacks: number;
  n_frames_offered: number;
  n_expectations: number;
  jev: {
    requests: number;
    input_tokens: number;
    cost_usd: number;
    latency_ms: number;
    is_reproduction: Record<string, number>;
    shows_expected: Record<string, number>;
    shows_actual: Record<string, number>;
    failure_kind: string;
    p_failure_kind: number;
    frame_in_fix: { file: string; fn: string | null; p: number }[];
  } | null;
  labels: { repro: number[]; expected: number[]; kind: string; also_ok: string[] } | null;
  agreement: { repro_pick_in_labels: boolean | null; repro_set_exact: boolean | null; expected_pick_in_labels: boolean | null; kind_strict: boolean | null; kind_lenient: boolean | null } | null;
  picked: { reproduction: number | null; expected: number | null; actual: number | null; context_blocks: number[]; anchors: number } | null;
  criterion: { form: string; strength: string; expected_text: string; derivation: string } | null;
  base: { status: string; ms: number; statements: number; environment_statements: number; fixups: string[]; verdict: { pass: boolean; actual: string; reason: string } | null } | null;
  gold: { status: string; ms: number; verdict: { pass: boolean; actual: string; reason: string } | null } | null;
  outcome: Outcome;
  goal: { test_id: string; call: string; expected: string; actual: string } | null;
  notes: string[];
  wall_ms: number;
}

const rows: Row[] = [];

function shortVerdict(v: Verdict): { pass: boolean; actual: string; reason: string } {
  return { pass: v.pass, actual: v.actual.slice(0, 200), reason: v.reason.slice(0, 200) };
}

async function one(r: Record_): Promise<void> {
  const t0 = Date.now();
  const ps = r.problem_statement.split('\r\n').join('\n');
  const ex = extractBlocks(ps);
  const label = labels[r.instance_id] ?? null;
  const row: Row = {
    instance_id: r.instance_id,
    repo: r.repo,
    n_blocks: ex.blocks.length,
    block_kinds: ex.blocks.map((b) => `${b.kind}/${b.origin}`),
    n_tracebacks: ex.tracebacks.length,
    n_frames_offered: 0,
    n_expectations: ex.expectations.length,
    jev: null,
    labels: label === null ? null : { repro: label.repro, expected: label.expected, kind: label.kind, also_ok: label.also_ok },
    agreement: null,
    picked: null,
    criterion: null,
    base: null,
    gold: null,
    outcome: 'no_blocks',
    goal: null,
    notes: [],
    wall_ms: 0,
  };
  rows.push(row);
  const finish = (outcome: Outcome): void => {
    row.outcome = outcome;
    row.wall_ms = Date.now() - t0;
    const j = row.jev;
    console.log(`${r.instance_id.padEnd(26)} blocks=${row.n_blocks} ${outcome.padEnd(15)} pick=${row.picked?.reproduction ?? '-'} kind=${j?.failure_kind ?? '-'} crit=${row.criterion?.form ?? '-'} base=${row.base?.verdict?.pass === undefined ? '-' : row.base.verdict.pass ? 'pass' : 'FAIL'} gold=${row.gold?.verdict?.pass === undefined ? '-' : row.gold.verdict.pass ? 'PASS' : 'fail'} $${(j?.cost_usd ?? 0).toFixed(4)} ${row.wall_ms}ms`);
  };
  if (extractOnly) {
    for (const b of ex.blocks) console.log(`  [${r.instance_id}] block ${b.index} ${b.kind}/${b.origin} L${b.startLine}-${b.endLine}${b.repl ? ` repl ${b.repl.statements.length} stmts` : ''}: ${b.text.split('\n')[0]?.slice(0, 90) ?? ''}`);
    for (const e of ex.expectations) console.log(`  [${r.instance_id}] ${e.pattern} ${JSON.stringify(e.values)} :: ${e.text.slice(0, 120)}`);
    finish('no_blocks');
    return;
  }
  if (ex.blocks.length === 0) {
    finish('no_blocks');
    return;
  }
  // (b) Jev
  const set = oracleQuestions({ repository: r.repo, problemStatement: ps, extraction: ex });
  row.n_frames_offered = set.frames.length;
  let judgement: OracleJudgement;
  if (jev !== null) {
    if (spent > SPEND_CAP) throw new Error(`spend cap ${SPEND_CAP} reached`);
    const res = await jev.ask(set.state, set.questions, { signal, stage: 'context', step: 1 });
    spent += res.usage.costUsd;
    latencies.push(res.latencyMs);
    judgement = readOracleAnswers(set, res.answers);
    row.jev = {
      requests: 1,
      input_tokens: res.usage.inputTokens,
      cost_usd: res.usage.costUsd,
      latency_ms: res.latencyMs,
      is_reproduction: Object.fromEntries(judgement.blocks.map((b) => [String(b.index), b.isReproduction])),
      shows_expected: Object.fromEntries(judgement.blocks.map((b) => [String(b.index), b.showsExpected])),
      shows_actual: Object.fromEntries(judgement.blocks.map((b) => [String(b.index), b.showsActual])),
      failure_kind: judgement.failureKind,
      p_failure_kind: judgement.failureKindProbabilities[judgement.failureKind] ?? 0,
      frame_in_fix: judgement.frames.map((f) => ({ file: f.frame.file, fn: f.frame.fn, p: f.inFix })),
    };
  } else {
    if (label === null) throw new Error(`no label for ${r.instance_id}`);
    judgement = readOracleAnswers(set, labelAnswers(ex, label, set));
    row.jev = { requests: 0, input_tokens: 0, cost_usd: 0, latency_ms: 0, is_reproduction: {}, shows_expected: {}, shows_actual: {}, failure_kind: judgement.failureKind, p_failure_kind: 1, frame_in_fix: [] };
  }
  const choice: BlockChoice = chooseBlocks(ex, judgement);
  row.picked = { reproduction: choice.reproduction?.index ?? null, expected: choice.expected?.index ?? null, actual: choice.actual?.index ?? null, context_blocks: [], anchors: choice.anchors.length };
  if (label !== null) {
    const reproSet = new Set(judgement.blocks.filter((b) => b.isReproduction >= 0.5).map((b) => b.index));
    const expSet = new Set(judgement.blocks.filter((b) => b.showsExpected >= 0.5).map((b) => b.index));
    row.agreement = {
      repro_pick_in_labels: choice.reproduction === null ? label.repro.length === 0 : label.repro.includes(choice.reproduction.index),
      repro_set_exact: [...reproSet].sort().join(',') === [...label.repro].sort().join(','),
      expected_pick_in_labels: choice.expected === null ? label.expected.length === 0 : label.expected.includes(choice.expected.index),
      kind_strict: judgement.failureKind === label.kind,
      kind_lenient: judgement.failureKind === label.kind || label.also_ok.includes(judgement.failureKind),
    };
    void expSet;
  }
  if (choice.reproduction === null) {
    const best = judgement.blocks.slice().sort((a, b) => b.isReproduction - a.isReproduction)[0];
    const bestBlock = best === undefined ? null : ex.blocks.find((b) => b.index === best.index) ?? null;
    if (bestBlock !== null && best !== undefined && best.isReproduction >= 0.5 && !isRunnable(bestBlock)) row.notes.push(`top block ${bestBlock.index} (${bestBlock.kind}) needs a command oracle (pytest/pylint/shell), not a statement runner`);
    finish(bestBlock !== null && best !== undefined && best.isReproduction >= 0.5 && !isRunnable(bestBlock) ? 'not_runnable' : 'no_pick');
    return;
  }
  // (c) criterion + run on base
  const block: CodeBlock = choice.reproduction;
  const cwc = chunksWithContext(block, ex);
  row.picked.context_blocks = cwc.contextBlocks;
  const built: BuiltCriterion | null = buildCriterion({ failureKind: judgement.failureKind, reproduction: block, expected: choice.expected, actual: choice.actual, expectations: ex.expectations, chunkOffset: cwc.offset }, ex.tracebacks);
  if (built === null) {
    finish('no_criterion');
    return;
  }
  row.criterion = { form: built.criterion.form, strength: built.strength, expected_text: built.expectedText.slice(0, 200), derivation: built.derivation.slice(0, 200) };
  const workspace = join(REPOS, r.instance_id);
  // the worktrees under /tmp/jevonly/repos are shared with other experiments (design §9 R4): refuse a dirty one
  const clean = await sh('git status --short', workspace);
  if (!clean.ok || clean.out.split('\n').some((l) => l.trim() !== '' && !l.includes('_version.py'))) {
    row.notes.push(`shared worktree not clean before the base run: ${clean.out.slice(0, 200)}`);
    finish('env_error');
    return;
  }
  const py = await venvPython(r);
  if (py === null) {
    row.notes.push('no working venv found');
    finish('env_error');
    return;
  }
  const vnote = await ensurePytestVersion(r, py, workspace);
  if (vnote !== null) row.notes.push(vnote);
  const pkg = PACKAGE[r.repo] ?? null;
  const options = { packageName: pkg, framework: pkg === 'django' ? ('django' as const) : null, timeoutMs: 30_000 };
  const { runRepro } = await import('../../src/jev-modes/synth/oracle/runner.ts');
  const base: ReproRunResult = await runRepro(run, cwc.chunks, { ...options, workspace, python: py });
  const goal = reproductionGoal({ block, chunks: cwc.chunks, built, result: base, options });
  row.base = {
    status: base.status,
    ms: base.durationMs,
    statements: base.statements.length,
    environment_statements: base.statements.filter((s) => s.environment).length,
    fixups: base.statements.map((s) => s.fixup).filter((f): f is string => f !== null),
    verdict: shortVerdict(goal.verdict),
  };
  row.goal = { test_id: goal.spec.testId, call: goal.failure.call, expected: goal.failure.expected, actual: goal.failure.actual };
  const evidence = base.statements.filter((s) => s.chunk >= 0 && !s.environment && s.kind !== 'syntax_error');
  if (base.status !== 'ran' || evidence.length === 0) {
    if (base.status !== 'ran') row.notes.push(`runner ${base.status}: ${base.outputTail.slice(-300)}`);
    finish('env_error');
    return;
  }
  const lastEvidence = evidence.at(-1);
  if (lastEvidence?.exception !== null && lastEvidence?.exception !== undefined && /^(NameError|ImportError|ModuleNotFoundError|SyntaxError)$/.test(lastEvidence.exception.type) && !goal.verdict.pass) {
    row.notes.push(`snippet incomplete: ${lastEvidence.exception.type}: ${lastEvidence.exception.message.slice(0, 120)}`);
  }
  if (goal.verdict.pass) {
    finish('passes_on_base');
    return;
  }
  if (skipGold) {
    finish(built.strength === 'weak' ? 'valid_weak' : 'valid');
    return;
  }
  // (d) gold
  const patchPath = join('/tmp/jevonly/oracle', `${r.instance_id}.gold.patch`);
  mkdirSync('/tmp/jevonly/oracle', { recursive: true });
  writeFileSync(patchPath, gold[r.instance_id] ?? '');
  const applied = await sh(`git apply '${patchPath}'`, workspace);
  if (!applied.ok) {
    row.notes.push(`gold apply failed: ${applied.out.slice(-200)}`);
    finish('env_error');
    return;
  }
  try {
    const g = await verifyRepro(run, workspace, goal.spec, py);
    row.gold = { status: g.result.status, ms: g.result.durationMs, verdict: shortVerdict(g.verdict) };
    if (g.verdict.pass) finish(built.strength === 'weak' ? 'valid_weak' : 'valid');
    else finish('fails_on_gold');
  } finally {
    const reverted = await sh(`git apply -R '${patchPath}' && git status --short`, workspace);
    if (!reverted.ok || reverted.out.split('\n').some((l) => l.trim() !== '' && !l.includes('_version.py'))) row.notes.push(`revert check: ${reverted.out.slice(-200)}`);
  }
}

// ---------------------------------------------------------------------------------------- main
const started = Date.now();
for (const r of records) {
  try {
    await one(r);
  } catch (e) {
    const row = rows.find((x) => x.instance_id === r.instance_id);
    const msg = e instanceof Error ? e.message : String(e);
    if (row !== undefined) {
      row.notes.push(`error: ${msg.slice(0, 300)}`);
      row.outcome = 'env_error';
    }
    console.log(`${r.instance_id} ERROR ${msg.slice(0, 200)}`);
    if (/spend cap/.test(msg)) break;
  }
}
const wall = Date.now() - started;
if (!extractOnly) {
  const out = { model: MODEL, ran_at: new Date().toISOString(), mode: useLabels ? 'labels' : 'jev', spend_usd: spent, jev_requests: latencies.length, latency_p50_ms: latencies.slice().sort((a, b) => a - b)[Math.floor(latencies.length / 2)] ?? null, wall_ms: wall, rows };
  writeFileSync(join(DIR, useLabels ? 'results.labels.json' : 'results.json'), JSON.stringify(out, null, 2));
  // table
  const lines: string[] = ['| instance | blocks (kinds) | Jev pick (p) / label | kind (p) / label | criterion | base | gold | outcome | Jev $ / ms | wall s |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const row of rows) {
    const j = row.jev;
    const pick = row.picked === null ? '-' : row.picked.reproduction === null ? 'none' : `${row.picked.reproduction} (${(j?.is_reproduction[String(row.picked.reproduction)] ?? 0).toFixed(2)})`;
    const lab = row.labels === null ? '' : ` / [${row.labels.repro.join(',')}]`;
    const kind = j === null ? '-' : `${j.failure_kind} (${j.p_failure_kind.toFixed(2)})`;
    const labKind = row.labels === null ? '' : ` / ${row.labels.kind}`;
    const crit = row.criterion === null ? '-' : `${row.criterion.form}${row.criterion.strength === 'weak' ? ' (weak)' : ''}`;
    const base = row.base?.verdict === null || row.base === null ? '-' : row.base.verdict.pass ? 'pass' : `fail: ${row.base.verdict.actual.slice(0, 40).replace(/\|/g, '\\|')}`;
    const g = row.gold?.verdict === null || row.gold === null || row.gold === undefined ? '-' : row.gold.verdict.pass ? 'PASS' : `fail: ${row.gold.verdict.actual.slice(0, 40).replace(/\|/g, '\\|')}`;
    lines.push(`| ${row.instance_id} | ${row.n_blocks} (${row.block_kinds.map((k) => k.split('/')[0]).join(', ')}) | ${pick}${lab} | ${kind}${labKind} | ${crit} | ${base} | ${g} | **${row.outcome}** | ${j === null ? '-' : `$${j.cost_usd.toFixed(4)} / ${j.latency_ms} ms`} | ${(row.wall_ms / 1000).toFixed(1)} |`);
  }
  writeFileSync(join(DIR, useLabels ? 'table.labels.md' : 'table.md'), lines.join('\n') + '\n');
  const count = (o: Outcome): number => rows.filter((r) => r.outcome === o).length;
  console.log(`\nblocks≥1: ${rows.filter((r) => r.n_blocks > 0).length}/${rows.length}; valid: ${count('valid')} (+weak ${count('valid_weak')}); passes_on_base: ${count('passes_on_base')}; fails_on_gold: ${count('fails_on_gold')}; env_error: ${count('env_error')}; no_pick: ${count('no_pick')}; not_runnable: ${count('not_runnable')}; no_criterion: ${count('no_criterion')}; no_blocks: ${count('no_blocks')}`);
  if (rows.some((r) => r.agreement !== null)) {
    const a = rows.filter((r) => r.agreement !== null).map((r) => r.agreement!);
    console.log(`agreement (n=${a.length}): repro pick in labels ${a.filter((x) => x.repro_pick_in_labels).length}, repro set exact ${a.filter((x) => x.repro_set_exact).length}, expected pick in labels ${a.filter((x) => x.expected_pick_in_labels).length}, kind strict ${a.filter((x) => x.kind_strict).length}, lenient ${a.filter((x) => x.kind_lenient).length}`);
  }
  console.log(`Jev: ${latencies.length} requests, $${spent.toFixed(4)}, p50 ${out.latency_p50_ms} ms; wall ${(wall / 1000).toFixed(0)} s`);
}
