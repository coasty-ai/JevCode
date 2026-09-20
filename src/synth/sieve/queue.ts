/**
 * The global verification queue of the Ledger + Sieve search (docs/JEV-ONLY-DESIGN.md §2.3, §6
 * row `queue.ts`). One queue per sub-goal search, shared by every site and source: jobs are
 * ordered by (base passed desc, p desc, source prior desc) with a stable insertion tiebreak, so an
 * 'improved' base is verified before the committed one, Jev's ranking (or the source prior in
 * SIEVE mode) orders the rest, and enumeration order breaks ties deterministically.
 *
 * Everything here is code; no Jev question is asked. The queue applies the design's free
 * pre-checks once, at enqueue time, so the runner only ever sees jobs worth a test run:
 *
 * - dedupe: one job per (base, site, canonical text) and per (base, candidate id). The base is
 *   part of the key because every source derives a candidate's id from (site, text) alone, and
 *   §2.3 enumerates the same candidates once per base: the same edit on top of a held partial
 *   ('improved' base, §4.4) is a different experiment, not a duplicate. The canonical text is the
 *   candidate's code tokens joined by single spaces (`a+b` ≡ `a + b`, comments dropped). It is
 *   deliberately NOT `py/similarity.normaliseLine`, which abstracts identifiers and literals to
 *   `ID`/`NUM`/`STR`: that would fold `gcd(b, a % b)` and `gcd(a, b % a)` into one entry and
 *   drop real mutants, while the sieve's measured strength is that it runs every one of them
 *   (gold passes 35/36, `contrarian-exhaustive.truth.jsonl`).
 * - unchanged-line removal: a replace candidate whose canonical text equals the site's current
 *   line is the buggy program again (removing it from Q8 turned 20/20 test-passing top picks,
 *   `probe-question-design.md`); an empty insert candidate inserts nothing; so is any candidate
 *   whose applied diff is empty.
 * - vocabulary pre-check (`vocabularyOf` / `passesVocab`): a candidate whose NAME tokens include
 *   one that is not an identifier of the file, of the failing tests, of the task text, a Python
 *   keyword, a builtin or a method of a builtin type cannot be a fix as the sources define one.
 *   Each edited file is checked against its own vocabulary (a composite unit's call-site edit in
 *   another file uses that file's names); a file without a vocabulary is not checked.
 *   Measured: 100 % of QuixBugs and 72 % of SWE-bench Verified fixed lines pass the file + tests
 *   vocabulary (`coverage-study.md` criterion (c), design conclusion 6).
 * - `tried` exclusion: `sha12` of the applied unified diff, the same key the run memory keeps for
 *   every candidate ever run (§2.1 `tried`), so a candidate re-enumerated on a later step is never
 *   run twice. A candidate whose edit no longer applies to the base (stale site) is dropped too.
 * - carry-over: jobs that were queued but not popped this step come back from `carryOver()` and
 *   are re-enqueued next step through the constructor, keyed by candidate id, so a RANK-mode p that
 *   cost a Jev request is not re-asked and a re-enumerated copy of the same candidate is a duplicate.
 */
import { sha12 } from '../../core/hash.js';
import { isKeyword, PY_BUILTINS, PY_KEYWORDS, PyEditError, tokenizeFragment } from '../py/index.js';
import type { Candidate, CandidateSourceName, FailureView, Site, SourceFile } from '../types.js';
import { applyCandidate } from '../verify/apply.js';
import { VerifyError } from '../verify/types.js';
import type { Base, VerifyJob } from '../search/types.js';

// ---------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------

/**
 * Default source prior when a candidate carries none: design §3's priority order encoded as a
 * descending ordinal (mutation 1, templates 2, donors 3, composite 4, sketch/fill 5, beam 6).
 * It is an ordering device only ("nothing is ever skipped, the prior only decides which source
 * spends the budget first", §3), never a probability, and it is not a measured quantity.
 */
export const SOURCE_ORDER_PRIOR: Readonly<Record<CandidateSourceName, number>> = {
  mutation: 0.6,
  template: 0.5,
  donor: 0.4,
  composite: 0.3,
  test_value: 0.3,
  history: 0.2,
  token_beam: 0.1,
};

/**
 * Public methods of the builtin container/scalar types, exactly the set the coverage study added
 * to its vocabulary (`coverage_study.py` BUILTINS: `dir(T)` for list, dict, set, str, tuple, int,
 * float, bytes, frozenset without dunder names; Python 3.9). Attribute names are NAME tokens, so
 * `x.append(y)` needs `append` in the vocabulary even when the file never calls it.
 */
