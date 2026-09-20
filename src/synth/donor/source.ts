/**
 * The donor CandidateSource: lines already in the workspace, re-bound to the site's scope.
 *
 *   (a) same-shape donors — every corpus line whose normalised shape equals the current line's,
 *       with up to two identifiers/attributes rebound (`dp[a, b] = dp[a - 1, b]` → `memo[i, j] = …`);
 *   (b) near-duplicates — lines with token-set Jaccard ≥ 0.5 (or Levenshtein similarity ≥ 0.5)
 *       to the current line, one substitution (`text.strip()` → `text.strip().lower().replace(…)`);
 *   (c) statement donors — statements of the enclosing function, then the file, then the corpus
 *       that reference the site's scope names, adapted; compound headers carry their body as
 *       `extraEdits` so a whole `for …:` block can be transplanted, and a statement spread over
 *       several physical lines carries its continuation lines the same way. This is the
 *       "missing statement" source for insert sites and the multi-line-body case of the ladder (`units`).
 *
 * Order is deterministic: source kind, then tier (same function < same file < corpus), fewer
 * substitutions first, then preference score, shape frequency, path and line. `opts.cap` cuts
 * the tail. Priors are enumeration order only; Jev ranks and the tests decide.
 */
import { jaccard, levenshteinSimilarity, normaliseLine } from '../py/similarity.js';
import { functionAt, scopeAt } from '../py/structure.js';
import type { LineScope } from '../py/structure.js';
import type { Candidate, CandidateSource, EnumerateOptions, LineEdit, Site, SourceFile } from '../types.js';
import { adaptIdentifiers, swapFamilyPairs } from './adapt.js';
import type { Adaptation } from './adapt.js';
import { NON_DONOR_KINDS, buildDonorIndex } from './corpus.js';
import type { DonorLine } from './corpus.js';

export type DonorOp = 'same_shape_rebind' | 'near_duplicate_rebind' | 'statement_donor' | 'family_swap';

export interface DonorSourceOptions {
  /** Jaccard / Levenshtein similarity floor for near-duplicates (default 0.5) */
  nearDuplicateThreshold?: number;
  /** near-duplicate donors considered after ranking by similarity (default 40) */
  maxNearDuplicates?: number;
  /** statement donors taken from the site's own file outside the enclosing function (default 300); the function itself is unbounded */
  maxFileStatements?: number;
  /** statement donors taken from other files of the corpus (default 150) */
  maxCorpusStatements?: number;
  /** adaptations per donor line for (a) / (b) / (c) (defaults 32 / 8 / 12) */
  maxMappingsSameShape?: number;
  maxMappingsNearDuplicate?: number;
  maxMappingsStatement?: number;
  /** extra physical lines carried with a statement donor: continuation lines of a bracketed statement plus the body of a compound header (default 8; longer ones are skipped or travel as a bare header) */
  maxBodyLines?: number;
  /** append both orders of same-family pairs (default true) */
  familySwaps?: boolean;
}

const DEFAULTS: Required<DonorSourceOptions> = {
  nearDuplicateThreshold: 0.5,
  maxNearDuplicates: 40,
  maxFileStatements: 300,
  maxCorpusStatements: 150,
  maxMappingsSameShape: 32,
  maxMappingsNearDuplicate: 8,
  maxMappingsStatement: 12,
  maxBodyLines: 8,
  familySwaps: true,
};

type Tier = 0 | 1 | 2;

interface Draft {
  op: DonorOp;
  tier: Tier;
  donor: DonorLine;
  adaptation: Adaptation;
  text: string;
  extraEdits: LineEdit[];
  shapeFrequency: number;
  /** identifier overlap with the failing test / task text */
  taskOverlap: number;
}

const OP_RANK: Record<DonorOp, number> = { same_shape_rebind: 0, near_duplicate_rebind: 1, statement_donor: 2, family_swap: 3 };

