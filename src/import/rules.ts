/**
 * Rule activation (docs/IMPORT-DESIGN.md §2.10.4, §2.5, §2.8 `rulePatterns`/`ruleFiles` [G1.6]).
 *
 * `matchRules(rules, paths)` decides which imported rule files the engine injects into a step's
 * `## Rules in scope` section. It is **pure and dependency-free** — a small glob matcher over the
 * already-capped 200 patterns, memoised per step — because it runs once per step on the hot path and
 * `src/import/**` may not reach into `src/loop`, `src/session` or the filesystem (§7 ownership).
 *
 * Both matchers are single-pass with one backtrack pointer (the classic wildcard algorithm), so a
 * pattern like `**​/*​/*​/*​/*a` is O(pattern × path) and never exponential: §6 row 15's "a pathological
 * pattern must not blow up" is a structural property here, not a timeout.
 */
import { IMPORT_LIMITS } from '../core/limits.js';
import type { MemoryItem } from './types.js';

/** §2.8: the two bounds a caller may narrow (never widen — the defaults are the ceilings). */
export interface MatchOptions {
  /** rule files considered per step; default `IMPORT_LIMITS.ruleFiles` (200) [G1.6] */
  maxRules?: number;
  /** patterns considered per rule after brace expansion; default `IMPORT_LIMITS.rulePatterns` (200) */
  maxPatterns?: number;
}

/**
 * §2.10.4: the per-step matcher. `match` is memoised on the joined path set **and** on each
 * `(pattern, path)` pair, so a rule with no match costs exactly one glob test per new pair and
 * nothing at all on a repeat. `tests` is that memo's observable — the gate asserts it rather than
 * inferring memoisation from wall time.
 */
export interface RuleMatcher {
  match(paths: readonly string[]): readonly MemoryItem[];
  /** rule files this matcher considers, after the `maxRules` cap */
  readonly size: number;
  /** glob evaluations performed since construction */
  readonly tests: number;
}

// ---------------------------------------------------------------------------------------
// the glob matcher
// ---------------------------------------------------------------------------------------

/** End index of the character class starting at `from`, or -1 when it never closes. */
function classEnd(pattern: string, from: number): number {
  let i = from + 1;
  if (pattern[i] === '!' || pattern[i] === '^') i++;
  if (pattern[i] === ']') i++;
  for (; i < pattern.length; i++) if (pattern[i] === ']') return i;
  return -1;
}

/** `[abc]`, `[a-z]`, `[!abc]` / `[^abc]` against one character. */
function classMatches(body: string, ch: string): boolean {
  let i = 0;
  let negate = false;
  if (body[i] === '!' || body[i] === '^') {
    negate = true;
    i++;
  }
  let hit = false;
  for (; i < body.length; i++) {
    const c = body[i]!;
    const next = body[i + 1];
    const after = body[i + 2];
    if (next === '-' && after !== undefined) {
      if (ch >= c && ch <= after) hit = true;
      i += 2;
      continue;
    }
    if (c === ch) hit = true;
  }
  return negate ? !hit : hit;
}

/**
 * One path segment against one pattern segment: `*` (not crossing `/`), `?` and character classes.
 * Single backtrack pointer, so the worst case is O(|pattern| × |segment|) with no stack growth.
 */
function matchSegment(pattern: string, segment: string): boolean {
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < segment.length) {
    let advanced = false;
    if (p < pattern.length) {
      const c = pattern[p]!;
      if (c === '*') {
        star = p;
        mark = s;
        p++;
        continue;
      }
      if (c === '?') {
        p++;
        s++;
        continue;
      }
      if (c === '[') {
        const end = classEnd(pattern, p);
        if (end !== -1) {
          if (classMatches(pattern.slice(p + 1, end), segment[s]!)) {
            p = end + 1;
            s++;
            advanced = true;
          }
        } else if (c === segment[s]) {
          p++;
          s++;
          advanced = true;
        }
      } else if (c === segment[s]) {
        p++;
        s++;
        advanced = true;
      }
    }
    if (advanced) continue;
    if (star === -1) return false;
    p = star + 1;
    mark++;
    s = mark;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/** Segment lists, with `**` matching zero or more segments. Same single-backtrack shape. */
function matchSegments(pats: readonly string[], segs: readonly string[]): boolean {
  let pi = 0;
  let si = 0;
  let starPi = -1;
  let starSi = 0;
  while (si < segs.length) {
    if (pi < pats.length && pats[pi] === '**') {
      starPi = pi;
      starSi = si;
      pi++;
      continue;
    }
    if (pi < pats.length && matchSegment(pats[pi]!, segs[si]!)) {
      pi++;
      si++;
      continue;
    }
    if (starPi === -1) return false;
    pi = starPi + 1;
    starSi++;
    si = starSi;
  }
  while (pi < pats.length && pats[pi] === '**') pi++;
  return pi === pats.length;
}

/** Split a path or pattern on `/`, dropping `.` and empty segments so `./a` === `a`. */
function segmentsOf(p: string): readonly string[] {
  return p
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0 && s !== '.');
}

/**
 * `{a,b}` expansion, innermost-first and bounded by `limit`: a pattern that would expand past the
 * cap keeps its remaining braces literal rather than allocating (§2.8 `rulePatterns`).
 */
