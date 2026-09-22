/**
 * Guard (finishing pass F17): `docs/DECISIONS.md` is the one document both sessions provably read, so a stale clause in
 * it is read as current policy by whoever picks up next. Two mechanical properties, both of which were red on
 * `main` @ `d297b29`:
 *
 *  1. **No branch is described as unmerged once it is an ancestor of HEAD.** The "Still owed before the head-to-head"
 *     paragraph owed slot B's engine seam "on branch `llm-loop-seam`" while that branch was merged at `d297b29`.
 *  2. **The ownership paragraph partitions `src/`.** The 2026-09-22 hunks rule named four paths while both sessions
 *     actually treat eleven-plus as harness-owned; a top-level `src/` directory that is on neither side (or on both)
 *     is exactly the ambiguity that blocked a merge for an hour.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');
const DECISIONS = readFileSync(join(ROOT, 'docs/DECISIONS.md'), 'utf8');

/** Words that make a sentence a claim the named branch has NOT landed. */
const UNMERGED_WORDS = /\b(still owed|owed|unmerged|not (?:yet )?merged|awaiting merge|pending merge|will land|has not landed|not landed)\b/i;

function isMergedOrGone(branch: string): boolean {
  const opts = { cwd: ROOT, encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ('ignore' | 'pipe')[] };
  try {
    execFileSync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], opts);
  } catch {
    return true; // the branch is gone; a doc that still owes it is stale by construction
  }
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', branch, 'HEAD'], opts);
    return true;
  } catch {
    return false;
  }
}

/** Every local branch name DECISIONS spells inside backticks after the word "branch". */
function branchesNamedInDecisions(): string[] {
  const names = new Set<string>();
  for (const m of DECISIONS.matchAll(/\bbranch(?:es)? `([A-Za-z0-9][A-Za-z0-9._/-]*)`/g)) names.add(m[1] as string);
  return [...names].sort();
}

describe('docs/DECISIONS.md consistency', () => {
  it('no sentence owes a branch that is already an ancestor of HEAD', () => {
    // DECISIONS is hard-wrapped, so the owing verb and the branch name routinely sit on different LINES of one
    // sentence (`llm-loop-seam`: "Still owed" on :1436, the branch on :1439). Unwrap, then scope by sentence.
    const unwrapped = DECISIONS.replace(/\s*\n\s*/g, ' ');
    const sentences = unwrapped.split(/(?<=[.!?])\s+(?=[A-Z*`(])/);
    const stale: string[] = [];
    for (const branch of branchesNamedInDecisions()) {
      if (!isMergedOrGone(branch)) continue;
      for (const s of sentences) {
        if (!s.includes(`\`${branch}\``)) continue;
        // A dated amendment may legitimately quote the old owing clause in order to strike it.
        if (/\bamend(?:ed|ment)?\b|\bstruck\b|\bresolved\b|\bno longer owed\b/i.test(s)) continue;
        if (UNMERGED_WORDS.test(s)) stale.push(`DECISIONS.md still owes merged branch ${branch}: ${s.trim().slice(0, 200)}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('the file-ownership paragraph places every top-level src/ directory on exactly one side', () => {
    const dirs = readdirSync(join(ROOT, 'src'))
      .filter((n) => statSync(join(ROOT, 'src', n)).isDirectory())
      .sort();
    expect(dirs.length).toBeGreaterThan(15);

    // The paragraph is bounded by its own markers so an unrelated `src/x` elsewhere in the log cannot satisfy it.
    const start = DECISIONS.indexOf('<!-- ownership:begin -->');
    const end = DECISIONS.indexOf('<!-- ownership:end -->');
    expect(start, 'DECISIONS must carry a delimited ownership paragraph').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const para = DECISIONS.slice(start, end);

    // Three buckets, each introduced by its own bold label; a dir belongs to the bucket whose slice names it.
    const labels = ['**Harness-owned', '**TUI-owned', '**Owned by hunk'] as const;
    const offsets = labels.map((l) => {
      const i = para.indexOf(l);
      expect(i, `the ownership paragraph must carry the bucket label ${l}`).toBeGreaterThan(-1);
      return i;
    });
    expect([...offsets].sort((a, b) => a - b), 'the three bucket labels must appear in order').toEqual(offsets);
    const buckets = offsets.map((o, k) => para.slice(o, k + 1 < offsets.length ? (offsets[k + 1] as number) : para.length));

    const misplaced: string[] = [];
    for (const d of dirs) {
      const hits = buckets.filter((b) => new RegExp(`\`src/${d}(?:/|\\*|\`)`).test(b)).length;
      if (hits !== 1) misplaced.push(`src/${d}: named in ${hits} of the 3 ownership buckets (want exactly 1)`);
    }
    expect(misplaced).toEqual([]);
  });

  it('the ownership paragraph also places the two by-hunk build files F07/F11 land in', () => {
    const start = DECISIONS.indexOf('<!-- ownership:begin -->');
    const para = DECISIONS.slice(start, DECISIONS.indexOf('<!-- ownership:end -->'));
    expect(para).toContain('`vitest.config.ts`');
    expect(para).toContain('`package.json`');
    expect(para).toContain('`src/errors.ts`');
  });

  it('the perf-window sentinel protocol is recorded with a path, a TTL and a clearer', () => {
    const i = DECISIONS.indexOf('/tmp/jevcode-perf-window-open');
    expect(i, 'the sentinel every session is told to poll must be documented where both sessions read').toBeGreaterThan(-1);
    const para = DECISIONS.slice(i, i + 2500);
    expect(para, 'who creates it').toMatch(/creat/i);
    expect(para, 'who polls it').toMatch(/poll/i);
    expect(para, 'a TTL, so a crashed measurement cannot wedge every other session').toMatch(/TTL/);
    expect(para, 'who clears a stale file').toMatch(/stale/i);
  });
});
