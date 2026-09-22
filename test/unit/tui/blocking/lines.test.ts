/**
 * TUI-DESIGN-5 §2.11 / §12 S39–S39c / §7 rows 34, 95–97 (R5-2): the two panes contract 1.4/1.5's `BlockingKind`
 * words made reachable — `lease-conflict` and `land-preflight`. D-AF's request (§8.2 R1) **landed** at `c7087e2`
 * with its four placeholder consumers, so round 5 restyles them on the real members and there is no `it.skip`
 * left: the skip §10 asked for would now be a lie about the tree.
 */
import { describe, expect, it } from 'vitest';
import type { BlockingRequest } from '../../../../src/core/types.js';
import { stringWidth } from '../../../../src/tui/composer/width.js';
import { GLYPHS, glyphSet } from '../../../../src/tui/glyphs.js';
import {
  LAND_PREFLIGHT_KEY_RUNGS,
  LEASE_CONFLICT_KEY_RUNGS,
  LEASE_STALE_KEY_RUNGS,
  beatAgoText,
  blockingLines,
  blockingLinesScreenReader,
  blockingRowsFull,
  blockingRowsStructured,
  landPreflightDetail,
  landPreflightRows,
  leaseConflictDetail,
  leaseConflictOpens,
  leaseConflictRows,
  leaseGoneNotice,
  parseLandPreflightDetail,
  parseLeaseConflictDetail,
  waitArmedKey,
  waitElapsedText,
  type LeaseConflictState,
} from '../../../../src/tui/blocking/lines.js';

const HELD: LeaseConflictState = { path: 'src/loop/engine.ts', holder: 'mbp', step: 12, heldMs: 180_000, holderLiveness: 'live' };

function req(kind: BlockingRequest['kind'], detail: string): BlockingRequest {
  return { id: 'b1', step: 12, kind, detail, stop: 'human_pause', exitCode: 4 };
}

