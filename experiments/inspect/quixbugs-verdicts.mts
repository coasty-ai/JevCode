/**
 * Per-program verdicts for a QuixBugs jev-only results directory (experiments/results/jev-only-audit.md
 * §6.3: the "27 gold-identical" of run 3 was a count with no per-program list and no code behind it).
 *
 * For every task in <resultsDir>/tasks.jsonl (last record per task wins):
 *   - the committed program is read from the run's bench workspace
 *     (~/.jevcode/runs/bench-work/<benchId>/<task>/jev-only/workspace/<task>.py), else rebuilt by
 *     applying the run's ~/.jevcode/runs/<runId>/model_patch.diff to bench/data/quixbugs/programs/<task>.py;
 *   - `miss`            the evaluator did not pass it (patch empty or a committed patch that still fails);
 *   - `gold-identical`  solved and token-identical to bench/data/quixbugs/correct/<task>.py (python
 *                       tokenize; comments, blank lines and the amount of whitespace ignored, indentation
 *                       structure kept);
 *   - otherwise both programs run on the evaluator's reference cases (run_tests.py) and on the
 *     code-derived perturbed inputs of src/synth/search/perturb.ts (JSON cases → ±1 / drop / duplicate /
 *     empty / singleton / word edits / swapped arguments; pytest Node chains → lengths ±1..3, acyclic
 *     and cyclic), through the same behaviour probe the guard uses:
 *       `equivalent`  every output (or exception class) matches the reference,
 *       `overfit`     at least one differs,
 *       `unverified`  no perturbation applies (graph fixtures built in a pytest module) or the probe failed.
 *
 * Usage: node_modules/.bin/tsx experiments/inspect/quixbugs-verdicts.mts [resultsDir] [--out <file>]
 *   default resultsDir bench/results/jev-only-quixbugs-3, default out <resultsDir>/verdicts.md
 * Nothing here asks Jev; python3 (stdlib) is the only external program.
 */
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Json } from '../../src/core/types.ts';
import { behaviourProbeCommand, linkedListInputs, linkedListShape, perturbedInputsFromCases, probeTimeoutMs, type PerturbedInput } from '../../src/synth/search/perturb.ts';

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const QB = join(ROOT, 'bench/data/quixbugs');
const RUNS = join(homedir(), '.jevcode/runs');
const PER_INPUT_TIMEOUT_MS = 2000;
const MAX_PERTURBED = 24;

type Verdict = 'gold-identical' | 'equivalent' | 'overfit' | 'unverified' | 'miss';

interface TaskRecord {
  task: string;
  pass: boolean | null;
  runId: string | null;
  reason: string | null;
  stopReason: string | null;
  steps: number | null;
  patchEmpty: boolean | null;
}

interface Row {
  program: string;
  solved: boolean;
  verdict: Verdict;
  evidence: string;
}

function argv(): { resultsDir: string; out: string } {
  const args = process.argv.slice(2);
  let resultsDir = 'bench/results/jev-only-quixbugs-3';
  let out: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--out') out = args[++i] ?? null;
    else resultsDir = a;
  }
  const dir = resolve(ROOT, resultsDir);
  return { resultsDir: dir, out: out === null ? join(dir, 'verdicts.md') : resolve(ROOT, out) };
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
      reason: typeof r['reason'] === 'string' ? r['reason'] : null,
      stopReason: typeof r['stopReason'] === 'string' ? r['stopReason'] : null,
      steps: typeof r['steps'] === 'number' ? r['steps'] : null,
      patchEmpty: typeof r['patchEmpty'] === 'boolean' ? r['patchEmpty'] : null,
    });
  }
  return [...byTask.values()].sort((a, b) => (a.task < b.task ? -1 : 1));
}

function benchIdOf(dir: string): string | null {
  const p = join(dir, 'summary.json');
  if (!existsSync(p)) return null;
  const s = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  return typeof s['benchId'] === 'string' ? s['benchId'] : null;
}

