/** Tool-call repair (docs/AGENT-LOOP-DESIGN.md §4.4, §6.4): names, JSON, aliases, coercion, validation, text-embedded calls, ids. */
import { describe, expect, it } from 'vitest';
import { assignIds, extractTextToolCalls, normaliseCall, normaliseWorkdir, repairJson, resolveToolName } from '../../../src/agent/repair.js';

const opts = { root: '/ws', cutOff: false, maxTokens: 16384 };

describe('tool names', () => {
  it.each([
    ['read_file', 'read_file'],
    ['READ_FILE', 'read_file'],
    ['Read', 'read_file'],
    ['view', 'read_file'],
    ['cat', 'read_file'],
    ['Write', 'write_file'],
    ['create_file', 'write_file'],
    ['Edit', 'edit_file'],
    ['str_replace', 'edit_file'],
    ['replace', 'edit_file'],
    ['search_replace', 'edit_file'],
    ['Bash', 'bash'],
    ['shell', 'bash'],
    ['run', 'bash'],
    ['run_command', 'bash'],
    ['execute_command', 'bash'],
    ['exec', 'bash'],
    ['Grep', 'grep'],
    ['search', 'grep'],
    ['search_files', 'grep'],
    ['rg', 'grep'],
    ['Glob', 'glob'],
    ['find_files', 'glob'],
    ['list_files', 'glob'],
    ['TodoWrite', 'todo_write'],
    ['update_plan', 'todo_write'],
    ['write_todos', 'todo_write'],
  ])('%s → %s', (alias, tool) => {
    expect(resolveToolName(alias)).toBe(tool);
  });

  it('an unknown name is UNKNOWN_TOOL with the list of tools', () => {
    const n = normaliseCall({ name: 'browse_web', input: { url: 'x' }, rawJson: '' }, opts);
    expect(n.name).toBe('invalid');
    expect(n.error).toBe('UNKNOWN TOOL browse_web. Available: read_file, write_file, edit_file, bash, grep, glob, todo_write.');
  });
});

