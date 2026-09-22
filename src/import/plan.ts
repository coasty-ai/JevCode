/**
 * The plan (docs/IMPORT-DESIGN.md §4.5, §4.6.1, §4.7.3 [G1.2], §4.7.5 [G1.3]).
 *
 * Four bounded passes in order — **exact dedupe → minhash-bucketed near dedupe → conflicts →
 * budget** — then the destination, the slug, the re-run matrix and the action for every row.
 * The result is an `ImportPlan`: the artefact phases 1–3 produce, and the thing `report.ts`
 * renders. *The report is the plan* (§0 principle 9).
 *
 * **Pure.** No I/O, no clock, no `process.env`, no writes. Every fact about the filesystem — the
 * parsed document, the manifest, the current state of each destination — arrives as data on
 * `PlanInput`, which is what makes §1 property 1 ("writes only under `~/.jevcode/imports/<id>/`")
 * structurally true of this module rather than merely tested.
 *
 * **No field of `PlanRow` can hold a value** (§4.6.1, §1 property 4): nothing here copies a
 * config value, a body or a credential anywhere.
 */
import { sha256Hex } from '../core/hash.js';
import { IMPORT_LIMITS } from '../core/limits.js';
import type { Answer } from '../core/types.js';
import type { FileVerdict, KeyVerdict } from './classify.js';
import { resolveChoice, resolveNoul, resolveScore } from './questions.js';
import type { ConflictCandidate, NoteCandidate, PairCandidate } from './questions.js';
import { joinSecretVerdict } from './secrets.js';
import type {
  CannotRead,
  DestinationSpec,
  Frontmatter,
  ImportAction,
  ImportClass,
  ImportManifest,
  ImportManifestEntry,
  ImportPlan,
  ImportSkipAction,
  MarkdownDoc,
  PlanRoot,
  PlanRow,
  SourceItem,
  SourceTool,
} from './types.js';

// ---------------------------------------------------------------------------------------
// §4.7.3 [G1.2] — destination confinement starts with the name
// ---------------------------------------------------------------------------------------

/** §6 row 85: the Windows device names, refused whatever their extension. */
const RESERVED_NAMES = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9']);

const SLUG_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * §4.7.3 **[G1.2]**, step 1 of three: destination names come from source-controlled frontmatter
 * `name:` and source filenames, so every basename is sanitised before it is ever joined to a
 * path. NFKC, lowercase, `[^a-z0-9-] → '-'`, trim, `slice(0, slugMaxChars)`.
 *
 * Falls back to `sha256(fallbackSeed)[0..8]` for: an empty result, `.`, `..`, a pure-punctuation
 * or over-long name, a Windows device name (`CON`, `NUL`, `COM1`…`LPT9`, with or without an
 * extension) and a name ending in `.` or a space (§6 row 85). The output can never contain `/`,
 * `\` or `..`, so `name: ../../.git/hooks/pre-commit` cannot leave the destination tree.
 *
 * Pure and total; the confinement assertion and the symlink refusal are steps 2 and 3, in
 * `apply.ts`.
 */
export function slugOf(name: string, fallbackSeed: string): string {
  const fallback = (): string => sha256Hex(fallbackSeed).slice(0, 8);
  if (typeof name !== 'string' || name.length === 0) return fallback();
  if (/[. ]$/.test(name)) return fallback();
  const stem = name.replace(/\\/g, '/').split('/').pop() ?? name;
  if (RESERVED_NAMES.has(stem.split('.')[0]?.toLowerCase() ?? '')) return fallback();
  const s = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, IMPORT_LIMITS.slugMaxChars)
    .replace(/-+$/g, '');
  if (s.length === 0 || s === '.' || s === '..') return fallback();
  if (RESERVED_NAMES.has(s)) return fallback();
  return SLUG_SHAPE.test(s) ? s : fallback();
}

/** §6 row 85: every *displayed* path and every `paths:` glob uses `/`; the real path keeps the platform separator. */
export function displayPath(p: string): string {
  return p.replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------------------
// §2.5 — glob expansion and its budget
// ---------------------------------------------------------------------------------------

function expandBraces(pattern: string, budget: number): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  let depth = 0;
  let close = -1;
  const parts: string[] = [];
  let start = open + 1;
  for (let i = open; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        parts.push(pattern.slice(start, i));
        close = i;
        break;
      }
    } else if (ch === ',' && depth === 1) {
      parts.push(pattern.slice(start, i));
      start = i + 1;
    }
  }
  if (close === -1) return [pattern];
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const out: string[] = [];
  for (const part of parts) {
    if (out.length > budget) break;
    out.push(...expandBraces(`${head}${part}${tail}`, budget));
  }
  return out;
}

/**
 * §2.5: brace-expand a rule's globs, then cap the list at `rulePatterns` (200) with a warning —
 * *"expanded, then capped"*, in that order, so `src/**\/*.{ts,tsx,js,jsx,mjs,cjs}` becomes six
 * patterns rather than one uncountable one (§6 row 62). Separators are normalised to `/`.
 */
export function expandGlobs(patterns: readonly string[], max: number = IMPORT_LIMITS.rulePatterns): { patterns: readonly string[]; capped: boolean } {
  const out: string[] = [];
  const seen = new Set<string>();
  let overflow = false;
  for (const raw of patterns) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    for (const p of expandBraces(displayPath(raw), max * 2)) {
      if (seen.has(p)) continue;
      seen.add(p);
      if (out.length >= max) {
        overflow = true;
        continue;
      }
      out.push(p);
    }
  }
  return { patterns: out, capped: overflow };
}

// ---------------------------------------------------------------------------------------
// §4.5 passes 1 and 2 — dedupe
// ---------------------------------------------------------------------------------------

/** §4.4.3 group III: the Jaccard band. Below `lo` the two are different; at or above `hi` they are the same; between, Jev is asked. */
export const JACCARD_BAND = { lo: 0.6, hi: 0.9 } as const;
/** §4.4.3 group V: the conflict precondition's own Jaccard window. */
export const CONFLICT_BAND = { lo: 0.3, hi: 0.9 } as const;

