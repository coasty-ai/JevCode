import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EngineEvent, ExecResult, Proposal, SandboxRunOptions, TestCommand } from '../../../src/core/types.js';
import { patternRedact } from '../../../src/core/redact.js';
import { redrawNote } from '../../../src/core/ansi.js';
import type { StageContext } from '../../../src/loop/engine.js';
import { runExecuteStage, type ExecuteStageResult } from '../../../src/loop/stages/execute.js';
import { isTestCommand, parseTestOutput } from '../../../src/workspace/tests.js';

const pytest = { command: 'pytest -q', runner: 'pytest' as const };
const npm = { command: 'npm test', runner: 'npm' as const };
const cargo = { command: 'cargo test', runner: 'cargo' as const };
const go = { command: 'go test ./...', runner: 'go' as const };

describe('isTestCommand (test detection feeds parsed counts and lastTestRun)', () => {
  it('matches the detected command, a prefix with more arguments, and launcher forms', () => {
    expect(isTestCommand('pytest -q', pytest)).toBe(true);
    expect(isTestCommand('pytest   -q tests/test_a.py', pytest)).toBe(true);
    expect(isTestCommand('pytest tests/test_a.py::test_f', pytest)).toBe(true);
    expect(isTestCommand('python -m pytest -x', pytest)).toBe(true);
    expect(isTestCommand('npx vitest run', { command: 'vitest run', runner: 'vitest' })).toBe(true);
    expect(isTestCommand('npm test -- --grep x', npm)).toBe(true);
    expect(isTestCommand('cargo test --lib', cargo)).toBe(true);
    expect(isTestCommand('go test ./pkg/...', go)).toBe(true);
  });
  it('does not treat other subcommands of the same launcher, other programs, or a null test command as the test command', () => {
    expect(isTestCommand('npm run build', npm)).toBe(false);
    expect(isTestCommand('npm install left-pad', npm)).toBe(false);
    expect(isTestCommand('cargo build --release', cargo)).toBe(false);
    expect(isTestCommand('go build ./...', go)).toBe(false);
    expect(isTestCommand('ls -la', pytest)).toBe(false);
    expect(isTestCommand('python -m pip install x', pytest)).toBe(false);
    expect(isTestCommand('pytest -q', null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// core/ansi.ts in the execute stage: what the model, the parsers and every exec:output listener read
// ---------------------------------------------------------------------------------------------------------------------

interface CapturedRun {
  result: ExecuteStageResult;
  events: EngineEvent[];
}

/** vitest 5 into a pipe (TERM passed through): the real capture, stdout and stderr as the sandbox delivered them */
const FX = JSON.parse(readFileSync(join(import.meta.dirname, '../core/fixtures/terminal-output.json'), 'utf8')) as { vitestColored: { text: string; chunks: string[] } };
const [VITEST_OUT, VITEST_ERR] = FX.vitestColored.text.split('\n[stderr]\n') as [string, string];

function execResult(stdout: string, stderr: string): ExecResult {
  const bytesSeen = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
  return { ok: false, exitCode: 1, signal: null, stdout, stderr, truncated: false, bytesSeen, killedBy: null, timedOut: false, orphans: [], sandboxExecDenied: false, durationMs: 5 };
}

/** One `run` action through `runExecuteStage` with a fake sandbox that streams `chunks` and returns their join. */
async function runWith(command: string, chunks: readonly { stream: 'stdout' | 'stderr'; text: string }[], testCommand: TestCommand | null = null): Promise<CapturedRun> {
  const events: EngineEvent[] = [];
  const sandbox = {
    run: async (_cmd: string, o: SandboxRunOptions): Promise<ExecResult> => {
      for (const c of chunks) o.onOutput?.(c.stream, c.text);
      const all = (s: 'stdout' | 'stderr'): string => chunks.filter((c) => c.stream === s).map((c) => c.text).join('');
      return execResult(all('stdout'), all('stderr'));
    },
  };
  const ctx = {
    step: 3,
    now: () => 0,
    emit: (e: EngineEvent) => events.push(e),
    redact: patternRedact,
    limits: { commandTimeoutMs: 60_000, maxCommandTimeoutMs: 600_000, maxOutputBytes: 200_000 },
    wallRemainingMs: () => 600_000,
    signal: new AbortController().signal,
    sandbox,
    workspaceInfo: { testCommand },
    workspace: { parseTestOutput, changedFiles: async () => [] },
    startCandidateRefresh: () => undefined,
  } as unknown as StageContext;
  const proposal = { action: { kind: 'run', command }, goal: 'g' } as unknown as Proposal;
  return { result: await runExecuteStage(ctx, proposal), events };
}

const liveChunks = (events: readonly EngineEvent[]): string[] => events.flatMap((e) => (e.type === 'exec:output' ? [e.chunk] : []));
const REMNANT_RE = /\u001b|\u009b|\[[0-9;]+m/;

describe('runExecuteStage run: command output is cleaned (core/ansi.ts) before the redactor, the parsers and every listener', () => {
  const vitest: TestCommand = { command: 'npx vitest run', runner: 'vitest' };

  it('coloured vitest output parses to counts (it was null), and neither the model output nor exec:output carries an escape', async () => {
    expect(parseTestOutput('vitest', `${VITEST_OUT}\n[stderr]\n${VITEST_ERR}`)).toBeNull(); // the raw bytes: counts lost
    // 61-char chunks: most boundaries fall inside an escape sequence
    const pieces = (s: string, stream: 'stdout' | 'stderr'): { stream: 'stdout' | 'stderr'; text: string }[] => (s.match(/[\s\S]{1,61}/g) ?? []).map((text) => ({ stream, text }));
    const { result, events } = await runWith('npx vitest run', [...pieces(VITEST_OUT, 'stdout'), ...pieces(VITEST_ERR, 'stderr')], vitest);
    expect(result.tests?.parsed).toMatchObject({ passed: 2, failed: 1 });
    expect(result.tests?.allPassed).toBe(false);
    expect(result.output).not.toMatch(REMNANT_RE);
    expect(result.output).toContain('Tests  1 failed | 2 passed (3)');
    const live = liveChunks(events);
    expect(live.length).toBeGreaterThan(0);
    for (const c of live) expect(c).not.toMatch(REMNANT_RE);
  });

  it('a sequence split between two chunks is held, never emitted half-stripped; the stream end flushes what is held', async () => {
    const { result, events } = await runWith('echo', [
      { stream: 'stdout', text: 'ok \u001b[3' },
      { stream: 'stdout', text: '3m\u001b[2m✓\u001b[22m\u001b[39m slow\n' },
      { stream: 'stdout', text: 'tail \u009b1' },
    ]);
    const live = liveChunks(events);
    expect(live.join('')).toBe('ok ✓ slow\ntail 1');
    expect(live[0]).toBe('ok ');
    expect(live.join('')).not.toContain('3m');
    expect(result.output).toBe('ok ✓ slow\ntail 1');
  });

  it('a key right after an SGR (grep --color=always) is redacted: the strip runs BEFORE the redactor', async () => {
    const key = `ghp_${'a1B2c3D4e5F6'.repeat(3)}`;
    const line = `"token": "\u001b[01;31m\u001b[K${key}\u001b[m\u001b[K"\n`;
    expect(patternRedact(line)).toContain(key); // redact-then-strip: the lookbehind sees the `K` and the key survives
    const { result, events } = await runWith('grep --color=always token cfg.json', [{ stream: 'stdout', text: line }]);
    expect(result.output).toBe('"token": "[REDACTED:pattern]"\n');
    expect(liveChunks(events).join('')).toBe('"token": "[REDACTED:pattern]"\n');
    const exec = result.outcome.status === 'executed' ? result.outcome.exec : undefined;
    expect(exec?.stdout).not.toContain(key.slice(4));
  });

  it('CR progress redraws collapse to their final state; binary output becomes a note with its size', async () => {
    const bar = Array.from({ length: 21 }, (_, i) => `\r${String(i * 5).padStart(3)}%|${'#'.repeat(i)}`).join('');
    const { result } = await runWith('train', [{ stream: 'stderr', text: `${bar}\n` }, { stream: 'stdout', text: 'done\n' }]);
    expect(result.output).toBe(`done\n\n[stderr]\n100%|${'#'.repeat(20)}\n${redrawNote(20)}\n`);
    const elf = `\u007fELF\u0002\u0001\u0001${'\u0000'.repeat(4000)}\u0003\u0000>\u0000${'�'.repeat(200)}`;
    const bin = await runWith('cat /bin/ls | head -c 4212', [{ stream: 'stdout', text: elf }]);
    expect(bin.result.output).toBe(`(binary output: ${Buffer.byteLength(elf)} bytes, not shown — write it to a file, or pipe it through xxd | head or file)`);
    expect(bin.result.output).not.toContain('\u0000');
  });
});