/** FNV-1a over the candidate text: ids stay stable when the cap changes. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function tierOf(donor: DonorLine, site: Site): Tier {
  if (donor.path !== site.file.path) return 2;
  if (site.block !== null && donor.block !== null && donor.block.startLine === site.block.startLine && donor.block.endLine === site.block.endLine) return 0;
  return 1;
}

const donorScopes = new WeakMap<SourceFile, Map<number, LineScope>>();
function donorScope(donor: DonorLine): LineScope {
  let m = donorScopes.get(donor.file);
  if (m === undefined) {
    m = new Map();
    donorScopes.set(donor.file, m);
  }
  let s = m.get(donor.line);
  if (s === undefined) {
    s = scopeAt(donor.file.mod, donor.line);
    m.set(donor.line, s);
  }
  return s;
}

/** Code-point string order: `localeCompare` collates by the process locale, which would make the candidate order machine-dependent. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The physical lines a statement donor carries besides its first line, re-indented so the
 * first line sits at `indent`: the continuation lines of a bracketed statement (`x = f(\n a,\n b)`)
 * and, for a compound header, its body. Returns `{ lines: [] }` for a plain one-line statement,
 * `{ lines }` for a complete transplant, and null when the statement cannot travel whole: a
 * continuation too long to carry (the first line alone would not parse) or a header whose body
 * is too long (the header may still go where a body already exists, see `headerFits`).
 */
