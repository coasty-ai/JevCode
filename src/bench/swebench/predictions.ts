/**
 * model_patch extraction and predictions.<condition>.jsonl (DESIGN.md §13). Runs after the
 * engine stopped, for every stopReason, never inside the step loop.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../../core/atomic.js';
import { byteLength } from '../../core/text.js';
import type { EngineMode } from '../../core/types.js';
import { SandboxError } from '../../errors.js';
import type { CommandRunner, PatchExtraction } from '../types.js';

export const MODEL_PATCH_FILE = 'model_patch.diff';
/** Bench-internal files that never belong in a prediction (mock solve scripts, run markers). */
export const PATCH_EXCLUDES = ["':(exclude).jevcode*'"];

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** `git add -A -N && git diff --binary <base> -- . ':(exclude).jevcode*'`, redirected to <runDir>/model_patch.diff. */
export function modelPatchCommand(baseCommit: string, outFile: string): string {
  return `git add -A -N && git diff --binary ${baseCommit} -- . ${PATCH_EXCLUDES.join(' ')} > ${shellQuote(outFile)}`;
}

/**
 * Intent-to-add makes new files visible, diffing against base_commit includes anything the
 * agent committed, --binary keeps the output applicable. The diff goes to a file rather than
 * stdout so the sandbox output cap can never truncate a large patch.
 */
export async function extractModelPatch(run: CommandRunner, baseCommit: string, runDir: string): Promise<PatchExtraction> {
  await mkdir(runDir, { recursive: true });
  const outFile = join(runDir, MODEL_PATCH_FILE);
  const res = await run(modelPatchCommand(baseCommit, outFile), { timeoutMs: 120_000, maxOutputBytes: 64 * 1024 });
  if (!res.ok) {
    throw new SandboxError(`model_patch extraction failed (exit ${res.exitCode ?? 'null'}, killedBy ${res.killedBy ?? 'none'}): ${res.stderr.slice(0, 500)}`);
  }
  let modelPatch: string;
  try {
    modelPatch = await readFile(outFile, 'utf8');
  } catch {
    // the sandbox may confine redirects; an absent file with a clean exit means an empty diff
    modelPatch = '';
    await writeFile(outFile, '', 'utf8');
  }
  const patchEmpty = modelPatch.trim() === '';
  if (patchEmpty && modelPatch !== '') {
    modelPatch = '';
    await writeFile(outFile, '', 'utf8');
  }
  return { modelPatch, patchBytes: byteLength(modelPatch), patchEmpty };
}

export async function readSavedModelPatch(runDir: string): Promise<string | null> {
  try {
    return await readFile(join(runDir, MODEL_PATCH_FILE), 'utf8');
  } catch {
    return null;
  }
}

export interface PredictionEntry {
  instance_id: string;
  model_name_or_path: string;
  model_patch: string;
}

/** `jevcode-<condition>-<model with / -> __>`: filesystem-safe and distinct per condition. */
export function modelNameOrPath(condition: EngineMode, generatorModel: string): string {
  return `jevcode-${condition}-${generatorModel.split('/').join('__')}`;
}

export function predictionsFileName(condition: EngineMode): string {
  return `predictions.${condition}.jsonl`;
}

export function formatPredictions(entries: readonly PredictionEntry[]): string {
  return entries.map((e) => JSON.stringify({ instance_id: e.instance_id, model_name_or_path: e.model_name_or_path, model_patch: e.model_patch })).join('\n') + (entries.length ? '\n' : '');
}

/** One file per condition, one line per SWE-bench instance, regenerated whole each time. */
export async function writePredictions(outDir: string, condition: EngineMode, entries: readonly PredictionEntry[]): Promise<string> {
  const path = join(outDir, predictionsFileName(condition));
  await writeFileAtomic(path, formatPredictions(entries), { mkdir: true });
  return path;
}
