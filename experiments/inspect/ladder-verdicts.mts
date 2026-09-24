/**
 * Per-task correctness verdicts for a ladder jev-only results directory. The ladder evaluator only
 * runs the task's own tests, so a "complete" solve can still be a behaviourally wrong fix (rungs-1-2
 * §26: `grades` with `minimum -= 1` maps 89.5 to 'A'; `textstats` with `tokens.append(n)` mutates the
 * caller's list and raises on a tuple). This script judges every solved task against the gold tree.
 *
 * For every task in <resultsDir>/tasks.jsonl (last record per task wins):
 *   - `miss`            the evaluator did not pass it;
 *   - the patched tree is a private copy of bench/data/ladder/tasks/<task> with the run's
 *     ~/.jevcode/runs/<runId>/model_patch.diff applied (else the bench workspace
 *     ~/.jevcode/runs/bench-work/<benchId>/<task>/jev-only/workspace/src copied over src/); the gold
 *     tree is another copy with gold/*.py copied over src/;
 *   - `gold-identical`  every gold module is token-identical to the patched module (python tokenize;
 *                       comments, blank lines and whitespace width ignored);
 *   - otherwise a differential over hand-derived inputs, in three python3 processes (stdlib + pytest,
 *     which the test modules import):
 *       harvest (gold tree): every public function of every gold module, and every public method of
 *         every class the modules define, is wrapped by a recorder; the task's tests/test_*.py are
 *         imported and each zero-argument test function is called, so the recorder sees the literal
 *         arguments the tests pass plus every nested call (report → letter_grade → …). Arguments are
 *         pickled (dataclass instances and dates included). Each distinct call is then perturbed one
 *         argument at a time: ints ±1 and to x±0.5, floats ±0.5 and to ⌊x⌋+0.5, strings emptied or cut
 *         to one character, lists/tuples/dicts emptied or cut to one element or the last dropped, a
 *         tuple in place of a list (and a list in place of a tuple), dates ±1 day, and None in place
 *         of the argument; at most --per-fn-cap perturbed inputs per function (seeded shuffle).
 *       replay (gold tree, patched tree): each input is unpickled fresh, called under a SIGALRM timer,
 *         and reduced to a canonical text (dict items and set members sorted, generators drained,
 *         address-only reprs replaced by the object's fields), its truthiness, and the canonical text
 *         of the arguments after the call (so a fix that mutates its input is a mismatch).
 *       `equivalent`  every input gives the same result text, exception class and post-call arguments,
 *       `overfit`     at least one differs (the evidence names the inputs; a mismatch whose truthiness
 *                     agrees on a bool-returning function is called out as type-only),
 *       `unverified`  the patch could not be materialised, the harvest recorded nothing, or a replay failed.
 *
 * Usage: node_modules/.bin/tsx experiments/inspect/ladder-verdicts.mts [resultsDir] [--out <file>] [--seed <int>] [--per-fn-cap <N>]
 *   default resultsDir bench/results/jev-only-ladder-7-final, default out <resultsDir>/verdicts.md
 * Nothing here asks Jev; python3 is the only external program. The harvest/replay harness is
 * src/jev-modes/synth/search/perturb.ts LADDER_HARNESS, shared with the guard's ladder-class behaviour probe
 * (the guard replays the same perturbed calls per passer; this script judges the committed tree).
 */
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { LADDER_HARNESS } from '../../src/jev-modes/synth/search/perturb.ts';

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LADDER = join(ROOT, 'bench/data/ladder');
const RUNS = join(homedir(), '.jevcode/runs');
const PER_INPUT_TIMEOUT_MS = 2000;
const DEFAULT_SEED = 20260921;
const DEFAULT_PER_FN_CAP = 80;
const ENV = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONHASHSEED: '0' };

type Verdict = 'gold-identical' | 'equivalent' | 'overfit' | 'unverified' | 'miss';
type Tier = 'short' | 'long';

interface TaskRecord {
  task: string;
  pass: boolean | null;
  runId: string | null;
  stopReason: string | null;
  steps: number | null;
  patchEmpty: boolean | null;
}

