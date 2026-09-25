/** The seven tool specs (docs/AGENT-LOOP-DESIGN.md §4.1, §4.2): exact shapes, the validator, the per-role list. */
import { describe, expect, it } from 'vitest';
import type { JsonObject } from '../../../src/core/types.js';
import { AGENT_TOOL_NAMES, TOOL_SPECS, signatureOf, toolsFor, validateArgs } from '../../../src/agent/tools/specs.js';

describe('tool specs', () => {
  it('every schema is a flat object with additionalProperties false and required listed before properties', () => {
    for (const name of AGENT_TOOL_NAMES) {
      const s = TOOL_SPECS[name].inputSchema;
      expect(Object.keys(s)).toEqual(['type', 'additionalProperties', 'required', 'properties']);
      expect(s['type']).toBe('object');
      expect(s['additionalProperties']).toBe(false);
      for (const req of s['required'] as string[]) expect(Object.keys(s['properties'] as JsonObject)).toContain(req);
    }
  });

  it('carries the exact descriptions and bounds of §4.2', () => {
    expect(TOOL_SPECS.write_file.description).toBe('Create a file or replace its whole content. Prefer edit_file for changes to an existing file.');
    expect(TOOL_SPECS.glob.description).toBe('List workspace files whose path matches a glob pattern (`**`, `*`, `?`, `{a,b}`); a directory name lists the files under it. Binary files and files over 1 MiB are listed with a tag.');
    // the JS fallback (no rg on the sandbox PATH) is not ripgrep, and says so; file tools do not expand $TMPDIR
    expect(TOOL_SPECS.grep.description).toBe(
      'Search file contents with a regular expression (ripgrep syntax when rg is installed, otherwise JavaScript; a leading (?i) is honoured). Returns `path:line: text` lines. Searches only files the workspace lists (no secrets, no ignored or binary files; files over 1 MiB are named, not searched).',
    );
    expect(TOOL_SPECS.bash.description.endsWith('Use $TMPDIR for scratch files (from bash; file tools take workspace paths).')).toBe(true);
    const bash = TOOL_SPECS.bash.inputSchema['properties'] as Record<string, JsonObject>;
    expect(bash['timeout_ms']).toEqual({ type: 'integer', minimum: 1000, maximum: 600000, description: 'Timeout in milliseconds. Default 120000.' });
    expect(bash['description']!['maxLength']).toBe(80);
    const grep = TOOL_SPECS.grep.inputSchema['properties'] as Record<string, JsonObject>;
    expect(grep['context']).toMatchObject({ minimum: 0, maximum: 5 });
    expect(grep['max_results']).toMatchObject({ minimum: 1, maximum: 500 });
    const todo = TOOL_SPECS.todo_write.inputSchema['properties'] as Record<string, JsonObject>;
    expect(todo['todos']).toMatchObject({ type: 'array', maxItems: 30 });
  });

  it('validates the examples the descriptions give', () => {
    const examples: [keyof typeof TOOL_SPECS, JsonObject][] = [
      ['read_file', { path: 'src/a.ts', offset: 1, limit: 2000 }],
      ['read_file', { path: 'jevcode:outputs/step-3.txt' }],
      ['write_file', { path: 'src/new.ts', content: 'export {}\n' }],
      ['edit_file', { path: 'src/a.ts', old_string: 'a', new_string: 'b', replace_all: false }],
      ['bash', { command: 'npm test', workdir: 'packages/core', timeout_ms: 120000, description: 'run the core tests' }],
      ['grep', { pattern: 'parseX', path: 'src', glob: '*.ts', case_insensitive: true, context: 2, max_results: 50 }],
      ['glob', { pattern: 'src/**/*.test.ts', path: 'src' }],
      ['todo_write', { todos: [{ content: 'read the code', status: 'completed' }, { content: 'fix it', status: 'in_progress' }] }],
    ];
    for (const [name, input] of examples) expect(validateArgs(name, input), `${name} ${JSON.stringify(input)}`).toBeNull();
  });

  it('names the precise problem of an invalid call', () => {
    expect(validateArgs('read_file', {})).toBe('path is required');
    expect(validateArgs('read_file', { path: 'a', limit: 5000 })).toBe('limit must be at most 2000');
    expect(validateArgs('bash', { command: 'ls', timeout_ms: 10 })).toBe('timeout_ms must be at least 1000');
    expect(validateArgs('edit_file', { path: 'a', old_string: 'x', new_string: 1 })).toBe('new_string must be a string');
    expect(validateArgs('todo_write', { todos: [{ content: 'x', status: 'doing' }] })).toBe('todos[0].status must be one of "pending", "in_progress", "completed"');
    expect(validateArgs('grep', { pattern: 'x', extra: 1 })).toBe('extra is not a known argument');
  });

  it('spells the Expected signature of INVALID_ARGUMENTS from the schema', () => {
    expect(signatureOf('edit_file')).toBe('{path: string, old_string: string, new_string: string, replace_all?: boolean}');
    expect(signatureOf('todo_write')).toBe('{todos: [{content: string, status: "pending"|"in_progress"|"completed"}]}');
  });

  it('gives a research child read, search, plan and bash only, in a fixed order', () => {
    expect(toolsFor('default').map((t) => t.name)).toEqual(['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'todo_write']);
    expect(toolsFor('research').map((t) => t.name)).toEqual(['read_file', 'grep', 'glob', 'bash', 'todo_write']);
  });
});
