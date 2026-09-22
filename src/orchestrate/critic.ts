/**
 * The critic is CODE (docs/ORCHESTRATION-DESIGN.md §5.3; §8.2 wave D3 item 23).
 *
 * Five hard rules computed from the diff `baseSha..<pinned>` and the verification output around
 * the merge, plus the one rule the grafts demoted [G8] from a hard fail to a human question.
 *
 * **Jev is never consulted about a hard rule.** Not to rank them, not to excuse one, not to
 * choose between them. The only route past a real hard fail is `/agent <slug> land --anyway`
 * typed twice, which the caller records in `RunMeta.overrides[]`; this module has no opinion
 * about that and no way to be talked out of a violation.
 *
 * The non-obvious invariant is in `outsideOwn`: the `∖ syncedDirty` term [D2] is what keeps the
 * `[a] include · [d] drop · [x] refuse` question rare enough to be worth asking. §2.6 already
 * keeps untouched carried paths out of the commit, so they are absent from the diff; this
 * subtraction is the belt for the path that is both carried AND genuinely edited, whose diff
 * correctly holds the parent's hunks too and must not be reported as "outside its slice".
 * `land.test.ts` asserts a 200-entry synced-dirty set produces ZERO prompts (corner row 19).
 *
 * Pure: no git, no clock, no I/O. The caller brings the diff, the counts and the two shas.
 */
import type { TestCounts } from '../core/types.js';
import { VERIFY_TAIL_LINES } from '../core/limits.js';
import { parseTestOutput, runnerFromCommand } from '../workspace/tests.js';
import { parseOwnGlob, ownsPath } from './split/globs.js';
import type { OwnGlob } from './split/globs.js';
import type { SyncedDirtyEntry } from './types.js';

/** One file of `git diff baseSha..<pinned>`; `added`/`removed` are the `+` and `-` LINES. */
export interface DiffFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
  added: readonly string[];
  removed: readonly string[];
}

export interface HardRuleInput {
  files: readonly DiffFile[];
  testGlobs: readonly string[];
  /** paths no diff may carry: `secretPaths`, `syncedIgnored`, submodule paths */
  forbidden: readonly string[];
  /** the counts parsed from the verify output BEFORE and AFTER the merge; null when unparsed */
  counts: { before: TestCounts | null; after: TestCounts | null };
  /** the merged tree's files that hold conflict markers, however the caller found them */
  conflictMarkerPaths: readonly string[];
  /** [G3] the sha pinned before verification, and `rev-parse` at merge time */
  pinned: string;
  pinnedNow: string;
}

export interface HardRuleViolation {
  rule: string;
  reason: string;
}

export type HardRuleResult = { ok: true } | { ok: false; violations: readonly HardRuleViolation[] };

/** The five rule names, so the transcript, `land.jsonl` and `RunMeta.overrides[]` agree on one spelling. */
export const HARD_RULES = {
  tests: 'tests-not-weakened',
  counts: 'test-count-not-dropped',
  forbidden: 'no-forbidden-path',
  conflicts: 'no-conflict-markers',
  pinned: 'pinned-sha-unchanged',
} as const;

// ---------------------------------------------------------------------------------------
// The test-glob matcher
// ---------------------------------------------------------------------------------------

/**
 * `orchestrate.testGlobs` is a BROADER language than the `own` sub-language of
 * `split/globs.ts`: its defaults pair a segment-spanning double-star prefix with a name pattern
 * (`test_` star `.py`, star `.test.` star) — a `*` inside a NAME, which none of the four `own`
 * forms allow and which `own` deliberately refuses, because ownership disjointness must stay
 * decidable by prefix containment. Hence this small dedicated matcher rather than a widening of
 * `globs.ts`, which would weaken §3.4 rule 3, "the whole safety argument of the design".
 *
 * A double-star spans path segments (as a prefix it also matches a root-level file); `*` and `?`
 * stop at `/`.
 */
