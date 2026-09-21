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
import { ensureWiring, firstFrameTask, modeFromFlags, readTask, selectRenderer, versionJson } from '../../../src/cli/main.js';
import { RESTORE, createRestoreTerminal, processRestoreTerminal, restoreTerminal, setProcessRestore } from '../../../src/tui/terminal.js';
import { UsageError } from '../../../src/errors.js';
import { buildProvider, defaultEngineFactory } from '../../../src/cli/session.js';
import { VERSION } from '../../../src/version.js';
import { INK_VERSION, REACT_VERSION } from '../../../src/cli/report.js';

const tty = { stdinIsTTY: true, stdoutIsTTY: true, env: { TERM: 'xterm-256color' } };
const pipe = { stdinIsTTY: false, stdoutIsTTY: false, env: { TERM: 'xterm-256color' } };

describe('selectRenderer (§1 table)', () => {
  it('chat on a TTY → Ink session; run on a TTY → Ink one-shot', () => {
    expect(selectRenderer({ command: 'chat' }, 'chat', tty)).toEqual({ kind: 'tui', mode: 'session', readline: false, interactive: true });
    expect(selectRenderer({ command: 'run', task: 'x' }, 'run', tty)).toEqual({ kind: 'tui', mode: 'one-shot', readline: false, interactive: true });
  });
  it('--plain on a TTY → plain renderer with the readline composer (session for chat, one-shot steering for run)', () => {
    expect(selectRenderer({ command: 'chat', plain: true }, 'chat', tty)).toEqual({ kind: 'plain', mode: 'session', readline: true, interactive: false });
    expect(selectRenderer({ command: 'run', plain: true, task: 'x' }, 'run', tty)).toEqual({ kind: 'plain', mode: 'one-shot', readline: true, interactive: false });
  });
  it('a pipe, CI, TERM=dumb and --no-input → plain, no readline, one-shot (C46)', () => {
    expect(selectRenderer({ command: 'chat' }, 'chat', pipe)).toEqual({ kind: 'plain', mode: 'one-shot', readline: false, interactive: false });
    expect(selectRenderer({ command: 'run', task: 'x' }, 'run', { ...tty, env: { CI: '1' } })).toMatchObject({ kind: 'plain', readline: false, interactive: false });
    expect(selectRenderer({ command: 'run', task: 'x' }, 'run', { ...tty, env: { TERM: 'dumb' } })).toMatchObject({ kind: 'plain', readline: false });
    expect(selectRenderer({ command: 'run', task: 'x', noInput: true }, 'run', tty)).toEqual({ kind: 'plain', mode: 'one-shot', readline: false, interactive: false });
  });
  it('--json → the NDJSON renderer, non-interactive, one-shot, on a TTY too', () => {
    expect(selectRenderer({ command: 'run', json: true, task: 'x' }, 'run', tty)).toEqual({ kind: 'json', mode: 'one-shot', readline: false, interactive: false });
    expect(selectRenderer({ command: 'chat', json: true }, 'chat', pipe)).toEqual({ kind: 'json', mode: 'one-shot', readline: false, interactive: false });
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
  it('modeFromFlags: --mode, the hidden --condition alias, default jev-on', () => {
    expect(modeFromFlags({ command: 'run' })).toBe('jev-on');
    expect(modeFromFlags({ command: 'run', mode: 'jev-only' })).toBe('jev-only');
    expect(modeFromFlags({ command: 'run', condition: 'jev-off' })).toBe('jev-off');
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
