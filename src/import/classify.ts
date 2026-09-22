/**
 * Classification (docs/IMPORT-DESIGN.md §4.4): the **12 file rules** of §4.4.1 and the **9 key
 * rules** of §4.4.2, both total, both deterministic, both first-match-wins.
 *
 * §0 principle 2 — *code decides, Jev disambiguates inside a declared band*: every rule publishes
 * its own confidence `p`, and `p` is used for nothing except deciding whether the row enters the
 * band that Jev question group II is asked for. §0 principle 5 — classification is per **key**,
 * not per file: one `settings.json` is simultaneously WORKFLOW (`hooks`), CONFIG (`permissions`)
 * and SECRET (`env.ANTHROPIC_API_KEY`).
 *
 * Pure: no I/O, no clock, no `process.env`. Every fact about a file arrives as data on
 * `FileInput`, so this module compiles and tests independently of the parsers (W1).
 *
 * ## Rule order: the identity rules run **before** the atlas class
 *
 * `classifyFile` runs the five *identity* rules — `skip:self` / `skip:third-party` /
 * `skip:tool-managed` (1), secret basename (2), oversize (3), not-text (4), unsupported format
 * (5) — ahead of "the atlas row declares a class", which is **rule 6**. §4.4.1 as originally
 * written put the atlas class first, and that ordering is judged wrong: every artefact the
 * discovery pass yields comes *from* an atlas row, so rule 1 always fired and rules 2–6 were
 * unreachable dead code. `skip:self`, `skip:third-party`, `skip:tool-managed`, the
 * secret-basename rule, `skip:oversize` and `skip:not-text` could not be produced at all, and
 * once the atlas destinations are wired the repository's own `AGENTS.md` — which *is* a
 * destination — would have been read as a source and appended to itself on every run.
 *
 * The departure is principled, not just a bug fix: identity answers *"this is not the human's
 * own importable content"* — it is our own output, a vendor's bundle, a file a tool manages for
 * itself, a credential store, too large to read, or not text at all. No declared class can
 * override any of those, because the atlas says what a file **is about**, never whether it is
 * ours to read. Reviewed and accepted 2026-09-22 (`docs/research/import/review-engine-2026-09-22.md`
 * defect 11); the coordinator has amended §4.4.1 to match, and the rule numbers below — 1–5
 * identity, 6 atlas, 7–12 content, unchanged — are that amended table's.
 *
 * ### Amendment, ratified 2026-09-22: the never-imported atlas classes join rule 2
 *
 * The atlas classes that are never imported at all (`transcript`, `secret`, `skip`) used to be
 * answered with the declared class at rule 6, which put them *below* oversize, not-text and
 * unsupported. An oversize transcript therefore reported `skip:oversize` — true, but naming the
 * cap instead of the thing the human can act on, and ~20 of the 3,371 real transcripts of §3.12
 * are over the 4 MiB cap, so it was the common case rather than a corner. They now answer at
 * **rule 2**, immediately after the secret-basename rule: a file we are never going to read
 * cannot have its verdict changed by its size, its encoding, or whether a parser claims its
 * format. They stay *below* the secret-basename rule so a credential store is still reported as
 * a secret by name rather than by whichever atlas row happened to match it.
 */
import { IMPORT_LIMITS } from '../core/limits.js';
import type { Json } from '../core/types.js';
import { isSecretBasename } from '../sandbox/paths.js';
import { EXEC_PATHS, MCP_PATHS, PERMISSION_PATHS, classifyValue, matchesPath } from './secrets.js';
import type { ConfigLeaf, Frontmatter, ImportClass, ImportSkipAction, MarkdownDoc, SourceFormat, SourceItem, SourceSpec, ValueShape } from './types.js';

export { NON_SECRET_LEAF_NAMES } from './secrets.js';

// ---------------------------------------------------------------------------------------
// §4.4.1 — the 12 file rules
// ---------------------------------------------------------------------------------------