/** Jaccard over two token sets. Pure; `|A ∩ B| / |A ∪ B|`, and 0 when both are empty. */
export function jaccardOf(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

class Union {
  private readonly parent = new Map<string, string>();
  find(x: string): string {
    const p = this.parent.get(x);
    if (p === undefined || p === x) {
      this.parent.set(x, x);
      return x;
    }
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  join(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

/**
 * §4.5 passes 1 and 2, exposed for the tests and the perf gate **[G1.6]**.
 *
 * 1. **Exact dedupe** by normalised sha256 — one group, no Jev.
 * 2. **Near dedupe**: candidates are pre-bucketed by their minhash band signatures so comparisons
 *    stay inside a bucket; the total is capped at `dedupePairs` (20 000). Jaccard ≥ 0.9 joins the
 *    group (no Jev); `[0.6, 0.9)` is reported in `band` for Jev question group III; below 0.6 the
 *    two are different.
 *
 * `groups` holds only the groups of size ≥ 2, each sorted by first appearance; `band` is sorted
 * by `(a, b)` so `same_meaning_<i>` is a stable index into it.
 */
export function dedupe(
  docs: readonly { id: string; sha256: string; bands: readonly string[]; tokens: readonly string[] }[],
  maxPairs: number = IMPORT_LIMITS.dedupePairs,
): { groups: readonly (readonly string[])[]; band: readonly { a: string; b: string; jaccard: number }[]; pairs: number; capped: boolean } {
  const union = new Union();
  const order = new Map<string, number>();
  docs.forEach((d, i) => order.set(d.id, i));

  // pass 1 — exact
  const bySha = new Map<string, string[]>();
  for (const d of docs) {
    const list = bySha.get(d.sha256);
    if (list) list.push(d.id);
    else bySha.set(d.sha256, [d.id]);
  }
  for (const ids of bySha.values()) {
    const first = ids[0];
    if (first === undefined) continue;
    for (const id of ids) union.join(first, id);
  }

  // pass 2 — minhash buckets, then Jaccard inside each bucket
  const tokenSets = new Map<string, ReadonlySet<string>>();
  for (const d of docs) tokenSets.set(d.id, new Set(d.tokens));
  const buckets = new Map<string, string[]>();
  for (const d of docs) {
    const keys = d.bands.length > 0 ? d.bands : ['\u0000no-band'];
    for (const k of keys.slice(0, IMPORT_LIMITS.minhashBands)) {
      const b = buckets.get(k);
      if (b) b.push(d.id);
      else buckets.set(k, [d.id]);
    }
  }

  const band: { a: string; b: string; jaccard: number }[] = [];
  const compared = new Set<string>();
  let pairs = 0;
  let capped = false;
  const bucketKeys = [...buckets.keys()].sort();
  outer: for (const key of bucketKeys) {
    const ids = buckets.get(key) ?? [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i];
        const b = ids[j];
        if (a === undefined || b === undefined) continue;
        const [x, y] = (order.get(a) ?? 0) <= (order.get(b) ?? 0) ? [a, b] : [b, a];
        const pk = `${x}\u0000${y}`;
        if (compared.has(pk)) continue;
        compared.add(pk);
        if (pairs >= maxPairs) {
          capped = true;
          break outer;
        }
        pairs++;
        if (union.find(x) === union.find(y)) continue;
        const j2 = jaccardOf(tokenSets.get(x) ?? new Set(), tokenSets.get(y) ?? new Set());
        if (j2 >= JACCARD_BAND.hi) union.join(x, y);
        else if (j2 >= JACCARD_BAND.lo) band.push({ a: x, b: y, jaccard: j2 });
      }
    }
  }

  const grouped = new Map<string, string[]>();
  for (const d of docs) {
    const root = union.find(d.id);
    const g = grouped.get(root);
    if (g) g.push(d.id);
    else grouped.set(root, [d.id]);
  }
  const groups = [...grouped.values()]
    .filter((g) => g.length > 1)
    .map((g) => [...g].sort((p, q) => (order.get(p) ?? 0) - (order.get(q) ?? 0)))
    .sort((p, q) => (order.get(p[0] ?? '') ?? 0) - (order.get(q[0] ?? '') ?? 0));
  band.sort((p, q) => (order.get(p.a) ?? 0) - (order.get(q.a) ?? 0) || (order.get(p.b) ?? 0) - (order.get(q.b) ?? 0));
  return { groups, band, pairs, capped };
}

// ---------------------------------------------------------------------------------------
// §4.7.5 — the nine-cell re-run matrix
// ---------------------------------------------------------------------------------------

/**
 * §4.7.5: the whole re-run matrix, including **the absent-destination cell [G1.3]** the spine
 * left undefined — without it a deleted destination is skipped forever.
 *
 * | manifest | source sha | markers | destination | action |
 * | --- | --- | --- | --- | --- |
 * | yes | unchanged | present | unchanged | `skip:unchanged` |
 * | yes | changed | present | unchanged | `update` |
 * | yes | unchanged | present | changed outside | `skip:unchanged` |
 * | yes | unchanged | present | changed inside | `review` |
 * | yes | any | missing | exists | `review` |
 * | yes | any | — | absent | `create` |
 * | no | — | present | — | `merge` |
 * | no | — | absent | exists | `append` |
 * | no | — | — | absent | `create` |
 */
export function rerunAction(args: {
  manifestEntry: ImportManifestEntry | null;
  sourceSha256: string;
  destExists: boolean;
  destSha256: string | null;
  markers: readonly string[];
  markerInteriorChanged: boolean;
  /**
   * True only for a destination we SHARE with the human — `AGENTS.md`, `MEMORY.md` — where our
   * bytes sit inside a marker pair and the markers are the only way to tell them apart from
   * theirs. False for a whole-file destination (`memory/<slug>.md`, `rules/<slug>.md`,
   * `commands/<n>.md`), which a `create` writes end to end with no markers in it at all.
   */
  appendable?: boolean;
}): { action: ImportAction; why: string } {
  const { manifestEntry: entry, sourceSha256, destExists, destSha256, markers, markerInteriorChanged } = args;
  const appendable = args.appendable !== false;
  if (entry === null) {
    if (!destExists) return { action: 'create', why: 'no manifest entry, destination absent' };
    if (markers.length > 0) return { action: 'merge', why: `no manifest entry, ${markers.length} import block${markers.length === 1 ? '' : 's'} already present` };
    return { action: 'append', why: 'no manifest entry, destination exists without an import block' };
  }
  if (!destExists) return { action: 'create', why: `destination was removed since ${entry.importId}; re-creating` };

  // Review follow-up D1: a whole-file destination has no markers to look for — demanding one
  // made every `create` come back `review` on the second run, which is §1 property 6's dominant
  // case (on a first import almost nothing exists yet) and told the human their files had been
  // edited when nothing had touched them. The file IS ours end to end, so its own sha is the
  // honest test: unchanged ⇒ nothing to do, source moved on ⇒ rewrite it, destination moved on
  // ⇒ the human edited what we wrote, so hands off.
  if (!appendable) {
    if (destSha256 !== null && destSha256 !== entry.destSha256) {
      return { action: 'review', why: `the destination changed since ${entry.importId}; nothing was written` };
    }
    if (sourceSha256 !== entry.sourceSha256) return { action: 'update', why: 'manifest entry exists, source sha256 changed' };
    return { action: 'skip:unchanged', why: 'manifest entry exists, source and destination sha256 unchanged' };
  }

  if (!markers.includes(entry.importId)) return { action: 'review', why: 'the block was edited or removed; nothing was written' };
  if (markerInteriorChanged) return { action: 'review', why: 'the block was edited; nothing was written' };
  if (sourceSha256 !== entry.sourceSha256) return { action: 'update', why: 'manifest entry exists, source sha256 changed' };
  return { action: 'skip:unchanged', why: 'manifest entry exists, source sha256 unchanged, markers present' };
}

// ---------------------------------------------------------------------------------------
// §4.4.3 group IV — ranking the index
// ---------------------------------------------------------------------------------------

const SCOPE_RANK: Readonly<Record<PlanRow['scope'], number>> = { project: 0, 'project-local': 1, user: 2 };
/**
 * §4.4.3 group IV's fallback order names `kind` (project > rule > preference > feedback >
 * reference), which lives in a topic file's frontmatter and **not** on `PlanRow`. The row-level
 * proxy is `class`, in the same spirit: a rule and a memory outrank a command, an MCP record and
 * a bare config row.
 */
const CLASS_RANK: Readonly<Record<Exclude<ImportClass, 'skip'>, number>> = { memory: 0, rule: 1, command: 2, mcp: 3, config: 4, transcript: 5, secret: 6 };

/**
 * §4.4.3 group IV: the code fallback order — `scope` (project > project-local > user) → `kind`
 * → `modified` desc → `bytes` asc — with the Jev Score in front of it when one was answered.
 * `scores` maps a row id to its **level index**, 0 being the most actionable situation, so
 * ascending is better. Stable and total; it only *orders* the index, it never drops a note.
 */
export function rankIndex(rows: readonly PlanRow[], scores?: Readonly<Record<string, number>>): readonly PlanRow[] {
  const withIndex = rows.map((r, i) => ({ r, i }));
  withIndex.sort((x, y) => {
    if (scores) {
      const sx = scores[x.r.id];
      const sy = scores[y.r.id];
      const nx = sx === undefined ? Number.POSITIVE_INFINITY : sx;
      const ny = sy === undefined ? Number.POSITIVE_INFINITY : sy;
      if (nx !== ny) return nx - ny;
    }
    const sc = SCOPE_RANK[x.r.scope] - SCOPE_RANK[y.r.scope];
    if (sc !== 0) return sc;
    const cl = CLASS_RANK[x.r.class] - CLASS_RANK[y.r.class];
    if (cl !== 0) return cl;
    if (x.r.source.mtimeMs !== y.r.source.mtimeMs) return y.r.source.mtimeMs - x.r.source.mtimeMs;
    if (x.r.bytes !== y.r.bytes) return x.r.bytes - y.r.bytes;
    return x.i - y.i;
  });
  return withIndex.map((w) => w.r);
}

// ---------------------------------------------------------------------------------------
// §4.6.1 — building the plan
// ---------------------------------------------------------------------------------------

/** One discovered artefact, with everything the plan needs about it already parsed (W1) and classified. */
export interface PlanCandidate {
  item: SourceItem;
  verdict: FileVerdict;
  doc?: MarkdownDoc | undefined;
  frontmatter?: Frontmatter | null | undefined;
  keys?: readonly KeyVerdict[] | undefined;
  destination?: DestinationSpec | undefined;
}

/** Everything `buildPlan` reads. Nothing here is fetched: the module is pure. */
export interface PlanInput {
  candidates: readonly PlanCandidate[];
  importId: string;
  at: string;
  jevcodeVersion: string;
  workspace: string;
  workspaceKey: string;
  gitRoot: string | null;
  trust: 'trust' | 'session' | 'none';
  roots: readonly PlanRoot[];
  manifest?: ImportManifest | null;
  /** destination path → its current sha256, so the re-run matrix can be evaluated; absent key = destination absent */
  destState?: Readonly<Record<string, { sha256: string; markers: readonly string[] } | null>>;
  jev?: { answers: Readonly<Record<string, Answer>>; requests: number; questions: number; usd: number; fallbacks: number; reason?: string };
  cannotRead?: readonly CannotRead[];
  notices?: readonly string[];
  scope?: 'user' | 'project' | 'both';
  all?: boolean;
  /** §6 row 83: false when the repository cannot be written to. Taken as input so `plan.ts` stays pure. */
  projectWritable?: boolean;
}

const USER_ROOT = '~/.config/jevcode/';
const PROJECT_ROOT = '.jevcode/';
/** §4.7.5: the two destination kinds an import *appends* a markered block to. */
const APPENDABLE: readonly DestinationSpec['kind'][] = ['agents-append', 'memory-index'];

type RowScope = PlanRow['scope'];

function scopeOf(item: SourceItem, dest: DestinationSpec | undefined): RowScope {
  if (dest) return dest.scope;
  return item.scope === 'managed' ? 'user' : item.scope;
}

function rootFor(scope: RowScope): string {
  return scope === 'user' ? USER_ROOT : PROJECT_ROOT;
}

/** §2.2: where one row lands. `null` is report-only. */
function destinationPath(kind: DestinationSpec['kind'], scope: RowScope, slug: string): string | null {
  const root = rootFor(scope);
  switch (kind) {
    case 'agents-append':
      return scope === 'user' ? `${USER_ROOT}AGENTS.md` : 'AGENTS.md';
    case 'memory-index':
      return `${root}memory/MEMORY.md`;
    case 'memory-topic':
      return `${root}memory/${slug}.md`;
    case 'memory-local':
      return `${PROJECT_ROOT}memory-local/${slug}.md`;
    case 'rule':
      return `${root}rules/${slug}.md`;
    case 'command':
      return `${root}commands/${slug}.md`;
    case 'mcp':
      return `${root}mcp.json`;
    case 'report-only':
      return null;
  }
}

/** §4.7.3: `name:` from the frontmatter when there is one, else the source's own basename stem. */
function nameOf(c: PlanCandidate): string {
  const fm = c.frontmatter ?? c.doc?.frontmatter ?? null;
  const raw = fm?.values['name'];
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  const base = displayPath(c.item.realpath).split('/').pop() ?? c.item.realpath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function fmValue(c: PlanCandidate, key: string): unknown {
  const fm = c.frontmatter ?? c.doc?.frontmatter ?? null;
  return fm ? fm.values[key] : undefined;
}

function asList(v: unknown): readonly string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return [];
}

/** §2.5: the trigger and the globs a rule source maps on to, across the ten source spellings. */
export function ruleSpecOf(c: PlanCandidate): { trigger: 'always' | 'paths' | 'manual'; patterns: readonly string[]; capped: boolean; dropped: number } {
  const alwaysApply = fmValue(c, 'alwaysApply');
  const trigger = fmValue(c, 'trigger');
  const raw = [...asList(fmValue(c, 'globs')), ...asList(fmValue(c, 'paths')), ...asList(fmValue(c, 'applyTo'))];
  const expanded = expandGlobs(raw);
  const dropped = expandGlobs(raw, Number.MAX_SAFE_INTEGER).patterns.length - expanded.patterns.length;
  if (expanded.patterns.length > 0) return { trigger: 'paths', patterns: expanded.patterns, capped: expanded.capped, dropped };
  if (alwaysApply === true || trigger === 'always_on' || trigger === 'always') return { trigger: 'always', patterns: ['**'], capped: false, dropped: 0 };
  if (trigger === 'glob') return { trigger: 'paths', patterns: [], capped: false, dropped: 0 };
  if (trigger === 'model_decision' || trigger === 'manual') return { trigger: 'manual', patterns: [], capped: false, dropped: 0 };
  return { trigger: 'always', patterns: ['**'], capped: false, dropped: 0 };
}

function thousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function kib(bytes: number): string {
  return `${Math.round(bytes / 1024)} KiB`;
}

/** §4.6.1: `sha256(source.id + dest)[0..12]`, with a discriminator when one source yields several rows. */
function rowId(sourceId: string, dest: string | null, discriminator: string): string {
  const key = discriminator.length > 0 ? `${sourceId}\u0000${dest ?? ''}\u0000${discriminator}` : `${sourceId}\u0000${dest ?? ''}`;
  return sha256Hex(key).slice(0, 12);
}

/** The destination cap a class is clipped to (§2.8). */
function capFor(kind: DestinationSpec['kind']): number {
  switch (kind) {
    case 'rule':
      return IMPORT_LIMITS.ruleBytes;
    case 'command':
      return IMPORT_LIMITS.commandBytes;
    case 'agents-append':
      return IMPORT_LIMITS.agentsAppendBytes;
    case 'memory-index':
      return IMPORT_LIMITS.memoryIndexBytes;
    default:
      return IMPORT_LIMITS.topicBytes;
  }
}

/** §2.3: the frontmatter block every imported file carries, as bytes. */
const FRONTMATTER_BYTES = 130;

/** §4.4.3 group II: the five readings and the class each maps on to. */
const KIND_TO_CLASS: Readonly<Record<string, { class: Exclude<ImportClass, 'skip'>; skip: ImportSkipAction | null }>> = {
  instructions_for_an_agent: { class: 'memory', skip: null },
  saved_workflow_or_command: { class: 'command', skip: null },
  tool_configuration: { class: 'config', skip: null },
  conversation_log_or_transcript: { class: 'transcript', skip: 'skip:transcript' },
  unrelated_project_file: { class: 'memory', skip: 'skip:unrelated' },
};

interface Draft {
  candidate: PlanCandidate;
  verdict: FileVerdict;
  tools: SourceTool[];
  scope: RowScope;
  destKind: DestinationSpec['kind'];
  slugBase: string;
  indexLineBytes: number;
  /** §6 row 17: `packages/<n>/**` derived from the source's own directory, when it has one. */
  derivedPaths: readonly string[];
  group?: string | undefined;
  extraWhy: string[];
  warnings: string[];
}

/**
 * §4.5 + §4.6.1: the whole plan phase. Bounded by `planRows` (2 000), `dedupePairs` (20 000),
 * `ruleFiles` (200), `rulePatterns` (200) and the destination caps of §2.8; nothing is truncated
 * silently — every clip adds a `warnings` entry on its row **and** a line in `notices`.
 */
/**
 * §4.4.3 groups III–V: the band candidates this pass found, in **exactly** the order their
 * question ids index. `buildPlan` both fills this and, on a later pass, reads the answers back
 * by the same index — so the two can never disagree, which is the failure review defect 5 was.
 *
 *   `same_meaning_<i>` → `pairs[i]`   `rank_<i>` → `notes[i]`   `contradicts_<i>` → `conflicts[i]`
 *
 * Collected through an out-parameter rather than returned, so the plan shape stays the §4.6.1
 * contract and the two-pass caller pays for one pass, not three: pass 1 fills this **and** names
 * the destinations to stat, pass 2 consumes the answers and the destination state together.
 */
export interface PlanBands {
  pairs: PairCandidate[];
  notes: NoteCandidate[];
  conflicts: ConflictCandidate[];
}

/**
 * §4.4.3 groups III–V: **content-keyed** question ids (review follow-up D2).
 *
 * These used to be ordinals — `rank_0`, `rank_1`, … — assigned while collecting in pass 1 and
 * read back by position in pass 2. But pass 2 runs *after* the duplicate folds pass 1's own
 * answers caused, so the list it re-indexes is shorter: every note after a folded pair shifted
 * by one and silently received its neighbour's Score. Keying on the row and item ids, which are
 * derived from the source and the destination and never from position, removes the whole class.
 *
 * The TUI reads these ids straight off the question map; they are stable across passes and
 * across runs of the same corpus.
 */
export function sameMeaningId(a: string, b: string): string {
  return `same_meaning_${a}_${b}`;
}
export function rankId(rowId: string): string {
  return `rank_${rowId}`;
}
export function contradictsId(a: string, b: string): string {
  return `contradicts_${a}_${b}`;
}

/** The longest run of headings the two documents share, in order — group III's state (§4.4.3). */
function commonHeadingRun(a: readonly string[], b: readonly string[]): number {
  let best = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let n = 0;
      while (i + n < a.length && j + n < b.length && a[i + n] === b[j + n]) n++;
      if (n > best) best = n;
    }
  }
  return best;
}

