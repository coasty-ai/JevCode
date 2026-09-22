/**
 * `bench --archive-runs` (docs/research/llm-jev/oos-analysis-2026-09-22.md, "Record archive").
 *
 * A results directory holds only `tasks.jsonl`, `summary.json`, `comparison.md` and the prediction
 * files; everything the OOS analysis actually reads — `steps.jsonl`, `decisions.jsonl`, `jev.jsonl`,
 * `generator.jsonl`, `run.json`, `state.json`, `model_patch.diff` — lives in `<runsDir>/<runId>/`,
 * outside the repository and outside the results directory, keyed only by `tasks.jsonl`'s `runId`.
 * The 44 runs behind that analysis had to be tarred by hand (104 MB raw, 4.1 MB gz) for anyone else
 * to reproduce a number. With this step a results directory carries its own compressed records:
 * `<resultsDir>/runs/<runId>/<name>.gz`, one gzip per file so a single record can be read back
 * without unpacking a whole archive.
 *
 * Never fails the bench: a run dir that is gone, a file that was never written and an I/O error are
 * all counted and logged, and `archiveRuns` resolves either way. The bench has already finished by
 * the time it is called; losing its records is better than losing its results.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

/** The per-run record files, exactly the set the OOS analysis reads. */
export const ARCHIVED_RUN_FILES: readonly string[] = ['steps.jsonl', 'decisions.jsonl', 'jev.jsonl', 'generator.jsonl', 'run.json', 'state.json', 'model_patch.diff'];

/** `<resultsDir>/runs/<runId>/`. */
export const ARCHIVE_DIR = 'runs';

export interface ArchiveRunsInput {
  /** the results directory; the archive goes to `<outDir>/runs/<runId>/` */
  outDir: string;
  /** run-directory root; the source of a run is `<runsDir>/<runId>/` */
  runsDir: string;
  /** the run ids to archive (the bench records' `runId`); duplicates and empties are ignored */
  runIds: readonly string[];
  log?: (line: string) => void;
}

export interface ArchiveRunsResult {
  /** run directories that produced at least one file */
  runs: number;
  /** `<name>.gz` files written */
  files: number;
  /** source files that did not exist (a jev-off run has no `jev.jsonl`, an unsolved one no `model_patch.diff`) */
  skipped: number;
  /** one line per failure; the step still resolves */
  errors: string[];
  /** the archive root (`<outDir>/runs`) */
  dir: string;
}

/** gzip one file to `<dest>.gz`; null when the source is not a readable file, the message when it failed. */
async function gzipFile(src: string, dest: string): Promise<'missing' | 'ok' | string> {
  try {
    const st = await stat(src);
    if (!st.isFile()) return 'missing';
  } catch {
    return 'missing';
  }
  try {
    await pipeline(createReadStream(src), createGzip(), createWriteStream(dest));
    return 'ok';
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Copy every record file of every run into `<outDir>/runs/<runId>/<name>.gz`. Missing files are
 * skipped, every error is collected, nothing throws.
 */
export async function archiveRuns(i: ArchiveRunsInput): Promise<ArchiveRunsResult> {
  const log = i.log ?? ((): void => undefined);
  const dir = join(i.outDir, ARCHIVE_DIR);
  const result: ArchiveRunsResult = { runs: 0, files: 0, skipped: 0, errors: [], dir };
  const ids = [...new Set(i.runIds.filter((id) => id.trim().length > 0))];
  if (ids.length === 0) return result;
  for (const runId of ids) {
    const from = join(i.runsDir, runId);
    const to = join(dir, runId);
    let wrote = 0;
    try {
      await mkdir(to, { recursive: true });
    } catch (e: unknown) {
      result.errors.push(`${runId}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    for (const name of ARCHIVED_RUN_FILES) {
      const outcome = await gzipFile(join(from, name), join(to, `${name}.gz`));
      if (outcome === 'missing') result.skipped += 1;
      else if (outcome === 'ok') wrote += 1;
      else result.errors.push(`${runId}/${name}: ${outcome}`);
    }
    result.files += wrote;
    if (wrote > 0) result.runs += 1;
  }
  log(`[bench] archived ${result.files} record files of ${result.runs}/${ids.length} runs to ${dir} (${result.skipped} missing${result.errors.length > 0 ? `, ${result.errors.length} failed` : ''})`);
  for (const e of result.errors) log(`[bench] archive: ${e}`);
  return result;
}
