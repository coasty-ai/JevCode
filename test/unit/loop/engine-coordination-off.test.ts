/**
 * contract 1.4 (W2b), COORDINATION-DESIGN §2.1 rule 3 / §4.1 — "everything is OFF when there is no ledger".
 *
 * The M2 shape, applied to coordination: with `EngineOptions.coordination` absent, or present with `ledger: null`, or
 * present with a handle and `enabled: false`, a full run must
 *   · build generator prompts that are BYTE-IDENTICAL to the same run before this wave,
 *   · emit the SAME event sequence (no `coordination:facts`, no `coordination:decision`, no `session:message`, and
 *     no extra `stage:start`/`stage:end` pair for `coordinate`),
 *   · write the same `steps.jsonl` rows (no `coord`, no `coordinateMs`, no `coordWaitMs`),
 *   · leave `EngineStatus` without `coordination` / `phase` / `subwork`, so `--json=verbose` is unchanged, and
 *   · do ZERO new I/O — not one byte under the coordination root.
 *
 * The last one is the reason this is a real temp dir rather than a mock: "no I/O" is a statement about the
 * filesystem, and a spy on the ledger would only prove that a method this run never calls was never called.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineEvent, EngineStatus, StepRecord } from '../../../src/core/types.js';
import { COORDINATION_DIR } from '../../../src/coordination/index.js';
import { makeEngine, repoState, turn, type Harness, type HarnessOptions } from './fakes.js';

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const TURNS = [turn({ kind: 'read', paths: ['src/a.py'] }), turn({ kind: 'write', path: 'src/a.py', content: 'x = 1\n' }), turn({ kind: 'done', summary: 'done' })];

/** everything the OFF promise is about, captured from one finished run. */
interface Trace {
  prompts: string[];
  eventTypes: string[];
  stages: string[];
  records: StepRecord[];
  status: EngineStatus;
}

async function run(opts: HarnessOptions = {}): Promise<Trace> {
  const h: Harness = await makeEngine({ turns: [...TURNS], probeGitState: repoState(), ...opts });
  try {
    await h.engine.run();
    return {
      prompts: h.provider.requests.map((r) => r.messages.map((m) => m.content).join('\n---\n')),
      eventTypes: h.events.map((e: EngineEvent) => e.type),
      stages: h.of('stage:start').map((e) => e.stage),
      records: h.of('step:end').map((e) => e.record),
      status: h.engine.status(),
    };
  } finally {
    h.cleanup();
  }
}

function newHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'jevcode-coord-off-'));
  homes.push(d);
  return d;
}

