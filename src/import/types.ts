/**
 * docs/IMPORT-DESIGN.md §7.1 row 1 — the import contract.
 *
 * TEMPORARY HOME. Every type in section 1 below is declared here only because the two designs
 * that own `src/core/types.ts` next have not landed yet: the whole block moves verbatim to
 * `src/core/types.ts` under a `// contract 1.6` marker **after** coordination 1.4 and
 * orchestration 1.5 land (§7.1 [G2.2]: "the import additions to src/core/types.ts go after
 * coordination's round-3 contract line"). Until then nothing outside `src/import/**` may import
 * from this file, and `src/core/types.ts` is not edited at all.
 *
 * Section 2 holds the four **widenings** of existing `src/core/types.ts` declarations. They are
 * written here as separate local types because widening the real declaration would edit a file
 * this slot does not own on this branch; each one names the member it merges into at 1.6.
 *
 * Section 3 is engine-local and does **not** move: the atlas shape, the parser results and the
 * seams `src/import/**` is injected with. `src/import/**` imports nothing from `src/tui`,
 * `src/cli`, `src/config`, `src/session` or `src/chat` (§7 ownership), so every root, clock and
 * filesystem call arrives as an argument.
 */
import type { Json } from '../core/types.js';

// =======================================================================================
// 1. contract 1.6 — moves to src/core/types.ts after coordination 1.4 / orchestration 1.5
// =======================================================================================

/** §3: the nine tools the atlas knows, plus Claude Desktop, the MCP-only rows and stdin pastes (§3.11). */
export type SourceTool =
  | 'claude-code'
  | 'claude-desktop'
  | 'codex'
  | 'opencode'
  | 'cursor'
  | 'windsurf'
  | 'aider'
  | 'gemini'
  | 'copilot'
  | 'mcp'
  | 'pasted';

/** §2.2 / §4.2.5: scope is meaning (§0 principle 7) — never flattened. `managed` is a system-wide root. */
export type SourceScope = 'user' | 'project' | 'project-local' | 'managed';

/** §4.2.5: how a source is read. A Codex `*.rules` file is `text` (no parser claims it). */
export type SourceFormat = 'md' | 'mdc' | 'json' | 'jsonc' | 'toml' | 'yaml' | 'jsonl' | 'sqlite' | 'text' | 'js' | 'sh';

/**
 * §4.4.0 / §4.6.1: `PlanRow.class`, and the class an atlas row declares (§3.1 `SourceSpec.class`).
 * The design's five letters map on: M → `memory` | `rule`, W → `command`, C → `config` | `mcp`,
 * S → `secret`, T → `transcript`, X → `skip` (an atlas row that is never imported at all).
 */
export type ImportClass = 'memory' | 'rule' | 'command' | 'mcp' | 'config' | 'secret' | 'transcript' | 'skip';

/** §4.4.0: the fourteen named `skip:*` reasons — "unknown" is never a silent bucket. */
export type ImportSkipAction =
  | 'skip:unchanged'
  | 'skip:self'
  | 'skip:secret'
  | 'skip:executable'
  | 'skip:unsupported'
  | 'skip:oversize'
  | 'skip:not-text'
  | 'skip:not-a-file'
  | 'skip:parse-error'
  | 'skip:symlink'
  | 'skip:transcript'
  | 'skip:third-party'
  | 'skip:tool-managed'
  | 'skip:unknown-format'
  | 'skip:remote'
  | 'skip:unrelated'
  | 'skip:untrusted';

/** §4.6.1: exactly one action per discovered artefact (§1 property 2 — there is no "other" bucket). */
export type ImportAction = 'create' | 'append' | 'update' | 'merge' | 'review' | 'suggest' | ImportSkipAction;

/** §4.2.5: the tolerant parse summary carried on a `SourceItem`. Shapes only — never a body. */
export interface SourceParse {
  ok: boolean;
  error?: string;
  frontmatterKeys?: readonly string[];
  /** redacted and clipped to `jevHeadingCells`, at most `jevHeadings` of them */
  headings?: readonly string[];
  lines?: number;
  fences?: number;
}

