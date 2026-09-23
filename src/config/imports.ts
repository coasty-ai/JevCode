/**
 * The import manifest and the eighteen `[import]` item strings (TUI-DESIGN-5 §5.3, §12.4 S87–S98 — §13.1 says
 * "seventeen"; S96's `importSkippedRowItem` is the eighteenth and is inside `IMPORT_ITEM_BUILDERS` rather than
 * outside every sweep, a declared divergence recorded on the anchor list below;
 * IMPORT-DESIGN §4.7.5 [G1.3], §4.7.6 [G1.4], §5.5; IMPORT-DESIGN §0 principle 10 — **`src/config` never
 * imports `src/tui`**, which is why the item builders live here and `src/tui/import/lines.ts` only
 * re-exports them, exactly as `credentials.ts`'s `keyEnteredText` / `savedText` are re-exported by
 * `src/tui/onboarding/lines.ts`).
 *
 * Two rules this module keeps, both load-bearing:
 *
 *  1. **No value import of `src/import/**` (gate G-R5-1).** `src/import/index.js` reaches `node:fs` and is named
 *     by the first-frame import-graph assertion; every import type here is `import type` and erases.
 *  2. **The `v: 0` manifest upgrades IN MEMORY and is never rewritten** until the next successful apply
 *     (IMPORT-DESIGN row 70, TUI-DESIGN-5 §5.3). `readImportManifest` therefore returns
 *     `{ manifest, upgraded, future }` and writes nothing; only `writeImportManifest` touches the disk. An
 *     unknown FUTURE `v` is `upgraded: false, future: true` — read as empty, never written back.
 *
 * Every string is a **named, glyph-agnostic anchor** with a two-glyph-set self-test (TD4 D-V's ratified pattern,
 * TUI-DESIGN-5 §13.4): the builders take a `GlyphSet`-shaped `{ dot, dash, arrow, ellipsis }` record so the
 * `--ascii` twin is produced by substitution and never by a second literal.
 */
