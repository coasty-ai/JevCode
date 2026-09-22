/**
 * The quick-iteration loop of HARNESS-NEXT-DESIGN §5, as one runnable script (wave S0).
 *
 * "No benchmark until a probe says the change is real." Three rings, each strictly cheaper than the one above it:
 *
 *   Ring 0 — micro-probes, no network, no API (seconds, $0): the `step-overhead` gate with its timing buckets, the
 *            Jev-contract lint, and the S0 unit micro-gates. Probes that belong to later waves (`lane-run`,
 *            `sandbox-spawn`, `py-load`, `jev-batch`, `llm-sample`) are listed as pending, not silently skipped.
 *   Ring 1 — free replay (seconds, $0): the `--jev off` safety gate of §1.2 — every Ring-2 task run offline against
 *            the mock provider with `JEVCODE_JEV=off`, which must still complete, only slower. (Replay of recorded
 *            runs, `jevcode inspect --replay`, needs `src/cli/**` and lands with that owner; the script says so
 *            rather than pretending the ring is complete.)
 *   Ring 2 — the tiny live tasks (≈ 2 min, ≈ $0.01): gcd, tagcloud, units, kth, mergesort through
 *            `jevcode bench --live --conditions llm-jev`, plus the one repository canary, once per wave.
 *
 * It prints the §5 table — wall per task and per step, steps, $, Jev requests, pass, verdict, overfit count — and
 * then evaluates the accept rule of §5 step 5 against the recorded baseline. Nothing here decides anything on its
 * own: it prints ACCEPT / REJECT with the reason, and the numbers to argue with.
 *
 * Usage (from the repo root):
 *   node --env-file=.env node_modules/.bin/tsx experiments/harness-next/quick.mts            # rings 0 and 1, $0
 *   node --env-file=.env node_modules/.bin/tsx experiments/harness-next/quick.mts --ring 2 --live --spend-cap 0.05
 *   … --canary            also run sympy__sympy-15345 once (live, ≈ $0.03)
 *   … --verdicts <md>     count overfits from a verdicts table (experiments/inspect/*-verdicts.mts output)
 *   … --timeline          record and print the §4.4 timing buckets in Ring 0 (never with a gated number)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseVerdictsMarkdown, type Verdict } from '../../src/bench/headtohead.ts';

// ---------------------------------------------------------------------------------------
// §5 Ring 2: the tasks and the baseline every row is compared against
// ---------------------------------------------------------------------------------------

interface QuickTask {
  id: string;
  suite: 'quixbugs' | 'ladder' | 'swebench';
  /** today's `llm-jev` numbers from the §5 table (the head-to-head at 626fc40) */
  baseline: { wallMs: number; steps: number; usd: number; jevRequests: number };
  why: string;
}

const TASKS: readonly QuickTask[] = [
  { id: 'gcd', suite: 'quixbugs', baseline: { wallMs: 16_000, steps: 3, usd: 0.0005, jevRequests: 4 }, why: 'seeds win the race; M3 must not slow it' },
  { id: 'tagcloud', suite: 'ladder', baseline: { wallMs: 11_000, steps: 2, usd: 0.0005, jevRequests: 9 }, why: 'the floor: any regression here is pure harness overhead' },
  { id: 'units', suite: 'ladder', baseline: { wallMs: 22_000, steps: 2, usd: 0.0008, jevRequests: 8 }, why: 'the LLM-decides path with a small prompt' },
  { id: 'kth', suite: 'quixbugs', baseline: { wallMs: 33_000, steps: 3, usd: 0.0007, jevRequests: 4 }, why: '449 candidates in one step: the screen/confirm mismatch detector' },
  { id: 'mergesort', suite: 'quixbugs', baseline: { wallMs: 178_000, steps: 3, usd: 0.014, jevRequests: 36 }, why: 'the RANK/Q17 path and the Jev-request outlier' },
];

const CANARY: QuickTask = { id: 'sympy__sympy-15345', suite: 'swebench', baseline: { wallMs: 157_000, steps: 2, usd: 0.03, jevRequests: 17 }, why: 'the repository canary: laneWarmMs, indexReuse, the chosen scope, TTFB — not the verdict' };

/** §5 grafts 6 and 7: offline tasks that need the S1 scope builders and the M11 replacer ladder. */
const PENDING_TASKS = [
  { id: 'q-self-edit', why: 'this repo, offline: needs the jest/vitest scope builders of wave S1' },
  { id: 'q-drifted-edit', why: 'fixture + mock provider: needs the M11 replacer ladder of wave S5' },
];

