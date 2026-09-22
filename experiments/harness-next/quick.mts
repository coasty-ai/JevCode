/**
 * The quick-iteration loop of HARNESS-NEXT-DESIGN §5, as one runnable script (wave S0).
 *
 * "No benchmark until a probe says the change is real." Three rings, each strictly cheaper than the one above it:
 *
 *   Ring 0 — micro-probes, no network, no API (seconds, $0): the `step-overhead` gate with its timing buckets,
 *            probes P2 `lane-run` and P2b `sandbox-spawn`, the Jev-contract lint, and the S0 unit micro-gates.
 *            Probes that belong to later waves (`py-load`, `jev-batch`, `llm-sample`) and the S0 deliverables
 *            this tree does not have are printed with their owner, not silently skipped.
 *   Ring 1 — free replay (seconds, $0): the `--jev off` safety gate of §1.2 — every Ring-2 task run offline against
 *            the mock provider, **twice**: once with Jev on and once with `JEVCODE_JEV=off`. The gate is the
 *            comparison, not an absolute: every task the Jev-on arm solves, the Jev-off arm must also solve.
 *            (Replay of recorded runs, `jevcode inspect --replay`, needs `src/cli/**` and lands with that owner;
 *            the script says so rather than pretending the ring is complete.)
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
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseVerdictsMarkdown, type Verdict } from '../../src/bench/headtohead.ts';
// §5 "What is measured on every Ring-2 run" lives in its own module so a bare bench directory and this ring are
// summarised by the same code (HARNESS-NEXT-DESIGN §6 S0 names the file)
import { ms, printQuickTable, readRecords, rowsFrom, type RawRecord, type TaskBaseline } from '../fastlane/quick-table.mts';

// ---------------------------------------------------------------------------------------
// §5 Ring 2: the tasks and the baseline every row is compared against
// ---------------------------------------------------------------------------------------

type QuickTask = TaskBaseline;

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

/**
 * §5 Ring 0 probes this script runs. They are opt-in in `src/perf/main.ts` (`RING0_PROBES`), so naming them makes
 * the perf run `partial` and the release gate, its wall and its python3 dependency stay exactly what they were.
 */
const RING0_PROBES = ['sandbox-spawn', 'lane-run'] as const;

/** §5 Ring 0: probes that are not in this tree yet, each with the wave that owns it. */
const PENDING_PROBES = [
  { id: 'py-load', why: 'wave S3 (M7): loadPythonFiles cold / warm-parse / stat-gated — owner: the S3 indexing wave' },
  { id: 'jev-batch', why: 'wave S4 (M9): 5 sequential vs 1 merged vs 5 concurrent, plus the cache hit — owner: the S4 router wave' },
  { id: 'llm-sample', why: 'wave S2 (M1–M4): 6 real propose_fix calls, --live only (≈ $0.003) — owner: the S2 generator wave' },
];

/**
 * Work §6 S0 names that this tree does not have, with the reason and the owner. Printed, not silently omitted:
 * a wave that reports "all gates met" while three of its deliverables are missing is the failure mode §5 exists
 * to prevent.
 */
