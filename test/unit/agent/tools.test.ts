/** The read-only tools and their result formats (docs/AGENT-LOOP-DESIGN.md §4.3, §4.6-§4.8, §7.2). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { syntaxCheck } from '../../../src/agent/tools/check.js';
import { bashStatusLine, renderBash } from '../../../src/agent/tools/format.js';
import { parseAgentOutputRef, runReadFile, type ReadHashes } from '../../../src/agent/tools/read.js';
import { createRgProbe, globMatches, globToRegExp, runGlob, runGrep } from '../../../src/agent/tools/search.js';
import { runReadonlyBash } from '../../../src/agent/tools/shell.js';
import { planOf, todoWrite } from '../../../src/agent/tools/todo.js';
import { createAgentContext, execResult } from './helpers.js';

const hashes = (): ReadHashes => new Map();
const noRg = async (): Promise<boolean> => false;
const withRg = async (): Promise<boolean> => true;

describe('read_file', () => {
  const lines = Array.from({ length: 30 }, (_v, i) => `line ${i + 1}`).join('\n');

  it('numbers lines and pages with offset and limit, naming the next offset', async () => {
    const ctx = createAgentContext({ files: { 'a.txt': `${lines}\n` } });
    const r = await runReadFile(ctx, { path: 'a.txt', offset: 5, limit: 3 }, undefined, hashes());
    expect(r.text).toBe('a.txt (lines 5-7 of 30)\n     5\tline 5\n     6\tline 6\n     7\tline 7\n[showing lines 5-7 of 30; call read_file with offset=8 to continue]');
    expect(r.summary).toBe('read_file a.txt (lines 5-7)');
    expect(r.readPaths).toEqual(['a.txt']);
    const all = await runReadFile(ctx, { path: 'a.txt' }, undefined, hashes());
    expect(all.text.startsWith('a.txt (lines 1-30 of 30)\n     1\tline 1')).toBe(true);
    expect(all.text).not.toContain('[showing');
  });

  it('clips a long line and stops at the 40,000-char cap', async () => {
    const ctx = createAgentContext({ files: { 'long.txt': `${'x'.repeat(2500)}\nshort\n`, 'big.txt': Array.from({ length: 1500 }, () => 'y'.repeat(100)).join('\n') } });
    const long = await runReadFile(ctx, { path: 'long.txt' }, undefined, hashes());
    expect(long.text).toContain(`${'x'.repeat(2000)}… [line clipped]`);
    const big = await runReadFile(ctx, { path: 'big.txt' }, undefined, hashes());
    expect(big.text.length).toBeLessThanOrEqual(40_200);
    expect(big.text).toMatch(/\[showing lines 1-\d+ of 1500; call read_file with offset=\d+ to continue\]$/);
  });

  it('reports missing, secret, outside and binary files as ERROR lines, and an offset past the end', async () => {
    const ctx = createAgentContext({ files: { 'bin.dat': 'ab\u0000cd', 'a.txt': 'one\n' } });
    expect((await runReadFile(ctx, { path: 'nope.txt' }, undefined, hashes())).text).toBe('ERROR: nope.txt: no such file');
    expect((await runReadFile(ctx, { path: '.env' }, undefined, hashes())).text).toBe('ERROR: .env is a secret path and cannot be read');
    expect((await runReadFile(ctx, { path: '../etc/passwd' }, undefined, hashes())).text).toBe('ERROR: ../etc/passwd is outside the workspace');
    expect((await runReadFile(ctx, { path: 'bin.dat' }, undefined, hashes())).text).toBe('ERROR: bin.dat is binary');
    const past = await runReadFile(ctx, { path: 'a.txt', offset: 9 }, undefined, hashes());
    expect(past).toMatchObject({ ok: false, text: 'ERROR: offset 9 is past the end of a.txt (1 lines)' });
  });

  it('serves jevcode:outputs/step-N[-k].txt from the run directory, and nothing else', async () => {
    const ctx = createAgentContext();
    mkdirSync(join(ctx.runDir, 'outputs'), { recursive: true });
    writeFileSync(join(ctx.runDir, 'outputs', 'step-3-2.txt'), 'spilled\noutput\n');
    const r = await runReadFile(ctx, { path: 'jevcode:outputs/step-3-2.txt' }, undefined, hashes());
    expect(r.text).toBe('jevcode:outputs/step-3-2.txt (lines 1-2 of 2)\n     1\tspilled\n     2\toutput');
    expect(r.readPaths).toBeUndefined();
    expect(parseAgentOutputRef('jevcode:outputs/../../etc/passwd')).toBeNull();
    expect((await runReadFile(ctx, { path: 'jevcode:outputs/step-9.txt' }, undefined, hashes())).text).toMatch(/^ERROR: jevcode:outputs\/step-9\.txt: no such file/);
  });

  it('reads several paths in one call and records their hashes for the stale-read note', async () => {
    const ctx = createAgentContext({ files: { 'a.txt': 'A\n', 'b.txt': 'B\n' } });
    const h = hashes();
    const r = await runReadFile(ctx, { path: 'a.txt' }, ['a.txt', 'b.txt'], h);
    expect(r.text).toBe('a.txt (lines 1-1 of 1)\n     1\tA\n\nb.txt (lines 1-1 of 1)\n     1\tB');
    expect(r.readPaths).toEqual(['a.txt', 'b.txt']);
    expect([...h.keys()]).toEqual(['a.txt', 'b.txt']);
  });
});

describe('grep', () => {
  const files = { 'src/a.ts': 'const parseX = 1;\nexport function parseX2() {}\n', 'src/b.ts': 'no match\n', 'docs/x.md': 'parseX in docs\n' };

  it('scans the candidates with a JS RegExp when rg is absent', async () => {
    const ctx = createAgentContext({ files });
    const r = await runGrep(ctx, { pattern: 'parseX' }, noRg);
    expect(r.text).toBe('3 matches in 2 files (showing 3)\ndocs/x.md:1: parseX in docs\nsrc/a.ts:1: const parseX = 1;\nsrc/a.ts:2: export function parseX2() {}');
    expect(r.summary).toBe('grep "parseX" (3 matches)');
    const scoped = await runGrep(ctx, { pattern: 'parseX', path: 'src', glob: '*.ts', max_results: 1 }, noRg);
    expect(scoped.text.split('\n')[0]).toBe('2 matches in 1 files (showing 1)');
    expect(scoped.text).toContain('[results capped at 1; narrow with path or glob]');
    const context = await runGrep(ctx, { pattern: 'const', path: 'src', context: 1 }, noRg);
    expect(context.text).toBe('1 matches in 1 files (showing 1)\nsrc/a.ts:1: const parseX = 1;\nsrc/a.ts-2- export function parseX2() {}');
    expect((await runGrep(ctx, { pattern: 'zzz' }, noRg)).text).toBe('0 matches');
    const bad = await runGrep(ctx, { pattern: '(' }, noRg);
    expect(bad.ok).toBe(false);
    expect(bad.text).toMatch(/^ERROR: invalid regular expression: /);
  });

  it('runs rg through the sandbox and drops lines for paths the workspace does not list (secrets, ignored files)', async () => {
    const ctx = createAgentContext({
      files,
      sandbox: (cmd) => (cmd.startsWith('rg ') ? { exitCode: 0, stdout: 'src/a.ts\u00001:const parseX = 1;\n.env\u00001:TOKEN=parseX\n./docs/x.md\u00001:parseX in docs\n--\nsrc/a.ts\u00002-context line\n' } : { stdout: '' }),
    });
    const r = await runGrep(ctx, { pattern: "it's", glob: '*.ts', case_insensitive: true, context: 1 }, withRg);
    expect(ctx.sb.commands[0]).toBe("rg --null --line-number --no-heading --color never -i -C 1 --glob '*.ts' -e 'it'\\''s'");
    expect(r.text).toBe('2 matches in 2 files (showing 2)\nsrc/a.ts:1: const parseX = 1;\ndocs/x.md:1: parseX in docs\nsrc/a.ts-2- context line');
    expect(r.text).not.toContain('.env');
  });

  it('reports an rg regex error as an invalid regular expression', async () => {
    const ctx = createAgentContext({ files, sandbox: () => ({ exitCode: 2, stderr: 'rg: regex parse error:\n    (\n    ^\nerror: unclosed group\n' }) });
    const r = await runGrep(ctx, { pattern: '(' }, withRg);
    expect(r).toMatchObject({ ok: false, text: 'ERROR: invalid regular expression: error: unclosed group' });
  });

  it('probes rg once per run', async () => {
    const ctx = createAgentContext({ sandbox: (cmd) => (cmd === 'rg --version' ? { exitCode: 0, stdout: 'ripgrep 15.0.0' } : { stdout: '' }) });
    const probe = createRgProbe();
    expect(await probe(ctx)).toBe(true);
    expect(await probe(ctx)).toBe(true);
    expect(ctx.sb.commands.filter((c) => c === 'rg --version')).toHaveLength(1);
    const missing = createAgentContext({ sandbox: () => ({ exitCode: 127, stderr: 'rg: not found' }) });
    expect(await createRgProbe()(missing)).toBe(false);
  });
});

describe('glob', () => {
  it.each([
    ['src/**/*.test.ts', 'src/a/b/x.test.ts', true],
    ['src/**/*.test.ts', 'src/x.test.ts', true],
    ['src/**/*.test.ts', 'test/x.test.ts', false],
    ['*.ts', 'deep/dir/x.ts', true],
    ['src/*.ts', 'src/a/x.ts', false],
    ['{src,test}/*.py', 'test/t.py', true],
    ['file?.md', 'file1.md', true],
    ['[ab].txt', 'b.txt', true],
    ['[!ab].txt', 'c.txt', true],
  ])('%s matches %s: %s', (pattern, path, expected) => {
    expect(globMatches(globToRegExp(pattern), pattern, path)).toBe(expected);
  });

  it('lists matching candidates sorted, under a path, and 0 files as a success', async () => {
    const ctx = createAgentContext({ files: { 'src/b.ts': '', 'src/a.ts': '', 'src/deep/c.ts': '', 'README.md': '' } });
    expect((await runGlob(ctx, { pattern: '**/*.ts' })).text).toBe('3 files\nsrc/a.ts\nsrc/b.ts\nsrc/deep/c.ts');
    expect((await runGlob(ctx, { pattern: '*.ts', path: 'src/deep' })).text).toBe('1 files\nsrc/deep/c.ts');
    const none = await runGlob(ctx, { pattern: '*.rs' });
    expect(none).toMatchObject({ ok: true, text: '0 files', summary: 'glob *.rs (0 files)' });
  });
});

