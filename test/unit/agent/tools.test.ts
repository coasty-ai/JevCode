/** The read-only tools and their result formats (docs/AGENT-LOOP-DESIGN.md §4.3, §4.6-§4.8, §7.2). */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentContext } from '../../../src/core/types.js';
import { syntaxCheck } from '../../../src/agent/tools/check.js';
import { bashStatusLine, renderBash } from '../../../src/agent/tools/format.js';
import { NOT_UTF8_NOTE, parseAgentOutputRef, runReadFile, type ReadHashes } from '../../../src/agent/tools/read.js';
import { RG_OUTPUT_CAP_LINE, SEARCH_VARIABLE_PATH_ERROR, WALK_CAP_LINE, compileGrepPattern, createRgProbe, globMatches, globToRegExp, runGlob, runGrep } from '../../../src/agent/tools/search.js';
import { runReadonlyBash } from '../../../src/agent/tools/shell.js';
import { VARIABLE_PATH_ERROR, rootNameHint } from '../../../src/agent/tools/result.js';
import { planOf, todoWrite } from '../../../src/agent/tools/todo.js';
import { AGENT_GREP_PARALLEL_READS } from '../../../src/agent/limits.js';
import { MAX_CANDIDATE_BYTES } from '../../../src/workspace/candidates.js';
import { createWorkspace, listSkipped } from '../../../src/workspace/files.js';
import { WALK_SKIP_DIRS } from '../../../src/workspace/skip-dirs.js';
import { tempWs, write, type TempWs } from '../workspace/helpers.js';
import { createAgentContext, execResult } from './helpers.js';

const hashes = (): ReadHashes => new Map();
const noRg = async (): Promise<boolean> => false;
const withRg = async (): Promise<boolean> => true;

let temps: TempWs[] = [];
afterEach(() => {
  for (const t of temps) t.cleanup();
  temps = [];
});

/** A context over a REAL workspace (createWorkspace on a temp dir, no git), for what only the real listing knows: skipped files, the walk cap. */
async function realContext(files: Record<string, string | Buffer>, o: { maxListEntries?: number } = {}): Promise<AgentContext> {
  const t = tempWs('jev-tools-');
  temps.push(t);
  for (const [rel, content] of Object.entries(files)) {
    if (typeof content === 'string') write(t.ws, rel, content);
    else {
      mkdirSync(join(t.ws, rel, '..'), { recursive: true });
      writeFileSync(join(t.ws, rel), content);
    }
  }
  const workspace = await createWorkspace(t.ws, t.runDir, { sandbox: t.sandbox, secretPaths: [], redact: (s) => s, ...o });
  return { ...createAgentContext({ root: t.ws }), workspace, sandbox: t.sandbox };
}

