/**
 * TUI-DESIGN §1 / §15.2 `cli/main.tsx` row / §15.3 / §17: the wiring — renderer selection (chat vs run vs `--plain`
 * vs `--json` vs `--no-input`, TTY vs pipe, CI, TERM=dumb), the one-shot task reader, `--version --json`, the jev-only
 * provider path (NullProvider; `config.generator()` never called), and the process-level signal handler installed
 * before the first frame (a SIGTERM to a real `jevcode run --plain --mock` exits 143 with the epilogue).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ResolvedConfigWithDiagnostics } from '../../../src/config/types.js';
import { parseCliArgs } from '../../../src/cli/args.js';
import { ensureWiring, firstFrameTask, loginFlagsFrom, readTask, rendererRefusal, rendererRefusalLine, rendererRefusalRows, selectRenderer, versionJson } from '../../../src/cli/main.js';
import { RESTORE, createRestoreTerminal, processRestoreTerminal, restoreTerminal, setProcessRestore } from '../../../src/tui/terminal.js';
import { UsageError } from '../../../src/errors.js';
import { makeController } from './helpers.js';
import { buildProvider, defaultEngineFactory } from '../../../src/cli/session.js';
import { VERSION } from '../../../src/version.js';
import { INK_VERSION, REACT_VERSION } from '../../../src/cli/report.js';

const tty = { stdinIsTTY: true, stdoutIsTTY: true, env: { TERM: 'xterm-256color' } };
const pipe = { stdinIsTTY: false, stdoutIsTTY: false, env: { TERM: 'xterm-256color' } };

// MINIMAL, MARKED EDIT BY SLOT S2 (TUI-DESIGN-4 §2.8 P-R10): `RendererSelection` gains `reason` — the first clause of
// the §1 rule that failed, `null` when the renderer is interactive. PROBED: `TERM=dumb jevcode chat` reports
// `jevcode: missing task text` (exit 2) and the word `TERM` never appears, so the user is told their command is
// malformed when in fact their terminal was refused. Only the `reason` key is added to these four `toEqual`s; the new
// describe below is the P-R10 coverage. The rest of the file is untouched.
describe('selectRenderer (§1 table)', () => {
  it('chat on a TTY → Ink session; run on a TTY → Ink one-shot', () => {
    expect(selectRenderer({ command: 'chat' }, 'chat', tty)).toEqual({ kind: 'tui', mode: 'session', readline: false, interactive: true, reason: null });
    expect(selectRenderer({ command: 'run', task: 'x' }, 'run', tty)).toEqual({ kind: 'tui', mode: 'one-shot', readline: false, interactive: true, reason: null });
  });
  it('--plain on a TTY → plain renderer with the readline composer (session for chat, one-shot steering for run)', () => {
    expect(selectRenderer({ command: 'chat', plain: true }, 'chat', tty)).toEqual({ kind: 'plain', mode: 'session', readline: true, interactive: false, reason: 'flag' });
    expect(selectRenderer({ command: 'run', plain: true, task: 'x' }, 'run', tty)).toEqual({ kind: 'plain', mode: 'one-shot', readline: true, interactive: false, reason: 'flag' });
  });
  it('a pipe, CI, TERM=dumb and --no-input → plain, no readline, one-shot (C46)', () => {
    expect(selectRenderer({ command: 'chat' }, 'chat', pipe)).toEqual({ kind: 'plain', mode: 'one-shot', readline: false, interactive: false, reason: 'stdin-not-tty' });
    expect(selectRenderer({ command: 'run', task: 'x' }, 'run', { ...tty, env: { CI: '1' } })).toMatchObject({ kind: 'plain', readline: false, interactive: false });
    expect(selectRenderer({ command: 'run', task: 'x' }, 'run', { ...tty, env: { TERM: 'dumb' } })).toMatchObject({ kind: 'plain', readline: false });
    expect(selectRenderer({ command: 'run', task: 'x', noInput: true }, 'run', tty)).toEqual({ kind: 'plain', mode: 'one-shot', readline: false, interactive: false, reason: 'flag' });
  });
  it('--json → the NDJSON renderer, non-interactive, one-shot, on a TTY too', () => {
    expect(selectRenderer({ command: 'run', json: true, task: 'x' }, 'run', tty)).toEqual({ kind: 'json', mode: 'one-shot', readline: false, interactive: false, reason: 'flag' });
    expect(selectRenderer({ command: 'chat', json: true }, 'chat', pipe)).toEqual({ kind: 'json', mode: 'one-shot', readline: false, interactive: false, reason: 'stdin-not-tty' });
  });
});

describe('P-R10: the refusal is named, and `TERM` is one of the names (TUI-DESIGN-4 §2.8)', () => {
  it('the first failing clause of the §1 rule wins, in the rule\'s own order', () => {
    expect(rendererRefusal({ command: 'chat' }, tty)).toBeNull();
    expect(rendererRefusal({ command: 'chat' }, { ...tty, stdinIsTTY: false })).toBe('stdin-not-tty');
    expect(rendererRefusal({ command: 'chat' }, { ...tty, stdoutIsTTY: false })).toBe('stdout-not-tty');
    expect(rendererRefusal({ command: 'chat' }, { ...tty, env: { CI: '1' } })).toBe('ci');
    expect(rendererRefusal({ command: 'chat' }, { ...tty, env: { TERM: 'dumb' } })).toBe('dumb');
    expect(rendererRefusal({ command: 'chat', plain: true }, tty)).toBe('flag');
    expect(rendererRefusal({ command: 'chat', json: true }, tty)).toBe('flag');
    expect(rendererRefusal({ command: 'chat', noInput: true }, tty)).toBe('flag');
    // a pipe under CI reports the pipe: it is the thing the user can most plausibly change
    expect(rendererRefusal({ command: 'chat' }, { stdinIsTTY: false, stdoutIsTTY: false, env: { CI: '1', TERM: 'dumb' } })).toBe('stdin-not-tty');
  });

  it('§12: the `TERM=dumb` sentence and its three ways out, byte for byte', () => {
    expect(selectRenderer({ command: 'chat' }, 'chat', { ...tty, env: { TERM: 'dumb' } }).reason).toBe('dumb');
    expect(rendererRefusalRows('dumb', { TERM: 'dumb' })).toEqual([
      'jevcode: chat needs an interactive terminal; this one reports TERM=dumb, so the plain renderer is used.',
      "· run 'jevcode chat --plain' for the line renderer",
      '· or \'jevcode run "<task>"\' for a one-shot run',
      '· or set a real TERM (e.g. TERM=xterm-256color)',
    ]);
    // the word `TERM` appears, which is the whole point of the defect
    expect(rendererRefusalRows('dumb', { TERM: 'dumb' }).join('\n')).toContain('TERM');
  });

  /**
   * The defect P-R10 names is not the sentence: it is that nothing consumed it, so `TERM=dumb jevcode chat`
   * answered `missing task text`. The controller now takes the ROWS (built by `main.tsx`, the §12 strings) and
   * raises them instead — for `chat` only, because `run` without a task really IS a missing task.
   */
  it('the refusal reaches the usage error: `chat` says why, `run` still says `missing task text`', async () => {
    const rows = rendererRefusalRows('dumb', { TERM: 'dumb' });
    const refused = await makeController({ mode: 'one-shot', task: null, options: { rendererRefusalRows: rows } });
    expect(await refused.controller.run()).toBe(2);
    const said = refused.stderr.join('');
    expect(said).toContain('chat needs an interactive terminal');
    expect(said).toContain('TERM=dumb');
    expect(said).toContain('set a real TERM');
    expect(said).not.toContain('missing task text');
    // `run` (no rows passed) keeps today's sentence
    const plain = await makeController({ mode: 'one-shot', task: null });
    expect(await plain.controller.run()).toBe(2);
    expect(plain.stderr.join('')).toContain('missing task text');
  });

  it('every other reason gets its own sentence and the two general ways out (no TERM row)', () => {
    for (const reason of ['ci', 'stdin-not-tty', 'stdout-not-tty', 'flag'] as const) {
      const rows = rendererRefusalRows(reason, { TERM: 'xterm-256color' });
      expect(rows, reason).toHaveLength(3);
      expect(rows[0], reason).toMatch(/^jevcode: chat needs an interactive terminal; .+\.$/);
      expect(rows.join('\n'), reason).not.toContain('set a real TERM');
      expect(rendererRefusalLine(reason)).toBe(rows[0]);
    }
    expect(rendererRefusalLine('ci')).toContain('CI is set');
    expect(rendererRefusalLine('stdin-not-tty')).toContain('stdin is not a terminal');
    expect(rendererRefusalLine('stdout-not-tty')).toContain('stdout is not a terminal');
    expect(rendererRefusalLine('dumb', { TERM: 'screen' })).toContain('TERM=screen');
  });
});

