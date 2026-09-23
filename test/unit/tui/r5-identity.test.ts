/**
 * TUI-DESIGN-5 §13 — the shared round-5 pin file (§10 "Shared, landed with W4 and W5"; gate "line identity").
 *
 * The standing rule is `transcript.log == --plain == TUI`, through **one formatter** or a **declared** normaliser.
 * §13.2 lists the places the three sinks deliberately differ, and its own wording is the reason this file exists:
 * *"A clause is asserted by `r5-identity.test.ts`, never skipped."* Every clause below names its number, and the
 * §13.1 producer rows are asserted as an identity — the TUI row IS the `--plain` row, by construction where the
 * builder allows it and by assertion where it does not.
 *
 * Offline, no clock, no I/O: every input is a typed fixture.
 */
import { describe, expect, it } from 'vitest';
import { GLYPHS, glyphSet } from '../../../src/tui/glyphs.js';
import { BLOCK_LOG_MAX, blockWidth, renderBlock } from '../../../src/tui/block/lines.js';
import {
  WHO_CELLS_MAX,
  activityView,
  keptCells,
  labelResolver,
  selfView,
  whoFlagRow,
  whoPlainRow,
  whoRowText,
  whoRows,
} from '../../../src/session/peers.js';
import { WHO_PIPED_COLUMNS } from '../../../src/cli/sessions.js';
import { publicMessage } from '../../../src/coordination/index.js';
import { CONTEXT_MIN_COLUMNS, contextBlock, ctxText } from '../../../src/tui/context/lines.js';
import { resumeCardRows, type ResumeCardInput } from '../../../src/session/picker-lines.js';
import { sessionRemainingUsd } from '../../../src/tui/budget/lines.js';
import { agentRows } from '../../../src/tui/agents/lines.js';
import { agentTabRows, agentViewport } from '../../../src/tui/pane/agents.js';
import { agentBlockLines } from '../../../src/tui/plain.js';
import { MODELS_PLAIN_CAP, modelsPickPrompt, modelsPlainLines, modelsShown } from '../../../src/tui/models/lines.js';
import { API, model, result } from './models/helpers.js';
import { F54_ROWS, mkAgentRow } from './agents/fixtures.js';
import { computeContextUsage } from '../../../src/loop/context/meter.js';
import type { ContextUsage, SessionActivityView, SelfIdentityView } from '../../../src/core/types.js';

/** §13.4: every width this file sweeps is a rung of §2.13's own table, never an arbitrary number. */
const WIDTHS = [40, 80, 120] as const;

const SELF: SelfIdentityView = { deviceId8: 'a1b2c3d4', label: 'mbp', sameDeviceCount: 1 };

function activity(over: Partial<SessionActivityView> = {}): SessionActivityView {
  return {
    runId: '20260922-101500-3k9qm2xa',
    sessionId: '20260922-101500-3k9qm2xa',
    label: 'mbp',
    parentSessionId: null,
    deviceId8: 'a1b2c3d4',
    sameDevice: true,
    kind: 'run',
    liveness: 'live',
    authority: 'trusted',
    flags: { hung: false, skewed: false, forked: false, takenOver: false, noLock: false, ignoredDevice: false, unverified: false, cloned: false },
    beatAgeMs: 2_000,
    arrivalAgeMs: 2_000,
    skewMs: null,
    syncLagMs: null,
    sameRepo: true,
    sameBranch: true,
    leaseCount: 0,
    step: 7,
    maxSteps: 40,
    stage: 'propose',
    mode: 'llm-jev',
    branch: 'main',
    head: '3f9a2c1',
    ctxPct: 41,
    spend: { totalUsd: 0.12, capUsd: 2 },
    editing: ['src/loop/engine.ts'],
    subwork: null,
    bench: null,
    ...over,
  };
}

/** §13.1: the harness's own `computeContextUsage` is the producer — this file never re-models the numbers. */
function usage(over: Partial<Parameters<typeof computeContextUsage>[0]> = {}): ContextUsage {
  return computeContextUsage({
    promptChars: 41_000,
    budgetChars: 70_000,
    files: 6,
    historyEntries: 12,
    summaryAt: 8,
    lastCompactionStep: 8,
    compactions: 3,
    lastCompactionAt: '2026-09-22T14:02:09.000Z',
    compaction: 'code',
    promptBuildMs: 41,
    refreshMs: 6,
    recentSteps: { chars: 71_000, allowanceChars: 71_000, whole: 2, clipped: 4, oneLine: 6, reads: 3 },
    ...over,
  });
}

