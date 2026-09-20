/**
 * QuixBugs index records (bench/data/quixbugs/index.json, schema in its README) and the
 * program/test files they point at. Loading validates every field so a hand-edited index
 * fails loudly before any workspace is built. `buggyLine`/`fixedLine` are the fix: they
 * stay inside this module's records and reach only the mocked trajectory, never the task text.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isFiniteNumber, isJsonArray, isJsonObject, isString, parseJson } from '../../core/json.js';
import type { Json } from '../../core/types.js';
import { ConfigError } from '../../errors.js';

export const QUIXBUGS_DIR = 'quixbugs';
export const RUN_TESTS_FILE = 'run_tests.py';
export const NODE_FILE = 'node.py';

export const QUIXBUGS_KINDS = ['operator', 'off_by_one', 'argument_swap', 'missing_condition', 'wrong_variable', 'wrong_call', 'control_flow', 'other'] as const;
export type QuixbugsKind = (typeof QUIXBUGS_KINDS)[number];

export interface QuixbugsRecord {
  name: string;
  /** 1-based line in programs/<name>.py; for insertions the line before which the statement belongs */
  bugLine: number;
  /** whitespace-stripped buggy line; null for the four insertion fixes */
  buggyLine: string | null;
  /** whitespace-stripped fixed line */
  fixedLine: string;
  kind: QuixbugsKind;
  hasJsonTests: boolean;
  testCount: number;
  /** optional one-line description (upstream docstring); appended to the task text when present */
  description: string | null;
}

/** One JSON test case of tests/<name>.json. */
export interface QuixbugsCase {
  input: Json[];
  expected: Json;
  slow?: boolean;
  timeout?: number;
}

const NAME_RE = /^[a-z][a-z0-9_]*$/;

export function validateIndexRecord(v: Json, index: number): QuixbugsRecord {
  const where = `quixbugs index record #${index}`;
  if (!isJsonObject(v)) throw new ConfigError(`${where}: not an object`);
  const name = v['name'];
  if (!isString(name) || !NAME_RE.test(name)) throw new ConfigError(`${where}: malformed name`);
  const w = `quixbugs record ${name}`;
  const bugLine = v['bugLine'];
  if (!isFiniteNumber(bugLine) || !Number.isInteger(bugLine) || bugLine < 1) throw new ConfigError(`${w}: bugLine must be a positive integer`);
  const buggyLine = v['buggyLine'];
  if (!(buggyLine === null || isString(buggyLine))) throw new ConfigError(`${w}: buggyLine must be a string or null`);
  const fixedLine = v['fixedLine'];
  if (!isString(fixedLine) || fixedLine.trim() === '') throw new ConfigError(`${w}: fixedLine must be a non-empty string`);
  const kind = v['kind'];
  if (!isString(kind) || !(QUIXBUGS_KINDS as readonly string[]).includes(kind)) throw new ConfigError(`${w}: unknown kind "${String(kind)}"`);
  const hasJsonTests = v['hasJsonTests'];
  if (typeof hasJsonTests !== 'boolean') throw new ConfigError(`${w}: hasJsonTests must be a boolean`);
  const testCount = v['testCount'];
  if (!isFiniteNumber(testCount) || testCount < 1) throw new ConfigError(`${w}: testCount must be a positive number`);
  const description = v['description'];
  if (!(description === undefined || description === null || isString(description))) throw new ConfigError(`${w}: description must be a string`);
  return {
    name,
    bugLine,
    buggyLine: buggyLine ?? null,
    fixedLine,
    kind: kind as QuixbugsKind,
    hasJsonTests,
    testCount,
    description: isString(description) && description.trim() !== '' ? description.trim() : null,
  };
}

export function parseIndex(text: string, where: string): QuixbugsRecord[] {
  const parsed = parseJson(text);
  if (!parsed.ok) throw new ConfigError(`${where}: invalid JSON (${parsed.error})`);
  if (!isJsonArray(parsed.value)) throw new ConfigError(`${where}: expected a JSON array of records`);
  const out = parsed.value.map((r, i) => validateIndexRecord(r, i));
  const seen = new Set<string>();
  for (const r of out) {
    if (seen.has(r.name)) throw new ConfigError(`${where}: duplicate program ${r.name}`);
    seen.add(r.name);
  }
  return out;
}

export async function loadIndex(quixbugsDir: string): Promise<QuixbugsRecord[]> {
  const path = join(quixbugsDir, 'index.json');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read QuixBugs index ${path}`, { cause: e });
  }
  return parseIndex(text, path);
}

export function validateCases(v: Json, where: string): QuixbugsCase[] {
  if (!isJsonArray(v)) throw new ConfigError(`${where}: expected a JSON array of cases`);
  return v.map((c, i) => {
    if (!isJsonObject(c) || !isJsonArray(c['input']) || !('expected' in c)) throw new ConfigError(`${where}: case #${i} must have "input" (array) and "expected"`);
    const out: QuixbugsCase = { input: c['input'], expected: c['expected'] ?? null };
    if (c['slow'] === true) out.slow = true;
    const timeout = c['timeout'];
    if (isFiniteNumber(timeout) && timeout > 0) out.timeout = timeout;
    return out;
  });
}

export async function loadCases(quixbugsDir: string, name: string): Promise<QuixbugsCase[]> {
  const path = join(quixbugsDir, 'tests', `${name}.json`);
  const text = await readFile(path, 'utf8').catch((e: unknown) => {
    throw new ConfigError(`cannot read QuixBugs tests ${path}`, { cause: e });
  });
  const parsed = parseJson(text);
  if (!parsed.ok) throw new ConfigError(`${path}: invalid JSON (${parsed.error})`);
  return validateCases(parsed.value, path);
}

export function programPath(quixbugsDir: string, name: string): string {
  return join(quixbugsDir, 'programs', `${name}.py`);
}
export function correctPath(quixbugsDir: string, name: string): string {
  return join(quixbugsDir, 'correct', `${name}.py`);
}
export function moduleTestPath(quixbugsDir: string, name: string): string {
  return join(quixbugsDir, 'tests', `${name}_test.py`);
}

/** `from node import Node` / `import node`: the graph programs and their tests need node.py beside them. */
export function usesNode(source: string): boolean {
  return /^\s*(?:from\s+node\s+import\b|import\s+node\b)/m.test(source);
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}
