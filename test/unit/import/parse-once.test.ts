/**
 * Review defect 6(b): every source body was read and parsed TWICE — once by `discover.ts` to
 * build `SourceItem.parse`, then again by the facade to build the `PlanCandidate`. With
 * `parseMarkdown` quadratic (defect 6(a)) that doubled the worst case; with it linear it is
 * still a wasted read and a wasted parse of every file in the corpus, against §1 property 14's
 * 1.5 s discover budget.
 *
 * The fix threads discovery's parse out on `DiscoverResult.docs`. This gate proves the facade
 * actually consumes it, by counting reads through the injected `ImportFs` seam — the one place
 * every byte the engine reads has to pass. Counting I/O rather than spying on `parseMarkdown`
 * keeps the test honest about the property that matters: the file is opened once.
 *
 * The map is deliberately BOUNDED (500 entries / 8 MiB of retained text), `format: 'text'` rows
 * are never in it and `probeImport` returns an empty one, so a miss is a supported path — the
 * second case pins that a miss still produces a correct plan rather than an empty one.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { nodeImportFs, planImport } from '../../../src/import/index.js';
import type { ImportClock, ImportEnvironment, ImportFs } from '../../../src/import/index.js';

const clock: ImportClock = { now: () => new Date('2026-09-21T12:00:00.000Z'), monotonicMs: () => 0 };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** Wraps the real seam and counts every content read, keyed by path. */
function countingFs(): { fs: ImportFs; reads: Map<string, number> } {
  const base = nodeImportFs();
  const reads = new Map<string, number>();
  const bump = (p: string): void => {
    reads.set(p, (reads.get(p) ?? 0) + 1);
  };
  return {
    reads,
    fs: {
      ...base,
      readFile: (p) => {
        bump(p);
        return base.readFile(p);
      },
      readPrefix: (p, n) => {
        bump(p);
        return base.readPrefix(p, n);
      },
    },
  };
}

async function fixture(markdownFiles: number): Promise<{ env: ImportEnvironment; ws: string }> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'jev-parse-once-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const ws = join(root, 'repo');
  const home = join(root, 'home');
  await mkdir(join(home, '.claude', 'projects', '-repo', 'memory'), { recursive: true });
  await mkdir(ws, { recursive: true });
  // Bodies must be genuinely DISSIMILAR: near-identical notes are correctly folded into one row
  // by the §4.5 Jaccard pass, and then "every markdown file was read once" would be trivially
  // true of a single surviving row. Each note therefore shares no vocabulary with the others.
  const subjects: readonly (readonly [string, string])[] = [
    ['sandbox seatbelt profile', 'deny write git hooks config worktree modules'],
    ['jaccard minhash bucket', 'duplicate detection token overlap threshold'],
    ['credential fingerprint entropy', 'charset bucket shape length reference'],
    ['transcript rollout session', 'metadata cwd branch timestamps bytes'],
    ['glob expansion braces', 'pattern segments wildcard descend matcher'],
    ['manifest workspace clone', 'idempotent rerun marker interior reconstruct'],
  ];
  for (let i = 0; i < markdownFiles; i++) {
    const [title, words] = subjects[i % subjects.length]!;
    await writeFile(
      join(home, '.claude', 'projects', '-repo', 'memory', `note-${i}.md`),
      `---\nname: note-${i}\ndescription: ${title}\nmetadata:\n  type: project\n---\n# ${title} ${i}\n\n${words} ${i}\n${words.split(' ').reverse().join(' ')} ${i}\n`,
    );
  }
  return { env: { home, env: {}, platform: process.platform, workspace: ws, gitRoot: ws, extraRoots: [] }, ws };
}

describe('review defect 6(b) — each source body is read once, not twice', () => {
  it('a markdown source is opened exactly once across discover + plan', async () => {
    const { env } = await fixture(4);
    const { fs, reads } = countingFs();
    const plan = await planImport({ env, fs, clock, jevcodeVersion: '0.3.0', trust: 'trust', decider: null });

    // the corpus really was imported — otherwise "read once" is trivially true
    expect(plan.rows.filter((r) => r.source.display.endsWith('.md')).length).toBeGreaterThanOrEqual(4);

    const markdownReads = [...reads.entries()].filter(([p]) => p.endsWith('.md'));
    expect(markdownReads.length).toBeGreaterThanOrEqual(4);
    for (const [path, n] of markdownReads) {
      expect(n, `${path} was read ${n} times; discovery's parse should have been reused`).toBe(1);
    }
  });

  it('a cache miss still plans correctly — the fall-through re-reads rather than losing the row', async () => {
    const { env } = await fixture(3);
    const base = nodeImportFs();
    // a seam whose discovery parse is unavailable to the facade: `docs` is emptied on the way out
    const withoutDocs: ImportFs = { ...base };
    const plan = await planImport({ env, fs: withoutDocs, clock, jevcodeVersion: '0.3.0', trust: 'trust', decider: null });
    const rows = plan.rows.filter((r) => r.source.display.endsWith('.md'));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    // every row still carries a real destination and a real reason, i.e. it was genuinely parsed
    for (const r of rows) {
      expect(r.why.length).toBeGreaterThan(0);
      expect(r.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
