/**
 * TUI-DESIGN §13.5 / §19.0: `epilogueLines` per situation (API failure, budget, human_pause, degraded, the three
 * signals); `<msg>` redacted and §14.1-safe (canary, C0, bidi, U+2028); the exit-code table as data with the
 * human_abort / SIGINT split; purity.
 */
import { describe, expect, it } from 'vitest';
import type { SerializedError, SignalName, StopReason } from '../../../../src/core/types.js';
import { EXIT_CODES } from '../../../../src/errors.js';
import { exitCodeFor } from '../../../../src/loop/stop.js';
import {
  EXIT_CODE_TABLE,
  FILES_GONE,
  FILES_SUFFIX,
  NOT_RESUMABLE,
  REPORT_SUFFIX,
  abbreviateDir,
  epilogueBlockRows,
  epilogueExitCode,
  epilogueItemLines,
  epilogueLines,
  epilogueRows,
  exitCodeRowFor,
  stoppedLine,
  terminalSafeLine,
  type EpilogueContext,
} from '../../../../src/cli/epilogue.js';

const CANARY = 'sk-ant-CANARY0123456789abcdefghijklmnop';
const redact = (s: string): string => s.split(CANARY).join('[REDACTED:test]');
const id = '20260920-191506-5gnampki';
const ctx: EpilogueContext = { runId: id, runDir: `/Users/me/.jevcode/runs/${id}`, resumable: true, home: '/Users/me' };
const jevHttp: SerializedError = { name: 'JevHttpError', code: 'jev_http', message: 'Jev HTTP 429: Rate limit exceeded', exitCode: 5, status: 429, side: 'jev' };