const DEFERRED = [
  { what: 'imagesMs reduction (p95 19.9–24.5 ms, target 15 ms)', why: 'the serial 15 MiB pre-image copy is in src/checkpoint/images.ts, owned by another branch in flight; S0 instrumented it (`images:pre` / `images:post` spans) and did not reduce it' },
  { what: 'src/loop/replay.ts + `jevcode inspect --replay <run-id>` (M15, Ring 1 proper)', why: 'the flag lands in src/cli/inspect.ts, owned by another branch; the `--jev off` gate below is the part of Ring 1 that is free of it' },
  { what: 'the TTFB callback on src/provider/sse.ts, and `--quick` in src/bench/cli.ts', why: 'both feed fields in src/core/types.ts (§4.4), owned by another branch; they land with the S2 generator wave' },
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

function num(v: string, flag: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number (got ${JSON.stringify(v)})`);
  return n;
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
      // `Number(v) as 0 | 1 | 2` accepted `--ring 7` and `--ring abc` (NaN): no ring ran and the script still
      // printed "all gates met" and exited 0 — a green run that measured nothing
      if (v === 'all') f.ring = 'all';
      else if (v === '0' || v === '1' || v === '2') f.ring = Number(v) as 0 | 1 | 2;
      else throw new Error(`--ring must be 0, 1, 2 or all (got ${JSON.stringify(v)})`);
    } else if (a === '--live') f.live = true;
    else if (a === '--canary') f.canary = true;
    else if (a === '--timeline') f.timeline = true;
    else if (a === '--spend-cap') f.spendCap = num(next(), '--spend-cap');
    else if (a === '--out') f.out = next();
    else if (a === '--verdicts') f.verdicts = next();
    else if (a === '--concurrency') f.concurrency = Math.max(1, Math.floor(num(next(), '--concurrency')));
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

/**
 * A child process with an explicit environment delta. A key set to `null` is *removed*: the Jev-on arm of the
 * Ring-1 gate must run with `JEVCODE_JEV` unset even when the shell that launched this script has it set,
 * otherwise the paired comparison silently compares two Jev-off arms.
 */
function run(cmd: string, args: readonly string[], env: Record<string, string | null> = {}): { code: number; out: string } {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  const r = spawnSync(cmd, [...args], { cwd: ROOT, encoding: 'utf8', env: merged, maxBuffer: 64 * 1024 * 1024 });
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
  const probe = run(process.execPath, [BIN, 'perf', '--out', out], { JEVCODE_PERF_ONLY: ['step-overhead', ...RING0_PROBES].join(','), ...(flags.timeline ? { JEVCODE_TIMELINE: '1' } : {}) });
  process.stdout.write(probe.out.split('\n').filter((l) => l.trim() !== '').map((l) => `  ${l}\n`).join(''));
  let harnessP95: number | null = null;
  try {
    const parsed = JSON.parse(readFileSync(out, 'utf8')) as {
      stepOverhead: { p95: number | null; imagesP95: number | null; imagesTargetMs: number; pass: boolean } | null;
      laneRun: { modes: { mode: string; cold: { p50: number | null } | null; speedup: number | null; gate: string; note: string }[] } | null;
      sandboxSpawn: { wrapperMs: number | null } | null;
    };
    harnessP95 = parsed.stepOverhead?.p95 ?? null;
    rows.push({ name: 'step-overhead harness p95', result: ms(harnessP95), gate: `< ${HARNESS_GATE_MS} ms`, pass: parsed.stepOverhead?.pass ?? false });
    // §6 S0 charters a *reduction* here and S0 did not land one: the 15 MiB serial pre-image copy is in
    // src/checkpoint/images.ts, which another branch owns. Instrumented, not reduced — say so on the row.
    const target = parsed.stepOverhead?.imagesTargetMs ?? 15;
    rows.push({ name: 'step-overhead imagesMs p95', result: ms(parsed.stepOverhead?.imagesP95 ?? null), gate: `report only (target < ${target} ms; DEFERRED, see below)`, pass: null });
    for (const m of parsed.laneRun?.modes ?? []) {
      rows.push({
        name: `probe lane-run (${m.mode})`,
        result: m.cold === null ? 'no cold arm' : `cold p50 ${ms(m.cold.p50)}${m.speedup === null ? '' : ` → ${m.speedup.toFixed(2)}×`}`,
        gate: 'warm ≥ 2× or M6 is dropped (§6 S1)',
        // a pending or unavailable arm is neither pass nor fail: it is a gate S1 still has to close
        pass: m.gate === 'pass' ? true : m.gate === 'FAIL' ? false : null,
      });
    }
    if (parsed.sandboxSpawn) rows.push({ name: 'probe sandbox-spawn', result: `wrapper ${ms(parsed.sandboxSpawn.wrapperMs)}`, gate: 'report only, never a gate (§5)', pass: null });
  } catch {
    rows.push({ name: 'step-overhead', result: 'no result', gate: `< ${HARNESS_GATE_MS} ms`, pass: false });
  }
  rows.push({ name: 'promptBuildMs p95', result: 'not recorded', gate: `< ${PROMPT_BUILD_GATE_MS} ms`, pass: null });

  const lint = run(process.execPath, ['scripts/jev-contract.mjs', '.']);
  rows.push({ name: 'jev-contract (§1.2 four clauses)', result: lint.out.trim().split('\n').at(-1) ?? '', gate: 'exit 0', pass: lint.code === 0 });

  const units = run(join(ROOT, 'node_modules', '.bin', 'vitest'), ['run', '--project', 'unit', 'test/unit/perf', 'test/unit/jev', 'test/unit/workspace', 'test/unit/scripts']);
  const tail = units.out.split('\n').filter((l) => /^\s*Tests\s+\d/.test(l)).at(-1) ?? (units.code === 0 ? 'ok' : 'failed');
  rows.push({ name: 'S0 unit micro-gates', result: tail.trim().replace(/\s+/g, ' '), gate: 'exit 0', pass: units.code === 0 });

  return rows;
}

// ---------------------------------------------------------------------------------------
// Ring 1 — free: the `--jev off` gate (§1.2 last paragraph)
// ---------------------------------------------------------------------------------------

/**
 * §1.2's continuously-tested property is a COMPARISON — "`--jev off` must still complete all five Ring-2 tasks,
 * only slower" — and it has to be gated as one.
 *
 * The first cut of this gate counted records whose `stopReason` was neither `error` nor `not_run` and called that
 * "finished". It is a false green, and measurably so: on the mocked arms 4 of 5 tasks solve with Jev on and 1 of 5
 * with `JEVCODE_JEV=off`, yet all ten runs "finish" — the four that stopped solving stop with `max_replans`, which
 * is not an error, and they stop **faster** than the runs that solved them (≈ 1.4 s against the Jev-on wall),
 * because replanning straight into the cap is the cheapest way to end a run. A gate that reads an early
 * `max_replans` as completion cannot fail, which makes the one operationalisation of the safety principle in this
 * wave unfalsifiable.
 *
 * So both arms are run and compared per task: every task the Jev-on arm **passes**, the Jev-off arm must pass too.
 * `pass` is the record's own field (the task's verifier), never a stop reason. "Only slower" is reported beside it,
 * and the false-green signature — Jev-off ended sooner *and* did not solve the task — is named explicitly.
 *
 * Mocked, offline, $0. The mock provider cannot solve every task, which is why the gate is relative to the Jev-on
 * arm of the same run rather than to 5/5: what must not happen is Jev-off losing a task Jev-on solves. Ring 1
 * proper (recorded replays of the 28 head-to-head run dirs, §3 M15) is the stronger corpus and lands with
 * `src/loop/replay.ts`.
 *
 * **Measured 2026-09-22, and the gate is RED.** quixbugs: Jev on 1/3 → off 0/3 (`gcd` lost). ladder: on 2/2 →
 * off 1/2 (`units` lost). Both losses carry the false-green signature — the Jev-off run ended *sooner* than the
 * Jev-on run that solved the task. The cause is one place, and it is a clause-3 failure, not a slow fallback: with
 * every Choice escaped and every Noul inert, the localiser returns **no site at all**
 * (`GoalSearchTrace.sitesConsidered: 0`, `outcome: 'exhausted'`, the step parks with "no site located for …"), so
 * the sieve has nothing to enumerate and the run replans into the cap with `candidatesTested: 0`. The allow-list
 * row for `src/synth/localize/index.ts` claims "ranking only, code order is the fallback"; the measurement says
 * the code order is not taken when Jev has no opinion — the candidate list is dropped instead. Closing this is the
 * localiser's own change (fall through to the SBFL/code ranking when no option clears its bar) and it belongs with
 * the wave that gives every site a named, tested fallback (§1.2 clause 3, waves S1/S4), not with S0's
 * instrumentation. S0's job here was to make the property falsifiable; it now falsifies.
 */
interface ArmRecords {
  byTask: Map<string, RawRecord>;
  code: number;
}

function jevArm(suite: 'quixbugs' | 'ladder', ids: readonly string[], jevOff: boolean): ArmRecords {
  const dir = mkdtempSync(join(tmpdir(), `fastlane-jev${jevOff ? 'off' : 'on'}-${suite}-`));
  const r = run(
    process.execPath,
    [BIN, 'bench', '--suite', suite, '--task-id', ids.join(','), '--conditions', 'llm-jev', '--concurrency', String(flags.concurrency), '--out', dir],
    // explicit both ways: the on-arm must not inherit a JEVCODE_JEV from the shell
    { JEVCODE_JEV: jevOff ? 'off' : null },
  );
  return { byTask: new Map(readRecords(dir).map((rec) => [rec.task, rec])), code: r.code };
}

function ring1(): GateRow[] {
  const rows: GateRow[] = [];
  console.log('\nRing 1 — the `--jev off` safety gate, paired against the same tasks with Jev on (no network, no API)\n');
  for (const suite of ['quixbugs', 'ladder'] as const) {
    const ids = TASKS.filter((t) => t.suite === suite).map((t) => t.id);
    const on = jevArm(suite, ids, false);
    const off = jevArm(suite, ids, true);

    const solvedOn = ids.filter((id) => on.byTask.get(id)?.pass === true);
    const solvedOff = ids.filter((id) => off.byTask.get(id)?.pass === true);
    const lost = solvedOn.filter((id) => off.byTask.get(id)?.pass !== true);
    const missing = ids.filter((id) => !off.byTask.has(id));
    const errored = ids.filter((id) => off.byTask.get(id)?.stopReason === 'error');

    // a Jev-on arm that solved nothing cannot be lost from: the comparison is vacuous and must not read `pass`
    // (the mock provider does not solve every task, and a loaded machine loses more of them to deadlines)
    const vacuous = solvedOn.length === 0;
    rows.push({
      name: `--jev off keeps what Jev solves, ${suite}`,
      result: `Jev on ${solvedOn.length}/${ids.length} pass → off ${solvedOff.length}/${ids.length}${lost.length > 0 ? `; lost ${lost.join(', ')}` : ''}${vacuous ? ' (vacuous: the Jev-on arm solved nothing)' : ''}`,
      gate: 'every task Jev-on solves, Jev-off solves',
      pass: vacuous && missing.length === 0 && errored.length === 0 ? null : lost.length === 0 && missing.length === 0 && errored.length === 0,
    });
    if (missing.length > 0) rows.push({ name: `  no record, ${suite}`, result: missing.join(', '), gate: 'every task produces a record', pass: false });
    if (errored.length > 0) rows.push({ name: `  stopReason error, ${suite}`, result: errored.join(', '), gate: 'the degraded path finishes, it does not crash', pass: false });

    // "only slower": the wall of the tasks both arms solved, and the false-green signature named on its own row
    const both = solvedOn.filter((id) => solvedOff.includes(id));
    const ratio = both.length === 0 ? null : both.reduce((acc, id) => acc + (off.byTask.get(id)!.wallMs || 0), 0) / Math.max(1, both.reduce((acc, id) => acc + (on.byTask.get(id)!.wallMs || 0), 0));
    rows.push({
      name: `  only slower, ${suite}`,
      result: ratio === null ? 'no task solved by both arms' : `${ratio.toFixed(2)}× the Jev-on wall over ${both.length} task(s)`,
      gate: 'report (a router fallback costs wall, never correctness)',
      pass: null,
    });
    const falseGreen = lost.filter((id) => (off.byTask.get(id)?.wallMs ?? Infinity) < (on.byTask.get(id)?.wallMs ?? 0));
    if (falseGreen.length > 0) {
      rows.push({ name: `  faster AND unsolved, ${suite}`, result: falseGreen.join(', '), gate: 'the false-green signature: replanned into the cap', pass: false });
    }
    if (on.code !== 0 || off.code !== 0) rows.push({ name: `  bench exit, ${suite}`, result: `on ${on.code}, off ${off.code}`, gate: 'report (a failing task is a non-zero exit)', pass: null });
  }
  rows.push({ name: 'replay of the 28 head-to-head run dirs', result: 'not landed', gate: 'src/loop/replay.ts + `inspect --replay` (needs src/cli/**)', pass: null });
  return rows;
}

// ---------------------------------------------------------------------------------------
// Ring 2 — the tiny live tasks
// ---------------------------------------------------------------------------------------

function ring2(verdicts: Map<string, Verdict>): ReturnType<typeof rowsFrom> {
  console.log(`\nRing 2 — the tiny live tasks (${flags.live ? 'LIVE' : 'mocked: pass --live for the real numbers'})\n`);
  const rows: ReturnType<typeof rowsFrom> = [];
  const wanted = flags.canary ? [...TASKS, CANARY] : TASKS;
  for (const suite of ['quixbugs', 'ladder', 'swebench'] as const) {
    const ids = wanted.filter((t) => t.suite === suite).map((t) => t.id);
    if (ids.length === 0) continue;
    const dir = mkdtempSync(join(tmpdir(), `fastlane-ring2-${suite}-`));
    const args = [BIN, 'bench', '--suite', suite, '--task-id', ids.join(','), '--conditions', 'llm-jev', '--concurrency', String(flags.concurrency), '--out', dir];
    if (flags.live) args.push('--live', '--spend-cap', String(flags.spendCap));
    const r = run(process.execPath, args, { JEVCODE_JEV: null });
    if (r.code !== 0) console.log(`  bench ${suite} exited ${r.code}\n${r.out.split('\n').slice(-12).join('\n')}`);
    rows.push(...rowsFrom(readRecords(dir), verdicts));
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
  ok &&= printQuickTable(ring2(verdicts), [...TASKS, CANARY]);
  console.log('\n  pending Ring-2 tasks:');
  for (const t of PENDING_TASKS) console.log(`    ${t.id.padEnd(16)} ${t.why}`);
}
console.log('\n  pending Ring-0 probes:');
for (const t of PENDING_PROBES) console.log(`    ${t.id.padEnd(16)} ${t.why}`);
console.log('\n  deferred by wave S0 (§6 S0 names it; this tree does not have it):');
for (const d of DEFERRED) console.log(`    ${d.what}\n      ${d.why}`);
console.log(`\nquick: ${ok ? 'all gates met' : 'a gate failed'} (git ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()})`);
process.exit(ok ? 0 : 1);
