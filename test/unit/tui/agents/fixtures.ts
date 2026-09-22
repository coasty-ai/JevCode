/** TUI-DESIGN-5 §4.2 / §4.0: typed agent fixtures — the only row source in a build with no `AgentSupervisor`. */
import type { AgentRow, AgentSpec, AgentState, Manifest } from '../../../../src/core/types.js';

/** every member of the union, in `src/core/types.ts`'s own order — the table test keys off THIS. */
export const ALL_AGENT_STATES: readonly AgentState[] = ['planned', 'starting', 'running', 'paused', 'parked', 'review', 'stalled', 'done', 'landing', 'landed', 'conflicted', 'failed-verify', 'kicked', 'dropped', 'crashed', 'failed-start'];

export function mkAgentRow(over: Partial<AgentRow> = {}): AgentRow {
  return {
    slug: 'tui-rows',
    state: 'running',
    step: 4,
    maxSteps: 12,
    stage: 'propose',
    spendUsd: 0.11,
    capUsd: 0.3,
    wallMs: 6 * 60_000,
    maxWallMs: 15 * 60_000,
    own: ['src/tui/**'],
    branch: 'jevcode/tui-rows',
    verify: ['npm test'],
    last: 'wrote src/tui/agents/lines.ts',
    why: '',
    ...over,
  };
}

/** F-54's five rows, verbatim in shape. */
export const F54_ROWS: readonly AgentRow[] = [
  mkAgentRow({ slug: 'tui-rows', state: 'running', step: 4, maxSteps: 12, stage: 'propose', spendUsd: 0.11, wallMs: 6 * 60_000 }),
  mkAgentRow({ slug: 'fix-store', state: 'paused', spendUsd: 0.08, wallMs: 4 * 60_000, branch: 'jevcode/fix-store' }),
  mkAgentRow({ slug: 'test-fixture', state: 'review', spendUsd: 0.05, wallMs: 3 * 60_000, branch: 'jevcode/test-fixture' }),
  mkAgentRow({ slug: 'dock-a2fee9c1', state: 'landed', spendUsd: 0.17, wallMs: 9 * 60_000, why: '8bc0d11', verify: ['npm test', 'npm run typecheck'], branch: 'jevcode/dock' }),
  mkAgentRow({ slug: 'lint-pass', state: 'failed-verify', spendUsd: 0.03, wallMs: 60_000, why: 'npm run lint', branch: 'jevcode/lint-pass' }),
];

export function mkAgentSpec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    slug: 'tui-rows',
    task: 'render the agent rows',
    own: ['src/tui/**'],
    role: 'code',
    verify: ['npm test'],
    dependsOn: [],
    /**
     * OR §6.1: `Σ capUsd_i ≤ reserveUsd` **exactly** — every per-agent cap is rounded down to the cent out of
     * the one reserve. `mkManifest`'s three agents at $0.30 sum to the $0.90 reserve, so the fixture obeys the
     * invariant a real manifest is built under; it used to be $0.60 (3 × $0.60 = $1.80 > $0.90), which is the
     * only reason the derived `reserve $0.90 of $1.80` ever matched S63.
     */
    capUsd: 0.3,
    maxSteps: 12,
    maxWallMs: 15 * 60_000,
    mode: 'jev-on',
    branch: 'jevcode/tui-rows',
    ...over,
  };
}

export function mkManifest(over: Partial<Manifest> = {}): Manifest {
  return {
    v: 1,
    manifestId: 'm-1',
    runId: '20260922-101010-abcdefgh',
    sessionId: 's-1',
    step: 11,
    splitKind: 'by_directory',
    verdict: 'chosen',
    probability: 0.72,
    confidence: 0.81,
    baseSha: '3f9a2c1',
    repoKey: 'repo',
    dockBranch: 'jevcode/dock-a2fee9c1',
    syncedDirty: [],
    dirtyOverlap: [],
    agents: [mkAgentSpec({ slug: 'tui-rows', own: ['src/tui/**'] }), mkAgentSpec({ slug: 'fix-store', own: ['src/loop/**'] }), mkAgentSpec({ slug: 'test-fixture', own: ['test/**'], verify: ['npm test', 'npm run typecheck'] })],
    reserveUsd: 0.9,
    reserveFrom: 'session',
    // the pool the reserve came from is NOT on the manifest (OR §6.1: `min(sessionRemaining × fraction, max)`),
    // so the card's `of` is supplied by the caller — see `POOL_USD` below, which is what S63 pins against
    rejected: [],
    demand: 'disjoint_directories',
    createdAt: '2026-09-22T10:10:10.000Z',
    checksum: 'deadbeef',
    ...over,
  };
}

/**
 * §12.3 S63's second money cell: the pool `mkManifest`'s $0.90 reserve came from
 * (`min(sessionRemainingUsd × reserveFraction, maxReserveUsd)` = `min($1.80 × 0.5, $2.00)`). It is a **caller's**
 * fact — `ManifestCardInput.of` — never `Σ capUsd`, which OR §6.1 caps at the reserve itself.
 */
export const POOL_USD = 1.8;
