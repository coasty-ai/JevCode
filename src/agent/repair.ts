/**
 * Tool-call repair and normalisation (docs/AGENT-LOOP-DESIGN.md §4.4, §6.4): the GLM/Qwen robustness layer.
 *
 * Applied in order to every call of a turn: the name (case-insensitive, then aliases), the JSON (repaired when the
 * adapter's parse failed), argument aliases, type coercion of stringly values, unknown keys dropped, schema validation
 * and the workspace check on `workdir`. A call that cannot be repaired is never a failed step: it becomes a precise
 * tool-result error the model can act on (§3.5). When a turn has no native calls, calls leaked into the prose as GLM or
 * Qwen XML, or as a fenced JSON block, are extracted and recorded as native `tool_use` blocks, so the next request shows
 * the model the native form.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AgentToolName, Json, JsonObject } from '../core/types.js';
import { AGENT_READ_MAX_PATHS, AGENT_SYNTHETIC_ID_PREFIX } from './limits.js';
import { invalidArguments, truncatedCall, unknownTool } from './prompt.js';
import { argNames, argSchema, isAgentToolName, signatureOf, validateArgs } from './tools/specs.js';
import { repairJson } from './json-repair.js';

export { repairJson } from './json-repair.js';

/** A call as the provider (or the text extractor) delivered it. */
export interface RawCall {
  id?: string;
  name: string;
  /** null when the adapter's JSON.parse failed */
  input: Json | null;
  rawJson: string;
}

/** A call after repair, ready to be recorded and resolved. */
export interface NormalisedCall {
  id: string;
  name: AgentToolName | 'invalid';
  /** what the model called it (for UNKNOWN TOOL and the summary) */
  rawName: string;
  /** the arguments replayed in the assistant's `tool_use` block: the model's own object when it sent one */
  replayInput: JsonObject;
  /** the normalised arguments; meaningful only when `error` is null */
  args: JsonObject;
  /** read_file with `paths: [...]`: every path, in order (≤ 8) */
  paths?: string[];
  /** argument names that were dropped (`(ignored unknown arguments: a, b)`) */
  ignored: string[];
  /** the tool-result text of a call that cannot run; null when valid */
  error: string | null;
}

/** §4.4 step 1 */
const NAME_ALIASES: Readonly<Record<string, AgentToolName>> = {
  read: 'read_file',
  view: 'read_file',
  cat: 'read_file',
  write: 'write_file',
  create_file: 'write_file',
  edit: 'edit_file',
  str_replace: 'edit_file',
  replace: 'edit_file',
  search_replace: 'edit_file',
  shell: 'bash',
  run: 'bash',
  run_command: 'bash',
  execute_command: 'bash',
  exec: 'bash',
  search: 'grep',
  search_files: 'grep',
  rg: 'grep',
  find_files: 'glob',
  list_files: 'glob',
  todowrite: 'todo_write',
  update_plan: 'todo_write',
  write_todos: 'todo_write',
};

/** §4.4 step 3 */
const ARG_ALIASES: Readonly<Record<string, string>> = {
  file_path: 'path',
  filePath: 'path',
  filename: 'path',
  file: 'path',
  old: 'old_string',
  oldString: 'old_string',
  old_str: 'old_string',
  oldText: 'old_string',
  new: 'new_string',
  newString: 'new_string',
  new_str: 'new_string',
  newText: 'new_string',
  replaceAll: 'replace_all',
  cmd: 'command',
  cwd: 'workdir',
  dir: 'workdir',
  directory: 'workdir',
  timeout: 'timeout_ms',
  query: 'pattern',
  regex: 'pattern',
  include: 'glob',
};