/** The committed program: the bench workspace file, else programs/<task>.py with model_patch.diff applied in a temp dir. */
async function patchedProgram(rec: TaskRecord, benchId: string | null, scratch: string): Promise<{ path: string; source: string; patchBytes: number }> {
  const buggy = join(QB, 'programs', `${rec.task}.py`);
  const diffPath = rec.runId === null ? null : join(RUNS, rec.runId, 'model_patch.diff');
  const patchBytes = diffPath !== null && existsSync(diffPath) ? readFileSync(diffPath).length : 0;
  if (benchId !== null) {
    const ws = join(RUNS, 'bench-work', benchId, rec.task, 'jev-only', 'workspace', `${rec.task}.py`);
    if (existsSync(ws)) return { path: ws, source: 'workspace', patchBytes };
  }
  if (diffPath !== null && patchBytes > 0) {
    const dir = join(scratch, rec.task);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    copyFileSync(buggy, join(dir, `${rec.task}.py`));
    try {
      await exec('git', ['apply', diffPath], { cwd: dir });
      return { path: join(dir, `${rec.task}.py`), source: 'model_patch.diff', patchBytes };
    } catch (e) {
      return { path: buggy, source: `model_patch.diff failed to apply: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`, patchBytes };
    }
  }
  return { path: buggy, source: 'unchanged (no patch)', patchBytes };
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
    # a trailing NEWLINE before ENDMARKER is optional
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
  const { stdout } = await exec('python3', ['-c', TOKEN_COMPARE, patched, reference]);
  const detail = stdout.trim();
  return { same: detail === 'same', detail };
}

interface RunTestsReport {
  passed: number;
  failed: number;
  errors: number;
  timeouts: number;
  total: number;
}

async function referenceCases(name: string, candidate: string): Promise<RunTestsReport | null> {
  try {
    const { stdout } = await exec('python3', [join(QB, 'run_tests.py'), name, candidate, '--timeout', '2'], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    const line = stdout.trim().split('\n').reverse().find((l) => l.startsWith('{'));
    if (line === undefined) return null;
    const r = JSON.parse(line) as Record<string, unknown>;
    const n = (k: string): number => (typeof r[k] === 'number' ? (r[k] as number) : 0);
    return { passed: n('passed'), failed: n('failed'), errors: n('errors'), timeouts: n('timeouts'), total: n('total') };
  } catch (e) {
    // run_tests.py exits 1 when a case fails; the report is still on stdout
    const err = e as { stdout?: string };
    const line = (err.stdout ?? '').trim().split('\n').reverse().find((l) => l.startsWith('{'));
    if (line === undefined) return null;
    const r = JSON.parse(line) as Record<string, unknown>;
    const n = (k: string): number => (typeof r[k] === 'number' ? (r[k] as number) : 0);
    return { passed: n('passed'), failed: n('failed'), errors: n('errors'), timeouts: n('timeouts'), total: n('total') };
  }
}

/** The programs/ module that defines `class <className>` (QuixBugs: node.py), or null. */
function classModuleOf(className: string): string | null {
  const dir = join(QB, 'programs');
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.py')) continue;
    if (new RegExp(`^class ${className}\\b`, 'm').test(readFileSync(join(dir, f), 'utf8'))) return f.slice(0, -3);
  }
  return null;
}