export const BUILTIN_TYPE_METHODS: readonly string[] = [
  'add', 'append', 'as_integer_ratio', 'bit_length', 'capitalize', 'casefold', 'center', 'clear', 'conjugate', 'copy', 'count',
  'decode', 'denominator', 'difference', 'difference_update', 'discard', 'encode', 'endswith', 'expandtabs', 'extend', 'find',
  'format', 'format_map', 'from_bytes', 'fromhex', 'fromkeys', 'get', 'hex', 'imag', 'index', 'insert', 'intersection',
  'intersection_update', 'is_integer', 'isalnum', 'isalpha', 'isascii', 'isdecimal', 'isdigit', 'isdisjoint', 'isidentifier',
  'islower', 'isnumeric', 'isprintable', 'isspace', 'issubset', 'issuperset', 'istitle', 'isupper', 'items', 'join', 'keys',
  'ljust', 'lower', 'lstrip', 'maketrans', 'numerator', 'partition', 'pop', 'popitem', 'real', 'remove', 'removeprefix',
  'removesuffix', 'replace', 'reverse', 'rfind', 'rindex', 'rjust', 'rpartition', 'rsplit', 'rstrip', 'setdefault', 'sort',
  'split', 'splitlines', 'startswith', 'strip', 'swapcase', 'symmetric_difference', 'symmetric_difference_update', 'title',
  'to_bytes', 'translate', 'union', 'update', 'upper', 'values', 'zfill',
];

/** Names the coverage study always allowed besides keywords and builtins (`coverage_study.py` BUILTINS). */
export const ALWAYS_IN_VOCAB: readonly string[] = ['self', 'cls'];

// ---------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------

/** The set of NAME tokens a candidate may use at a site. */
export type Vocabulary = ReadonlySet<string>;