describe('todo_write and the plan', () => {
  it('maps completed to done and the rest to remaining, and counts the statuses', () => {
    const r = todoWrite([
      { content: 'read', status: 'completed' },
      { content: 'fix', status: 'in_progress' },
      { content: 'test', status: 'pending' },
    ]);
    expect(r).toMatchObject({ ok: true, text: 'OK: todo list updated (1 completed, 1 in progress, 1 pending)', summary: 'todo_write (1/3 done)' });
    if (!r.ok) throw new Error('expected ok');
    expect(planOf(r.todos)).toEqual({ done: ['read'], remaining: ['fix', 'test'], openProblems: [] });
  });

  it('refuses two items in progress', () => {
    expect(todoWrite([{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }])).toMatchObject({ ok: false, text: 'INVALID ARGUMENTS for todo_write: more than one item is in_progress' });
  });
});

describe('bash results', () => {
  it('status lines for exit, timeout and kill', () => {
    expect(bashStatusLine(execResult({ exitCode: 0, durationMs: 1234 }), null, null)).toBe('exit 0 · 1.2s');
    expect(bashStatusLine(execResult({ exitCode: 1, durationMs: 42_000 }), 'pkg', { passed: 3, failed: 1, errors: 0, skipped: 0 })).toBe('exit 1 · 42s · in pkg · tests: 3 passed, 1 failed, 0 errors');
    expect(bashStatusLine(execResult({ exitCode: null, killedBy: 'timeout', durationMs: 120_000 }), null, null)).toBe('timed out after 120s (raise timeout_ms up to 600000 or run a narrower command)');
    expect(bashStatusLine(execResult({ exitCode: null, killedBy: 'wall_time' }), null, null)).toBe("killed (the run's wall-time budget ran out)");
  });

  it('keeps 30k of a passing output inline, spills more as head 12k + tail 4k with a pointer', async () => {
    const spilled: string[] = [];
    const spill = async (t: string): Promise<string> => {
      spilled.push(t);
      return 'jevcode:outputs/step-4.txt';
    };
    const small = await renderBash(execResult({ exitCode: 0 }), 'fine\n', { workdir: null, tests: null, spill });
    expect(small.text).toBe('exit 0 · 0s\nfine\n');
    const big = 'a'.repeat(20_000) + 'b'.repeat(20_000);
    const r = await renderBash(execResult({ exitCode: 0 }), big, { workdir: null, tests: null, spill });
    expect(r.text).toContain(`${'a'.repeat(12_000)}\n[… 24000 chars omitted …]\n${'b'.repeat(4_000)}`);
    expect(r.text.endsWith('full output: jevcode:outputs/step-4.txt (40000 bytes) — read_file it with offset/limit or grep it')).toBe(true);
    expect(spilled).toEqual([big]);
  });

  it('keeps 10k of a failing output inline, and more of its tail (errors are at the end)', async () => {
    const out = 'h'.repeat(8_000) + 't'.repeat(8_000);
    const r = await renderBash(execResult({ exitCode: 2 }), out, { workdir: null, tests: null, spill: async () => null });
    expect(r.ok).toBe(false);
    expect(r.text).toContain(`${'h'.repeat(3_000)}\n[… 6000 chars omitted …]\n${'t'.repeat(7_000)}`);
    expect(r.text.endsWith('(the full output could not be saved)')).toBe(true);
  });

  it('runs a read-only command through the sandbox with its workdir and a clamped timeout', async () => {
    const ctx = createAgentContext({ sandbox: () => ({ exitCode: 0, stdout: 'a.ts\nb.ts\n' }), wallRemainingMs: 5_000 });
    const r = await runReadonlyBash(ctx, { command: 'ls', workdir: 'src', timeout_ms: 600_000 }, undefined);
    expect(ctx.sb.timeouts).toEqual([5_000]);
    expect(r).toMatchObject({ ok: true, summary: 'bash ls (exit 0)' });
    expect(r.text).toBe('exit 0 · 0s · in src\na.ts\nb.ts\n');
  });
});

