/**
 * Terminal-Bench 4.0 task data (bench/data/terminal-bench/{manifest.json,tasks/<name>/}).
 * The manifest carries the runner fields the data agent extracted; task.toml is parsed with a
 * small TOML subset reader for artifacts, the verifier timeout and metadata.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isFiniteNumber, isJsonArray, isJsonObject, isString, isStringArray, parseJson } from '../../core/json.js';
import type { Json } from '../../core/types.js';
import { ConfigError } from '../../errors.js';

export interface TbManifestRecord {
  name: string;
  category: string | null;
  subcategory: string | null;
  difficulty: string | null;
  expert_time_estimate_hours: number | null;
  verifier_timeout_sec: number;
  artifacts: string[];
  env_workdir: string;
  env_copy_lines: string[];
  env_run_steps_non_install: string[];
  verifier_pip_packages: string[];
  tests_hardcode_paths: string[];
  local_feasibility: string | null;
  shim_effort: string | null;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

function optString(o: Record<string, Json>, key: string): string | null {
  const v = o[key];
  return isString(v) ? v : null;
}
function strArrayOr(o: Record<string, Json>, key: string, where: string): string[] {
  const v = o[key];
  if (v === undefined || v === null) return [];
  if (!isStringArray(v)) throw new ConfigError(`${where}: "${key}" must be a string array`);
  return v;
}

/** Harbor artifacts: plain paths or `{ source, destination?, service?, exclude? }` objects; the source path is what a runner copies. */
function artifactPaths(o: Record<string, Json>, where: string): string[] {
  const v = o['artifacts'];
  if (v === undefined || v === null) return [];
  if (!isJsonArray(v)) throw new ConfigError(`${where}: "artifacts" must be an array`);
  const out: string[] = [];
  for (const a of v) {
    if (isString(a)) out.push(a);
    else if (isJsonObject(a) && isString(a['source'])) out.push(a['source']);
    else throw new ConfigError(`${where}: malformed artifact entry`);
  }
  return out;
}

export function validateManifestRecord(v: Json, index: number): TbManifestRecord {
  const where = `terminal-bench manifest #${index}`;
  if (!isJsonObject(v)) throw new ConfigError(`${where}: not an object`);
  const name = v['name'];
  if (!isString(name) || !NAME_RE.test(name)) throw new ConfigError(`${where}: malformed name`);
  const w = `terminal-bench manifest ${name}`;
  const timeout = v['verifier_timeout_sec'];
  const hours = v['expert_time_estimate_hours'];
  const workdir = v['env_workdir'];
  return {
    name,
    category: optString(v, 'category'),
    subcategory: optString(v, 'subcategory'),
    difficulty: optString(v, 'difficulty'),
    expert_time_estimate_hours: isFiniteNumber(hours) ? hours : null,
    verifier_timeout_sec: isFiniteNumber(timeout) && timeout > 0 ? timeout : 600,
    artifacts: artifactPaths(v, w),
    env_workdir: isString(workdir) && workdir.startsWith('/') ? workdir : '/app',
    env_copy_lines: strArrayOr(v, 'env_copy_lines', w),
    env_run_steps_non_install: strArrayOr(v, 'env_run_steps_non_install', w),
    verifier_pip_packages: strArrayOr(v, 'verifier_pip_packages', w),
    tests_hardcode_paths: strArrayOr(v, 'tests_hardcode_paths', w),
    local_feasibility: optString(v, 'local_feasibility'),
    shim_effort: optString(v, 'shim_effort'),
  };
}

export function parseManifest(text: string, where: string): TbManifestRecord[] {
  const parsed = parseJson(text);
  if (!parsed.ok) throw new ConfigError(`${where}: invalid JSON (${parsed.error})`);
  if (!isJsonArray(parsed.value)) throw new ConfigError(`${where}: expected an array`);
  return parsed.value.map((r, i) => validateManifestRecord(r, i));
}

// ---------------------------------------------------------------------------------------
// task.toml subset: top-level keys, [tables], [[array tables]], strings, numbers, booleans,
// arrays (multi-line), inline tables. Enough for Harbor's TaskConfig; anything else throws.
// ---------------------------------------------------------------------------------------

export type TomlValue = string | number | boolean | TomlValue[] | { [k: string]: TomlValue };
export type TomlTable = { [k: string]: TomlValue };

