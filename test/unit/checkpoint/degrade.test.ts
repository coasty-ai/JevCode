/**
 * TUI-DESIGN-4 §7.2 (P-D2) / §10 (S6 `checkpoint/degrade.test.ts`): the store routes every **write** path's
 * classification to `onDegrade` as well as throwing, once per `<file>:<code>` key; `exitCodeFor('complete', …,
 * degraded = true)` is 3; and §7.9's forward-version refusal.
 *
 * The probe that produced the defect: with `$JEVCODE_HOME/runs` removed (or `chmod 500`) 0.9 s into a 40-step run
 * the run reported `[run] end complete steps=40 … exit 0`, **no** `checkpoint degraded` item appeared, and stderr
 * printed `resume` and `report` rows for a directory that did not exist.
 */
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_FILES,
  CHECKPOINT_VERSION,
  artefactVersion,
  checkpointDegradedSentence,
  createCheckpointStore,
  degradedConsequence,
  newerArtefactMessage,
  parseEnvelope,
  refuseNewerRunMeta,
  serialiseEnvelope,
  type DiskError,
} from '../../../src/checkpoint/store.js';
import { EXIT_CODES } from '../../../src/errors.js';
import { exitCodeFor } from '../../../src/loop/stop.js';
import { makeMeta, makeState, makeStepRecord, withTempDir } from '../../fixtures/checkpoint/make.js';

const identity = (s: string): string => s;

describe('onDegrade (§7.2 item 1: a failing checkpoint write degrades loudly)', () => {
  it('a vanished run directory reports ENOENT once per key from every write path — the measured silent case', () =>
    withTempDir(async (root) => {
      const dir = join(root, 'run');
      await mkdir(dir, { recursive: true });
      const seen: DiskError[] = [];
      const store = createCheckpointStore(dir, identity, { onDegrade: (info) => seen.push(info) });
      await store.create(makeMeta());
      // the runs dir is removed mid-run (JEVCODE_FAULT=rundir:rm)
      await rm(dir, { recursive: true, force: true });
      await expect(store.writeState(makeState({ step: 1 }))).rejects.toBeTruthy();
      expect(seen.map((s) => s.key)).toEqual(['state.json:ENOENT']);
      expect(seen[0]!.code).toBe('ENOENT');
      // §7.2 edge 6: the sentence, never the raw `open '<path>'` suffix
      expect(seen[0]!.sentence).toBe('checkpoint degraded: ENOENT on state.json — the run directory was removed during the run; this run cannot be resumed');
      expect(seen[0]!.sentence).not.toContain(dir);
      // once per key: a second state write with the same code adds nothing
      await expect(store.writeState(makeState({ step: 2 }))).rejects.toBeTruthy();
      expect(seen).toHaveLength(1);
      // a different file is a different key
      await expect(store.appendStep(makeStepRecord(1))).rejects.toBeTruthy();
      expect(seen.map((s) => s.key)).toEqual(['state.json:ENOENT', 'steps.jsonl:ENOENT']);
    }));

  it('a read-only run directory reports EACCES (or EROFS/EPERM on the platform) and the run is not resumable', () =>
    withTempDir(async (root) => {
      const dir = join(root, 'run');
      await mkdir(dir, { recursive: true });
      const seen: DiskError[] = [];
      const store = createCheckpointStore(dir, identity, { onDegrade: (info) => seen.push(info) });
      await store.create(makeMeta());
      await chmod(dir, 0o500);
      try {
        await expect(store.writeState(makeState({ step: 1 }))).rejects.toBeTruthy();
      } finally {
        await chmod(dir, 0o700);
      }
      expect(seen).toHaveLength(1);
      expect(seen[0]!.file).toBe('state.json');
      expect(['EACCES', 'EROFS']).toContain(seen[0]!.code);
      expect(seen[0]!.sentence).toContain('this run cannot be resumed');
    }));

  it('a throwing reporter never breaks the write path (the notice is best effort, the throw is not)', () =>
    withTempDir(async (root) => {
      const dir = join(root, 'run');
      await mkdir(dir, { recursive: true });
      const store = createCheckpointStore(dir, identity, {
        onDegrade: () => {
          throw new Error('a broken log');
        },
      });
      await store.create(makeMeta());
      await rm(dir, { recursive: true, force: true });
      await expect(store.writeState(makeState({ step: 1 }))).rejects.toMatchObject({ code: 'checkpoint' });
    }));

  it('a store with no callback behaves exactly as before (the option is additive)', () =>
    withTempDir(async (root) => {
      const dir = join(root, 'run');
      await mkdir(dir, { recursive: true });
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta());
      await store.writeState(makeState({ step: 1 }));
      expect(JSON.parse(await readFile(join(dir, CHECKPOINT_FILES.state), 'utf8'))).toMatchObject({ version: CHECKPOINT_VERSION });
    }));

  it('a read of an absent file is not a degradation (ENOENT is classified on writes only)', () =>
    withTempDir(async (root) => {
      const dir = join(root, 'run');
      await mkdir(dir, { recursive: true });
      const seen: DiskError[] = [];
      const store = createCheckpointStore(dir, identity, { onDegrade: (info) => seen.push(info) });
      await store.create(makeMeta());
      expect(await store.readCache('nothing.json')).toBeNull();
      expect(await store.readOutput(4)).toBeNull();
      expect(seen).toEqual([]);
    }));
});