const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
/** Words set off as code in prose: `x`, 'x', "x" (the study's SWE vocabulary came from the test patch; issue words are the §9 R5 extension). */
const QUOTED_RE = /`([^`\n]+)`|'([^'\n]+)'|"([^"\n]+)"/g;
/** A prose token that reads as a code name: has an underscore or a digit, or is camelCase/CapWords, or is dotted. */
const CODE_LIKE_RE = /^(?=.*[_0-9])[A-Za-z_][A-Za-z0-9_]*$|^[a-z]+[A-Z][A-Za-z0-9]*$|^[A-Z][a-z]+[A-Z][A-Za-z0-9]*$/;

function identifiersInText(text: string): string[] {
  return text.match(IDENTIFIER_RE) ?? [];
}

/**
 * Names in free prose worth adding to the vocabulary: every identifier inside quotes or
 * backticks (dotted paths split on `.`), every token that reads as code (underscore, digit,
 * camelCase, CapWords) and every token directly followed by `(` or preceded by `.`. Plain
 * English words are left out so a long issue text does not turn the pre-check into a no-op.
 */
export function namesInProse(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(QUOTED_RE)) {
    const inner = m[1] ?? m[2] ?? m[3] ?? '';
    for (const id of identifiersInText(inner)) out.add(id);
  }
  const re = new RegExp(IDENTIFIER_RE.source, 'g');
  for (const m of text.matchAll(re)) {
    const word = m[0];
    const before = m.index > 0 ? text[m.index - 1] : '';
    const after = text[m.index + word.length] ?? '';
    // a dotted path needs a name on both sides of the dot; a sentence-final word is prose
    const dotted = (before === '.' && /[A-Za-z0-9_]/.test(text[m.index - 2] ?? '')) || (after === '.' && /[A-Za-z_]/.test(text[m.index + word.length + 1] ?? ''));
    if (CODE_LIKE_RE.test(word) || after === '(' || dotted) out.add(word);
  }
  return [...out];
}

/**
 * The vocabulary of one file for one goal: NAME tokens of the file ∪ identifiers named by the
 * failing tests (their ids, calls, expected and actual text: an `AttributeError: ... 'bar'` names
 * the attribute a fix must add) ∪ code names and quoted words of the task text ∪ Python keywords,
 * builtins, builtin-type methods and `self`/`cls`. Measured as criterion (c) "file + tests" in
 * `coverage-study.md`: 40/40 QuixBugs and 144/199 (72 %) SWE fixed lines pass it.
 */
export function vocabularyOf(file: SourceFile, tests: readonly FailureView[], taskText: string): Vocabulary {
  const vocab = new Set<string>();
  for (const t of file.mod.tokens) if (t.type === 'NAME') vocab.add(t.text);
  for (const f of tests) {
    // test text is code-like (calls, node ids, reprs), so every identifier-shaped token counts
    for (const s of [f.testId, f.call, f.expected, f.actual]) for (const id of identifiersInText(s)) vocab.add(id);
  }
  for (const id of namesInProse(taskText)) vocab.add(id);
  for (const k of PY_KEYWORDS) vocab.add(k);
  for (const b of PY_BUILTINS) vocab.add(b);
  for (const m of BUILTIN_TYPE_METHODS) vocab.add(m);
  for (const n of ALWAYS_IN_VOCAB) vocab.add(n);
  return vocab;
}

/** `vocabularyOf` for every file of a base, keyed by path: the `VerifyQueueOptions.vocab` map. */
export function vocabulariesOf(files: ReadonlyMap<string, SourceFile>, tests: readonly FailureView[], taskText: string): Map<string, Vocabulary> {
  const out = new Map<string, Vocabulary>();
  for (const [path, file] of files) out.set(path, vocabularyOf(file, tests, taskText));
  return out;
}

/** Every text a candidate writes: its line plus the text of each extra edit. */
function candidateTexts(candidate: Pick<Candidate, 'text' | 'extraEdits'>): string[] {
  return candidateEdits(candidate).map((e) => e.text);
}

/** Every (file, text) a candidate writes: the site line in the site's file, then each extra edit with a text. */
function candidateEdits(candidate: Pick<Candidate, 'text' | 'extraEdits'> & Partial<Pick<Candidate, 'site'>>): { path: string; text: string }[] {
  const out = [{ path: candidate.site?.file.path ?? '', text: candidate.text }];
  for (const e of candidate.extraEdits ?? []) if (e.text !== undefined) out.push({ path: e.path, text: e.text });
  return out;
}

function missingNames(text: string, vocab: Vocabulary, into: Set<string>): void {
  for (const t of tokenizeFragment(text)) if (t.type === 'NAME' && !isKeyword(t.text) && !vocab.has(t.text)) into.add(t.text);
}

/** NAME tokens of `candidate` (line and extra edits) that are not in `vocab`, in first-seen order. */
export function missingFromVocab(candidate: Candidate, vocab: Vocabulary): string[] {
  const missing = new Set<string>();
  for (const text of candidateTexts(candidate)) missingNames(text, vocab, missing);
  return [...missing];
}

/**
 * Per-file form of `missingFromVocab`: each edit is checked against the vocabulary of the file it
 * writes to (a composite unit's call-site edit in another file uses that file's names, §3 source
 * 4); an edit into a file with no vocabulary is not checked.
 */
export function missingFromVocabByPath(candidate: Candidate, vocabByPath: ReadonlyMap<string, Vocabulary>): string[] {
  const missing = new Set<string>();
  for (const e of candidateEdits(candidate)) {
    const vocab = vocabByPath.get(e.path);
    if (vocab !== undefined) missingNames(e.text, vocab, missing);
  }
  return [...missing];
}

/** True when every NAME token the candidate writes is in the vocabulary (the free pre-check of design §3). */
export function passesVocab(candidate: Candidate, vocab: Vocabulary): boolean {
  return missingFromVocab(candidate, vocab).length === 0;
}

// ---------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------

function codeTokenTexts(text: string): string[] {
  const out: string[] = [];
  for (const t of tokenizeFragment(text)) {
    if (t.type === 'NAME' || t.type === 'NUMBER' || t.type === 'STRING' || t.type === 'OP' || t.type === 'ERRORTOKEN') out.push(t.text);
  }
  return out;
}

/**
 * Whitespace- and comment-insensitive form of a candidate text: code tokens joined by one space,
 * extra edits appended as further lines. Identifiers and literals are kept verbatim (see the
 * header for why `normaliseLine` is not used).
 */
export function canonicalText(candidate: Pick<Candidate, 'text' | 'extraEdits'>): string {
  return candidateTexts(candidate).map((t) => codeTokenTexts(t).join(' ')).join('\n');
}

/** One key per edit location: file, line and kind (a replace and an insert at the same line are different sites). */
export function siteKey(site: Site): string {
  return `${site.file.path}:${site.line}:${site.kind}`;
}

/** The unchanged program: a replace whose canonical text is the current line, or an insert of nothing. */
export function isUnchanged(candidate: Candidate): boolean {
  const own = codeTokenTexts(candidate.text).join(' ');
  if (candidate.site.kind === 'insert') return own.length === 0 && (candidate.extraEdits ?? []).length === 0;
  return own === codeTokenTexts(candidate.site.currentLine).join(' ') && (candidate.extraEdits ?? []).length === 0;
}

/** `tried` key of an applied diff: `sha12(diff)`, as `SearchMemory.tried` and `PersistedSearchState.tried` store it. */
export function triedKey(diff: string): string {
  return sha12(diff);
}

/** A probability that is not a finite number (a ranker bug) sorts last rather than breaking the comparator. */
function finiteOrZero(x: number): number {
  return Number.isFinite(x) ? x : 0;
}

/** The queue key of a job: (base passed, p, source prior), each sorted descending. */
export function verifyKey(base: Base, p: number, sourcePrior: number): [number, number, number] {
  return [finiteOrZero(base.summary.passed), finiteOrZero(p), finiteOrZero(sourcePrior)];
}

/** The candidate's own prior when the source set one, else the §3 source-order ordinal. */
export function sourcePriorOf(candidate: Candidate): number {
  return candidate.prior ?? SOURCE_ORDER_PRIOR[candidate.source];
}

/**
 * Build a job. `p` defaults to the source prior (SIEVE mode: "no Jev; tests rank", §2.3); RANK
 * mode passes the Noul/Choice probability.
 */
export function jobFor(candidate: Candidate, base: Base, p?: number): VerifyJob {
  const sourcePrior = sourcePriorOf(candidate);
  const prob = p ?? sourcePrior;
  return { candidate, base, p: prob, sourcePrior, key: verifyKey(base, prob, sourcePrior) };
}

// ---------------------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------------------

export type DropReason = 'duplicate' | 'unchanged' | 'tried' | 'vocab' | 'apply_failed';
export type AddResult = 'queued' | DropReason;

/** A queued job carries the hash of its applied diff so the runner can add it to `tried` without re-applying. */
export interface QueuedJob extends VerifyJob {
  readonly diffHash: string;
}

export interface AddSummary {
  queued: QueuedJob[];
  dropped: Record<DropReason, number>;
}

export interface VerifyQueueOptions {
  /**
   * `sha12(diff)` of every candidate already run in this run; the queue never enqueues them again.
   * Pass the live `SearchMemory.tried` set: additions the runner makes while the queue exists are
   * seen by later `add` calls.
   */
  tried?: ReadonlySet<string>;
  /** Per-file vocabulary (`vocabularyOf`); when given, each edit into a file that has one is checked (`missingFromVocabByPath`). */
  vocab?: ReadonlyMap<string, Vocabulary>;
  /** Jobs returned by a previous step's `carryOver()`, re-enqueued first (re-checked against `tried`). */
  carried?: readonly VerifyJob[];
}

interface Entry {
  job: QueuedJob;
  /** Insertion sequence: the stable tiebreak when keys are equal. */
  seq: number;
}

/** Descending on each key component, then ascending insertion order. */
function compareEntries(a: Entry, b: Entry): number {
  for (let i = 0; i < 3; i++) {
    const d = (b.job.key[i] ?? 0) - (a.job.key[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.seq - b.seq;
}

/** Candidate ids are per (site, text) in every source, so a queued id is identified together with its base. */
function idKey(baseId: string, candidateId: string): string {
  return `${baseId}\u0000${candidateId}`;
}

function emptyDrops(): Record<DropReason, number> {
  return { duplicate: 0, unchanged: 0, tried: 0, vocab: 0, apply_failed: 0 };
}

export class VerifyQueue {
  private readonly entries: Entry[] = [];
  private readonly ids = new Set<string>();
  private readonly texts = new Set<string>();
  private readonly tried: ReadonlySet<string>;
  private readonly vocab: ReadonlyMap<string, Vocabulary> | null;
  private seq = 0;
  private poppedCount = 0;
  readonly dropped: Record<DropReason, number> = emptyDrops();

  constructor(opts: VerifyQueueOptions = {}) {
    this.tried = opts.tried ?? new Set<string>();
    this.vocab = opts.vocab ?? null;
    // carried jobs go first so the previous step's Jev ranking keeps its place; a fresh copy of
    // the same candidate enumerated again this step is then a duplicate by id
    for (const job of opts.carried ?? []) this.add(job);
  }

  /** Jobs waiting to be popped. */
  get size(): number {
    return this.entries.length;
  }

  /** Jobs handed to the runner so far (this queue's lifetime). */
  get popped(): number {
    return this.poppedCount;
  }

  /** Whether a candidate with this id is queued on `baseId` (any base when omitted); popped jobs no longer count. */
  has(candidateId: string, baseId?: string): boolean {
    if (baseId !== undefined) return this.ids.has(idKey(baseId, candidateId));
    for (const e of this.entries) if (e.job.candidate.id === candidateId) return true;
    return false;
  }

  /**
   * Enqueue one job after the free pre-checks, in this order: id / canonical-text duplicate,
   * unchanged line, vocabulary, applicability on the job's base, `tried`. The key is recomputed
   * from the job's fields so a stale `key` can never misorder the queue.
   */
  add(job: VerifyJob): AddResult {
    return this.enqueue(job).result;
  }

  /** Enqueue many jobs; returns the ones that made it and a count per drop reason for the trace. */
  addAll(jobs: Iterable<VerifyJob>): AddSummary {
    const summary: AddSummary = { queued: [], dropped: emptyDrops() };
    for (const job of jobs) {
      const r = this.enqueue(job);
      if (r.result === 'queued') summary.queued.push(r.queued);
      else summary.dropped[r.result]++;
    }
    return summary;
  }

  /**
   * The §2.3 form `queue.addAll(cands, p = sourcePrior)`: enqueue candidates on `base`, with `p`
   * the source prior (SIEVE mode) or a per-candidate probability (RANK mode, e.g. the Noul p of
   * `RankedCandidate`). Jobs are built with `jobFor`.
   */
  addCandidates(candidates: Iterable<Candidate>, base: Base, p?: number | ((candidate: Candidate) => number)): AddSummary {
    const jobs: VerifyJob[] = [];
    for (const c of candidates) jobs.push(jobFor(c, base, typeof p === 'function' ? p(c) : p));
    return this.addAll(jobs);
  }

  /** The next job without removing it. */
  peek(): QueuedJob | undefined {
    return this.entries[0]?.job;
  }

  /** Remove and return the best `n` jobs in key order (fewer when the queue runs out). */
  pop(n: number): QueuedJob[] {
    const taken = this.entries.splice(0, Math.max(0, Math.floor(n)));
    for (const e of taken) this.ids.delete(idKey(e.job.base.id, e.job.candidate.id));
    this.poppedCount += taken.length;
    return taken.map((e) => e.job);
  }

  /**
   * End of step: remove and return every job not popped, in key order, for the next step's
   * `VerifyQueue({ carried })`. Their canonical texts stay reserved in this (now empty) queue
   * only until it is discarded; the new queue re-applies every pre-check.
   */
  carryOver(): QueuedJob[] {
    const rest = this.entries.splice(0, this.entries.length);
    for (const e of rest) this.ids.delete(idKey(e.job.base.id, e.job.candidate.id));
    return rest.map((e) => e.job);
  }

  /** Snapshot of the queue in key order (for traces and tests); does not consume. */
  toArray(): readonly QueuedJob[] {
    return this.entries.map((e) => e.job);
  }

  private drop(reason: DropReason): { result: DropReason } {
    this.dropped[reason]++;
    return { result: reason };
  }

  private enqueue(job: VerifyJob): { result: 'queued'; queued: QueuedJob } | { result: DropReason } {
    const { candidate, base } = job;
    const idK = idKey(base.id, candidate.id);
    const textKey = `${base.id}\u0000${siteKey(candidate.site)}\u0000${canonicalText(candidate)}`;
    if (this.ids.has(idK) || this.texts.has(textKey)) return this.drop('duplicate');
    if (isUnchanged(candidate)) return this.drop('unchanged');
    if (this.vocab !== null && missingFromVocabByPath(candidate, this.vocab).length > 0) return this.drop('vocab');
    let diff: string;
    try {
      diff = applyCandidate(candidate, base.files).diff;
    } catch (e) {
      // the site no longer reads `currentLine` on this base (an earlier edit moved it) or an extra
      // edit is out of range: nothing to run. Anything else is a bug and must surface.
      if (e instanceof VerifyError || e instanceof PyEditError) return this.drop('apply_failed');
      throw e;
    }
    // the edits cancel out (e.g. an extra edit rewrites a line with its own text): the base again
    if (diff === '') return this.drop('unchanged');
    const diffHash = triedKey(diff);
    if (this.tried.has(diffHash)) return this.drop('tried');

    const queued: QueuedJob = { ...job, key: verifyKey(base, job.p, job.sourcePrior), diffHash };
    const entry: Entry = { job: queued, seq: this.seq++ };
    this.entries.splice(this.insertionIndex(entry), 0, entry);
    this.ids.add(idK);
    this.texts.add(textKey);
    return { result: 'queued', queued };
  }

  /** Binary search for the first entry that sorts after `entry` (equal keys go after: stable). */
  private insertionIndex(entry: Entry): number {
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareEntries(this.entries[mid]!, entry) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
