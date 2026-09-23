/**
 * Guard (finishing pass F17): `docs/DECISIONS.md` is the one document both sessions provably read, so a stale clause in
 * it is read as current policy by whoever picks up next. Three mechanical properties, all of which were red on
 * `main` @ `d297b29`:
 *
 *  1. **No branch is described as unmerged once it is an ancestor of HEAD.** The "Still owed before the head-to-head"
 *     paragraph owed slot B's engine seam "on branch `llm-loop-seam`" while that branch was merged at `d297b29`.
 *  2. **The ownership paragraph partitions `src/`.** The 2026-09-22 hunks rule named four paths while both sessions
 *     actually treat eleven-plus as harness-owned; a top-level `src/` directory that is on neither side (or on both)
 *     is exactly the ambiguity that blocked a merge for an hour.
 *  3. **No un-struck clause calls Ring 1 green outside the provenance table.** The Ring-1 entry states that there is
 *     no `--jev off` measurement at or after `d297b29`; a surviving "(Ring 1 came back green on the merged tree
 *     anyway)" eleven lines above it said the opposite in the same entry.
 *
 * Two scoping rules the first version of this file got wrong, both re-probed (review F17-2):
 *  - **Branch names are derived from `git for-each-ref`, not from the word "branch".** The old discovery regex
 *    (/branch `X`/) found three names and missed `llm-loop-seam` entirely, so the guard was vacuous for the very
 *    clause it was written for. Any backticked token that is a real local branch counts now.
 *  - **The scope is a markdown BLOCK, not a regex "sentence".** The old split (/(?<=[.!?])\s+/) did not break on
 *    headings, bullets or table rows, so one "sentence" spanned a whole entry and a stray "resolved" in an unrelated
 *    paragraph excluded a live owing bullet. Blocks break on blank lines and on `#`/`-`/`|` lines, and an owing clause
 *    is excused only by being INSIDE a `~~strike~~` — the document's own convention for a claim it keeps but retires.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');
const DECISIONS = readFileSync(join(ROOT, 'docs/DECISIONS.md'), 'utf8');

/** Words that make a clause a claim the named branch has NOT landed. */
const UNMERGED_WORDS = /\b(still owed|owed|unmerged|not (?:yet )?merged|awaiting merge|pending merge|will land|has not landed|not landed)\b/i;

/**
 * Branches nobody can "owe": the trunk everything is measured against, and this worktree's own head. A sentence
 * saying "landed on `main`" must not be read as owing `main`.
 */