describe('coordination off: a run without a ledger is the run before this wave', () => {
  it('absent `coordination` — no coordinate stage, no coordination events, no coord/coordinateMs on any row', async () => {
    const t = await run();
    expect(t.stages).not.toContain('coordinate');
    expect(t.eventTypes.filter((x) => x.startsWith('coordination:') || x === 'session:message')).toEqual([]);
    for (const r of t.records) {
      expect(r.coord).toBeUndefined();
      expect(r.timing.coordinateMs).toBeUndefined();
      expect(r.timing.coordWaitMs).toBeUndefined();
    }
    // §12.0.3: the three status members are ABSENT, not empty — `--json=verbose` is byte-identical to HEAD
    expect('coordination' in t.status).toBe(false);
    expect('phase' in t.status).toBe(false);
    expect('subwork' in t.status).toBe(false);
  });

  it('contract 1.4 (W0 item 1): a run with no ledger writes neither `claims` nor `claimEpochHigh` to run.json', async () => {
    const h: Harness = await makeEngine({ turns: [...TURNS], probeGitState: repoState() });
    try {
      await h.engine.run();
      const meta = h.store.meta;
      expect(meta).not.toBeNull();
      expect('claims' in meta!).toBe(false);
      expect('claimEpochHigh' in meta!).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('`ledger: null` is identical to absent: same prompts, same events, same rows', async () => {
    const [off, nulled] = await Promise.all([run(), run({ engine: { coordination: { ledger: null, claims: 'strict' } } })]);
    // `claims: 'strict'` is set on purpose: with no handle the mode is not even read, which is the property that
    // makes `ledger: null` a safe thing for the surface to pass while the human's config says `strict`.
    expect(nulled.prompts).toEqual(off.prompts);
    expect(nulled.eventTypes).toEqual(off.eventTypes);
    expect(nulled.stages).toEqual(off.stages);
    // the timing VALUES are wall-clock and differ between two runs of anything; what OFF promises is that the
    // `StepTiming` object has the same MEMBERS — no `coordinateMs`, no `coordWaitMs` — on every row
    expect(nulled.records.map((r) => Object.keys(r.timing).sort().join(','))).toEqual(off.records.map((r) => Object.keys(r.timing).sort().join(',')));
    expect(nulled.records.every((r) => r.coord === undefined)).toBe(true);
    expect('coordination' in nulled.status).toBe(false);
  });

  it('a real ledger with `enabled: false` writes nothing under the coordination root and changes no prompt', async () => {
    const home = newHome();
    const { openLedger } = await import('../../../src/coordination/index.js');
    const ledger = openLedger({
      home,
      self: { deviceId: 'k3q7m2ab', label: 'mbp', host: 'mbp.local', user: 'p', bootAt: '2026-09-21T06:00:00.000Z', sessionId: null, runId: null, wsKey: 'ws:0123456789abcdef', repoKey: null, remoteKey: null, branch: 'main' },
      isPidAlive: () => true,
      // no fs.watch in unit tests: the ledger falls back to its poll, which a scan-only handle never arms
      watch: (() => {
        throw Object.assign(new Error('no fs.watch in tests'), { code: 'ENOSYS' });
      }) as never,
    });
    await ledger.open();
    // every FILE under the coordination root, recursively — `open()` may create empty kind directories, and the
    // question is whether the RUN wrote a record into one of them
    const root = join(home, COORDINATION_DIR);
    const files = (dir: string, prefix = ''): string[] =>
      !existsSync(dir)
        ? []
        : readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));
    const before = files(root).sort();
    const [off, disabled] = [await run(), await run({ engine: { coordination: { ledger, enabled: false } } })];
    const after = files(root).sort();
    await ledger.close();
    expect(disabled.prompts).toEqual(off.prompts);
    expect(disabled.eventTypes).toEqual(off.eventTypes);
    expect('coordination' in disabled.status).toBe(false);
    // the run wrote no heartbeat, no lease, no ack: the coordination root is byte-for-byte what `open()` left
    expect(after).toEqual(before);
    expect(after.some((f) => f.startsWith('registry/') || f.startsWith('leases/') || f.startsWith('acks/'))).toBe(false);
  });

  it('a bench run defaults to OFF even with a handle, and an explicit `enabled` beats the default (§4.1)', async () => {
    const { coordinationEnabled } = await import('../../../src/loop/coordination.js');
    const handle = { ledger: {} } as unknown as NonNullable<Parameters<typeof coordinationEnabled>[0]>['ledger'];
    expect(coordinationEnabled({ ledger: handle }, 'bench')).toBe(false);
    // a `perf` run DOES coordinate, so §13 M9's step-overhead gate measures the real path
    expect(coordinationEnabled({ ledger: handle }, 'perf')).toBe(true);
    expect(coordinationEnabled({ ledger: handle }, 'cli')).toBe(true);
    expect(coordinationEnabled({ ledger: handle, enabled: true }, 'bench')).toBe(true);
    expect(coordinationEnabled({ ledger: handle, enabled: false }, 'cli')).toBe(false);
    expect(coordinationEnabled({ ledger: null }, 'cli')).toBe(false);
    expect(coordinationEnabled(undefined, 'cli')).toBe(false);
  });
});
