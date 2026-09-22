/**
 * `jevcode import` — the CLI twin of the import overlay (TUI-DESIGN-5 §5.5, §5.7, §12.4, §13.3; IMPORT-DESIGN
 * §5.6, §5.7, §4.8.2).
 *
 * Four rules this module keeps:
 *
 *  1. **`src/import/**` is reached through a seam, never a static import** (gate G-R5-1). `ImportIo.engine` is
 *     the facade; when it is absent `loadImportEngine()` does `await import('../import/index.js')` inside a
 *     function body, which the first-frame import-graph assertion passes by construction. Every test injects a
 *     fixture engine instead, so the unit suite is offline and hermetic.
 *  2. **`--yes` never applies a credential row.** It calls `applicableRows` (`src/import/index.ts:687`) and
 *     nothing else — the one place engine policy for "what may be written without a human" lives (§5.5). A
 *     credential in a non-TTY is refused with §4.8.2's sentence, and the exit code is unchanged by it.
 *  3. **Every row string comes from `src/tui/import/lines.ts` / `src/config/imports.ts`** (§13.1) — the same
 *     functions the Ink overlay renders, so `--plain` and the TUI cannot drift. This module declares no
 *     `[import]` text of its own; `lines.test.ts`'s grep covers it as well as `lines.ts`.
 *  4. **The manifest is the CLI's, the writes are the engine's.** After a successful apply this module merges
 *     the entries the seam reports into `<jevcodeDir>/imports/manifest.json` (atomic, 0600), runs the [G1.4]
 *     retention GC and says so; before an undo it reads the manifest and hands it over. `src/config/imports.ts`
 *     is therefore live code, not a library with only a test for a caller.
 *
 * **The phase-4 gap, stated out loud (deviation, §5.3 / IMPORT-DESIGN §7.4 row 29).** `applyPlan`,
 * `resumeImport` and `undoImport` are re-exported by the facade but **cannot be called without an adapter this
 * build does not have**: `ApplyOptions` (`src/import/apply.ts:366`) wants an `ImportWriteFs`, a clock, a lock
 * path, `destRoots`, an `artifactDir`, an `apply.jsonl` and — the load-bearing one — a `render(row, sourceText)`
 * seam that turns a re-read source into destination bytes, which no module outside the import engine implements
 * and no round-5 section specifies. `loadImportEngine` therefore wires the three READ verbs (`isImportId`,
 * `planImport`, `summarisePlan`, `applicableRows`, `asImportPlan`) and leaves the three WRITE verbs absent; a
 * `--yes` / `--resume` / `--undo` that reaches the production loader is refused **before anything is read**,
 * with `importNotWired`'s sentence and exit 2, rather than planning and then failing. A host that has the
 * adapter (the TUI session's `openImport`, or a later wave) passes `ImportIo.engine` and every write path below
 * runs unchanged — that is what the seam is for, and what every test here exercises.
 *
 * Exit codes (§5.6, `src/errors.ts`): `0` a plan or a clean apply · `2` a usage error, a write failure, a held
 * lock or a row demoted by the source re-check [G1.1] · `4` the Jev budget · `130` SIGINT during apply with rows
 * left.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { EXIT_CODES, isAbortError } from '../errors.js';
import type { ImportManifest, ImportManifestEntry, ImportPlan, Json } from '../core/types.js';
import type { PlanSummary } from '../import/index.js';
import { GLYPHS, glyphSet, glyphTwin, type GlyphSet } from '../tui/glyphs.js';
import { IMPORT_NOTHING_FOUND, importGlyphs, importPlainLines, importScreenReaderLines, importSelectionPrompt } from '../tui/import/lines.js';
import {
  IMPORT_LABEL,
  gcImportRecords,
  importAppliedItem,
  importArtifactDir,
  importCancelledItem,
  importInterruptedItem,
  importManifestPath,
  importPlanItem,
  importReportItem,
  importRetentionItem,
  importUndoItem,
  importWriteErrorItem,
  importsRoot,
  mergeManifestEntries,
  readImportManifest,
  writeImportManifest,
} from '../config/imports.js';
import { groupKeyOf, initImportUi, type ImportUiInput } from '../tui/import/reducer.js';

/** §5.5: `--scope user|project|both`, default `both`. */
export const IMPORT_SCOPES = ['user', 'project', 'both'] as const;
export type ImportScope = (typeof IMPORT_SCOPES)[number];