import { chmod, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { writeFileAtomic } from '../core/atomic.js';
import { isJsonObject, parseJson } from '../core/json.js';
import type { ImportManifest, ImportManifestEntry, Json, JsonObject } from '../core/types.js';

// ---------------------------------------------------------------------------------------
// Paths (IMPORT-DESIGN §4.7.5, §4.7.6)
// ---------------------------------------------------------------------------------------

/** IMPORT-DESIGN §4.7.5: the manifest file under `<jevcodeDir>/imports/`. */
export const IMPORT_MANIFEST_FILE_NAME = 'manifest.json';
/** IMPORT-DESIGN §4.7.6 [G1.4] `importsKeep`: how many import record directories survive the next import's GC. */
export const IMPORTS_KEEP = 10;

/** IMPORT-DESIGN §4.7.6: `<jevcodeDir>/imports` — the artefact root; the manifest and every `imp_…` record live here. */
export function importsRoot(jevcodeDir: string): string {
  return join(jevcodeDir, 'imports');
}

/** IMPORT-DESIGN §4.7.5: `<jevcodeDir>/imports/manifest.json`. */
export function importManifestPath(jevcodeDir: string): string {
  return join(importsRoot(jevcodeDir), IMPORT_MANIFEST_FILE_NAME);
}

/** IMPORT-DESIGN §4.7.6: `<jevcodeDir>/imports/<importId>` — `plan.json`, `report.md`, `apply.jsonl` and `pre/`. */
export function importArtifactDir(jevcodeDir: string, importId: string): string {
  return join(importsRoot(jevcodeDir), importId);
}

// ---------------------------------------------------------------------------------------
// The manifest — tolerant read, pure merge, atomic 0600 write
// ---------------------------------------------------------------------------------------

/** IMPORT-DESIGN §4.7.5 [G1.3]: an empty manifest — keyed by workspace, never one global destination list. */
export function emptyImportManifest(): ImportManifest {
  return { v: 1, user: [], workspaces: {} };
}

/**
 * The result of a tolerant read. `upgraded` is true exactly when the file on disk was a pre-1 manifest that this
 * read lifted **in memory**; the caller must not write it back until an apply succeeds (row 70). `error` carries a
 * one-line reason for an unreadable or malformed file — the manifest then reads as empty and the import proceeds,
 * because refusing to import because a bookkeeping file is corrupt is worse than re-importing.
 */
export interface ImportManifestRead {
  manifest: ImportManifest;
  /** the file existed and parsed */
  found: boolean;
  /** a `v: 0` (or version-less) document was lifted to `v: 1` in memory; NOTHING was written */
  upgraded: boolean;
  /**
   * The file on disk carries a version this build does not know (`v: 2`, `v: 99`, a string). It is read as EMPTY
   * — a newer client's bookkeeping is not ours to interpret — and `upgraded` is **false**, which is what stops
   * the next apply from overwriting it and destroying that client's undo sources.
   */
  future: boolean;
  error: string | null;
}

/** What `upgradeImportManifest` answers: the lifted document plus the two flags the writer obeys. */
export interface ImportManifestUpgrade {
  manifest: ImportManifest;
  /** a `v: 0` document was lifted in memory; write it back at the next successful apply */
  upgraded: boolean;
  /** an unknown FUTURE `v`: read as empty, and never written back (see `ImportManifestRead.future`) */
  future: boolean;
}

function entryOf(v: Json): ImportManifestEntry | null {
  if (!isJsonObject(v)) return null;
  const s = (k: string): string | null => (typeof v[k] === 'string' ? (v[k] as string) : null);
  const importId = s('importId');
  const dest = s('dest');
  if (importId === null || dest === null) return null;
  const scope = s('scope');
  const by = s('by');
  return {
    importId,
    dest,
    sourceSha256: s('sourceSha256') ?? '',
    destSha256: s('destSha256') ?? '',
    scope: scope === 'user' || scope === 'project' || scope === 'project-local' ? scope : 'project',
    at: s('at') ?? '',
    by: by === 'flag' ? 'flag' : 'tty',
  };
}

function entriesOf(v: Json | undefined): ImportManifestEntry[] {
  if (!Array.isArray(v)) return [];
  const out: ImportManifestEntry[] = [];
  for (const row of v) {
    const e = entryOf(row);
    if (e !== null) out.push(e);
  }
  return out;
}

/**
 * IMPORT-DESIGN row 70 / TUI-DESIGN-5 §5.3: the tolerant reader. A `v: 0` document — the shape that predates
 * [G1.3]'s per-workspace keying, i.e. one flat `entries` array — is lifted by moving every non-`user` entry under
 * `workspaceKey`, **in memory only**. A missing file, a parse error, a non-object root and an unknown future `v`
 * are all "no manifest": the import re-creates rather than refusing.
 */
export function upgradeImportManifest(value: Json, workspaceKey: string): ImportManifestUpgrade {
  if (!isJsonObject(value)) return { manifest: emptyImportManifest(), upgraded: false, future: false };
  const v = value['v'];
  if (v === 1) {
    const workspaces: Record<string, readonly ImportManifestEntry[]> = {};
    const raw = value['workspaces'];
    if (isJsonObject(raw)) for (const [k, rows] of Object.entries(raw)) workspaces[k] = entriesOf(rows);
    const lastRun = typeof value['lastRun'] === 'string' ? { lastRun: value['lastRun'] } : {};
    return { manifest: { v: 1, user: entriesOf(value['user']), workspaces, ...lastRun }, upgraded: false, future: false };
  }
  // An unknown FUTURE version (`v: 2`, `v: 99`, a string): read as empty and NEVER rewritten. `upgraded: true`
  // here would mean "write it back at the next apply", which destroys a newer JevCode's record of what it wrote
  // — and with it the only source its `--undo` can restore from. Only `v: 0` / a version-less document is lifted.
  if (v !== undefined && v !== 0) return { manifest: emptyImportManifest(), upgraded: false, future: true };
  // v: 0 (or absent) — the flat pre-[G1.3] shape: one `entries` array against repo-relative destinations.
  const flat = entriesOf(value['entries'] ?? value['rows']);
  if (flat.length === 0 && value['user'] === undefined) return { manifest: emptyImportManifest(), upgraded: true, future: false };
  const user = [...entriesOf(value['user']), ...flat.filter((e) => e.scope === 'user')];
  const project = flat.filter((e) => e.scope !== 'user');
  const workspaces: Record<string, readonly ImportManifestEntry[]> = project.length > 0 ? { [workspaceKey]: project } : {};
  return { manifest: { v: 1, user, workspaces }, upgraded: true, future: false };
}

/** Read `<jevcodeDir>/imports/manifest.json`. Never throws, never writes (row 70). */
export async function readImportManifest(path: string, workspaceKey: string): Promise<ImportManifestRead> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { manifest: emptyImportManifest(), found: false, upgraded: false, future: false, error: code === 'ENOENT' ? null : `${code ?? 'read failed'}` };
  }
  const parsed = parseJson(text);
  if (!parsed.ok) return { manifest: emptyImportManifest(), found: true, upgraded: false, future: false, error: parsed.error };
  const { manifest, upgraded, future } = upgradeImportManifest(parsed.value, workspaceKey);
  return { manifest, found: true, upgraded, future, error: null };
}