/** §4.2.5: one line of `sources.jsonl`. Keyed by realpath (§4.2.3), so five detectors yield one item. */
export interface SourceItem {
  /** `sha256(realpath).slice(0, 12)` */
  id: string;
  realpath: string;
  /** `~/…` form; never an absolute home path in an artefact */
  display: string;
  tools: readonly SourceTool[];
  /** the atlas row id, e.g. `claude.auto-memory.topic` */
  artefact: string;
  format: SourceFormat;
  scope: SourceScope;
  bytes: number;
  sha256: string;
  mtime: string;
  parse: SourceParse;
  notices: readonly string[];
}

/** §2.3: `kind` in a topic file's frontmatter; Claude Code's four `type` values map on to the first four. */
export type MemoryKind = 'project' | 'preference' | 'reference' | 'feedback' | 'rule';

/** §2.5: when a rule is injected. `always` is a rule file with `paths: ["**"]`, never an AGENTS.md promotion. */
export type RuleTrigger = 'always' | 'paths' | 'manual';

/** §2.3: the `source:` block written into every imported file — provenance on every byte (§0 principle 6). */
export interface MemoryProvenance {
  tool: SourceTool;
  /** `~/…` display form */
  path: string;
  sha256: string;
  /** ISO-8601 */
  imported: string;
  importId: string;
  /** present only when N detectors found the same realpath (§4.2.3) */
  tools?: readonly SourceTool[];
}

/** §2.3 / §2.5: one topic or rule file, frontmatter + body, as the engine renders it. */
export interface MemoryItem {
  /** the human name; the filename is `slugOf(name)` (§4.7.3) — they are not the same thing */
  name: string;
  description: string;
  kind: MemoryKind;
  scope: 'user' | 'project' | 'project-local';
  /** required when `trigger === 'paths'`; absent = index-only, loaded on demand */
  paths?: readonly string[];
  /** rules only */
  trigger?: RuleTrigger;
  source: MemoryProvenance;
  /** count of `[REDACTED:*]` substitutions made at write time (§2.9) */
  redacted: number;
  /** bytes dropped by the cap; 0 when whole */
  clipped: number;
  /** redacted, bidi-stripped, CRLF-normalised, capped body */
  body: string;
}

/** §2.6 / §5.8.3: an inert imported command (A63). The body never executes — see `executableStripped`. */
export interface ProjectCommand {
  name: string;
  description: string;
  argumentHint?: string;
  /** destination path, repo- or `~`-relative */
  path: string;
  body: string;
  scope: 'user' | 'project';
  source: MemoryProvenance;
  /** how many `` !`cmd` ``/```` ```! ````/`!{cmd}`/`@{file}`/`$(cmd)` segments became ```` ```text (not run) ```` fences */
  executableStripped: number;
}

/** §2.7 / §3.10: the one normalised MCP dialect. Every server arrives disabled. */
export interface McpServerRecord {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: readonly string[];
  url?: string;
  /** values are `${VAR}` references only — a literal credential is replaced by its variable name (§4.8.3) */
  env?: Readonly<Record<string, string>>;
  headers?: Readonly<Record<string, string>>;
  /** §2.7: always false on arrival; §1 property 16 asserts it */
  enabled: false;
  source: { tool: SourceTool; path: string; sha256: string; importId: string };
  /** dropped extras and credential substitutions, rendered in the report */
  notes?: readonly string[];
}

/** §2.7: the `mcp.json` document. */
export interface McpFile {
  v: 1;
  servers: Readonly<Record<string, McpServerRecord>>;
}

/**
 * §4.6.1: one row of the plan. **No field of this type can hold a value** — that is the
 * structural half of §1 property 4; `test/unit/import/leak.test.ts` is the other half.
 */
export interface PlanRow {
  /** stable: `sha256(source.id + dest).slice(0, 12)` */
  id: string;
  source: {
    id: string;
    display: string;
    tools: readonly SourceTool[];
    sha256: string;
    bytes: number;
    /** carried only as a cheap pre-filter for the re-hash of §4.7.2 */
    mtimeMs: number;
  };
  class: Exclude<ImportClass, 'skip'>;
  /** repo- or `~`-relative; null for report-only rows */
  dest: string | null;
  action: ImportAction;
  scope: 'user' | 'project' | 'project-local';
  /** destination bytes this row would write */
  bytes: number;
  /** `rule 9 (frontmatter name+description+metadata.type)` | `jev kind_3 … p=0.82 can_=0.71` | `code fallback (jev unavailable: HTTP 429)` */
  why: string;
  warnings: readonly string[];
  /** conflict / duplicate group id */
  group?: string;
}