describe('degradedConsequence / checkpointDegradedSentence (§7.2 edge 6, §12)', () => {
  it('names what the errno means for the run, and always ends with the same consequence', () => {
    expect(checkpointDegradedSentence('EACCES', 'state.json')).toBe('checkpoint degraded: EACCES on state.json — the run directory is not writable; this run cannot be resumed');
    expect(checkpointDegradedSentence('ENOSPC', 'steps.jsonl')).toBe('checkpoint degraded: ENOSPC on steps.jsonl — the disk is full; this run cannot be resumed');
    for (const code of ['ENOSPC', 'EACCES', 'EROFS', 'EDQUOT', 'EIO', 'EMFILE', 'ENOENT'] as const) {
      expect(degradedConsequence(code), code).toContain('this run cannot be resumed');
    }
  });
});

describe('exitCodeFor with degraded (§7.2 item 2, edge 3)', () => {
  it('the run completes but the last write failed: the reason stays complete and the exit code becomes 3', () => {
    expect(exitCodeFor('complete')).toBe(EXIT_CODES.ok);
    expect(exitCodeFor('complete', undefined, true)).toBe(EXIT_CODES.checkpoint);
    expect(exitCodeFor('max_steps', undefined, true)).toBe(EXIT_CODES.checkpoint);
    // an error keeps its own code: the fault is more specific than the degradation
    expect(exitCodeFor('error', { name: 'ConfigError', code: 'config', message: 'x', exitCode: 2 }, true)).toBe(2);
  });
});

describe('forward-version refusal (§7.9, P-D9)', () => {
  it('run.json v > CHECKPOINT_VERSION refuses by name; older and absent keep loading; non-numeric is corrupt, not newer', () => {
    expect(refuseNewerRunMeta({ v: 99 }, 'R1')).toBe('run R1 was written by a newer JevCode (run.json v99; this build reads v1) — upgrade with jevcode upgrade');
    expect(refuseNewerRunMeta({ v: CHECKPOINT_VERSION }, 'R1')).toBeNull();
    expect(refuseNewerRunMeta({ v: 0 }, 'R1')).toBeNull();
    expect(refuseNewerRunMeta({}, 'R1')).toBeNull();
    // edge: `v` present but not a number → corrupt, so it falls through to the shape check, never to "newer"
    expect(refuseNewerRunMeta({ v: 'two' }, 'R1')).toBeNull();
    expect(artefactVersion({ v: 'two' })).toBe('corrupt');
    expect(artefactVersion({})).toBeNull();
    expect(artefactVersion(null)).toBeNull();
    expect(newerArtefactMessage('R2', 'run.json', 3, 1)).toContain('run.json v3; this build reads v1');
  });

  it('the same check guards state.json`s envelope', () => {
    const good = serialiseEnvelope(makeState({ step: 1 }), identity);
    expect(parseEnvelope(good).ok).toBe(true);
    const newer = good.replace('"version":1', '"version":7');
    const r = parseEnvelope(newer);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('written by a newer JevCode (state.json v7; this build reads v1)');
    const older = parseEnvelope(good.replace('"version":1', '"version":0'));
    expect(older.ok).toBe(false);
    expect(older.ok === false ? older.reason : '').toContain('unsupported version');
  });

  it('jevcode report must still bundle a newer run: the refusal is a pure helper, not a read-time throw', async () =>
    withTempDir(async (dir) => {
      await writeFile(join(dir, CHECKPOINT_FILES.meta), JSON.stringify({ ...makeMeta(), v: 99 }));
      // reading the file is still possible — `report` does exactly this
      const text = await readFile(join(dir, CHECKPOINT_FILES.meta), 'utf8');
      expect(JSON.parse(text)).toMatchObject({ v: 99 });
      expect(refuseNewerRunMeta(JSON.parse(text), 'R1')).not.toBeNull();
    }));
});