/**
 * IMPORT-DESIGN §4.7.5: merge the rows one apply wrote into the manifest. Pure. A second write to the same
 * destination in the same scope REPLACES the entry — the manifest answers "what is at this destination now",
 * never "every import that ever touched it".
 */
export function mergeManifestEntries(manifest: ImportManifest, workspaceKey: string, entries: readonly ImportManifestEntry[]): ImportManifest {
  const user = [...manifest.user];
  const project = [...(manifest.workspaces[workspaceKey] ?? [])];
  const put = (list: ImportManifestEntry[], e: ImportManifestEntry): void => {
    const at = list.findIndex((x) => x.dest === e.dest);
    if (at >= 0) list[at] = e;
    else list.push(e);
  };
  for (const e of entries) put(e.scope === 'user' ? user : project, e);
  const workspaces: Record<string, readonly ImportManifestEntry[]> = { ...manifest.workspaces };
  if (project.length > 0) workspaces[workspaceKey] = project;
  const last = entries[entries.length - 1];
  return { v: 1, user, workspaces, ...(last !== undefined ? { lastRun: last.importId } : manifest.lastRun !== undefined ? { lastRun: manifest.lastRun } : {}) };
}

/** IMPORT-DESIGN §4.7.5: every destination the manifest knows for this workspace plus the user scope. Pure. */
export function importDestinations(manifest: ImportManifest, workspaceKey: string): readonly string[] {
  return [...manifest.user.map((e) => e.dest), ...(manifest.workspaces[workspaceKey] ?? []).map((e) => e.dest)];
}

/** Every import id the manifest still references — [G1.4]: an id whose `pre/` is a live undo source is never GC'd. */
export function referencedImportIds(manifest: ImportManifest): ReadonlySet<string> {
  const out = new Set<string>();
  for (const e of manifest.user) out.add(e.importId);
  for (const rows of Object.values(manifest.workspaces)) for (const e of rows) out.add(e.importId);
  return out;
}

/**
 * IMPORT-DESIGN §4.7.6 [G1.4]: which record directories the next import GCs — the oldest ids beyond `keep`,
 * **never** one the manifest still references. `ids` arrive in any order; `imp_<ISO compact>_<hex>` sorts
 * lexicographically by time, which is why the id format is sortable. Pure.
 */
export function retentionVictims(ids: readonly string[], manifest: ImportManifest, keep: number = IMPORTS_KEEP): readonly string[] {
  const referenced = referencedImportIds(manifest);
  // "the newest `keep` dirs survive, and an id a manifest entry still points at is NEVER GC'd" — so the survivor
  // set is (newest keep) ∪ referenced, and a referenced id does not consume one of the ten slots. Its `pre/` is
  // the only thing an `--undo` can restore from, which is a stronger claim than "it is old".
  const sorted = [...ids].sort();
  const newest = new Set(sorted.slice(Math.max(0, sorted.length - Math.max(0, Math.floor(keep)))));
  return sorted.filter((id) => !newest.has(id) && !referenced.has(id));
}

/** The import record directories under `<jevcodeDir>/imports` (ids only; a non-`imp_` entry is ignored). Never throws. */
export async function listImportRecords(root: string): Promise<readonly string[]> {
  try {
    const names = await readdir(root);
    return names.filter((n) => n.startsWith('imp_')).sort();
  } catch {
    return [];
  }
}