function trailingLines(donor: DonorLine, indent: string, maxLines: number): { lines: string[]; bodyDropped: boolean } | null {
  const lines = donor.file.mod.lines;
  const headerWs = donor.indent;
  const reindent = (raw: string): string => (raw.startsWith(headerWs) ? indent + raw.slice(headerWs.length) : indent + raw.trimStart());
  const out: string[] = [];
  for (let l = donor.line + 1; l <= donor.statementEndLine; l++) {
    out.push(reindent(lines[l - 1]!));
    if (out.length > maxLines) return null;
  }
  if (!donor.isHeader) return { lines: out, bodyDropped: false };
  const body: string[] = [];
  for (let l = donor.statementEndLine + 1; l <= lines.length; l++) {
    const raw = lines[l - 1]!;
    if (raw.trim() === '') {
      body.push('');
      continue;
    }
    const ws = /^[ \t]*/.exec(raw)?.[0] ?? '';
    if (ws.length <= headerWs.length || !ws.startsWith(headerWs)) break;
    body.push(indent + raw.slice(headerWs.length));
    if (out.length + body.length > maxLines) return { lines: out, bodyDropped: true };
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { lines: [...out, ...body], bodyDropped: false };
}

function isHeaderText(text: string): boolean {
  const code = text.replace(/\s+#.*$/, '').trimEnd();
  return code.endsWith(':') && !/^\s*(else|elif|except|finally|try|def|class)\b/.test(code) && /^\s*(if|for|while|with|async)\b/.test(code);
}

/** A header without its body may only go where the next line is already indented under it. */
function headerFits(site: Site, hasBody: boolean): boolean {
  if (hasBody) return true;
  if (site.kind === 'replace' && isHeaderText(site.currentLine)) return true;
  const nextLine = site.file.mod.lines[site.kind === 'insert' ? site.line - 1 : site.line];
  if (nextLine === undefined || nextLine.trim() === '') return false;
  const ws = /^[ \t]*/.exec(nextLine)?.[0] ?? '';
  return ws.length > site.indent.length;
}

/**
 * Identifiers of the site's enclosing function (strongest rebinding preference), read through
 * `site.block` so an insert site just past the function's last line still sees that function
 * and not the next one; module names at module level.
 */
function preferredIdentifiers(site: Site): readonly string[] {
  const mod = site.file.mod;
  if (site.block !== null) {
    const block = mod.blocks.find((b) => b.startLine === site.block?.startLine && b.endLine === site.block?.endLine);
    const fn = block === undefined ? undefined : mod.functions.find((f) => f.blockIndex === block.index);
    if (fn !== undefined) return fn.identifiers;
  }
  return functionAt(mod, site.line)?.identifiers ?? mod.moduleNames;
}

export function createDonorSource(options: DonorSourceOptions = {}): CandidateSource {
  const cfg = { ...DEFAULTS, ...options };
  return {
    name: 'donor',
    enumerate(site: Site, opts: EnumerateOptions): Candidate[] {
      // the site's own file always donates, ahead of a stale copy the corpus may hold under the same path
      const index = buildDonorIndex([site.file, ...[...opts.corpus.values()].filter((f) => f.path !== site.file.path)]);
      const preferred = preferredIdentifiers(site);
      const task = new Set(opts.taskIdentifiers);
      const current = site.currentLine.trim();
      const drafts: Draft[] = [];
      const seen = new Set<string>();
      if (site.kind === 'replace') seen.add(current);

      /**
       * `adaptation.text` is the header line, or header + body lines joined by '\n' when a
       * compound statement travels whole (the body was adapted together with the header, so a
       * `SIZE_UNITS` → `DURATION_UNITS` mapping reaches the `return` inside the `for`).
       */
      const push = (op: DonorOp, donor: DonorLine, adaptation: Adaptation, bodyDropped = false): void => {
        const [text = '', ...body] = adaptation.text.split('\n');
        const key = adaptation.text;
        if (seen.has(key) || seen.has(text)) return;
        // a compound header arriving without its body (a bare header line, or a statement whose
        // body was too long to carry) only parses where the next line is already indented under it
        const bareHeader = body.length === 0 ? isHeaderText(text) : bodyDropped;
        if (bareHeader && !headerFits(site, false)) return;
        seen.add(key);
        const extraEdits: LineEdit[] = body.map((b, k) => ({ path: site.file.path, line: site.line + 1 + k, kind: 'insert', text: b }));
        const finalIds = donor.identifiers.map((n) => adaptation.substitutions.find((s) => s.kind === 'identifier' && s.from === n)?.to ?? n);
        drafts.push({ op, tier: tierOf(donor, site), donor, adaptation, text, extraEdits, shapeFrequency: index.shapeFrequency(donor.shape), taskOverlap: finalIds.filter((n) => task.has(n)).length });
      };
      const adapt = (donor: DonorLine, maxChanges: number, maxMappings: number, blockText = donor.text): Adaptation[] =>
        adaptIdentifiers(blockText, site.scope, { maxChanges, maxMappings, preferred, taskIdentifiers: opts.taskIdentifiers, donorScope: donorScope(donor) });

      if (site.kind === 'replace' && current !== '') {
        const shapeTokens = normaliseLine(current);
        const shape = shapeTokens.join(' ');
        // (a) same shape
        for (const donor of index.byShape.get(shape) ?? []) {
          if (donor.text === current) continue;
          for (const a of adapt(donor, 2, cfg.maxMappingsSameShape)) push('same_shape_rebind', donor, a);
        }
        // (b) near-duplicates, best similarity first
        const near = index.lines
          .filter((d) => d.shape !== shape && d.text !== current)
          .map((d) => ({ d, score: Math.max(jaccard(shapeTokens, d.shapeTokens), levenshteinSimilarity(shapeTokens, d.shapeTokens)) }))
          .filter((x) => x.score >= cfg.nearDuplicateThreshold)
          .sort((x, y) => y.score - x.score || tierOf(x.d, site) - tierOf(y.d, site) || byCodePoint(x.d.path, y.d.path) || x.d.line - y.d.line)
          .slice(0, cfg.maxNearDuplicates);
        for (const { d } of near) for (const a of adapt(d, 1, cfg.maxMappingsNearDuplicate)) push('near_duplicate_rebind', d, a);
      }

      // (c) statement donors that reference the site's scope names
      const scopeNames = new Set([...site.scope.params, ...site.scope.locals, ...site.scope.module, ...site.scope.imports]);
      // identifiers of the whole logical statement: a reference on a continuation line
      // (`x = f(\n    LIMIT)`) counts as much as one on the first physical line
      const statementIdentifiers = (d: DonorLine): string[] => {
        if (d.statementEndLine === d.line) return [...d.identifiers];
        const names = new Set(d.identifiers);
        for (const l of index.files.get(d.path) ?? []) if (l.line > d.line && l.line <= d.statementEndLine) for (const n of l.identifiers) names.add(n);
        return [...names];
      };
      const statementDonors = index.lines
        .filter((d) => d.startsStatement && d.statementKind !== null && !NON_DONOR_KINDS.has(d.statementKind))
        .filter((d) => !(d.path === site.file.path && site.kind === 'replace' && d.line === site.line))
        .map((d) => {
          const ids = statementIdentifiers(d);
          const inScope = ids.filter((n) => scopeNames.has(n)).length;
          return { d, tier: tierOf(d, site), inScopeFraction: ids.length === 0 ? 0 : inScope / ids.length, inScope, taskOverlap: ids.filter((n) => task.has(n)).length };
        })
        .filter((x) => x.inScope > 0)
        .sort((x, y) => x.tier - y.tier || y.inScopeFraction - x.inScopeFraction || y.taskOverlap - x.taskOverlap || index.shapeFrequency(y.d.shape) - index.shapeFrequency(x.d.shape) || byCodePoint(x.d.path, y.d.path) || x.d.line - y.d.line);
      const tierBudget: Record<Tier, number> = { 0: Number.POSITIVE_INFINITY, 1: cfg.maxFileStatements, 2: cfg.maxCorpusStatements };
      const tierTaken: Record<Tier, number> = { 0: 0, 1: 0, 2: 0 };
      let currentTier: Tier | null = null;
      for (const { d, tier } of statementDonors) {
        if (tier !== currentTier) {
          // every draft collected so far sorts ahead of this tier's statement donors (op, then
          // tier, are the leading sort keys), so once the cap is already full the tier cannot
          // change the output and a large corpus is not adapted for nothing
          if (drafts.length >= opts.cap) break;
          currentTier = tier;
        }
        if (tierTaken[tier]++ >= tierBudget[tier]) continue;
        const trailing = trailingLines(d, site.indent, cfg.maxBodyLines);
        if (trailing === null) continue;
        const blockText = [d.text, ...trailing.lines].join('\n');
        for (const a of adapt(d, 2, cfg.maxMappingsStatement, blockText)) push('statement_donor', d, a, trailing.bodyDropped);
      }

      drafts.sort(
        (x, y) =>
          OP_RANK[x.op] - OP_RANK[y.op] ||
          x.tier - y.tier ||
          x.adaptation.changes - y.adaptation.changes ||
          y.adaptation.score - x.adaptation.score ||
          y.taskOverlap - x.taskOverlap ||
          y.shapeFrequency - x.shapeFrequency ||
          byCodePoint(x.donor.path, y.donor.path) ||
          x.donor.line - y.donor.line ||
          byCodePoint(x.text, y.text),
      );

      // same-family pairs in both orders, after the primaries so a tight cap keeps the originals
      if (cfg.familySwaps) {
        for (const d of [...drafts]) {
          if (d.extraEdits.length > 0) continue;
          for (const s of swapFamilyPairs(d.text, site.scope)) {
            if (seen.has(s.text)) continue;
            seen.add(s.text);
            drafts.push({ ...d, op: 'family_swap', text: s.text, adaptation: { ...d.adaptation, text: s.text } });
          }
        }
      }

      const out: Candidate[] = [];
      for (const d of drafts.slice(0, Math.max(0, opts.cap))) {
        const text = site.indent + d.text;
        const prior = Math.max(0.05, 0.9 - 0.2 * OP_RANK[d.op] - 0.1 * d.tier - 0.05 * d.adaptation.changes);
        const c: Candidate = { id: `donor-${site.line}-${fnv1a(`${d.op}|${text}|${d.extraEdits.map((e) => e.text ?? '').join('\n')}`)}`, site, text, source: 'donor', op: d.op, prior };
        if (d.extraEdits.length > 0) c.extraEdits = d.extraEdits;
        out.push(c);
      }
      return out;
    },
  };
}