describe('the lease-conflict card (TUI-DESIGN-5 §2.11, §12 S39)', () => {
  it('renders §2.11 verbatim at full width: the title names the path, the holder, the step and the age', () => {
    const rows = leaseConflictRows(HELD);
    expect(rows.title).toEqual(['another session holds src/loop/engine.ts (mbp, step 12, 3 m)']);
    expect(rows.keys).toBe('[w] wait for it   [r] read-only session   [t] relocate to a worktree   [q] quit');
    expect(rows.inline).toBe(false);
    expect(blockingRowsFull(req('lease-conflict', leaseConflictDetail(HELD)))).toEqual([
      'another session holds src/loop/engine.ts (mbp, step 12, 3 m)',
      '[w] wait for it   [r] read-only session   [t] relocate to a worktree   [q] quit',
    ]);
  });

  it('the keys row takes the widest of four rungs that fits — and every rung keeps all four keys', () => {
    expect(LEASE_CONFLICT_KEY_RUNGS).toHaveLength(4);
    const seen = LEASE_CONFLICT_KEY_RUNGS.map((r, i) => [i, leaseConflictRows(HELD, stringWidth(r)).keys]);
    for (const [i, keys] of seen) expect(keys, `rung ${String(i)}`).toBe(LEASE_CONFLICT_KEY_RUNGS[i as number]);
    // one cell narrower than a rung takes the next one down; below the last rung the last one stands (fitRung's rule)
    expect(leaseConflictRows(HELD, stringWidth(LEASE_CONFLICT_KEY_RUNGS[0] as string) - 1).keys).toBe(LEASE_CONFLICT_KEY_RUNGS[1]);
    expect(leaseConflictRows(HELD, 1).keys).toBe(LEASE_CONFLICT_KEY_RUNGS[3]);
    // every rung offers the same four answers — `w` (wait), `r` (read-only), `t` (worktree), `q` (quit)
    for (const rung of LEASE_CONFLICT_KEY_RUNGS) for (const k of ['w', 'r', 't', 'q']) expect(rung, rung).toMatch(new RegExp(`\\b${k}\\b`));
    // widest first, each strictly narrower than the one above it
    const widths = LEASE_CONFLICT_KEY_RUNGS.map((r) => stringWidth(r));
    expect(widths).toEqual([...widths].sort((a, b) => b - a));
    expect(new Set(widths).size).toBe(widths.length);
  });

  it('§7 row 95 / §12 S39a: a holder that stops beating re-renders the card as ONE row and `[w]` changes meaning', () => {
    for (const liveness of ['stale', 'stale-reused-pid'] as const) {
      const rows = leaseConflictRows({ ...HELD, holderLiveness: liveness, beatAgeMs: 120_000 });
      expect(rows.title, liveness).toEqual(['the holder stopped beating 2 m ago']);
      expect(rows.keys, liveness).toBe('[w] take it  [r] read-only  [q] quit');
      // §12 S39a and §2.13's 80-column cell are ONE row joined by an em dash, not two rows
      expect(rows.inline, liveness).toBe(true);
      expect(rows.joiner, liveness).toBe(' — ');
      const r = req('lease-conflict', leaseConflictDetail({ ...HELD, holderLiveness: liveness }));
      expect(blockingRowsFull(r), liveness).toEqual(['the holder stopped beating 3 m ago — [w] take it  [r] read-only  [q] quit']);
      // …and at 80 columns, which is what §2.13's cell measures, the renderer keeps it as one row
      expect(blockingLines(r, 4, 80), liveness).toEqual(['the holder stopped beating 3 m ago — [w] take it  [r] read-only  [q] quit']);
      // `[t] relocate` is gone: there is nothing live to relocate away from
      expect(rows.keys, liveness).not.toContain('[t]');
    }
    // the S39a string exactly as §12 writes it, with the 2 m age of §7 row 95
    expect(blockingRowsFull(req('lease-conflict', leaseConflictDetail({ ...HELD, heldMs: 120_000, holderLiveness: 'stale' })))[0]).toBe(
      'the holder stopped beating 2 m ago — [w] take it  [r] read-only  [q] quit',
    );
    expect(LEASE_STALE_KEY_RUNGS[0]).toBe('[w] take it  [r] read-only  [q] quit');
    // an `unknown` verdict stays permissive and keeps the live card (unknown never denies, §2.1 rule 4's discipline)
    expect(leaseConflictRows({ ...HELD, holderLiveness: 'unknown' }).keys).toBe(LEASE_CONFLICT_KEY_RUNGS[0]);
    expect(leaseConflictRows({ ...HELD, holderLiveness: 'unknown' }).inline).toBe(false);
  });

  it('§7 row 96: an armed `[w]` shows its elapsed counter and its escape, so the wait can always be woken', () => {
    const rows = leaseConflictRows({ ...HELD, waitingMs: 134_000 }, 200);
    expect(rows.keys.startsWith('[w] waiting 2m14s — Esc gives up')).toBe(true);
    expect(waitArmedKey(134_000)).toBe('[w] waiting 2m14s — Esc gives up');
    expect(waitArmedKey(134_000, glyphSet({ ascii: true }))).toBe('[w] waiting 2m14s - Esc gives up');
    // at a width that fits only the clause, the clause alone survives — the escape is never the thing that is cut
    expect(leaseConflictRows({ ...HELD, waitingMs: 134_000 }, stringWidth(waitArmedKey(134_000))).keys).toBe(waitArmedKey(134_000));
    expect([waitElapsedText(41_000), waitElapsedText(134_000), waitElapsedText(3_720_000)]).toEqual(['41s', '2m14s', '1h02m']);
    expect(waitElapsedText(Number.NaN)).toBe('0s');
  });

  it('§7 row 97 / §12 S39b: a `gone` holder is not a conflict — the pane never opens and one `[ui]` line records it', () => {
    expect(leaseConflictOpens('gone')).toBe(false);
    for (const l of ['live', 'stale', 'stale-reused-pid', 'unknown'] as const) expect(leaseConflictOpens(l), l).toBe(true);
    expect(leaseGoneNotice('mbp', '14:02')).toBe('took a lease left by a session that is gone (mbp, 14:02)');
    // hostile text can never move the cursor or split the row
    expect(leaseGoneNotice('m\u001b[2Jbp\n', '14:02')).toBe('took a lease left by a session that is gone (m[2Jbp, 14:02)');
  });

  it('the detail round-trips, and an unparseable detail still names a holder rather than an empty cell', () => {
    expect(parseLeaseConflictDetail(leaseConflictDetail(HELD))).toEqual(HELD);
    expect(leaseConflictDetail(HELD)).toBe('src/loop/engine.ts|mbp|12|180000|live');
    expect(parseLeaseConflictDetail('src/a.ts')).toEqual({ path: 'src/a.ts', holder: 'another session', step: null, heldMs: null, holderLiveness: 'live' });
    expect(parseLeaseConflictDetail('')).toEqual({ path: '', holder: 'another session', step: null, heldMs: null, holderLiveness: 'live' });
    expect(parseLeaseConflictDetail('src/a.ts|mbp|x|y|nonsense')).toEqual({ path: 'src/a.ts', holder: 'mbp', step: null, heldMs: null, holderLiveness: 'unknown' });
    // the facts the beat did not carry are omitted, never rendered as a blank or a zero
    expect(leaseConflictRows({ path: 'src/a.ts', holder: 'mbp', step: null, heldMs: null, holderLiveness: 'live' }).title).toEqual(['another session holds src/a.ts (mbp)']);
  });
});