interface Row {
  task: string;
  tier: Tier;
  solved: boolean;
  verdict: Verdict;
  /** overfit rows: every mismatch is weak (exception class only, or bool vs int with equal truthiness) */
  weakOnly?: boolean;
  evidence: string;
}

interface Options {
  resultsDir: string;
  out: string;
  seed: number;
  perFnCap: number;
}

function argv(): Options {
  const args = process.argv.slice(2);
  let resultsDir = 'bench/results/jev-only-ladder-7-final';
  let out: string | null = null;
  let seed = DEFAULT_SEED;
  let perFnCap = DEFAULT_PER_FN_CAP;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--out') out = args[++i] ?? null;
    else if (a === '--seed') seed = Number(args[++i]);
    else if (a === '--per-fn-cap') perFnCap = Number(args[++i]);
    else resultsDir = a;
  }
  const dir = resolve(ROOT, resultsDir);
  return { resultsDir: dir, out: out === null ? join(dir, 'verdicts.md') : resolve(ROOT, out), seed, perFnCap };
}

function readRecords(dir: string): TaskRecord[] {
  const byTask = new Map<string, TaskRecord>();
  for (const line of readFileSync(join(dir, 'tasks.jsonl'), 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const r = JSON.parse(line) as Record<string, unknown>;
    if (typeof r['task'] !== 'string') continue;
    byTask.set(r['task'], {
      task: r['task'],
      pass: typeof r['pass'] === 'boolean' ? r['pass'] : null,
      runId: typeof r['runId'] === 'string' ? r['runId'] : null,
      stopReason: typeof r['stopReason'] === 'string' ? r['stopReason'] : null,
      steps: typeof r['steps'] === 'number' ? r['steps'] : null,
      patchEmpty: typeof r['patchEmpty'] === 'boolean' ? r['patchEmpty'] : null,
    });
  }
  return [...byTask.values()];
}

function benchIdOf(dir: string): string | null {
  const p = join(dir, 'summary.json');
  if (!existsSync(p)) return null;
  const s = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  return typeof s['benchId'] === 'string' ? s['benchId'] : null;
}

function tierOf(task: string): Tier {
  const p = join(LADDER, 'tasks', task, 'meta.json');
  if (!existsSync(p)) return 'short';
  const m = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  return m['tier'] === 'long' ? 'long' : 'short';
}

/** index.json order: the short tier, then the long tier, each sorted by name. */
function indexOrder(): string[] {
  const p = join(LADDER, 'index.json');
  if (!existsSync(p)) return [];
  const idx = JSON.parse(readFileSync(p, 'utf8')) as { name: string }[];
  return idx.map((e) => e.name);
}

function goldModules(task: string): string[] {
  const dir = join(LADDER, 'tasks', task, 'gold');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.py')).map((f) => f.slice(0, -3)).sort();
}

/** A private copy of the task directory without gold/ and caches. */
async function copyTask(task: string, dest: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  await exec('cp', ['-R', join(LADDER, 'tasks', task), dest]);
  rmSync(join(dest, 'gold'), { recursive: true, force: true });
  for (const d of ['src', 'tests']) rmSync(join(dest, d, '__pycache__'), { recursive: true, force: true });
}

interface Trees {
  gold: string;
  patched: string | null;
  patchedFrom: string;
}

async function materialise(rec: TaskRecord, benchId: string | null, scratch: string): Promise<Trees> {
  const gold = join(scratch, rec.task, 'gold');
  await copyTask(rec.task, gold);
  for (const m of goldModules(rec.task)) copyFileSync(join(LADDER, 'tasks', rec.task, 'gold', `${m}.py`), join(gold, 'src', `${m}.py`));

  const patched = join(scratch, rec.task, 'patched');
  await copyTask(rec.task, patched);
  const diffPath = rec.runId === null ? null : join(RUNS, rec.runId, 'model_patch.diff');
  const reasons: string[] = [];
  if (diffPath !== null && existsSync(diffPath) && readFileSync(diffPath).length > 0) {
    try {
      await exec('git', ['apply', diffPath], { cwd: patched });
      return { gold, patched, patchedFrom: `model_patch.diff (${readFileSync(diffPath).length} bytes)` };
    } catch (e) {
      reasons.push(`model_patch.diff failed to apply: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    }
  } else reasons.push(diffPath === null ? 'no runId' : 'no model_patch.diff');
  if (benchId !== null) {
    const ws = join(RUNS, 'bench-work', benchId, rec.task, 'jev-only', 'workspace', 'src');
    if (existsSync(ws)) {
      rmSync(join(patched, 'src'), { recursive: true, force: true });
      await exec('cp', ['-R', ws, join(patched, 'src')]);
      rmSync(join(patched, 'src', '__pycache__'), { recursive: true, force: true });
      return { gold, patched, patchedFrom: `bench workspace src/ (${reasons.join('; ')})` };
    }
    reasons.push('no bench workspace');
  }
  return { gold, patched: null, patchedFrom: reasons.join('; ') };
}

const TOKEN_COMPARE = `
import sys, tokenize, io
def toks(path):
    with open(path, 'rb') as f:
        src = f.read()
    out = []
    for t in tokenize.tokenize(io.BytesIO(src).readline):
        if t.type in (tokenize.COMMENT, tokenize.NL, tokenize.ENCODING, tokenize.ENDMARKER):
            continue
        out.append((t.type, t.string))
    while out and out[-1][0] in (tokenize.NEWLINE, tokenize.DEDENT):
        out.pop()
    return out
a, b = toks(sys.argv[1]), toks(sys.argv[2])
if a == b:
    print('same')
else:
    n = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
    print('differs at token %d: %r vs %r' % (n, a[n][1] if n < len(a) else '<end>', b[n][1] if n < len(b) else '<end>'))
`;

async function tokenIdentical(patched: string, reference: string): Promise<{ same: boolean; detail: string }> {
  if (!existsSync(patched)) return { same: false, detail: 'missing in the patched tree' };
  const { stdout } = await exec('python3', ['-c', TOKEN_COMPARE, patched, reference]);
  const detail = stdout.trim();
  return { same: detail === 'same', detail };
}

// ---------------------------------------------------------------------------------------
// The harness: `harvest` on the gold tree, `replay` on each tree — src/jev-modes/synth/search/perturb.ts
// LADDER_HARNESS, the same generator the guard's ladder-class behaviour probe runs (2026-09-21;
// it lived here first). Written to a file once per run and invoked per mode.
// ---------------------------------------------------------------------------------------

interface HarvestReport {
  recorded: number;
  inputs: number;
  functions: number;
  stats: Record<string, number>;
  importErrors: Record<string, string>;
}

interface Replay {
  r: string;
  t: boolean | null;
  a: string;
}

interface HarvestInput {
  module: string;
  qualname: string;
  how: string;
  source: string;
  text: string;
}

function lastJson(stdout: string): Record<string, unknown> | null {
  const line = stdout.split('\n').map((l) => l.trim()).reverse().find((l) => l.startsWith('{'));
  return line === undefined ? null : (JSON.parse(line) as Record<string, unknown>);
}

async function harvest(harness: string, goldTree: string, modules: string[], seed: number, perFnCap: number, outPath: string): Promise<HarvestReport | { error: string }> {
  try {
    // LADDER_HARNESS argv: harvest <tree> <modules,csv> <test_modules,csv|''> <seed> <per_fn_cap> <out_path>; the modules are import names, the empty test list means every tests/test*.py
    const { stdout, stderr } = await exec('python3', [harness, 'harvest', goldTree, modules.map((m) => `src.${m}`).join(','), '', String(seed), String(perFnCap), outPath], { env: ENV, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, cwd: goldTree });
    const o = lastJson(stdout);
    if (o === null) return { error: `harvest gave no protocol line (${stderr.trim().split('\n').pop() ?? ''})` };
    return { recorded: Number(o['recorded']), inputs: Number(o['inputs']), functions: Number(o['functions']), stats: (o['stats'] as Record<string, number>) ?? {}, importErrors: (o['import_errors'] as Record<string, string>) ?? {} };
  } catch (e) {
    return { error: `harvest failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` };
  }
}

async function replay(harness: string, tree: string, inputsPath: string, count: number): Promise<Replay[] | { error: string }> {
  try {
    // LADDER_HARNESS argv: replay <tree> <@inputs-file | inputs-json> <timeout_s>
    const { stdout, stderr } = await exec('python3', [harness, 'replay', tree, `@${inputsPath}`, String(PER_INPUT_TIMEOUT_MS / 1000)], { env: ENV, timeout: count * PER_INPUT_TIMEOUT_MS + 10_000, maxBuffer: 64 * 1024 * 1024, cwd: tree });
    const o = lastJson(stdout);
    if (o === null) return { error: `replay gave no protocol line (${stderr.trim().split('\n').pop() ?? ''})` };
    const outputs = o['outputs'];
    if (!Array.isArray(outputs)) return { error: 'replay protocol line malformed' };
    return outputs as Replay[];
  } catch (e) {
    return { error: `replay failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` };
  }
}

function cut(s: string, n = 60): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function isErrorText(s: string): boolean {
  return /^(ERROR|TIMEOUT|RESOLVE_ERROR|UNPICKLE_ERROR)/.test(s);
}

interface Mismatch {
  input: HarvestInput;
  gold: Replay;
  patched: Replay;
  /** strong: a different value, or one side raises where the other returns, or the arguments were mutated differently;
   *  weak: both sides raise but a different class, or the truthiness agrees on a bool-returning function (bool vs int). */
  kind: 'result' | 'mutation' | 'exception-class' | 'type-only';
}

function isWeak(k: Mismatch['kind']): boolean {
  return k === 'exception-class' || k === 'type-only';
}

function classify(input: HarvestInput, gold: Replay, patched: Replay): Mismatch | null {
  if (gold.r !== patched.r) {
    if (isErrorText(gold.r) && isErrorText(patched.r) && gold.r !== 'TIMEOUT' && patched.r !== 'TIMEOUT') return { input, gold, patched, kind: 'exception-class' };
    const typeOnly = !isErrorText(gold.r) && !isErrorText(patched.r) && gold.t !== null && gold.t === patched.t && (gold.r === 'True' || gold.r === 'False');
    return { input, gold, patched, kind: typeOnly ? 'type-only' : 'result' };
  }
  if (gold.a !== patched.a) return { input, gold, patched, kind: 'mutation' };
  return null;
}

function describe(m: Mismatch): string {
  if (m.kind === 'mutation') return `${cut(m.input.text, 70)} → same result ${cut(m.gold.r, 40)} but the patched call left the arguments as ${cut(m.patched.a, 50)} vs gold ${cut(m.gold.a, 50)}`;
  const note = m.kind === 'type-only' ? ' (truthiness agrees; type differs)' : m.kind === 'exception-class' ? ' (both raise)' : '';
  return `${cut(m.input.text, 70)} → patched ${cut(m.patched.r, 40)} vs gold ${cut(m.gold.r, 40)}${note}`;
}

const KIND_ORDER: Record<Mismatch['kind'], number> = { result: 0, mutation: 1, 'type-only': 2, 'exception-class': 3 };

async function judge(rec: TaskRecord, benchId: string | null, scratch: string, opts: Options): Promise<Row> {
  const tier = tierOf(rec.task);
  const solved = rec.pass === true;
  if (!solved) {
    const what = rec.patchEmpty === true ? 'no patch committed' : 'a committed patch still fails';
    return { task: rec.task, tier, solved, verdict: 'miss', evidence: `${what}; ${rec.stopReason ?? '?'} after ${rec.steps ?? '?'} steps` };
  }
  const trees = await materialise(rec, benchId, scratch);
  if (trees.patched === null) return { task: rec.task, tier, solved, verdict: 'unverified', evidence: `patched tree could not be materialised: ${trees.patchedFrom}` };
  const modules = goldModules(rec.task);
  const idents = await Promise.all(modules.map(async (m) => ({ m, ...(await tokenIdentical(join(trees.patched!, 'src', `${m}.py`), join(trees.gold, 'src', `${m}.py`))) })));
  const differing = idents.filter((i) => !i.same);
  if (differing.length === 0) return { task: rec.task, tier, solved, verdict: 'gold-identical', evidence: `token-identical to gold/ (${modules.map((m) => `${m}.py`).join(', ')}; from ${trees.patchedFrom})` };
  const head = `differs from gold in ${differing.map((d) => `${d.m}.py (${d.detail})`).join(', ')}`;

  const inputsPath = join(scratch, rec.task, 'inputs.json');
  const harness = join(scratch, 'ladder_harness.py');
  const h = await harvest(harness, trees.gold, modules, opts.seed, opts.perFnCap, inputsPath);
  if ('error' in h) return { task: rec.task, tier, solved, verdict: 'unverified', evidence: `${head}; ${h.error}` };
  if (h.inputs === 0) return { task: rec.task, tier, solved, verdict: 'unverified', evidence: `${head}; the harvest recorded no call (${h.stats['tests_run'] ?? 0} tests run${Object.keys(h.importErrors).length > 0 ? `, import errors ${JSON.stringify(h.importErrors)}` : ''})` };
  const inputs = (JSON.parse(readFileSync(inputsPath, 'utf8')) as { inputs: HarvestInput[] }).inputs;
  const [gold, patched] = await Promise.all([replay(harness, trees.gold, inputsPath, inputs.length), replay(harness, trees.patched, inputsPath, inputs.length)]);
  if ('error' in gold) return { task: rec.task, tier, solved, verdict: 'unverified', evidence: `${head}; gold ${gold.error}` };
  if ('error' in patched) return { task: rec.task, tier, solved, verdict: 'unverified', evidence: `${head}; patched ${patched.error}` };
  const mismatches: Mismatch[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const m = classify(inputs[i]!, gold[i]!, patched[i]!);
    if (m !== null) mismatches.push(m);
  }
  const fns = [...new Set(inputs.map((i) => i.qualname))];
  const perturbed = inputs.length - h.recorded;
  const coverage = `${inputs.length} inputs (${h.recorded} recorded from ${h.stats['tests_run'] ?? 0} tests${(h.stats['tests_failed'] ?? 0) > 0 ? `, ${h.stats['tests_failed']} failed on gold` : ''}, ${perturbed} perturbed) over ${fns.length} functions`;
  if (mismatches.length === 0) return { task: rec.task, tier, solved, verdict: 'equivalent', evidence: `${head}; identical results, exception classes and post-call arguments on ${coverage} (${fns.join(', ')}); from ${trees.patchedFrom}` };
  mismatches.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.input.text < b.input.text ? -1 : 1));
  const byFn = new Map<string, Mismatch[]>();
  for (const m of mismatches) byFn.set(m.input.qualname, [...(byFn.get(m.input.qualname) ?? []), m]);
  const examples: string[] = [];
  for (const [, ms] of byFn) for (const m of ms.slice(0, 3)) examples.push(describe(m));
  const weak = mismatches.filter((m) => isWeak(m.kind)).length;
  const strong = mismatches.length - weak;
  const kinds = (['result', 'mutation', 'type-only', 'exception-class'] as const).map((k) => [k, mismatches.filter((m) => m.kind === k).length] as const).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ');
  const tally = `${mismatches.length}/${inputs.length} differ (${[...byFn].map(([f, ms]) => `${f} ${ms.length}`).join(', ')}; ${kinds})`;
  const grade = strong > 0 ? 'strong' : 'weak only';
  return { task: rec.task, tier, solved, verdict: 'overfit', weakOnly: strong === 0, evidence: `${grade}: ${head}; ${tally} on ${coverage}: ${examples.slice(0, 6).join('; ')}; from ${trees.patchedFrom}` };
}

function table(rows: readonly Row[]): string {
  const lines = ['| task | tier | solved | verdict | evidence |', '| --- | --- | --- | --- | --- |'];
  for (const r of rows) lines.push(`| ${r.task} | ${r.tier} | ${r.solved ? 'yes' : 'no'} | ${r.verdict} | ${r.evidence.replace(/\|/g, '\\|')} |`);
  return lines.join('\n');
}

function tierLine(rows: readonly Row[], tier: Tier | null): string {
  const rs = tier === null ? rows : rows.filter((r) => r.tier === tier);
  const solved = rs.filter((r) => r.solved).length;
  const c = (v: Verdict): number => rs.filter((r) => r.verdict === v).length;
  const correct = c('gold-identical') + c('equivalent');
  const strong = rs.filter((r) => r.verdict === 'overfit' && r.weakOnly !== true);
  const weak = rs.filter((r) => r.verdict === 'overfit' && r.weakOnly === true);
  const name = (xs: Row[]): string => (xs.length > 0 ? ` (${xs.map((r) => r.task).join(', ')})` : '');
  return `${tier === null ? 'all' : tier} tier: solved ${solved}/${rs.length}, correct ${correct}/${rs.length} (gold-identical ${c('gold-identical')}, equivalent ${c('equivalent')}); overfit ${c('overfit')} — strong ${strong.length}${name(strong)}, weak only ${weak.length}${name(weak)}; unverified ${c('unverified')}, miss ${c('miss')}`;
}

async function main(): Promise<void> {
  const opts = argv();
  const records = readRecords(opts.resultsDir);
  const order = indexOrder();
  const pos = (t: string): number => (order.indexOf(t) === -1 ? order.length : order.indexOf(t));
  records.sort((a, b) => pos(a.task) - pos(b.task) || (a.task < b.task ? -1 : 1));
  const benchId = benchIdOf(opts.resultsDir);
  const scratch = mkdtempSync(join(tmpdir(), 'ladder-verdicts-'));
  writeFileSync(join(scratch, 'ladder_harness.py'), LADDER_HARNESS);
  const rows: Row[] = [];
  try {
    for (const rec of records) {
      const row = await judge(rec, benchId, scratch, opts);
      rows.push(row);
      console.log(`${row.task.padEnd(18)} ${row.tier.padEnd(5)} ${row.solved ? 'solved' : 'miss  '} ${row.verdict.padEnd(15)} ${cut(row.evidence, 120)}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const summary = [tierLine(rows, 'short'), tierLine(rows, 'long'), tierLine(rows, null)];
  const overfits = rows.filter((r) => r.verdict === 'overfit');
  const md = `# Per-task verdicts: ${opts.resultsDir.replace(`${ROOT}/`, '')}

Generated by \`experiments/inspect/ladder-verdicts.mts\` (code only, no Jev). Bench id ${benchId ?? 'unknown'}. "solved" is the bench
evaluator's verdict (the task's own \`tests/\`, the only oracle the run had). The patched tree is a private copy of
\`bench/data/ladder/tasks/<task>\` with the run's \`~/.jevcode/runs/<runId>/model_patch.diff\` applied (else the bench workspace
\`src/\`); the gold tree has \`gold/*.py\` copied over \`src/\`.

Verdicts: \`gold-identical\` = every gold module token-identical to the patched module (comments, blank lines and whitespace
width ignored); otherwise a differential: every public function and method of the gold modules is wrapped by a recorder,
the task's test functions are run so the recorder sees the arguments the tests pass (and every nested call), each distinct
call is perturbed one argument at a time (ints ±1 and x±0.5, floats ±0.5 and ⌊x⌋+0.5, strings emptied / one character,
sequences emptied / one element / last dropped, tuple for list and list for tuple, dates ±1 day, None; at most ${opts.perFnCap}
perturbed inputs per function, seed ${opts.seed}), and every input is replayed on both trees (SIGALRM ${PER_INPUT_TIMEOUT_MS / 1000} s each) comparing
the canonical result text, the exception class and the arguments after the call: \`equivalent\` = all agree, \`overfit\` = at
least one differs, \`unverified\` = the patch could not be materialised or a harness step failed; \`miss\` = not solved.
An overfit is *strong* when some input gets a different value, or one side raises where the other returns, or the arguments
are mutated differently; it is *weak only* when every difference is either both sides raising a different exception class or a
bool-returning function returning a non-bool of the same truthiness. "correct" below counts gold-identical + equivalent; the
weak-only rows are named so they can be counted either way.

${table(rows)}

Totals:
- ${summary.join('\n- ')}
${overfits.length > 0 ? `\nOverfit (solved by the evaluator, behaviourally different from gold): ${overfits.map((r) => `${r.task}${r.weakOnly === true ? ' (weak only)' : ''}`).join(', ')}.\n` : ''}`;
  writeFileSync(opts.out, md);
  console.log('');
  for (const s of summary) console.log(s);
  console.log(`written ${opts.out}`);
}

await main();
