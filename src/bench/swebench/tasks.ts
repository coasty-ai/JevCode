/**
 * SWE-bench Verified subset records (bench/data/swebench-verified-30.json, schema in
 * bench/data/README.md and DESIGN.md §13). Loading validates every field so a hand-edited or
 * truncated data file fails loudly before any clone starts.
 */
import { readFile } from 'node:fs/promises';
import { isFiniteNumber, isJsonArray, isJsonObject, isString, isStringArray, parseJson } from '../../core/json.js';
import type { Json } from '../../core/types.js';
import { ConfigError } from '../../errors.js';

export interface SwebenchSpec {
  python: string;
  install: string;
  pre_install: string[];
  pip_packages: string[];
  packages: string | null;
  test_cmd: string;
}

export interface SwebenchRecord {
  instance_id: string;
  repo: string;
  base_commit: string;
  environment_setup_commit: string;
  version: string;
  created_at: string;
  difficulty: string;
  problem_statement: string;
  /** kept only so the file is a faithful dataset copy; never read by bench code */
  hints_text: string;
  fail_to_pass: string[];
  pass_to_pass: string[];
  test_patch: string;
  test_files: string[];
  spec: SwebenchSpec;
  log_parser: string;
  eval_script: string;
}

export type GoldPatches = Record<string, string>;

const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ID_RE = /^[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/;

function str(o: Record<string, Json>, key: string, where: string): string {
  const v = o[key];
  if (!isString(v)) throw new ConfigError(`${where}: "${key}" must be a string`);
  return v;
}
function strArray(o: Record<string, Json>, key: string, where: string): string[] {
  const v = o[key];
  if (!isStringArray(v)) throw new ConfigError(`${where}: "${key}" must be a string array`);
  return v;
}

export function validateRecord(v: Json, index: number): SwebenchRecord {
  const where = `swebench record #${index}`;
  if (!isJsonObject(v)) throw new ConfigError(`${where}: not an object`);
  const instance_id = str(v, 'instance_id', where);
  if (!ID_RE.test(instance_id)) throw new ConfigError(`${where}: malformed instance_id "${instance_id}"`);
  const w = `swebench record ${instance_id}`;
  const repo = str(v, 'repo', w);
  if (!REPO_RE.test(repo)) throw new ConfigError(`${w}: malformed repo "${repo}"`);
  const base_commit = str(v, 'base_commit', w);
  const environment_setup_commit = str(v, 'environment_setup_commit', w);
  for (const [k, sha] of [['base_commit', base_commit], ['environment_setup_commit', environment_setup_commit]] as const) {
    if (!SHA_RE.test(sha)) throw new ConfigError(`${w}: "${k}" is not a 40-hex sha`);
  }
  const specJson = v['spec'];
  if (!isJsonObject(specJson)) throw new ConfigError(`${w}: "spec" must be an object`);
  const packages = specJson['packages'];
  if (!(packages === null || isString(packages))) throw new ConfigError(`${w}: spec.packages must be a string or null`);
  const spec: SwebenchSpec = {
    python: str(specJson, 'python', `${w}.spec`),
    install: str(specJson, 'install', `${w}.spec`),
    pre_install: strArray(specJson, 'pre_install', `${w}.spec`),
    pip_packages: strArray(specJson, 'pip_packages', `${w}.spec`),
    packages: packages ?? null,
    test_cmd: str(specJson, 'test_cmd', `${w}.spec`),
  };
  const fail_to_pass = strArray(v, 'fail_to_pass', w);
  if (fail_to_pass.length === 0) throw new ConfigError(`${w}: fail_to_pass is empty`);
  const rec: SwebenchRecord = {
    instance_id,
    repo,
    base_commit,
    environment_setup_commit,
    version: str(v, 'version', w),
    created_at: str(v, 'created_at', w),
    difficulty: str(v, 'difficulty', w),
    problem_statement: str(v, 'problem_statement', w),
    hints_text: str(v, 'hints_text', w),
    fail_to_pass,
    pass_to_pass: strArray(v, 'pass_to_pass', w),
    test_patch: str(v, 'test_patch', w),
    test_files: strArray(v, 'test_files', w),
    spec,
    log_parser: str(v, 'log_parser', w),
    eval_script: str(v, 'eval_script', w),
  };
  if (rec.problem_statement.trim() === '') throw new ConfigError(`${w}: problem_statement is empty`);
  if (rec.test_files.length === 0) throw new ConfigError(`${w}: test_files is empty`);
  for (const f of rec.test_files) {
    if (f.startsWith('/') || f.split('/').includes('..')) throw new ConfigError(`${w}: test file path "${f}" is not repo-relative`);
  }
  return rec;
}

export function parseRecords(text: string, where: string): SwebenchRecord[] {
  const parsed = parseJson(text);
  if (!parsed.ok) throw new ConfigError(`${where}: invalid JSON (${parsed.error})`);
  if (!isJsonArray(parsed.value)) throw new ConfigError(`${where}: expected a JSON array of records`);
  const out = parsed.value.map((r, i) => validateRecord(r, i));
  const seen = new Set<string>();
  for (const r of out) {
    if (seen.has(r.instance_id)) throw new ConfigError(`${where}: duplicate instance_id ${r.instance_id}`);
    seen.add(r.instance_id);
  }
  return out;
}

export async function loadRecords(path: string): Promise<SwebenchRecord[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read SWE-bench data file ${path}`, { cause: e });
  }
  return parseRecords(text, path);
}

export function parseGold(text: string, where: string): GoldPatches {
  const parsed = parseJson(text);
  if (!parsed.ok) throw new ConfigError(`${where}: invalid JSON (${parsed.error})`);
  if (!isJsonObject(parsed.value)) throw new ConfigError(`${where}: expected an object keyed by instance_id`);
  const out: GoldPatches = {};
  for (const [k, v] of Object.entries(parsed.value)) {
    if (!isString(v)) throw new ConfigError(`${where}: gold patch for ${k} is not a string`);
    out[k] = v;
  }
  return out;
}

export async function loadGold(path: string): Promise<GoldPatches> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read SWE-bench gold file ${path}`, { cause: e });
  }
  return parseGold(text, path);
}

/** Paths touched by a unified diff (`diff --git a/<p> b/<p>` headers), in order, deduplicated. */
export function touchedFiles(diff: string): string[] {
  const out: string[] = [];
  for (const m of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    const p = m[2]!;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** Added lines of a diff (without the leading '+'), excluding the '+++' header. */
export function addedLines(diff: string): string[] {
  const out: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) out.push(line.slice(1));
  }
  return out;
}

/**
 * The test invocation eval.sh runs between its output markers (the spec's test_cmd plus the
 * exact targets), so the local evaluator never re-derives Django labels or sympy paths.
 */
export function testCommandFromEvalScript(evalScript: string): string | null {
  const lines = evalScript.split('\n');
  const start = lines.findIndex((l) => l.includes('>>>>> Start Test Output'));
  const end = lines.findIndex((l) => l.includes('>>>>> End Test Output'));
  if (start === -1 || end === -1 || end <= start + 1) return null;
  const body = lines
    .slice(start + 1, end)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  return body.length === 0 ? null : body.join('\n');
}

export function isFiniteInt(v: unknown): v is number {
  return isFiniteNumber(v) && Number.isInteger(v);
}