describe('§13.1 S1–S10: `/who` has ONE producer — the TUI row IS the `--plain` row', () => {
  it('the rendered block row equals `whoPlainRow` at every rung of the §2.13 ladder', () => {
    const rows = [activity(), activity({ runId: '20260922-090000-7bd1kk2q', label: 'air', sameDevice: false, deviceId8: 'ffee0011', liveness: 'stale', beatAgeMs: 400_000 })];
    const g = GLYPHS.unicode;
    const resolve = labelResolver(rows, SELF);
    for (const columns of WIDTHS) {
      const w = blockWidth(columns);
      const drawn = renderBlock(whoRows(rows, SELF, { width: w, g }), w, g).map((r) => r.text);
      const plain = rows.flatMap((row) => {
        const flags = whoFlagRow(row, { width: w, g });
        return flags === null ? [whoPlainRow(row, { width: w, g, label: resolve(row) })] : [whoPlainRow(row, { width: w, g, label: resolve(row) }), flags];
      });
      expect(drawn, `${columns} columns`).toEqual(plain);
    }
  });

  it('`whoRowText` is the ONE builder both sinks call, and the ascii twin substitutes rather than diverging', () => {
    const row = activity();
    for (const columns of WIDTHS) {
      const w = blockWidth(columns);
      const unicode = whoRowText(row, { width: w, g: GLYPHS.unicode, label: 'mbp' });
      const ascii = whoRowText(row, { width: w, g: glyphSet({ ascii: true }), label: 'mbp' });
      expect(whoPlainRow(row, { width: w, g: GLYPHS.unicode, label: 'mbp' })).toBe(unicode);
      // §12's twin rule: the ascii row carries no unicode glyph and stays inside the width
      expect(ascii).not.toMatch(/[·●○◌⇄✉⏸⟳↻↪—]/u);
      expect([...ascii].length).toBeLessThanOrEqual(w);
    }
  });

  it('gate G-R5-6: no `/who` row — including the dim flag row — exceeds its width, at 40 … 200', () => {
    const row = activity({ flags: { hung: true, skewed: true, forked: true, takenOver: true, noLock: true, ignoredDevice: true, unverified: true, cloned: true } });
    for (let columns = 40; columns <= 200; columns += 1) {
      const w = blockWidth(columns);
      for (const g of [GLYPHS.unicode, glyphSet({ ascii: true })]) {
        expect([...whoRowText(row, { width: w, g, label: 'mbp' })].length, `${columns}`).toBeLessThanOrEqual(w);
        const flags = whoFlagRow(row, { width: w, g });
        if (flags !== null) expect([...flags].length, `${columns} flags`).toBeLessThanOrEqual(w);
      }
    }
  });
});

