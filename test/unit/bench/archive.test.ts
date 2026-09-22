/**
 * `bench --archive-runs` (bench/archive.ts), the "Record archive" note of
 * docs/research/llm-jev/oos-analysis-2026-09-22.md: the 44 run directories that analysis reads live
 * under `~/.jevcode/runs/<runId>/`, outside the repository and outside the `bench/results/oos-…`
 * directories, so a results directory must carry its own compressed records.
 *
 * Offline: a FAKE run directory in a tmpdir, no bench run, no network.
 */
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { ARCHIVED_RUN_FILES, ARCHIVE_DIR, archiveRuns } from '../../../src/bench/archive.js';
import { runBenchWithSources } from '../../../src/bench/runner.js';
import { baseOptions, createFakeDeps, syntheticSource, tempDir, type EngineScript } from './helpers.js';

/** the record-file names and bytes of a real run dir, shortened (20260922-063746-h3qflvih) */
const CONTENT: Record<string, string> = {
  'steps.jsonl': '{"step":1,"proposal":{"action":{"kind":"run"}}}\n{"step":2,"proposal":{"action":{"kind":"patch"}}}\n',
  'decisions.jsonl': '{"step":3,"stage":"complete","id":"task_complete","noul":0.7}\n',
  'jev.jsonl': '{"step":3,"stage":"judge","requestHash":"0e3a"}\n',
  'generator.jsonl': '{"step":2,"stopReason":"timeout","outputTokens":0}\n',
  'run.json': '{"runId":"20260922-063746-h3qflvih","mode":"llm-jev"}\n',
  'state.json': '{"plan":{"remaining":[]}}\n',
  'model_patch.diff': 'diff --git a/sympy/polys/densebasic.py b/sympy/polys/densebasic.py\n+    F = dmp_strip(F, f.lev)\n',
};

async function fakeRun(runsDir: string, runId: string, names: readonly string[]): Promise<void> {
  const dir = join(runsDir, runId);
  await mkdir(dir, { recursive: true });
  for (const name of names) await writeFile(join(dir, name), CONTENT[name] ?? '', 'utf8');
}