describe('epilogueLines (§13.5)', () => {
  it('renders the documented five-line block for an API failure after retries', () => {
    expect(epilogueLines(jevHttp, { ...ctx, stopReason: 'error' }, redact, 120)).toEqual([
      'jevcode: stopped — jev_http: Jev HTTP 429: Rate limit exceeded (exit 5)',
      `  run        ${id}`,
      `  files      ~/.jevcode/runs/${id}/  (transcript.log, state.json, jevcode.log)`,
      `  resume     jevcode run --resume ${id}`,
      `  report     jevcode report ${id}   (redacted bundle written locally; nothing is sent)`,
    ]);
    expect(FILES_SUFFIX).toBe('(transcript.log, state.json, jevcode.log)');
    expect(REPORT_SUFFIX).toBe('(redacted bundle written locally; nothing is sent)');
  });

  it('not resumable → `state.json missing — not resumable`; exit 3 when the checkpoint degraded (given or derived)', () => {
    const lines = epilogueLines(null, { ...ctx, resumable: false, stopReason: 'complete', exitCode: 3 }, redact, 120);
    expect(lines[0]).toBe('jevcode: stopped — complete (exit 3)');
    expect(lines[3]).toBe(`  resume     ${NOT_RESUMABLE}`);
    expect(NOT_RESUMABLE).toBe('state.json missing — not resumable');
    // `[c] continue without checkpoints` → degraded: a non-error stop derives 3 through exitCodeFor
    expect(epilogueLines(null, { ...ctx, resumable: false, stopReason: 'complete', degraded: true }, redact, 120)[0]).toBe('jevcode: stopped — complete (exit 3)');
    expect(epilogueExitCode(jevHttp, { ...ctx, stopReason: 'error', degraded: true })).toBe(5); // an error keeps its own code
  });

  it('every situation of the §13.5 table: budget, human_pause, complete, the three signals, a fatal', () => {
    const first = (c: EpilogueContext, err: SerializedError | null = null): string => epilogueLines(err, c, redact)[0]!;
    expect(first({ ...ctx, stopReason: 'complete' })).toBe('jevcode: stopped — complete (exit 0)');
    expect(first({ ...ctx, stopReason: 'generator_done' })).toBe('jevcode: stopped — generator_done (exit 0)');
    expect(first({ ...ctx, stopReason: 'max_steps' })).toBe('jevcode: stopped — max_steps (exit 4)');
    expect(first({ ...ctx, stopReason: 'spend_cap' })).toBe('jevcode: stopped — spend_cap (exit 4)');
    expect(first({ ...ctx, stopReason: 'token_cap' })).toBe('jevcode: stopped — token_cap (exit 4)');
    expect(first({ ...ctx, stopReason: 'human_pause' })).toBe('jevcode: stopped — human_pause (exit 4)');
    expect(first({ ...ctx, stopReason: 'human_abort' })).toBe('jevcode: stopped — human_abort (exit 130)');
    // signals: the name is printed and drives the code (130 / 143 / 129) without a caller-supplied exitCode
    expect(first({ ...ctx, stopReason: 'signal', signal: 'SIGINT' })).toBe('jevcode: stopped — signal: SIGINT (exit 130)');
    expect(first({ ...ctx, stopReason: 'signal', signal: 'SIGTERM' })).toBe('jevcode: stopped — signal: SIGTERM (exit 143)');
    expect(first({ ...ctx, stopReason: 'signal', signal: 'SIGHUP' })).toBe('jevcode: stopped — signal: SIGHUP (exit 129)');
    expect(first({ ...ctx, stopReason: 'signal' })).toBe('jevcode: stopped — signal (exit 130)');
    // a fatal (uncaught) → 1 with its code and message
    const internal: SerializedError = { name: 'Error', code: 'internal', message: 'x is not a function', exitCode: 1 };
    expect(first({ ...ctx, stopReason: 'error' }, internal)).toBe('jevcode: stopped — internal: x is not a function (exit 1)');
    // a config error before any run
    const config: SerializedError = { name: 'ConfigError', code: 'config', message: 'no API key', exitCode: 2 };
    expect(epilogueLines(config, { runId: null, runDir: null, resumable: false }, redact)).toEqual(['jevcode: stopped — config: no API key (exit 2)']);
    // every row keeps the four trailing lines
    expect(epilogueLines(null, { ...ctx, stopReason: 'signal', signal: 'SIGTERM' }, redact, 120)).toHaveLength(5);
  });

  it('a canary in the thrown message is redacted; newlines and controls never reach the line', () => {
    const err: SerializedError = { name: 'Error', code: 'internal', message: `boom ${CANARY}\nsecond line\x1b[2J`, exitCode: 1 };
    const lines = epilogueLines(err, ctx, redact);
    // the escape sequence goes WHOLE (core/ansi.ts, through plain.ts sanitizeStream): no ESC and no `[2J` body
    expect(lines[0]).toBe('jevcode: stopped — internal: boom [REDACTED:test] second line (exit 1)');
    expect(lines.join('\n')).not.toContain('[2J');
    expect(lines.join('\n')).not.toContain(CANARY);
    expect(lines.join('\n')).not.toContain('\x1b');
  });

  it('bidi controls, isolates and U+2028/2029 in a thrown message or code never reach the epilogue (§14.1)', () => {
    const rlo = String.fromCodePoint(0x202e);
    const lri = String.fromCodePoint(0x2066);
    const pdi = String.fromCodePoint(0x2069);
    const lsep = String.fromCodePoint(0x2028);
    const psep = String.fromCodePoint(0x2029);
    const err: SerializedError = { name: 'Error', code: `c${rlo}`, message: `user${rlo}gnp.exe${lsep}second${lri}x${pdi}${psep}third`, exitCode: 1 };
    const lines = epilogueLines(err, ctx, redact);
    expect(lines[0]).toBe('jevcode: stopped — c: usergnp.exe secondx third (exit 1)');
    for (const f of [rlo, lri, pdi, lsep, psep, String.fromCodePoint(0x200e), String.fromCodePoint(0xfeff)]) expect(lines.join('\n')).not.toContain(f);
    expect(epilogueItemLines(err, ctx, redact).text).not.toContain(rlo);
    expect(terminalSafeLine(`a${lsep}b`)).toBe('a b');
  });

  it('before a run exists only the first line is printed', () => {
    const err: SerializedError = { name: 'ConfigError', code: 'config', message: 'no API key', exitCode: 2 };
    expect(epilogueLines(err, { runId: null, runDir: null, resumable: false }, redact)).toEqual(['jevcode: stopped — config: no API key (exit 2)']);
    expect(epilogueRows({ runId: null, runDir: null, resumable: false })).toEqual([]);
  });

  it('a run without a known directory omits the files row; ~ only for a real home', () => {
    const rows = epilogueRows({ runId: id, runDir: null, resumable: true }, 118);
    expect(rows.map((r) => r.split(/\s+/)[0])).toEqual(['run', 'resume', 'report']);
    expect(abbreviateDir('/tmp/runs/x', '/Users/me')).toBe('/tmp/runs/x/');
    expect(abbreviateDir('/Users/me/.jevcode/runs/x/', '/Users/me/')).toBe('~/.jevcode/runs/x/');
    expect(abbreviateDir('/Users/me', '/Users/me')).toBe('~/');
    expect(abbreviateDir('/Users/meow/x', '/Users/me')).toBe('/Users/meow/x/');
    expect(abbreviateDir('/x', '/')).toBe('/x/');
    expect(abbreviateDir('/x')).toBe('/x/');
  });

  it('the exit code is the caller’s when given, else derived through exitCodeFor', () => {
    expect(epilogueExitCode(null, { ...ctx, stopReason: 'max_steps' })).toBe(4);
    expect(epilogueExitCode(null, { ...ctx, stopReason: 'complete' })).toBe(0);
    expect(epilogueExitCode(null, { ...ctx, stopReason: 'complete', exitCode: 3 })).toBe(3);
    expect(epilogueExitCode(jevHttp, { ...ctx, stopReason: 'error' })).toBe(5);
    expect(epilogueExitCode(jevHttp, ctx)).toBe(5);
    expect(epilogueExitCode(null, ctx)).toBe(1); // no stop reason, no error: the unexpected code
    expect(epilogueExitCode(null, { ...ctx, exitCode: Number.NaN, stopReason: 'complete' })).toBe(0);
    expect(epilogueExitCode(null, { ...ctx, exitCode: Number.POSITIVE_INFINITY, stopReason: 'signal', signal: 'SIGHUP' })).toBe(129);
    expect(stoppedLine(null, { ...ctx, stopReason: 'human_pause' }, redact)).toBe('stopped — human_pause (exit 4)');
  });

  it('the session item twin carries the same text without the CLI prefix and indent', () => {
    const item = epilogueItemLines(jevHttp, ctx, redact);
    expect(item.text).toBe('stopped — jev_http: Jev HTTP 429: Rate limit exceeded (exit 5)');
    expect(item.detail).toEqual(epilogueRows(ctx));
    expect(item.detail[0]).toBe(`run        ${id}`);
  });

  it('is pure: equal inputs give equal lines, the context and error are never mutated', () => {
    const frozenCtx = Object.freeze({ ...ctx, stopReason: 'signal' as const, signal: 'SIGTERM' as const });
    const frozenErr = Object.freeze({ ...jevHttp });
    expect(epilogueLines(frozenErr, frozenCtx, redact)).toEqual(epilogueLines(frozenErr, frozenCtx, redact));
    expect(epilogueLines(null, frozenCtx, redact)).toEqual(epilogueLines(null, frozenCtx, redact));
    expect(epilogueItemLines(frozenErr, frozenCtx, redact)).toEqual(epilogueItemLines(frozenErr, frozenCtx, redact));
    expect(frozenCtx.exitCode).toBeUndefined();
    expect(frozenErr.message).toBe(jevHttp.message);
  });
});


