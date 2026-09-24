/**
 * `question_about_the_code` in jev-only — the honest lookup (TUI-DESIGN-2 §3.6): no engine run (the jev-only
 * synthesizer proposes no `read` and would end in `max_replans`). What jev-only does well is select: one request of
 * context Nouls over ≤ 60 candidate files (`contextNoul`, criteria written once in the state), then code-computed
 * excerpts — ≤ 3 hits at p ≥ 0.5, ≤ 64 KiB read each through the caller's denylisted reader, ≤ 3 keyword lines per file
 * (definition lines first), each ≤ 120 cells. `lookupLines` is the `[jevcode]` bubble (§3.6 / §12 "Transcript").
 */
import type { AskResult, Candidate, FileView, Json, JsonObject, JevProvider, Question, TokenUsage } from '../../core/types.js';
import { contextNoul, ref } from '../../jev/questions.js';
import { cellWidth, truncateCells } from '../../tui/glyphs.js';
import { oneLine } from '../../tui/plain.js';

export interface LookupInput {
  message: string;
  /** `@path` mentions, ranked first */
  mentions: readonly string[];
  candidates: readonly Candidate[];
  /** bounded, denylisted read (`isMentionDenied` first); null = denied or unreadable */
  read: (rel: string, maxBytes: number) => Promise<FileView | null>;
  ask: (state: Json, questions: Record<string, Question>) => Promise<AskResult>;
  provider: JevProvider;
  redact: (s: string) => string;
  signal: AbortSignal;
}
export interface LookupLine {
  n: number;
  text: string;
}
export interface LookupHit {
  path: string;
  p: number;
  /** ≤ 3 lines per file, each ≤ 120 cells */
  lines: LookupLine[];
}
export interface LookupResult {
  hits: LookupHit[];
  /** candidates Jev was asked about */
  considered: number;
  usage: TokenUsage;
  latencyMs: number;
  provider: JevProvider;
  /** the client's hash of the lookup request (`''` when nothing was asked) — the `--json` `chat` line of the lookup (§6 item 17) */
  requestHash: string;
}

export const LOOKUP_CANDIDATES_MAX = 60;
export const LOOKUP_HITS_MAX = 3;
export const LOOKUP_LINES_MAX = 3;
export const LOOKUP_SELECT_FLOOR = 0.5;
export const LOOKUP_READ_BYTES = 64 * 1024;
export const LOOKUP_KEYWORDS_MAX = 12;
export const LOOKUP_LINE_CELLS = 120;
/** the excerpt text itself (the `  <path>:<n>  ` prefix takes the rest of the 120 cells) */
export const LOOKUP_EXCERPT_CELLS = 100;

/** 60 words that carry no lookup signal */
export const LOOKUP_STOPLIST: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'her', 'was', 'one', 'our', 'out', 'has', 'his', 'how',
  'its', 'let', 'may', 'new', 'now', 'old', 'see', 'way', 'who', 'why', 'did', 'does', 'this', 'that', 'with', 'from', 'what',
  'where', 'when', 'which', 'there', 'their', 'about', 'into', 'have', 'will', 'would', 'could', 'should', 'code', 'file',
  'function', 'work', 'works', 'thing', 'things', 'please', 'tell', 'show', 'explain', 'mean',
]);

const WORD_RE = /[A-Za-z_][A-Za-z0-9_]{2,}/g;

