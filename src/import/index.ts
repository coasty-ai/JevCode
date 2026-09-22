/**
 * The import engine's single entry point (docs/IMPORT-DESIGN.md §4.1) — the only module the CLI
 * and the TUI session import. `src/import/**` is a pure-plus-read-only module that turns the
 * filesystem into an `ImportPlan` and renders it; **it performs no writes**. Every write goes
 * through the seams the caller supplies (`ImportWriteFs`), so the whole engine lands without
 * touching a file the TUI session owns (§0, the one-sentence contract).
 *
 * `planImport()` runs phases 1–3 — discover → classify → plan — and writes nothing at all.
 * `applyPlan()` / `resumeImport()` / `undoImport()` (re-exported from `apply.ts`) run phase 4
 * over the injected write seam, and only for the rows the human approved.
 */
import { isAbsolute, join } from 'node:path';

import { IMPORT_LIMITS } from '../core/limits.js';
import { sha256Hex } from '../core/hash.js';
import { patternRedact } from '../core/redact.js';
import type { Answer, Decider, Json } from '../core/types.js';

import { classifyConfig, classifyFile, walkLeaves } from './classify.js';
import type { FileVerdict, KeyVerdict } from './classify.js';
import { discover, nodeImportFs, probeImport, readSource, systemClock } from './discover.js';
import type { DiscoverOptions } from './discover.js';
import { parseFrontmatter } from './parse/frontmatter.js';
import { parseJsonc } from './parse/jsonc.js';
import { parseMarkdown } from './parse/markdown.js';
import { parseMdc } from './parse/mdc.js';
import { parseToml } from './parse/toml.js';
import { findMarkerBlocks, joinDestination } from './apply.js';
import { buildPlan } from './plan.js';
import type { PlanCandidate, PlanInput } from './plan.js';
import { askImport, fileKindQuestions, mergeBatches, secretQuestions } from './questions.js';
import type { FileCandidate, JevSample, SecretCandidate } from './questions.js';
import { SOURCES, allRoots, specById } from './sources.js';
import type {
  CannotRead,
  ConfigLeaf,
  Frontmatter,
  ImportClock,
  ImportEnvironment,
  ImportFs,
  ImportManifest,
  ImportPlan,
  ImportProbe,
  MarkdownDoc,
  PlanRow,
  PlanRoot,
  SourceItem,
} from './types.js';

// ---------------------------------------------------------------------------------------
// Re-exports — the whole engine surface, so a caller imports one module (§4.1)
// ---------------------------------------------------------------------------------------

export { IMPORT_LIMITS } from '../core/limits.js';
export type { ImportLimits } from '../core/limits.js';

export * from './types.js';

export { ALWAYS_EXCLUDED, OPT_IN_SOURCES, SOURCES, SOURCE_TOOLS, allRoots, rootFor, specById } from './sources.js';
export { discover, nodeImportFs, probeImport, readSource, slugToPath, systemClock } from './discover.js';
export type { DiscoverOptions, DiscoverResult } from './discover.js';

export { fmBool, fmList, fmString, kindOf, parseFrontmatter } from './parse/frontmatter.js';
export {
  fenceExecutables,
  jaccard,
  looksBinary,
  minhashBands,
  normaliseText,
  parseMarkdown,
  resolveImports,
  stripBlockHtmlComments,
} from './parse/markdown.js';
export { mdcTrigger, parseMdc } from './parse/mdc.js';
export { parseJsonc, stripJsonComments } from './parse/jsonc.js';
export { parseToml } from './parse/toml.js';
export { parseJsonl, transcriptMeta } from './parse/jsonl.js';
export type { TranscriptMeta } from './parse/jsonl.js';
export { isSqliteFile, parseSqlite } from './parse/sqlite.js';

export { FILE_BAND, NON_SECRET_LEAF_NAMES, classifyConfig, classifyFile, classifyKey, formatOf, walkLeaves } from './classify.js';
export type { FileInput, FileVerdict, KeyVerdict } from './classify.js';
export {
  EXEC_PATHS,
  KNOWN_SECRET_PATHS,
  MCP_PATHS,
  PERMISSION_PATHS,
  charsetOf,
  classifyValue,
  entropyBits,
  isEnvReference,
  joinSecretVerdict,
  referenceName,
  shapeOf,
} from './secrets.js';
export type { SecretDecision } from './secrets.js';

