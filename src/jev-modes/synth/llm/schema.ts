/**
 * Structured output of the LLM candidate source (docs/LLM-JEV-DESIGN.md §4.5, §4.10): the forced
 * `propose_fix` and `write_reproduction` tools as flat strict JSON schemas (no `oneOf`, empty
 * arrays instead of optional keys) and the field-by-field readers that turn a GenerateResult into
 * a typed value or a `malformed` verdict. A hunk is `{path, old, new, near_line}`: `old` is
 * copied from the listing and anchored in candidates.ts (exact → whitespace → token signature),
 * `near_line` only breaks ties. A malformed sample is dropped, never retried.
 */
import { extractLastFencedJson } from '../../../provider/actions.js';
import { isJsonArray, isJsonObject, parseJson } from '../../../core/json.js';
import type { GenerateResult, Json, JsonObject, ToolSpec } from '../../../core/types.js';
import { FAILURE_KINDS, isFailureKind } from '../oracle/questions.js';
import type { FailureKind } from '../oracle/types.js';

export const PROPOSE_FIX_TOOL_NAME = 'propose_fix';
export const WRITE_REPRODUCTION_TOOL_NAME = 'write_reproduction';

/** Bounds of one `propose_fix` reply (§4.5): strings are clipped, list caps are enforced in candidates.ts. */
export const FIX_LIMITS = {
  patches: 3,
  edits: 12,
  files: 4,
  analysisChars: 300,
  rationaleChars: 200,
  needPaths: 3,
  needSymbols: 6,
} as const;

/** Bounds of one `write_reproduction` reply (§4.10). */
export const REPRO_LIMITS = {
  scriptLines: 60,
  expectedChars: 300,
  quoteChars: 200,
} as const;

const HUNK_SCHEMA: JsonObject = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'workspace-relative path of the file to edit, exactly as shown in the listing' },
    old: { type: 'string', description: 'the contiguous block to replace, copied verbatim from the listing (indentation included, at least one line, unique in the file)' },
    new: { type: 'string', description: 'the replacement block with its indentation; an empty string deletes the block' },
    near_line: { type: 'integer', description: 'the L<n> of the first line of `old` in the listing; 0 when unknown' },
  },
  required: ['path', 'old', 'new', 'near_line'],
  additionalProperties: false,
};

const PATCH_SCHEMA: JsonObject = {
  type: 'object',
  properties: {
    rationale: { type: 'string', description: `why this patch fixes the failure, at most ${FIX_LIMITS.rationaleChars} characters` },
    edits: { type: 'array', description: `1 to ${FIX_LIMITS.edits} edits, at most ${FIX_LIMITS.files} files`, items: HUNK_SCHEMA },
  },
  required: ['rationale', 'edits'],
  additionalProperties: false,
};

export const PROPOSE_FIX_TOOL: ToolSpec = {
  name: PROPOSE_FIX_TOOL_NAME,
  description: 'Return 1 to 3 genuinely different patches for the localised fault, or an empty patch list with `need` filled when the fix requires code you cannot see.',
  inputSchema: {
    type: 'object',
    properties: {
      analysis: { type: 'string', description: `what the failure shows and where the fault is, at most ${FIX_LIMITS.analysisChars} characters` },
      patches: { type: 'array', description: `0 to ${FIX_LIMITS.patches} patches, each a complete fix on its own`, items: PATCH_SCHEMA },
      need: {
        type: 'object',
        description: 'files or symbols you must see before you can write the fix; empty arrays when none',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: `at most ${FIX_LIMITS.needPaths} workspace paths` },
          symbols: { type: 'array', items: { type: 'string' }, description: `at most ${FIX_LIMITS.needSymbols} function or class names` },
        },
        required: ['paths', 'symbols'],
        additionalProperties: false,
      },
    },
    required: ['analysis', 'patches', 'need'],
    additionalProperties: false,
  },
};