class TomlReader {
  private i = 0;
  private readonly s: string;
  constructor(s: string) {
    this.s = s;
  }
  private peek(): string {
    return this.s[this.i] ?? '';
  }
  private skipWs(): void {
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.i++;
      else if (c === '#') {
        while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++;
      } else break;
    }
  }
  private fail(msg: string): never {
    throw new ConfigError(`task.toml: ${msg} at offset ${this.i}`);
  }
  readValue(): TomlValue {
    this.skipWs();
    const c = this.peek();
    if (c === '"') return this.readBasicString();
    if (c === "'") return this.readLiteralString();
    if (c === '[') return this.readArray();
    if (c === '{') return this.readInlineTable();
    const m = /^(true|false|[+-]?(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|[+-]?inf|[+-]?nan)/.exec(this.s.slice(this.i));
    if (!m) this.fail('unsupported value');
    this.i += m[0].length;
    if (m[0] === 'true') return true;
    if (m[0] === 'false') return false;
    const n = Number(m[0].split('_').join(''));
    if (!Number.isFinite(n)) this.fail('non-finite number');
    return n;
  }
  private readBasicString(): string {
    if (this.s.startsWith('"""', this.i)) {
      this.i += 3;
      const end = this.s.indexOf('"""', this.i);
      if (end === -1) this.fail('unterminated string');
      const raw = this.s.slice(this.i, end).replace(/^\r?\n/, '');
      this.i = end + 3;
      return raw;
    }
    this.i++;
    let out = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (c === '"') {
        this.i++;
        return out;
      }
      if (c === '\\') {
        const n = this.s[this.i + 1] ?? '';
        const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' };
        if (n === 'u' || n === 'U') {
          const len = n === 'u' ? 4 : 8;
          const hex = this.s.slice(this.i + 2, this.i + 2 + len);
          out += String.fromCodePoint(Number.parseInt(hex, 16));
          this.i += 2 + len;
        } else if (n in map) {
          out += map[n]!;
          this.i += 2;
        } else this.fail(`bad escape \\${n}`);
        continue;
      }
      if (c === '\n') this.fail('newline in string');
      out += c;
      this.i++;
    }
    return this.fail('unterminated string');
  }
  private readLiteralString(): string {
    if (this.s.startsWith("'''", this.i)) {
      this.i += 3;
      const end = this.s.indexOf("'''", this.i);
      if (end === -1) this.fail('unterminated string');
      const raw = this.s.slice(this.i, end).replace(/^\r?\n/, '');
      this.i = end + 3;
      return raw;
    }
    this.i++;
    const end = this.s.indexOf("'", this.i);
    if (end === -1) this.fail('unterminated string');
    const out = this.s.slice(this.i, end);
    this.i = end + 1;
    return out;
  }
  private readArray(): TomlValue[] {
    this.i++;
    const out: TomlValue[] = [];
    for (;;) {
      this.skipWs();
      if (this.peek() === ']') {
        this.i++;
        return out;
      }
      out.push(this.readValue());
      this.skipWs();
      if (this.peek() === ',') this.i++;
      else if (this.peek() !== ']') this.fail('expected , or ]');
      if (out.length > 10_000) this.fail('array too long');
    }
  }
  private readInlineTable(): TomlTable {
    this.i++;
    const out: TomlTable = {};
    for (;;) {
      this.skipWs();
      if (this.peek() === '}') {
        this.i++;
        return out;
      }
      const key = this.readKey();
      this.skipWs();
      if (this.peek() !== '=') this.fail('expected =');
      this.i++;
      out[key] = this.readValue();
      this.skipWs();
      if (this.peek() === ',') this.i++;
      else if (this.peek() !== '}') this.fail('expected , or }');
    }
  }
  readKey(): string {
    this.skipWs();
    const c = this.peek();
    if (c === '"') return this.readBasicString();
    if (c === "'") return this.readLiteralString();
    const m = /^[A-Za-z0-9_-]+/.exec(this.s.slice(this.i));
    if (!m) this.fail('expected key');
    this.i += m[0].length;
    return m[0];
  }
  /** Dotted key path: a.b."c d" */
  readKeyPath(): string[] {
    const parts = [this.readKey()];
    for (;;) {
      const save = this.i;
      while (this.peek() === ' ' || this.peek() === '\t') this.i++;
      if (this.peek() === '.') {
        this.i++;
        parts.push(this.readKey());
      } else {
        this.i = save;
        return parts;
      }
    }
  }
  atEnd(): boolean {
    this.skipWs();
    return this.i >= this.s.length;
  }
  expect(ch: string): void {
    this.skipWs();
    if (this.peek() !== ch) this.fail(`expected ${ch}`);
    this.i++;
  }
  lookahead(str: string): boolean {
    this.skipWs();
    return this.s.startsWith(str, this.i);
  }
  advance(n: number): void {
    this.i += n;
  }
}

