/**
 * TUI-DESIGN §13.1 / §13.3 / §19.0: blocking rows at 2..4 for every kind (the key hints always survive at 80
 * columns); the §24 strings; the detail round trips incl. the checkpoint-degraded fallbacks; §14.1 bidi
 * controls never reach a row; rows are cut in cells; purity; the severity → surface map.
 */
import { describe, expect, it } from 'vitest';
import type { BlockingKind, BlockingRequest, EngineEvent } from '../../../../src/core/types.js';
import { stringWidth } from '../../../../src/tui/composer/width.js';
import {
  BLOCKING_MAX_ROWS,
  CHECKPOINT_DEGRADED_DEFAULT_FILE,
  SEVERITY_SURFACES,
  blockingLines,
  blockingLinesScreenReader,
  blockingRowsFull,
  blockingRowsStructured,
  blockingStatusWord,
  checkpointDegradedDetail,
  clipCodePoints,
  driftDetail,
  formatRetryIn,
  keyRejectedDetail,
  landPreflightDetail,
  leaseConflictDetail,
  parseCheckpointDegradedDetail,
  parseDriftDetail,
  severityOfEvent,
  severityToast,
  surfaceFor,
  terminalSafeLine,
} from '../../../../src/tui/blocking/lines.js';

function req(over: Partial<BlockingRequest> & Pick<BlockingRequest, 'kind'>): BlockingRequest {
  return { id: 'b1', step: 3, detail: '', stop: 'error', exitCode: 5, ...over };
}

const keyRejected = req({ kind: 'key-rejected', side: 'jev', detail: keyRejectedDetail(401, 'User not found.'), sources: ['env JEV_API_KEY', 'file ~/.config/jevcode/credentials.json'], exitCode: 2 });

const ALL_KINDS: readonly BlockingKind[] = ['key-rejected', 'spend-limit', 'jev-unreachable', 'checkpoint-degraded', 'drift', 'sandbox-unavailable', 'land-preflight', 'lease-conflict'];

/** One realistic request per kind, every detail filled (the widest rows). */
function sample(kind: BlockingKind): BlockingRequest {
  switch (kind) {
    case 'key-rejected':
      return keyRejected;
    case 'spend-limit':
      return req({ kind, detail: 'You have reached your specified API usage limits.', exitCode: 5 });
    case 'jev-unreachable':
      return req({ kind, retryInMs: 30_000, detail: 'HTTP 503 service unavailable', exitCode: 5 });
    case 'checkpoint-degraded':
      return req({ kind, step: 1, detail: checkpointDegradedDetail('ENOSPC', 'state.json'), exitCode: 3 });
    case 'drift':
      return req({ kind, detail: driftDetail('jev-1.13', 'jev-1.13-20260901'), exitCode: 2 });
    case 'sandbox-unavailable':
      return req({ kind, exitCode: 6 });
    // TUI-DESIGN-5 §2.11: the two round-5 cards read their facts through the module's own `*Detail` encodings
    case 'land-preflight':
      return req({ kind, detail: landPreflightDetail(7, 2), stop: 'human_pause', exitCode: 4 });
    case 'lease-conflict':
      return req({ kind, detail: leaseConflictDetail({ path: 'src/loop/engine.ts', holder: 'mbp', step: 12, heldMs: 180_000, holderLiveness: 'live' }), stop: 'human_pause', exitCode: 4 });
  }
}

/** The key hints the §24 row of each kind carries. */
const KEYS: Readonly<Record<BlockingKind, readonly string[]>> = {
  'key-rejected': ['[r]', '[l]', '[q]'],
  'spend-limit': ['[q]'],
  'jev-unreachable': ['[r]', '[q]'],
  'checkpoint-degraded': ['[r]', '[c]', '[q]'],
  drift: ['[p]', '[q]'],
  'sandbox-unavailable': ['[q]'],
  // TUI-DESIGN-5 §2.11 / §12 S39, S39c: round 5 owns both rows' strings, twins and keys. `[c] continue` is gone
  // from the lease-conflict card — §2.11's four keys are `[w] wait` · `[r] read-only session` · `[t] relocate to a
  // worktree` · `[q] quit`, and all three answers already exist on `BlockingAnswer` (`wait` / `worktree` / `stop`).
  'land-preflight': ['[c]', '[s]', '[x]'],
  'lease-conflict': ['[w]', '[r]', '[t]', '[q]'],
};