export {
  askImport,
  contradictsQuestions,
  fileKindQuestions,
  mattersHereQuestions,
  mergeBatches,
  resolveChoice,
  resolveNoul,
  resolveScore,
  sameMeaningQuestions,
  secretQuestions,
} from './questions.js';
export type {
  AskDeps,
  ConflictCandidate,
  FileCandidate,
  JevOutcome,
  JevSample,
  NoteCandidate,
  PairCandidate,
  QuestionBatch,
  SecretCandidate,
} from './questions.js';

export { buildPlan, dedupe, expandGlobs, rankIndex, rerunAction, slugOf } from './plan.js';
export type { PlanCandidate, PlanInput } from './plan.js';

export { REPORT_SECTIONS, parseReport, renderPlanJson, renderReport } from './report.js';
export type { ReportView } from './report.js';

export {
  APPLY_ORDER,
  applyPlan,
  confineDestination,
  findMarkerBlocks,
  markerClose,
  markerOpen,
  reconstructs,
  releaseLock,
  replaceMarkerInterior,
  resumeImport,
  retentionVictims,
  takeLock,
  undoImport,
} from './apply.js';
export type { AppliedRow, ApplyOptions, ApplyResult, LockInfo, UndoOptions, UndoResult } from './apply.js';

export { mergeMcpFile, normaliseMcp, normaliseReference, parseMcpFile, renderBackTo, renderMcpFile } from './mcp.js';
export type { McpDialect, NormaliseInput, NormaliseResult } from './mcp.js';

export { createRuleMatcher, globMatch, matchRules } from './rules.js';
export type { MatchOptions } from './rules.js';

// ---------------------------------------------------------------------------------------
// The import id (§0 notation)
// ---------------------------------------------------------------------------------------

/** `imp_<ISO compact>_<6 hex>`, e.g. `imp_20260921T120000Z_a1b2c3`. Pure given `now` and `seed`. */
export function newImportId(now: Date, seed?: string): string {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const hex = sha256Hex(seed ?? `${now.getTime()}:${Math.random()}`).slice(0, 6);
  return `imp_${iso}_${hex}`;
}

/** True for a well-formed import id; the CLI validates `--undo`/`--resume` arguments with it. */
export function isImportId(value: string): boolean {
  return /^imp_\d{8}T\d{6}Z_[0-9a-f]{6}$/.test(value);
}

// ---------------------------------------------------------------------------------------
// planImport — phases 1–3 (§4.1). Writes nothing.
// ---------------------------------------------------------------------------------------

export interface PlanImportOptions {
  env: ImportEnvironment;
  fs?: ImportFs;
  clock?: ImportClock;
  jevcodeVersion: string;
  trust: 'trust' | 'session' | 'none';
  /** default: derived from the clock */
  importId?: string;
  /** null, or `--no-jev` / `--mock`, disables every group; the code fallbacks still produce a complete plan (§4.9) */
  decider?: Decider | null;
  jevSample?: JevSample;
  jevMaxUsd?: number;
  /** `--source <id>` values; the transcript pass is off unless one names it (§4.2.6) */
  optIn?: readonly string[];
  manifest?: ImportManifest | null;
  /** destination path → its current state, for the re-run matrix (§4.7.5); absent key = destination absent */
  destState?: Readonly<Record<string, { sha256: string; markers: readonly string[] } | null>>;
  /** absolute destination paths, so a source that IS a destination is `skip:self` (§4.4.1 rule 2) */
  destinations?: readonly string[];
  respectGitignore?: boolean;
  scope?: 'user' | 'project' | 'both';
  all?: boolean;
  /** scope → destination root; defaults to the workspace and `${XDG_CONFIG_HOME:-~/.config}/jevcode` */
  destRoots?: DestRoots;
  /** false when the repo is read-only or there is no git root (§6 rows 83–84) */
  projectWritable?: boolean;
  /** applied to every heading and every sentence fragment before it can reach Jev or an artefact (§2.9) */
  redact?: (s: string) => string;
  cannotRead?: readonly CannotRead[];
  signal?: AbortSignal;
}

/** What one discovered item parsed into, before classification. */
interface Parsed {
  doc: MarkdownDoc | null;
  frontmatter: Frontmatter | null;
  leaves: readonly ConfigLeaf[];
  warnings: readonly string[];
}