describe('the land pre-flight card (TUI-DESIGN-5 §2.11, §12 S39c)', () => {
  it('renders S39c verbatim as one row, joined by an em dash and not the ` · ` every other inline kind uses', () => {
    const rows = landPreflightRows(7, 2);
    expect(rows.inline).toBe(true);
    expect(rows.joiner).toBe(' — ');
    expect(blockingRowsFull(req('land-preflight', landPreflightDetail(7, 2)))).toEqual([
      "7 uncommitted files, 2 inside an agent's slice — [c] commit them  [s] stash them  [x] cancel the land",
    ]);
    expect(blockingLines(req('land-preflight', landPreflightDetail(7, 2)), 4, 120)).toEqual([
      "7 uncommitted files, 2 inside an agent's slice — [c] commit them  [s] stash them  [x] cancel the land",
    ]);
  });

  it("the keys are `Engine.land(input, ask?)`'s three, at four rungs, and the count agrees with the noun", () => {
    expect(LAND_PREFLIGHT_KEY_RUNGS).toHaveLength(4);
    for (const rung of LAND_PREFLIGHT_KEY_RUNGS) for (const k of ['c', 's', 'x']) expect(rung, rung).toMatch(new RegExp(`\\b${k}\\b`));
    expect(landPreflightRows(1, 0).title).toEqual(["1 uncommitted file, 0 inside an agent's slice"]);
    expect(landPreflightRows(0, 0).title).toEqual(["0 uncommitted files, 0 inside an agent's slice"]);
    expect(landPreflightRows(7, 2, 40).keys).toBe(LAND_PREFLIGHT_KEY_RUNGS[1]);
    expect(landPreflightRows(7, 2, 1).keys).toBe(LAND_PREFLIGHT_KEY_RUNGS[3]);
    expect(parseLandPreflightDetail(landPreflightDetail(7, 2))).toEqual({ dirty: 7, inSlice: 2 });
    expect(parseLandPreflightDetail('nonsense')).toEqual({ dirty: 0, inSlice: 0 });
    expect(landPreflightRows(Number.NaN, -3).title).toEqual(["0 uncommitted files, 0 inside an agent's slice"]);
  });
});