/** A fake-workspace context whose root is a real directory holding `bytes` on disk (the raw-encoding checks read it). */
function onDisk(bytes: Record<string, Buffer>): ReturnType<typeof createAgentContext> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jevcode-enc-')));
  const files: Record<string, string> = {};
  for (const [rel, b] of Object.entries(bytes)) {
    writeFileSync(join(root, rel), b);
    files[rel] = b.toString('utf8');
  }
  return createAgentContext({ root, files });
}

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

  it('a missing path that repeats the workspace folder name names the relative form (S6 live, 2026-09-23)', async () => {
    const ctx = createAgentContext({ files: { 'src/math.js': 'export const x = 1;\n' } });
    // the fake workspace's root is /ws: `ws/src/math.js` is the live run's `js-fix/src/math.js`
    const r = await runReadFile(ctx, { path: 'ws/src/math.js' }, undefined, hashes());
    expect(r.ok).toBe(false);
    expect(r.text).toBe('ERROR: ws/src/math.js: no such file (paths are relative to the workspace root ws: did you mean src/math.js?)');
    // any other missing path keeps the plain line
    expect((await runReadFile(ctx, { path: 'other/src/math.js' }, undefined, hashes())).text).toBe('ERROR: other/src/math.js: no such file');
  });

  it('gives no root-name hint where the workspace really has a top-level entry of that name', () => {
    const root = mkdtempSync(join(tmpdir(), 'jevcode-roothint-'));
    const name = root.split('/').pop()!;
    expect(rootNameHint(root, `${name}/a.py`)).toBe(` (paths are relative to the workspace root ${name}: did you mean a.py?)`);
    mkdirSync(join(root, name));
    expect(rootNameHint(root, `${name}/a.py`)).toBe('');
    expect(rootNameHint(root, 'a.py')).toBe('');
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

  it('refuses a path that asks for variable expansion: only bash expands $TMPDIR (a live run left a literal `$TMPDIR/` in the repo)', async () => {
    const ctx = createAgentContext({ files: { 'routes/$slug.tsx': 'x\n' } });
    for (const path of ['$TMPDIR/x', '${HOME}/a.txt', 'src/${name}.ts']) {
      const r = await runReadFile(ctx, { path }, undefined, hashes());
      expect(r).toMatchObject({ ok: false, text: VARIABLE_PATH_ERROR });
    }
    expect(VARIABLE_PATH_ERROR).toBe(`ERROR: file tools take workspace paths and do not expand variables such as $TMPDIR; create scratch files with bash (e.g. cat > "$TMPDIR/x" <<'EOF')`);
    // a `$` inside an ordinary name (a Remix / TanStack route) is a file name like any other
    expect((await runReadFile(ctx, { path: 'routes/$slug.tsx' }, undefined, hashes())).ok).toBe(true);
    expect(ctx.fs.reads).toEqual(['routes/$slug.tsx']);
  });

  it('labels a page of a file that is not UTF-8, and names a UTF-16 file instead of calling it binary', async () => {
    const latin1 = Buffer.from('caf\xe9 = 1\nna\xefve = 2\n', 'latin1');
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello\n', 'utf16le')]);
    const ctx = onDisk({ 'legacy.py': latin1, 'wide.txt': utf16, 'ok.txt': Buffer.from('café � literal\n', 'utf8'), 'bin.dat': Buffer.from([0x41, 0, 0x42]) });
    const page = await runReadFile(ctx, { path: 'legacy.py' }, undefined, hashes());
    expect(page.ok).toBe(true);
    expect(page.text.split('\n')[0]).toBe(`legacy.py (lines 1-2 of 2) ${NOT_UTF8_NOTE}`);
    expect(NOT_UTF8_NOTE).toBe('(not UTF-8: bytes that are not valid UTF-8 show as �; edit_file and write_file refuse this file)');
    expect(page.text).toContain('     1\tcaf� = 1');
    expect(await runReadFile(ctx, { path: 'wide.txt' }, undefined, hashes())).toMatchObject({ ok: false, text: 'ERROR: wide.txt is UTF-16 text; not shown — convert it with bash (iconv -f UTF-16 -t UTF-8)', summary: 'read_file wide.txt (UTF-16)' });
    // valid UTF-8 that happens to hold U+FFFD reads plainly; a binary stays binary
    expect((await runReadFile(ctx, { path: 'ok.txt' }, undefined, hashes())).text.split('\n')[0]).toBe('ok.txt (lines 1-1 of 1)');
    expect((await runReadFile(ctx, { path: 'bin.dat' }, undefined, hashes())).text).toBe('ERROR: bin.dat is binary');
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
    // --no-config: a user's RIPGREP_CONFIG_PATH cannot change the answer; --hidden with .git and the skipped directories
    // excluded LAST (a later glob wins in rg): the listing offers .github/ and .eslintrc.js; a 500-column preview keeps a
    // minified line from filling the cap
    const skipGlobs = [...WALK_SKIP_DIRS].filter((n) => n !== '.git').map((n) => `--glob '!${n}/'`).join(' ');
    expect(ctx.sb.commands[0]).toBe(`rg --no-config --null --line-number --no-heading --color never --hidden --max-columns 500 --max-columns-preview -i -C 1 --glob '*.ts' --glob '!.git' ${skipGlobs} --glob '!*.egg-info/' -e 'it'\\''s'`);
    expect(ctx.sb.commands[0]).toContain("--glob '!.git' --glob '!node_modules/' --glob '!.venv/'");
    expect(r.text).toBe('2 matches in 2 files (showing 2)\nsrc/a.ts:1: const parseX = 1;\ndocs/x.md:1: parseX in docs\nsrc/a.ts-2- context line');
    expect(r.text).not.toContain('.env');
  });

  it('rg: a CRLF file matches (`.` does not match its CR), and a line reaches the model cleaned then redacted', async () => {
    // an SGR inside the key: redacting before the clean would miss it (the fake redactor masks `sk-secret-…`)
    const stdout = 'src/a.ts\u00001:const parseX = 1;\r\nsrc/a.ts\u00002:// \u001b[31mparseX\u001b[0m warn\u0007\r\nsrc/b.ts\u00001:token = "sk-secret-\u001b[1mabc123\u001b[0m" parseX\n';
    const ctx = createAgentContext({ files: { ...files, 'src/b.ts': 'x\n' }, sandbox: (cmd) => (cmd.startsWith('rg ') ? { exitCode: 0, stdout } : { stdout: '' }) });
    const r = await runGrep(ctx, { pattern: 'parseX' }, withRg);
    expect(r.text).toBe('3 matches in 2 files (showing 3)\nsrc/a.ts:1: const parseX = 1;\nsrc/a.ts:2: // parseX warn\nsrc/b.ts:1: token = "[REDACTED]" parseX');
  });

  it('the JS scan shows a CRLF line without its CR and an escape sequence without its body', async () => {
    const ctx = createAgentContext({ files: { 'src/w.ts': 'const parseX = 1;\r\nlog("\u001b[32mparseX ok\u001b[0m");\r\n' } });
    const r = await runGrep(ctx, { pattern: 'parseX' }, noRg);
    expect(r.text).toBe('2 matches in 1 files (showing 2)\nsrc/w.ts:1: const parseX = 1;\nsrc/w.ts:2: log("parseX ok");');
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

  it('a probe cut short by a pause is not remembered: the next grep asks again', async () => {
    const ctx = createAgentContext({ sandbox: (cmd) => (cmd === 'rg --version' ? { exitCode: 0, stdout: 'ripgrep 14\n' } : {}) });
    const probe = createRgProbe();
    const paused = ctx.sb.run.bind(ctx.sb);
    ctx.sb.run = async (command, o) => {
      ctx.abort(new Error('human_pause'));
      return { ...(await paused(command, o)), killedBy: 'abort' as const, exitCode: null, ok: false };
    };
    expect(await probe(ctx)).toBe(false);
    ctx.sb.run = paused;
    const resumed = createAgentContext({ sandbox: (cmd) => (cmd === 'rg --version' ? { exitCode: 0, stdout: 'ripgrep 14\n' } : {}) });
    expect(await probe(resumed)).toBe(true);
    expect(resumed.sb.commands).toEqual(['rg --version']);
  });

  it('without rg, scans every listed file: a symbol in file 2,501 of 2,502 is found (the 2,000-file cap answered `0 matches`)', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 2502; i += 1) files[`pkg/m${String(i).padStart(4, '0')}.py`] = `x_${i} = ${i}\n`;
    files['pkg/m2500.py'] = 'def needleFunction():\n    return 1\n';
    const ctx = createAgentContext({ files });
    let inFlight = 0;
    let peak = 0;
    const read = ctx.fs.read.bind(ctx.fs);
    ctx.fs.read = async (path, max) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      try {
        return await read(path, max);
      } finally {
        inFlight -= 1;
      }
    };
    const r = await runGrep(ctx, { pattern: 'def needleFunction' }, noRg);
    expect(r.text).toBe('1 matches in 1 files (showing 1)\npkg/m2500.py:1: def needleFunction():');
    expect(ctx.fs.reads).toHaveLength(2502);
    expect(peak).toBe(AGENT_GREP_PARALLEL_READS);
  });

  it('a scan stopped by its 20 s budget says how far it got — also at 0 matches, which must never read as "absent"', async () => {
    const ctx = createAgentContext({ files: { 'a.txt': 'nothing\n', 'b.txt': 'nothing\n', 'c.txt': 'nothing\n' } });
    // the first reading fixes the deadline (15 s + 20 s); the first file is taken at 30 s, and every later check is past it
    let t = 0;
    ctx.now = () => (t += 15_000);
    const r = await runGrep(ctx, { pattern: 'needle' }, noRg);
    expect(r).toMatchObject({ ok: true, text: '0 matches\n[searched 1 of 3 files in 20 s; narrow with path or glob]' });
    // the run's own stop ends the scan the same way
    const stopped = createAgentContext({ files: { 'a.txt': 'needle\n', 'b.txt': 'needle\n' } });
    stopped.abort(new Error('human_pause'));
    expect((await runGrep(stopped, { pattern: 'needle' }, noRg)).text).toBe('0 matches\n[searched 0 of 2 files in 20 s; narrow with path or glob]');
  });

  it('without rg, a leading (?i) is the i flag and a pattern the u flag rejects is tried without it', async () => {
    const ctx = createAgentContext({ files: { 'a.ts': 'const NEEDLE = 1;\nreturn "x";\n' } });
    expect((await runGrep(ctx, { pattern: '(?i)needle' }, noRg)).text).toBe('1 matches in 1 files (showing 1)\na.ts:1: const NEEDLE = 1;');
    // `\"` is an identity escape: 'Invalid escape' under the u flag, a plain quote without it
    expect((await runGrep(ctx, { pattern: 'return \\"x\\"' }, noRg)).text).toBe('1 matches in 1 files (showing 1)\na.ts:2: return "x";');
    expect(compileGrepPattern('(?is)a.b', false)).toEqual(/a.b/isu);
    expect(compileGrepPattern('(', false)).toMatchObject({ error: expect.stringMatching(/Unterminated group/) });
    // a CRLF file: `$` anchors at the end of the line, and the shown text carries no \r
    const crlf = createAgentContext({ files: { 'w.bat': 'echo one\r\necho two\r\n' } });
    expect((await runGrep(crlf, { pattern: 'two$' }, noRg)).text).toBe('1 matches in 1 files (showing 1)\nw.bat:2: echo two');
  });

  it('names the files over 1 MiB it did not search, under the searched path and glob (both executors)', async () => {
    const big = `${'// filler line\n'.repeat(Math.ceil((MAX_CANDIDATE_BYTES + 1024) / 15))}export function needleFunction() {}\n`;
    const ctx = await realContext({ 'src/small.ts': 'const a = 1;\n', 'src/bundle.js': big, 'vendor/other.js': big, 'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]) });
    const skipped = await listSkipped(ctx.workspace);
    expect(skipped).toEqual({ walkCapped: false, files: [{ path: 'assets/logo.png', bytes: 6, reason: 'binary' }, { path: 'src/bundle.js', bytes: Buffer.byteLength(big), reason: 'large' }, { path: 'vendor/other.js', bytes: Buffer.byteLength(big), reason: 'large' }] });
    const js = await runGrep(ctx, { pattern: 'needleFunction' }, noRg);
    expect(js.text).toBe('0 matches\n[2 files over 1 MiB were not searched: src/bundle.js, vendor/other.js; search them with bash, e.g. grep -n]');
    expect((await runGrep(ctx, { pattern: 'needleFunction', path: 'src' }, noRg)).text).toBe('0 matches\n[1 file over 1 MiB was not searched: src/bundle.js; search it with bash, e.g. grep -n]');
    // a glob that excludes them, and a path that holds none, say nothing about them
    expect((await runGrep(ctx, { pattern: 'const', glob: '*.ts' }, noRg)).text).toBe('1 matches in 1 files (showing 1)\nsrc/small.ts:1: const a = 1;');
    const rg = { ...ctx, sandbox: { ...ctx.sandbox, run: async () => execResult({ exitCode: 1 }) } };
    expect((await runGrep(rg, { pattern: 'needleFunction', glob: '*.js' }, withRg)).text).toBe('0 matches\n[2 files over 1 MiB were not searched: src/bundle.js, vendor/other.js; search them with bash, e.g. grep -n]');
  });

  it('an rg that fails without a regex error and finds nothing (an older rg that rejects a flag) falls back to the JavaScript scan', async () => {
    const ctx = createAgentContext({ files, sandbox: () => ({ exitCode: 2, stderr: "error: Found argument '--max-columns-preview' which wasn't expected\n" }) });
    expect((await runGrep(ctx, { pattern: 'parseX', path: 'docs' }, withRg)).text).toBe('1 matches in 1 files (showing 1)\ndocs/x.md:1: parseX in docs');
  });

  it('rg skips the dependency and cache dirs no listed file is under, and keeps a tracked dist/ or egg-info searchable', async () => {
    const tracked = { 'src/a.ts': 'x\n', 'dist/bundle.js': 'x\n', 'lib/pkg.egg-info/PKG-INFO': 'x\n', 'scripts/build': 'x\n' };
    const ctx = createAgentContext({ files: tracked, sandbox: () => ({ exitCode: 1 }) });
    await runGrep(ctx, { pattern: 'x' }, withRg);
    const cmd = ctx.sb.commands[0]!;
    for (const g of ['!.venv/', '!node_modules/', '!.tox/', '!.next/', '!.cache/', '!build/']) expect(cmd).toContain(`--glob '${g}'`);
    // a directory a listed file passes through is searched; `!build/` (trailing slash) never hides the file scripts/build
    expect(cmd).not.toContain("'!dist/'");
    expect(cmd).not.toContain("'!*.egg-info/'");
  });

  it('an rg output cap filled by unlisted files (a .venv outside git) never answers a bare `0 matches`', async () => {
    const venv = Array.from({ length: 50 }, (_v, i) => `.venv/lib/pkg${i}/main.py\u00001:def main():`).join('\n');
    const ctx = createAgentContext({ files, sandbox: () => ({ exitCode: 0, stdout: `${venv}\n`, truncated: true }) });
    const r = await runGrep(ctx, { pattern: 'def main' }, withRg);
    expect(r.text).toBe(`0 matches\n${RG_OUTPUT_CAP_LINE}`);
  });

  it('rg exit 2 from files it could not open (the macOS read-deny on .env) is an answer, not a reason to re-scan in JS', async () => {
    const ctx = createAgentContext({ files, sandbox: () => ({ exitCode: 2, stdout: '', stderr: 'rg: .env: Operation not permitted (os error 1)\n' }) });
    expect((await runGrep(ctx, { pattern: 'nowhere' }, withRg)).text).toBe('0 matches');
    expect(ctx.fs.reads).toEqual([]);
    // a LISTED file it could not open is named, never silently absent
    const listed = createAgentContext({ files, sandbox: () => ({ exitCode: 2, stderr: 'rg: .env: Operation not permitted (os error 1)\nrg: ./src/b.ts: Permission denied (os error 13)\n' }) });
    expect((await runGrep(listed, { pattern: 'nowhere' }, withRg)).text).toBe('0 matches\n[rg could not read 1 listed file: src/b.ts]');
    expect(listed.fs.reads).toEqual([]);
    // a usage error mixed in still falls back
    const usage = createAgentContext({ files, sandbox: () => ({ exitCode: 2, stderr: "rg: .env: Operation not permitted (os error 1)\nerror: unexpected argument '--max-columns-preview' found\n" }) });
    expect((await runGrep(usage, { pattern: 'parseX', path: 'docs' }, withRg)).text).toBe('1 matches in 1 files (showing 1)\ndocs/x.md:1: parseX in docs');
  });

  it('refuses a path a shell would expand ($TMPDIR) instead of answering a silent `0 matches` or `0 files`', async () => {
    const ctx = createAgentContext({ files });
    expect(await runGrep(ctx, { pattern: 'parseX', path: '$TMPDIR' }, noRg)).toMatchObject({ ok: false, text: SEARCH_VARIABLE_PATH_ERROR });
    expect(await runGlob(ctx, { pattern: '*.ts', path: '${HOME}/src' })).toMatchObject({ ok: false, text: SEARCH_VARIABLE_PATH_ERROR });
    expect(ctx.sb.commands).toEqual([]);
  });

  it('rg stopped by its timeout says the results are partial, also at 0 matches', async () => {
    const ctx = createAgentContext({ files, sandbox: () => ({ exitCode: null, killedBy: 'timeout' }) });
    expect((await runGrep(ctx, { pattern: 'x' }, withRg)).text).toBe('0 matches\n[rg stopped after 20 s, so the results are partial; narrow with path or glob]');
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

  it('a path that repeats the root\'s own name searches the root (or below it), as bash and read_file do — never a silent `0 files` (S6 review)', async () => {
    const ctx = createAgentContext({ root: '/work/js-fix', files: { 'src/a.ts': 'const parseX = 1;\n', 'README.md': '' } });
    expect((await runGlob(ctx, { pattern: '**/*', path: 'js-fix' })).text).toBe('2 files\nREADME.md\nsrc/a.ts');
    expect((await runGlob(ctx, { pattern: '*.ts', path: 'js-fix/src' })).text).toBe('1 files\nsrc/a.ts');
    expect((await runGrep(ctx, { pattern: 'parseX', path: 'js-fix' }, async () => false)).text).toContain('src/a.ts');
    // a real directory with the root's name is searched as itself
    const nested = createAgentContext({ root: '/work/pkg', files: { 'pkg/x.ts': '', 'y.ts': '' } });
    expect((await runGlob(nested, { pattern: '*.ts', path: 'pkg' })).text).toBe('1 files\npkg/x.ts');
  });

  it('lists binary and large files with a tag instead of answering `0 files` (assets/logo.png, a 2.7 MB file)', async () => {
    const ctx = await realContext({ 'src/a.ts': 'a\n', 'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]), 'data/dump.sql': Buffer.alloc(Math.round(2.7 * 1024 * 1024), 0x61) });
    expect((await runGlob(ctx, { pattern: '**/*.png' })).text).toBe('1 files\nassets/logo.png (binary)');
    expect((await runGlob(ctx, { pattern: 'dump.sql' })).text).toBe('1 files\ndata/dump.sql (2.7 MB)');
    expect((await runGlob(ctx, { pattern: '**/*' })).text).toBe('3 files\nassets/logo.png (binary)\ndata/dump.sql (2.7 MB)\nsrc/a.ts');
  });

  it('a pattern without glob characters that names a directory lists the files under it, and says so', async () => {
    const ctx = createAgentContext({ files: { 'assets/icons/a.svg': '', 'assets/b.css': '', 'src/assets.ts': '', 'pkg/core/tests/t.py': '', 'pkg/web/tests/u.py': '' } });
    expect((await runGlob(ctx, { pattern: 'assets' })).text).toBe('assets is a directory; listing assets/**\n2 files\nassets/b.css\nassets/icons/a.svg');
    expect((await runGlob(ctx, { pattern: './assets/' })).text.split('\n')[0]).toBe('assets is a directory; listing assets/**');
    expect((await runGlob(ctx, { pattern: 'icons', path: 'assets' })).text).toBe('icons is a directory; listing icons/**\n1 files\nassets/icons/a.svg');
    expect((await runGlob(ctx, { pattern: 'tests' })).text).toBe('tests names directories below the top; listing **/tests/**\n2 files\npkg/core/tests/t.py\npkg/web/tests/u.py');
    // a name that matches a file is the file; a glob stays a glob; nothing of that name stays `0 files`
    expect((await runGlob(ctx, { pattern: 'assets.ts' })).text).toBe('1 files\nsrc/assets.ts');
    expect((await runGlob(ctx, { pattern: 'asset*' })).text).toBe('1 files\nsrc/assets.ts');
    expect((await runGlob(ctx, { pattern: 'nowhere' })).text).toBe('0 files');
  });

  it('both tools say when the workspace listing stopped at its cap', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i += 1) files[`f${String(i).padStart(2, '0')}.txt`] = 'needle\n';
    const ctx = await realContext(files, { maxListEntries: 5 });
    expect((await listSkipped(ctx.workspace)).walkCapped).toBe(true);
    expect((await runGlob(ctx, { pattern: '*.txt' })).text.split('\n').at(-1)).toBe(WALK_CAP_LINE);
    expect((await runGrep(ctx, { pattern: 'needle' }, noRg)).text.split('\n').at(-1)).toBe(WALK_CAP_LINE);
    // a fake workspace (not made by createWorkspace) has nothing skipped
    expect(await listSkipped(createAgentContext().workspace)).toEqual({ files: [], walkCapped: false });
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

  it('a checker that colours its error reaches the model as plain text (cleaned, then redacted)', async () => {
    const stderr = '\u001b[31m  File "a.py", line 1\u001b[0m\n\u001b[1mSyntaxError\u001b[0m: invalid syntax\r\n';
    const ctx = createAgentContext({ sandbox: (cmd) => (cmd.includes('agent-check-') ? { exitCode: 0 } : { exitCode: 1, stderr }) });
    expect(await syntaxCheck(ctx, 'a.py', 'x = 1\n', 'x = (\n')).toEqual(['  File "a.py", line 1', 'SyntaxError: invalid syntax']);
  });

  it('JavaScript: node --check for edits of existing files only', async () => {
    const ctx = createAgentContext({ sandbox: (cmd) => (cmd.includes('agent-check-') ? { exitCode: 0 } : { exitCode: 1, stderr: 'SyntaxError: Unexpected token' }) });
    expect(await syntaxCheck(ctx, 'a.js', 'let a = 1;\n', 'let a = ;\n')).toEqual(['SyntaxError: Unexpected token']);
    expect(await syntaxCheck(ctx, 'new.js', null, 'let a = ;\n')).toEqual([]);
    expect(ctx.sb.commands.filter((c) => c.startsWith('node --check'))).toHaveLength(2);
  });

  it('JavaScript: the pre-edit copy parses under the module type of the nearest package.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jevcode-check-'));
    mkdirSync(join(root, 'esm', 'src'), { recursive: true });
    mkdirSync(join(root, 'cjs'), { recursive: true });
    mkdirSync(join(root, 'plain'), { recursive: true });
    writeFileSync(join(root, 'esm', 'package.json'), '{"type": "module"}');
    writeFileSync(join(root, 'cjs', 'package.json'), '{"type": "commonjs"}');
    writeFileSync(join(root, 'plain', 'package.json'), '{"name": "plain"}');
    // an ESM file whose old content parses only as a module: the scratch copy must not be read as CommonJS
    const ctx = createAgentContext({ root, sandbox: (cmd) => (cmd.includes('agent-check-') && !cmd.includes('.mjs') ? { exitCode: 1, stderr: 'SyntaxError: Cannot use import statement outside a module' } : cmd.includes('agent-check-') ? { exitCode: 0 } : { exitCode: 1, stderr: 'SyntaxError: Unexpected token' }) });
    expect(await syntaxCheck(ctx, 'esm/src/a.js', 'import x from "y";\n', 'import x from ;\n')).toEqual(['SyntaxError: Unexpected token']);
    await syntaxCheck(ctx, 'cjs/b.js', 'module.exports = 1;\n', 'module.exports = ;\n');
    await syntaxCheck(ctx, 'plain/c.js', 'x;\n', 'x(;\n');
    await syntaxCheck(ctx, 'top.js', 'x;\n', 'x(;\n');
    const scratch = ctx.sb.commands.filter((c) => c.includes('agent-check-')).map((c) => /agent-check-[^.]*(\.[a-z]+)/.exec(c)![1]);
    expect(scratch).toEqual(['.mjs', '.cjs', '.js', '.js']);
  });
});