/** §4.4.3 group III state: paths, tools, byte counts, sha256 PREFIXES and headings. Never a body. */
function pairCandidate(id: string, pair: { a: string; b: string; jaccard: number }, candidates: readonly PlanCandidate[]): PairCandidate {
  const side = (itemId: string): PairCandidate['a'] => {
    const c = candidates.find((x) => x.item.id === itemId);
    const headings = c?.doc?.headings ?? c?.item.parse.headings ?? [];
    return {
      path: c?.item.display ?? itemId,
      tool: c?.item.tools[0] ?? 'claude-code',
      bytes: c?.item.bytes ?? 0,
      sha8: (c?.item.sha256 ?? '').slice(0, 8),
      headings,
    };
  };
  const a = side(pair.a);
  const b = side(pair.b);
  return { id, a, b, jaccard: pair.jaccard, commonHeadingRun: commonHeadingRun(a.headings, b.headings) };
}

/**
 * §4.4.3 group V state, narrowed by **[G2.4]**: the headings, the matched noun phrase and the two
 * polarity markers — **not** the two sentences. The spine sent 200-char sentence fragments, which
 * is the only path in the design that bends "Jev never receives a file body", and pattern
 * redaction cannot catch a secret written in prose. Jev's effect here is limited to *ordering*
 * the conflicts section (the verdict is `review` either way), so the weaker payload costs nothing.
 */
