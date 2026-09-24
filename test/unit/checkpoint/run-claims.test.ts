/**
 * contract 1.4 (COORDINATION-DESIGN W0 item 1, §3.2 / §9.3 / §4.6 row 1 as amended): `RunMeta.claims[]` and
 * `RunMeta.claimEpochHigh` in `run.json`.
 *
 * The fold only knows the epochs of records it can still SEE — an ended heartbeat is GC'd after 24 h — so a run
 * whose earlier incarnations are gone would re-mint an epoch a previous one already used and `compareClaim` would
 * return 0 for two live processes, the one case §9.3's fork rule cannot decide. These two members are where the
 * device's own history survives that GC, which is why `claims` APPENDS (capped, first + newest 63) and
 * `claimEpochHigh` is a monotonic MAX rather than a scalar replace.
 *
 * The absence is the other half: a run with no ledger never mints, so `run.json` carries neither member.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_CLAIMS_PER_RUN } from '../../../src/core/limits.js';
import { MAX_CLAIMS_PER_RUN as LEDGER_MAX_CLAIMS_PER_RUN, capClaims } from '../../../src/coordination/index.js';
import type { RunClaimRow, RunMeta } from '../../../src/core/types.js';
import { CHECKPOINT_FILES, capRunClaims, createCheckpointStore } from '../../../src/checkpoint/store.js';
import { makeMeta, makeState, withTempDir } from '../../fixtures/checkpoint/make.js';

const identity = (s: string): string => s;

const row = (epoch: number, over: Partial<RunClaimRow> = {}): RunClaimRow => ({ epoch, deviceId: 'k3q7m2ab', at: `2026-09-2${epoch % 10}T06:00:00.000Z`, authority: 'self', ...over });

async function readMeta(dir: string): Promise<RunMeta> {
  return JSON.parse(await readFile(join(dir, CHECKPOINT_FILES.meta), 'utf8')) as RunMeta;
}

describe('run.json claims[] / claimEpochHigh', () => {
  it('a resume after two mints shows BOTH claims and the high-water mark', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta());
      // the fresh run's mint, then the resume's
      await store.updateMeta({ claims: [row(1)], claimEpochHigh: 1 });
      await store.updateMeta({ claims: [row(2)], claimEpochHigh: 2 });
      await store.writeState(makeState());
      const meta = await readMeta(dir);
      expect(meta.claims?.map((c) => c.epoch)).toEqual([1, 2]);
      expect(meta.claims?.[1]).toEqual(row(2));
      expect(meta.claimEpochHigh).toBe(2);
      // the resume LOADS them: `checkResumeClaim`'s local set is this array, not just this process's claim
      const loaded = await store.load();
      expect(loaded.meta.claims?.map((c) => c.epoch)).toEqual([1, 2]);
      expect(loaded.meta.claimEpochHigh).toBe(2);
    }));

  it('the high-water mark never goes down, and an unrelated patch leaves both members alone', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta());
      await store.updateMeta({ claims: [row(7)], claimEpochHigh: 7 });
      // a late write from an older incarnation must not lower a mark a newer one already raised
      await store.updateMeta({ claimEpochHigh: 3 });
      await store.updateMeta({ resolvedJevModel: 'jev-1.13-20260901' });
      const meta = await readMeta(dir);
      expect(meta.claimEpochHigh).toBe(7);
      expect(meta.claims?.map((c) => c.epoch)).toEqual([7]);
      expect(meta.resolvedJevModel).toBe('jev-1.13-20260901');
    }));

  it('a run with no ledger writes neither member', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta());
      await store.updateMeta({ resumes: [{ resumedAt: '2026-09-22T06:00:00.000Z', previousStopReason: 'signal' }] });
      const meta = await readMeta(dir);
      expect('claims' in meta).toBe(false);
      expect('claimEpochHigh' in meta).toBe(false);
    }));

  it('caps at MAX_CLAIMS_PER_RUN keeping the FIRST row and the newest 63, exactly as the ledger does', () =>
    withTempDir(async (dir) => {
      expect(MAX_CLAIMS_PER_RUN).toBe(64);
      // one number, two readers: `src/checkpoint/**` must not import the ledger to learn the bound
      expect(MAX_CLAIMS_PER_RUN).toBe(LEDGER_MAX_CLAIMS_PER_RUN);
      const many = Array.from({ length: 100 }, (_, i) => i + 1);
      expect(capRunClaims(many)).toEqual(capClaims(many));
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta());
      for (let epoch = 1; epoch <= 100; epoch++) await store.updateMeta({ claims: [row(epoch)], claimEpochHigh: epoch });
      const meta = await readMeta(dir);
      const epochs = meta.claims?.map((c) => c.epoch) ?? [];
      expect(epochs).toHaveLength(MAX_CLAIMS_PER_RUN);
      // the origin is the provenance and is never pruned; the maximum is the last row
      expect(epochs[0]).toBe(1);
      expect(epochs[epochs.length - 1]).toBe(100);
      expect(epochs[1]).toBe(100 - (MAX_CLAIMS_PER_RUN - 2));
      expect(meta.claimEpochHigh).toBe(100);
    }));
});