const NEVER_OWED = new Set(['main', 'master', 'HEAD']);

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function isMergedOrGone(branch: string): boolean {
  try {
    git(['rev-parse', '--verify', `refs/heads/${branch}`]);
  } catch {
    return true; // the branch is gone; a doc that still owes it is stale by construction
  }
  try {
    git(['merge-base', '--is-ancestor', branch, 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every LOCAL branch this checkout has that DECISIONS spells inside backticks anywhere — the word "branch" is not
 * required, because DECISIONS routinely names a branch without it ("slot B's engine seam on `llm-loop-seam`").
 */
function branchesNamedInDecisions(): string[] {
  const refs = new Set(
    git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  const named = new Set<string>();
  for (const m of DECISIONS.matchAll(/`([^`\n]+)`/g)) {
    const tok = (m[1] as string).trim();
    if (refs.has(tok) && !NEVER_OWED.has(tok)) named.add(tok);
  }
  return [...named].sort();
}

/**
 * The branch-dependent checks need the branches. A single-branch checkout — GitHub Actions' `actions/checkout`, or
 * `git clone --single-branch` — has exactly one local branch, and the working branches DECISIONS names were never
 * pushed, so discovery finds nothing there and "no block owes a merged branch" would pass vacuously. Both checks are
 * SKIPPED, visibly, in such a checkout rather than asserted over an empty set; any checkout that carries more than
 * one local branch (every developer worktree) runs them unchanged.
 */
const LOCAL_BRANCH_COUNT = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter((s) => s.trim().length > 0).length;
const SINGLE_BRANCH_CHECKOUT = LOCAL_BRANCH_COUNT <= 1;

/** Every `~~struck~~` span elided: the document's own signal that the claim inside is retired but kept for history. */
function elideStrikes(md: string): string {
  expect((md.match(/~~/g) ?? []).length % 2, 'docs/DECISIONS.md: unbalanced ~~ strike markers').toBe(0);
  return md.replace(/~~[\s\S]*?~~/g, ' ⟨struck⟩ ');
}

/**
 * The document split into markdown BLOCKS, each unwrapped onto one line. A block ends at a blank line and a new one
 * starts at a heading, a list item or a table row — so a bullet is its own scope and cannot borrow an exclusion from
 * the paragraph above it, and a bullet with no terminal punctuation cannot run into the next one.
 */
function blocks(md: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  const flush = (): void => {
    const t = cur.join(' ').replace(/\s+/g, ' ').trim();
    if (t.length > 0) out.push(t);
    cur = [];
  };
  for (const raw of md.split('\n')) {
    if (raw.trim().length === 0) {
      flush();
      continue;
    }
    if (/^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|\|)/.test(raw)) flush();
    cur.push(raw.trim());
  }
  flush();
  return out;
}

/** Blocks, then sentences INSIDE each block: the finest scope that never crosses a markdown boundary. */
function scopesOf(md: string): string[] {
  return blocks(md).flatMap((b) => b.split(/(?<=[.!?])\s+(?=[A-Z*`(~⟨])/));
}

/**
 * Every scope of `md` that owes one of `branches`. A scope is a sentence inside a markdown block; `~~struck~~` spans
 * are elided first, so the ONLY way to keep an owing clause in the log is to strike it.
 */
function staleOwings(md: string, branches: readonly string[]): string[] {
  const scopes = scopesOf(elideStrikes(md));
  const stale: string[] = [];
  for (const branch of branches) {
    for (const s of scopes) {
      if (!s.includes(`\`${branch}\``)) continue;
      if (UNMERGED_WORDS.test(s)) stale.push(`still owes merged branch ${branch}: ${s.trim().slice(0, 240)}`);
    }
  }
  return stale;
}

describe('docs/DECISIONS.md consistency', () => {
  it('the block scoping breaks on markdown structure, so one entry is not one "sentence"', () => {
    // Regression pin for review F17-2 probe (b): a paragraph carrying "resolved" must not excuse the bullet below it.
    const probe = ['Some paragraph. The earlier defect is resolved.', '', '- Still owed: a thing.', '| a | table row |'].join('\n');
    const got = blocks(probe);
    expect(got).toEqual(['Some paragraph. The earlier defect is resolved.', '- Still owed: a thing.', '| a | table row |']);
  });

  it.skipIf(SINGLE_BRANCH_CHECKOUT)('branch discovery does not require the word "branch", and finds the merged ones by ref', () => {
    // Regression pin for review F17-2 probe (a): the old /branch `X`/ regex found three names and missed the rest.
    const found = branchesNamedInDecisions();
    expect(found.length, 'DECISIONS names local branches in backticks; discovery must find them').toBeGreaterThan(3);
    expect(found, 'the trunk is never "owed"').not.toContain('main');
    for (const b of found) expect(b).not.toMatch(/\s/);
  });

  it('the staleness rule catches both shapes the first version of this guard missed', () => {
    // Review F17-2's two probes, run as data so the guard's power is asserted and cannot rot back.
    const noWordBranch = 'Still owed: slot B engine seam, unmerged on `probe-branch-x`, and the fix on `probe-branch-y`.';
    const bulletAfterResolved = [
      'The earlier jevWallMs defect is resolved.',
      '',
      '- Still owed before the head-to-head: slot B\'s engine seam on branch `probe-branch-x`.',
    ].join('\n');
    const struck = 'The seam was ~~still owed on `probe-branch-x`~~ — landed at `c811899`.';

    expect(staleOwings(noWordBranch, ['probe-branch-x', 'probe-branch-y']).length, 'probe (a): a branch named without the word "branch"').toBe(2);
    expect(staleOwings(bulletAfterResolved, ['probe-branch-x']).length, 'probe (b): an owing bullet below a paragraph saying "resolved"').toBe(1);
    expect(staleOwings(struck, ['probe-branch-x']), 'a ~~struck~~ owing clause is retired, not stale').toEqual([]);
  });

  it.skipIf(SINGLE_BRANCH_CHECKOUT)('no block owes a branch that is already an ancestor of HEAD', () => {
    // DECISIONS is hard-wrapped, so the owing verb and the branch name routinely sit on different LINES of one
    // block; blocks() unwraps. A retired owing clause must be INSIDE a ~~strike~~, not merely near the word "amended".
    const merged = branchesNamedInDecisions().filter(isMergedOrGone);
    expect(staleOwings(DECISIONS, merged)).toEqual([]);
  });

  it('no un-struck block calls Ring 1 green outside the provenance table', () => {
    const md = DECISIONS;
    const begin = md.indexOf('<!-- ring1-provenance:begin -->');
    const end = md.indexOf('<!-- ring1-provenance:end -->');
    expect(begin, 'the Ring-1 provenance table must be delimited so it can state the record in one place').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    const outside = md.slice(0, begin) + md.slice(end);
    const bad = scopesOf(elideStrikes(outside)).filter((b) => /Ring[\s-]?1\b/.test(b) && /\bgreen\b|all gates met/i.test(b));
    expect(bad.map((b) => b.slice(0, 240)), 'only the provenance table may state a Ring-1 verdict').toEqual([]);
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

  it('the ownership entry counts the directories that were on neither list, and names them', () => {
    // Review F17-3: the entry said "four"; `ls -d src/*/` minus the peer's eleven minus the TUI five leaves SIX.
    const dirs = readdirSync(join(ROOT, 'src')).filter((n) => statSync(join(ROOT, 'src', n)).isDirectory());
    const start = DECISIONS.indexOf('## 2026-09-22 Harness-owned files touched by the TUI session arrive as hunks');
    expect(start).toBeGreaterThan(-1);
    const entry = DECISIONS.slice(start, DECISIONS.indexOf('<!-- ownership:begin -->', start));

    // The peer's own round-5 enumeration, which the entry must quote verbatim, and the TUI reverse list.
    // `core` counts as covered: the peer's enumeration names "every non-TUI block of `src/core/types.ts`".
    const peer = ['loop', 'synth', 'coordination', 'orchestrate', 'import', 'models', 'provider', 'spend', 'checkpoint', 'core'];
    const tui = ['tui', 'cli', 'config', 'session', 'chat'];
    const unlisted = dirs.filter((d) => !peer.includes(d) && !tui.includes(d)).sort();
    expect(unlisted).toEqual(['bench', 'jev', 'perf', 'sandbox', 'undo', 'workspace']);

    // The log is hard-wrapped and uses bold, so compare against the unwrapped, emphasis-stripped text.
    const flat = entry.replace(/\*\*/g, '').replace(/\s+/g, ' ');
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    expect(flat, 'the entry must state how many directories were on neither list').toContain(
      `${words[unlisted.length] as string} top-level \`src/\` directories were on neither list`,
    );
    for (const d of unlisted) expect(entry, `the entry must name the unlisted directory src/${d}`).toContain(`\`src/${d}`);
  });

  it('the eleven-path enumeration the ownership entry cites is checkable from this checkout', () => {
    // Review F17-3: the entry cited a coordination doc that does not in fact quote the enumeration, so the move of
    // `src/spend` into the harness bucket could not be checked from `main`. Whatever it cites must carry the paths.
    const start = DECISIONS.indexOf('## 2026-09-22 Harness-owned files touched by the TUI session arrive as hunks');
    const entry = DECISIONS.slice(start, DECISIONS.indexOf('<!-- ownership:begin -->', start));
    const cited = [...entry.matchAll(/`(docs\/research\/[^`]+\.md)`/g)].map((m) => m[1] as string);
    expect(cited.length, 'the entry must cite a document on this branch that carries the enumeration').toBeGreaterThan(0);
    const carriers = cited.filter((p) => {
      try {
        return readFileSync(join(ROOT, p), 'utf8').includes('src/spend/**');
      } catch {
        return false;
      }
    });
    expect(carriers, `none of ${cited.join(', ')} quotes the peer's enumeration (it must name src/spend/**)`).not.toEqual([]);
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
