/**
 * TUI-DESIGN-5 §2.8 / §10 (slot R5-1): the resume card's **eight branches**, each at 40 / 80 / 120 columns, with
 * the `ctx` cell **present and omitted** (§7 row 38 — omitted, never zeroed, when `CheckpointState.lastPromptChars`
 * is absent, because a resumed `ctx 0%` before any prompt was read is a lie).
 */
import { describe, expect, it } from 'vitest';
import {
  RESUME_CARD_BRANCHES,
  crashedLine,
  importedRunLine,
  liveElsewhereRow,
  resumeCardKeys,
  resumeCardNote,
  resumeCardRows,
  resumeCardSentence,
  targetsMovedLine,
  takenOverLine,
  unqualifiedClaimLine,
  type ResumeCardBranch,
  type ResumeCardInput,
} from '../../../src/session/picker-lines.js';
import { stringWidth } from '../../../src/tui/composer/width.js';

const NOW = Date.parse('2026-09-21T23:44:32.000Z');
const RUN = '20260921-234432-rpywkq2v';
const WIDTHS = [40, 80, 120] as const;

function card(branch: ResumeCardBranch, patch: Partial<ResumeCardInput> = {}): ResumeCardInput {
  const base: ResumeCardInput = {
    runId: RUN,
    title: 'fix store rotation',
    branch,
    pausedAtMs: NOW - 42 * 60_000,
    step: 7,
    pauseDetail: 'pause now during propose, 62 % streamed',
    steersPending: 3,
    head: { from: '3f9a2c1', to: '8bc0d11', commits: 2, by: 'mbp', subjects: ['fix store rotation', 'tests'] },
    changedSince: ['store.ts', 'engine.ts'],
    livePeer: { label: 'mbp', step: 12, editing: 'src/tui/App.tsx' },
    spend: { usd: 0.42, capUsd: 2 },
    wallMs: 724_000,
    maxWallMs: 1_800_000,
    ctxPct: 41,
    targetsMoved: null,
    importedFrom: null,
    crashed: null,
    takenOver: null,
    forked: null,
  };
  const withBranch: ResumeCardInput = {
    ...base,
    ...(branch === 'targets-moved' ? { targetsMoved: { path: 'store.ts', by: 'mbp', head: '8bc0d11' } } : {}),
    ...(branch === 'imported' ? { importedFrom: 'mbp' } : {}),
    ...(branch === 'crashed' ? { crashed: { agoMs: 180_000, step: 8, stage: 'propose', intoMs: 41_000 } } : {}),
    ...(branch === 'taken-over' ? { takenOver: { label: 'mbp', at: '14:02', epoch: 4 } } : {}),
    ...(branch === 'forked-unverified' ? { forked: { label: 'mbp', epoch: 4 } } : {}),
  };
  return { ...withBranch, ...patch };
}