export const WRITE_REPRODUCTION_TOOL: ToolSpec = {
  name: WRITE_REPRODUCTION_TOOL_NAME,
  description: 'Return one standalone Python script that raises (or fails an assert) while the reported bug exists and completes silently once it is fixed.',
  inputSchema: {
    type: 'object',
    properties: {
      script: { type: 'string', description: `top-level statements only, at most ${REPRO_LIMITS.scriptLines} lines; no sys.exit, no printed verdict, no network, no files` },
      expected_behaviour: { type: 'string', description: `what the script's last statements assert, at most ${REPRO_LIMITS.expectedChars} characters` },
      issue_quote: { type: 'string', description: `the sentence of the issue your assertion encodes, copied verbatim, at most ${REPRO_LIMITS.quoteChars} characters` },
      failure_kind: { type: 'string', enum: Object.keys(FAILURE_KINDS), description: 'the kind of failure the reporter observes' },
    },
    required: ['script', 'expected_behaviour', 'issue_quote', 'failure_kind'],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------------------

export interface HunkSpec {
  path: string;
  old: string;
  new: string;
  /** 0 = unknown */
  nearLine: number;
}

export interface PatchSpec {
  rationale: string;
  edits: HunkSpec[];
}

export interface ProposeFixOutput {
  analysis: string;
  patches: PatchSpec[];
  need: { paths: string[]; symbols: string[] };
}

export interface ReproductionOutput {
  script: string;
  expectedBehaviour: string;
  issueQuote: string;
  failureKind: FailureKind;
}

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; reason: string };

/** `finish_reason: length` in either provider's vocabulary (§4.5: the sample is dropped and the next round doubles `max_tokens` once). */
export function isLengthStop(stopReason: string): boolean {
  return stopReason === 'length' || stopReason === 'max_tokens';
}

function clipTo(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

function stringOr(o: JsonObject, key: string, fallback: string | null): string | null {
  const v = o[key];
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return fallback;
  return null;
}

function stringList(v: Json | undefined, max: number): string[] | null {
  if (v === undefined || v === null) return [];
  if (!isJsonArray(v)) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') return null;
    if (x.trim() !== '' && out.length < max) out.push(x);
  }
  return out;
}

/** The tool's input: the forced tool call when present, else the last fenced JSON block of the text (§4.5 fallback). */
function toolInput(result: GenerateResult, name: string): ParseOutcome<JsonObject> {
  const tool = result.toolCalls[0];
  if (tool !== undefined) {
    if (tool.name !== name) return { ok: false, reason: `tool call "${tool.name}" is not ${name}` };
    return isJsonObject(tool.input) ? { ok: true, value: tool.input } : { ok: false, reason: `${name} input is not an object` };
  }
  const block = extractLastFencedJson(result.text);
  if (block === null) return { ok: false, reason: 'no tool call and no fenced json block in the reply' };
  const parsed = parseJson(block);
  if (!parsed.ok) return { ok: false, reason: `fenced json does not parse: ${parsed.error}` };
  return isJsonObject(parsed.value) ? { ok: true, value: parsed.value } : { ok: false, reason: 'fenced json is not an object' };
}

function readHunk(v: Json, where: string): ParseOutcome<HunkSpec> {
  if (!isJsonObject(v)) return { ok: false, reason: `${where} is not an object` };
  const path = stringOr(v, 'path', null);
  const oldText = stringOr(v, 'old', null);
  const newText = stringOr(v, 'new', '');
  if (path === null || oldText === null || newText === null) return { ok: false, reason: `${where} needs string path/old/new` };
  const near = v['near_line'];
  const nearLine = typeof near === 'number' && Number.isInteger(near) && near > 0 ? near : 0;
  return { ok: true, value: { path: path.trim(), old: oldText, new: newText, nearLine } };
}

function readPatch(v: Json, where: string): ParseOutcome<PatchSpec> {
  if (!isJsonObject(v)) return { ok: false, reason: `${where} is not an object` };
  const rationale = stringOr(v, 'rationale', '');
  if (rationale === null) return { ok: false, reason: `${where}.rationale is not a string` };
  const edits = v['edits'];
  if (!isJsonArray(edits) || edits.length === 0) return { ok: false, reason: `${where}.edits is not a non-empty array` };
  const out: HunkSpec[] = [];
  for (const [i, e] of edits.entries()) {
    const h = readHunk(e, `${where}.edits[${i}]`);
    if (!h.ok) return h;
    out.push(h.value);
  }
  return { ok: true, value: { rationale: clipTo(rationale, FIX_LIMITS.rationaleChars), edits: out } };
}

/** Read a `propose_fix` reply; strings are clipped, list caps beyond `patches` are left to the converter (they are per-patch drops, not a malformed sample). */
export function parseProposeFix(result: GenerateResult): ParseOutcome<ProposeFixOutput> {
  const input = toolInput(result, PROPOSE_FIX_TOOL_NAME);
  if (!input.ok) return input;
  const o = input.value;
  const analysis = stringOr(o, 'analysis', '');
  if (analysis === null) return { ok: false, reason: 'analysis is not a string' };
  const patchesRaw = o['patches'];
  if (patchesRaw !== undefined && patchesRaw !== null && !isJsonArray(patchesRaw)) return { ok: false, reason: 'patches is not an array' };
  const patches: PatchSpec[] = [];
  for (const [i, p] of (isJsonArray(patchesRaw) ? patchesRaw : []).entries()) {
    if (patches.length >= FIX_LIMITS.patches) break;
    const r = readPatch(p, `patches[${i}]`);
    if (!r.ok) return r;
    patches.push(r.value);
  }
  const needRaw = o['need'];
  let need: ProposeFixOutput['need'] = { paths: [], symbols: [] };
  if (needRaw !== undefined && needRaw !== null) {
    if (!isJsonObject(needRaw)) return { ok: false, reason: 'need is not an object' };
    const paths = stringList(needRaw['paths'], FIX_LIMITS.needPaths);
    const symbols = stringList(needRaw['symbols'], FIX_LIMITS.needSymbols);
    if (paths === null || symbols === null) return { ok: false, reason: 'need.paths / need.symbols must be string arrays' };
    need = { paths, symbols };
  }
  return { ok: true, value: { analysis: clipTo(analysis, FIX_LIMITS.analysisChars), patches, need } };
}

/** Read a `write_reproduction` reply. */
export function parseWriteReproduction(result: GenerateResult): ParseOutcome<ReproductionOutput> {
  const input = toolInput(result, WRITE_REPRODUCTION_TOOL_NAME);
  if (!input.ok) return input;
  const o = input.value;
  const script = stringOr(o, 'script', null);
  const expected = stringOr(o, 'expected_behaviour', '');
  const quote = stringOr(o, 'issue_quote', '');
  const kind = stringOr(o, 'failure_kind', 'none_of_these');
  if (script === null || script.trim() === '') return { ok: false, reason: 'script is missing or empty' };
  if (expected === null || quote === null || kind === null) return { ok: false, reason: 'expected_behaviour / issue_quote / failure_kind must be strings' };
  return {
    ok: true,
    value: {
      script: script.replace(/\r\n/g, '\n').replace(/\n+$/, ''),
      expectedBehaviour: clipTo(expected.trim(), REPRO_LIMITS.expectedChars),
      issueQuote: clipTo(quote.trim(), REPRO_LIMITS.quoteChars),
      failureKind: isFailureKind(kind) ? kind : 'none_of_these',
    },
  };
}
