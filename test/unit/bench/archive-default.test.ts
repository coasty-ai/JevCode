/**
 * `archiveByDefault` / `archiveRunsDue` (docs/research/llm-jev/oos-analysis-2026-09-22.md, the
 * coordinator note on the record archive).
 *
 * The 44 run directories that analysis reads live under `~/.jevcode/runs/`, outside the
 * repository, and had to be tarred by hand afterwards so the numbers could be reproduced from a
 * checkout. `--archive-runs` fixes that only for whoever remembers to pass it — and the flag does
 * not even parse yet (`src/cli/args.ts` is owned elsewhere). So a results directory inside the
 * repository's own `bench/results` tree archives by default; a scratch directory anywhere else
 * does not, and an explicit flag always wins.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { archiveByDefault, archiveRunsDue, benchResultsRootOf, repoRootOf } from '../../../src/bench/archive.js';

let tmp: string;
let repo: string;
let results: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'jev-archive-default-'));
  repo = join(tmp, 'checkout');
  results = join(repo, 'bench', 'results');
  mkdirSync(join(results, 'oos-2026-09-22'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), '{"name":"jevcode"}');
  mkdirSync(join(tmp, 'elsewhere', 'bench', 'results', 'oos-x'), { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('archiving a results directory by default (OOS 2026-09-22 record-archive note; review operational note)', () => {
  it('the repository is found from the OUTPUT PATH, not from the cwd (review operational note)', () => {
    expect(repoRootOf(join(results, 'oos-2026-09-22'))).toBe(resolve(repo));
    expect(benchResultsRootOf(join(results, 'oos-2026-09-22'))).toBe(join(resolve(repo), 'bench', 'results'));
    // a tree with no package.json above it is in no repository at all
    expect(repoRootOf(join(tmp, 'elsewhere', 'bench', 'results', 'oos-x'))).toBeNull();
    expect(benchResultsRootOf(join(tmp, 'elsewhere', 'bench', 'results', 'oos-x'))).toBeNull();
    // ... and a bench/results-shaped path outside any checkout never archives, however it is named
    expect(archiveByDefault(join(tmp, 'elsewhere', 'bench', 'results', 'oos-x'))).toBe(false);
  });

  it('a directory in its own repository bench/results tree archives itself; anywhere else does not', () => {
    expect(archiveByDefault(join(results, 'oos-2026-09-22'))).toBe(true);
    expect(archiveByDefault(join(results, 'llm-jev-7', 'nested'))).toBe(true);
    expect(archiveByDefault(results)).toBe(true);
    expect(archiveByDefault(join(repo, 'bench'))).toBe(false);
    expect(archiveByDefault(join(repo, 'bench', 'results-elsewhere'))).toBe(false); // prefix, not a child
    expect(archiveByDefault(join(repo, 'perf', 'results'))).toBe(false);
  });

  it('an explicit flag always wins over the default, in both directions', () => {
    expect(archiveRunsDue(true, join(tmp, 'elsewhere'))).toBe(true);
    expect(archiveRunsDue(false, join(results, 'oos-2026-09-22'))).toBe(false);
    // undefined is the only value that defers to the directory
    expect(archiveRunsDue(undefined, join(results, 'oos-2026-09-22'))).toBe(true);
    expect(archiveRunsDue(undefined, join(tmp, 'elsewhere'))).toBe(false);
  });

  it('a trailing slash and a non-normalised path are the same directory', () => {
    expect(archiveByDefault(`${join(results, 'oos-1')}/`)).toBe(true);
    expect(archiveByDefault(join(results, 'a', '..', 'oos-1'))).toBe(true);
    expect(archiveByDefault(join(results, '..', 'work', 'oos-1'))).toBe(false);
  });
});