async function tmp(): Promise<{ outDir: string; runsDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'jevcode-archive-'));
  const outDir = join(root, 'results');
  const runsDir = join(root, 'runs');
  await mkdir(outDir, { recursive: true });
  await mkdir(runsDir, { recursive: true });
  return { outDir, runsDir };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('archiveRuns', () => {
  it('writes one gzip per record file under <resultsDir>/runs/<runId>/ and every one round-trips to the original bytes', async () => {
    const { outDir, runsDir } = await tmp();
    const runId = '20260922-063746-h3qflvih';
    await fakeRun(runsDir, runId, ARCHIVED_RUN_FILES);
    const log: string[] = [];
    const r = await archiveRuns({ outDir, runsDir, runIds: [runId], log: (l) => log.push(l) });
    expect(r).toMatchObject({ runs: 1, files: ARCHIVED_RUN_FILES.length, skipped: 0, errors: [] });
    expect(r.dir).toBe(join(outDir, ARCHIVE_DIR));
    for (const name of ARCHIVED_RUN_FILES) {
      const gz = await readFile(join(outDir, ARCHIVE_DIR, runId, `${name}.gz`));
      expect(gunzipSync(gz).toString('utf8')).toBe(CONTENT[name]);
    }
    expect(log.join('\n')).toContain(`archived ${ARCHIVED_RUN_FILES.length} record files of 1/1 runs`);
  });

  it('a file that was never written is skipped, not an error, and the rest of the run is still archived', async () => {
    const { outDir, runsDir } = await tmp();
    const runId = '20260922-054652-dcxbrltg';
    // the crossfile run proposed no patch at all, so it has no model_patch.diff; jev-off runs have no jev.jsonl
    const present = ARCHIVED_RUN_FILES.filter((n) => n !== 'model_patch.diff' && n !== 'jev.jsonl');
    await fakeRun(runsDir, runId, present);
    const r = await archiveRuns({ outDir, runsDir, runIds: [runId] });
    expect(r).toMatchObject({ runs: 1, files: present.length, skipped: 2, errors: [] });
    for (const name of present) expect(gunzipSync(await readFile(join(outDir, ARCHIVE_DIR, runId, `${name}.gz`))).toString('utf8')).toBe(CONTENT[name]);
    await expect(readFile(join(outDir, ARCHIVE_DIR, runId, 'model_patch.diff.gz'))).rejects.toThrow();
  });

  it('a run directory that does not exist, a directory where a file should be, a duplicate id and an empty list never throw', async () => {
    const { outDir, runsDir } = await tmp();
    const gone = await archiveRuns({ outDir, runsDir, runIds: ['20260922-000000-notthere'] });
    expect(gone).toMatchObject({ runs: 0, files: 0, skipped: ARCHIVED_RUN_FILES.length, errors: [] });
    expect(await archiveRuns({ outDir, runsDir, runIds: [] })).toMatchObject({ runs: 0, files: 0, skipped: 0, errors: [] });
    expect(await archiveRuns({ outDir, runsDir, runIds: ['', '   '] })).toMatchObject({ runs: 0, files: 0 });
    // `run.json` is a directory here: not a file, so it is skipped like a missing one
    const runId = '20260922-061926-da3ho35c';
    await fakeRun(runsDir, runId, ['steps.jsonl']);
    await mkdir(join(runsDir, runId, 'run.json'), { recursive: true });
    const r = await archiveRuns({ outDir, runsDir, runIds: [runId, runId] });
    expect(r).toMatchObject({ runs: 1, files: 1, errors: [] });
    expect(r.skipped).toBe(ARCHIVED_RUN_FILES.length - 1);
  });

  it('the bench runner calls it last, only under --archive-runs, and an empty run directory does not fail the bench', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const script: EngineScript = () => ({ result: { steps: 2, tokensPerStep: [10, 10] }, decisions: 0, spendUsd: 0 });
    const { deps } = createFakeDeps({ script });
    const lines: string[] = [];
    const outDir = join(t.dir, 'results');
    const runsDir = join(t.dir, 'runs');
    const opts = baseOptions(runsDir, outDir, { conditions: ['jev-on'], concurrency: 1, log: (l) => lines.push(l), archiveRuns: true });
    const out = await runBenchWithSources([syntheticSource({ id: 'a' })], opts, deps);
    const runId = out.records[0]?.runId;
    expect(typeof runId).toBe('string');
    expect((await stat(join(outDir, ARCHIVE_DIR, runId!))).isDirectory()).toBe(true);
    // the fake engine writes no record files, so nothing is archived and nothing throws
    expect(lines.some((l) => l.includes('[bench] archived 0 record files of 0/1 runs'))).toBe(true);
    // and the `done` line still comes after it
    expect(lines.findIndex((l) => l.includes('[bench] archived'))).toBeLessThan(lines.findIndex((l) => l.startsWith('[bench] done:')));
  });

  it('archives every run of a results directory, keyed by runId as tasks.jsonl is', async () => {
    const { outDir, runsDir } = await tmp();
    const ids = ['20260922-054652-dcxbrltg', '20260922-061926-da3ho35c', '20260922-055835-jrb5hkbr'];
    for (const id of ids) await fakeRun(runsDir, id, ['steps.jsonl', 'run.json']);
    const r = await archiveRuns({ outDir, runsDir, runIds: ids });
    expect(r).toMatchObject({ runs: 3, files: 6, errors: [] });
    for (const id of ids) expect(gunzipSync(await readFile(join(outDir, ARCHIVE_DIR, id, 'run.json.gz'))).toString('utf8')).toBe(CONTENT['run.json']);
  });
});