describe('JSON repair', () => {
  it.each([
    ['a code fence', '```json\n{"path": "a.py"}\n```', { path: 'a.py' }],
    ['prose before the object', 'Here you go: {"path": "a.py"}', { path: 'a.py' }],
    ['a trailing comma', '{"path": "a.py", "limit": 5,}', { path: 'a.py', limit: 5 }],
    ['trailing commas in arrays', '{"todos": [{"content": "x", "status": "pending"},]}', { todos: [{ content: 'x', status: 'pending' }] }],
    ['raw newlines inside a string', '{"content": "line one\nline two"}', { content: 'line one\nline two' }],
    ['a raw tab inside a string', '{"content": "a\tb"}', { content: 'a\tb' }],
    ['an unclosed string and object', '{"command": "npm test', { command: 'npm test' }],
    ['unbalanced brackets', '{"todos": [{"content": "x", "status": "pending"}', { todos: [{ content: 'x', status: 'pending' }] }],
    ['unquoted keys', '{path: "a.py", offset: 3}', { path: 'a.py', offset: 3 }],
    ['Python literals', '{"replace_all": True, "x": None}', { replace_all: true, x: null }],
    ['a dangling key', '{"path": "a.py", "limit":', { path: 'a.py', limit: null }],
    ['trailing prose after the object', '{"path": "a.py"} and that is it', { path: 'a.py' }],
  ])('%s', (_name, text, expected) => {
    expect(repairJson(text)).toEqual(expected);
  });

  it('returns null for text that holds no JSON', () => {
    expect(repairJson('no json here')).toBeNull();
    expect(repairJson('')).toBeNull();
  });

  it('repairs a call whose adapter parse failed', () => {
    const n = normaliseCall({ name: 'read_file', input: null, rawJson: '{"path": "src/a.py",}' }, opts);
    expect(n.error).toBeNull();
    expect(n.args).toEqual({ path: 'src/a.py' });
  });

  it('an unrepairable argument string is INVALID_ARGUMENTS with the signature', () => {
    const n = normaliseCall({ name: 'read_file', input: null, rawJson: 'not json at all' }, opts);
    expect(n.error).toBe('INVALID ARGUMENTS for read_file: the arguments are not valid JSON. Expected {path: string, offset?: integer, limit?: integer}.');
  });

  it('the last call of a reply cut off at the output limit is TRUNCATED_CALL', () => {
    const n = normaliseCall({ name: 'write_file', input: null, rawJson: 'garbage' }, { ...opts, cutOff: true });
    expect(n.error).toBe('Your reply was cut off at the output limit (16384 tokens) while writing this call. Split large changes into several smaller edit_file calls, or write a large file in parts.');
  });

  it.each([
    ['a write cut mid-content', 'write_file', '{"path":"big.py","content":"def f():\n    return 1\n\ndef g():\n    ret'],
    ['a command cut mid-string', 'bash', '{"command": "rm -rf build/tmp/cache && echo do'],
    ['an edit cut after its old_string', 'edit_file', '{"path": "a.py", "old_string": "x = 1", "new_string": "x = 2\ny ='],
  ])('a cut-off call whose prefix JSON repair could close is still TRUNCATED_CALL, never run: %s', (_why, name, rawJson) => {
    const n = normaliseCall({ name, input: null, rawJson }, { ...opts, cutOff: true });
    expect(n.error).toMatch(/^Your reply was cut off at the output limit \(16384 tokens\)/);
    expect(n.args).toEqual({});
    expect(n.replayInput).toEqual({});
    // the same prefix in a reply that was not cut is repaired as usual
    expect(normaliseCall({ name, input: null, rawJson }, opts).error).toBeNull();
  });

  it('a cut-off call that parsed but lacks its required arguments is TRUNCATED_CALL, not INVALID ARGUMENTS', () => {
    // openai-compat adapters send `{}` when the reply was cut before the first argument
    const n = normaliseCall({ name: 'write_file', input: {}, rawJson: '{}' }, { ...opts, cutOff: true });
    expect(n.error).toMatch(/^Your reply was cut off at the output limit/);
    expect(normaliseCall({ name: 'write_file', input: {}, rawJson: '{}' }, opts).error).toMatch(/^INVALID ARGUMENTS for write_file: path is required/);
  });

  it('a cut-off reply whose last call parsed completely runs as usual', () => {
    const n = normaliseCall({ name: 'read_file', input: { path: 'a.py' }, rawJson: '{"path": "a.py"}' }, { ...opts, cutOff: true });
    expect(n.error).toBeNull();
    expect(n.args).toEqual({ path: 'a.py' });
  });
});

