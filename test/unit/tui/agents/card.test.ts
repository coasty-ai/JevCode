/**
 * TUI-DESIGN-5 §4.6, §7 rows 49 / 50 / 51, §12.3 S63 / S64 / S74 / S80 / S82 / S83 (R5-4's §10 `agents-card`).
 * The four cards at 40 / 80 / 120, and the two recovery branches the resume card must offer.
 */
import { describe, expect, it } from 'vitest';
import { GLYPHS, cellWidth } from '../../../../src/tui/glyphs.js';
import { blockTexts, blockWidth } from '../../../../src/tui/block/lines.js';
import {
  type AgentCardInput,
  NO_RISK_DIMENSIONS,
  adoptedText,
  agentBadge,
  agentCard,
  baseMovedText,
  dirtyWarningText,
  goneText,
  landSummaryText,
  manifestBodyRows,
  manifestBodyText,
  recreateFromBranchText,
  reviewOfferText,
} from '../../../../src/tui/agents/lines.js';
import { F54_ROWS, POOL_USD, mkManifest } from './fixtures.js';

const ASCII_RE = /^[\x20-\x7e]*$/;
const WIDTHS = [40, 80, 120];

describe('the manifest card (§4.6, §12.3 S63 / S64 / S65)', () => {
  it('S63: the body row names the agents, the globs, the reserve and the verify commands', () => {
    expect(manifestBodyText(mkManifest(), GLYPHS.unicode, POOL_USD)).toBe('3 agents · src/tui/** · src/loop/** · test/** · reserve $0.90 of $1.80 · verify: npm test, npm run typecheck');
  });

  it("S63's second money cell is the POOL the reserve came from, never Σ capUsd (OR §6.1)", () => {
    const m = mkManifest();
    // OR §6.1's own invariant, which the fixture now obeys: a derived figure can never exceed the reserve, so
    // `Σ capUsd` would render `reserve $0.90 of $0.90` on every real manifest — the cell would carry no fact
    const sumCaps = m.agents.reduce((n, a) => n + a.capUsd, 0);
    expect(sumCaps).toBeLessThanOrEqual(m.reserveUsd);
    expect(manifestBodyText(m, GLYPHS.unicode, sumCaps)).toContain('reserve $0.90 of $0.90');
  });

  it('§13.2 clause 5: with no pool supplied the ` of $Y` clause is OMITTED, never invented', () => {
    expect(manifestBodyText(mkManifest())).toBe('3 agents · src/tui/** · src/loop/** · test/** · reserve $0.90 · verify: npm test, npm run typecheck');
    expect(manifestBodyText(mkManifest())).not.toContain(' of $');
    // and the card takes it from `ManifestCardInput.of`, so the two forms come from one builder
    const withPool = agentCard({ kind: 'manifest', manifest: mkManifest(), of: POOL_USD }, { width: 120 });
    expect(withPool.map((r) => (r.kind === 'note' ? r.text : '')).join('\n')).toContain('reserve $0.90 of $1.80');
  });

  it('§4.12 at 40: the body STACKS, one glob per row — the joined row would wrap mid-list', () => {
    const rows = manifestBodyRows(mkManifest(), 40, GLYPHS.unicode, POOL_USD);
    expect(rows).toEqual(['3 agents', 'src/tui/**', 'src/loop/**', 'test/**', 'reserve $0.90 of $1.80', 'verify: npm test, npm run typecheck']);
    // no row is split across a separator, and no row ends in a dangling `·`
    for (const r of rows) expect(r.endsWith('·')).toBe(false);
    // 80 and 120 are S63's one `·`-joined row
    for (const w of [80, 120]) expect(manifestBodyRows(mkManifest(), w, GLYPHS.unicode, POOL_USD)).toEqual([manifestBodyText(mkManifest(), GLYPHS.unicode, POOL_USD)]);
    // and the card draws exactly those rows
    const card = agentCard({ kind: 'manifest', manifest: mkManifest(), of: POOL_USD }, { width: 40 });
    expect(card.slice(0, rows.length).map((r) => (r.kind === 'note' ? r.text : ''))).toEqual(rows);
  });

  it('S64: the dirty-checkout warning names the files INSIDE a slice, not the whole dirty set', () => {
    const t = dirtyWarningText({ files: 7, inSlice: ['src/tui/Pane.tsx', 'src/loop/engine.ts'] });
    expect(t).toBe("⚠ your checkout has 7 uncommitted files; 2 of them (src/tui/Pane.tsx, src/loop/engine.ts) are inside an agent's slice — /land will ask you to commit or stash those two before it merges");
  });

  it('S65 is on the card, and the warning is omitted (not blanked) when nothing dirty is in a slice', () => {
    const rows = agentCard({ kind: 'manifest', manifest: mkManifest(), dirty: { files: 7, inSlice: [] } }, { width: 120 });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r.kind === 'note' ? r.text : ''))).toContain(NO_RISK_DIMENSIONS);
    const withDirty = agentCard({ kind: 'manifest', manifest: mkManifest(), dirty: { files: 7, inSlice: ['a.ts'] } }, { width: 120 });
    expect(withDirty).toHaveLength(3);
  });

  it('the card gains exactly the stacked rows at 40 and is otherwise shape-stable at 80 / 120', () => {
    const at = (w: number): number => agentCard({ kind: 'manifest', manifest: mkManifest(), of: POOL_USD, dirty: { files: 7, inSlice: ['src/tui/Pane.tsx'] } }, { width: w }).length;
    // §4.12 is explicit that the 40-column body stacks, so the count DOES move there — the gate that holds at
    // every width is G-R5-6's ("no row exceeds the width"), asserted in the next case, not a constant row count
    expect(at(80)).toBe(at(120));
    expect(at(40)).toBe(at(80) + manifestBodyRows(mkManifest(), 40).length - 1);
  });

  it('the OTHER three cards are row-count-stable across 40 / 80 / 120 (the width changes the text, never the shape)', () => {
    const cards: AgentCardInput[] = [
      { kind: 'resume', rows: F54_ROWS, baseMoved: { from: 'a', to: 'b', commits: 1, by: 'you' } },
      { kind: 'land-preview', rows: F54_ROWS, dockVerified: true },
      { kind: 'review', slug: 'test-fixture', action: 'patch a.ts', risk: 0.5 },
    ];
    for (const card of cards) expect(new Set(WIDTHS.map((w) => agentCard(card, { width: w }).length)).size, card.kind).toBe(1);
  });

  it('no rendered row exceeds the block width at 40 / 80 / 120', () => {
    for (const w of WIDTHS) {
      const bw = blockWidth(w);
      for (const line of blockTexts(agentCard({ kind: 'manifest', manifest: mkManifest(), dirty: { files: 7, inSlice: ['src/tui/Pane.tsx'] } }, { width: bw }), bw)) {
        expect(cellWidth(line), `${w}: ${line}`).toBeLessThanOrEqual(bw);
      }
    }
  });

  it('§7 row 51: the badge keeps two simultaneous approvals apart', () => {
    expect(agentBadge('tui-rows')).toBe('agent tui-rows');
  });
});