describe('both panes through the shared fitting, twins and width rules', () => {
  const cases: readonly [string, BlockingRequest][] = [
    ['lease-conflict', req('lease-conflict', leaseConflictDetail(HELD))],
    ['land-preflight', req('land-preflight', landPreflightDetail(7, 2))],
  ];

  it.each(cases)('%s: no row exceeds the columns at 20…200, and EVERY key letter survives (the fix pass)', (name, r) => {
    // the letters the pane's answers are keyed by — a modal that loses one of these has no visible way out
    const letters = name === 'lease-conflict' ? ['w', 'r', 't', 'q'] : ['c', 's', 'x'];
    for (let cols = 20; cols <= 200; cols += 1) {
      for (const rows of [1, 2, 3, 4]) {
        const lines = blockingLines(r, rows, cols);
        expect(lines.length, `${name} ${cols}x${rows}`).toBeLessThanOrEqual(rows);
        for (const l of lines) expect(stringWidth(l), `${name} ${cols}x${rows}: ${l}`).toBeLessThanOrEqual(cols);
        const last = lines[lines.length - 1] ?? '';
        expect(last.length, `${name} ${cols}x${rows}`).toBeGreaterThan(0);
        // the overlay never gives a blocking card fewer than two rows (`Overlay.tsx:151`'s `Math.max(2, …)`), and
        // at one row nothing can carry both the reason and four keys — so the promise is asserted from two up
        if (rows >= 2) {
          const joined = lines.join(' ');
          for (const k of letters) expect(joined, `${name} ${cols}x${rows}: ${joined}`).toMatch(new RegExp(`\\b${k}\\b`));
        }
      }
    }
  });

  it.each(cases)('%s: the keys rung is picked from the WIDTH, not always rung 0 (the fix pass)', (name, r) => {
    const rungs = name === 'lease-conflict' ? LEASE_CONFLICT_KEY_RUNGS : LAND_PREFLIGHT_KEY_RUNGS;
    // the widest rung at 200 columns, the narrowest at 20 — `blockingRowsStructured` used to answer rung 0 at both
    expect(blockingRowsStructured(r, 200).keys, name).toBe(rungs[0]);
    expect(blockingRowsStructured(r, 20).keys, name).toBe(rungs[rungs.length - 1]);
    expect(blockingRowsStructured(r).keys, name).toBe(rungs[0]);
    // and the same rung reaches the rendered rows
    expect(blockingLines(r, 4, 20).join(' '), name).toContain(rungs[rungs.length - 1]);
  });

  it.each(cases)('%s: the `--ascii` twin is produced by the render path itself, not by the caller', (name, r) => {
    const ascii = glyphSet({ ascii: true });
    for (const line of [...blockingRowsFull(r, ascii), ...blockingLines(r, 4, 200, ascii), ...blockingLinesScreenReader(r, ascii)]) {
      expect(line.replace(/·/g, '-'), `${name}: ${line}`).toMatch(/^[\x20-\x7e]*$/);
      expect(line, `${name}: ${line}`).not.toContain('—');
    }
  });

  it('§12 S39c: `land-preflight` keeps its em dash for everyone else, and only the ascii set folds it', () => {
    const r = req('land-preflight', landPreflightDetail(7, 2));
    expect(blockingRowsFull(r).join(' ')).toContain(' — ');
    expect(blockingRowsFull(r, glyphSet({ ascii: true }))).toEqual([
      "7 uncommitted files, 2 inside an agent's slice - [c] commit them  [s] stash them  [x] cancel the land",
    ]);
    // the screen-reader set keeps the unicode cells (`glyphSet({ screenReader: true })`, §14.1)
    expect(blockingRowsFull(r, GLYPHS.sr).join(' ')).toContain(' — ');
  });

  it('§12 S39a under `--ascii`: the stale card folds its em dash too', () => {
    const stale = req('lease-conflict', leaseConflictDetail({ ...HELD, heldMs: 120_000, holderLiveness: 'stale' }));
    expect(blockingRowsFull(stale, glyphSet({ ascii: true }))).toEqual(['the holder stopped beating 2 m ago - [w] take it  [r] read-only  [q] quit']);
  });

  it.each(cases)('%s: the screen-reader twin numbers the reason and leaves the keys row unnumbered', (name, r) => {
    const sr = blockingLinesScreenReader(r);
    expect(sr[0]?.startsWith('1 '), name).toBe(true);
    expect(sr[sr.length - 1], name).toBe(blockingRowsStructured(r).keys);
  });

  it('the landed kinds are untouched by the joiner (every other inline kind still joins with ` · `)', () => {
    const spend = blockingRowsFull({ id: 'b', step: 1, kind: 'spend-limit', detail: 'limit', stop: 'error', exitCode: 5 });
    expect(spend[0]).toBe('provider: spend limit reached — "limit" · this keeps failing until access resumes · [q] stop (exit 5)');
    expect(blockingRowsStructured({ id: 'b', step: 1, kind: 'spend-limit', detail: 'limit', stop: 'error', exitCode: 5 }).joiner).toBeUndefined();
  });

  it('§12 S39 / S3: the coarse age words carry the space §12 writes, and are not `peerAgoText`', () => {
    expect([beatAgoText(41_000), beatAgoText(180_000), beatAgoText(7_200_000)]).toEqual(['41 s', '3 m', '2 h']);
    expect(beatAgoText(-5)).toBe('0 s');
    expect(beatAgoText(Number.NaN)).toBe('0 s');
  });

  it('neither pane names an exit code: `[q]` / `[x]` choose between resumable outcomes, not "the run is over"', () => {
    for (const [name, r] of cases) expect(blockingRowsStructured(r).keys, name).not.toMatch(/exit \d/);
  });

  it('the cards are glyph-agnostic except for the em dash, which folds under --ascii', () => {
    expect(landPreflightRows(7, 2, 200, glyphSet({ ascii: true })).joiner).toBe(' - ');
    expect(landPreflightRows(7, 2, 200, GLYPHS.sr).joiner).toBe(' — ');
    expect(leaseConflictRows(HELD).title[0]).toMatch(/^[\x20-\x7e]*$/);
    for (const rung of [...LEASE_CONFLICT_KEY_RUNGS, ...LAND_PREFLIGHT_KEY_RUNGS, ...LEASE_STALE_KEY_RUNGS]) {
      // only the narrowest rungs carry `·`, which has a twin; nothing else is outside ASCII
      expect(rung.replace(/·/g, '-')).toMatch(/^[\x20-\x7e]*$/);
    }
  });
});