/** §5 Ring 0: the probes this ring will run once their wave lands. */
const PENDING_PROBES = [
  { id: 'lane-run', why: 'wave S1 (M6): one real candidate run, cold spawn vs persistent runner — the ≥ 2× gate' },
  { id: 'sandbox-spawn', why: 'wave S1: the seatbelt wrapper alone, report only' },
  { id: 'py-load', why: 'wave S3 (M7): loadPythonFiles cold / warm-parse / stat-gated' },
  { id: 'jev-batch', why: 'wave S4 (M9): 5 sequential vs 1 merged vs 5 concurrent, plus the cache hit' },
  { id: 'llm-sample', why: 'wave S2 (M1–M4): 6 real propose_fix calls, --live only' },
];

const HARNESS_GATE_MS = 50;
/** src/perf/main.ts LOAD_QUIET: above this the numbers are not release numbers */
const LOAD_QUIET = 2;
const PROMPT_BUILD_GATE_MS = 5;

// ---------------------------------------------------------------------------------------
// flags
// ---------------------------------------------------------------------------------------

interface Flags {
  ring: 0 | 1 | 2 | 'all';
  live: boolean;
  canary: boolean;
  timeline: boolean;
  spendCap: number;
  out: string | null;
  verdicts: string | null;
  concurrency: number;
}

function parseFlags(argv: readonly string[]): Flags {
  const f: Flags = { ring: 'all', live: false, canary: false, timeline: false, spendCap: 0.05, out: null, verdicts: null, concurrency: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--ring') {
      const v = next();
      f.ring = v === 'all' ? 'all' : (Number(v) as 0 | 1 | 2);
    } else if (a === '--live') f.live = true;
    else if (a === '--canary') f.canary = true;
    else if (a === '--timeline') f.timeline = true;
    else if (a === '--spend-cap') f.spendCap = Number(next());
    else if (a === '--out') f.out = next();
    else if (a === '--verdicts') f.verdicts = next();
    else if (a === '--concurrency') f.concurrency = Number(next());
    else if (a === '--help' || a === '-h') {
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 30).join('\n'));
      process.exit(0);
    } else throw new Error(`unknown flag ${a}`);
  }
  return f;
}

const flags = parseFlags(process.argv.slice(2));
const ROOT = process.cwd();
const BIN = join(ROOT, 'bin/jevcode.js');
const runRing = (n: 0 | 1 | 2): boolean => flags.ring === 'all' || flags.ring === n;

