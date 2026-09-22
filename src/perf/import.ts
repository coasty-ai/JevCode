/**
 * `jevcode import` perf rows (docs/IMPORT-DESIGN.md §7.6 row 46, §8.5, §1 properties 14–15):
 * discover p95 ≤ 1 500 ms on the author's real shape, the plan phase p95 ≤ 400 ms at
 * `scale(2000)` **[G1.6]**, and the wizard probe p95 ≤ 50 ms. The first frame is unaffected (F1)
 * because the probe runs after it.
 *
 * Both corpora are *generated*, never committed (§8.1): `realshape()` is 12 project slugs,
 * 43 topic files + 4 indexes, 3 fake worktrees, 3 371 zero-byte `.jsonl` placeholders and one
 * sparse 151 MB file — the author's measured shape (2.7 GB of transcripts) without committing
 * 2.7 GB. `scale(n)` is n memory files with controlled Jaccard overlap, n/10 rules, n/20 commands.
 *
 * NOT WIRED INTO `src/perf/main.ts`. Adding a `ProbeName` means editing `readme.ts` and the
 * README's Performance section, which the TUI session owns (§7). This module follows the
 * `jev-latency.ts` convention instead — a standalone `measureImport()` the owner of `main.ts`
 * adds in one line when the import command lands.
 */
import { mkdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { percentile } from '../core/time.js';
import { buildPlan } from '../import/plan.js';
import type { PlanCandidate } from '../import/plan.js';
import { classifyFile } from '../import/classify.js';
import { parseMarkdown } from '../import/parse/markdown.js';
import { discover, nodeImportFs, probeImport, systemClock } from '../import/discover.js';
import { SOURCES } from '../import/sources.js';
import { IMPORT_LIMITS } from '../core/limits.js';
import type { ImportEnvironment, SourceItem } from '../import/types.js';

/** §8.5: the three budgets. Exceeding one fails the gate; the measurements themselves are reported either way. */
export const IMPORT_PERF_BUDGETS = {
  discoverP95Ms: 1_500,
  planP95Ms: 400,
  probeP95Ms: 50,
} as const;

export interface ImportPerfRow {
  name: 'discover' | 'plan' | 'probe';
  raw: number[];
  p50: number | null;
  p95: number | null;
  budgetMs: number;
  ok: boolean;
}

export interface ImportPerfResult {
  rows: ImportPerfRow[];
  /** the shapes actually generated, so a short run is readable */
  shape: { slugs: number; topics: number; transcripts: number; worktrees: number; planRows: number };
  ok: boolean;
}

function row(name: ImportPerfRow['name'], raw: number[], budgetMs: number): ImportPerfRow {
  const p95 = percentile(raw, 95);
  return { name, raw, p50: percentile(raw, 50), p95, budgetMs, ok: p95 !== null && p95 <= budgetMs };
}

// ---------------------------------------------------------------------------------------
// Corpus generators (§8.1) — generated at run time, never committed
// ---------------------------------------------------------------------------------------

export interface RealShapeOptions {
  slugs?: number;
  topicsPerSlug?: number;
  transcripts?: number;
  worktrees?: number;
  /** a sparse file of this size stands in for the real 151 MB transcript; it is never read */
  largestTranscriptBytes?: number;
}

export interface GeneratedCorpus {
  /** the fake `$HOME` */
  home: string;
  /** the fake workspace (a git-root-shaped directory) */
  workspace: string;
  cleanup(): void;
  counts: { slugs: number; topics: number; transcripts: number; worktrees: number };
}

function topicBody(name: string, i: number): string {
  return [
    '---',
    `name: ${name}`,
    `description: generated fixture note ${i}`,
    'metadata:',
    '  type: project',
    '---',
    `# ${name}`,
    '',
    `Line about src/loop/step-${i % 17}.ts and the ${i % 7} case it covers.`,
    'Shared sentence that every note repeats so the Jaccard pass has real work to do.',
    `Unique tail ${i} ${'word '.repeat(8 + (i % 12))}`,
    '',
  ].join('\n');
}

/**
 * §8.1 `realshape()`: the author's measured `~/.claude` shape. The transcripts are zero-byte
 * placeholders plus one sparse file, so the corpus costs kilobytes on disk and still exercises
 * the `walkEntries` cap and the `skip:transcript` default.
 */
export function realshape(opts: RealShapeOptions = {}): GeneratedCorpus {
  const slugs = opts.slugs ?? 12;
  const topicsPerSlug = opts.topicsPerSlug ?? 4;
  const transcripts = opts.transcripts ?? 3_371;
  const worktrees = opts.worktrees ?? 3;
  const root = mkdtempSync(join(tmpdir(), 'jev-import-perf-'));
  const home = join(root, 'home');
  const workspace = join(root, 'ws');
  let topics = 0;

  for (let s = 0; s < slugs; s++) {
    const slug = join(home, '.claude', 'projects', `-Users-x-p${s}`);
    mkdirSync(join(slug, 'memory'), { recursive: true });
    writeFileSync(join(slug, 'memory', 'MEMORY.md'), '<!-- jevcode:memory-index v1 -->\n# Memory\n\n');
    for (let t = 0; t < topicsPerSlug; t++) {
      writeFileSync(join(slug, 'memory', `note-${t}.md`), topicBody(`note-${s}-${t}`, s * topicsPerSlug + t));
      topics++;
    }
    for (let i = 0; i < Math.ceil(transcripts / slugs); i++) writeFileSync(join(slug, `session-${i}.jsonl`), '');
  }
  // the 151 MB file, sparse: it must be seen by `stat` and never opened
  const big = join(home, '.claude', 'projects', '-Users-x-p0', 'session-big.jsonl');
  writeFileSync(big, '');
  truncateSync(big, opts.largestTranscriptBytes ?? 151 * 1024 * 1024);

  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.a]\ncommand = "npx"\n');

  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'AGENTS.md'), '# Agents\n\nBe terse.\n');
  // §6 row 6: the exclusion is load-bearing, so the corpus must contain worktrees to exclude
  for (let w = 0; w < worktrees; w++) {
    const wt = join(workspace, '.claude', 'worktrees', `wt-${w}`, 'docs');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '..', 'AGENTS.md'), '# Agents\n\nBe terse.\n');
    for (let i = 0; i < 40; i++) writeFileSync(join(wt, `d${i}.md`), '# doc\n');
  }

  return {
    home,
    workspace,
    counts: { slugs, topics, transcripts, worktrees },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** §8.1 `scale(n)`: n memory files with controlled Jaccard overlap, n/10 rules, n/20 commands — in memory. */
export function scale(n: number): readonly PlanCandidate[] {
  const out: PlanCandidate[] = [];
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const text = topicBody(`note-${i}`, i);
    const doc = parseMarkdown(text);
    const item: SourceItem = {
      id: `id${String(i).padStart(9, '0')}`,
      realpath: `/home/.claude/projects/-p/memory/note-${i}.md`,
      display: `~/.claude/projects/-p/memory/note-${i}.md`,
      tools: ['claude-code'],
      artefact: 'claude.auto-memory.topic',
      format: 'md',
      scope: 'user',
      bytes: text.length,
      sha256: doc.normalisedSha256,
      mtime: new Date(now - i * 1000).toISOString(),
      parse: { ok: true, lines: doc.lines, fences: doc.fences, headings: doc.headings },
      notices: [],
    };
    out.push({ item, verdict: classifyFile({ item, doc, frontmatter: doc.frontmatter }), doc });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// The three rows
// ---------------------------------------------------------------------------------------

export interface MeasureImportOptions {
  /** repetitions per row; the perf harness uses 20, the unit test 2 */
  reps?: number;
  /** plan-phase corpus size; the gate uses 2 000 */
  planRows?: number;
  realShape?: RealShapeOptions;
}

/** §7.6 row 46: discover p95, plan-phase p95 **[G1.6]**, probe p95. Never touches the network. */
export async function measureImport(opts: MeasureImportOptions = {}): Promise<ImportPerfResult> {
  const reps = opts.reps ?? 20;
  const planRows = opts.planRows ?? 2_000;
  const corpus = realshape(opts.realShape ?? {});
  const fs = nodeImportFs();
  const clock = systemClock();
  const env: ImportEnvironment = {
    home: corpus.home,
    env: {},
    platform: process.platform,
    workspace: corpus.workspace,
    gitRoot: corpus.workspace,
    extraRoots: [],
  };
  const discoverRaw: number[] = [];
  const probeRaw: number[] = [];
  const planRaw: number[] = [];
  try {
    for (let i = 0; i < reps; i++) {
      const t0 = clock.monotonicMs();
      await discover({ env, fs, clock, sources: SOURCES, limits: IMPORT_LIMITS });
      discoverRaw.push(clock.monotonicMs() - t0);

      const t1 = clock.monotonicMs();
      await probeImport({ env, fs, clock, sources: SOURCES, limits: IMPORT_LIMITS, deadlineMs: IMPORT_PERF_BUDGETS.probeP95Ms });
      probeRaw.push(clock.monotonicMs() - t1);
    }
    const candidates = scale(planRows);
    for (let i = 0; i < reps; i++) {
      const t2 = clock.monotonicMs();
      buildPlan({
        candidates,
        importId: 'imp_20260921T120000Z_a1b2c3',
        at: '2026-09-21T12:00:00.000Z',
        jevcodeVersion: '0.0.0',
        workspace: corpus.workspace,
        workspaceKey: corpus.workspace,
        gitRoot: corpus.workspace,
        trust: 'trust',
        roots: [],
      });
      planRaw.push(clock.monotonicMs() - t2);
    }
  } finally {
    corpus.cleanup();
  }

  const rows = [
    row('discover', discoverRaw, IMPORT_PERF_BUDGETS.discoverP95Ms),
    row('plan', planRaw, IMPORT_PERF_BUDGETS.planP95Ms),
    row('probe', probeRaw, IMPORT_PERF_BUDGETS.probeP95Ms),
  ];
  return {
    rows,
    shape: { ...corpus.counts, planRows },
    ok: rows.every((r) => r.ok),
  };
}