describe('the resume card (§7 row 49 `base moved`, §7 row 50 worktree-gone-branch-present)', () => {
  it('S82: `base moved` replaces [Enter] with the three recovery keys', () => {
    expect(baseMovedText({ from: '3f9a2c1', to: '9d21ee0', commits: 2, by: 'you' }, 3)).toBe('base moved 3f9a2c1 → 9d21ee0 (2 commits by you) — [r] rebase the 3 agents · [s] stage on the old base · [f] forget');
  });

  it('the base-moved branch is on the card, once, with the agent count from the rows', () => {
    const rows = agentCard({ kind: 'resume', rows: F54_ROWS, baseMoved: { from: '3f9a2c1', to: '9d21ee0', commits: 2, by: 'you' } }, { width: 120 });
    const notes = rows.filter((r) => r.kind === 'note').map((r) => (r.kind === 'note' ? r.text : ''));
    expect(notes.filter((t) => t.startsWith('base moved'))).toHaveLength(1);
    expect(notes[0]).toContain('rebase the 5 agents');
  });

  it('S83: worktree gone, branch present → the branch is the truth, the worktree is a cache', () => {
    expect(recreateFromBranchText('test-fixture')).toBe('[n] recreate from jevcode/test-fixture');
    const rows = agentCard({ kind: 'resume', rows: [], worktreeGone: ['test-fixture', 'fix-store'] }, { width: 120 });
    const notes = rows.filter((r) => r.kind === 'note').map((r) => (r.kind === 'note' ? r.text : ''));
    expect(notes).toContain('[n] recreate from jevcode/test-fixture');
    expect(notes).toContain('[n] recreate from jevcode/fix-store');
  });

  it('§7 row 50 tail: branch AND run dir gone → dropped, and NO recovery is offered', () => {
    const rows = agentCard({ kind: 'resume', rows: [], gone: ['lint-pass'] }, { width: 120 });
    const notes = rows.filter((r) => r.kind === 'note').map((r) => (r.kind === 'note' ? r.text : ''));
    expect(goneText('lint-pass')).toBe('lint-pass: branch and run dir are both gone — dropped, nothing to recover');
    expect(notes.some((t) => t.includes('recreate from'))).toBe(false);
  });

  it('a resume card with neither branch is exactly the rows (no empty recovery rows)', () => {
    expect(agentCard({ kind: 'resume', rows: F54_ROWS }, { width: 120 })).toHaveLength(F54_ROWS.length);
  });
});

describe('the land-preview and review cards (§12.3 S80 / S74)', () => {
  it('S80: the summary row counts landed and parked and names the merge', () => {
    expect(landSummaryText(F54_ROWS, true)).toBe('5 agents: 1 landed, 1 parked · dock verified · /land merges it here');
    expect(landSummaryText(F54_ROWS, false)).toBe('5 agents: 1 landed, 1 parked · /land merges it here');
  });

  it('S74: one child needing approval, with its keys', () => {
    expect(reviewOfferText({ slug: 'test-fixture', action: 'patch test/unit/store.test.ts', risk: 0.52 })).toBe('test-fixture needs approval: patch test/unit/store.test.ts (risk 0.52) — [Enter] review · [d] decline · [q] leave it parked');
  });

  it('S81: the adoption row (§7 row 47)', () => {
    expect(adoptedText('2026…-rpywkq2v', F54_ROWS)).toBe('adopted 5 agents of run 2026…-rpywkq2v (1 running, 0 parked) — /agents');
  });

  it('every card is ASCII-clean under --ascii', () => {
    const g = GLYPHS.ascii;
    for (const card of [
      agentCard({ kind: 'manifest', manifest: mkManifest(), dirty: { files: 7, inSlice: ['a.ts'] } }, { width: 120, g }),
      agentCard({ kind: 'resume', rows: F54_ROWS, baseMoved: { from: 'a', to: 'b', commits: 1, by: 'you' }, worktreeGone: ['x'], gone: ['y'] }, { width: 120, g }),
      agentCard({ kind: 'land-preview', rows: F54_ROWS, dockVerified: true }, { width: 120, g }),
      agentCard({ kind: 'review', slug: 'test-fixture', action: 'patch a.ts', risk: 0.5 }, { width: 120, g }),
    ]) {
      for (const line of blockTexts(card, 120, g)) expect(line).toMatch(ASCII_RE);
    }
  });
});