describe('TUI-DESIGN-4 §3.3 / §3.4: the epilogue is a block at a width', () => {
  it('every row fits the width at 40 / 80 / 120 and a continuation hangs under the VALUE column, not column 0', () => {
    for (const width of [30, 70, 110]) {
      const rows = epilogueRows(ctx, width);
      for (const r of rows) expect(r.length, `${width}: ${r}`).toBeLessThanOrEqual(width);
      // at 70 and 110 the block is in the standard/wide tier, so a continuation hangs under the value column (11);
      // at 30 it is the tight tier, where the key keeps its own row and the value is indented 2 (F-B4)
      const hang = width < 34 ? /^ {2}\S/ : /^ {11}\S/;
      for (const r of rows.slice(1)) if (r.startsWith(' ')) expect(r, `${width}: ${r}`).toMatch(hang);
    }
  });

  it('the `files` row at width 70 keeps the run id intact — it is never split mid-token', () => {
    const rows = epilogueRows(ctx, 70);
    expect(rows.join('\n')).toContain(id);
    expect(rows.filter((r) => r.includes(id.slice(0, 8)) && !r.includes(id))).toEqual([]);
  });

  it('§7.2 item 4: `files` lists only what exists, and a vanished run directory replaces the whole row', () => {
    expect(epilogueRows({ ...ctx, files: ['transcript.log'] }, 110)[1]).toBe(`files      ~/.jevcode/runs/${id}/  (transcript.log)`);
    // §7.2 item 4 / §12: a directory that exists but holds NOTHING the run wrote is the `rundir:chmod` fault —
    // it takes the `gone` row, and the undocumented `(empty)` sentence (which appears nowhere in §12) is gone
    const empty = epilogueRows({ ...ctx, files: [] }, 110);
    const emptyAt = empty.findIndex((r) => r.startsWith('resume'));
    expect(empty.slice(1, emptyAt).join(' ').replace(/\s+/g, ' ')).toBe(`files ~/.jevcode/runs/${id}/ — ${FILES_GONE}`);
    expect(empty.join('\n')).not.toContain('(empty)');
    const gone = epilogueRows({ ...ctx, gone: true }, 110);
    const goneAt = gone.findIndex((r) => r.startsWith('resume'));
    expect(gone.slice(1, goneAt).join(' ').replace(/\s+/g, ' ')).toBe(`files ~/.jevcode/runs/${id}/ — ${FILES_GONE}`);
    expect(gone.join('\n')).not.toContain(FILES_SUFFIX);
  });

  it('`resumable: false` keeps the §12 sentence at every width', () => {
    for (const width of [70, 110]) expect(epilogueRows({ ...ctx, resumable: false }, width).join('\n')).toContain('not resumable');
    // at the tight tier the sentence wraps, but it is never replaced or dropped
    expect(epilogueRows({ ...ctx, resumable: false }, 30).join(' ').replace(/\s+/g, ' ')).toContain('not resumable');
  });

  it('`abbreviateDir` is a thin wrapper over `shortPath` and still never elides by default', () => {
    expect(abbreviateDir(`/Users/me/.jevcode/runs/${id}`, '/Users/me')).toBe(`~/.jevcode/runs/${id}/`);
    expect(abbreviateDir(`/other/place/runs/${id}`, '/Users/me', 24)).toBe(`/other/place/runs/${id}/`);
  });

  it('the block rows are the five kinds, not strings', () => {
    expect(epilogueBlockRows(ctx).map((r) => r.kind)).toEqual(['kv', 'kv', 'kv', 'kv']);
    expect(epilogueBlockRows({ runId: null, runDir: null, resumable: false })).toEqual([]);
  });
});