/** The tool a name means, or null (§4.4 step 1). */
export function resolveToolName(name: string): AgentToolName | null {
  const trimmed = name.trim();
  if (isAgentToolName(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  if (isAgentToolName(lower)) return lower;
  return NAME_ALIASES[lower] ?? null;
}

function isObject(v: Json | undefined): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The input as an object: the adapter's parse, a JSON string, or the repaired raw JSON. */
function inputObject(raw: RawCall): JsonObject | null {
  if (isObject(raw.input ?? undefined)) return raw.input as JsonObject;
  if (typeof raw.input === 'string') {
    const parsed = repairJson(raw.input);
    return isObject(parsed ?? undefined) ? (parsed as JsonObject) : null;
  }
  if (raw.rawJson.trim() === '') return {};
  const repaired = repairJson(raw.rawJson);
  return isObject(repaired ?? undefined) ? (repaired as JsonObject) : null;
}

/** §4.4 step 3: aliases apply only when the tool knows the canonical name and the model did not also send it. */
function applyAliases(tool: AgentToolName, input: JsonObject): JsonObject {
  const known = new Set(argNames(tool));
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(input)) {
    const canonical = !known.has(k) ? ARG_ALIASES[k] : undefined;
    if (canonical !== undefined && known.has(canonical) && !(canonical in input) && !(canonical in out)) {
      // `timeout` below 1,000 is read as seconds (models write `timeout: 30`)
      out[canonical] = k === 'timeout' && typeof v === 'number' && v > 0 && v < 1000 ? Math.round(v * 1000) : v;
    } else if (!(k in out)) out[k] = v;
  }
  return out;
}

/** Stringly values become the type the schema asks for (`"20"` → 20, `"true"` → true, a JSON array string → the array). */
function coerce(tool: AgentToolName, input: JsonObject): JsonObject {
  const out: JsonObject = { ...input };
  for (const [k, v] of Object.entries(input)) {
    const s = argSchema(tool, k);
    if (s === null || typeof v !== 'string') continue;
    const t = s['type'];
    const text = v.trim();
    if (t === 'integer' && /^-?\d+$/.test(text)) out[k] = Number(text);
    else if (t === 'boolean' && (text === 'true' || text === 'false')) out[k] = text === 'true';
    else if ((t === 'array' || t === 'object') && /^[[{]/.test(text)) {
      const parsed = repairJson(text);
      if (parsed !== null) out[k] = parsed;
    }
  }
  return out;
}

/** A workspace-relative directory, or an error. `.` and '' mean the root and are dropped. */
export function normaliseWorkdir(root: string, dir: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const text = dir.trim();
  if (text === '' || text === '.' || text === './') return { ok: true, value: null };
  const abs = isAbsolute(text) ? resolve(text) : resolve(root, text);
  const rel = relative(root, abs);
  if (rel === '') return { ok: true, value: null };
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { ok: false, error: `workdir "${dir}" is outside the workspace` };
  return { ok: true, value: rel.split(sep).join('/') };
}

/** An absolute path inside the workspace becomes workspace-relative; anything else is left for the tool to judge. */
function relativiseInside(root: string, path: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(root, resolve(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : path;
}

export interface NormaliseOptions {
  root: string;
  /** the turn stopped at the output limit and this call is its last: an unparseable call was cut off, not malformed */
  cutOff: boolean;
  maxTokens: number;
}

/** §4.4 steps 1-5 for one call (the id is assigned separately). */
export function normaliseCall(raw: RawCall, o: NormaliseOptions): Omit<NormalisedCall, 'id'> {
  const rawName = raw.name;
  const tool = resolveToolName(rawName);
  const original = inputObject(raw);
  const replayInput = original ?? {};
  const fail = (name: AgentToolName | 'invalid', error: string): Omit<NormalisedCall, 'id'> => ({ name, rawName, replayInput, args: {}, ignored: [], error });
  if (tool === null) return fail('invalid', unknownTool(rawName));
  if (original === null) {
    if (o.cutOff) return fail(tool, truncatedCall(o.maxTokens));
    return fail(tool, invalidArguments(tool, 'the arguments are not valid JSON', signatureOf(tool)));
  }
  let input = coerce(tool, applyAliases(tool, original));
  // `read_file` with `paths: [...]` reads each path in one call, so the call keeps its one id and one result (§4.4 step 3)
  let paths: string[] | undefined;
  if (tool === 'read_file' && Array.isArray(input['paths']) && !('path' in input)) {
    const list = input['paths'].filter((p): p is string => typeof p === 'string' && p.trim() !== '');
    if (list.length > 0) {
      paths = list.slice(0, AGENT_READ_MAX_PATHS).map((p) => relativiseInside(o.root, p));
      const { paths: _dropped, ...rest } = input;
      input = { ...rest, path: paths[0]! };
    }
  }
  const known = new Set(argNames(tool));
  const ignored = Object.keys(input).filter((k) => !known.has(k));
  const args: JsonObject = {};
  for (const [k, v] of Object.entries(input)) if (known.has(k)) args[k] = v;
  const problem = validateArgs(tool, args);
  if (problem !== null) return { ...fail(tool, invalidArguments(tool, problem, signatureOf(tool))), ignored };
  for (const key of ['path'] as const) {
    const v = args[key];
    if (typeof v === 'string' && !v.startsWith('jevcode:')) args[key] = relativiseInside(o.root, v);
  }
  if (tool === 'bash' && typeof args['workdir'] === 'string') {
    const wd = normaliseWorkdir(o.root, args['workdir']);
    if (!wd.ok) return { ...fail(tool, invalidArguments(tool, wd.error, signatureOf(tool))), ignored };
    if (wd.value === null) delete args['workdir'];
    else args['workdir'] = wd.value;
  }
  return { name: tool, rawName, replayInput, args, ...(paths !== undefined ? { paths } : {}), ignored, error: null };
}

/**
 * §3.1 step 6: the provider's id when it is non-empty and not yet used in this run's transcript, else
 * `call_<turn>_<i>` (suffixed until unique). The assistant record replays the same id, so pairing holds on every wire.
 */
export function assignIds(calls: readonly RawCall[], turn: number, used: Set<string>): string[] {
  const out: string[] = [];
  calls.forEach((c, i) => {
    let id = typeof c.id === 'string' ? c.id.trim() : '';
    if (id === '' || used.has(id)) {
      const base = `${AGENT_SYNTHETIC_ID_PREFIX}${turn}_${i}`;
      id = base;
      for (let n = 2; used.has(id); n += 1) id = `${base}_${n}`;
    }
    used.add(id);
    out.push(id);
  });
  return out;
}

// ---------------------------------------------------------------------------------------
// §4.4 step 6: calls written into the prose
// ---------------------------------------------------------------------------------------

const GLM_CALL = /<tool_call>\s*([^<\s]+)\s*((?:<arg_key>[\s\S]*?<\/arg_key>\s*<arg_value>[\s\S]*?<\/arg_value>\s*)*)<\/tool_call>/g;
const GLM_PAIR = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
const QWEN_CALL = /(?:<tool_call>\s*)?<function=([^>\s]+)>([\s\S]*?)<\/function>(?:\s*<\/tool_call>)?/g;
const QWEN_PARAM = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g;
const FENCED_JSON = /```(?:json)?[ \t]*\n([\s\S]*?)\n?```/g;

/** A parameter value: one leading and one trailing newline are layout, not content. */
function xmlValue(v: string): string {
  return v.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

function extractGlm(text: string): RawCall[] {
  const calls: RawCall[] = [];
  for (const m of text.matchAll(GLM_CALL)) {
    const input: JsonObject = {};
    for (const p of (m[2] ?? '').matchAll(GLM_PAIR)) input[(p[1] ?? '').trim()] = xmlValue(p[2] ?? '');
    calls.push({ name: m[1] ?? '', input, rawJson: JSON.stringify(input) });
  }
  return calls;
}

function extractQwen(text: string): RawCall[] {
  const calls: RawCall[] = [];
  for (const m of text.matchAll(QWEN_CALL)) {
    const input: JsonObject = {};
    for (const p of (m[2] ?? '').matchAll(QWEN_PARAM)) input[(p[1] ?? '').trim()] = xmlValue(p[2] ?? '');
    calls.push({ name: m[1] ?? '', input, rawJson: JSON.stringify(input) });
  }
  return calls;
}

function jsonCall(v: Json): RawCall | null {
  if (!isObject(v) || typeof v['name'] !== 'string' || resolveToolName(v['name']) === null) return null;
  const args = v['arguments'] ?? v['parameters'] ?? v['input'] ?? {};
  const input = typeof args === 'string' ? repairJson(args) : args;
  return { name: v['name'], input: input ?? null, rawJson: typeof args === 'string' ? args : JSON.stringify(args) };
}

function extractFencedJson(text: string): { calls: RawCall[]; spans: [number, number][] } {
  const calls: RawCall[] = [];
  const spans: [number, number][] = [];
  for (const m of text.matchAll(FENCED_JSON)) {
    const parsed = repairJson(m[1] ?? '');
    if (parsed === null) continue;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const found = items.map(jsonCall);
    if (found.length === 0 || found.some((c) => c === null)) continue;
    calls.push(...(found as RawCall[]));
    spans.push([m.index, m.index + m[0].length]);
  }
  return { calls, spans };
}

function tidy(prose: string): string {
  return prose.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * §4.4 step 6: calls a turn wrote into its text instead of the native interface, tried as GLM XML, then Qwen XML, then
 * fenced JSON; `prose` is the text with the extracted blocks removed. No calls → the text is returned unchanged.
 */
export function extractTextToolCalls(text: string): { calls: RawCall[]; prose: string } {
  const glm = extractGlm(text);
  if (glm.length > 0) return { calls: glm, prose: tidy(text.replace(GLM_CALL, '')) };
  const qwen = extractQwen(text);
  if (qwen.length > 0) return { calls: qwen, prose: tidy(text.replace(QWEN_CALL, '')) };
  const fenced = extractFencedJson(text);
  if (fenced.calls.length > 0) {
    let prose = '';
    let at = 0;
    for (const [s, e] of fenced.spans) {
      prose += text.slice(at, s);
      at = e;
    }
    return { calls: fenced.calls, prose: tidy(prose + text.slice(at)) };
  }
  return { calls: [], prose: text };
}

/** The `(ignored unknown arguments: a, b)` line of a result (§4.4 step 4). */
export function ignoredLine(ignored: readonly string[]): string | null {
  return ignored.length === 0 ? null : `(ignored unknown arguments: ${ignored.join(', ')})`;
}

/** A recorded call as the driver runs it: its parse-time verdict, or the call normalised again (deterministic). */
export function deriveCall(rec: { id: string; name: string; input: JsonObject; error?: string }, root: string): NormalisedCall {
  if (rec.error !== undefined) return { id: rec.id, name: resolveToolName(rec.name) ?? 'invalid', rawName: rec.name, replayInput: rec.input, args: {}, ignored: [], error: rec.error };
  return { id: rec.id, ...normaliseCall({ name: rec.name, input: rec.input, rawJson: JSON.stringify(rec.input) }, { root, cutOff: false, maxTokens: 0 }) };
}