/** IMPORT-DESIGN §4.7.6 [G1.4]: run the retention GC. Returns the ids removed (possibly none). Never throws. */
export async function gcImportRecords(root: string, manifest: ImportManifest, keep: number = IMPORTS_KEEP): Promise<readonly string[]> {
  const ids = await listImportRecords(root);
  const victims = retentionVictims(ids, manifest, keep);
  const gone: string[] = [];
  for (const id of victims) {
    try {
      await rm(join(root, id), { recursive: true, force: true });
      gone.push(id);
    } catch {
      /* a record we cannot remove is not a reason to fail an import */
    }
  }
  return gone;
}

/**
 * Write the manifest atomically at mode 0600, creating `<jevcodeDir>/imports` at 0700 — the same discipline
 * `credentials.ts`'s `writeJsonSecure` applies to the credentials file. Called ONLY after a successful apply,
 * which is what makes the `v: 0` read non-destructive (row 70).
 */
export async function writeImportManifest(path: string, manifest: ImportManifest): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, `${JSON.stringify(manifest as unknown as JsonObject, null, 2)}\n`, { mode: 0o600, mkdir: true });
  try {
    await chmod(path, 0o600);
    const s = await stat(dir);
    if ((s.mode & 0o777) !== 0o700) await chmod(dir, 0o700);
  } catch {
    /* Windows and exotic filesystems: the ACL note covers them, exactly as credentials.ts says */
  }
}

// ---------------------------------------------------------------------------------------
// The eighteen `[import]` items (IMPORT-DESIGN §5.5; TUI-DESIGN-5 §12.4 S93–S96)
// ---------------------------------------------------------------------------------------

/**
 * The glyphs the item builders substitute. A structural subset of `GlyphSet` (`src/tui/glyphs.ts`) so this
 * module keeps `src/config` free of any `src/tui` import (IMPORT-DESIGN §0 principle 10) while the TUI can hand
 * its real set straight in.
 */
export interface ImportGlyphs {
  readonly dot: string;
  readonly dash: string;
  readonly arrow: string;
  readonly ellipsis: string;
}

/** The unicode set the items default to; `IMPORT_GLYPHS_ASCII` is its twin, and the two are self-tested pairwise. */
export const IMPORT_GLYPHS: ImportGlyphs = { dot: '·', dash: '—', arrow: '→', ellipsis: '…' };
export const IMPORT_GLYPHS_ASCII: ImportGlyphs = { dot: '-', dash: '-', arrow: '->', ellipsis: '...' };

/** The label every item below is committed under (`TranscriptItem.label`); the text never repeats it. */
export const IMPORT_LABEL = '[import]';

/**
 * IMPORT-DESIGN §5.5 / TD3 §5.1: money as `$0.0003` — the same "up to six places, trailing zeros dropped, never
 * scientific notation" shape `usdMicro` (`src/tui/onboarding/lines.ts:206`) already prints, restated here because
 * `src/config` never imports `src/tui`. `$0.00` for zero, so a free plan does not read as an error.
 */
export function importUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00';
  const t = n.toFixed(6).replace(/0+$/, '');
  return `$${t.endsWith('.') ? `${t}00` : t}`;
}

/** `38 KiB` / `512 B` — sizes only, never contents (the `formatSize` shape `onboarding/lines.ts` already prints). */
export function importSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  const k = bytes / 1024;
  if (k < 1024) return `${k < 10 ? k.toFixed(1) : Math.round(k)} KiB`;
  return `${(k / 1024).toFixed(1)} MiB`;
}

/** `3,371` — thousands separated, so a transcript count reads at a glance. */
export function importCount(n: number): string {
  return Number.isFinite(n) ? Math.floor(n).toLocaleString('en-US') : '0';
}

/** An import id shortened to `imp_…a1b2c3` for a row that has no room for the whole thing. */
export function shortImportId(importId: string, g: ImportGlyphs = IMPORT_GLYPHS): string {
  return importId.length <= 12 ? importId : `imp_${g.ellipsis}${importId.slice(-6)}`;
}

/** 1. `[import] plan imp_… · 41 to import · 9 to review · 137 skipped` */
export function importPlanItem(importId: string, toImport: number, toReview: number, skipped: number, g: ImportGlyphs = IMPORT_GLYPHS): string {
  return `plan ${importId} ${g.dot} ${toImport} to import ${g.dot} ${toReview} to review ${g.dot} ${importCount(skipped)} skipped`;
}