/** §4.8.2: `--yes` from a non-TTY applies M/W/C rows and refuses every credential row, in these words. */
export const IMPORT_CREDENTIALS_NEED_TTY = 'credentials need a terminal — run jevcode import on a tty, or set the variable yourself';
/** §5.7: the pipe / `--no-input` twin is a DRY RUN only; the summary line says so rather than silently not applying. */
export const IMPORT_PIPE_DRY_RUN = 'not a terminal — dry run only; pass --yes to apply the non-credential rows';
/**
 * §5.7: the same statement for a run that IS a terminal. `jevcode import` has no readline yet, so a TTY dry run
 * used to print `Enter selection (1-6):` with nothing to read it and no explanation — the exact case §5.7's pipe
 * sentence exists to prevent, in the one place a human is actually sitting there. Every non-applying run now says
 * what it did and what would apply it; only the *reason* differs between the two sentences.
 */
export const IMPORT_DRY_RUN = 'dry run — nothing was written; pass --yes to apply the non-credential rows';

/**
 * §5.6 / the phase-4 gap in this module's header: a write verb the build cannot perform. Named and exported so
 * `cli/import.test.ts` pins it as an anchor rather than grepping a literal (§13.4), and so the day the adapter
 * lands the sentence is deleted in exactly one place.
 */
export function importNotWired(verb: '--yes' | '--resume' | '--undo'): string {
  return `jevcode import ${verb} is not available in this build: it plans and reports, and the apply seam is not wired yet.`;
}

/** §5.5 / §5.6: the flags `jevcode import` reads. A narrow shape so this module compiles before `args.ts` widens. */
export interface ImportFlags {
  readonly dryRun?: boolean;
  readonly yes?: boolean;
  readonly scope?: string;
  readonly source?: string;
  readonly resume?: string;
  readonly undo?: string;
  readonly json?: boolean;
  /** §5.7 twin 1: force the numbered twin even when the host resolved a screen reader */
  readonly plain?: boolean;
  /** §5.7 twin 2: the spoken twin, whether the host resolved it or the flag asked for it */
  readonly screenReader?: boolean;
  /** §5.7 twin 3: `--ascii`, whether the host resolved it or the flag asked for it */
  readonly ascii?: boolean;
  readonly noInput?: boolean;
}

/**
 * §5.6: the half of `src/import/index.ts` the CLI calls, as a seam. The five READ members are what
 * `loadImportEngine` wires from the facade with no adapter; the three WRITE members are **optional** because
 * phase 4 needs an `ApplyOptions` adapter this build does not have (see the module header) — a host that has one
 * supplies all eight.
 */
export interface ImportEngine {
  isImportId(value: string): boolean;
  planImport(opts: ImportPlanRequest): Promise<ImportPlan>;
  summarisePlan(plan: ImportPlan): PlanSummary;
  applicableRows(plan: ImportPlan, opts?: { scope?: ImportScope }): readonly string[];
  /** §4.7.6: `--resume` re-reads the STORED `plan.json` and hands it back; this is the engine's own narrowing */
  asImportPlan?(value: Json): ImportPlan | null;
  applyPlan?(input: ImportApplyRequest): Promise<ImportApplyOutcome>;
  resumeImport?(input: ImportApplyRequest): Promise<ImportApplyOutcome>;
  undoImport?(input: ImportUndoRequest): Promise<ImportUndoOutcome>;
}

/** What the CLI hands `planImport`; the host fills in the environment and the redactor. */
export interface ImportPlanRequest {
  scope?: ImportScope;
  optIn?: readonly string[];
  [k: string]: unknown;
}

export interface ImportApplyRequest {
  plan?: ImportPlan;
  importId?: string;
  rows?: readonly string[];
  by?: 'tty' | 'flag';
  /** §4.7.5: the manifest this CLI read, so the engine merges rather than re-creating */
  manifest?: ImportManifest | null;
}

export interface ImportUndoRequest {
  importId: string;
  /** §4.7.6: the manifest the undo removes restored destinations from */
  manifest?: ImportManifest | null;
}