function conflictCandidate(
  id: string,
  con: { a: string; b: string; noun: string; positiveMarker: string; negativeMarker: string },
  candidates: readonly PlanCandidate[],
): ConflictCandidate {
  const headingsOf = (itemId: string): readonly string[] => {
    const c = candidates.find((x) => x.item.id === itemId);
    return c?.doc?.headings ?? c?.item.parse.headings ?? [];
  };
  return {
    id,
    headings: [...headingsOf(con.a), ...headingsOf(con.b)].slice(0, IMPORT_LIMITS.jevHeadings),
    noun: con.noun,
    positiveMarker: con.positiveMarker,
    negativeMarker: con.negativeMarker,
  };
}

export function buildPlan(input: PlanInput, bands?: PlanBands): ImportPlan {
  const notices: string[] = [...(input.notices ?? [])];
  const jev = input.jev ?? { answers: {}, requests: 0, questions: 0, usd: 0, fallbacks: 0 };
  const answers = jev.answers;
  // §4.4.3 group I: built over the *uncapped* candidate list, because that is the list the facade
  // numbered `secret_<i>` over before the row ceiling below trimmed it (review defect 5).
  const secretIds = secretQuestionIds(input.candidates);

  // ---- 0. the row ceiling -------------------------------------------------------------
  let candidates = input.candidates;
  if (candidates.length > IMPORT_LIMITS.planRows) {
    notices.push(`plan capped at ${thousands(IMPORT_LIMITS.planRows)} rows (${thousands(candidates.length)} candidates)`);
    candidates = candidates.slice(0, IMPORT_LIMITS.planRows);
  }

  // ---- 1. Jev group II: the file-kind band --------------------------------------------
  const verdicts = new Map<string, FileVerdict>();
  let bandIndex = 0;
  for (const c of candidates) {
    let v = c.verdict;
    if (v.band) {
      const id = `kind_${bandIndex}`;
      bandIndex += 1;
      const chosen = resolveChoice(answers, id);
      if (chosen) {
        const mapped = KIND_TO_CLASS[chosen.option];
        if (mapped) {
          v = {
            class: mapped.class,
            skip: mapped.skip,
            rule: v.rule,
            p: v.p,
            band: true,
            why: `jev ${id} ${chosen.option} p=${chosen.p.toFixed(2)} can_=${chosen.paired.toFixed(2)}`,
          };
        }
      } else if (jev.reason !== undefined) {
        v = { ...v, why: `${v.why} (code fallback; jev unavailable: ${jev.reason})` };
      }
    }
    verdicts.set(c.item.id, v);
  }

  // ---- 2. §4.5 passes 1–2: dedupe -----------------------------------------------------
  const docs = candidates
    .filter((c) => c.doc !== undefined && verdicts.get(c.item.id)?.skip === null)
    .map((c) => ({ id: c.item.id, sha256: c.doc?.normalisedSha256 ?? c.item.sha256, bands: c.doc?.bands ?? [], tokens: c.doc?.tokens ?? [] }));
  const dd = dedupe(docs);
  if (dd.capped) notices.push(`duplicate scan capped at ${thousands(IMPORT_LIMITS.dedupePairs)} pairs (${thousands(docs.length)} candidates)`);

  const mergedInto = new Map<string, string>();
  /** survivor id → one `same as …` line per source folded into it (§4.5 pass 2, §1 property 2). */
  const foldNotes = new Map<string, string[]>();
  const extraTools = new Map<string, SourceTool[]>();
  for (const group of dd.groups) {
    const keep = group[0];
    if (keep === undefined) continue;
    for (const id of group.slice(1)) {
      mergedInto.set(id, keep);
      const byId = candidates.find((c) => c.item.id === id);
      if (byId) extraTools.set(keep, [...(extraTools.get(keep) ?? []), ...byId.item.tools]);
    }
  }

  // ---- 3. the drafts ------------------------------------------------------------------
  const drafts: Draft[] = [];
  const dupGroupOf = new Map<string, string>();
  dd.band.forEach((pair, i) => {
    const id = sameMeaningId(pair.a, pair.b);
    if (bands) bands.pairs.push(pairCandidate(id, pair, candidates));
    const same = resolveNoul(answers, id, 0.6);
    const gid = `dup-${i + 1}`;
    if (same === null) {
      dupGroupOf.set(pair.a, gid);
      dupGroupOf.set(pair.b, gid);
    } else {
      // Jev says the same thing: fold b into a, exactly as an exact duplicate.
      mergedInto.set(pair.b, pair.a);
      const folded = candidates.find((c) => c.item.id === pair.b);
      if (folded) extraTools.set(pair.a, [...(extraTools.get(pair.a) ?? []), ...folded.item.tools]);
      // §1 property 2: a folded source must not vanish silently. The survivor names it, so the
      // report can still account for every discovered artefact and the human can see WHY the
      // second copy is not being written.
      foldNotes.set(pair.a, [
        ...(foldNotes.get(pair.a) ?? []),
        `same as ${folded?.item.display ?? pair.b} (jaccard ${pair.jaccard.toFixed(2)}, jev ${id} p=${same.toFixed(2)})`,
      ]);
    }
  });

  for (const c of candidates) {
    if (mergedInto.has(c.item.id)) continue;
    const v = verdicts.get(c.item.id) ?? c.verdict;
    const destSpec = c.destination;
    const scope = scopeOf(c.item, destSpec);
    let destKind: DestinationSpec['kind'] = destSpec?.kind ?? (v.class === 'mcp' ? 'mcp' : v.class === 'command' ? 'command' : v.class === 'rule' ? 'rule' : v.class === 'memory' ? 'memory-topic' : 'report-only');
    // §6 row 17: a monorepo's `packages/<n>/AGENTS.md` is not the repository's AGENTS.md. Its
    // destination comes from its own directory relative to the git root, as a path-scoped rule —
    // never flattened into one always-on file.
    const packageDir = scope === 'user' ? null : relativeDir(c.item.realpath, input.gitRoot);
    const derivedPaths = packageDir === null ? [] : [`${packageDir}/**`];
    if (destKind === 'agents-append' && packageDir !== null) destKind = 'rule';
    const uniqueTools: SourceTool[] = [];
    for (const t of [...c.item.tools, ...(extraTools.get(c.item.id) ?? [])]) if (!uniqueTools.includes(t)) uniqueTools.push(t);
    const name = nameOf(c);
    const description = typeof fmValue(c, 'description') === 'string' ? String(fmValue(c, 'description')) : '';
    const slugBase = slugOf(packageDir === null ? name : `${packageDir}-${name}`, c.item.realpath);
    const indexLineBytes = `- [${name}](${slugBase}.md) — ${description} · ${v.class} · ${c.item.sha256.slice(0, 8)}\n`.length;
    const draft: Draft = {
      candidate: c,
      verdict: v,
      tools: uniqueTools,
      scope,
      destKind,
      slugBase,
      indexLineBytes,
      derivedPaths,
      extraWhy: [],
      warnings: [...(foldNotes.get(c.item.id) ?? [])],
      ...(dupGroupOf.has(c.item.id) ? { group: dupGroupOf.get(c.item.id) } : {}),
    };
    drafts.push(draft);
  }

  // ---- 4. §4.5 pass 3: conflicts ------------------------------------------------------
  const cf = findConflicts(candidates, verdicts, dd.band);
  const conflicts = cf.conflicts;
  if (cf.capped) notices.push(`conflict scan capped at ${thousands(IMPORT_LIMITS.dedupePairs)} pairs (${thousands(candidates.length)} candidates)`);
  conflicts.forEach((con, i) => {
    const gid = `conflict-${i + 1}`;
    const cid = contradictsId(con.a, con.b);
    if (bands) bands.conflicts.push(conflictCandidate(cid, con, candidates));
    const p = resolveNoul(answers, cid);
    for (const id of [con.a, con.b]) {
      const d = drafts.find((x) => x.candidate.item.id === id);
      if (!d) continue;
      d.group = gid;
      d.extraWhy.push(`conflict: opposed polarity on "${con.noun}"${p === null ? '' : ` (jev ${cid} p=${p.toFixed(2)})`}`);
    }
  });
  const conflicted = new Set(conflicts.flatMap((c) => [c.a, c.b]));

  // ---- 5. slugs, destinations and actions ---------------------------------------------
  const taken = new Map<string, { tool: SourceTool | undefined; n: number }>();
  const destState = input.destState ?? {};
  const manifest = input.manifest ?? null;
  const projectAvailable = input.gitRoot !== null && input.projectWritable !== false;
  const unavailableReason = input.gitRoot === null ? 'project scope unavailable (no git root)' : 'project scope unavailable (read-only)';
  const wantScope = input.scope ?? 'both';

  const rows: PlanRow[] = [];
  const ruleDrafts: Draft[] = [];
  const indexCandidates: { row: PlanRow; bytes: number }[] = [];

  for (const d of drafts) {
    const c = d.candidate;
    const v = d.verdict;
    const item = c.item;

    // rows that never reach a destination
    if (v.skip !== null) {
      const promoted = input.all === true && v.skip === 'skip:unrelated' && v.rule === 12;
      rows.push(
        makeRow({
          item,
          tools: d.tools,
          cls: v.class === 'skip' ? 'memory' : v.class,
          dest: null,
          action: promoted ? 'review' : v.skip,
          scope: d.scope,
          bytes: 0,
          why: promoted ? `${v.why} — promoted by --all` : v.why,
          warnings: d.warnings,
          ...(d.group === undefined ? {} : { group: d.group }),
        }),
      );
      continue;
    }

    // key rows: one file is simultaneously SECRET, CONFIG/permission, WORKFLOW/exec and CONFIG/mcp
    if (c.keys && c.keys.length > 0) {
      const keyRows = keyGroupRows(c, d, answers, jev.reason, destState, manifest, input.workspaceKey, secretIds);
      if (keyRows.length > 0) {
        rows.push(...keyRows);
        continue;
      }
    }

    // §6 row 17: a memory file the directory scoped into a rule is a *rule* row, not a memory row.
    const cls: Exclude<ImportClass, 'skip'> = d.destKind === 'rule' && (v.class === 'memory' || v.class === 'skip') ? 'rule' : v.class === 'skip' ? 'memory' : v.class;
    if (d.destKind === 'rule') ruleDrafts.push(d);

    // slug allocation (§6 rows 59–60)
    const slug = allocateSlug(d.slugBase, item.tools[0], taken);
    const dest = destinationPath(d.destKind, d.scope, slug);

    // bytes and the clip warning
    const cap = capFor(d.destKind);
    const warnings = [...d.warnings];
    let bytes = 0;
    if (dest !== null) {
      const body = item.bytes;
      if (body > cap) {
        bytes = cap;
        warnings.push(`clipped ${thousands(body)} → ${thousands(cap)} bytes`);
        notices.push(`clip: ${displayPath(item.display)} clipped ${thousands(body)} → ${thousands(cap)} bytes`);
      } else {
        bytes = body + FRONTMATTER_BYTES;
      }
    }

    // the rule trigger and its glob budget (§1 property 11, §6 row 62)
    const why: string[] = [v.why];
    if (d.destKind === 'rule') {
      const declared = ruleSpecOf(c);
      // §6 row 17: the source's own directory supplies the scope when its frontmatter does not.
      const useDerived = declared.patterns.length === 0 || (declared.trigger === 'always' && d.derivedPaths.length > 0);
      const spec = useDerived && d.derivedPaths.length > 0 ? { ...declared, trigger: 'paths' as const, patterns: d.derivedPaths } : declared;
      why.push(`trigger ${spec.trigger}, ${spec.patterns.length} pattern${spec.patterns.length === 1 ? '' : 's'}`);
      if (spec.capped) {
        warnings.push(`glob budget ${IMPORT_LIMITS.rulePatterns} reached; ${spec.dropped} patterns dropped`);
        notices.push(`globs: ${displayPath(item.display)} glob budget ${IMPORT_LIMITS.rulePatterns} reached; ${spec.dropped} patterns dropped`);
      }
    }
    why.push(...d.extraWhy);

    // the re-run matrix (§4.7.5)
    const entry = dest === null ? null : manifestEntryFor(manifest, input.workspaceKey, dest, d.scope);
    const state = dest === null ? null : (destState[dest] ?? null);
    const matrix = rerunAction({
      manifestEntry: entry,
      sourceSha256: item.sha256,
      destExists: state !== null,
      destSha256: state?.sha256 ?? null,
      markers: state?.markers ?? [],
      markerInteriorChanged: entry !== null && state !== null && state.sha256 !== entry.destSha256,
      appendable: APPENDABLE.includes(d.destKind),
    });

    let action: ImportAction = dest === null ? 'suggest' : matrix.action;
    if (dest !== null && (action === 'append' || action === 'merge') && !APPENDABLE.includes(d.destKind)) {
      // A topic, rule or command file is one document, not a stack of blocks: an existing
      // destination no manifest entry claims is never overwritten or appended to.
      action = d.destKind === 'mcp' ? 'merge' : 'review';
      if (action === 'review') why.push('the destination exists and no import wrote it; nothing will be overwritten');
    }
    if (action === 'create' && entry !== null) notices.push(`destination was removed since ${entry.importId}; re-creating ${dest ?? ''}`);
    if (entry !== null) {
      why.splice(0, why.length, matrix.why, ...d.extraWhy);
    }
    if (conflicted.has(item.id)) action = 'review';
    if (d.group?.startsWith('dup-') === true) action = 'review';

    // scope availability and the human's --scope (§6 rows 83–84, §4.9)
    if ((d.scope === 'project' || d.scope === 'project-local') && input.trust === 'none') {
      action = 'skip:untrusted';
      why.push('the workspace is not trusted; user-scope rows still apply');
    } else if ((d.scope === 'project' || d.scope === 'project-local') && !projectAvailable) {
      action = 'skip:untrusted';
      why.push(unavailableReason);
    } else if (wantScope === 'user' && d.scope !== 'user') {
      action = 'skip:unrelated';
      why.push('out of scope (--scope=user)');
    } else if (wantScope === 'project' && d.scope === 'user') {
      action = 'skip:unrelated';
      why.push('out of scope (--scope=project)');
    }

    const row = makeRow({
      item,
      tools: d.tools,
      cls,
      dest,
      action,
      scope: d.scope,
      bytes: action.startsWith('skip:') ? 0 : bytes,
      why: why.join(' — '),
      warnings,
      ...(d.group === undefined ? {} : { group: d.group }),
    });
    rows.push(row);
    if (cls === 'memory' && d.destKind === 'memory-topic' && !action.startsWith('skip:')) indexCandidates.push({ row, bytes: d.indexLineBytes });
  }

  if (!projectAvailable) notices.push(unavailableReason);
  if (wantScope === 'project' && !projectAvailable) notices.push(`--scope=project: ${unavailableReason}`);

  // ---- 6. the rule-file budget [G1.6] --------------------------------------------------
  if (ruleDrafts.length > IMPORT_LIMITS.ruleFiles) {
    const bySpecificity = [...ruleDrafts].sort((a, b) => depthOf(b.candidate.item.realpath) - depthOf(a.candidate.item.realpath) || a.candidate.item.realpath.localeCompare(b.candidate.item.realpath));
    const dropped = bySpecificity.slice(IMPORT_LIMITS.ruleFiles);
    const droppedIds = new Set(dropped.map((d) => d.candidate.item.id));
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r === undefined || r.class !== 'rule' || !droppedIds.has(r.source.id)) continue;
      rows[i] = { ...r, action: 'skip:unsupported', bytes: 0, dest: null, why: `${r.why} — rule budget ${IMPORT_LIMITS.ruleFiles} reached` };
    }
    notices.push(`rule budget ${IMPORT_LIMITS.ruleFiles} reached; ${dropped.length} rules not imported (most specific kept)`);
  }

  // ---- 7. §4.5 pass 4: the budget ------------------------------------------------------
  const scores: Record<string, number> = {};
  indexCandidates.forEach((ic) => {
    if (bands) bands.notes.push({ id: rankId(ic.row.id), path: ic.row.source.display, kind: ic.row.class, scope: ic.row.scope, bytes: ic.row.bytes });
    const s = resolveScore(answers, rankId(ic.row.id));
    if (s !== null) scores[ic.row.id] = s;
  });
  const ranked = rankIndex(
    indexCandidates.map((ic) => ic.row),
    Object.keys(scores).length > 0 ? scores : undefined,
  );
  const lineBytes = new Map(indexCandidates.map((ic) => [ic.row.id, ic.bytes]));
  let indexLines = 0;
  let indexBytes = 0;
  for (const r of ranked) {
    const b = lineBytes.get(r.id) ?? 80;
    if (indexLines + 1 > IMPORT_LIMITS.memoryIndexLines || indexBytes + b > IMPORT_LIMITS.memoryIndexBytes) break;
    indexLines += 1;
    indexBytes += b;
  }
  if (ranked.length > indexLines) {
    notices.push(`${ranked.length} notes → ${indexLines} indexed, ${ranked.length - indexLines} on demand (${kib(IMPORT_LIMITS.memoryDirBytes)} budget)`);
  }

  const memoryBytes = rows.filter((r) => (r.class === 'memory' || r.class === 'rule') && r.dest !== null && !r.action.startsWith('skip:')).reduce((n, r) => n + r.bytes, 0);
  if (memoryBytes > IMPORT_LIMITS.memoryDirBytes) notices.push(`memory budget ${kib(IMPORT_LIMITS.memoryDirBytes)} exceeded (${kib(memoryBytes)}); the index is trimmed, no note is dropped`);

  return {
    v: 1,
    importId: input.importId,
    at: input.at,
    jevcodeVersion: input.jevcodeVersion,
    workspace: displayPath(input.workspace),
    workspaceKey: displayPath(input.workspaceKey),
    gitRoot: input.gitRoot === null ? null : displayPath(input.gitRoot),
    trust: input.trust,
    roots: input.roots,
    rows,
    budget: { memoryBytes, memoryMax: IMPORT_LIMITS.memoryDirBytes, indexLines, indexMax: IMPORT_LIMITS.memoryIndexLines },
    jev: { requests: jev.requests, questions: jev.questions, usd: jev.usd, fallbacks: jev.fallbacks, ...(jev.reason === undefined ? {} : { reason: jev.reason }) },
    cannotRead: input.cannotRead ?? [],
    notices,
  };
}