export function expandBraces(pattern: string, limit: number = IMPORT_LIMITS.rulePatterns): readonly string[] {
  const open = pattern.indexOf('{');
  if (open === -1 || limit <= 1) return [pattern];
  let depth = 0;
  let close = -1;
  const commas: number[] = [];
  for (let i = open; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    } else if (c === ',' && depth === 1) commas.push(i);
  }
  if (close === -1) return [pattern];
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const bounds = [open, ...commas, close];
  const out: string[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const alt = pattern.slice(bounds[i]! + 1, bounds[i + 1]!);
    for (const rest of expandBraces(`${head}${alt}${tail}`, limit - out.length)) {
      if (out.length >= limit) return out;
      if (!out.includes(rest)) out.push(rest);
    }
  }
  return out.length > 0 ? out : [pattern];
}

/**
 * §2.10.4: the small glob matcher — `**`, `*`, `?`, `{a,b}` and character classes, POSIX separators
 * only. A pattern with no `/` matches the **basename** at any depth (`*.ts` ≡ `**​/*.ts`), which is
 * what a Cursor `globs:`, a Copilot `applyTo:` and a Claude `paths:` all mean; anything with a `/` is
 * anchored at the path root. Pure, linear, no backtracking blowup.
 */
export function globMatch(pattern: string, path: string): boolean {
  if (pattern.length === 0 || path.length === 0) return false;
  const segs = segmentsOf(path);
  if (segs.length === 0) return false;
  for (const expanded of expandBraces(pattern)) {
    const anchored = /[\\/]/.test(expanded) ? expanded : `**/${expanded}`;
    if (matchSegments(segmentsOf(anchored), segs)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------
// the per-step matcher
// ---------------------------------------------------------------------------------------

/** §2.5: `always` fires on every step, `manual` never fires implicitly, `paths` consults the globs. */
function patternsOf(rule: MemoryItem, maxPatterns: number): readonly string[] | 'always' | 'never' {
  const trigger = rule.trigger ?? (rule.paths && rule.paths.length > 0 ? 'paths' : 'manual');
  if (trigger === 'manual') return 'never';
  const paths = rule.paths ?? [];
  // §2.5: `always` is a rule file with `paths: ["**"]`, never an AGENTS.md promotion
  if (trigger === 'always') return paths.length === 0 || paths.includes('**') ? 'always' : paths.slice(0, maxPatterns);
  if (paths.length === 0) return 'never';
  return paths.slice(0, maxPatterns);
}

/**
 * §2.10.4: build a matcher over `rules` once and reuse it for every step of a run. The `rules` array
 * is capped at `maxRules` here, so the per-step cost is bounded no matter how many rule files the
 * import produced.
 */
export function createRuleMatcher(rules: readonly MemoryItem[], opts: MatchOptions = {}): RuleMatcher {
  const maxRules = Math.max(0, opts.maxRules ?? IMPORT_LIMITS.ruleFiles);
  const maxPatterns = Math.max(0, opts.maxPatterns ?? IMPORT_LIMITS.rulePatterns);
  const kept = rules.slice(0, maxRules);
  const compiled = kept.map((rule) => ({ rule, patterns: patternsOf(rule, maxPatterns) }));
  /** `(pattern, path)` → verdict; the "one glob test per rule with no match" memo */
  const pairs = new Map<string, boolean>();
  /** joined path set → the step's answer; a re-ask inside the same step costs nothing */
  const steps = new Map<string, readonly MemoryItem[]>();
  let tests = 0;

  const hit = (pattern: string, path: string): boolean => {
    const key = `${pattern}\u0000${path}`;
    const memo = pairs.get(key);
    if (memo !== undefined) return memo;
    tests++;
    const verdict = globMatch(pattern, path);
    pairs.set(key, verdict);
    return verdict;
  };

  return {
    get size(): number {
      return compiled.length;
    },
    get tests(): number {
      return tests;
    },
    match(paths: readonly string[]): readonly MemoryItem[] {
      const key = paths.join('\u0000');
      const memo = steps.get(key);
      if (memo !== undefined) return memo;
      const out: MemoryItem[] = [];
      for (const { rule, patterns } of compiled) {
        if (patterns === 'never') continue;
        if (patterns === 'always') {
          out.push(rule);
          continue;
        }
        let matched = false;
        for (const pattern of patterns) {
          for (const path of paths) {
            if (hit(pattern, path)) {
              matched = true;
              break;
            }
          }
          if (matched) break;
        }
        if (matched) out.push(rule);
      }
      const frozen: readonly MemoryItem[] = Object.freeze(out);
      steps.set(key, frozen);
      return frozen;
    },
  };
}

/** Matchers are cached on the `rules` array itself, so a run that hands the same array every step compiles once. */
const MATCHERS = new WeakMap<readonly MemoryItem[], { matcher: RuleMatcher; maxRules: number; maxPatterns: number }>();

/**
 * §2.10.4: the rule files a step activates. Pure, dependency-free, memoised per step and capped at
 * `ruleFiles` [G1.6]; a rule with no match contributes nothing and costs one memoised glob test.
 */
export function matchRules(rules: readonly MemoryItem[], paths: readonly string[], opts: MatchOptions = {}): readonly MemoryItem[] {
  const maxRules = opts.maxRules ?? IMPORT_LIMITS.ruleFiles;
  const maxPatterns = opts.maxPatterns ?? IMPORT_LIMITS.rulePatterns;
  const cached = MATCHERS.get(rules);
  if (cached !== undefined && cached.maxRules === maxRules && cached.maxPatterns === maxPatterns) return cached.matcher.match(paths);
  const matcher = createRuleMatcher(rules, opts);
  MATCHERS.set(rules, { matcher, maxRules, maxPatterns });
  return matcher.match(paths);
}