/** The outcome of one classification: a class or a named skip, its rule number, its confidence, and whether it is in the band. */
export interface FileVerdict {
  class: ImportClass;
  skip: ImportSkipAction | null;
  rule: number;
  p: number;
  band: boolean;
  why: string;
}

/**
 * Everything the 12 rules read. `doc` and `frontmatter` are the W1 parser results carried as
 * **data**, never fetched: `classifyFile` never calls a parser and never touches disk.
 * `isDestination` is set by the caller from the destination set it built before classify
 * (§6 row 9) — a file is never appended to itself.
 */
export interface FileInput {
  item: SourceItem;
  spec?: SourceSpec | undefined;
  doc?: MarkdownDoc | undefined;
  frontmatter?: Frontmatter | null | undefined;
  isDestination?: boolean;
}

/** §4.4.1: `0.5 ≤ p < 0.7`. Only rows 11 and 12 fall in it, and Jev group II is asked for exactly those. */
export const FILE_BAND = { lo: 0.5, hi: 0.7 } as const satisfies { readonly lo: 0.5; readonly hi: 0.7 };

/**
 * §4.4.1: the two banded rows. The design states the band as the interval `[0.5, 0.7)` *and*
 * names rows 11 and 12 as its only members, while printing row 12's own `p` as `0.45`. The
 * membership sentence governs — row 12 (`skip:unrelated`, the "everything else" row) is precisely
 * the row a human most often disagrees with, and `--all` exists to promote it.
 */
export const BAND_RULES: readonly number[] = [11, 12];

/** §4.4.1 rule 7: a frontmatter key in this set makes the file a path-scoped rule. */
const RULE_KEYS: readonly string[] = ['paths', 'globs', 'applyTo', 'trigger', 'alwaysApply'];
/** §4.4.1 rule 8: a frontmatter key in this set makes the file an invokable workflow. */
const COMMAND_KEYS: readonly string[] = ['argument-hint', 'argumentHint', 'arguments', 'allowed-tools', 'allowedTools', 'mode', 'template', 'prompt'];
/** §4.4.1 rule 8: …or an argument substitution in the body. */
const ARGUMENT_RE = /\$ARGUMENTS\b|\$[1-9]\b/;

/** §4.4.1 rule 6: the three formats no parser claims. */
const UNSUPPORTED_FORMATS: readonly SourceFormat[] = ['js', 'sh', 'sqlite'];

/** §6 row 54: vendor-bundled artefacts — only the human's own `skills/<n>/` is imported. */
const THIRD_PARTY_RE = /(^|\/)(skills|prompts|commands)\/\.system\/|(^|\/)node_modules\//;
/** Files a tool writes about itself; never the human's content. */
const TOOL_MANAGED_RE = /(^|\/)(statsig|shell-snapshots|todos|ide|\.venv|__pycache__)\/|(^|\/)\.DS_Store$/;

/** §4.4.1 rule 10: the line ceiling above which a markdown file stops reading as one standing instruction. */
const RULE10_MAX_LINES = 2_000;
/** §4.4.1 rule 11: the line ceiling of the headingless banded row. */
const RULE11_MAX_LINES = 200;

const MARKDOWN_FORMATS: readonly SourceFormat[] = ['md', 'mdc'];

/** §4.4.0: the two declared classes that are never imported, and the named skip each becomes. */
const ALWAYS_SKIP: Readonly<Record<string, ImportSkipAction>> = { transcript: 'skip:transcript', secret: 'skip:secret', skip: 'skip:unsupported' };

function basenameOf(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i === -1 ? norm : norm.slice(i + 1);
}

function thousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The class a skipped row keeps (§4.4.0: "the row keeps its source class"), when no atlas row declared one. */
function classFromFormat(format: SourceFormat): Exclude<ImportClass, 'skip'> {
  switch (format) {
    case 'jsonl':
      return 'transcript';
    case 'json':
    case 'jsonc':
    case 'toml':
    case 'yaml':
      return 'config';
    case 'js':
    case 'sh':
      return 'command';
    case 'sqlite':
      return 'config';
    default:
      return 'memory';
  }
}