const EMPTY_PARSED: Parsed = { doc: null, frontmatter: null, leaves: [], warnings: [] };

/** §4.2.4 + §4.3: read and parse one item by format. Total — a failure is a warning, never a throw. */
async function parseItem(item: SourceItem, fs: ImportFs, redact: (s: string) => string): Promise<Parsed> {
  const read = await readSource(item, fs, IMPORT_LIMITS);
  if (!read.ok) return { ...EMPTY_PARSED, warnings: [read.error] };
  const text = read.text;
  switch (item.format) {
    case 'md':
    case 'text': {
      const fm = parseFrontmatter(text);
      return {
        doc: parseMarkdown(text, { redact, headingLimit: IMPORT_LIMITS.jevHeadings, headingCells: IMPORT_LIMITS.jevHeadingCells }),
        frontmatter: fm.ok ? fm.value : null,
        leaves: [],
        warnings: fm.warnings,
      };
    }
    case 'mdc': {
      const r = parseMdc(text);
      if (!r.ok) return { ...EMPTY_PARSED, warnings: [r.error, ...r.warnings] };
      return { doc: r.value.doc, frontmatter: r.value.frontmatter, leaves: [], warnings: r.warnings };
    }
    case 'json':
    case 'jsonc': {
      const r = parseJsonc(text);
      if (!r.ok) return { ...EMPTY_PARSED, warnings: [r.error, ...r.warnings] };
      return { doc: null, frontmatter: null, leaves: walkLeaves(r.value), warnings: r.warnings };
    }
    case 'toml': {
      const r = parseToml(text);
      if (!r.ok) return { ...EMPTY_PARSED, warnings: [r.error, ...r.warnings] };
      return { doc: null, frontmatter: null, leaves: r.value, warnings: r.warnings };
    }
    default:
      // yaml, jsonl, sqlite, js, sh: the atlas class already routes these to a named skip (§4.4.1 rules 5–6)
      return EMPTY_PARSED;
  }
}

/** §4.4.3 group I state — shapes only, so a candidate can never carry a value byte. */
function secretCandidatesOf(item: SourceItem, keys: readonly KeyVerdict[]): readonly SecretCandidate[] {
  const out: SecretCandidate[] = [];
  for (const k of keys) {
    if (!k.band || k.shape === null) continue;
    out.push({
      id: `${item.id}:${k.leaf.dotted}`,
      dotted: k.leaf.dotted,
      leaf: k.leaf.path[k.leaf.path.length - 1] ?? k.leaf.dotted,
      path: item.display,
      shape: k.shape,
      fileClass: item.format,
    });
  }
  return out;
}

/** §4.4.3 group II state — paths, counts, frontmatter *keys* and redacted headings. Never a body. */
function fileCandidateOf(item: SourceItem, doc: MarkdownDoc | null): FileCandidate {
  return {
    id: item.id,
    path: item.display,
    bytes: item.bytes,
    lines: doc?.lines ?? item.parse.lines ?? 0,
    fences: doc?.fences ?? item.parse.fences ?? 0,
    frontmatterKeys: doc?.frontmatter?.keys ?? item.parse.frontmatterKeys ?? [],
    headings: doc?.headings ?? item.parse.headings ?? [],
  };
}

/**
 * §4.1 phases 1–3: discover → read → map → classify → (Jev, inside the declared bands) → plan.
 * Writes nothing outside the caller's artefact directory — this function writes nothing at all;
 * it returns the plan and the caller persists it (§1 property 1).
 */