/** §4.6.1: one root as the report's `## Sources` section names it. */
export interface PlanRoot {
  display: string;
  tool: SourceTool;
  via: 'default' | 'env';
  env?: string;
  exists: boolean;
}

/** §3.11: rendered even when empty, so "nothing found" never reads as "you have nothing". */
export interface CannotRead {
  what: string;
  why: string;
  paste: string;
}

/** §4.6.1: the artefact phases 1–3 produce. The report *is* the plan (§0 principle 9). */
export interface ImportPlan {
  v: 1;
  importId: string;
  /** ISO-8601 */
  at: string;
  jevcodeVersion: string;
  workspace: string;
  /** `realpath(gitRoot ?? workspace)` [G1.3] */
  workspaceKey: string;
  gitRoot: string | null;
  trust: 'trust' | 'session' | 'none';
  roots: readonly PlanRoot[];
  rows: readonly PlanRow[];
  budget: { memoryBytes: number; memoryMax: number; indexLines: number; indexMax: number };
  jev: { requests: number; questions: number; usd: number; fallbacks: number; reason?: string };
  cannotRead: readonly CannotRead[];
  notices: readonly string[];
}

/** §5.1: the ≤ 50 ms wizard probe. Counts and tool names only — never a value, never a body. */
export interface ImportProbe {
  tools: readonly { tool: SourceTool; display: string; items: number }[];
  /** sum of `tools[].items` */
  total: number;
  /** wall time of the probe, for the perf row */
  ms: number;
  /** true when a cap or the deadline stopped the probe early */
  partial: boolean;
}

/** §4.7.5: one applied row, as the manifest remembers it. */
export interface ImportManifestEntry {
  importId: string;
  /** repo- or `~`-relative destination */
  dest: string;
  /** the source's sha256 at apply time, so a changed source becomes `update` */
  sourceSha256: string;
  /** the destination's sha256 immediately after the write */
  destSha256: string;
  scope: 'user' | 'project' | 'project-local';
  at: string;
  /** §4.8.2: only the human's own terminal or their own `--yes` is authority */
  by: 'tty' | 'flag';
}

/**
 * §4.7.5 [G1.3]: keyed by workspace — a single global list against repo-relative destinations
 * makes a second clone of the same repo look already-imported.
 */
export interface ImportManifest {
  v: 1;
  user: readonly ImportManifestEntry[];
  /** `realpath(gitRoot ?? workspace)` → its entries */
  workspaces: Readonly<Record<string, readonly ImportManifestEntry[]>>;
  lastRun?: string;
}

// =======================================================================================
// 2. the widenings — each merges into an existing src/core/types.ts declaration at 1.6
// =======================================================================================

/**
 * §7.1 row 1, widening 1: `InstructionRecord += kind?, scope?`. Declared here as a distinct type
 * because `src/core/types.ts` is not edited on this branch; at 1.6 the two members are added to
 * `InstructionRecord` itself and this alias is deleted.
 */
export interface ImportedInstructionRecord {
  path: string;
  sha256: string;
  bytes: number;
  kind?: MemoryKind;
  scope?: 'user' | 'project' | 'project-local';
}

/**
 * §7.1 row 1, widening 2: `EngineOptions.memory?: {index?, rules?, topics?}`. At 1.6 this becomes
 * the type of a new optional `memory` member on `EngineOptions`.
 */
export interface EngineMemoryOptions {
  /** the `## Memory (index)` system-prompt section, already capped at `memoryIndexPromptBytes` */
  index?: string;
  /** rule files the per-step matcher may activate (§2.10.4) */
  rules?: readonly MemoryItem[];
  /** topic headers; bodies are read on demand */
  topics?: readonly MemoryItem[];
}