/** identifiers and words ≥ 3 chars minus the stoplist, ≤ 12, lower-cased, first occurrence wins */
export function lookupKeywords(message: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of message.matchAll(WORD_RE)) {
    const w = m[0].toLowerCase();
    if (seen.has(w) || LOOKUP_STOPLIST.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= LOOKUP_KEYWORDS_MAX) break;
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** mentions first, path-token overlap desc, shorter paths; ≤ 60 (≈ 1 ms over 20,000: one regex test per path, scoring only the matches) */
export function rankCandidates(candidates: readonly Candidate[], keywords: readonly string[], mentions: readonly string[]): Candidate[] {
  const mentionSet = new Set(mentions.map((m) => m.replace(/^@/, '')));
  const re = keywords.length > 0 ? new RegExp(keywords.map(escapeRe).join('|'), 'gi') : null;
  const scored: { c: Candidate; score: number }[] = [];
  for (const c of candidates) {
    const mentioned = mentionSet.has(c.path);
    let overlap = 0;
    if (re !== null) {
      re.lastIndex = 0;
      const seen = new Set<string>();
      for (const m of c.path.matchAll(re)) seen.add(m[0].toLowerCase());
      overlap = seen.size;
    }
    if (!mentioned && overlap === 0) continue;
    scored.push({ c, score: (mentioned ? 1000 : 0) + overlap });
  }
  scored.sort((a, b) => b.score - a.score || a.c.path.length - b.c.path.length || (a.c.path < b.c.path ? -1 : a.c.path > b.c.path ? 1 : 0));
  return scored.slice(0, LOOKUP_CANDIDATES_MAX).map((s) => s.c);
}

/** the context-stage exception (§5.5): criteria once, in the state */
export const LOOKUP_CRITERIA: JsonObject = {
  true: 'reading the file would show the code the question is about (its definition, its callers or its tests)',
  false: 'the file is unrelated to the question, or only shares a common word with it',
};

const DEFINITION_RE = /^\s*(export\s+)?(async\s+)?(def|class|function|const|let|var|fn|func|pub|interface|type|struct|impl|enum|module|trait|protocol)\b/;

/** ≤ 3 keyword lines of a file, definition lines first, in file order within each group */
export function excerptLines(content: string, keywords: readonly string[]): LookupLine[] {
  if (keywords.length === 0) return [];
  const re = new RegExp(keywords.map(escapeRe).join('|'), 'i');
  const defs: LookupLine[] = [];
  const rest: LookupLine[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length && defs.length < LOOKUP_LINES_MAX; i++) {
    const raw = lines[i] ?? '';
    if (raw.trim() === '' || !re.test(raw)) continue;
    const line = { n: i + 1, text: truncateCells(oneLine(raw.trim()), LOOKUP_EXCERPT_CELLS) };
    if (DEFINITION_RE.test(raw)) defs.push(line);
    else if (rest.length < LOOKUP_LINES_MAX) rest.push(line);
  }
  return [...defs, ...rest].slice(0, LOOKUP_LINES_MAX);
}

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };

export async function lookupCode(i: LookupInput): Promise<LookupResult> {
  const keywords = lookupKeywords(i.message);
  const ranked = rankCandidates(i.candidates, keywords, i.mentions);
  if (ranked.length === 0) return { hits: [], considered: 0, usage: ZERO_USAGE, latencyMs: 0, provider: i.provider, requestHash: '' };
  const state: JsonObject = { message: i.redact(i.message), files: ranked.map((c) => ({ path: c.path, bytes: c.bytes })), criteria: LOOKUP_CRITERIA };
  const questions: Record<string, Question> = {};
  ranked.forEach((c, k) => {
    questions[`file_${k}`] = contextNoul(`Would reading \`${c.path}\` help answer ${ref('message')}?`);
  });
  const r = await i.ask(state, questions);
  const selected = ranked
    .map((c, k) => {
      const a = r.answers[`file_${k}`];
      return { c, p: a && a.type === 'noul' && Number.isFinite(a.noul) ? a.noul : 0 };
    })
    .filter((s) => s.p >= LOOKUP_SELECT_FLOOR)
    .sort((a, b) => b.p - a.p)
    .slice(0, LOOKUP_HITS_MAX);
  const hits: LookupHit[] = [];
  for (const s of selected) {
    if (i.signal.aborted) throw i.signal.reason;
    const view = await i.read(s.c.path, LOOKUP_READ_BYTES);
    hits.push({ path: s.c.path, p: s.p, lines: view === null ? [] : excerptLines(view.content, keywords) });
  }
  return { hits, considered: ranked.length, usage: r.usage, latencyMs: r.latencyMs, provider: i.provider, requestHash: r.requestHash };
}

export const LOOKUP_HEADER = "In jev-only mode I can point at code but not explain it — Jev decides, it doesn't write. Likely places:";
export const LOOKUP_FOOTER = "Switch with /mode jev-on to get an explanation from the LLM, or describe the change and I'll make it.";
/** §3.6 / §12 verbatim — `candidates` even for one (the glossary's literal; pty and live expectations match `candidates\)`) */
export function lookupMissText(dir: string, considered: number): string {
  return `I couldn't find a file in ${dir} that clearly answers that (looked at ${considered} candidates). Name the file or function, or switch with /mode jev-on for an explanation.`;
}

/** one `  <path>:<n>  <text>` row, ≤ 120 cells */
export function lookupHitLine(path: string, line: LookupLine): string {
  const prefix = `  ${path}:${line.n}  `;
  const room = LOOKUP_LINE_CELLS - cellWidth(prefix);
  return room <= 0 ? truncateCells(prefix, LOOKUP_LINE_CELLS) : prefix + truncateCells(line.text, room);
}

/** the bubble of §3.6 (header, ≤ 3 lines per file, footer) or the miss line */
export function lookupLines(r: LookupResult, dir: string): string[] {
  if (r.hits.length === 0) return [lookupMissText(dir, r.considered)];
  const out = [LOOKUP_HEADER];
  for (const h of r.hits) {
    if (h.lines.length === 0) out.push(`  ${h.path}`);
    for (const l of h.lines) out.push(lookupHitLine(h.path, l));
  }
  out.push(LOOKUP_FOOTER);
  return out;
}