export async function planImport(opts: PlanImportOptions): Promise<ImportPlan> {
  const fs = opts.fs ?? nodeImportFs();
  const clock = opts.clock ?? systemClock();
  const redact = opts.redact ?? patternRedact;
  const now = clock.now();
  const importId = opts.importId ?? newImportId(now, opts.env.workspace);

  const discoverOpts: DiscoverOptions = {
    env: opts.env,
    fs,
    clock,
    sources: SOURCES,
    ...(opts.optIn !== undefined ? { optIn: opts.optIn } : {}),
    ...(opts.respectGitignore !== undefined ? { respectGitignore: opts.respectGitignore } : {}),
    ...(opts.all !== undefined ? { all: opts.all } : {}),
    ...(opts.destinations !== undefined ? { destinations: opts.destinations } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    limits: IMPORT_LIMITS,
  };
  const found = await discover(discoverOpts);

  // ----- map + classify (§4.3, §4.4) -----
  const candidates: PlanCandidate[] = [];
  const secretCands: SecretCandidate[] = [];
  const fileCands: FileCandidate[] = [];
  const notices: string[] = [...found.notices];

  for (const item of found.items) {
    const parsed = await parseItem(item, fs, redact);
    const keys: readonly KeyVerdict[] = parsed.leaves.length > 0 ? classifyConfig(parsed.leaves) : [];
    // §4.4.1 rule 1 is "the atlas row declares a class and the parse succeeded", so the spec that
    // produced this item MUST reach the classifier — without it every atlas row falls through to
    // rule 12 (`skip:unrelated`) and the whole plan is empty.
    const spec = specById(item.artefact);
    const verdict: FileVerdict = classifyFile({
      item,
      ...(spec !== undefined ? { spec } : {}),
      doc: parsed.doc ?? undefined,
      frontmatter: parsed.frontmatter,
      isDestination: (opts.destinations ?? []).includes(item.realpath),
    });
    candidates.push({
      item,
      verdict,
      // Review defect 1: without this the atlas's own routing is discarded and `plan.ts` falls
      // back to the class map, so `agents-append`, `memory-index`, `memory-local` and
      // `report-only` are dead end to end — a repo `CLAUDE.md` lands in `.jevcode/memory/` and
      // the marker/append path, `MEMORY.md` and the [G1.5] trust re-pin are never exercised.
      // The atlas is the only place a tool's knowledge lives (§3.1); it must win.
      ...(spec !== undefined ? { destination: spec.destination } : {}),
      ...(parsed.doc !== null ? { doc: parsed.doc } : {}),
      ...(parsed.frontmatter !== null ? { frontmatter: parsed.frontmatter } : {}),
      ...(keys.length > 0 ? { keys } : {}),
    });
    for (const w of parsed.warnings) notices.push(`${item.display}: ${w}`);
    secretCands.push(...secretCandidatesOf(item, keys));
    if (verdict.band) fileCands.push(fileCandidateOf(item, parsed.doc));
  }

  // ----- ask Jev, inside the declared bands only (§4.4.3) -----
  const sample: JevSample = opts.jevSample ?? 'headings';
  const batches = mergeBatches(
    [
      ...(secretCands.length > 0 ? [secretQuestions(secretCands)] : []),
      ...(fileCands.length > 0 ? [fileKindQuestions(fileCands, sample)] : []),
      // Groups III (same_meaning), IV (matters_here) and V (contradicts) are asked by `buildPlan`'s
      // own passes, which own the Jaccard band, the index budget and the polarity precondition
      // (§4.5). They are not batched here, so the merge stays total over the two band groups.
    ],
    IMPORT_LIMITS.jevQuestions,
  );
  const jev = await askImport(batches, {
    decider: opts.decider ?? null,
    signal: opts.signal ?? new AbortController().signal,
    maxUsd: opts.jevMaxUsd ?? 0.01,
    requests: IMPORT_LIMITS.jevRequests,
  });

  // ----- plan (§4.5, §4.6) -----
  // §4.6.1 [G1.3]: the manifest is keyed by `realpath(gitRoot ?? workspace)`. Without the
  // realpath the key is whatever path the caller happened to pass, so the same clone reached
  // through a symlink (or `/var` vs `/private/var` on macOS) reads as a different workspace and
  // its rows all come back `create` — which is exactly the second-clone case [G1.3] exists for.
  const workspaceRaw = opts.env.gitRoot ?? opts.env.workspace;
  const workspaceKey = await fs.realpath(workspaceRaw).catch(() => workspaceRaw);
  const roots: readonly PlanRoot[] = found.roots.length > 0 ? found.roots.map(planRoot) : allRoots(opts.env).map(planRoot);
  const destRoots = opts.destRoots ?? defaultDestRoots(opts.env);
  const answers: Readonly<Record<string, Answer>> = jev.answers;
  const input: PlanInput = {
    candidates,
    importId,
    at: now.toISOString(),
    jevcodeVersion: opts.jevcodeVersion,
    workspace: opts.env.workspace,
    workspaceKey,
    gitRoot: opts.env.gitRoot,
    trust: opts.trust,
    roots,
    manifest: opts.manifest ?? null,
    ...(opts.destState !== undefined ? { destState: opts.destState } : {}),
    jev: {
      answers,
      requests: jev.requests,
      questions: jev.questions,
      usd: jev.usd,
      fallbacks: jev.fallbacks,
      ...(jev.reason !== undefined ? { reason: jev.reason } : {}),
    },
    ...(opts.cannotRead !== undefined ? { cannotRead: opts.cannotRead } : {}),
    notices,
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
    ...(opts.all !== undefined ? { all: opts.all } : {}),
    ...(opts.projectWritable !== undefined ? { projectWritable: opts.projectWritable } : {}),
  };

  const first = buildPlan(input);
  if (opts.destState !== undefined) return first;
  // §4.7.5: the re-run matrix is evaluated at PLAN time — the report has to be able to say
  // `append`, `update` and `skip:unchanged`, not just `create`. That needs the destinations'
  // current bytes, and nobody but the engine knows what the destinations are until the plan has
  // named them. So: plan once to learn them, stat them (read-only, phase 1-3 writes nothing),
  // and re-plan only when at least one already exists. On a first import nothing exists and the
  // second pass is skipped entirely. Row ids are stable across the two passes because
  // `PlanRow.id` is derived from the source and the destination, never from the action.
  const destState = await probeDestinations(first, destRoots, fs);
  if (destState === null) return first;
  return buildPlan({ ...input, destState });
}

/** The scope→root map a caller gets when it does not supply one; mirrors `ApplyOptions.destRoots`. */
export interface DestRoots {
  project: string;
  projectLocal: string;
  user: string;
}

/**
 * §2.2: workspace files live in the repo, user files under `${XDG_CONFIG_HOME:-~/.config}/jevcode`.
 * A **relative** `XDG_CONFIG_HOME` is ignored per spec (§6 row 4) — the same rule `rootFor` applies
 * to every atlas root, restated here rather than imported, because `src/import/**` may not reach
 * `src/config/credentials.ts` (§7 ownership).
 */
export function defaultDestRoots(env: ImportEnvironment): DestRoots {
  const xdg = env.env['XDG_CONFIG_HOME'];
  const configHome = xdg !== undefined && xdg.length > 0 && isAbsolute(xdg) ? xdg : join(env.home, '.config');
  return { project: env.workspace, projectLocal: env.workspace, user: join(configHome, 'jevcode') };
}

/**
 * Read the current state of every destination the plan names. Returns null when none exists, so
 * the caller can skip the second planning pass. Read-only and total: an unreadable or
 * non-regular destination reads as absent, exactly as the matrix's "destination absent" cell.
 */
async function probeDestinations(
  plan: ImportPlan,
  destRoots: DestRoots,
  fs: ImportFs,
): Promise<Readonly<Record<string, { sha256: string; markers: readonly string[] } | null>> | null> {
  const wanted = new Map<string, PlanRow['scope']>();
  for (const r of plan.rows) if (r.dest !== null && !wanted.has(r.dest)) wanted.set(r.dest, r.scope);
  if (wanted.size === 0) return null;
  const state: Record<string, { sha256: string; markers: readonly string[] } | null> = {};
  let anyExists = false;
  for (const [dest, scope] of wanted) {
    const root = scope === 'user' ? destRoots.user : scope === 'project-local' ? destRoots.projectLocal : destRoots.project;
    const abs = joinDestination(root, dest);
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) {
        state[dest] = null;
        continue;
      }
      const buf = await fs.readFile(abs);
      state[dest] = { sha256: sha256Hex(buf), markers: findMarkerBlocks(buf.toString('utf8')).map((b) => b.importId) };
      anyExists = true;
    } catch {
      state[dest] = null;
    }
  }
  return anyExists ? state : null;
}