/**
 * §7.1 row 1, widening 3: `NoticeKind += 'import'`. At 1.6 the literal joins the `NoticeKind`
 * union in `src/core/types.ts`; until then engine notices carry it through this alias.
 */
export type ImportNoticeKind = 'import';

/**
 * §7.1 row 1, widening 4: `RunMeta.imports?: readonly string[]` — the import ids folded into a run.
 */
export type RunMetaImports = readonly string[];

/**
 * §7.1 row 1, amendment: `CheckpointState.kept?[].kind += 'memory'`. `kept` itself is a
 * coordination-design addition (CD :1174), so this is an amendment to that row [G2.2], not an
 * independent change.
 */
export type KeptMemoryKind = 'memory';

// =======================================================================================
// 3. engine-local — stays in src/import/, never moves to src/core/types.ts
// =======================================================================================

/** §3.1: where a detector looks. The override is checked BEFORE the default, in order. */
export interface RootSpec {
  kind: 'home' | 'repo' | 'managed';
  /** e.g. `['CLAUDE_CONFIG_DIR']`; the report names which one fired */
  envOverride?: readonly string[];
  /** `~/.claude` | `<repo>` | `/Library/Application Support/Claude` */
  path: string;
  platform?: readonly NodeJS.Platform[];
  /** §3.4: `OPENCODE_DATA_DIR` is comma-separated; all roots are scanned and deduped by realpath */
  splitOnComma?: boolean;
}

/** §2.2 / §3: where a row of one atlas kind lands. `null` = report-only. */
export interface DestinationSpec {
  kind: 'agents-append' | 'memory-topic' | 'memory-local' | 'memory-index' | 'rule' | 'command' | 'mcp' | 'report-only';
  /** `user` rows land under `~/.config/jevcode/`, project rows under `<repo>/.jevcode/` */
  scope: 'user' | 'project' | 'project-local';
}

/** §3.1: one row of the atlas — the only place a tool's knowledge lives. */
export interface SourceSpec {
  /** e.g. `claude.auto-memory.topic` */
  id: string;
  tool: SourceTool;
  /** human label for the report */
  artefact: string;
  roots: readonly RootSpec[];
  /** glob, relative to the root */
  pattern: string;
  format: SourceFormat;
  /** the rule-1 verdict (§4.4.1) */
  class: ImportClass;
  scope: SourceScope;
  destination: DestinationSpec;
  /** within a tool, for "first match wins" chains */
  precedence?: number;
  /** rendered in the report when the row is skipped */
  notes?: readonly string[];
  /** §4.2.6: only scanned when `--source <id>` names it */
  optIn?: string;
}

/** §3.1: the resolved form of one `RootSpec` on this machine. */
export interface ResolvedRoot {
  tool: SourceTool;
  kind: RootSpec['kind'];
  /** absolute */
  path: string;
  display: string;
  via: 'default' | 'env';
  env?: string;
  exists: boolean;
}

/** §4.3: every parser is tolerant and total — it returns this, it never throws. */
export type ParseResult<T> = { ok: true; value: T; warnings: readonly string[] } | { ok: false; error: string; warnings: readonly string[] };

/** §4.3 `frontmatter.ts`: scalars, lists and **one** nesting level (`metadata:`). */
export type FrontmatterValue = string | number | boolean | readonly string[] | Readonly<Record<string, string | number | boolean>>;
export interface Frontmatter {
  /** insertion-ordered keys, for `parse.frontmatterKeys` */
  keys: readonly string[];
  values: Readonly<Record<string, FrontmatterValue>>;
  /** byte offset in the source where the body starts */
  bodyOffset: number;
  /** a `---` block that did not close, or a line that did not parse: body still imported */
  broken: boolean;
}

/** §4.3 `markdown.ts`: one executable segment found in a body, to be fenced inert (§2.6). */
export interface ExecutableSegment {
  form: 'backtick-bang' | 'fence-bang' | 'brace-bang' | 'at-brace' | 'dollar-paren' | 'backtick-cmd';
  start: number;
  end: number;
  /** the command text, kept only so the fence can reproduce it verbatim as inert text */
  text: string;
}

