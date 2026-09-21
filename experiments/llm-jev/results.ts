/**
 * Shared loading for the llm-jev measurement scripts (docs/LLM-JEV-DESIGN.md §10.4): results dirs → the latest record per
 * (suite, task, condition) with later dirs winning, the verdicts.md files beside them (one arm's table each: a dir whose
 * records are all one arm, or `verdicts.<arm>.md`), summary.json limits, and the run directories under ~/.jevcode/runs.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { CONDITION_ORDER, isBenchCondition } from '../../src/bench/conditions.ts';
import { readGeneratorRecords, summariseGeneratorRecords } from '../../src/bench/generator-records.ts';
import { parseVerdictsMarkdown, type Verdict, type Verdicts } from '../../src/bench/headtohead.ts';
import { readTasksJsonl, TASKS_FILE } from '../../src/bench/runner.ts';
import type { BenchRecord } from '../../src/bench/types.ts';
import type { BenchCondition, BenchSuite } from '../../src/core/types.ts';

export const DEFAULT_RUNS_DIR = join(homedir(), '.jevcode', 'runs');

export interface LoadedResults {
  dirs: string[];
  /** latest record per (suite, task, condition), later dirs winning */
  records: BenchRecord[];
  verdicts: Map<BenchCondition, Map<string, Verdict>>;
  /** summary.json limits per (suite, condition) when present (maxSteps / maxWallMs / taskSpendCapUsd); key = limitsKey() */
  limits: Map<string, RunLimitsSummary>;
}

export interface RunLimitsSummary {
  maxSteps: number;
  maxWallMs: number;
  taskSpendCapUsd: number;
}

export function limitsKey(suite: BenchSuite, condition: BenchCondition): string {
  return `${suite}\u0000${condition}`;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * `--verdicts <arm>=<file>` entries are applied after the auto-detected files. Records written before the `generator`
 * field existed get it from `<runsDir>/<runId>/generator.jsonl` when the run dir is still there (§10.4: "all from
 * tasks.jsonl + run directories").
 */
export async function loadResults(dirs: readonly string[], explicitVerdicts: readonly string[] = [], runsDir: string = DEFAULT_RUNS_DIR): Promise<LoadedResults> {
  const byKey = new Map<string, BenchRecord>();
  const verdicts = new Map<BenchCondition, Map<string, Verdict>>();
  const limits = new Map<string, RunLimitsSummary>();
  const merge = (arm: BenchCondition, m: Map<string, Verdict>): void => {
    const cur = verdicts.get(arm) ?? new Map<string, Verdict>();
    for (const [k, v] of m) cur.set(k, v);
    verdicts.set(arm, cur);
  };
  for (const dir of dirs) {
    const recs = (await readTasksJsonl(join(dir, TASKS_FILE), (l) => process.stderr.write(`${l}\n`))) as BenchRecord[];
    for (const r of recs) byKey.set(`${r.suite}\u0000${r.task}\u0000${r.condition}`, r);
    const arms = [...new Set(recs.map((r) => r.condition))];
    const suites = [...new Set(recs.map((r) => r.suite))];
    for (const f of readdirSync(dir)) {
      if (f === 'verdicts.md' && arms.length === 1) merge(arms[0]!, parseVerdictsMarkdown(readFileSync(join(dir, f), 'utf8')));
      const m = /^verdicts\.([a-z-]+)\.md$/.exec(f);
      if (m !== null && isBenchCondition(m[1]!)) merge(m[1], parseVerdictsMarkdown(readFileSync(join(dir, f), 'utf8')));
    }
    const summary = readJson(join(dir, 'summary.json'));
    if (summary !== null && typeof summary === 'object' && 'conditions' in summary) {
      const conds = (summary as { conditions: Record<string, { maxSteps?: number; maxWallMs?: number; taskSpendCapUsd?: number }> }).conditions;
      for (const [c, cfg] of Object.entries(conds)) {
        if (!isBenchCondition(c) || typeof cfg.maxSteps !== 'number' || typeof cfg.maxWallMs !== 'number' || typeof cfg.taskSpendCapUsd !== 'number') continue;
        for (const suite of suites) limits.set(limitsKey(suite, c), { maxSteps: cfg.maxSteps, maxWallMs: cfg.maxWallMs, taskSpendCapUsd: cfg.taskSpendCapUsd });
      }
    }
  }
  for (const spec of explicitVerdicts) {
    const eq = spec.indexOf('=');
    const arm = spec.slice(0, eq);
    const file = spec.slice(eq + 1);
    if (eq < 0 || !isBenchCondition(arm)) throw new Error(`--verdicts expects <arm>=<verdicts.md>, got "${spec}"`);
    merge(arm, parseVerdictsMarkdown(readFileSync(file, 'utf8')));
  }
  const records = [...byKey.values()];
  for (const r of records) {
    if (r.generator !== undefined || r.runId === null || r.condition === 'jev-only') continue;
    const rows = await readGeneratorRecords(join(runsDir, r.runId));
    if (rows.length > 0) r.generator = summariseGeneratorRecords(rows);
  }
  return { dirs: dirs.map((d) => basename(d)), records, verdicts, limits };
}

export function armsPresent(records: readonly BenchRecord[]): BenchCondition[] {
  return CONDITION_ORDER.filter((c) => records.some((r) => r.condition === c));
}

export function suitesPresent(records: readonly BenchRecord[]): BenchSuite[] {
  const order: BenchSuite[] = ['quixbugs', 'ladder', 'swebench', 'terminal-bench'];
  return order.filter((s) => records.some((r) => r.suite === s));
}

export function asVerdicts(m: Map<BenchCondition, Map<string, Verdict>>): Verdicts {
  return m;
}

/** Minimal flag parser: `--k v` pairs (repeatable) and positionals. */
export function parseArgs(argv: readonly string[]): { positional: string[]; flags: Map<string, string[]> } {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const value = next !== undefined && !next.startsWith('--') ? next : 'true';
      if (value !== 'true') i++;
      flags.set(key, [...(flags.get(key) ?? []), value]);
    } else positional.push(a);
  }
  return { positional, flags };
}

export function flag(flags: Map<string, string[]>, key: string): string | undefined {
  return flags.get(key)?.at(-1);
}