describe('argument aliases, coercion and unknown keys', () => {
  it.each([
    ['file_path', 'read_file', { file_path: 'a.py' }, { path: 'a.py' }],
    ['filePath', 'read_file', { filePath: 'a.py' }, { path: 'a.py' }],
    ['filename', 'write_file', { filename: 'a.py', content: 'x' }, { path: 'a.py', content: 'x' }],
    ['file', 'read_file', { file: 'a.py' }, { path: 'a.py' }],
    ['old/new', 'edit_file', { path: 'a', old: 'x', new: 'y' }, { path: 'a', old_string: 'x', new_string: 'y' }],
    ['oldString/newString', 'edit_file', { path: 'a', oldString: 'x', newString: 'y' }, { path: 'a', old_string: 'x', new_string: 'y' }],
    ['old_str/new_str', 'edit_file', { path: 'a', old_str: 'x', new_str: 'y' }, { path: 'a', old_string: 'x', new_string: 'y' }],
    ['oldText/newText', 'edit_file', { path: 'a', oldText: 'x', newText: 'y' }, { path: 'a', old_string: 'x', new_string: 'y' }],
    ['replaceAll', 'edit_file', { path: 'a', old_string: 'x', new_string: 'y', replaceAll: true }, { path: 'a', old_string: 'x', new_string: 'y', replace_all: true }],
    ['cmd', 'bash', { cmd: 'ls' }, { command: 'ls' }],
    ['cwd', 'bash', { command: 'ls', cwd: 'src' }, { command: 'ls', workdir: 'src' }],
    ['dir', 'bash', { command: 'ls', dir: 'src' }, { command: 'ls', workdir: 'src' }],
    ['directory', 'bash', { command: 'ls', directory: 'src' }, { command: 'ls', workdir: 'src' }],
    ['timeout in seconds', 'bash', { command: 'ls', timeout: 30 }, { command: 'ls', timeout_ms: 30000 }],
    ['timeout in ms', 'bash', { command: 'ls', timeout: 45000 }, { command: 'ls', timeout_ms: 45000 }],
    ['query', 'grep', { query: 'foo' }, { pattern: 'foo' }],
    ['regex', 'grep', { regex: 'foo' }, { pattern: 'foo' }],
    ['include', 'grep', { pattern: 'foo', include: '*.ts' }, { pattern: 'foo', glob: '*.ts' }],
  ])('%s', (_name, tool, input, args) => {
    const n = normaliseCall({ name: tool, input, rawJson: '' }, opts);
    expect(n.error).toBeNull();
    expect(n.args).toEqual(args);
  });

  it('coerces stringly numbers and booleans (Gemini sends them quoted)', () => {
    const n = normaliseCall({ name: 'grep', input: { pattern: 'x', context: '2', case_insensitive: 'true' }, rawJson: '' }, opts);
    expect(n.args).toEqual({ pattern: 'x', context: 2, case_insensitive: true });
  });

  it('fits display-only and bounded fields instead of rejecting the call', () => {
    const long = 'Run the whole unit test suite for the parser package and report which tests fail and why';
    const bash = normaliseCall({ name: 'bash', input: { command: 'npm test', description: long, timeout_ms: 900000 }, rawJson: '' }, opts);
    expect(bash.error).toBeNull();
    expect(bash.args).toEqual({ command: 'npm test', description: long.slice(0, 80), timeout_ms: 600000 });
    const read = normaliseCall({ name: 'read_file', input: { path: 'a.py', limit: 5000 }, rawJson: '' }, opts);
    expect(read.args).toEqual({ path: 'a.py', limit: 2000 });
    const todo = normaliseCall({ name: 'todo_write', input: { todos: [{ content: 'x'.repeat(250), status: 'pending' }] }, rawJson: '' }, opts);
    expect(todo.error).toBeNull();
    expect(todo.args).toEqual({ todos: [{ content: 'x'.repeat(200), status: 'pending' }] });
    // a value below its minimum is still an error
    expect(normaliseCall({ name: 'read_file', input: { path: 'a.py', limit: 0 }, rawJson: '' }, opts).error).toMatch(/limit must be at least 1/);
  });

  it('drops unknown keys and reports them', () => {
    const n = normaliseCall({ name: 'edit_file', input: { command: 'str_replace', path: 'a', old_string: 'x', new_string: 'y' }, rawJson: '' }, opts);
    expect(n.error).toBeNull();
    expect(n.ignored).toEqual(['command']);
    expect(n.args).toEqual({ path: 'a', old_string: 'x', new_string: 'y' });
  });

  it('read_file with paths reads each path in one call (at most 8)', () => {
    const n = normaliseCall({ name: 'read_file', input: { paths: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }, rawJson: '' }, opts);
    expect(n.error).toBeNull();
    expect(n.paths).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });

  it('workdir must stay inside the workspace; the root is dropped', () => {
    expect(normaliseWorkdir('/ws', 'pkg/core')).toEqual({ ok: true, value: 'pkg/core' });
    expect(normaliseWorkdir('/ws', '/ws/pkg')).toEqual({ ok: true, value: 'pkg' });
    expect(normaliseWorkdir('/ws', '.')).toEqual({ ok: true, value: null });
    expect(normaliseWorkdir('/ws', '../other').ok).toBe(false);
    const bad = normaliseCall({ name: 'bash', input: { command: 'ls', cwd: '/etc' }, rawJson: '' }, opts);
    expect(bad.error).toBe('INVALID ARGUMENTS for bash: workdir "/etc" is outside the workspace. Expected {command: string, workdir?: string, timeout_ms?: integer, description?: string}.');
    const root = normaliseCall({ name: 'bash', input: { command: 'ls', workdir: '.' }, rawJson: '' }, opts);
    expect(root.args).toEqual({ command: 'ls' });
  });

  it('an absolute path inside the workspace becomes workspace-relative', () => {
    expect(normaliseCall({ name: 'read_file', input: { path: '/ws/src/a.py' }, rawJson: '' }, opts).args).toEqual({ path: 'src/a.py' });
  });
});