/** §4.3 `markdown.ts`: an `@path` reference outside every fence and code span. */
export interface ImportRef {
  /** the raw reference as written, e.g. `@~/notes.md` */
  raw: string;
  target: string;
  start: number;
  end: number;
}

/** §4.3 `markdown.ts`: the normalised document the classifier, the deduper and Jev see. */
export interface MarkdownDoc {
  /** BOM-stripped, CRLF-normalised, bidi-stripped, ANSI-stripped */
  text: string;
  /** how many control characters the normalisation removed */
  controlsRemoved: number;
  frontmatter: Frontmatter | null;
  /** at most `jevHeadings`, each clipped to `jevHeadingCells` */
  headings: readonly string[];
  lines: number;
  fences: number;
  executables: readonly ExecutableSegment[];
  refs: readonly ImportRef[];
  /** normalised token set (§4.4.3 group III) — lowercase, punctuation dropped, frontmatter stripped */
  tokens: readonly string[];
  /** sha256 of the normalised text, the exact-dedupe key (§4.5 pass 1) */
  normalisedSha256: string;
  /** `minhashBands` 32-bit band signatures, the near-dedupe bucket key [G1.6] */
  bands: readonly string[];
}

/** §4.4.2: one leaf of a parsed config object, addressed by its dotted path. */
export interface ConfigLeaf {
  /** `['env', 'ANTHROPIC_API_KEY']` — quoted TOML table keys survive as one segment */
  path: readonly string[];
  /** dotted rendering of `path`, for the report and the Jev state */
  dotted: string;
  value: Json;
}

/** §4.4.2 rule 8 / §4.4.3 group I: the shape of a candidate value. Retains **no substring** of it. */
export interface ValueShape {
  length: number;
  charset: 'hex' | 'base64url' | 'alnum' | 'mixed' | 'ascii' | 'other';
  /** Shannon entropy bucket, not the value's entropy to full precision */
  entropyBucket: 'low' | 'medium' | 'high';
  /** `sha256(value).slice(0, 8)` — the only form in which a secret is ever displayed (§8.2 R9) */
  fingerprint: string;
  /** the `detectSecrets` family name when a pattern recognised it */
  family: string | null;
  /** true when the whole value is a pure `${VAR}` / `{env:VAR}` / `$VAR` / `%VAR%` reference */
  reference: boolean;
}

/** §4.2: the read-only filesystem seam. Every call the engine makes goes through one of these. */
export interface ImportFs {
  readdir(path: string): Promise<readonly { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }[]>;
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; size: number; mtimeMs: number; mode: number; dev: number; ino: number }>;
  lstat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number; mode: number; dev: number; ino: number }>;
  realpath(path: string): Promise<string>;
  readFile(path: string): Promise<Buffer>;
  /** §4.2.2: opened for the 256 KiB transcript metadata pass only; never for a body */
  readPrefix(path: string, bytes: number): Promise<Buffer>;
}

/**
 * §4.7: the write seam the CLI supplies (§0 contract). `src/import/**` performs no writes of its
 * own — `apply.ts` calls these, and the harness can therefore land the whole engine without
 * touching a file the TUI session owns.
 */
export interface ImportWriteFs extends ImportFs {
  writeFile(path: string, data: string, opts: { mode: number; mkdir: boolean }): Promise<void>;
  appendFile(path: string, data: string, opts: { mode: number; mkdir: boolean }): Promise<void>;
  mkdir(path: string, opts: { recursive: true; mode?: number }): Promise<void>;
  rm(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** §4.7.1: `O_EXCL` create; resolves false when the file already exists */
  createExclusive(path: string, data: string, mode: number): Promise<boolean>;
}

/** §4.2: the clock seam, so every artefact timestamp is deterministic under test. */
export interface ImportClock {
  now(): Date;
  /** monotonic milliseconds, for `walkMs` and the probe deadline */
  monotonicMs(): number;
}

/** §4.2.1: the environment the roots are resolved against. Nothing reads `process.env` directly. */
export interface ImportEnvironment {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** the workspace, and its git root when there is one */
  workspace: string;
  gitRoot: string | null;
  /** every `--from <path>`, already absolute */
  extraRoots: readonly string[];
}