// ---------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------

function depthOf(p: string): number {
  return displayPath(p).split('/').length;
}

/** Directory segments that belong to a *tool*, not to a package: they never scope a rule. */
const TOOL_DIRS = new Set([
  '.cursor',
  '.claude',
  '.codex',
  '.windsurf',
  '.devin',
  '.github',
  '.gemini',
  '.copilot',
  '.opencode',
  '.aider',
  '.jevcode',
  'rules',
  'instructions',
  'memory',
  'memory-local',
  'commands',
  'prompts',
  'skills',
  'workflows',
  'agents',
]);

/**
 * §6 rows 17 and 84: the source's own directory relative to the git root, with the tool
 * directories stripped off the end — `packages/web/.cursor/rules/style.mdc` is scoped by
 * `packages/web`, not by `.cursor/rules`. `null` for a file that sits at the git root, for one
 * outside it (the `instructionSearchDirs` range is the workspace up to the git root, never
 * above) and for one whose remaining directory is itself a dot-directory.
 */
export function relativeDir(realpath: string, gitRoot: string | null): string | null {
  if (gitRoot === null) return null;
  const p = displayPath(realpath);
  const root = displayPath(gitRoot).replace(/\/+$/, '');
  if (root.length === 0 || !p.startsWith(`${root}/`)) return null;
  const segments = p.slice(root.length + 1).split('/');
  segments.pop();
  while (segments.length > 0 && TOOL_DIRS.has(segments[segments.length - 1] ?? '')) segments.pop();
  if (segments.length === 0) return null;
  if (segments.some((s) => s.startsWith('.'))) return null;
  return segments.join('/');
}