describe('the resume card (§2.8) — eight branches at three widths', () => {
  it('the branch union is exactly the eight §10 names', () => {
    expect([...RESUME_CARD_BRANCHES]).toEqual(['fresh', 'replayable', 'targets-moved', 'imported', 'crashed', 'live-elsewhere', 'taken-over', 'forked-unverified']);
  });

  it.each(RESUME_CARD_BRANCHES)('%s — every row fits its width at 40 / 80 / 120 and the head is a full rule (G-R5-6)', (branch) => {
    for (const columns of WIDTHS) {
      const rows = resumeCardRows(card(branch), { nowMs: NOW, columns });
      expect(rows.length, `${branch}@${columns}`).toBeGreaterThan(2);
      for (const r of rows) expect(stringWidth(r), `${branch}@${columns}: ${r}`).toBeLessThanOrEqual(columns);
      // the rule head is padded to exactly `columns`
      expect(stringWidth(rows[0] ?? ''), `${branch}@${columns} head`).toBe(columns);
      expect(rows[0]?.startsWith('─')).toBe(true);
    }
  });

  it('fresh — no `[r]`, no branch note, and the status row names the pause', () => {
    const rows = resumeCardRows(card('fresh'), { nowMs: NOW, columns: 120 });
    expect(rows[1]).toBe('paused 42 m ago · now at step 7 (pause now during propose, 62 % streamed) · 3 steers pending');
    expect(rows.join('\n')).not.toContain('[r] replay');
    expect(resumeCardNote(card('fresh'))).toBeNull();
  });

  it('replayable — `[r] replay the paused proposal` is offered at 120 and survives the 80-column rung as `r replay`', () => {
    expect(resumeCardKeys(card('replayable'), 120)).toBe('[Enter] resume (fresh step 7)   [r] replay the paused proposal   [f] fresh   [d] diff since pause   [w] who   [Esc]');
    expect(resumeCardKeys(card('replayable'), 80)).toBe('Enter resume · r replay · f fresh · d diff · w who · Esc');
    expect(resumeCardKeys(card('replayable'), 40)).toBe('Enter resume · r replay · Esc');
    // the 40-column rung keeps `[r]` — the one key the branch exists for — and drops the other three
    expect(resumeCardKeys(card('fresh'), 40)).toBe('Enter resume · Esc');
  });

  it('targets-moved — S23 names the file, the author and the sha, and `[r]` is withheld (§7 row 30)', () => {
    const c = card('targets-moved');
    expect(resumeCardNote(c)).toBe('targets changed since the proposal (store.ts by mbp@8bc0d11) — replay unavailable');
    expect(targetsMovedLine({ path: 'store.ts', by: 'mbp', head: '8bc0d11' })).toBe(resumeCardNote(c));
    expect(resumeCardRows(c, { nowMs: NOW, columns: 120 }).join('\n')).not.toContain('[r] replay');
  });

  it('imported — S24, and no `[r]` (the bodies stayed on the origin, §7 row 31)', () => {
    expect(resumeCardNote(card('imported'))).toBe('the paused proposal and its samples stayed on mbp — resuming starts a fresh step');
    expect(importedRunLine('air')).toContain('stayed on air');
    expect(resumeCardRows(card('imported'), { nowMs: NOW, columns: 120 }).join('\n')).not.toContain('[r] replay');
  });

  it('crashed — S25 REPLACES the pause row; the note stays null so the sentence is printed once', () => {
    const rows = resumeCardRows(card('crashed'), { nowMs: NOW, columns: 120 });
    // §12.1 S25 verbatim — `41 s`, the module's own `shortAgo`, not `core/time.ts`'s `41s` (§13.4 greps this)
    expect(rows[1]).toBe('crashed 3 m ago during step 8 (propose, 41 s in) — step 8 restarts');
    expect(rows[1]).toBe(crashedLine({ agoMs: 180_000, step: 8, stage: 'propose', intoMs: 41_000 }));
    expect(resumeCardNote(card('crashed'))).toBeNull();
    expect(rows.filter((r) => r.includes('crashed')).length).toBe(1);
    expect(rows.join('\n')).not.toContain('paused');
  });

  it('live-elsewhere — S26 REPLACES the key row at 120; the two narrower rungs keep `w watch` and `Esc`', () => {
    const c = card('live-elsewhere');
    expect(resumeCardKeys(c, 120)).toBe('● live on mbp — [w] watch (read-only tail) · [t] tell · [p] ask to pause · [Esc]');
    expect(resumeCardKeys(c, 120)).toBe(liveElsewhereRow('mbp'));
    expect(resumeCardKeys(c, 60)).toBe('● live elsewhere · w watch · t tell · p ask to pause · Esc');
    expect(resumeCardKeys(c, 40)).toBe('● live · w watch · Esc');
    expect(resumeCardKeys(c, 120, true)).toBe('* live on mbp -- [w] watch (read-only tail) - [t] tell - [p] ask to pause - [Esc]');
    expect(resumeCardRows(c, { nowMs: NOW, columns: 120 }).join('\n')).not.toContain('[Enter] resume');
  });

  it('taken-over — S11, and the sub-state footer names `--force-takeback` (§7 row 27)', () => {
    const c = card('taken-over');
    expect(resumeCardNote(c)).toBe('taken over by mbp at 14:02 (claim 4); /resume --force-takeback re-takes it');
    expect(takenOverLine({ label: 'mbp', at: '14:02', epoch: 4 })).toBe(resumeCardNote(c));
    expect(resumeCardRows(c, { nowMs: NOW, columns: 120 }).at(-1)).toBe('Esc returns to the list — /resume --force-takeback re-takes the run');
  });

  it('forked-unverified — S12 annotates and NEVER refuses (§7 row 28): `[Enter] resume` is still offered', () => {
    const c = card('forked-unverified');
    expect(resumeCardNote(c)).toBe('mbp claims 4 (unverified) — ignored; sessions pair to make it count');
    expect(unqualifiedClaimLine({ label: 'air', epoch: 9 })).toBe('air claims 9 (unverified) — ignored; sessions pair to make it count');
    expect(resumeCardRows(c, { nowMs: NOW, columns: 120 }).join('\n')).toContain('[Enter] resume (fresh step 7)');
  });
});