/** The perturbed inputs perturb.ts derives from the visible tests of `name`. */
function perturbedInputsOf(name: string): { inputs: PerturbedInput[]; basis: string } {
  const jsonPath = join(QB, 'tests', `${name}.json`);
  if (existsSync(jsonPath)) {
    const cases = JSON.parse(readFileSync(jsonPath, 'utf8')) as Json;
    return { inputs: perturbedInputsFromCases(cases, name, MAX_PERTURBED), basis: `tests/${name}.json` };
  }
  const pyPath = join(QB, 'tests', `${name}_test.py`);
  if (existsSync(pyPath)) {
    const parsed = linkedListShape(readFileSync(pyPath, 'utf8'), name, []);
    // perturb.ts resolves the class's module from the parsed workspace files; here (no parser) from programs/*.py
    const shape = parsed === null ? null : { ...parsed, module: parsed.module ?? classModuleOf(parsed.className) };
    if (shape !== null) return { inputs: linkedListInputs(shape, `${name}_test.py`, MAX_PERTURBED), basis: `tests/${name}_test.py (${shape.className} chains of lengths ${shape.lengths.join('/')}, class from ${shape.module ?? 'the program module'}.py)` };
    return { inputs: [], basis: `tests/${name}_test.py builds graph fixtures perturb.ts does not perturb` };
  }
  return { inputs: [], basis: 'no visible tests found' };
}

async function probeOutputs(name: string, candidatePath: string, inputs: readonly PerturbedInput[]): Promise<string[] | null> {
  const cmd = behaviourProbeCommand({ name, candidatePath, inputs, perInputTimeoutMs: PER_INPUT_TIMEOUT_MS, pythonPath: [join(QB, 'programs')] });
  try {
    const { stdout } = await exec('sh', ['-c', cmd], { timeout: probeTimeoutMs(inputs.length, PER_INPUT_TIMEOUT_MS), maxBuffer: 4 * 1024 * 1024 });
    const line = stdout.split('\n').map((l) => l.trim()).reverse().find((l) => l.startsWith('{'));
    if (line === undefined) return null;
    const o = JSON.parse(line) as Record<string, unknown>;
    if (o['probe'] === 'import_error') return [`import_error:${String(o['error'])}`];
    const outputs = o['outputs'];
    return Array.isArray(outputs) ? outputs.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))) : null;
  } catch {
    return null;
  }
}

function inputText(p: PerturbedInput): string {
  return p.exprs !== undefined ? p.exprs.join(', ').replace(/__jev_chain\(__jev_class\([^)]*\), "[^"]*", (\d+), (None|\d+)\)/, (_m, n: string, c: string) => `${c === 'None' ? 'acyclic' : 'cyclic'} chain of ${n}`) : JSON.stringify(p.input);
}

function cut(s: string, n = 60): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

async function judge(rec: TaskRecord, benchId: string | null, scratch: string): Promise<Row> {
  const name = rec.task;
  const reference = join(QB, 'correct', `${name}.py`);
  const patched = await patchedProgram(rec, benchId, scratch);
  const solved = rec.pass === true;
  if (!solved) {
    const what = patched.patchBytes === 0 ? 'no patch committed' : `a ${patched.patchBytes}-byte patch was committed and still fails`;
    return { program: name, solved, verdict: 'miss', evidence: `${what}; ${rec.stopReason ?? '?'} after ${rec.steps ?? '?'} steps${rec.reason ? `; ${cut(rec.reason, 90)}` : ''}` };
  }
  const ident = await tokenIdentical(patched.path, reference);
  if (ident.same) return { program: name, solved, verdict: 'gold-identical', evidence: `token-identical to correct/${name}.py (from ${patched.source})` };

  const [refCases, patCases] = await Promise.all([referenceCases(name, reference), referenceCases(name, patched.path)]);
  const cases = refCases !== null && patCases !== null ? `reference cases: patched ${patCases.passed}/${patCases.total}, reference ${refCases.passed}/${refCases.total}` : 'reference cases: run_tests.py gave no report';
  const { inputs, basis } = perturbedInputsOf(name);
  if (inputs.length === 0) return { program: name, solved, verdict: 'unverified', evidence: `differs (${ident.detail}); ${cases}; ${basis}` };
  const [outPatched, outRef] = await Promise.all([probeOutputs(name, patched.path, inputs), probeOutputs(name, reference, inputs)]);
  if (outPatched === null || outRef === null) return { program: name, solved, verdict: 'unverified', evidence: `differs (${ident.detail}); ${cases}; behaviour probe produced no result on ${inputs.length} perturbed inputs from ${basis}` };
  const diffs: string[] = [];
  for (let i = 0; i < inputs.length; i++) if (outPatched[i] !== outRef[i]) diffs.push(`${inputText(inputs[i]!)} → patched ${cut(outPatched[i] ?? '<none>', 40)} vs reference ${cut(outRef[i] ?? '<none>', 40)}`);
  const kinds = [...new Set(inputs.map((p) => p.how))].join(', ');
  if (diffs.length === 0) return { program: name, solved, verdict: 'equivalent', evidence: `differs (${ident.detail}); ${cases}; identical outputs on ${inputs.length} perturbed inputs (${kinds}) from ${basis}` };
  return { program: name, solved, verdict: 'overfit', evidence: `differs (${ident.detail}); ${cases}; ${diffs.length}/${inputs.length} perturbed inputs differ, e.g. ${diffs[0]}` };
}