function makeRow(a: {
  item: SourceItem;
  tools: readonly SourceTool[];
  cls: Exclude<ImportClass, 'skip'>;
  dest: string | null;
  action: ImportAction;
  scope: RowScope;
  bytes: number;
  why: string;
  warnings: readonly string[];
  group?: string;
  discriminator?: string;
}): PlanRow {
  return {
    id: rowId(a.item.id, a.dest, a.discriminator ?? ''),
    source: { id: a.item.id, display: displayPath(a.item.display), tools: a.tools, sha256: a.item.sha256, bytes: a.item.bytes, mtimeMs: Date.parse(a.item.mtime) || 0 },
    class: a.cls,
    dest: a.dest,
    action: a.action,
    scope: a.scope,
    bytes: a.bytes,
    why: a.why,
    warnings: a.warnings,
    ...(a.group === undefined ? {} : { group: a.group }),
  };
}

function manifestEntryFor(manifest: ImportManifest | null, workspaceKey: string, dest: string, scope: RowScope): ImportManifestEntry | null {
  if (manifest === null) return null;
  const list = scope === 'user' ? manifest.user : (manifest.workspaces[workspaceKey] ?? []);
  return list.find((e) => e.dest === dest) ?? null;
}

/** §6 rows 59–60: the second source to claim a slug gets `-<tool>` when the tools differ, then `-2`, `-3`, … */
export function allocateSlug(base: string, tool: SourceTool | undefined, taken: Map<string, { tool: SourceTool | undefined; n: number }>): string {
  const owner = taken.get(base);
  if (owner === undefined) {
    taken.set(base, { tool, n: 1 });
    return base;
  }
  if (tool !== undefined && owner.tool !== tool && !taken.has(`${base}-${tool}`)) {
    taken.set(`${base}-${tool}`, { tool, n: 1 });
    return `${base}-${tool}`;
  }
  let n = owner.n + 1;
  while (taken.has(`${base}-${n}`)) n += 1;
  owner.n = n;
  taken.set(`${base}-${n}`, { tool, n: 1 });
  return `${base}-${n}`;
}

