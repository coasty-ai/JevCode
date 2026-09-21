/**
 * Ladder task records (bench/data/ladder/index.json + tasks/<name>/meta.json, layout in its
 * README). Loading validates every field and checks the task directory has src/, tests/,
 * task.md and gold/, so a half-authored task fails loudly before any workspace is built.
 * `description` and gold/ are the fix and never reach the task text.
 *
 * Tiers: the original twelve tasks are tier "short" (the default when meta.json has no `tier`);
 * the long-horizon tasks (README "The long tier") declare `tier: "long"` and `expected_failing`,
 * the exact failing set of the buggy tree. Records are ordered short tier first, then long, each
 * in index order, so `--tasks 12` still selects exactly the original twelve in their original
 * order and the long tasks follow at positions 13-20.
 */
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isFiniteNumber, isJsonArray, isJsonObject, isString, isStringArray, parseJson } from '../../core/json.js';
import type { Json } from '../../core/types.js';
import { ConfigError } from '../../errors.js';

export const LADDER_DIR = 'ladder';
export const LADDER_KINDS = ['operator', 'off_by_one', 'guard', 'import', 'attribute', 'call_args', 'new_branch', 'constant', 'rename', 'two_files'] as const;
/** in selection order: every "short" task precedes every "long" one */
export const LADDER_TIERS = ['short', 'long'] as const;
export type LadderTier = (typeof LADDER_TIERS)[number];
/** `tests/test_<module>.py::test_<name>` with an optional parametrised suffix */
const TEST_ID_RE = /^tests\/[A-Za-z0-9_]+\.py::[A-Za-z0-9_]+(\[[^\]]*\])?$/;

export interface LadderMeta {
  name: string;
  /** `diff -U0` hunks between src/ and gold/ summed over `files` */
  hunks: number;
  kinds: string[];
  /** workspace-relative paths of the buggy modules (`src/<module>.py`) */
  files: string[];
  /** 1-5 */
  difficulty: number;
  /** what is wrong and how it is fixed: evaluator/report side only */
  description: string;
  /** tasks/<name>, relative to bench/data/ladder */
  path: string;
  /** "short" (the original twelve; the default) or "long" (tasks 13-20) */
  tier: LadderTier;
  /** the buggy tree's exact failing test ids, sorted; required for tier "long", absent otherwise */
  expectedFailing?: string[];
}

export interface LadderRecord {
  meta: LadderMeta;
  /** absolute tasks/<name> */
  taskDir: string;
  /** task.md, CRLF normalised and trimmed */
  task: string;
  /** the task's own pytest.ini when it ships one */
  pytestIni: string | null;
}

const NAME_RE = /^[a-z][a-z0-9_]*$/;

export function validateMeta(v: Json, where: string): LadderMeta {
  if (!isJsonObject(v)) throw new ConfigError(`${where}: not an object`);
  const name = v['name'];
  if (!isString(name) || !NAME_RE.test(name)) throw new ConfigError(`${where}: malformed name`);
  const w = `ladder task ${name}`;
  const hunks = v['hunks'];
  if (!isFiniteNumber(hunks) || !Number.isInteger(hunks) || hunks < 1) throw new ConfigError(`${w}: hunks must be a positive integer`);
  const kinds = v['kinds'];
  if (!isStringArray(kinds) || kinds.length === 0) throw new ConfigError(`${w}: kinds must be a non-empty string array`);
  for (const k of kinds) if (!(LADDER_KINDS as readonly string[]).includes(k)) throw new ConfigError(`${w}: unknown kind "${k}"`);
  const files = v['files'];
  if (!isStringArray(files) || files.length === 0) throw new ConfigError(`${w}: files must be a non-empty string array`);
  for (const f of files) if (!/^src\/[A-Za-z0-9_]+\.py$/.test(f)) throw new ConfigError(`${w}: file "${f}" is not src/<module>.py`);
  const difficulty = v['difficulty'];
  if (!isFiniteNumber(difficulty) || !Number.isInteger(difficulty) || difficulty < 1 || difficulty > 5) throw new ConfigError(`${w}: difficulty must be an integer 1-5`);
  const description = v['description'];
  if (!isString(description)) throw new ConfigError(`${w}: description must be a string`);
  const path = v['path'];
  const rel = isString(path) ? path : `tasks/${name}`;
  if (rel.startsWith('/') || rel.split('/').includes('..')) throw new ConfigError(`${w}: path "${rel}" is not relative`);
  const tierValue = v['tier'];
  const tier: LadderTier = tierValue === undefined ? 'short' : tierValue === 'short' || tierValue === 'long' ? tierValue : (() => {
    throw new ConfigError(`${w}: tier must be one of ${LADDER_TIERS.join(', ')}`);
  })();
  const expected = v['expected_failing'];
  const out: LadderMeta = { name, hunks, kinds: [...kinds], files: [...files], difficulty, description, path: rel, tier };
  if (expected !== undefined) {
    if (!isStringArray(expected) || expected.length === 0) throw new ConfigError(`${w}: expected_failing must be a non-empty string array`);
    for (const id of expected) if (!TEST_ID_RE.test(id)) throw new ConfigError(`${w}: expected_failing entry "${id}" is not a pytest id under tests/`);
    if (new Set(expected).size !== expected.length) throw new ConfigError(`${w}: expected_failing has duplicates`);
    out.expectedFailing = [...expected].sort();
  } else if (tier === 'long') {
    throw new ConfigError(`${w}: tier long requires expected_failing`);
  }
  return out;
}

