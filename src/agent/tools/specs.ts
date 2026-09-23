/**
 * The agent's seven tools (docs/AGENT-LOOP-DESIGN.md §4.1, §4.2): the exact descriptions and JSON schemas the model
 * sees, the per-role tool list, and the one validator every call passes before it runs (§4.4 step 5).
 *
 * Every schema is a flat object with `additionalProperties: false` and `required` listed before `properties`
 * (ForgeCode's flattening lowered tool-call error rates). The list is fixed at run start and identical on every
 * turn, so the provider's prompt cache holds.
 */
import type { AgentToolName, Json, JsonObject, ToolSpec } from '../../core/types.js';

export const AGENT_TOOL_NAMES: readonly AgentToolName[] = ['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'todo_write'];

/** a research child (`orchestration.role === 'research'`) may read, search, plan and run read-only-classified commands (§4.1) */
export const RESEARCH_TOOL_NAMES: readonly AgentToolName[] = ['read_file', 'grep', 'glob', 'bash', 'todo_write'];

export function isAgentToolName(s: string): s is AgentToolName {
  return (AGENT_TOOL_NAMES as readonly string[]).includes(s);
}

/** Tools that never touch the workspace; `bash` is read-only only when the classifier proves it (§12). */
export const READ_ONLY_TOOLS: ReadonlySet<AgentToolName> = new Set(['read_file', 'grep', 'glob', 'todo_write']);

const str = (description: string, extra: JsonObject = {}): JsonObject => ({ type: 'string', ...extra, description });
const int = (description: string, extra: JsonObject): JsonObject => ({ type: 'integer', ...extra, description });
const bool = (description: string): JsonObject => ({ type: 'boolean', description });

function object(required: string[], properties: JsonObject): JsonObject {
  return { type: 'object', additionalProperties: false, required, properties };
}

export const TOOL_SPECS: Readonly<Record<AgentToolName, ToolSpec>> = {
  read_file: {
    name: 'read_file',
    description:
      'Read a text file from the workspace. Returns numbered lines (`   12\\t<line>`). Use offset and limit for large files. Also reads `jevcode:outputs/step-N.txt` paths the harness gives you.',
    inputSchema: object(['path'], {
      path: str('Workspace-relative path, or a jevcode:outputs/step-N.txt path.'),
      offset: int('1-based first line to return. Default 1.', { minimum: 1 }),
      limit: int('Number of lines. Default 2000.', { minimum: 1, maximum: 2000 }),
    }),
  },
  write_file: {
    name: 'write_file',
    description: 'Create a file or replace its whole content. Prefer edit_file for changes to an existing file.',
    inputSchema: object(['path', 'content'], {
      path: str('Workspace-relative path. Parent directories are created.'),
      content: str("The complete file content. No placeholders such as '... rest unchanged'."),
    }),
  },
  edit_file: {
    name: 'edit_file',
    description:
      'Replace text in a file. old_string must match the file exactly (copy it from read_file without the line-number prefix) and must be unique unless replace_all is true. Include enough surrounding lines to make it unique.',
    inputSchema: object(['path', 'old_string', 'new_string'], {
      path: str('Workspace-relative path of an existing file.'),
      old_string: str('The exact text to replace.'),
      new_string: str('The replacement text. Must differ from old_string.'),
      replace_all: bool('Replace every occurrence. Default false.'),
    }),
  },
  bash: {
    name: 'bash',
    description:
      'Run a non-interactive shell command (sh -c, a fresh shell each time; use workdir instead of cd). Default timeout 120 s, maximum 600 s. No editors, pagers, prompts or servers that never exit. Use $TMPDIR for scratch files.',
    inputSchema: object(['command'], {
      command: str('The shell command.'),
      workdir: str('Workspace-relative directory to run in. Default: the workspace root.'),
      timeout_ms: int('Timeout in milliseconds. Default 120000.', { minimum: 1000, maximum: 600000 }),
      description: str('Five to ten words on what the command does, shown to the user.', { maxLength: 80 }),
    }),
  },
  grep: {
    name: 'grep',
    description:
      'Search file contents with a regular expression (ripgrep syntax). Returns `path:line: text` lines. Searches only files the workspace lists (no secrets, no ignored or binary files).',
    inputSchema: object(['pattern'], {
      pattern: str('Regular expression.'),
      path: str('Directory or file to search. Default: the workspace root.'),
      glob: str('Only files matching this glob, e.g. "*.ts" or "src/**/*.py".'),
      case_insensitive: bool('Default false.'),
      context: int('Lines of context around each match. Default 0.', { minimum: 0, maximum: 5 }),
      max_results: int('Maximum matching lines. Default 100.', { minimum: 1, maximum: 500 }),
    }),
  },
  glob: {
    name: 'glob',
    description: 'List workspace files whose path matches a glob pattern (`**`, `*`, `?`, `{a,b}`).',
    inputSchema: object(['pattern'], {
      pattern: str('Glob, e.g. "src/**/*.test.ts".'),
      path: str('Directory to search in. Default: the workspace root.'),
    }),
  },
  todo_write: {
    name: 'todo_write',
    description:
      'Record your plan for multi-step work. Send the whole list each time. Keep exactly one item in_progress while you work; mark items completed as soon as they are done.',
    inputSchema: object(['todos'], {
      todos: {
        type: 'array',
        maxItems: 30,
        items: object(['content', 'status'], {
          content: { type: 'string', maxLength: 200 },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
        }),
      },
    }),
  },
};

/** The tool list of a run: fixed at run start (§4.1). */
export function toolsFor(role: 'research' | 'default'): ToolSpec[] {
  const names = role === 'research' ? RESEARCH_TOOL_NAMES : AGENT_TOOL_NAMES;
  return names.map((n) => TOOL_SPECS[n]);
}

// ---------------------------------------------------------------------------------------
// Schema reading and validation (the subset the seven schemas use)
// ---------------------------------------------------------------------------------------

function asObject(v: Json | undefined): JsonObject | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : null;
}