// ---------------------------------------------------------------------------------------
// §4.4.2 — one config file becomes several rows
// ---------------------------------------------------------------------------------------

/**
 * §4.4.3 group I: which `secret_<i>` question belongs to which band key, **plan-wide**.
 *
 * `secretQuestions` numbers its Nouls across the whole candidate list, so a counter that restarts
 * at every file reads file 2's key with file 1's answer — which can *demote* a real credential
 * (review defect 5). The map is keyed by `SecretCandidate.id`, the same `<item.id>:<dotted>` the
 * facade builds the candidates with, so the two agree by construction rather than by both
 * happening to iterate in the same order.
 */
export function secretCandidateId(itemId: string, dotted: string): string {
  return `${itemId}:${dotted}`;
}

function secretQuestionIds(candidates: readonly PlanCandidate[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  let n = 0;
  for (const c of candidates) {
    for (const k of c.keys ?? []) {
      // the facade's own filter: a band key always has a shape, and only band keys are asked about
      if (!k.band || k.shape === null) continue;
      out.set(secretCandidateId(c.item.id, k.leaf.dotted), `secret_${n}`);
      n += 1;
    }
  }
  return out;
}

function keyGroupRows(
  c: PlanCandidate,
  d: Draft,
  answers: Readonly<Record<string, Answer>>,
  jevReason: string | undefined,
  destState: Readonly<Record<string, { sha256: string; markers: readonly string[] } | null>>,
  manifest: ImportManifest | null,
  workspaceKey: string,
  secretIds: ReadonlyMap<string, string>,
): PlanRow[] {
  const keys = c.keys ?? [];
  const out: PlanRow[] = [];
  const item = c.item;

  // Jev group I may promote a band key into the secret class and may never demote one out of it.
  const resolved: KeyVerdict[] = keys.map((k): KeyVerdict => {
    if (!k.band) return k;
    // no id ⇒ no answer ⇒ `joinSecretVerdict(_, null)` treats the band item as a secret, which is
    // the conservative side of §0 principle 4. Mis-keying can only over-protect, never demote.
    const id = secretIds.get(secretCandidateId(item.id, k.leaf.dotted));
    const a = id === undefined ? undefined : answers[id];
    const p = a && a.type === 'noul' && Number.isFinite(a.noul) ? a.noul : null;
    const joined = joinSecretVerdict({ secret: false, band: true, rule: k.rule, why: k.why }, p);
    return joined.secret ? { ...k, class: 'secret', kind: 'secret', why: joined.why } : k;
  });

  const secrets = resolved.filter((k) => k.kind === 'secret');
  const permissions = resolved.filter((k) => k.kind === 'permission');
  const execs = resolved.filter((k) => k.kind === 'exec');
  const mcps = resolved.filter((k) => k.kind === 'mcp');

  if (secrets.length > 0) {
    const first = secrets[0];
    const fp = first?.shape?.fingerprint;
    out.push(
      makeRow({
        item,
        tools: d.tools,
        cls: 'secret',
        dest: null,
        action: 'skip:secret',
        scope: d.scope,
        bytes: 0,
        why: `${first?.why ?? 'key rule 1'}${fp === undefined ? '' : ` — sha256:${fp}`}${secrets.length > 1 ? ` (+${secrets.length - 1} more)` : ''}${jevReason === undefined ? '' : ` — ${jevReason}`}`,
        warnings: [],
        discriminator: 'secret',
      }),
    );
  }
  if (permissions.length > 0) {
    out.push(
      makeRow({
        item,
        tools: d.tools,
        cls: 'config',
        dest: null,
        action: 'suggest',
        scope: d.scope,
        bytes: 0,
        why: `${permissions[0]?.why ?? 'key rule 5'} — ${permissions.length} ${permissions.length === 1 ? 'entry' : 'entries'}, never written`,
        warnings: [],
        discriminator: 'permission',
      }),
    );
  }
  if (execs.length > 0) {
    out.push(
      makeRow({
        item,
        tools: d.tools,
        cls: 'config',
        dest: null,
        action: 'skip:executable',
        scope: d.scope,
        bytes: 0,
        why: `${execs[0]?.why ?? 'key rule 6'}${execs.length > 1 ? ` (+${execs.length - 1} more)` : ''}`,
        warnings: [],
        discriminator: 'exec',
      }),
    );
  }
  if (mcps.length > 0) {
    const servers = new Set(mcps.map((k) => k.leaf.path[1] ?? '').filter((s) => s.length > 0));
    const count = Math.min(servers.size, IMPORT_LIMITS.mcpServers);
    const dest = destinationPath('mcp', d.scope, 'mcp');
    const entry = dest === null ? null : manifestEntryFor(manifest, workspaceKey, dest, d.scope);
    const state = dest === null ? null : (destState[dest] ?? null);
    const action: ImportAction = entry !== null ? rerunAction({ manifestEntry: entry, sourceSha256: item.sha256, destExists: state !== null, destSha256: state?.sha256 ?? null, markers: state?.markers ?? [], markerInteriorChanged: false, appendable: false }).action : state === null ? 'create' : 'merge';
    const warnings = servers.size > IMPORT_LIMITS.mcpServers ? [`mcp budget ${IMPORT_LIMITS.mcpServers} reached; ${servers.size - IMPORT_LIMITS.mcpServers} servers not imported`] : [];
    out.push(
      makeRow({
        item,
        tools: d.tools,
        cls: 'mcp',
        dest,
        action,
        scope: d.scope,
        bytes: count * 240,
        why: `${mcps[0]?.why ?? 'key rule 7'} — ${count} server${count === 1 ? '' : 's'}, all disabled`,
        warnings,
        discriminator: 'mcp',
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// §4.5 pass 3 / §4.4.3 group V — the conflict precondition
// ---------------------------------------------------------------------------------------

const POSITIVE_MARKERS: readonly string[] = ['always', 'must', 'use', 'prefer'];
const NEGATIVE_MARKERS: readonly string[] = ['never', "don't", 'avoid', 'do not'];
const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'be', 'it', 'this', 'that', 'with', 'before', 'after', 'when', 'you', 'your', 'we', 'i']);

/** Crude stemming: enough to make `patching` and `patch` the same noun without a dictionary. */
function stem(w: string): string {
  return w.replace(/(ing|ed|es|s)$/u, '');
}

/** Whole-word marker matching: `because` and `house` must not count as the positive marker `use`. */
const MARKER_RE = new Map<string, RegExp>(
  [...POSITIVE_MARKERS, ...NEGATIVE_MARKERS].map((m) => [m, new RegExp(`(^|[^a-z'])${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z']|$)`)] as const),
);

function markedSentences(text: string, markers: readonly string[]): { marker: string; nouns: Set<string> }[] {
  const out: { marker: string; nouns: Set<string> }[] = [];
  for (const raw of text.split(/[.!?\n]+/).slice(0, 400)) {
    const s = raw.toLowerCase().trim();
    if (s.length === 0) continue;
    const marker = markers.find((m) => MARKER_RE.get(m)?.test(s) === true);
    if (marker === undefined) continue;
    const nouns = new Set(
      s
        .replace(/[^a-z0-9\s'-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !markers.includes(w) && !POSITIVE_MARKERS.includes(w) && !NEGATIVE_MARKERS.includes(w))
        .map(stem),
    );
    if (nouns.size > 0) out.push({ marker, nouns });
  }
  return out;
}

/**
 * §4.4.3 group V, the **code precondition** — there is no Jev call without it: both items carry
 * an imperative about the same noun phrase, one with a positive marker (`always`, `must`, `use`,
 * `prefer`) and the other with a negative one (`never`, `don't`, `avoid`, `do not`). The Jaccard
 * window is `[0.3, 0.9)`.
 */
export function findConflicts(
  candidates: readonly PlanCandidate[],
  verdicts: ReadonlyMap<string, FileVerdict>,
  _band: readonly { a: string; b: string; jaccard: number }[],
  maxPairs: number = IMPORT_LIMITS.dedupePairs,
): {
  conflicts: readonly { a: string; b: string; noun: string; positiveMarker: string; negativeMarker: string }[];
  pairs: number;
  capped: boolean;
} {
  const live = candidates.filter((c) => c.doc !== undefined && verdicts.get(c.item.id)?.skip === null);
  const out: { a: string; b: string; noun: string; positiveMarker: string; negativeMarker: string }[] = [];
  const order = new Map<string, number>();
  live.forEach((c, i) => order.set(c.item.id, i));
  const sets = new Map<string, ReadonlySet<string>>();
  const pos = new Map<string, { marker: string; nouns: Set<string> }[]>();
  const neg = new Map<string, { marker: string; nouns: Set<string> }[]>();
  // **[G1.6]**, as pass 2 does it: bucket first, compare inside a bucket. The precondition's own
  // key is the shared **noun stem** — a conflict needs a positive imperative in one file and a
  // negative one in the other *about the same noun* — so an inverted index on that stem is both
  // the natural bucket and an exact one: it excludes only pairs the precondition would have
  // rejected anyway. The all-pairs pass it replaces was the last super-linear step left in the
  // engine, and it truncated at `dedupePairs` without telling anyone.
  const withNoun = new Map<string, { positives: string[]; negatives: string[] }>();
  const bucketFor = (noun: string): { positives: string[]; negatives: string[] } => {
    const found = withNoun.get(noun);
    if (found !== undefined) return found;
    const made = { positives: [], negatives: [] };
    withNoun.set(noun, made);
    return made;
  };
  for (const c of live) {
    const text = c.doc?.text ?? '';
    const id = c.item.id;
    sets.set(id, new Set(c.doc?.tokens ?? []));
    const p = markedSentences(text, POSITIVE_MARKERS);
    const n = markedSentences(text, NEGATIVE_MARKERS);
    pos.set(id, p);
    neg.set(id, n);
    for (const noun of new Set(p.flatMap((s) => [...s.nouns]))) bucketFor(noun).positives.push(id);
    for (const noun of new Set(n.flatMap((s) => [...s.nouns]))) bucketFor(noun).negatives.push(id);
  }

  let pairs = 0;
  let capped = false;
  const compared = new Set<string>();
  const nouns = [...withNoun.keys()].sort();
  outer: for (const noun of nouns) {
    const bucket = withNoun.get(noun);
    if (bucket === undefined) continue;
    for (const p of bucket.positives) {
      for (const n of bucket.negatives) {
        if (p === n) continue;
        const [x, y] = (order.get(p) ?? 0) <= (order.get(n) ?? 0) ? [p, n] : [n, p];
        const pk = `${x}\u0000${y}`;
        if (compared.has(pk)) continue;
        compared.add(pk);
        if (pairs >= maxPairs) {
          capped = true;
          break outer;
        }
        pairs++;
        const jac = jaccardOf(sets.get(x) ?? new Set(), sets.get(y) ?? new Set());
        if (jac < CONFLICT_BAND.lo || jac >= CONFLICT_BAND.hi) continue;
        const hit = opposed(pos.get(x) ?? [], neg.get(y) ?? []) ?? opposed(pos.get(y) ?? [], neg.get(x) ?? []);
        if (hit === null) continue;
        out.push({ a: x, b: y, noun: hit.noun, positiveMarker: hit.positiveMarker, negativeMarker: hit.negativeMarker });
      }
    }
  }
  // the bucket walk visits by noun, so restore the candidates' own order: `conflict-<i>` is a
  // stable name only if the list is
  out.sort((p, q) => (order.get(p.a) ?? 0) - (order.get(q.a) ?? 0) || (order.get(p.b) ?? 0) - (order.get(q.b) ?? 0));
  return { conflicts: out, pairs, capped };
}

function opposed(
  positives: readonly { marker: string; nouns: Set<string> }[],
  negatives: readonly { marker: string; nouns: Set<string> }[],
): { noun: string; positiveMarker: string; negativeMarker: string } | null {
  for (const p of positives) {
    for (const n of negatives) {
      for (const noun of p.nouns) {
        if (n.nouns.has(noun)) return { noun, positiveMarker: p.marker, negativeMarker: n.marker };
      }
    }
  }
  return null;
}