/** 2. `[import] report ~/.jevcode/imports/imp_…/report.md (0600)` */
export function importReportItem(displayPath: string): string {
  return `report ${displayPath} (0600)`;
}

/** 3. `[import] jev 1 request · 70 questions · $0.0003 · 6 code fallbacks` */
export function importJevItem(requests: number, questions: number, usdSpent: number, fallbacks: number, g: ImportGlyphs = IMPORT_GLYPHS): string {
  return `jev ${requests} request${requests === 1 ? '' : 's'} ${g.dot} ${questions} questions ${g.dot} ${importUsd(usdSpent)} ${g.dot} ${fallbacks} code fallback${fallbacks === 1 ? '' : 's'}`;
}

/** 4. §12.4 S93: `[import] applied 41 of 41 · memory 29 · commands 6 · rules 0 · mcp 3 (disabled) · 38 KiB` */
export function importAppliedItem(applied: number, total: number, counts: { memory: number; commands: number; rules: number; mcp: number }, bytes: number, g: ImportGlyphs = IMPORT_GLYPHS): string {
  return `applied ${applied} of ${total} ${g.dot} memory ${counts.memory} ${g.dot} commands ${counts.commands} ${g.dot} rules ${counts.rules} ${g.dot} mcp ${counts.mcp} (disabled) ${g.dot} ${importSize(bytes)}`;
}

/** 5. `[import] generator key: imported from ~/.claude/settings.json env.ANTHROPIC_API_KEY (sha256:3f2a…)` — a FINGERPRINT, never a value (§4.8.1). */
export function importCredentialItem(which: 'generator' | 'jev', displayPath: string, dotted: string, fp: string, g: ImportGlyphs = IMPORT_GLYPHS): string {
  return `${which} key: imported from ${displayPath} ${dotted} (sha256:${fp.slice(0, 4)}${g.ellipsis})`;
}

/** 6. `[import] trust: AGENTS.md re-pinned (sha256 1a2b3c4d → 9f8e7d6c) — the block you approved` */
export function importTrustRepinnedItem(from: string, to: string, name = 'AGENTS.md', g: ImportGlyphs = IMPORT_GLYPHS): string {
  return `trust: ${name} re-pinned (sha256 ${from.slice(0, 8)} ${g.arrow} ${to.slice(0, 8)}) ${g.dash} the block you approved`;
}

/** 7. `[import] trust: AGENTS.md changed outside the import block — you will be asked once at the next start` */
export function importTrustChangedItem(name = 'AGENTS.md', g: ImportGlyphs = IMPORT_GLYPHS): string {
  return `trust: ${name} changed outside the import block ${g.dash} you will be asked once at the next start`;
}

/** 8. `[import] active from the next run · /new starts one here · rules and topics are live now` */
export function importActiveItem(g: ImportGlyphs = IMPORT_GLYPHS): string {
  return `active from the next run ${g.dot} /new starts one here ${g.dot} rules and topics are live now`;
}

/** 9. `[import] 4 credentials found, 0 copied · values never leave their file` (§4.8.1 invariant 1, said out loud). */
export function importCredentialsFoundItem(found: number, g: ImportGlyphs = IMPORT_GLYPHS): string {
  return `${found} credential${found === 1 ? '' : 's'} found, 0 copied ${g.dot} values never leave their file`;
}

/** 10. `[import] skipped 3,371 transcripts (2.7 GB) — jevcode import --source claude-transcripts` */
export function importSkippedSourceItem(count: number, what: string, bytes: number, sourceId: string, g: ImportGlyphs = IMPORT_GLYPHS): string {
  return `skipped ${importCount(count)} ${what} (${importSize(bytes)}) ${g.dash} jevcode import --source ${sourceId}`;
}

/** 11. §12.4 S92's item twin: `[import] nothing found · 3 sources cannot be read from disk · /memory add pastes them` */
export function importNothingFoundItem(cannotRead: number, g: ImportGlyphs = IMPORT_GLYPHS): string {
  return `nothing found ${g.dot} ${cannotRead} source${cannotRead === 1 ? '' : 's'} cannot be read from disk ${g.dot} /memory add pastes them`;
}