export interface ImportApplyOutcome {
  /** rows written */
  applied: number;
  /** rows the source re-check or a write error demoted — any non-zero value is exit 2 [G1.1] */
  failed: number;
  total: number;
  /** the first write failure, if any */
  error?: { path: string; code: string } | null;
  /** SIGINT stopped the apply at a row boundary with rows left (§7 row 59, behaviour 2) */
  interrupted?: boolean;
  importId: string;
  /** §4.7.5: what the apply wrote, as the manifest remembers it — merged and written by THIS module */
  entries?: readonly ImportManifestEntry[];
}

export interface ImportUndoOutcome {
  restored: number;
  /** destinations changed since the import — left alone, never overwritten */
  modified: number;
  importId: string;
  /** §4.7.6: the manifest with the restored destinations removed; written back by THIS module */
  manifest?: ImportManifest | null;
}

export interface ImportIo {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  /** a TTY may be asked for a credential; a pipe may not (§4.8.2) */
  isTTY?: boolean;
  columns?: number;
  ascii?: boolean;
  screenReader?: boolean;
  /** the facade; absent = `await import('../import/index.js')` (gate G-R5-1: a DYNAMIC import, inside a body) */
  engine?: ImportEngine;
  /** what `planImport` needs beyond the flags (env, redactor, destinations) — the caller owns every one */
  planOptions?: ImportPlanRequest;
  /** `~/.jevcode`: where `imports/manifest.json` and `imports/<id>/plan.json` live. Defaults to `~/.jevcode`. */
  jevcodeDir?: string;
  /** [G1.3]: `realpath(gitRoot ?? workspace)` — the manifest is keyed by it; defaults to `process.cwd()` */
  workspaceKey?: string;
  /** `~/.jevcode/imports/<id>/report.md`, for the `[import] report …` item */
  reportPath?: (importId: string) => string;
  /** reads one artefact (`plan.json`); `null` when it is missing. Defaults to `node:fs`. */
  readArtifact?: (path: string) => Promise<string | null>;
}

/** gate G-R5-1: the ONLY reach into `src/import/**`, and it is inside a function body. */
async function loadImportEngine(io: ImportIo): Promise<ImportEngine> {
  if (io.engine !== undefined) return io.engine;
  const m = await import('../import/index.js');
  // The five READ verbs, named exactly as the facade names them. The three WRITE verbs are deliberately absent:
  // `applyPlan`/`resumeImport`/`undoImport` take an `ApplyOptions`/`UndoOptions` this module cannot build (see
  // the header), and a half-built adapter that writes into a human's `.jevcode/` is worse than an honest refusal.
  return {
    isImportId: m.isImportId,
    planImport: (opts) => m.planImport(opts as unknown as Parameters<typeof m.planImport>[0]),
    summarisePlan: m.summarisePlan,
    applicableRows: (plan, opts) => m.applicableRows(plan, opts ?? {}),
    asImportPlan: m.asImportPlan,
  };
}

function scopeOf(flags: ImportFlags): ImportScope | null {
  const s = flags.scope;
  if (s === undefined) return 'both';
  return (IMPORT_SCOPES as readonly string[]).includes(s) ? (s as ImportScope) : null;
}

/** §5.7: the twins are resolved from the FLAGS as well as the host — `--ascii` works without a pre-resolving host. */
function glyphsOf(io: ImportIo, flags: ImportFlags): GlyphSet {
  const ascii = io.ascii === true || flags.ascii === true;
  const sr = speaks(io, flags);
  return glyphSet({ ...(ascii ? { ascii: true } : {}), ...(sr ? { screenReader: true } : {}) });
}

/** §5.7: the spoken twin — asked for by the host or by `--screen-reader`, and overridden by an explicit `--plain`. */
function speaks(io: ImportIo, flags: ImportFlags): boolean {
  if (flags.plain === true) return false;
  return io.screenReader === true || flags.screenReader === true;
}

function line(io: ImportIo, text: string): void {
  io.stdout.write(`${text}\n`);
}

/** §13.1: an `[import]` item on stdout — the label is the item's, never repeated inside the text. */
function item(io: ImportIo, text: string): void {
  line(io, `${IMPORT_LABEL} ${text}`);
}

/** every operator-facing notice and refusal goes to stderr, so a script parsing the report reads rows only */
function note(io: ImportIo, text: string): void {
  io.stderr.write(`${text}\n`);
}

function jevcodeDirOf(io: ImportIo): string {
  return io.jevcodeDir ?? join(homedir(), '.jevcode');
}