function table(rows: readonly Row[]): string {
  const lines = ['| program | solved | verdict | evidence |', '| --- | --- | --- | --- |'];
  for (const r of rows) lines.push(`| ${r.program} | ${r.solved ? 'yes' : 'no'} | ${r.verdict} | ${r.evidence.replace(/\|/g, '\\|')} |`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const { resultsDir, out } = argv();
  const records = readRecords(resultsDir);
  const benchId = benchIdOf(resultsDir);
  const scratch = mkdtempSync(join(tmpdir(), 'quixbugs-verdicts-'));
  const rows: Row[] = [];
  try {
    for (const rec of records) {
      const row = await judge(rec, benchId, scratch);
      rows.push(row);
      console.log(`${row.program.padEnd(28)} ${row.solved ? 'solved' : 'miss  '} ${row.verdict.padEnd(15)} ${cut(row.evidence, 110)}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const count = (v: Verdict): number => rows.filter((r) => r.verdict === v).length;
  const solved = rows.filter((r) => r.solved).length;
  const totals = { solved, goldIdentical: count('gold-identical'), equivalent: count('equivalent'), overfit: count('overfit'), unverified: count('unverified'), miss: count('miss') };
  const verified = totals.goldIdentical + totals.equivalent;
  const summary = [
    `Totals: solved ${solved}/${rows.length}; gold-identical ${totals.goldIdentical}, equivalent ${totals.equivalent}, overfit ${totals.overfit}, unverified ${totals.unverified}, miss ${totals.miss}.`,
    `Correct by this script: ${verified}/${rows.length} (gold-identical + equivalent); ${totals.unverified} more pass the reference cases but differ from the reference where no perturbation applies; ${totals.overfit} overfit the reference cases.`,
  ];
  const md = `# Per-program verdicts: ${resultsDir.replace(`${ROOT}/`, '')}

Generated by \`experiments/inspect/quixbugs-verdicts.mts\` (code only, no Jev). Bench id ${benchId ?? 'unknown'}; the committed program is the
run's bench workspace file (\`~/.jevcode/runs/bench-work/<benchId>/<task>/jev-only/workspace/<task>.py\`), else
\`model_patch.diff\` applied to \`bench/data/quixbugs/programs/<task>.py\`. "solved" is the bench evaluator's verdict on the
reference cases (\`bench/data/quixbugs/tests\`, the same cases the workspace exposes; there is no hidden suite).

Verdicts: \`gold-identical\` = token-identical to \`bench/data/quixbugs/correct/<task>.py\` (comments, blank lines and whitespace
width ignored); otherwise both programs ran on the reference cases and on the perturbed inputs \`src/synth/search/perturb.ts\`
derives from the visible tests (the guard's behaviour probe): \`equivalent\` = every output matches, \`overfit\` = at least one
differs, \`unverified\` = no perturbation applies (pytest graph fixtures) or the probe gave no result; \`miss\` = not solved.

${table(rows)}

${summary.join('\n')}
`;
  writeFileSync(out, md);
  console.log('');
  for (const s of summary) console.log(s);
  console.log(`written ${out}`);
}

await main();