describe('blockingLines (§13.3, §24)', () => {
  it('key rejected: the four rows verbatim at 4, drops the reassurance at 3, title + keys at 2, one joined row at 1', () => {
    expect(blockingLines(keyRejected, 4, 120)).toEqual([
      'jev: key rejected (HTTP 401 — "User not found.")',
      'Set the decider key and retry. Consulted: env JEV_API_KEY, file ~/.config/jevcode/credentials.json',
      'The key is never printed or logged.',
      '[r] retry with the current key   [l] /login   [q] stop (exit 2)',
    ]);
    expect(blockingLines(keyRejected, 3, 120)).toEqual([
      'jev: key rejected (HTTP 401 — "User not found.")',
      'Set the decider key and retry. Consulted: env JEV_API_KEY, file ~/.config/jevcode/credentials.json',
      '[r] retry with the current key   [l] /login   [q] stop (exit 2)',
    ]);
    expect(blockingLines(keyRejected, 2, 120)).toEqual(['jev: key rejected (HTTP 401 — "User not found.")', '[r] retry with the current key   [l] /login   [q] stop (exit 2)']);
    expect(blockingLines(keyRejected, 1, 200)).toEqual(['jev: key rejected (HTTP 401 — "User not found.")  [r] retry with the current key   [l] /login   [q] stop (exit 2)']);
    expect(blockingLines(keyRejected, 0, 80)).toEqual([]);
    expect(blockingLines(keyRejected, -3, 80)).toEqual([]);
    expect(blockingLines(keyRejected, Number.NaN, 80)).toEqual([]);
    // more than 4 rows never renders more than 4
    expect(blockingLines(keyRejected, 9, 120)).toHaveLength(BLOCKING_MAX_ROWS);
    // generator side: the same rows naming the generator key
    const gen = blockingLines(req({ kind: 'key-rejected', side: 'generator', detail: keyRejectedDetail(403, 'forbidden'), exitCode: 2 }), 4, 120);
    expect(gen[0]).toBe('generator: key rejected (HTTP 403 — "forbidden")');
    expect(gen[1]).toBe('Set the generator key and retry. Consulted: none');
  });

  it('the provider message is clipped to 120 chars and flattened to one line', () => {
    const long = `${'x'.repeat(200)}\n\x1b[2Jsecond`;
    const detail = keyRejectedDetail(401, long);
    expect(detail.startsWith('HTTP 401 — "')).toBe(true);
    expect([...detail].length).toBeLessThanOrEqual('HTTP 401 — ""'.length + 120);
    expect(detail.endsWith('…"')).toBe(true);
    expect(detail).not.toContain('\n');
    expect(detail).not.toContain('\x1b');
  });

  it('spend limit: one row; split at the dots when the row is wider than the columns and rows allow', () => {
    const r = sample('spend-limit');
    const one = 'provider: spend limit reached — "You have reached your specified API usage limits." · this keeps failing until access resumes · [q] stop (exit 5)';
    expect(blockingLines(r, 4, 200)).toEqual([one]);
    expect(blockingLines(r, 1, 200)).toEqual([one]);
    expect(blockingLines(r, 3, 90)).toEqual(['provider: spend limit reached — "You have reached your specified API usage limits."', 'this keeps failing until access resumes · [q] stop (exit 5)']);
    // a first part wider than the columns is clipped like every row
    expect(blockingLines(r, 3, 80)[0]).toBe('provider: spend limit reached — "You have reached your specified API usage limi…');
    // the second and third parts share a row while they fit (59 cells at 60 columns), split below that
    expect(blockingLines(r, 4, 60)).toEqual(['provider: spend limit reached — "You have reached your specified API usage limits."'.slice(0, 59) + '…', 'this keeps failing until access resumes · [q] stop (exit 5)']);
    expect(blockingLines(r, 4, 50)).toEqual(['provider: spend limit reached — "You have reached your specified API usage limits."'.slice(0, 49) + '…', 'this keeps failing until access resumes', '[q] stop (exit 5)']);
    // rows = 2: the title and the keys survive, the middle sentence is dropped
    expect(blockingLines(r, 2, 50)).toEqual(['provider: spend limit reached — "You have reached your specified API usage limits."'.slice(0, 49) + '…', '[q] stop (exit 5)']);
    // one row and too narrow: clipped
    expect(stringWidth(blockingLines(r, 1, 40)[0]!)).toBe(40);
  });

  it('jev unreachable: the countdown row, `last:` cause when known, keys inline at 120 and on their own row at 80', () => {
    const r = sample('jev-unreachable');
    expect(blockingLines(r, 4, 120)).toEqual(['jev unreachable after 3 attempts · retrying in 30 s (auto, doubles to 5 min) · [r] now  [q] stop', 'last: HTTP 503 service unavailable']);
    expect(blockingLines(r, 2, 120)).toHaveLength(2);
    // 80 columns: the 96-cell §24 row splits at its dots; the keys are the last row, the cause in the middle
    expect(blockingLines(r, 4, 80)).toEqual(['jev unreachable after 3 attempts · retrying in 30 s (auto, doubles to 5 min)', 'last: HTTP 503 service unavailable', '[r] now  [q] stop']);
    expect(blockingLines(r, 3, 80)).toEqual(['jev unreachable after 3 attempts · retrying in 30 s (auto, doubles to 5 min)', 'last: HTTP 503 service unavailable', '[r] now  [q] stop']);
    expect(blockingLines(r, 2, 80)).toEqual(['jev unreachable after 3 attempts · retrying in 30 s (auto, doubles to 5 min)', '[r] now  [q] stop']);
    // without a cause and with room, the keys join the last title row when they fit
    expect(blockingLines({ ...r, detail: '' }, 4, 120)).toEqual(['jev unreachable after 3 attempts · retrying in 30 s (auto, doubles to 5 min) · [r] now  [q] stop']);
    expect(blockingLines({ ...r, detail: '' }, 4, 80)).toEqual(['jev unreachable after 3 attempts · retrying in 30 s (auto, doubles to 5 min)', '[r] now  [q] stop']);
    expect(blockingLines({ ...r, detail: '' }, 4, 70)).toEqual(['jev unreachable after 3 attempts', 'retrying in 30 s (auto, doubles to 5 min) · [r] now  [q] stop']);
    // narrower still: three title rows before the keys; the cause is the first row dropped
    expect(blockingLines(r, 4, 60)).toEqual(['jev unreachable after 3 attempts', 'retrying in 30 s (auto, doubles to 5 min)', 'last: HTTP 503 service unavailable', '[r] now  [q] stop']);
    expect(blockingLines(r, 3, 60)).toEqual(['jev unreachable after 3 attempts', 'retrying in 30 s (auto, doubles to 5 min)', '[r] now  [q] stop']);
    expect(blockingLines({ ...r, retryInMs: 300_000, detail: '' }, 2, 120)[0]).toContain('retrying in 5 min (auto');
    expect(blockingLines({ ...r, detail: '' }, 1, 120)).toHaveLength(1);
    // retryInMs absent → the 30 s default
    const noMs = req({ kind: 'jev-unreachable' });
    expect(blockingLines(noMs, 2, 120)[0]).toContain('retrying in 30 s');
    expect(formatRetryIn(30_000)).toBe('30 s');
    expect(formatRetryIn(90_000)).toBe('1 min 30 s');
    expect(formatRetryIn(300_000)).toBe('5 min');
    expect(formatRetryIn(-5)).toBe('0 s');
    expect(formatRetryIn(Number.NaN)).toBe('0 s');
    expect(formatRetryIn(Number.POSITIVE_INFINITY)).toBe('0 s');
  });

  it('every kind at 80 columns and rows 2..4 keeps its §24 key hints (would have caught the clipped `[r] now  [q] stop`)', () => {
    for (const kind of ALL_KINDS) {
      for (const rows of [2, 3, 4]) {
        const lines = blockingLines(sample(kind), rows, 80);
        const text = lines.join('\n');
        for (const key of KEYS[kind]) expect(text, `${kind} rows=${rows}`).toContain(key);
        // the keys sit on the last row, whole
        const keys = blockingRowsStructured(sample(kind)).keys;
        expect(lines.at(-1)!.endsWith(keys), `${kind} rows=${rows}: ${lines.at(-1)}`).toBe(true);
      }
    }
  });

  it('checkpoint degraded: four rows; the middle names the file, the consequence (§7.2 edge 6) and the fix (§7.4 item 6)', () => {
    const r = sample('checkpoint-degraded');
    expect(blockingLines(r, 4, 120)).toEqual([
      'checkpoint degraded: ENOSPC on state.json',
      'state.json could not be written since step 1 — the disk is full; this run cannot be resumed.',
      'free space, or pass --runs-dir <dir> on another volume',
      '[r] retry the write   [c] continue without checkpoints   [q] stop now (exit 3)',
    ]);
    expect(blockingLines(r, 2, 120)).toEqual(['checkpoint degraded: ENOSPC on state.json', '[r] retry the write   [c] continue without checkpoints   [q] stop now (exit 3)']);
    expect(checkpointDegradedDetail('EACCES', 'steps.jsonl')).toBe('EACCES on steps.jsonl');
    expect(parseCheckpointDegradedDetail('EACCES on steps.jsonl')).toEqual({ code: 'EACCES', file: 'steps.jsonl' });
    expect(parseCheckpointDegradedDetail('EIO on run dir')).toEqual({ code: 'EIO', file: 'run dir' });
  });

  it('checkpoint degraded: an empty detail or one without ` on ` falls back to state.json', () => {
    const empty = blockingLines(req({ kind: 'checkpoint-degraded', step: 2, detail: '', exitCode: 3 }), 4, 120);
    expect(empty).toEqual([
      `checkpoint degraded: unknown on ${CHECKPOINT_DEGRADED_DEFAULT_FILE}`,
      'state.json could not be written since step 2 — the run cannot be resumed from here.',
      '[r] retry the write   [c] continue without checkpoints   [q] stop now (exit 3)',
    ]);
    const codeOnly = blockingLines(req({ kind: 'checkpoint-degraded', step: 2, detail: 'ENOSPC', exitCode: 3 }), 4, 120);
    expect(codeOnly[0]).toBe('checkpoint degraded: ENOSPC on state.json');
    expect(codeOnly[1]).toBe('state.json could not be written since step 2 — the disk is full; this run cannot be resumed.');
    expect(parseCheckpointDegradedDetail('')).toEqual({ code: 'unknown', file: 'state.json' });
    expect(parseCheckpointDegradedDetail('   ')).toEqual({ code: 'unknown', file: 'state.json' });
    expect(parseCheckpointDegradedDetail('ENOSPC')).toEqual({ code: 'ENOSPC', file: 'state.json' });
    expect(parseCheckpointDegradedDetail('ENOSPC on ')).toEqual({ code: 'ENOSPC on', file: 'state.json' });
    expect(CHECKPOINT_DEGRADED_DEFAULT_FILE).toBe('state.json');
  });

  it('first-call drift: the alias row and the pin key from the detail', () => {
    const r = sample('drift');
    expect(blockingLines(r, 4, 120)).toEqual(['jev: model alias jev-1.13 resolved to jev-1.13-20260901 on the first call', '[p] pin --jev-model jev-1.13-20260901 for the next run   [q] stop (exit 2)']);
    expect(parseDriftDetail('a → b')).toEqual({ configured: 'a', served: 'b' });
    expect(parseDriftDetail('a -> b')).toEqual({ configured: 'a', served: 'b' });
    expect(parseDriftDetail('served-only')).toEqual({ configured: 'served-only', served: 'served-only' });
  });

  it('sandbox unavailable: two rows', () => {
    const r = sample('sandbox-unavailable');
    expect(blockingLines(r, 4, 120)).toEqual(['sandbox: seatbelt requested but sandbox-exec is unavailable', '[q] stop (exit 6)']);
    expect(blockingLines(r, 1, 120)).toEqual(['sandbox: seatbelt requested but sandbox-exec is unavailable  [q] stop (exit 6)']);
  });

  it('every row is cut to the columns in cells (wide characters count two); NaN columns fall back to 80', () => {
    for (const kind of ALL_KINDS) {
      const r = req({ kind, detail: kind === 'drift' ? driftDetail('a', 'b') : kind === 'checkpoint-degraded' ? checkpointDegradedDetail('EIO', 'state.json') : 'detail 日本語 😀 '.repeat(6) });
      for (const rows of [1, 2, 3, 4]) {
        for (const cols of [1, 10, 40, 80, 200]) {
          const lines = blockingLines(r, rows, cols);
          expect(lines.length).toBeGreaterThan(0);
          expect(lines.length).toBeLessThanOrEqual(rows);
          for (const l of lines) expect(stringWidth(l), `${kind} rows=${rows} cols=${cols}`).toBeLessThanOrEqual(cols);
        }
      }
      expect(blockingLines(r, 4, Number.NaN).every((l) => stringWidth(l) <= 80)).toBe(true);
    }
    // a CJK cause is measured in cells, not code points: 40 columns hold 19 wide characters plus the ellipsis
    const cjk = blockingLines(req({ kind: 'jev-unreachable', detail: '日'.repeat(60) }), 4, 40);
    const last = cjk.find((l) => l.startsWith('last:'))!;
    expect(stringWidth(last)).toBeLessThanOrEqual(40);
    expect([...last].length).toBeLessThan(40);
    expect(clipCodePoints('😀😀😀', 2)).toBe('😀…');
    expect(clipCodePoints('abc', 3)).toBe('abc');
    expect(clipCodePoints('abc', 0)).toBe('…');
  });

  it('bidi controls, isolates, U+2028/2029 and C0/C1 in a provider message never reach a row (§14.1)', () => {
    const rlo = String.fromCodePoint(0x202e);
    const lri = String.fromCodePoint(0x2066);
    const pdi = String.fromCodePoint(0x2069);
    const lsep = String.fromCodePoint(0x2028);
    const psep = String.fromCodePoint(0x2029);
    const bom = String.fromCodePoint(0xfeff);
    const nasty = `user${rlo}gnp.exe${lsep}second${lri}x${pdi}${psep}third\x1b[2J\x7f\x85${bom}end`;
    expect(terminalSafeLine(nasty)).toBe('usergnp.exe secondx third[2Jend');
    const forbidden = [rlo, lri, pdi, lsep, psep, bom, '\x1b', '\x7f', '\x85', String.fromCodePoint(0x200f), String.fromCodePoint(0x061c)];
    const requests = [
      req({ kind: 'key-rejected', detail: keyRejectedDetail(401, nasty), sources: [`env ${rlo}X`] }),
      req({ kind: 'spend-limit', detail: nasty }),
      req({ kind: 'jev-unreachable', detail: nasty }),
      req({ kind: 'checkpoint-degraded', detail: `ENOSPC on ${rlo}state.json` }),
      req({ kind: 'drift', detail: driftDetail(`a${rlo}`, `b${lsep}c`) }),
    ];
    for (const r of requests) {
      const text = [...blockingLines(r, 4, 200), ...blockingRowsFull(r), ...blockingLinesScreenReader(r)].join('|');
      for (const f of forbidden) expect(text, r.kind).not.toContain(f);
    }
    // the toast twin
    expect(severityToast('error', `x${rlo}y${lsep}z`, 'c')).toBe('! c: xy z');
    // ordinary text is untouched: tabs and newlines become one space, trimmed
    expect(terminalSafeLine('  a\tb\r\nc  ')).toBe('a b c');
    expect(terminalSafeLine('')).toBe('');
  });

  it('is pure: equal inputs give equal rows, and the request is never mutated', () => {
    const frozen = Object.freeze({ ...sample('jev-unreachable'), sources: Object.freeze(['a']) as unknown as string[] });
    const a = blockingLines(frozen, 4, 80);
    const b = blockingLines(frozen, 4, 80);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(blockingRowsFull(frozen)).toEqual(blockingRowsFull(frozen));
    expect(blockingLinesScreenReader(frozen)).toEqual(blockingLinesScreenReader(frozen));
    expect(frozen.detail).toBe('HTTP 503 service unavailable');
  });

  it('status words and the screen-reader numbered twin', () => {
    expect(blockingStatusWord('jev-unreachable')).toBe('paused: jev unreachable');
    expect(blockingStatusWord('key-rejected')).toBe('paused: key rejected');
    expect(blockingStatusWord('checkpoint-degraded')).toBe('paused: checkpoint degraded');
    expect(blockingStatusWord('spend-limit')).toBe('paused: spend limit');
    expect(blockingStatusWord('drift')).toBe('paused: model drift');
    expect(blockingStatusWord('sandbox-unavailable')).toBe('paused: sandbox unavailable');
    const sr = blockingLinesScreenReader(keyRejected);
    expect(sr[0]).toBe('1 jev: key rejected (HTTP 401 — "User not found.")');
    expect(sr[3]).toBe(blockingRowsFull(keyRejected)[3]);
    // the single-row kinds: reason and cause numbered, keys last and unnumbered
    expect(blockingLinesScreenReader(sample('jev-unreachable'))).toEqual(['1 jev unreachable after 3 attempts · retrying in 30 s (auto, doubles to 5 min)', '2 last: HTTP 503 service unavailable', '[r] now  [q] stop']);
    expect(blockingLinesScreenReader(sample('spend-limit'))).toEqual(['1 provider: spend limit reached — "You have reached your specified API usage limits." · this keeps failing until access resumes', '[q] stop (exit 5)']);
    // blockingRowsFull keeps the §24 text: the single-row kinds are one row (plus the cause)
    expect(blockingRowsFull(sample('spend-limit'))).toHaveLength(1);
    expect(blockingRowsFull(sample('jev-unreachable'))).toEqual(['jev unreachable after 3 attempts · retrying in 30 s (auto, doubles to 5 min) · [r] now  [q] stop', 'last: HTTP 503 service unavailable']);
  });
});