/** 12. §12.4 S94: `[import] undo imp_… · 41 files restored · 0 modified since` */
export function importUndoItem(importId: string, restored: number, modified: number, g: ImportGlyphs = IMPORT_GLYPHS): string {
  return `undo ${shortImportId(importId, g)} ${g.dot} ${restored} file${restored === 1 ? '' : 's'} restored ${g.dot} ${modified} modified since`;
}

/** 13. `[import] source changed since the plan: ~/.claude/CLAUDE.md (9f8e7d6c → 1a2b3c4d) — not written` (§7 row 56). */
export function importSourceChangedItem(displayPath: string, from: string, to: string, g: ImportGlyphs = IMPORT_GLYPHS): string {
  return `source changed since the plan: ${displayPath} (${from.slice(0, 8)} ${g.arrow} ${to.slice(0, 8)}) ${g.dash} not written`;
}

/**
 * 14. §12.4 S95 / §7 row 57: `[import] error: could not write <path>: EACCES (40 of 41 applied) — jevcode import
 * --resume imp_… continues`. TUI-DESIGN-5 §12.4 extends IMPORT-DESIGN's row with the `--resume` clause, so the
 * human who hits a half-applied import is told how to finish it rather than left to find `--resume` in `--help`.
 */
export function importWriteErrorItem(path: string, code: string, applied: number, total: number, importId: string, g: ImportGlyphs = IMPORT_GLYPHS): string {
  return `error: could not write ${path}: ${code} (${applied} of ${total} applied) ${g.dash} jevcode import --resume ${shortImportId(importId, g)} continues`;
}

/** 15. `[import] cancelled · nothing was written` — Ctrl-C during discover (§7 row 59, behaviour 1). */
export function importCancelledItem(g: ImportGlyphs = IMPORT_GLYPHS): string {
  return `cancelled ${g.dot} nothing was written`;
}

/** 16. `[import] applied 9 of 41 — jevcode import --resume imp_…` — Ctrl-C during apply (§7 row 59, behaviour 2). */
export function importInterruptedItem(applied: number, total: number, importId: string, g: ImportGlyphs = IMPORT_GLYPHS): string {
  return `applied ${applied} of ${total} ${g.dash} jevcode import --resume ${importId}`;
}

/** 17. `[import] removed 3 old import records (kept the newest 10)` — the retention GC [G1.4]. */
export function importRetentionItem(removed: number, keep: number = IMPORTS_KEEP): string {
  return `removed ${removed} old import record${removed === 1 ? '' : 's'} (kept the newest ${keep})`;
}

/** §12.4 S96: `[import] skipped <path> — <reason>` — one malformed source (§7 row 54), the reason, never a stack. */
export function importSkippedRowItem(path: string, reason: string, g: ImportGlyphs = IMPORT_GLYPHS): string {
  return `skipped ${path} ${g.dash} ${reason}`;
}

/**
 * §13.4: the pin inventory's anchor list — **every** `[import]` item builder, by name, so `import-lines.test.ts`
 * can assert that `src/tui/import/lines.ts` re-exports all of them and re-declares none. A zero-match grep is a
 * hard failure, never a skip.
 *
 * §13.1 says "the 17 `[import]` strings"; the module exports **eighteen** — §12.4 S96's `importSkippedRowItem`
 * (the malformed-source row of §7 row 54) is the eighteenth, and it belongs inside the pin rather than outside
 * every sweep. The declared divergence from §13.1's count is recorded in the implementer report; the list is the
 * source of truth and `lines.test.ts` asserts it covers every `*Item` export of this module, so a nineteenth
 * builder cannot be added outside the pin.
 */
export const IMPORT_ITEM_BUILDERS = [
  'importPlanItem',
  'importReportItem',
  'importJevItem',
  'importAppliedItem',
  'importCredentialItem',
  'importTrustRepinnedItem',
  'importTrustChangedItem',
  'importActiveItem',
  'importCredentialsFoundItem',
  'importSkippedSourceItem',
  'importNothingFoundItem',
  'importUndoItem',
  'importSourceChangedItem',
  'importWriteErrorItem',
  'importCancelledItem',
  'importInterruptedItem',
  'importRetentionItem',
  'importSkippedRowItem',
] as const;
