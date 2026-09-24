/**
 * Generator protocol (DESIGN.md §7, §19.1): the `propose_action` tool schema, the parser that
 * turns a GenerateResult into a validated Proposal, and the one-line action summary used by
 * the window, the transcript and the loop detector.
 */
import { GeneratorResponseError } from '../errors.js';
import { isJsonObject, isString, isStringArray, parseJson } from '../core/json.js';
import type { Action, ActionKind, GenerateResult, Json, JsonObject, PlanDraft, Proposal, ToolSpec } from '../core/types.js';

export const PROPOSE_ACTION_TOOL_NAME = 'propose_action';

/** Characters of rawText kept in the retry message after a malformed reply (§6 stage table). */
export const RAW_TEXT_TAIL_CHARS = 500;

const ACTION_KINDS: readonly ActionKind[] = ['read', 'edit', 'write', 'patch', 'run', 'done'];

const stringSchema = (description: string): JsonObject => ({ type: 'string', description });

function actionVariant(kind: ActionKind, props: Record<string, JsonObject>, required: string[]): JsonObject {
  return {
    type: 'object',
    properties: { kind: { type: 'string', const: kind }, ...props },
    required: ['kind', ...required],
    additionalProperties: false,
  };
}

/** JSON Schema of { goal, action, plan }; the Action union as oneOf, strict everywhere. */
export const PROPOSE_ACTION_TOOL: ToolSpec = {
  name: PROPOSE_ACTION_TOOL_NAME,
  description:
    'Propose exactly one next action for the coding task together with a one-sentence goal and the full updated plan. ' +
    'The harness executes the action (after a safety review) and shows you the result on the next turn.',
  inputSchema: {
    type: 'object',
    properties: {
      goal: stringSchema('One sentence: what this single action is meant to achieve.'),
      action: {
        oneOf: [
          actionVariant('read', { paths: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Workspace-relative paths to show (bounded: 12 files, 16 KB each).' } }, ['paths']),
          actionVariant(
            'edit',
            {
              path: stringSchema('Workspace-relative file path.'),
              old: stringSchema('Exact text to replace, copied verbatim; must occur exactly once.'),
              new: stringSchema('Replacement text.'),
            },
            ['path', 'old', 'new'],
          ),
          actionVariant('write', { path: stringSchema('Workspace-relative file path to create or overwrite.'), content: stringSchema('Full file content.') }, ['path', 'content']),
          actionVariant('patch', { diff: stringSchema('Unified diff with a/ b/ prefixes (-p1), applied with git apply.') }, ['diff']),
          actionVariant(
            'run',
            {
              command: stringSchema('Non-interactive shell command run with sh -c in the workspace.'),
              timeoutMs: { type: 'integer', minimum: 1000, description: 'Optional timeout override in milliseconds (capped by the harness).' },
            },
            ['command'],
          ),
          actionVariant('done', { summary: stringSchema('What was done and how it was verified.') }, ['summary']),
        ],
      },
      plan: {
        type: 'object',
        properties: {
          done: { type: 'array', items: { type: 'string' }, description: 'Items finished, including ones finished by this action if it succeeds.' },
          remaining: { type: 'array', items: { type: 'string' }, description: 'Items still to do, in order.' },
          openProblems: { type: 'array', items: { type: 'string' }, description: 'Unresolved problems or questions.' },
        },
        required: ['done', 'remaining', 'openProblems'],
        additionalProperties: false,
      },
    },
    required: ['goal', 'action', 'plan'],
    additionalProperties: false,
  },
};

/**
 * docs/ORCHESTRATION-DESIGN.md §2.5(b) / corner row 24: the same tool with the `action` `oneOf`
 * narrowed to `kinds`. A `role: 'research'` child is offered `read | run | done` and nothing else,
 * so it is never even shown the shape of a write — Cognition's "subagents only tasked with
 * answering a question, not writing any code".
 *
 * The full kind list returns `PROPOSE_ACTION_TOOL` itself (referential identity), so every run
 * without a research role sends the byte-identical schema it sent before.
 */
export function proposeActionToolFor(kinds: readonly ActionKind[]): ToolSpec {
  const wanted = ACTION_KINDS.filter((k) => kinds.includes(k));
  if (wanted.length === ACTION_KINDS.length) return PROPOSE_ACTION_TOOL;
  const schema = PROPOSE_ACTION_TOOL.inputSchema;
  const properties = isJsonObject(schema['properties']) ? schema['properties'] : {};
  const action = isJsonObject(properties['action']) ? properties['action'] : {};
  const oneOf = Array.isArray(action['oneOf']) ? action['oneOf'] : [];
  const variants = oneOf.filter((v) => {
    if (!isJsonObject(v)) return false;
    const props = v['properties'];
    if (!isJsonObject(props)) return false;
    const kind = props['kind'];
    return isJsonObject(kind) && typeof kind['const'] === 'string' && (wanted as readonly string[]).includes(kind['const']);
  });
  return { ...PROPOSE_ACTION_TOOL, inputSchema: { ...schema, properties: { ...properties, action: { ...action, oneOf: variants } } } };
}

function fail(reason: string, rawText: string): never {
  throw new GeneratorResponseError(reason, rawText);
}

function exactKeys(obj: JsonObject, expected: readonly string[], optional: readonly string[], where: string, rawText: string): void {
  const keys = Object.keys(obj);
  for (const k of expected) if (!(k in obj)) fail(`${where}: missing key "${k}"`, rawText);
  for (const k of keys) if (!expected.includes(k) && !optional.includes(k)) fail(`${where}: unexpected key "${k}"`, rawText);
}

function requireString(obj: JsonObject, key: string, where: string, rawText: string, opts: { nonEmpty?: boolean } = {}): string {
  const v = obj[key];
  if (!isString(v)) fail(`${where}.${key}: expected a string, got ${describe(v)}`, rawText);
  if (opts.nonEmpty && v.trim().length === 0) fail(`${where}.${key}: must not be empty`, rawText);
  return v;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'nothing';
  if (Array.isArray(v)) return 'an array';
  return typeof v;
}

/** Validate an unknown value as an Action with exact key checks. */
export function validateAction(v: unknown, rawText = ''): Action {
  if (!isJsonObject(v)) fail(`action: expected an object, got ${describe(v)}`, rawText);
  const kind = v['kind'];
  if (!isString(kind) || !(ACTION_KINDS as readonly string[]).includes(kind)) {
    fail(`action.kind: expected one of ${ACTION_KINDS.join(', ')}, got ${isString(kind) ? `"${kind}"` : describe(kind)}`, rawText);
  }
  switch (kind as ActionKind) {
    case 'read': {
      exactKeys(v, ['kind', 'paths'], [], 'action', rawText);
      const paths = v['paths'];
      if (!isStringArray(paths) || paths.length === 0) fail('action.paths: expected a non-empty array of strings', rawText);
      for (const p of paths) if (p.trim().length === 0) fail('action.paths: contains an empty path', rawText);
      return { kind: 'read', paths: [...paths] };
    }
    case 'edit': {
      exactKeys(v, ['kind', 'path', 'old', 'new'], [], 'action', rawText);
      const path = requireString(v, 'path', 'action', rawText, { nonEmpty: true });
      const old = requireString(v, 'old', 'action', rawText, { nonEmpty: true });
      const nu = requireString(v, 'new', 'action', rawText);
      if (old === nu) fail('action: old and new are identical', rawText);
      return { kind: 'edit', path, old, new: nu };
    }
    case 'write': {
      exactKeys(v, ['kind', 'path', 'content'], [], 'action', rawText);
      const path = requireString(v, 'path', 'action', rawText, { nonEmpty: true });
      const content = requireString(v, 'content', 'action', rawText);
      return { kind: 'write', path, content };
    }
    case 'patch': {
      exactKeys(v, ['kind', 'diff'], [], 'action', rawText);
      const diff = requireString(v, 'diff', 'action', rawText, { nonEmpty: true });
      return { kind: 'patch', diff };
    }
    case 'run': {
      exactKeys(v, ['kind', 'command'], ['timeoutMs'], 'action', rawText);
      const command = requireString(v, 'command', 'action', rawText, { nonEmpty: true });
      if ('timeoutMs' in v) {
        const t = v['timeoutMs'];
        if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) fail(`action.timeoutMs: expected a positive number, got ${describe(t)}`, rawText);
        return { kind: 'run', command, timeoutMs: Math.round(t) };
      }
      return { kind: 'run', command };
    }
    case 'done': {
      exactKeys(v, ['kind', 'summary'], [], 'action', rawText);
      const summary = requireString(v, 'summary', 'action', rawText, { nonEmpty: true });
      return { kind: 'done', summary };
    }
  }
}

export function validatePlanDraft(v: unknown, rawText = ''): PlanDraft {
  if (!isJsonObject(v)) fail(`plan: expected an object, got ${describe(v)}`, rawText);
  exactKeys(v, ['done', 'remaining', 'openProblems'], [], 'plan', rawText);
  const out: Record<string, string[]> = {};
  for (const k of ['done', 'remaining', 'openProblems'] as const) {
    const arr = v[k];
    if (!isStringArray(arr)) fail(`plan.${k}: expected an array of strings`, rawText);
    out[k] = arr.map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return { done: out['done']!, remaining: out['remaining']!, openProblems: out['openProblems']! };
}

/** Validate the full { goal, action, plan } object. */
export function validateProposalInput(v: unknown, rawText: string): Omit<Proposal, 'rawText'> {
  if (!isJsonObject(v)) fail(`proposal: expected an object, got ${describe(v)}`, rawText);
  exactKeys(v, ['goal', 'action', 'plan'], [], 'proposal', rawText);
  const goal = requireString(v, 'goal', 'proposal', rawText, { nonEmpty: true });
  const action = validateAction(v['action'], rawText);
  const plan = validatePlanDraft(v['plan'], rawText);
  return { goal, action, plan };
}

const FENCE_RE = /```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;

/** The last fenced ```json block of `text`, or null. */
export function extractLastFencedJson(text: string): string | null {
  let last: string | null = null;
  for (const m of text.matchAll(FENCE_RE)) last = m[1] ?? null;
  return last;
}

/**
 * toolCalls[0].input when present (the forced tool call), else the last fenced json block in
 * the text (graceful degradation when a provider ignores tool_choice, §7).
 */
export function parseProposal(result: GenerateResult): Proposal {
  const tool = result.toolCalls[0];
  const rawText = tool ? (result.text.length > 0 ? `${result.text}\n${tool.rawJson}` : tool.rawJson) : result.text;
  let input: Json;
  if (tool) {
    if (tool.name !== PROPOSE_ACTION_TOOL_NAME) fail(`tool call "${tool.name}" is not ${PROPOSE_ACTION_TOOL_NAME}`, rawText);
    input = tool.input;
  } else {
    const block = extractLastFencedJson(result.text);
    if (block === null) fail('no tool call and no fenced json block in the reply', rawText);
    const parsed = parseJson(block);
    if (!parsed.ok) fail(`fenced json block does not parse: ${parsed.error}`, rawText);
    input = parsed.value;
  }
  const { goal, action, plan } = validateProposalInput(input, rawText);
  return { goal, action, plan, rawText };
}

function shortCommand(command: string): string {
  const oneLine = command.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine;
}

/** "edit src/a.py", "run pytest -q", "done" (§4 WindowEntry.action). */
export function summariseAction(a: Action): string {
  switch (a.kind) {
    case 'read':
      return `read ${a.paths.slice(0, 6).join(' ')}${a.paths.length > 6 ? ` (+${a.paths.length - 6} more)` : ''}`;
    case 'edit':
      return `edit ${a.path}`;
    case 'write':
      return `write ${a.path}`;
    case 'patch': {
      const paths = patchTouchedPaths(a.diff);
      return paths.length > 0 ? `patch ${paths.slice(0, 6).join(' ')}` : 'patch';
    }
    case 'run':
      return `run ${shortCommand(a.command)}`;
    case 'done':
      return 'done';
  }
}

/** Paths named on `---`/`+++` headers of a unified diff, -p1 stripped, deduplicated, /dev/null dropped. */
export function patchTouchedPaths(diff: string): string[] {
  const out: string[] = [];
  for (const line of diff.split('\n')) {
    const m = /^(?:---|\+\+\+) (?:"?)([^\t\n"]+)/.exec(line);
    if (!m || !m[1]) continue;
    let p = m[1].trim();
    if (p === '/dev/null') continue;
    if (/^[ab]\//.test(p)) p = p.slice(2);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** The last RAW_TEXT_TAIL_CHARS of a malformed reply, for the retry message. */
export function rawTextTail(rawText: string): string {
  return rawText.length <= RAW_TEXT_TAIL_CHARS ? rawText : rawText.slice(rawText.length - RAW_TEXT_TAIL_CHARS);
}