function ms(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v.toFixed(1)} ms`;
}
function pct(a: number, b: number): string {
  if (b === 0) return '—';
  const d = ((a - b) / b) * 100;
  return `${d >= 0 ? '+' : ''}${d.toFixed(0)} %`;
}
function run(cmd: string, args: readonly string[], env: Record<string, string> = {}): { code: number; out: string } {
  const r = spawnSync(cmd, [...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// ---------------------------------------------------------------------------------------
// Ring 0 — micro-probes, $0
// ---------------------------------------------------------------------------------------

interface GateRow {
  name: string;
  result: string;
  gate: string;
  pass: boolean | null;
}

function ring0(): GateRow[] {
  const rows: GateRow[] = [];
  const load = loadavg()[0] ?? 0;
  console.log('\nRing 0 — micro-probes (no network, no API)\n');
  // every gate in this ring is load-sensitive (§8 R-4: the harness gate passes by a few ms and flips under load)
  if (load > LOAD_QUIET) console.log(`  NOTE: 1-minute load ${load.toFixed(2)} > ${LOAD_QUIET}; these are not release numbers and a FAIL here may be the machine\n`);
  if (!existsSync(BIN)) {
    const b = run('npm', ['run', 'build']);
    if (b.code !== 0) throw new Error(`build failed:\n${b.out}`);
  }
  const out = join(mkdtempSync(join(tmpdir(), 'fastlane-quick-')), 'perf.json');
  const probe = run(process.execPath, [BIN, 'perf', '--out', out], { JEVCODE_PERF_ONLY: 'step-overhead', ...(flags.timeline ? { JEVCODE_TIMELINE: '1' } : {}) });
  process.stdout.write(probe.out.split('\n').filter((l) => l.trim() !== '').map((l) => `  ${l}\n`).join(''));
  let harnessP95: number | null = null;
  try {
    const parsed = JSON.parse(readFileSync(out, 'utf8')) as { stepOverhead: { p95: number | null; imagesP95: number | null; pass: boolean } | null };
    harnessP95 = parsed.stepOverhead?.p95 ?? null;
    rows.push({ name: 'step-overhead harness p95', result: ms(harnessP95), gate: `< ${HARNESS_GATE_MS} ms`, pass: parsed.stepOverhead?.pass ?? false });
    rows.push({ name: 'step-overhead imagesMs p95', result: ms(parsed.stepOverhead?.imagesP95 ?? null), gate: 'report only (target < 15 ms)', pass: null });
  } catch {
    rows.push({ name: 'step-overhead', result: 'no result', gate: `< ${HARNESS_GATE_MS} ms`, pass: false });
  }
  rows.push({ name: 'promptBuildMs p95', result: 'not recorded', gate: `< ${PROMPT_BUILD_GATE_MS} ms`, pass: null });

  const lint = run(process.execPath, ['scripts/jev-contract.mjs', '.']);
  rows.push({ name: 'jev-contract (§1.2 four clauses)', result: lint.out.trim().split('\n').at(-1) ?? '', gate: 'exit 0', pass: lint.code === 0 });

  const units = run(join(ROOT, 'node_modules', '.bin', 'vitest'), ['run', '--project', 'unit', 'test/unit/perf', 'test/unit/jev', 'test/unit/workspace', 'test/unit/scripts']);
  const tail = units.out.split('\n').filter((l) => /^\s*Tests\s+\d/.test(l)).at(-1) ?? (units.code === 0 ? 'ok' : 'failed');
  rows.push({ name: 'S0 unit micro-gates', result: tail.trim().replace(/\s+/g, ' '), gate: 'exit 0', pass: units.code === 0 });

  for (const p of PENDING_PROBES) rows.push({ name: `probe ${p.id}`, result: 'not landed', gate: p.why, pass: null });
  return rows;
}

// ---------------------------------------------------------------------------------------
// Ring 1 — free: the `--jev off` gate (§1.2 last paragraph)
// ---------------------------------------------------------------------------------------

function ring1(): GateRow[] {
  const rows: GateRow[] = [];
  console.log('\nRing 1 — replay and the `--jev off` gate (no network, no API)\n');
  for (const suite of ['quixbugs', 'ladder'] as const) {
    const ids = TASKS.filter((t) => t.suite === suite).map((t) => t.id);
    const dir = mkdtempSync(join(tmpdir(), `fastlane-jevoff-${suite}-`));
    const r = run(process.execPath, [BIN, 'bench', '--suite', suite, '--task-id', ids.join(','), '--conditions', 'llm-jev', '--concurrency', String(flags.concurrency), '--out', dir], { JEVCODE_JEV: 'off' });
    const recs = readRecords(dir);
    const finished = recs.filter((x) => x.stopReason !== 'error' && x.stopReason !== 'not_run').length;
    rows.push({
      name: `--jev off, ${suite} (${ids.join(', ')})`,
      result: `${finished}/${ids.length} finished, ${recs.filter((x) => x.pass === true).length} pass (mocked)`,
      gate: 'every task completes, only slower',
      pass: r.code === 0 && finished === ids.length,
    });
  }
  rows.push({ name: 'replay of the 28 head-to-head run dirs', result: 'not landed', gate: 'src/loop/replay.ts + `inspect --replay` (needs src/cli/**)', pass: null });
  return rows;
}

// ---------------------------------------------------------------------------------------
// Ring 2 — the tiny live tasks
// ---------------------------------------------------------------------------------------

interface Row {
  task: string;
  pass: boolean | null;
  steps: number;
  wallMs: number;
  usd: number;
  jevRequests: number;
  jevMs: number;
  harnessMs: number;
  stopReason: string;
  verdict: Verdict | null;
}

interface RawRecord {
  task: string;
  suite: string;
  pass: boolean | null;
  steps: number;
  wallMs: number;
  cost: { generator: number; jev: number };
  jevRequests: number;
  timing: { generatorMs: number; jevMs: number; execMs: number; harnessMs: number };
  stopReason: string;
}

function readRecords(dir: string): RawRecord[] {
  const file = join(dir, 'tasks.jsonl');
  if (!existsSync(file)) {
    // the runner writes into <out>/<bench-id>/ when it owns the id
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(dir, e.name, 'tasks.jsonl'))) return readRecords(join(dir, e.name));
    }
    return [];
  }
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as RawRecord);
}

function ring2(verdicts: Map<string, Verdict>): Row[] {
  console.log(`\nRing 2 — the tiny live tasks (${flags.live ? 'LIVE' : 'mocked: pass --live for the real numbers'})\n`);
  const rows: Row[] = [];
  const wanted = flags.canary ? [...TASKS, CANARY] : TASKS;
  for (const suite of ['quixbugs', 'ladder', 'swebench'] as const) {
    const ids = wanted.filter((t) => t.suite === suite).map((t) => t.id);
    if (ids.length === 0) continue;
    const dir = mkdtempSync(join(tmpdir(), `fastlane-ring2-${suite}-`));
    const args = [BIN, 'bench', '--suite', suite, '--task-id', ids.join(','), '--conditions', 'llm-jev', '--concurrency', String(flags.concurrency), '--out', dir];
    if (flags.live) args.push('--live', '--spend-cap', String(flags.spendCap));
    const r = run(process.execPath, args);
    if (r.code !== 0) console.log(`  bench ${suite} exited ${r.code}\n${r.out.split('\n').slice(-12).join('\n')}`);
    for (const rec of readRecords(dir)) {
      rows.push({
        task: rec.task,
        pass: rec.pass,
        steps: rec.steps,
        wallMs: rec.wallMs,
        usd: rec.cost.generator + rec.cost.jev,
        jevRequests: rec.jevRequests,
        jevMs: rec.timing.jevMs,
        harnessMs: rec.timing.harnessMs,
        stopReason: rec.stopReason,
        verdict: verdicts.get(rec.task) ?? null,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------------------
// the table and the accept rule (§5 step 5)
// ---------------------------------------------------------------------------------------

function printGates(rows: readonly GateRow[]): void {
  const w = Math.max(...rows.map((r) => r.name.length), 10);
  const w1 = Math.max(...rows.map((r) => r.result.length), 6);
  for (const r of rows) console.log(`  ${r.name.padEnd(w)}  ${r.result.padEnd(w1)}  ${r.gate.padEnd(30)} ${r.pass === null ? '·' : r.pass ? 'pass' : 'FAIL'}`);
}

function printRing2(rows: readonly Row[]): boolean {
  if (rows.length === 0) {
    console.log('  no records');
    return false;
  }
  console.log('  task            pass  steps   wall      wall/step    $        jev req  jevMs   harnessMs  verdict     vs baseline');
  let improved = 0;
  let verdictChanges = 0;
  let overfits = 0;
  let jevRequestsUp = 0;
  for (const r of rows) {
    const base = [...TASKS, CANARY].find((t) => t.id === r.task)?.baseline;
    const delta = base ? pct(r.wallMs, base.wallMs) : '—';
    if (base && r.wallMs <= base.wallMs * 0.9) improved += 1;
    if (base && r.jevRequests > base.jevRequests) jevRequestsUp += 1;
    if (r.verdict === 'overfit') overfits += 1;
    if (r.verdict === 'miss' || r.pass === false) verdictChanges += 1;
    console.log(
      `  ${r.task.padEnd(15)} ${String(r.pass ?? '—').padEnd(5)} ${String(r.steps).padStart(5)}  ${ms(r.wallMs).padStart(8)}  ${ms(r.steps > 0 ? r.wallMs / r.steps : null).padStart(9)}  ${`$${r.usd.toFixed(4)}`.padStart(8)} ${String(r.jevRequests).padStart(8)} ${ms(r.jevMs).padStart(8)} ${ms(r.harnessMs).padStart(10)}  ${(r.verdict ?? '—').padEnd(11)} ${delta}`,
    );
  }
  const need = Math.min(3, rows.length);
  const accept = improved >= need && verdictChanges === 0 && jevRequestsUp === 0;
  console.log('\n  accept rule (§5 step 5):');
  console.log(`    median wall −≥ 10 % on ≥ ${need} tasks           ${improved}/${rows.length}  ${improved >= need ? 'met' : 'NOT met'}`);
  console.log(`    no verdict changed                          ${verdictChanges} change(s)  ${verdictChanges === 0 ? 'met' : 'NOT met'}`);
  console.log(`    overfit count not increased (baseline 5)    ${overfits}  ${overfits <= 5 ? 'met' : 'NOT met'}`);
  console.log(`    Jev requests not increased                  ${jevRequestsUp} task(s) up  ${jevRequestsUp === 0 ? 'met' : 'NOT met'}`);
  console.log(`    screenMismatches = 0, scopeUnusable = 0     not recorded before wave S1`);
  console.log(`\n  ${accept ? 'ACCEPT' : 'REJECT'} — and run it twice before believing it (§5 step 4)`);
  return accept;
}

// ---------------------------------------------------------------------------------------

const verdicts = flags.verdicts === null ? new Map<string, Verdict>() : parseVerdictsMarkdown(readFileSync(flags.verdicts, 'utf8'));
let ok = true;
if (runRing(0)) {
  const rows = ring0();
  printGates(rows);
  ok &&= rows.every((r) => r.pass !== false);
}
if (runRing(1)) {
  const rows = ring1();
  printGates(rows);
  ok &&= rows.every((r) => r.pass !== false);
}
if (runRing(2)) {
  ok &&= printRing2(ring2(verdicts));
  console.log('\n  pending Ring-2 tasks:');
  for (const t of PENDING_TASKS) console.log(`    ${t.id.padEnd(16)} ${t.why}`);
}
console.log(`\nquick: ${ok ? 'all gates met' : 'a gate failed'} (git ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()})`);
process.exit(ok ? 0 : 1);