describe('the `ctx` cell (§7 row 38) — present and OMITTED, never zeroed', () => {
  it.each(RESUME_CARD_BRANCHES)('%s — `ctx 41%%` at 120 with a pct, and the whole cell gone when it is null', (branch) => {
    const withCtx = resumeCardRows(card(branch), { nowMs: NOW, columns: 120 }).join('\n');
    const without = resumeCardRows(card(branch, { ctxPct: null }), { nowMs: NOW, columns: 120 }).join('\n');
    expect(withCtx).toContain('ctx 41%');
    expect(without).not.toContain('ctx');
    // and never the zero the LIVE status cell would legitimately show
    expect(resumeCardRows(card(branch, { ctxPct: null }), { nowMs: NOW, columns: 120 }).join('\n')).not.toContain('ctx 0%');
  });

  it('a card with `ctxPct: 0` DOES show `ctx 0%` — zero is a fact, absence is not', () => {
    expect(resumeCardRows(card('fresh', { ctxPct: 0 }), { nowMs: NOW, columns: 120 }).join('\n')).toContain('ctx 0%');
  });
});

describe('the card’s other rows', () => {
  it('the HEAD row names the drift, the commits and the files that moved', () => {
    const rows = resumeCardRows(card('fresh'), { nowMs: NOW, columns: 200 });
    expect(rows[2]).toBe('HEAD 3f9a2c1 → 8bc0d11 (2 commits by mbp: "fix store rotation", "tests") · changed since: store.ts, engine.ts');
    expect(resumeCardRows(card('fresh', { head: null }), { nowMs: NOW, columns: 200 })[2]).not.toContain('HEAD');
  });

  it('the live row joins the peer, the spend, the wall and the ctx', () => {
    const rows = resumeCardRows(card('fresh'), { nowMs: NOW, columns: 200 });
    expect(rows[3]).toBe('live on this repo: mbp (step 12, editing src/tui/App.tsx) · spend $0.42/2.00 · wall 12m4s/30m · ctx 41%');
  });

  it('with no peer, no spend, no wall and no ctx the live row is omitted entirely', () => {
    const rows = resumeCardRows(card('fresh', { livePeer: null, spend: null, wallMs: null, maxWallMs: null, ctxPct: null, head: null }), { nowMs: NOW, columns: 120 });
    expect(rows.length).toBe(4);
    expect(rows[2]).toContain('[Enter] resume');
  });

  it('`--ascii` substitutes every glyph: the rule, the arrow, the dot and the dashes', () => {
    const rows = resumeCardRows(card('taken-over'), { nowMs: NOW, columns: 120, ascii: true });
    expect(rows[0]?.startsWith('-')).toBe(true);
    expect(rows[2]).toContain('->');
    expect(rows.join('\n')).not.toContain('→');
    expect(rows.join('\n')).not.toContain('─');
    expect(rows.at(-1)).toBe('Esc returns to the list -- /resume --force-takeback re-takes the run');
  });

  it('§7 row 91: the card says how to leave its focused sub-state', () => {
    for (const branch of RESUME_CARD_BRANCHES) {
      expect(resumeCardRows(card(branch), { nowMs: NOW, columns: 120 }).at(-1), branch).toContain('Esc returns to the list');
    }
    // at 40 columns the footer is dropped for the rows that matter; the key row still ends in `Esc`
    expect(resumeCardRows(card('fresh'), { nowMs: NOW, columns: 40 }).at(-1)).toContain('Esc');
  });

  it('§7 row 82: the screen-reader sentence carries the branch’s own fact', () => {
    expect(resumeCardSentence(card('replayable'), NOW)).toContain('r to replay the paused proposal');
    expect(resumeCardSentence(card('crashed'), NOW)).toContain('Crashed 3 m ago during step 8 propose');
    expect(resumeCardSentence(card('taken-over'), NOW)).toContain('taken over by mbp at 14:02');
    expect(resumeCardSentence(card('fresh', { ctxPct: null }), NOW)).not.toContain('Context');
    expect(resumeCardSentence(card('fresh'), NOW)).toContain('Context 41 percent');
  });

  it('a zero-column card still builds (the caller may not know its width yet)', () => {
    const rows = resumeCardRows(card('fresh'), { nowMs: NOW, columns: 0 });
    expect(rows.length).toBeGreaterThan(3);
    expect(rows[0]).toContain(RUN);
  });
});