describe('calls written into the prose', () => {
  it('extracts GLM XML calls and removes them from the prose', () => {
    const text = 'Let me look.\n<tool_call>read_file\n<arg_key>path</arg_key>\n<arg_value>src/a.py</arg_value>\n</tool_call>\n<tool_call>bash<arg_key>command</arg_key><arg_value>ls -la</arg_value></tool_call>';
    const x = extractTextToolCalls(text);
    expect(x.calls.map((c) => [c.name, c.input])).toEqual([
      ['read_file', { path: 'src/a.py' }],
      ['bash', { command: 'ls -la' }],
    ]);
    expect(x.prose).toBe('Let me look.');
  });

  it('extracts Qwen function calls, with and without a tool_call wrapper', () => {
    const text = 'Reading.\n<tool_call>\n<function=read_file>\n<parameter=path>\nsrc/a.py\n</parameter>\n<parameter=offset>\n10\n</parameter>\n</function>\n</tool_call>\n<function=glob><parameter=pattern>**/*.ts</parameter></function>';
    const x = extractTextToolCalls(text);
    expect(x.calls.map((c) => [c.name, c.input])).toEqual([
      ['read_file', { path: 'src/a.py', offset: '10' }],
      ['glob', { pattern: '**/*.ts' }],
    ]);
    expect(x.prose).toBe('Reading.');
    // the stringly offset is coerced when the call is normalised
    expect(normaliseCall(x.calls[0]!, opts).args).toEqual({ path: 'src/a.py', offset: 10 });
  });

  it('extracts a fenced JSON call or array of calls, and leaves an ordinary JSON block alone', () => {
    const one = extractTextToolCalls('Now:\n```json\n{"name": "bash", "arguments": {"command": "npm test"}}\n```');
    expect(one.calls.map((c) => [c.name, c.input])).toEqual([['bash', { command: 'npm test' }]]);
    expect(one.prose).toBe('Now:');
    const many = extractTextToolCalls('```json\n[{"name": "read_file", "arguments": "{\\"path\\": \\"a\\"}"}, {"name": "glob", "parameters": {"pattern": "*.md"}}]\n```');
    expect(many.calls.map((c) => [c.name, c.input])).toEqual([
      ['read_file', { path: 'a' }],
      ['glob', { pattern: '*.md' }],
    ]);
    // a manifest whose name happens to be a tool alias is not a call: a call carries its arguments
    const manifest = extractTextToolCalls('Here is the manifest:\n```json\n{"name": "search", "version": "2.1.0"}\n```');
    expect(manifest.calls).toEqual([]);
    const data = extractTextToolCalls('The config is:\n```json\n{"name": "my-package", "version": "1.0.0"}\n```');
    expect(data.calls).toEqual([]);
    expect(data.prose).toBe('The config is:\n```json\n{"name": "my-package", "version": "1.0.0"}\n```');
  });

  it('GLM wins over Qwen when both appear (tried in order)', () => {
    const x = extractTextToolCalls('<tool_call>glob<arg_key>pattern</arg_key><arg_value>*.py</arg_value></tool_call> <function=bash><parameter=command>ls</parameter></function>');
    expect(x.calls.map((c) => c.name)).toEqual(['glob']);
  });
});

describe('call ids', () => {
  it('keeps a non-empty unused provider id, and rewrites empty and repeated ones consistently', () => {
    const used = new Set(['call_old']);
    const ids = assignIds(
      [
        { id: 'toolu_1', name: 'a', input: {}, rawJson: '' },
        { id: '', name: 'b', input: {}, rawJson: '' },
        { id: 'toolu_1', name: 'c', input: {}, rawJson: '' },
        { name: 'd', input: {}, rawJson: '' },
        { id: 'call_old', name: 'e', input: {}, rawJson: '' },
      ],
      4,
      used,
    );
    expect(ids).toEqual(['toolu_1', 'call_4_1', 'call_4_2', 'call_4_3', 'call_4_4']);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...used]).toEqual(expect.arrayContaining(ids));
  });

  it('a synthetic id already used (a carried transcript) gets a suffix', () => {
    const ids = assignIds([{ name: 'a', input: {}, rawJson: '' }], 1, new Set(['call_1_0']));
    expect(ids).toEqual(['call_1_0_2']);
  });
});