function planRoot(r: { tool: PlanRoot['tool']; display: string; via: PlanRoot['via']; env?: string; exists: boolean }): PlanRoot {
  return { display: r.display, tool: r.tool, via: r.via, exists: r.exists, ...(r.env !== undefined ? { env: r.env } : {}) };
}

/** §5.1: the wizard's ≤ 50 ms probe, re-exported at the facade so the host imports one module. */
export async function probe(opts: PlanImportOptions & { deadlineMs?: number }): Promise<ImportProbe> {
  const fs = opts.fs ?? nodeImportFs();
  const clock = opts.clock ?? systemClock();
  return probeImport({
    env: opts.env,
    fs,
    clock,
    sources: SOURCES,
    limits: IMPORT_LIMITS,
    ...(opts.optIn !== undefined ? { optIn: opts.optIn } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    deadlineMs: opts.deadlineMs ?? 50,
  });
}

// ---------------------------------------------------------------------------------------
// Plan summary — the numbers the overlay, the `[import]` items and `--plain` all quote (§5.2, §5.5)
// ---------------------------------------------------------------------------------------

export type PlanGroupKey = 'memory' | 'rules' | 'commands' | 'mcp' | 'config' | 'review' | 'skipped';

/** §5.2: one row of the groups-first overlay. The engine owns the counts; the TUI owns the strings. */
export interface PlanGroup {
  key: PlanGroupKey;
  rows: number;
  bytes: number;
  /** false for `review` and `skipped`: `y` never applies them */
  applicable: boolean;
}

export interface PlanSummary {
  groups: readonly PlanGroup[];
  toImport: number;
  toReview: number;
  skipped: number;
  bytes: number;
  /** §5.5: `0 bytes of secrets copied` is a constant, but the count of credentials found is not */
  credentialsFound: number;
}

const GROUP_ORDER: readonly PlanGroupKey[] = ['memory', 'rules', 'commands', 'mcp', 'config', 'review', 'skipped'];

function groupOf(row: { class: string; action: string }): PlanGroupKey {
  if (row.action === 'review') return 'review';
  if (row.action.startsWith('skip:')) return 'skipped';
  if (row.action === 'suggest') return 'config';
  switch (row.class) {
    case 'memory':
      return 'memory';
    case 'rule':
      return 'rules';
    case 'command':
      return 'commands';
    case 'mcp':
      return 'mcp';
    default:
      return 'config';
  }
}

/**
 * §5.2 / §5.5: the group rows and the three headline counts, derived once so the overlay, the
 * `[import]` items, `--plain` and `--json` can never disagree about them. Pure.
 */
export function summarisePlan(plan: ImportPlan): PlanSummary {
  const byKey = new Map<PlanGroupKey, { rows: number; bytes: number }>();
  for (const key of GROUP_ORDER) byKey.set(key, { rows: 0, bytes: 0 });
  let credentialsFound = 0;
  for (const r of plan.rows) {
    if (r.class === 'secret') credentialsFound++;
    const g = byKey.get(groupOf(r));
    if (g === undefined) continue;
    g.rows++;
    g.bytes += r.bytes;
  }
  const groups = GROUP_ORDER.map((key) => {
    const g = byKey.get(key) ?? { rows: 0, bytes: 0 };
    return { key, rows: g.rows, bytes: g.bytes, applicable: key !== 'review' && key !== 'skipped' };
  });
  const applicable = groups.filter((g) => g.applicable);
  return {
    groups,
    toImport: applicable.reduce((n, g) => n + g.rows, 0),
    toReview: byKey.get('review')?.rows ?? 0,
    skipped: byKey.get('skipped')?.rows ?? 0,
    bytes: applicable.reduce((n, g) => n + g.bytes, 0),
    credentialsFound,
  };
}

/**
 * §4.5 pass 3 / §4.8.2: the row ids `--yes` may apply — never a `review` row (a conflict group's
 * rows are excluded from `--yes` by construction), never a `skip:*` row, never a credential row,
 * and only the requested scope. This is engine policy, not a surface decision, so both the TUI
 * and the plain twin call it rather than re-deriving it.
 */
export function applicableRows(plan: ImportPlan, opts: { scope?: 'user' | 'project' | 'both' } = {}): readonly string[] {
  const scope = opts.scope ?? 'both';
  const out: string[] = [];
  for (const r of plan.rows) {
    if (r.action === 'review' || r.action === 'suggest' || r.action.startsWith('skip:')) continue;
    if (r.class === 'secret') continue;
    if (scope === 'user' && r.scope !== 'user') continue;
    if (scope === 'project' && r.scope === 'user') continue;
    out.push(r.id);
  }
  return out;
}

/** Narrow a JSON value the CLI read back from `plan.json`; returns null when it is not an `ImportPlan`. */
export function asImportPlan(value: Json): ImportPlan | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as { [k: string]: Json };
  if (v['v'] !== 1 || typeof v['importId'] !== 'string' || !Array.isArray(v['rows'])) return null;
  return value as unknown as ImportPlan;
}