function schemaProps(schema: JsonObject): JsonObject {
  return asObject(schema['properties']) ?? {};
}

function schemaRequired(schema: JsonObject): string[] {
  const r = schema['required'];
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : [];
}

function typeWord(schema: JsonObject): string {
  const t = schema['type'];
  if (t === 'array') {
    const items = asObject(schema['items']);
    return items === null ? '[...]' : `[${typeWord(items)}]`;
  }
  if (t === 'object') {
    const req = new Set(schemaRequired(schema));
    const parts = Object.entries(schemaProps(schema)).map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${typeWord(asObject(v) ?? {})}`);
    return `{${parts.join(', ')}}`;
  }
  const e = schema['enum'];
  if (Array.isArray(e)) return e.map((x) => JSON.stringify(x)).join('|');
  return typeof t === 'string' ? t : 'value';
}

/** `{path: string, old_string: string, new_string: string, replace_all?: boolean}` — the `Expected …` of INVALID_ARGUMENTS (§5.4) */
export function signatureOf(name: AgentToolName): string {
  return typeWord(TOOL_SPECS[name].inputSchema);
}

/** The known argument names of a tool. */
export function argNames(name: AgentToolName): string[] {
  return Object.keys(schemaProps(TOOL_SPECS[name].inputSchema));
}

/** The schema of one argument, or null. */
export function argSchema(name: AgentToolName, arg: string): JsonObject | null {
  return asObject(schemaProps(TOOL_SPECS[name].inputSchema)[arg]);
}

function checkValue(v: Json, schema: JsonObject, where: string): string | null {
  const t = schema['type'];
  if (t === 'string') {
    if (typeof v !== 'string') return `${where} must be a string`;
    const max = schema['maxLength'];
    if (typeof max === 'number' && v.length > max) return `${where} is longer than ${max} characters`;
    const e = schema['enum'];
    if (Array.isArray(e) && !e.includes(v)) return `${where} must be one of ${e.map((x) => JSON.stringify(x)).join(', ')}`;
    return null;
  }
  if (t === 'integer') {
    if (typeof v !== 'number' || !Number.isInteger(v)) return `${where} must be an integer`;
    const min = schema['minimum'];
    const max = schema['maximum'];
    if (typeof min === 'number' && v < min) return `${where} must be at least ${min}`;
    if (typeof max === 'number' && v > max) return `${where} must be at most ${max}`;
    return null;
  }
  if (t === 'boolean') return typeof v === 'boolean' ? null : `${where} must be true or false`;
  if (t === 'array') {
    if (!Array.isArray(v)) return `${where} must be an array`;
    const max = schema['maxItems'];
    if (typeof max === 'number' && v.length > max) return `${where} has more than ${max} items`;
    const items = asObject(schema['items']);
    if (items === null) return null;
    for (const [i, item] of v.entries()) {
      const problem = checkValue(item, items, `${where}[${i}]`);
      if (problem !== null) return problem;
    }
    return null;
  }
  if (t === 'object') {
    const o = asObject(v);
    if (o === null) return `${where} must be an object`;
    return checkObject(o, schema, where);
  }
  return null;
}

function checkObject(o: JsonObject, schema: JsonObject, where: string): string | null {
  const props = schemaProps(schema);
  for (const req of schemaRequired(schema)) {
    if (!(req in o)) return `${where === '' ? '' : `${where}.`}${req} is required`;
  }
  for (const [k, v] of Object.entries(o)) {
    const s = asObject(props[k]);
    const at = where === '' ? k : `${where}.${k}`;
    if (s === null) return `${at} is not a known argument`;
    const problem = checkValue(v, s, at);
    if (problem !== null) return problem;
  }
  return null;
}

/** Validate a call's (already normalised) arguments against its schema: types, required, enum and bounds. Null = valid. */
export function validateArgs(name: AgentToolName, input: JsonObject): string | null {
  return checkObject(input, TOOL_SPECS[name].inputSchema, '');
}