function descend(root: TomlTable, path: string[], arrayLeaf: boolean): TomlTable {
  let cur: TomlTable = root;
  for (const [idx, key] of path.entries()) {
    const last = idx === path.length - 1;
    const existing = cur[key];
    if (last && arrayLeaf) {
      const arr = Array.isArray(existing) ? existing : [];
      if (!Array.isArray(existing)) cur[key] = arr;
      const t: TomlTable = {};
      arr.push(t);
      return t;
    }
    if (existing === undefined) {
      const t: TomlTable = {};
      cur[key] = t;
      cur = t;
    } else if (Array.isArray(existing)) {
      const lastEl = existing.at(-1);
      if (lastEl === undefined || typeof lastEl !== 'object' || Array.isArray(lastEl)) throw new ConfigError(`task.toml: ${key} is not a table`);
      cur = lastEl;
    } else if (typeof existing === 'object') {
      cur = existing;
    } else throw new ConfigError(`task.toml: ${key} is not a table`);
  }
  return cur;
}

export function parseToml(text: string): TomlTable {
  const r = new TomlReader(text);
  const root: TomlTable = {};
  let cur = root;
  let guard = 0;
  while (!r.atEnd()) {
    if (++guard > 100_000) throw new ConfigError('task.toml: too many statements');
    if (r.lookahead('[[')) {
      r.advance(2);
      const path = r.readKeyPath();
      r.expect(']');
      r.expect(']');
      cur = descend(root, path, true);
      continue;
    }
    if (r.lookahead('[')) {
      r.advance(1);
      const path = r.readKeyPath();
      r.expect(']');
      cur = descend(root, path, false);
      continue;
    }
    const path = r.readKeyPath();
    r.expect('=');
    const value = r.readValue();
    const parent = path.length > 1 ? descend(cur, path.slice(0, -1), false) : cur;
    parent[path.at(-1)!] = value;
  }
  return root;
}

export interface TaskToml {
  artifacts: string[];
  verifierTimeoutSec: number | null;
  collectCommands: string[];
  metadata: Record<string, string>;
}

function tableAt(t: TomlTable, key: string): TomlTable | null {
  const v = t[key];
  return v !== undefined && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

export function readTaskToml(text: string): TaskToml {
  const t = parseToml(text);
  const artifacts: string[] = [];
  const rawArtifacts = t['artifacts'];
  if (Array.isArray(rawArtifacts)) {
    for (const a of rawArtifacts) {
      if (typeof a === 'string') artifacts.push(a);
      else if (typeof a === 'object' && !Array.isArray(a) && typeof a['source'] === 'string') artifacts.push(a['source']);
    }
  }
  const verifier = tableAt(t, 'verifier');
  const timeout = verifier?.['timeout_sec'];
  const collectCommands: string[] = [];
  const collect = verifier?.['collect'];
  if (Array.isArray(collect)) {
    for (const c of collect) {
      if (typeof c === 'object' && !Array.isArray(c) && typeof c['command'] === 'string') collectCommands.push(c['command']);
    }
  }
  const metadata: Record<string, string> = {};
  const md = tableAt(t, 'metadata');
  if (md) for (const [k, v] of Object.entries(md)) if (typeof v === 'string' || typeof v === 'number') metadata[k] = String(v);
  return { artifacts, verifierTimeoutSec: typeof timeout === 'number' && timeout > 0 ? timeout : null, collectCommands, metadata };
}

export interface TbTaskRecord {
  manifest: TbManifestRecord;
  toml: TaskToml;
  taskDir: string;
  /** upstream solution/ (mocked bench only); null when absent */
  goldDir: string | null;
  instruction: string;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export const TB_DIR = 'terminal-bench';

/** Manifest filtered to names with a tasks/<name>/ directory, each with task.toml parsed. */
export async function loadTerminalBenchRecords(dataDir: string): Promise<TbTaskRecord[]> {
  const root = join(dataDir, TB_DIR);
  const manifestPath = join(root, 'manifest.json');
  let text: string;
  try {
    text = await readFile(manifestPath, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read Terminal-Bench manifest ${manifestPath}`, { cause: e });
  }
  const manifest = parseManifest(text, manifestPath);
  const present = new Set(await readdir(join(root, 'tasks')).catch((): string[] => []));
  const out: TbTaskRecord[] = [];
  for (const m of manifest) {
    if (!present.has(m.name)) continue;
    const taskDir = join(root, 'tasks', m.name);
    if (!(await isDir(taskDir))) continue;
    const [tomlText, instruction] = await Promise.all([readFile(join(taskDir, 'task.toml'), 'utf8'), readFile(join(taskDir, 'instruction.md'), 'utf8')]);
    const toml = readTaskToml(tomlText);
    const goldDir = join(root, 'gold', m.name);
    out.push({ manifest: m, toml, taskDir, goldDir: (await isDir(goldDir)) ? goldDir : null, instruction });
  }
  return out;
}