async function readArtifact(io: ImportIo, path: string): Promise<string | null> {
  if (io.readArtifact !== undefined) return await io.readArtifact(path);
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * §12.4 S93: the per-class split of what the apply was ASKED to write, from the rows themselves (`groupKeyOf`,
 * the reducer's own grouping) rather than from `PlanGroup`, so `--scope user` reports the rows it narrowed to.
 */
function appliedSplit(plan: ImportPlan, rows: readonly string[]): { counts: { memory: number; commands: number; rules: number; mcp: number }; bytes: number } {
  const ids = new Set(rows);
  const counts = { memory: 0, commands: 0, rules: 0, mcp: 0 };
  let bytes = 0;
  for (const r of plan.rows) {
    if (!ids.has(r.id)) continue;
    bytes += Number.isFinite(r.bytes) ? r.bytes : 0;
    const key = groupKeyOf(r);
    if (key === 'memory' || key === 'commands' || key === 'rules' || key === 'mcp') counts[key] += 1;
  }
  return { counts, bytes };
}

/**
 * §5.5 / §5.6: the verb. Pure over `ImportIo`; the only I/O is `io.stdout` / `io.stderr`, the manifest under
 * `io.jevcodeDir` and whatever the injected engine does.
 */
export async function commandImport(flags: ImportFlags, io: ImportIo): Promise<number> {
  const g = glyphsOf(io, flags);
  const gl = importGlyphs(g);
  const columns = io.columns ?? 120;

  // ---- flag validation, before anything is read -------------------------------------------------
  const scope = scopeOf(flags);
  if (scope === null) {
    note(io, `jevcode import: --scope expects one of ${IMPORT_SCOPES.join('|')}, got "${flags.scope ?? ''}". Run 'jevcode import --help' for usage.`);
    return EXIT_CODES.config;
  }
  if (flags.resume !== undefined && flags.undo !== undefined) {
    note(io, "jevcode import: --resume and --undo are exclusive. Run 'jevcode import --help' for usage.");
    return EXIT_CODES.config;
  }
  if (flags.yes === true && flags.dryRun === true) {
    note(io, "jevcode import: --yes and --dry-run are exclusive. Run 'jevcode import --help' for usage.");
    return EXIT_CODES.config;
  }
  // §12.4 S95 / §7 row 59: `jevcode import --resume imp_…` is the command the resume hint prints, WITHOUT
  // `--yes`. It is an apply intent on its own — a `--resume` that re-planned and printed a dry run would leave
  // the half-applied import exactly as it found it, silently.
  if (flags.resume !== undefined && flags.dryRun === true) {
    note(io, "jevcode import: --resume and --dry-run are exclusive. Run 'jevcode import --help' for usage.");
    return EXIT_CODES.config;
  }

  const engine = await loadImportEngine(io);

  // ---- --undo / --resume: the id is validated through `isImportId`, never a regex of our own -----
  for (const [name, value] of [
    ['undo', flags.undo],
    ['resume', flags.resume],
  ] as const) {
    if (value === undefined) continue;
    if (!engine.isImportId(value)) {
      note(io, `jevcode import: --${name} expects an import id (imp_YYYYMMDDTHHMMSSZ_xxxxxx), got "${value}". Run 'jevcode import --help' for usage.`);
      return EXIT_CODES.config;
    }
  }

  // ---- the write verbs are refused BEFORE anything is read (the phase-4 gap) --------------------
  const wantsApply = flags.yes === true || flags.resume !== undefined;
  if (flags.undo !== undefined && engine.undoImport === undefined) {
    note(io, importNotWired('--undo'));
    return EXIT_CODES.config;
  }
  if (wantsApply) {
    const verb = flags.resume !== undefined ? '--resume' : '--yes';
    const run = flags.resume !== undefined ? engine.resumeImport : engine.applyPlan;
    if (run === undefined) {
      note(io, importNotWired(verb));
      return EXIT_CODES.config;
    }
  }

  const dir = jevcodeDirOf(io);
  const workspaceKey = io.workspaceKey ?? process.cwd();

  if (flags.undo !== undefined) {
    const undo = engine.undoImport;
    if (undo === undefined) {
      note(io, importNotWired('--undo'));
      return EXIT_CODES.config;
    }
    // §4.7.6: undo consults the manifest for what this import actually wrote, and writes back what is left
    const before = await readImportManifest(importManifestPath(dir), workspaceKey);
    const r = await undo({ importId: flags.undo, manifest: before.found ? before.manifest : null });
    // only where the HOST said its config dir is: this module never writes into a guessed `~/.jevcode`
    if (r.manifest != null && !before.future && io.jevcodeDir !== undefined) await writeImportManifest(importManifestPath(dir), r.manifest);
    if (flags.json === true) {
      line(io, JSON.stringify({ importId: r.importId, applied: 0, restored: r.restored, skipped: r.modified, errors: [] }));
      return EXIT_CODES.ok;
    }
    item(io, importUndoItem(r.importId, r.restored, r.modified, gl));
    return EXIT_CODES.ok;
  }

  // ---- the plan: the STORED one for `--resume`, a fresh one otherwise --------------------------
  let plan: ImportPlan;
  if (flags.resume !== undefined) {
    // §4.7.6: resume re-reads `plan.json` — the rows it continues must be the rows the original import planned,
    // never a fresh plan with a new id and a different row set.
    const path = join(importArtifactDir(dir, flags.resume), 'plan.json');
    const text = await readArtifact(io, path);
    const parsed = text === null ? null : safeJson(text);
    const stored = parsed === null ? null : (engine.asImportPlan?.(parsed) ?? null);
    if (stored === null) {
      note(io, `jevcode import: --resume ${flags.resume} cannot read its stored plan at ${path}. Run 'jevcode import' to plan again.`);
      return EXIT_CODES.config;
    }
    plan = stored;
  } else {
    try {
      plan = await engine.planImport({
        ...(io.planOptions ?? {}),
        scope,
        ...(flags.source !== undefined ? { optIn: [flags.source] } : {}),
      });
    } catch (e) {
      if (isAbort(e)) {
        item(io, importCancelledItem(gl));
        return EXIT_CODES.sigint;
      }
      note(io, `jevcode import: ${e instanceof Error ? e.message : String(e)}`);
      return EXIT_CODES.config;
    }
  }

  const summary = engine.summarisePlan(plan);
  const applicable = engine.applicableRows(plan, { scope });

  // §12.4 S92 / §7 row 52: nothing installed — one sentence, exit 0, nothing written.
  if (plan.rows.length === 0) {
    if (flags.json === true) line(io, JSON.stringify(plan as unknown as Json));
    else line(io, glyphTwin(IMPORT_NOTHING_FOUND, g));
    return EXIT_CODES.ok;
  }

  // §5.7 / §13.3: `--json` is ONE `ImportPlan`, no prose, and it is the whole answer.
  if (flags.json === true && !wantsApply) {
    line(io, JSON.stringify(plan as unknown as Json));
    return EXIT_CODES.ok;
  }

  const input: ImportUiInput = { plan, summary, applicable };
  const ui = initImportUi(input);

  // ---- the dry run (the default) ----------------------------------------------------------------
  if (!wantsApply) {
    item(io, importPlanItem(plan.importId, summary.toImport, summary.toReview, summary.skipped, gl));
    if (io.reportPath !== undefined) item(io, importReportItem(io.reportPath(plan.importId)));
    // §5.7: the numbered twin, WITHOUT its prompt — nothing in this build reads an answer, and an unanswerable
    // `Enter selection (1-N):` is the defect the pipe sentence was written for (finding 8).
    const rows = speaks(io, flags) ? importScreenReaderLines(ui, { prompt: false }) : importPlainLines(ui, input, columns, g, { prompt: false });
    for (const r of rows) line(io, r);
    // every non-applying run says so; the pipe / `--no-input` case names its own reason as well (§5.7)
    note(io, glyphTwin(io.isTTY !== true || flags.noInput === true ? IMPORT_PIPE_DRY_RUN : IMPORT_DRY_RUN, g));
    return EXIT_CODES.ok;
  }

  // ---- --yes / --resume: exactly `applicableRows`, and never a credential (§4.8.2) --------------
  if (summary.credentialsFound > 0 && io.isTTY !== true) note(io, glyphTwin(IMPORT_CREDENTIALS_NEED_TTY, g));
  const run = flags.resume !== undefined ? engine.resumeImport : engine.applyPlan;
  if (run === undefined) {
    note(io, importNotWired(flags.resume !== undefined ? '--resume' : '--yes'));
    return EXIT_CODES.config;
  }
  const read = await readImportManifest(importManifestPath(dir), workspaceKey);
  let out: ImportApplyOutcome;
  try {
    out = await run({
      plan,
      importId: flags.resume ?? plan.importId,
      rows: applicable,
      by: 'flag',
      manifest: read.found ? read.manifest : null,
    });
  } catch (e) {
    if (isAbort(e)) {
      item(io, importInterruptedItem(0, applicable.length, plan.importId, gl));
      return EXIT_CODES.sigint;
    }
    note(io, `jevcode import: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_CODES.config;
  }

  // §4.7.5 [G1.3] / [G1.4]: the manifest and the retention GC are this module's, and they run on every apply
  // that wrote something — including an interrupted or partly failed one, whose rows are just as real.
  const retention = await recordApply(io, dir, workspaceKey, read.future, out);

  if (flags.json === true) {
    line(io, JSON.stringify({ importId: out.importId, applied: out.applied, restored: 0, skipped: out.total - out.applied, errors: out.error == null ? [] : [`${out.error.path}: ${out.error.code}`] }));
    return out.error != null || out.failed > 0 ? EXIT_CODES.config : out.interrupted === true ? EXIT_CODES.sigint : EXIT_CODES.ok;
  }

  if (out.error != null) {
    item(io, importWriteErrorItem(out.error.path, out.error.code, out.applied, out.total, out.importId, gl));
    if (retention > 0) item(io, importRetentionItem(retention));
    return EXIT_CODES.config;
  }
  if (out.interrupted === true) {
    // §7 row 59, behaviour 2: apply stops at the row boundary and prints the resume hint; exit 130.
    item(io, importInterruptedItem(out.applied, out.total, out.importId, gl));
    if (retention > 0) item(io, importRetentionItem(retention));
    return EXIT_CODES.sigint;
  }
  // §12.4 S93: ONE applied item, with the per-class counts and the byte total — never a second, shorter sentence
  const split = appliedSplit(plan, applicable);
  item(io, importAppliedItem(out.applied, out.total, split.counts, split.bytes, gl));
  if (retention > 0) item(io, importRetentionItem(retention));
  // [G1.1]: a row demoted by the source re-check is exit 2 — the human asked for all of them and did not get all
  return out.failed > 0 ? EXIT_CODES.config : EXIT_CODES.ok;
}

/**
 * §4.7.5: merge what the apply wrote into `<jevcodeDir>/imports/manifest.json` (atomic, 0600) and run the
 * [G1.4] retention GC. Returns how many old record directories it removed, for `importRetentionItem`.
 *
 * A manifest written by a NEWER JevCode (`future`) is never rewritten — it is read as empty, and overwriting it
 * would destroy that client's record of what it wrote, and with it its undo sources.
 */
async function recordApply(io: ImportIo, dir: string, workspaceKey: string, future: boolean, out: ImportApplyOutcome): Promise<number> {
  const entries = out.entries ?? [];
  // READS fall back to `~/.jevcode` (harmless, and it is where the artefacts are); a WRITE only happens where
  // the host named its config dir, so a caller that forgot the field never has a manifest invented under it
  if (future || io.jevcodeDir === undefined) return 0;
  const path = importManifestPath(dir);
  const read = await readImportManifest(path, workspaceKey);
  if (read.future) return 0;
  if (entries.length === 0 && !read.upgraded) return 0;
  const merged = mergeManifestEntries(read.manifest, workspaceKey, entries);
  try {
    await writeImportManifest(path, merged);
  } catch {
    // a bookkeeping write that fails is not a reason to fail an import that already wrote its rows
    return 0;
  }
  const gone = await gcImportRecords(importsRoot(dir), merged);
  return gone.length;
}

function safeJson(text: string): Json | null {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return null;
  }
}

/**
 * §7 row 59: a SIGINT, and nothing else. The message regex this used to carry turned any engine error whose text
 * happened to contain "aborted" (`discovery aborted: EPERM`) into `[import] cancelled` and exit 130, hiding both
 * the reason and the real exit code.
 */
function isAbort(e: unknown): boolean {
  return isAbortError(e) || (e instanceof Error && e.name === 'AbortError');
}

/** §5.7: re-exported so the readline twin and the tests share one prompt string. */
export { importSelectionPrompt };
/** the default glyph set, exported for the tests that assert the two-twin behaviour. */
export const IMPORT_CLI_GLYPHS = GLYPHS.unicode;