describe('the post-write syntax check', () => {
  it('JSON: reports a new error only', async () => {
    const ctx = createAgentContext();
    expect(await syntaxCheck(ctx, 'c.json', '{"a": 1}', '{"a": }')).toHaveLength(1);
    expect(await syntaxCheck(ctx, 'c.json', '{"broken"', '{"still": broken')).toEqual([]);
    expect(await syntaxCheck(ctx, 'c.json', null, '{"ok": true}')).toEqual([]);
  });

  it('Python: ast.parse through the sandbox; a failure the old content shared, or a missing interpreter, reports nothing', async () => {
    let n = 0;
    const ctx = createAgentContext({
      sandbox: (cmd) => {
        n += 1;
        if (!cmd.startsWith('python3 -c')) return { stdout: '' };
        return cmd.includes('agent-check-') ? { exitCode: 0 } : { exitCode: 1, stderr: '  File "a.py", line 2\n    def f(:\n          ^\nSyntaxError: invalid syntax\n' };
      },
    });
    const lines = await syntaxCheck(ctx, 'a.py', 'def f():\n    pass\n', 'def f(:\n');
    expect(lines).toEqual(['  File "a.py", line 2', '    def f(:', '          ^', 'SyntaxError: invalid syntax']);
    expect(n).toBe(2);
    const shared = createAgentContext({ sandbox: () => ({ exitCode: 1, stderr: 'SyntaxError: bad' }) });
    expect(await syntaxCheck(shared, 'a.py', 'bad(', 'bad((')).toEqual([]);
    const missing = createAgentContext({ sandbox: () => ({ exitCode: 127, stderr: 'python3: not found' }) });
    expect(await syntaxCheck(missing, 'a.py', null, 'x(')).toEqual([]);
  });

  it('JavaScript: node --check for edits of existing files only', async () => {
    const ctx = createAgentContext({ sandbox: (cmd) => (cmd.includes('agent-check-') ? { exitCode: 0 } : { exitCode: 1, stderr: 'SyntaxError: Unexpected token' }) });
    expect(await syntaxCheck(ctx, 'a.js', 'let a = 1;\n', 'let a = ;\n')).toEqual(['SyntaxError: Unexpected token']);
    expect(await syntaxCheck(ctx, 'new.js', null, 'let a = ;\n')).toEqual([]);
    expect(ctx.sb.commands.filter((c) => c.startsWith('node --check'))).toHaveLength(2);
  });
});