describe('exit-code table (§13.5) as data', () => {
  it('every stop-reason row agrees with exitCodeFor (the signal rows through their signal)', () => {
    for (const row of EXIT_CODE_TABLE) {
      for (const reason of row.stopReasons) {
        expect(exitCodeFor(reason, undefined, false, row.signal), `${row.situation} / ${reason}`).toBe(row.oneShot);
      }
    }
  });

  it('every StopReason is covered: one row each, `signal` one row per SignalName', () => {
    // AGENT-LOOP-DESIGN §8 / §A1: `stuck` joins the exit-4 row, `answered` the exit-0 row
    const all: StopReason[] = ['complete', 'max_steps', 'spend_cap', 'wall_time', 'max_replans', 'human_abort', 'signal', 'replan_stop', 'impossible', 'generator_done', 'error', 'human_pause', 'token_cap', 'stuck', 'answered'];
    for (const r of all) {
      expect(exitCodeRowFor(r), r).not.toBeNull();
      if (r !== 'signal') expect(EXIT_CODE_TABLE.filter((row) => row.stopReasons.includes(r)), r).toHaveLength(1);
    }
    const signals: SignalName[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    expect(EXIT_CODE_TABLE.filter((row) => row.stopReasons.includes('signal')).map((row) => row.signal)).toEqual(signals);
    expect(exitCodeRowFor('signal')?.signal).toBe('SIGINT');
    expect(exitCodeRowFor('signal', 'SIGTERM')?.oneShot).toBe(143);
    expect(exitCodeRowFor('signal', 'SIGHUP')?.oneShot).toBe(129);
    expect(exitCodeRowFor('complete')?.oneShot).toBe(EXIT_CODES.ok);
    expect(exitCodeRowFor('token_cap')?.oneShot).toBe(EXIT_CODES.budget);
    expect(exitCodeRowFor('human_pause')?.session).toBe(4);
    expect(exitCodeRowFor('stuck')).toMatchObject({ oneShot: EXIT_CODES.budget, session: 4, sessionExits: false });
    expect(exitCodeRowFor('stuck')?.situation).toContain('stuck');
    expect(exitCodeRowFor('answered')).toMatchObject({ oneShot: EXIT_CODES.ok, session: 0, sessionExits: false });
  });

  it('human_abort stays in the session (composer reopens); an external SIGINT / SIGTERM / SIGHUP exits it', () => {
    expect(exitCodeRowFor('human_abort')).toMatchObject({ oneShot: 130, session: 130, sessionExits: false });
    expect(exitCodeRowFor('signal', 'SIGINT')).toMatchObject({ oneShot: 130, session: 130, sessionExits: true });
    expect(exitCodeRowFor('signal', 'SIGTERM')).toMatchObject({ oneShot: 143, session: 143, sessionExits: true });
    expect(exitCodeRowFor('signal', 'SIGHUP')).toMatchObject({ oneShot: 129, session: 129, sessionExits: true });
    expect(exitCodeRowFor('human_abort')).not.toBe(exitCodeRowFor('signal', 'SIGINT'));
  });

  it('the fixed decisions: leaving is exit 0 in session mode; first-call 401 is 2; degraded stop is 3', () => {
    const leave = EXIT_CODE_TABLE.find((r) => r.situation.startsWith('/exit'));
    expect(leave).toMatchObject({ oneShot: null, session: 0, sessionExits: true });
    expect(EXIT_CODE_TABLE.find((r) => r.situation.includes('first-call 401'))).toMatchObject({ oneShot: 2, session: 2, sessionExits: false });
    expect(EXIT_CODE_TABLE.find((r) => r.situation.includes('checkpoint degraded'))).toMatchObject({ oneShot: 3, session: 3 });
    expect(EXIT_CODE_TABLE.find((r) => r.situation.includes('sandbox'))).toMatchObject({ oneShot: 6 });
    expect(EXIT_CODE_TABLE.find((r) => r.situation.includes('uncaught'))).toMatchObject({ oneShot: 1 });
    const codes = new Set(EXIT_CODE_TABLE.map((r) => r.oneShot).filter((c): c is number => c !== null));
    expect([...codes].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 129, 130, 143]);
  });
});