/**
 * §4.4.1 rule 5: "not valid UTF-8 after BOM strip, or contains a NUL in the first 8 KiB". The
 * decode itself belongs to the reader (W1 `markdown.ts`); classify sees its verdict as data —
 * a NUL inside the normalised text, or a parse error naming the condition, or a discovery notice.
 */
function isNotText(input: FileInput): boolean {
  const { item, doc } = input;
  if (doc && doc.text.slice(0, IMPORT_LIMITS.binarySniffBytes).includes('\u0000')) return true;
  if (item.parse.error !== undefined && /not text|not valid utf|invalid utf-?8|binary|\bNUL\b/i.test(item.parse.error)) return true;
  return item.notices.some((n) => /not text|invalid utf-?8|\bNUL\b/i.test(n));
}

function frontmatterKeys(input: FileInput): readonly string[] {
  if (input.frontmatter) return input.frontmatter.keys;
  if (input.doc?.frontmatter) return input.doc.frontmatter.keys;
  return input.item.parse.frontmatterKeys ?? [];
}

function frontmatterValues(input: FileInput): Readonly<Record<string, unknown>> {
  const fm = input.frontmatter ?? input.doc?.frontmatter ?? null;
  return fm ? fm.values : {};
}

function hasKey(keys: readonly string[], want: readonly string[]): string | null {
  for (const k of want) if (keys.includes(k)) return k;
  return null;
}

function bodyHasArguments(input: FileInput): boolean {
  if (input.doc) return ARGUMENT_RE.test(input.doc.text);
  return false;
}

function headingCount(input: FileInput): number {
  if (input.doc) return input.doc.headings.length;
  return input.item.parse.headings?.length ?? 0;
}

function lineCount(input: FileInput): number {
  if (input.doc) return input.doc.lines;
  return input.item.parse.lines ?? 0;
}

function verdict(v: FileVerdict): FileVerdict {
  return v;
}

/**
 * §4.4.1 (amended 2026-09-22): the 12 rules, in order, first match wins. **Total** — every input
 * leaves with exactly one verdict, and "unknown" is always a named `skip:*`, never a silent
 * bucket (§4.4.0).
 *
 * Two readings the table leaves implicit are made explicit here and nowhere else:
 * - **rule 1** is the identity rule: a realpath that is one of our own destinations
 *   (`skip:self`, §6 row 9), a vendor-bundled path (`skip:third-party`, §6 row 54) and a path a
 *   tool manages for itself (`skip:tool-managed`). All three say *"this file is not the human's
 *   own content"*, and the table has no other row for the last two.
 * - **rule 6** carries the qualifier *"and the parse succeeded"*; the failing branch is the named
 *   `skip:parse-error` of §6 row 28, attributed to rule 6. A parse error that *names* a decode
 *   failure is `skip:not-text` at rule 4 instead — the more specific reason wins, as §6 rows
 *   24–25 require.
 *
 * See the module header for why the identity rules precede the atlas class.
 */
