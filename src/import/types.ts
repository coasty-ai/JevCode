/**
 * docs/IMPORT-DESIGN.md §7.1 row 1 — the import contract.
 *
 * LANDED AT contract 1.6 (2026-09-22). The 22 shapes section 1 used to declare here now live in
 * `src/core/types.ts` under the `// contract 1.6` header, which sits directly after coordination's
 * 1.4 and orchestration's 1.5 exactly as §7.1 [G2.2] requires ("the import additions to
 * src/core/types.ts go after coordination's round-3 contract line"). This file re-exports every one
 * of them, so `src/import/**` and its tests keep the single import they were written against and no
 * other module moved.
 *
 * The five widenings section 2 used to declare as stand-in aliases are now members of the real
 * declarations, and the aliases are gone: `InstructionRecord += kind?, scope?`;
 * `EngineOptions.memory?: EngineMemoryOptions`; `NoticeKind += 'import'`; `RunMeta.imports?`;
 * `CheckpointState.kept?[].kind += 'memory'` (the `kept` row itself landed with 1.6 as the
 * amendment to COORDINATION-DESIGN §8.6 `:1504` that [G2.2] calls for).
 *
 * Section 3 is engine-local and does **not** move: the atlas shape, the parser results and the
 * seams `src/import/**` is injected with. `src/import/**` imports nothing from `src/tui`,
 * `src/cli`, `src/config`, `src/session` or `src/chat` (§7 ownership), so every root, clock and
 * filesystem call arrives as an argument.
 */
// the four contract shapes section 3's own declarations refer to: `export … from` re-exports do not
// create local bindings, so they are imported as well as re-exported
import type { ImportClass, Json, SourceFormat, SourceScope, SourceTool } from '../core/types.js';

// =======================================================================================
// 1. contract 1.6 — declared in src/core/types.ts, re-exported here
// =======================================================================================

export type {
  CannotRead,
  ImportAction,
  ImportClass,
  ImportManifest,
  ImportManifestEntry,
  ImportPlan,
  ImportProbe,
  ImportSkipAction,
  McpFile,
  McpServerRecord,
  MemoryItem,
  MemoryKind,
  MemoryProvenance,
  PlanRoot,
  PlanRow,
  ProjectCommand,
  RuleTrigger,
  SourceFormat,
  SourceItem,
  SourceParse,
  SourceScope,
  SourceTool,
} from '../core/types.js';

// =======================================================================================
// 2. the widenings — members of the real src/core/types.ts declarations since 1.6
// =======================================================================================

/**
 * §7.1 row 1, widening 2: the type of `EngineOptions.memory`. Re-exported rather than re-declared,
 * because `src/loop/**` and `src/provider/**` read it from the contract and `src/import/**` produces it.
 */
export type { EngineMemoryOptions, MemoryUsage } from '../core/types.js';

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
  /**
   * Review defect 7: `Buffer` is accepted so a destination and its `pre/` snapshot survive
   * **byte for byte**. Round-tripping arbitrary bytes through `toString('utf8')` replaces every
   * invalid sequence with U+FFFD, which corrupted a latin-1 `AGENTS.md` (`e9` → `ef bf bd`) and
   * mangled its snapshot too, so undo then refused to restore it. `apply.ts` reads and writes
   * destinations as `Buffer`, and **demotes a destination that is not valid UTF-8 to `review`
   * rather than rewriting it** — the widening makes the snapshot honest, it does not license
   * writing rendered text into a non-UTF-8 file.
   */
  writeFile(path: string, data: string | Buffer, opts: { mode: number; mkdir: boolean }): Promise<void>;
  /** Text only: every appender in the engine (`apply.jsonl`, the marker blocks) renders UTF-8. */
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