describe('severity → surface (§13.1)', () => {
  it('the table rows as data', () => {
    expect(SEVERITY_SURFACES.info).toEqual({ statusZone: 'none', toastMs: 0, staticItem: 'dim', liveRegion: 'none', overlay: 'none', log: 'info' });
    expect(SEVERITY_SURFACES.notice).toMatchObject({ statusZone: 'progress-word', toastMs: 2000, liveRegion: 'retry-row' });
    expect(SEVERITY_SURFACES.warning).toMatchObject({ statusZone: 'error-badge', toastMs: 2000, staticItem: 'warning', log: 'warn' });
    expect(SEVERITY_SURFACES.error).toMatchObject({ statusZone: 'error-badge', toastMs: 4000, staticItem: 'error', log: 'error' });
    expect(SEVERITY_SURFACES.blocking).toMatchObject({ statusZone: 'paused', toastMs: 0, staticItem: 'red-then-dim', overlay: 'blocking' });
    expect(SEVERITY_SURFACES.fatal).toMatchObject({ statusZone: 'done-error', toastMs: 0, staticItem: 'run-end', liveRegion: 'cleared', log: 'error-and-epilogue' });
    expect(surfaceFor('error')).toBe(SEVERITY_SURFACES.error);
    // only blocking opens an overlay; only fatal clears the live region
    const kinds = Object.keys(SEVERITY_SURFACES) as (keyof typeof SEVERITY_SURFACES)[];
    expect(kinds.filter((k) => SEVERITY_SURFACES[k].overlay === 'blocking')).toEqual(['blocking']);
    expect(kinds.filter((k) => SEVERITY_SURFACES[k].liveRegion === 'cleared')).toEqual(['fatal']);
  });

  it('severityOfEvent classifies the contract events', () => {
    const err = { name: 'E', code: 'internal', message: 'm', exitCode: 1 };
    const cases: [EngineEvent, ReturnType<typeof severityOfEvent>][] = [
      [{ type: 'error', step: 1, error: err, fatal: true }, 'fatal'],
      [{ type: 'error', step: 1, error: err, fatal: false }, 'error'],
      [{ type: 'blocking:request', request: keyRejected }, 'blocking'],
      [{ type: 'retry', side: 'jev', step: 1, stage: 'risk', info: { attempt: 2, maxAttempts: 3, waitMs: 1000, retryAfter: false, cause: { kind: 'http', status: 429, code: null, message: 'rate limited' } } }, 'notice'],
      [{ type: 'retry:settled', side: 'jev', step: 1, attempts: 3, ok: true, totalWaitMs: 2000 }, 'notice'],
      [{ type: 'retry:settled', side: 'jev', step: 1, attempts: 3, ok: false, totalWaitMs: 2000 }, 'warning'],
      [{ type: 'retry:settled', side: 'jev', step: 1, attempts: 3, ok: true, totalWaitMs: 10_001 }, 'warning'],
      [{ type: 'notice', step: null, kind: 'offline', level: 'warn', text: 'offline' }, 'notice'],
      [{ type: 'notice', step: null, kind: 'online', level: 'info', text: 'back' }, 'notice'],
      [{ type: 'notice', step: 2, kind: 'checkpoint:degraded', level: 'warn', text: 'x' }, 'error'],
      [{ type: 'notice', step: null, kind: 'ui', level: 'info', text: 'x', label: '[ui]' }, 'info'],
      [{ type: 'notice', step: null, kind: 'config', level: 'warn', text: 'x' }, 'warning'],
      [{ type: 'notice', step: null, kind: 'lock', level: 'error', text: 'x' }, 'error'],
      [{ type: 'transcript', step: 1, level: 'warn', text: 'w' }, 'warning'],
      [{ type: 'transcript', step: 1, level: 'info', text: 'i' }, 'info'],
      [{ type: 'status', status: { step: 1, maxSteps: 2, wallMs: 0, maxWallMs: 1, stage: 'idle', spend: { generator: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, jev: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, totalUsd: 0, capUsd: 1, exceeded: false }, stopReason: null } }, null],
      [{ type: 'pause:requested', step: 1 }, null],
    ];
    for (const [e, expected] of cases) expect(severityOfEvent(e), e.type).toBe(expected);
  });

  it('toast text: `! <short>` for warnings, `! <code>: <short>` for errors, none otherwise', () => {
    expect(severityToast('warning', 'retry chain: 3 attempts')).toBe('! retry chain: 3 attempts');
    expect(severityToast('error', 'Jev HTTP 500', 'jev_http')).toBe('! jev_http: Jev HTTP 500');
    expect(severityToast('error', 'x')).toBe('! x');
    expect(severityToast('info', 'x')).toBeNull();
    expect(severityToast('blocking', 'x')).toBeNull();
    expect([...severityToast('warning', 'y'.repeat(200))!].length).toBeLessThanOrEqual(62);
  });
});