export function classifyFile(input: FileInput): FileVerdict {
  const { item, spec } = input;
  const name = basenameOf(item.realpath);
  const fallbackClass = classFromFormat(item.format);

  // 1 — identity: our own destination, a bundled artefact, a tool-managed file
  if (input.isDestination === true) {
    return verdict({ class: fallbackClass, skip: 'skip:self', rule: 1, p: 1, band: false, why: 'rule 1 (realpath is a destination)' });
  }
  if (THIRD_PARTY_RE.test(item.realpath.replace(/\\/g, '/'))) {
    return verdict({ class: fallbackClass, skip: 'skip:third-party', rule: 1, p: 1, band: false, why: 'rule 1 (bundled; only your own skills import)' });
  }
  if (TOOL_MANAGED_RE.test(item.realpath.replace(/\\/g, '/'))) {
    return verdict({ class: fallbackClass, skip: 'skip:tool-managed', rule: 1, p: 1, band: false, why: 'rule 1 (the tool manages this file itself)' });
  }

  // 2 — a secret basename is named, never read
  if (isSecretBasename(name)) {
    return verdict({ class: 'secret', skip: 'skip:secret', rule: 2, p: 1, band: false, why: `rule 2 (secret basename ${name}; named, not read)` });
  }

  // 2 (cont.) — an atlas class that is NEVER imported, whatever the file turns out to be.
  //
  // Ratified 2026-09-22: this branch is hoisted ABOVE oversize/not-text/unsupported. It used to
  // live with the atlas class at rule 6, which meant a transcript over 4 MiB reported
  // `skip:oversize` — true but useless, since ~20 of the author's 3,371 transcripts are over the
  // cap and the report would have named the cap rather than the reason the human cares about
  // (`jevcode import --source claude-transcripts`). "Never imported" is an identity statement
  // like the three above it: the size, encoding and parser availability of a file we are never
  // going to read cannot change the verdict, so they must not be consulted first.
  //
  // It stays BELOW the secret-basename rule so a credential store is still reported as a secret
  // by name rather than by whichever atlas row happened to match it.
  const never = spec && spec.class ? ALWAYS_SKIP[spec.class] : undefined;
  if (spec && never !== undefined) {
    const cls = spec.class === 'skip' ? fallbackClass : spec.class;
    return verdict({ class: cls, skip: never, rule: 2, p: 1, band: false, why: `rule 2 (atlas ${spec.id}; never imported)` });
  }

  // 3 — oversize
  if (item.bytes > IMPORT_LIMITS.sourceReadCapBytes) {
    return verdict({
      class: fallbackClass,
      skip: 'skip:oversize',
      rule: 3,
      p: 1,
      band: false,
      why: `rule 3 (${thousands(item.bytes)} bytes; larger than ${IMPORT_LIMITS.sourceReadCapBytes / (1024 * 1024)} MiB)`,
    });
  }

  // 4 — not text
  if (isNotText(input)) {
    return verdict({ class: fallbackClass, skip: 'skip:not-text', rule: 4, p: 1, band: false, why: 'rule 4 (not valid UTF-8, or a NUL in the first 8 KiB)' });
  }

  // 5 — a format no parser claims
  if (UNSUPPORTED_FORMATS.includes(item.format)) {
    return verdict({ class: fallbackClass, skip: 'skip:unsupported', rule: 5, p: 1, band: false, why: `rule 5 (format ${item.format})` });
  }

  // 6 — the atlas row declares a class and the parse succeeded
  if (spec && spec.class) {
    if (!item.parse.ok) {
      const reason = item.parse.error ?? 'unparsable';
      return verdict({ class: fallbackClass, skip: 'skip:parse-error', rule: 6, p: 1, band: false, why: `rule 6 (atlas ${spec.id}) — parse error: ${reason}` });
    }
    // the never-imported classes were already answered at rule 2, above; only importable
    // classes reach here
    return verdict({ class: spec.class, skip: null, rule: 6, p: 1, band: false, why: `rule 6 (atlas ${spec.id})` });
  }

  const keys = frontmatterKeys(input);

  // 7 — a path-scoped rule
  const ruleKey = hasKey(keys, RULE_KEYS);
  if (ruleKey !== null) {
    return verdict({ class: 'rule', skip: null, rule: 7, p: 0.95, band: false, why: `rule 7 (frontmatter ${ruleKey})` });
  }

  // 8 — an invokable workflow
  const commandKey = hasKey(keys, COMMAND_KEYS);
  if (commandKey !== null) {
    return verdict({ class: 'command', skip: null, rule: 8, p: 0.9, band: false, why: `rule 8 (frontmatter ${commandKey})` });
  }
  if (bodyHasArguments(input)) {
    return verdict({ class: 'command', skip: null, rule: 8, p: 0.9, band: false, why: 'rule 8 (body contains $ARGUMENTS or $1)' });
  }

  // 9 — a learned note: name + description + a type, flat or nested (§2.3)
  const values = frontmatterValues(input);
  const hasType = keys.includes('type') || keys.includes('metadata.type') || (typeof values['metadata'] === 'object' && values['metadata'] !== null && 'type' in (values['metadata'] as Record<string, unknown>));
  if (keys.includes('name') && keys.includes('description') && hasType) {
    return verdict({ class: 'memory', skip: null, rule: 9, p: 0.9, band: false, why: 'rule 9 (frontmatter name+description+metadata.type)' });
  }

  const isMarkdown = MARKDOWN_FORMATS.includes(item.format);
  const headings = headingCount(input);
  const lines = lineCount(input);

  // 10 — a markdown document with structure
  if (isMarkdown && headings >= 1 && lines <= RULE10_MAX_LINES && !bodyHasArguments(input)) {
    return verdict({ class: 'memory', skip: null, rule: 10, p: 0.75, band: false, why: `rule 10 (markdown, ${headings} heading${headings === 1 ? '' : 's'}, ${thousands(lines)} lines)` });
  }

  // 11 — a short headingless note: the first banded row
  if (isMarkdown && headings === 0 && lines <= RULE11_MAX_LINES) {
    return verdict({ class: 'memory', skip: null, rule: 11, p: 0.55, band: true, why: `rule 11 (markdown, no heading, ${thousands(lines)} lines)` });
  }

  // 12 — everything else: the second banded row
  return verdict({ class: fallbackClass, skip: 'skip:unrelated', rule: 12, p: 0.45, band: true, why: 'rule 12 (no rule matched)' });
}