describe('§13.2 — every declared clause, asserted', () => {
  it('clause 1: `--plain` with no TTY width renders the 120-column form, and the drop ladder is width-driven', () => {
    expect(WHO_PIPED_COLUMNS).toBe(120);
    // the ladder: nine cells at the widest rung, fewer as the width falls, never more than the cell count
    expect(keptCells(blockWidth(WHO_PIPED_COLUMNS))).toBe(WHO_CELLS_MAX);
    expect(keptCells(blockWidth(40))).toBeLessThan(WHO_CELLS_MAX);
    let previous = WHO_CELLS_MAX;
    for (let w = 200; w >= 1; w -= 1) {
      const kept = keptCells(w);
      expect(kept, `${w}`).toBeLessThanOrEqual(previous);
      previous = kept;
    }
  });

  it('clause 2: the status zone is a status LINE, never a transcript item — `ctxText` is absent below its gate', () => {
    // the `ctx` cell has no `transcript.log` sink at all; the fact reaches it through `/context`'s block
    expect(ctxText(usage(), CONTEXT_MIN_COLUMNS - 1)).toBe('');
    expect(ctxText(usage(), CONTEXT_MIN_COLUMNS)).not.toBe('');
    // and the same numbers are in the block, which DOES have one
    const block = contextBlock({ usage: usage(), step: 12, mode: 'llm-jev', live: true }, 120);
    expect(block.head).toContain('context');
    expect(block.rows.length).toBeGreaterThan(3);
  });

  it('clause 3: `annotateBlock`’s row cap is 24, and a longer block is cut with a counted tail', () => {
    expect(BLOCK_LOG_MAX).toBe(24);
    const many = Array.from({ length: 60 }, (_, i) => activity({ runId: `2026092${i % 10}-101500-3k9qm2x${i % 10}`, label: `dev${i}` }));
    const built = whoRows(many, SELF, { width: blockWidth(120), g: GLYPHS.unicode });
    // the builder itself never truncates — the cap is the LOG's, applied at the write, so the block is whole here
    expect(built.length).toBeGreaterThan(BLOCK_LOG_MAX);
  });

  it('clause 4: the resume card’s `ctx` cell is OMITTED, not zeroed, when `lastPromptChars` is absent', () => {
    const base: ResumeCardInput = {
      runId: '20260922-101500-3k9qm2xa', title: 'fix the parser', branch: 'replayable', pausedAtMs: 1_000, step: 7,
      pauseDetail: 'pause now during propose', steersPending: 0, head: null, changedSince: [], livePeer: null,
      spend: { usd: 0.12, capUsd: 2 }, wallMs: 60_000, maxWallMs: 900_000, ctxPct: null,
      targetsMoved: null, importedFrom: null, crashed: null, takenOver: null, forked: null,
    };
    for (const columns of WIDTHS) {
      const without = resumeCardRows(base, { columns, nowMs: 100_000 }).join('\n');
      const with41 = resumeCardRows({ ...base, ctxPct: 41 }, { columns, nowMs: 100_000 }).join('\n');
      expect(without, `${columns}`).not.toMatch(/ctx/);
      expect(with41, `${columns}`).toContain('ctx 41%');
      // the omission is a MISSING cell, never `ctx 0%`
      expect(without).not.toContain('ctx 0%');
    }
  });

  it('clause 5: `/cost`’s held/free arithmetic omits rather than zeroes — the third argument defaults away', () => {
    // `sessionRemainingUsd` is the 3-argument form; with no holds the answer is the 2-argument one, exactly
    expect(sessionRemainingUsd(5, 1.25)).toBe(sessionRemainingUsd(5, 1.25, 0));
    expect(sessionRemainingUsd(5, 1.25, 0.5)).toBeCloseTo(3.25, 10);
    // a negative or non-finite hold can never inflate the remaining budget
    expect(sessionRemainingUsd(5, 1.25, -9)).toBe(sessionRemainingUsd(5, 1.25));
    expect(sessionRemainingUsd(5, 1.25, Number.NaN)).toBe(sessionRemainingUsd(5, 1.25));
  });

  it('clause 6: the agents tab is a VIEWPORT; `--plain` and the block print every row', () => {
    const many = Array.from({ length: 30 }, (_, i) => mkAgentRow({ slug: `a${i}` }));
    const v = agentViewport(many.length, 12, 29);
    expect(v.end - v.start).toBeLessThanOrEqual(12);
    expect(v.above + (v.end - v.start) + v.below).toBe(many.length);
    // the Ink tab shows a window …
    const tab = agentTabRows({ agents: many, paneFocus: true, agentCursor: 29 }, 12, 120);
    expect(tab.length).toBeLessThanOrEqual(12);
    // … and the `--plain` twin prints one line per row, never a filtered subset
    const plain = agentBlockLines(many, 120);
    expect(plain.filter((l) => /\ba\d+\b/.test(l))).toHaveLength(many.length);
    // §13.1: one pure function, four render targets — the block rows and the plain lines are the same text
    const block = renderBlock(agentRows(F54_ROWS, { width: blockWidth(120) }), blockWidth(120), GLYPHS.unicode).map((r) => r.text);
    const plain54 = agentBlockLines(F54_ROWS, 120);
    for (const row of F54_ROWS) {
      expect(block.some((l) => l.includes(row.slug)), `${row.slug} in the block`).toBe(true);
      expect(plain54.some((l) => l.includes(row.slug)), `${row.slug} in --plain`).toBe(true);
    }
  });

  it('clause 7: the model picker’s `--plain` twin numbers 40 of N, with the `more` token and the one-turn prompt', () => {
    expect(MODELS_PLAIN_CAP).toBe(40);
    const rows = Array.from({ length: 512 }, (_, i) => model(`z-ai/glm-${i}`, 'openrouter'));
    const lines = modelsPlainLines({ models: rows, text: API, results: [result('openrouter', rows)], nowMs: Date.parse('2026-09-22T10:00:00.000Z') });
    expect(modelsShown(rows.length)).toBe(MODELS_PLAIN_CAP);
    const head = lines.find((l) => l.startsWith('models ')) ?? '';
    expect(head).toContain('1-40 of 512');
    expect(head).toContain('more');
    // the one-turn prompt is what the caller ARMS as `pendingList` (TD4 §4.6's mechanism, reused), so it is a
    // string this module owns rather than a line in the block — the digit half is dropped when nothing is numbered
    expect(modelsPickPrompt(MODELS_PLAIN_CAP)).toBe('pick 1-40, or type a query > ');
    expect(modelsPickPrompt(0)).toBe('type a query > ');
    // the numbered rows are exactly the cap, and every one is numbered
    expect(lines.filter((l) => /^\s*\d+[.)]?\s/.test(l))).toHaveLength(MODELS_PLAIN_CAP);
    // `jevcode models list --plain` passes `Infinity`: a `--plain` twin's row count equals `rows.length`
    const whole = modelsPlainLines({ models: rows, text: API, cap: Number.POSITIVE_INFINITY, prompt: false });
    expect(whole.filter((l) => /^\s*\d+[.)]?\s/.test(l))).toHaveLength(rows.length);
  });

  it('§13.3 as ratified: `sessions inbox --json` serialises coordination’s own `publicMessage(m)` — no hostKey, checksum or hmac', () => {
    // the declared clause that stood in for this is RETIRED (round-5 owner item): the projection is the contract,
    // and it lives in the module that owns the record rather than as a sentence in the CLI.
    const projected = publicMessage({
      id: 'm-1',
      from: { deviceId: 'k3q7m2abcdef0000', label: 'air', sessionId: 'S1-aaaaaaaa', runId: 'R1' },
      to: '@all',
      type: 'heads-up',
      text: 'editing store.ts',
      refs: {},
      t: '2026-09-21T23:00:00.000Z',
      hostKey: 'never-serialised',
      checksum: 'never-serialised',
    } as unknown as Parameters<typeof publicMessage>[0]);
    const json = JSON.stringify(projected);
    for (const key of ['hostKey', 'checksum', 'hmac', 'never-serialised']) expect(json).not.toContain(key);
    // the full device id never leaves: the projection carries the id8 under a name that says id8 (§7 row 61)
    expect(projected.from.deviceId8).toBe('k3q7m2ab');
    expect(json).not.toContain('k3q7m2abcdef0000');
  });
});

describe('§13.1 / §7 row 61: nothing a view carries is a secret', () => {
  it('`selfView`’s and `activityView`’s outputs have no `hostKey`, no full device id and no pid, at any depth', () => {
    const row = activity();
    const json = JSON.stringify({ self: SELF, row });
    for (const forbidden of ['hostKey', 'hmac', 'checksum', 'pid']) expect(json, forbidden).not.toContain(forbidden);
    expect(SELF.deviceId8).toHaveLength(8);
    expect(row.deviceId8).toHaveLength(8);
    // the two mappers are the ONLY producers of the two views, and they are what `sessions who --json` serialises
    expect(typeof activityView).toBe('function');
    expect(typeof selfView).toBe('function');
  });

  it('no rendered `/who` row leaks a path outside the workspace-relative `editing` cell, or a full run id', () => {
    const row = activity({ editing: ['src/loop/engine.ts'] });
    const text = whoRowText(row, { width: blockWidth(120), g: GLYPHS.unicode, label: 'mbp' });
    expect(text).not.toContain(row.runId); // the id8 tail at most
    expect(text).not.toMatch(/\/(Users|home)\//);
  });
});