describe('readTask and versions', () => {
  it('argv wins, then --task-file, then piped stdin; a TTY with nothing yields null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcode-main-'));
    try {
      const file = join(dir, 'task.txt');
      writeFileSync(file, '  from file \n');
      expect(await readTask({ command: 'run', task: 'from argv' }, { stdinIsTTY: true })).toBe('from argv');
      expect(await readTask({ command: 'run', taskFile: file }, { stdinIsTTY: true })).toBe('from file');
      const stdin = new PassThrough();
      stdin.end('from stdin\n');
      expect(await readTask({ command: 'run' }, { stdinIsTTY: false }, stdin)).toBe('from stdin');
      expect(await readTask({ command: 'run' }, { stdinIsTTY: true })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('an unreadable --task-file is a usage error (exit 2) naming the path and the code, never a raw ENOENT', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcode-main-'));
    try {
      const missing = join(dir, 'nope.txt');
      const p = readTask({ command: 'run', taskFile: missing }, { stdinIsTTY: true });
      await expect(p).rejects.toBeInstanceOf(UsageError);
      await expect(p).rejects.toMatchObject({ exitCode: 2, message: `--task-file: cannot read ${missing}: ENOENT` });
      // a directory is not a task file either
      await expect(readTask({ command: 'run', taskFile: dir }, { stdinIsTTY: true })).rejects.toMatchObject({ exitCode: 2, message: `--task-file: cannot read ${dir}: EISDIR` });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('firstFrameTask: the argv-only header text — the task, `task from <file>` for --task-file, `resuming <id>`, else the session header (§1, §24)', () => {
    expect(firstFrameTask({ task: 'fix it' })).toBe('fix it');
    expect(firstFrameTask({ taskFile: '/tmp/tasks/todo.md' })).toBe('task from todo.md');
    expect(firstFrameTask({ resume: '20260920-150000-abcdefgh' })).toBe('resuming 20260920-150000-abcdefgh');
    expect(firstFrameTask({ task: 'fix it', taskFile: '/x' })).toBe('fix it');
    expect(firstFrameTask({})).toBe('');
  });
  it('--version --json names the package, the versions (node, ink, react) and the bundle; ink and react are the pinned dependencies (§17 item 3)', () => {
    const v = versionJson('/x/dist/jevcode.mjs');
    expect(v).toEqual({ name: 'jevcode', version: VERSION, node: process.version, ink: INK_VERSION, react: REACT_VERSION, bundle: '/x/dist/jevcode.mjs' });
    expect(Object.keys(v)).toEqual(['name', 'version', 'node', 'ink', 'react', 'bundle']);
    // §17 item 1: ink and react live in devDependencies (inlined by esbuild); either section pins the version the report names
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(pkg.devDependencies?.['ink'] ?? pkg.dependencies?.['ink']).toBe(INK_VERSION);
    expect(pkg.devDependencies?.['react'] ?? pkg.dependencies?.['react']).toBe(REACT_VERSION);
  });
  it('the fatal wiring shares the one process-wide restoreTerminal() of src/tui/terminal.ts: the wiring\'s restore *is* that function, and the fatal path plus the Ink-side paths write RESTORE once between them (§14.2; the pty smoke asserts the count end to end)', () => {
    const w = ensureWiring();
    try {
      expect(w.restore).toBe(restoreTerminal);
      expect(ensureWiring()).toBe(w); // idempotent: one wiring per process
      // behaviour through the process-wide seam: a fake TTY behind restoreTerminal(); every path that may run at exit
      const writes: string[] = [];
      let raw = true;
      const fake = createRestoreTerminal({
        stdout: { isTTY: true, write: () => true },
        stdin: {
          get isRaw() {
            return raw;
          },
          setRawMode: () => {
            raw = false;
          },
        },
        writeSync: (_fd, text) => {
          writes.push(text);
        },
      });
      setProcessRestore(fake);
      w.restore(); // fatalExit / the engine's exit hook / earlyExit
      restoreTerminal(); // the Ink mount's hygiene ('exit' hook), unmount(), finishSession
      processRestoreTerminal()(); // SIGTSTP
      expect(writes).toEqual([RESTORE]);
      expect(raw).toBe(false);
      expect(fake.written).toBe(true);
    } finally {
      setProcessRestore(null);
      w.uninstall();
    }
  });
  // TUI-DESIGN-3 §1.1: `modeFromFlags` is gone — `config/resolve.ts modeFromParsedFlags` is the one rule (test/unit/config/resolve.test.ts)
  it('loginFlagsFrom: `jevcode login --jev-provider typesafe --jev-key-stdin` forwards jevProvider to commandLogin with the other login flags (TUI-DESIGN-2 §1.4)', () => {
    expect(loginFlagsFrom(parseCliArgs(['login', '--jev-provider', 'typesafe', '--jev-key-stdin']))).toEqual({ jevProvider: 'typesafe', jevKeyStdin: true });
    // TUI-DESIGN-3 §1.6: `--key-stdin` rides along
    expect(loginFlagsFrom(parseCliArgs(['login', '--key-stdin']))).toEqual({ keyStdin: true });
    expect(loginFlagsFrom(parseCliArgs(['login', '--key-stdin', '--verify']))).toEqual({ keyStdin: true, verify: true });
    expect(loginFlagsFrom(parseCliArgs(['login', '--provider', 'anthropic', '--jev-provider', 'OpenRouter', '--generator-key-stdin', '--jev-key-stdin', '--status', '--verify', '--config', '/x/c.json']))).toEqual({
      provider: 'anthropic',
      jevProvider: 'openrouter',
      generatorKeyStdin: true,
      jevKeyStdin: true,
      status: true,
      verify: true,
      config: '/x/c.json',
    });
    // nothing is forwarded that was not given (an absent --jev-provider stays absent, so login infers)
    expect(loginFlagsFrom(parseCliArgs(['login']))).toEqual({});
    expect(Object.keys(loginFlagsFrom(parseCliArgs(['login', '--jev-key-stdin'])))).toEqual(['jevKeyStdin']);
  });
});

describe('jev-only preservation (§15.3)', () => {
  it('buildProvider returns the NullProvider for jev-only and never calls config.generator()', async () => {
    let generatorCalls = 0;
    const config = {
      generator: () => {
        generatorCalls += 1;
        throw new Error('must not be called');
      },
      redact: (s: string) => s,
    } as unknown as ResolvedConfigWithDiagnostics;
    const p = await buildProvider(config, { command: 'run' }, 'jev-only');
    expect(p.name).toBe('mock');
    await expect(p.generate({ system: '', messages: [], maxTokens: 1, temperature: null }, { signal: new AbortController().signal })).rejects.toThrow();
    expect(generatorCalls).toBe(0);
    // --mock keeps the generator section unvalidated too
    const m = await buildProvider(config, { command: 'run', mock: true }, 'jev-on');
    expect(m.name).toBe('mock');
    expect(generatorCalls).toBe(0);
  });
  it('llm-jev (docs/LLM-JEV-DESIGN.md): buildProvider constructs the REAL generator exactly as jev-on does — never the NullProvider; --mock* keep the scripted provider', async () => {
    let generatorCalls = 0;
    const sentinel = new Error('generator section validated');
    const config = {
      generator: () => {
        generatorCalls += 1;
        throw sentinel;
      },
      redact: (s: string) => s,
    } as unknown as ResolvedConfigWithDiagnostics;
    await expect(buildProvider(config, { command: 'run' }, 'llm-jev')).rejects.toBe(sentinel);
    expect(generatorCalls).toBe(1);
    const m = await buildProvider(config, { command: 'run', mockGenerator: true }, 'llm-jev');
    expect(m.name).toBe('mock');
    expect(generatorCalls).toBe(1);
  });
  it('the engine factory routes jev-off to the generator-only engine and everything else to createEngine (dynamic imports)', async () => {
    // a jev-only engine without a synthesizer is refused by createEngine itself — proof the real factory was reached
    await expect(defaultEngineFactory({ mode: 'jev-only' } as never)).rejects.toThrow(/synthesizer/);
  });
});

describe('signals before and during the first frames (§14.2, research 20 item 2)', () => {
  it('a SIGTERM to a real `jevcode run --plain --mock` exits 143 with the signal epilogue on stderr', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jevcode-sig-home-'));
    const ws = mkdtempSync(join(tmpdir(), 'jevcode-sig-ws-'));
    try {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/main.tsx', 'run', 'probe', '--plain', '--mock', '--mock-steps', '40', '--workspace', ws], {
        cwd: process.cwd(),
        env: { ...process.env, JEVCODE_HOME: home, CI: undefined, TERM: 'xterm-256color' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d: string) => {
        out += d;
        // the header (first frame) is out: the handler exists by contract; the run may or may not have started
        if (out.includes('step 0/') && !sent) {
          sent = true;
          child.kill('SIGTERM');
        }
      });
      child.stderr.on('data', (d: string) => {
        err += d;
      });
      let sent = false;
      const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
      expect(sent).toBe(true);
      expect(code).toBe(143);
      expect(err).toContain('stopped — signal: SIGTERM (exit 143)');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);
});