// ---------------------------------------------------------------------------------------
// §4.4.2 — the 9 key rules
// ---------------------------------------------------------------------------------------

/** §4.4.2: one key's verdict. `shape` never holds a substring of the value (see `secrets.ts`). */
export interface KeyVerdict {
  leaf: ConfigLeaf;
  class: ImportClass;
  kind: 'secret' | 'reference' | 'permission' | 'exec' | 'mcp' | 'config';
  rule: number;
  band: boolean;
  why: string;
  shape: ValueShape | null;
}

function isUnderMcp(dotted: string): boolean {
  return matchesPath(dotted, MCP_PATHS);
}

/**
 * §4.4.2: the 9 rules, per **key**, first match wins. Pure, and it **never retains a value** —
 * the only thing that survives a call is a `ValueShape` (length, charset, entropy bucket,
 * `sha256[0..8]`, family, reference flag).
 *
 * Rule 3 runs before the band, so anything a `detectSecrets` family recognises is a secret
 * without asking anyone; rule 8's allowlist is what keeps a 64-hex `sha256` out of the band.
 */
export function classifyKey(leaf: ConfigLeaf): KeyVerdict {
  const leafName = leaf.path[leaf.path.length - 1] ?? leaf.dotted;
  const v = classifyValue(leaf.dotted, leafName, leaf.value);

  if (v.secret) return { leaf, class: 'secret', kind: 'secret', rule: v.rule, band: false, why: v.why, shape: v.shape };
  if (v.rule === 4) return { leaf, class: 'config', kind: 'reference', rule: 4, band: false, why: v.why, shape: v.shape };

  if (matchesPath(leaf.dotted, PERMISSION_PATHS)) {
    return { leaf, class: 'config', kind: 'permission', rule: 5, band: false, why: `key rule 5 (permission set: ${leaf.dotted}) — never written`, shape: v.shape };
  }
  if (matchesPath(leaf.dotted, EXEC_PATHS) && !(leafName === 'command' && isUnderMcp(leaf.dotted))) {
    return { leaf, class: 'command', kind: 'exec', rule: 6, band: false, why: `key rule 6 (hook/exec set: ${leaf.dotted}) — report only`, shape: v.shape };
  }
  if (isUnderMcp(leaf.dotted)) {
    return { leaf, class: 'mcp', kind: 'mcp', rule: 7, band: false, why: `key rule 7 (mcp set: ${leaf.dotted})`, shape: v.shape };
  }
  if (v.band) {
    return { leaf, class: 'config', kind: 'config', rule: 8, band: true, why: v.why, shape: v.shape };
  }
  return { leaf, class: 'config', kind: 'config', rule: 9, band: false, why: v.why, shape: v.shape };
}