/**
 * TUI-DESIGN-4 §7.10 (P-D10) item 3: the peer-lease pane, and item 2's session-open notice.
 *
 * It is **not** a `BlockingKind`: the registry is another design's (`docs/COORDINATION-DESIGN.md`) and contract 1.7
 * adds no blocking kind, so nothing in `core/types.ts` moves for it — the rows go through the same structure and
 * the same fitter.
 */
describe('the peer-lease pane (§7.10 item 3)', () => {
  const view = (o: Partial<{ live: number; stale: number; oldestStartedMsAgo: number | null; exclusive: boolean }> = {}) => ({
    live: 2,
    stale: 0,
    oldestStartedMsAgo: 240_000,
    exclusive: true,
    ...o,
  });

  it('a live exclusive lease offers wait / read-only / quit', async () => {
    const { PEER_LEASE_KEYS, peerLeaseLines, peerLeaseRows } = await import('../../../../src/tui/blocking/lines.js');
    const rows = peerLeaseRows(view());
    expect(rows.keys).toBe(PEER_LEASE_KEYS);
    expect(rows.keys).toBe('[w] wait for it   [r] read-only session   [q] quit');
    const lines = peerLeaseLines(view(), 4, 120);
    expect(lines[0]).toBe('another jevcode holds this workspace (2 here)');
    expect(lines[lines.length - 1]).toBe(PEER_LEASE_KEYS);
  });

  it('edge 1: a stale entry from a killed instance never blocks — it offers [c] continue', async () => {
    const { PEER_STALE_KEYS, peerLeaseLines } = await import('../../../../src/tui/blocking/lines.js');
    const lines = peerLeaseLines(view({ live: 1, stale: 1, exclusive: true }), 4, 120);
    expect(lines[0]).toContain('1 stale entry');
    expect(lines[lines.length - 1]).toBe(PEER_STALE_KEYS);
    expect(PEER_STALE_KEYS).toBe('[c] continue');
    // not exclusive: informational only, never the wait keys
    expect(peerLeaseLines(view({ exclusive: false, stale: 2 }), 4, 120).at(-1)).toBe(PEER_STALE_KEYS);
  });

  it('every row fits the columns, at every slot height, and the keys always survive', async () => {
    const { peerLeaseLines } = await import('../../../../src/tui/blocking/lines.js');
    for (const columns of [20, 40, 60, 80, 120]) {
      for (const rows of [1, 2, 3, 4]) {
        const out = peerLeaseLines(view({ stale: 3 }), rows, columns);
        expect(out.length, `${columns}x${rows}`).toBeLessThanOrEqual(rows);
        for (const r of out) expect(stringWidth(r), `${columns}x${rows}: ${r}`).toBeLessThanOrEqual(columns);
      }
    }
    expect(peerLeaseLines(view(), 0, 80)).toEqual([]);
  });

  it('item 2 / §12: the session-open notice names /peers, which is a real command this round', async () => {
    const { peerAgoText, peerOpenNotice } = await import('../../../../src/tui/blocking/lines.js');
    expect(peerOpenNotice(view({ oldestStartedMsAgo: 240_000 }))).toBe('another jevcode is working in this workspace (started 4m ago) — /peers lists them');
    expect(peerOpenNotice(view({ oldestStartedMsAgo: null }))).toBe('another jevcode is working in this workspace — /peers lists them');
    // the only instance, or the registry absent: no notice
    expect(peerOpenNotice(view({ live: 1 }))).toBeNull();
    expect(peerOpenNotice(null)).toBeNull();
    expect(peerAgoText(0)).toBe('0s');
    expect(peerAgoText(59_000)).toBe('59s');
    expect(peerAgoText(60_000)).toBe('1m');
    expect(peerAgoText(3 * 3600_000 + 60_000)).toBe('3h');
  });
});
