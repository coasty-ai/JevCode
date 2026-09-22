/**
 * TUI-DESIGN-4 §7.4 (P-D4) / §10 (S6 `errors/explain.test.ts`): one case per row of the §7.4 table, including a
 * path containing a canary secret (assert redacted), the two-row fix cap, the `~` seam and the exit codes.
 */
import { describe, expect, it } from 'vitest';
import { CheckpointError, ConfigError, EXIT_CODES, FS_FIX_MAX_ROWS, explainFsError, fsErrorToJevCodeError } from '../../../src/errors.js';

const SECRET = 'sk-ant-api03-SECRETSECRETSECRETSECRETSECRET1234';
const redact = (s: string): string => s.split(SECRET).join('[REDACTED:test]');

function errno(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`${code}: boom`), { code, ...extra });
}

describe('explainFsError (§7.4: errors that name the fix)', () => {
  it('EACCES / EROFS mkdir on the runs dir', () => {
    const x = explainFsError(errno('EACCES', { syscall: 'mkdir' }), { op: 'runs-dir', path: '/home/u/.jevcode/runs' });
    expect(x).toEqual({
      line: 'cannot create the runs directory /home/u/.jevcode/runs: permission denied',
      fix: ['set JEVCODE_HOME to a writable directory, or pass --runs-dir <dir>'],
      code: 'EACCES',
      exitCode: EXIT_CODES.config,
    });
    expect(explainFsError(errno('EROFS'), { op: 'runs-dir', path: '/mnt/ro/runs' })?.line).toBe('cannot create the runs directory /mnt/ro/runs: permission denied');
    // the syscall alone is enough when the caller gave no op
    expect(explainFsError(errno('EACCES', { syscall: 'mkdir' }), { path: '/x/runs' })?.line).toContain('cannot create the runs directory');
  });

  /**
   * §7.4 row 2 and §7.7's edge: ENOSPC under a LIVE run dir is exit 3 (this run cannot be checkpointed) while the same
   * code at LAUNCH stays exit 2 (`--runs-dir` on another volume is the fix). The split lives HERE since the harness
   * session landed round 4's owed hunk (0458ddf, 2026-09-22); the two readers — `src/cli/fatal.ts` (the `run-dir` op)
   * and `src/cli/report.ts` (§7.7's edge) — keep their own pins and now agree with the function.
   */
  it('ENOSPC names the volume fix; exit 3 inside a live run dir, exit 2 at launch', () => {
    expect(explainFsError(errno('ENOSPC'), { op: 'run-dir', path: '/runs/r1' })).toEqual({
      line: 'the disk holding /runs/r1 is full',
      fix: ['free space, or pass --runs-dir <dir> on another volume'],
      code: 'ENOSPC',
      exitCode: EXIT_CODES.checkpoint,
    });
    // the same code while the LAUNCH creates the runs directory: `--runs-dir` on another volume is the fix, exit 2
    expect(explainFsError(errno('ENOSPC'), { op: 'runs-dir', path: '/runs' })?.exitCode).toBe(EXIT_CODES.config);
    expect(explainFsError(errno('EDQUOT'), { op: 'other', path: '/runs' })?.exitCode).toBe(EXIT_CODES.config);
  });

  it('ENOENT on the run dir mid-run is a checkpoint failure (exit 3), not a config one', () => {
    const x = explainFsError(errno('ENOENT'), { op: 'run-dir', path: '/runs/r1' });
    expect(x?.line).toBe('the run directory /runs/r1 disappeared during the run');
    expect(x?.fix).toEqual(['this run cannot be resumed; the transcript above is complete']);
    expect(x?.exitCode).toBe(EXIT_CODES.checkpoint);
    // ENOENT anywhere else is not classified: a missing file is ordinary
    expect(explainFsError(errno('ENOENT'), { op: 'other', path: '/x' })).toBeNull();
  });

  it('EACCES on the config file', () => {
    expect(explainFsError(errno('EACCES'), { op: 'config', path: '/home/u/.jevcode/config.json' })).toEqual({
      line: 'cannot read /home/u/.jevcode/config.json: permission denied',
      fix: ['chmod u+r /home/u/.jevcode/config.json, or pass --config <path>'],
      code: 'EACCES',
      exitCode: EXIT_CODES.config,
    });
  });

  it('EMFILE / ENFILE', () => {
    for (const code of ['EMFILE', 'ENFILE']) {
      expect(explainFsError(errno(code))).toEqual({ line: 'too many open files', fix: ['raise the file-descriptor limit (ulimit -n)'], code, exitCode: EXIT_CODES.config });
    }
  });

  it('an unclassified error stays unclassified, so the raw-errno fallback keeps its job', () => {
    expect(explainFsError(new Error('plain'))).toBeNull();
    expect(explainFsError(null)).toBeNull();
    expect(explainFsError('ENOSPC')).toBeNull();
    // edge 3: a Windows errno defaults gracefully
    expect(explainFsError(errno('EBADFHANDLE'))).toBeNull();
  });

  it('walks a cause chain (a CheckpointError wraps the errno) and terminates on a cycle', () => {
    const wrapped = new CheckpointError('cannot rotate state.json', '/runs/r1', { cause: errno('ENOSPC') });
    expect(explainFsError(wrapped, { op: 'run-dir', path: '/runs/r1' })?.code).toBe('ENOSPC');
    const cyclic: Error & { cause?: unknown } = new Error('loop');
    cyclic.cause = cyclic;
    expect(explainFsError(cyclic)).toBeNull();
  });

  it('edge 1: the path passes redact and is made terminal-safe (a path can contain a token)', () => {
    const x = explainFsError(errno('ENOSPC'), { op: 'run-dir', path: `/runs/${SECRET}/r1`, redact });
    expect(x?.line).toBe('the disk holding /runs/[REDACTED:test]/r1 is full');
    expect(x?.line).not.toContain(SECRET);
    const nasty = explainFsError(errno('ENOSPC'), { op: 'run-dir', path: '/runs/a\u0007b\nc‮' });
    expect(nasty?.line).toBe('the disk holding /runs/ab c is full'); // a newline collapses to a space, like terminalSafeLine
  });

  it('edge 2: the `~` abbreviation goes through the injected shortener (S3 `shortPath`)', () => {
    const x = explainFsError(errno('EACCES', { syscall: 'mkdir' }), { op: 'runs-dir', path: '/Users/u/.jevcode/runs', shorten: (p) => p.replace('/Users/u', '~') });
    expect(x?.line).toBe('cannot create the runs directory ~/.jevcode/runs: permission denied');
  });

  it('edge 4: the fix block is at most two rows, so it fits the flat tier', () => {
    for (const code of ['EACCES', 'EROFS', 'ENOSPC', 'ENOENT', 'EMFILE']) {
      const x = explainFsError(errno(code), { op: 'run-dir', path: '/runs/r1' });
      if (x !== null) expect(x.fix.length, code).toBeLessThanOrEqual(FS_FIX_MAX_ROWS);
    }
  });

  it('an empty path falls back to a sentence that still reads', () => {
    expect(explainFsError(errno('ENOSPC'), { op: 'run-dir' })?.line).toBe('the disk holding the run directory is full');
  });
});

describe('fsErrorToJevCodeError (§7.4: exit 2 for a configuration/permission problem, not 1)', () => {
  it('classified errnos become ConfigError (2) and the mid-run ENOENT a CheckpointError (3)', () => {
    const cfg = fsErrorToJevCodeError(errno('EACCES', { syscall: 'mkdir' }), { op: 'runs-dir', path: '/x/runs' });
    expect(cfg).toBeInstanceOf(ConfigError);
    expect(cfg?.exitCode).toBe(2);
    expect(cfg?.message).toBe('cannot create the runs directory /x/runs: permission denied');
    const chk = fsErrorToJevCodeError(errno('ENOENT'), { op: 'run-dir', path: '/runs/r1' });
    expect(chk).toBeInstanceOf(CheckpointError);
    expect(chk?.exitCode).toBe(3);
  });
  it('an already-typed error keeps its own code, and an unclassified one is left alone', () => {
    const existing = new CheckpointError('corrupt', '/runs/r1');
    expect(fsErrorToJevCodeError(existing)).toBe(existing);
    expect(fsErrorToJevCodeError(new Error('plain'))).toBeNull();
  });
});