/** §4.4.2: every leaf of one parsed config, in walk order. */
export function classifyConfig(leaves: readonly ConfigLeaf[]): readonly KeyVerdict[] {
  return leaves.map(classifyKey);
}

// ---------------------------------------------------------------------------------------
// The dotted-path walk
// ---------------------------------------------------------------------------------------

/** §4.4.2: how many leaves one config file may contribute before the walk stops. */
export const MAX_LEAVES = 5_000;

/**
 * §4.4.2: walk a parsed JSON value into dotted-path leaves. Arrays contribute numeric segments
 * (`notify.0`), so `/(^|\.)notify(\.\d+)?$/` matches an array of hook commands. Empty objects and
 * empty arrays are leaves in their own right, so a `permissions: {}` still appears in the report.
 * Pure and bounded by `maxLeaves`.
 */
export function walkLeaves(value: Json, opts?: { maxLeaves?: number }): readonly ConfigLeaf[] {
  const max = opts?.maxLeaves ?? MAX_LEAVES;
  const out: ConfigLeaf[] = [];
  const seen = new Set<object>();
  const walk = (v: Json, path: readonly string[]): void => {
    if (out.length >= max) return;
    if (v !== null && typeof v === 'object') {
      if (seen.has(v)) return;
      seen.add(v);
      const entries: [string, Json][] = Array.isArray(v) ? v.map((x, i) => [String(i), x] as [string, Json]) : Object.entries(v);
      if (entries.length === 0) {
        if (path.length > 0) out.push({ path, dotted: path.join('.'), value: Array.isArray(v) ? [] : {} });
        return;
      }
      for (const [k, child] of entries) {
        if (out.length >= max) return;
        walk(child, [...path, k]);
      }
      return;
    }
    if (path.length === 0) return;
    out.push({ path, dotted: path.join('.'), value: v });
  };
  walk(value, []);
  return out;
}

// ---------------------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------------------

const EXTENSION_FORMATS: Readonly<Record<string, SourceFormat>> = {
  md: 'md',
  markdown: 'md',
  mdc: 'mdc',
  json: 'json',
  jsonc: 'jsonc',
  json5: 'jsonc',
  toml: 'toml',
  yaml: 'yaml',
  yml: 'yaml',
  jsonl: 'jsonl',
  ndjson: 'jsonl',
  sqlite: 'sqlite',
  sqlite3: 'sqlite',
  db: 'sqlite',
  vscdb: 'sqlite',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  ts: 'js',
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
};

/** §4.2.5: the dot-file rule files that are markdown bodies with no extension at all. */
const DOTFILE_MARKDOWN: readonly string[] = ['.cursorrules', '.windsurfrules', '.clinerules', '.aiderrules'];

/**
 * §4.2.5: how a source is read, from its basename alone. A Codex `*.rules` file is `text` — no
 * parser claims it — which is exactly what the `SourceFormat` doc comment says.
 */
export function formatOf(basename: string): SourceFormat {
  const name = basenameOf(basename);
  if (DOTFILE_MARKDOWN.includes(name.toLowerCase())) return 'md';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'text';
  const ext = name.slice(dot + 1).toLowerCase();
  return EXTENSION_FORMATS[ext] ?? 'text';
}