function segmentPattern(seg: string): string {
  let out = '';
  for (const ch of seg) {
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

export function testGlobToRegExp(glob: string): RegExp {
  const parts = glob.split('/');
  let re = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? '';
    const last = i === parts.length - 1;
    if (p === '**') {
      re += last ? '.*' : '(?:[^/]+/)*';
      continue;
    }
    re += segmentPattern(p);
    if (!last) re += '/';
  }
  return new RegExp(`^${re}$`);
}

/** True when `path` matches any glob of `globs` (the test-glob language, not the `own` one). */
export function matchesTestGlob(globs: readonly string[], path: string): boolean {
  for (const g of globs) {
    if (g === '') continue;
    if (testGlobToRegExp(g).test(path)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------
// Rule 1 — tests are not removed or weakened
// ---------------------------------------------------------------------------------------

/**
 * §5.3's assertion shapes: `assert`, `expect(`, `should`, `t.Error`, `#[test]`. Case-insensitive,
 * so `Assert.Equal` and `Expect(` count; the rule measures a NET decrease, so the occasional false
 * positive on one side is cancelled by the same false positive on the other.
 */
const ASSERTION_RE = /assert|expect\(|\bshould\b|t\.Error|#\[test\]/i;

export function countAssertions(lines: readonly string[]): number {
  let n = 0;
  for (const l of lines) if (ASSERTION_RE.test(l)) n++;
  return n;
}

function checkTests(input: HardRuleInput, out: HardRuleViolation[]): void {
  for (const f of input.files) {
    if (!matchesTestGlob(input.testGlobs, f.path)) continue;
    if (f.status === 'D') {
      out.push({ rule: HARD_RULES.tests, reason: `deleted the test file ${f.path}` });
      continue;
    }
    const delta = countAssertions(f.removed) - countAssertions(f.added);
    if (delta > 0) out.push({ rule: HARD_RULES.tests, reason: `removed ${delta} assertion${delta === 1 ? '' : 's'} in ${f.path}` });
  }
}

// ---------------------------------------------------------------------------------------
// Rule 2 — the collected test count does not drop
// ---------------------------------------------------------------------------------------

export function totalCount(c: TestCounts): number {
  return c.passed + c.failed + c.errors + c.skipped;
}

function checkCounts(input: HardRuleInput, out: HardRuleViolation[]): void {
  const { before, after } = input.counts;
  // An unparsed count is not a violation: most runners the harness cannot parse are still green.
  if (before === null || after === null) return;
  const b = totalCount(before);
  const a = totalCount(after);
  if (a < b) out.push({ rule: HARD_RULES.counts, reason: `the collected test count dropped from ${b} to ${a}` });
}

// ---------------------------------------------------------------------------------------
// Rule 3 — no `.git`, no submodule, no `secretPaths`, no `syncedIgnored` file committed
// ---------------------------------------------------------------------------------------

function forbiddenMatch(forbidden: readonly string[], path: string): string | null {
  const segs = path.split('/');
  if (segs[0] === '.git' || segs.includes('.git')) return '.git';
  for (const f of forbidden) {
    if (f === '') continue;
    const clean = f.endsWith('/') ? f.slice(0, -1) : f;
    if (path === clean || path.startsWith(`${clean}/`)) return f;
  }
  return null;
}

function checkForbidden(input: HardRuleInput, out: HardRuleViolation[]): void {
  for (const f of input.files) {
    const hit = forbiddenMatch(input.forbidden, f.path);
    if (hit !== null) out.push({ rule: HARD_RULES.forbidden, reason: `the diff carries ${f.path}, which no diff may carry (${hit})` });
  }
}

// ---------------------------------------------------------------------------------------
// Rule 4 — the merge introduces no conflict markers
// ---------------------------------------------------------------------------------------

/** `^<<<<<<< ` and `^>>>>>>> ` — both, so a legitimate diff-of-a-diff needs both to be flagged. */
export function hasConflictMarkers(text: string): boolean {
  return /^<<<<<<< /m.test(text) && /^>>>>>>> /m.test(text);
}

function checkConflictMarkers(input: HardRuleInput, out: HardRuleViolation[]): void {
  const paths = input.conflictMarkerPaths.filter((p) => p !== '');
  if (paths.length === 0) return;
  const shown = paths.slice(0, 4).join(', ');
  const more = paths.length > 4 ? `, +${paths.length - 4} more` : '';
  out.push({ rule: HARD_RULES.conflicts, reason: `the merged tree holds conflict markers in ${shown}${more}` });
}

// ---------------------------------------------------------------------------------------
// Rule 5 — [G3] the pinned sha still matches at merge time
// ---------------------------------------------------------------------------------------

export const BRANCH_MOVED = 'the branch moved during verification';

function checkPinned(input: HardRuleInput, out: HardRuleViolation[]): void {
  if (input.pinnedNow !== input.pinned) out.push({ rule: HARD_RULES.pinned, reason: BRANCH_MOVED });
}

/** The five hard rules, in §5.3's order. Every violation is reported, not only the first. */
export function checkHardRules(input: HardRuleInput): HardRuleResult {
  const violations: HardRuleViolation[] = [];
  checkTests(input, violations);
  checkCounts(input, violations);
  checkForbidden(input, violations);
  checkConflictMarkers(input, violations);
  checkPinned(input, violations);
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

// ---------------------------------------------------------------------------------------
// [G8] The demotion — a HUMAN question, never a Jev one
// ---------------------------------------------------------------------------------------

export interface OutsideOwnInput {
  changed: readonly string[];
  own: readonly string[];
  syncedDirty: readonly SyncedDirtyEntry[];
  incidentalGlobs: readonly string[];
}

/** `changed ∩ complement(own) ∖ syncedDirty ∖ incidentalGlobs`, sorted and deduplicated. */
export function outsideOwn(input: OutsideOwnInput): string[] {
  const globs: OwnGlob[] = [];
  for (const raw of input.own) {
    const p = parseOwnGlob(raw);
    // An unparsable `own` glob owns nothing: normalisation rule 2 already deleted such an option,
    // so reaching one here means widening ownership on a malformed string, which we refuse to do.
    if (p.ok) globs.push(p.glob);
  }
  const carried = new Set(input.syncedDirty.map((e) => e.path));
  const out = new Set<string>();
  for (const p of input.changed) {
    if (p === '') continue;
    if (ownsPath(globs, p)) continue;
    if (carried.has(p)) continue;
    if (matchesTestGlob(input.incidentalGlobs, p)) continue;
    out.add(p);
  }
  return [...out].sort();
}

/** How many paths the §4.8 one-liner names before it says "+N more". */
const QUESTION_PATHS_SHOWN = 4;

export interface IncludeDropQuestion {
  prompt: string;
  lines: readonly string[];
  choices: readonly ['a', 'd', 'x'];
}

/**
 * §4.8's string, or null when there is nothing to ask about:
 * `fix-store touched 2 files outside its slice (package-lock.json, dist/x.js) — [a] include them ·
 * [d] drop them from the merge · [x] refuse`
 *
 * Only `[d]` and `[x]` consume a kick (§5.3); this function does not decide that, it only asks.
 */
export function buildIncludeDropQuestion(slug: string, outside: readonly string[]): IncludeDropQuestion | null {
  const paths = [...new Set(outside.filter((p) => p !== ''))].sort();
  if (paths.length === 0) return null;
  const shown = paths.slice(0, QUESTION_PATHS_SHOWN).join(', ');
  const more = paths.length > QUESTION_PATHS_SHOWN ? `, +${paths.length - QUESTION_PATHS_SHOWN} more` : '';
  const noun = paths.length === 1 ? 'file' : 'files';
  const prompt = `${slug} touched ${paths.length} ${noun} outside its slice (${shown}${more}) — [a] include them · [d] drop them from the merge · [x] refuse`;
  return { prompt, lines: paths, choices: ['a', 'd', 'x'] };
}

// ---------------------------------------------------------------------------------------
// Corner row 41 — the flaky flag, REPORTED and never acted on
// ---------------------------------------------------------------------------------------

export interface VerifyHistoryEntry {
  command: string;
  dockHead: string;
  ok: boolean;
}

/**
 * True when the same command already passed on THIS dock head and the merge touched no file the
 * test reads. It is a flag on the row and in `land.jsonl`, nothing else: `verifyRetries` defaults
 * to 0 and the design never auto-retries a test to green (§5.3, corner row 41).
 */
export function flakyFlag(
  history: readonly VerifyHistoryEntry[],
  attempt: { command: string; dockHead: string; touched: readonly string[] },
  testReads: (cmd: string) => readonly string[],
): boolean {
  const passedHere = history.some((h) => h.ok && h.command === attempt.command && h.dockHead === attempt.dockHead);
  if (!passedHere) return false;
  const reads = new Set(testReads(attempt.command));
  for (const t of attempt.touched) if (reads.has(t)) return false;
  return true;
}

// ---------------------------------------------------------------------------------------
// Verify output
// ---------------------------------------------------------------------------------------

/**
 * `VerifyResult.counts`, built on the workspace's own parsers — never reimplemented here.
 * `runnerFromCommand` knows only the Python runners plus the two npm shapes, so an unrecognised
 * command falls back to the `'unknown'` runner, which tries every parser in turn and still
 * returns null when none matches (`npx vitest run`, `cargo test` and `go test` are the cases this
 * buys; the observable contract "null when unparsed" is unchanged).
 */
export function parseVerifyCounts(command: string, output: string): TestCounts | null {
  return parseTestOutput(runnerFromCommand(command) ?? 'unknown', output);
}

/** The last `n` lines of a command's combined output, for `VerifyResult.tail` / `land.jsonl`. */
export function tailLines(output: string, n: number = VERIFY_TAIL_LINES): string[] {
  if (typeof output !== 'string' || output === '') return [];
  const lines = output.split(/\r?\n/);
  while (lines.length > 0 && (lines[lines.length - 1] ?? '') === '') lines.pop();
  return n <= 0 ? [] : lines.slice(-n);
}
