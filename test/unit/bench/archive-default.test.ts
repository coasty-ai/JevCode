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
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { archiveByDefault, archiveRunsDue } from '../../../src/bench/archive.js';

const ROOT = resolve('/repo/bench/results');

describe('archiving a results directory by default (OOS 2026-09-22 record-archive note)', () => {
  it('a directory in the repository bench/results tree archives itself; anywhere else does not', () => {
    expect(archiveByDefault(join(ROOT, 'oos-2026-09-22'), ROOT)).toBe(true);
    expect(archiveByDefault(join(ROOT, 'llm-jev-7', 'nested'), ROOT)).toBe(true);
    expect(archiveByDefault(ROOT, ROOT)).toBe(true);
    // the .gitignore un-ignores exactly these prefixes under bench/results, which is why that tree
    // is the one that must carry its records
    for (const name of ['oos-x', 'llm-jev-x', 'live-x', 'jev-only-x', 'glm-x']) {
      expect(archiveByDefault(join(ROOT, name), ROOT)).toBe(true);
    }
    expect(archiveByDefault('/tmp/scratch-bench', ROOT)).toBe(false);
    expect(archiveByDefault(resolve('/repo/bench/results-elsewhere'), ROOT)).toBe(false); // prefix, not a child
    expect(archiveByDefault(resolve('/repo/bench'), ROOT)).toBe(false);
  });

  it('an explicit flag always wins over the default, in both directions', () => {
    expect(archiveRunsDue(true, '/tmp/scratch-bench', ROOT)).toBe(true);
    expect(archiveRunsDue(false, join(ROOT, 'oos-2026-09-22'), ROOT)).toBe(false);
    // undefined is the only value that defers to the directory
    expect(archiveRunsDue(undefined, join(ROOT, 'oos-2026-09-22'), ROOT)).toBe(true);
    expect(archiveRunsDue(undefined, '/tmp/scratch-bench', ROOT)).toBe(false);
  });

  it('a trailing slash and a non-normalised path are the same directory', () => {
    expect(archiveByDefault(`${join(ROOT, 'oos-1')}/`, `${ROOT}/`)).toBe(true);
    expect(archiveByDefault(join(ROOT, 'a', '..', 'oos-1'), ROOT)).toBe(true);
    expect(archiveByDefault(join(ROOT, '..', 'work', 'oos-1'), ROOT)).toBe(false);
  });
});