export function tierRank(tier: LadderTier): number {
  return LADDER_TIERS.indexOf(tier);
}

/** Stable: short tier first, then long, each keeping the given order. */
export function orderByTier<T extends { tier: LadderTier }>(metas: readonly T[]): T[] {
  return [...metas].sort((a, b) => tierRank(a.tier) - tierRank(b.tier));
}

export function parseIndex(text: string, where: string): LadderMeta[] {
  const parsed = parseJson(text);
  if (!parsed.ok) throw new ConfigError(`${where}: invalid JSON (${parsed.error})`);
  if (!isJsonArray(parsed.value)) throw new ConfigError(`${where}: expected a JSON array of task metas`);
  const out = parsed.value.map((m, i) => validateMeta(m, `${where} #${i}`));
  const seen = new Set<string>();
  for (const m of out) {
    if (seen.has(m.name)) throw new ConfigError(`${where}: duplicate task ${m.name}`);
    seen.add(m.name);
  }
  return orderByTier(out);
}

async function kind(p: string): Promise<'dir' | 'file' | null> {
  try {
    const s = await stat(p);
    return s.isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
}

export function normaliseTaskText(text: string): string {
  return `${text.split('\r\n').join('\n').trim()}\n`;
}

export function goldPathFor(taskDir: string, srcFile: string): string {
  return join(taskDir, 'gold', basename(srcFile));
}

/** index.json → validated records with their task.md; every listed directory must be complete. */
export async function loadLadderRecords(ladderDir: string): Promise<LadderRecord[]> {
  const indexPath = join(ladderDir, 'index.json');
  let text: string;
  try {
    text = await readFile(indexPath, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read Ladder index ${indexPath}`, { cause: e });
  }
  const metas = parseIndex(text, indexPath);
  const out: LadderRecord[] = [];
  for (const meta of metas) {
    const taskDir = join(ladderDir, meta.path);
    for (const [rel, want] of [['src', 'dir'], ['tests', 'dir'], ['gold', 'dir'], ['task.md', 'file']] as const) {
      if ((await kind(join(taskDir, rel))) !== want) throw new ConfigError(`ladder task ${meta.name}: missing ${rel} under ${taskDir}`);
    }
    for (const f of meta.files) {
      if ((await kind(join(taskDir, f))) !== 'file') throw new ConfigError(`ladder task ${meta.name}: listed file ${f} is missing`);
      if ((await kind(goldPathFor(taskDir, f))) !== 'file') throw new ConfigError(`ladder task ${meta.name}: gold/${basename(f)} is missing`);
    }
    const task = normaliseTaskText(await readFile(join(taskDir, 'task.md'), 'utf8'));
    if (task.trim() === '') throw new ConfigError(`ladder task ${meta.name}: task.md is empty`);
    const iniPath = join(taskDir, 'pytest.ini');
    const pytestIni = (await kind(iniPath)) === 'file' ? await readFile(iniPath, 'utf8') : null;
    out.push({ meta, taskDir, task, pytestIni });
  }
  return out;
}
