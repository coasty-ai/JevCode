import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../src/core/hash.js';
import type { CheckpointEnvelope } from '../../../src/core/types.js';
import { CheckpointError } from '../../../src/errors.js';
import { CHECKPOINT_FILES, CORRUPT_STATE_FILE, ORCHESTRATE_FILE_BYTES, cacheRelPath, createCheckpointStore, parseEnvelope, redactDeep, serialiseEnvelope } from '../../../src/checkpoint/store.js';
import { FAKE_KEY, REDACTED, fakeRedact, makeDecision, makeMeta, makeState, makeStepRecord, withTempDir } from '../../fixtures/checkpoint/make.js';

const identity = (s: string): string => s;

async function readEnvelope(dir: string, file: string): Promise<CheckpointEnvelope> {
  return JSON.parse(await readFile(join(dir, file), 'utf8')) as CheckpointEnvelope;
}

async function readLines(dir: string, file: string): Promise<string[]> {
  const text = await readFile(join(dir, file), 'utf8');
  expect(text.endsWith('\n')).toBe(true);
  return text.slice(0, -1).split('\n');
}

describe('create / updateMeta', () => {
  it('writes run.json once and refuses a second create', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta());
      const meta = JSON.parse(await readFile(join(dir, CHECKPOINT_FILES.meta), 'utf8')) as unknown;
      expect(meta).toEqual(makeMeta());
      await expect(store.create(makeMeta())).rejects.toBeInstanceOf(CheckpointError);
    }));

  it('appends overrides/resumes and replaces scalars without losing fields', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta({ overrides: [{ setting: 'maxSteps', from: '10', to: '20', atStep: 3 }] }));
      await store.updateMeta({ resumes: [{ resumedAt: '2026-09-19T13:00:00.000Z', previousStopReason: 'signal' }] });
      await store.updateMeta({ overrides: [{ setting: 'spendCapUsd', from: '1', to: '2', atStep: 5 }], resolvedJevModel: 'jev-1.13-20260901' });
      const onDisk = JSON.parse(await readFile(join(dir, CHECKPOINT_FILES.meta), 'utf8')) as ReturnType<typeof makeMeta>;
      expect(onDisk.task).toBe('fix the bug');
      expect(onDisk.overrides).toHaveLength(2);
      expect(onDisk.overrides[1]?.setting).toBe('spendCapUsd');
      expect(onDisk.resumes).toEqual([{ resumedAt: '2026-09-19T13:00:00.000Z', previousStopReason: 'signal' }]);
      expect(onDisk.resolvedJevModel).toBe('jev-1.13-20260901');
      expect(onDisk.jevModelDrift).toBeNull();
    }));

  it('serialises concurrent updateMeta calls (no lost updates)', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta());
      await Promise.all(
        Array.from({ length: 10 }, (_, i) => store.updateMeta({ overrides: [{ setting: `s${i}`, from: 'a', to: 'b', atStep: i }] })),
      );
      const onDisk = JSON.parse(await readFile(join(dir, CHECKPOINT_FILES.meta), 'utf8')) as ReturnType<typeof makeMeta>;
      expect(onDisk.overrides.map((o) => o.setting).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `s${i}`).sort());
    }));
});

describe('writeState / load', () => {
  it('rotates: prev holds the previous state, state.json the new one, checksum verified', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta());
      await store.writeState(makeState({ step: 1 }));
      await store.writeState(makeState({ step: 2 }));
      const cur = await readEnvelope(dir, CHECKPOINT_FILES.state);
      const prev = await readEnvelope(dir, CHECKPOINT_FILES.prev);
      expect(cur.version).toBe(1);
      expect(cur.state.step).toBe(2);
      expect(prev.state.step).toBe(1);
      expect(cur.checksum).toBe(sha256Hex(JSON.stringify(makeState({ step: 2 }))));
      // no temp files left behind
      const files = await readdir(dir);
      expect(files.filter((f) => f.includes('.tmp-'))).toEqual([]);
      const loaded = await store.load();
      expect(loaded.recoveredFrom).toBe('state');
      expect(loaded.state).toEqual(makeState({ step: 2 }));
      expect(loaded.meta).toEqual(makeMeta());
      expect(store.lastWarnings()).toEqual([]);
    }));

  it('falls back to prev when state.json is tampered, with a warning', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta());
      await store.writeState(makeState({ step: 1 }));
      await store.writeState(makeState({ step: 2 }));
      const path = join(dir, CHECKPOINT_FILES.state);
      const text = await readFile(path, 'utf8');
      await writeFile(path, text.replace('"step":2', '"step":3'));
      const loaded = await store.load();
      expect(loaded.recoveredFrom).toBe('prev');
      expect(loaded.state.step).toBe(1);
      expect(store.lastWarnings().join(' ')).toMatch(/checksum mismatch/);
    }));

  it('falls back to prev on a version mismatch and on a truncated file', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta());
      await store.writeState(makeState({ step: 1 }));
      await store.writeState(makeState({ step: 2 }));
      const path = join(dir, CHECKPOINT_FILES.state);
      const text = await readFile(path, 'utf8');
      await writeFile(path, text.replace('"version":1', '"version":2'));
      expect((await store.load()).recoveredFrom).toBe('prev');
      // TUI-DESIGN-4 §7.9: a *newer* envelope is named as such so the caller can offer `jevcode upgrade`
      expect(store.lastWarnings().join(' ')).toMatch(/written by a newer JevCode \(state\.json v2; this build reads v1\)/);
      await writeFile(path, text.slice(0, text.length >> 1));
      expect((await store.load()).recoveredFrom).toBe('prev');
      expect(store.lastWarnings().join(' ')).toMatch(/not JSON/);
    }));

  it('falls back to prev when state.json is missing', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta());
      await store.writeState(makeState({ step: 1 }));
      await rename(join(dir, CHECKPOINT_FILES.state), join(dir, CHECKPOINT_FILES.prev));
      const loaded = await store.load();
      expect(loaded.recoveredFrom).toBe('prev');
      expect(store.lastWarnings().join(' ')).toMatch(/missing/);
    }));

  it('rejects a state whose runId does not match run.json', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta({ runId: '20260919-120000-zzzzzzzz' }));
      await store.writeState(makeState({ step: 1 }));
      const err = await store.load().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CheckpointError);
      expect((err as CheckpointError).message).toMatch(/does not match/);
    }));

  it('throws CheckpointError (exit 3) naming the dir when both files are bad, and when run.json is missing', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      let err = await store.load().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CheckpointError);
      await store.create(makeMeta());
      await store.writeState(makeState({ step: 1 }));
      await store.writeState(makeState({ step: 2 }));
      await writeFile(join(dir, CHECKPOINT_FILES.state), '{garbage');
      await writeFile(join(dir, CHECKPOINT_FILES.prev), '{"version":1,"checksum":"00","state":{}}');
      err = await store.load().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CheckpointError);
      expect((err as CheckpointError).exitCode).toBe(3);
      expect((err as CheckpointError).runDir).toBe(dir);
      expect((err as CheckpointError).message).toContain(dir);
      expect((err as CheckpointError).message).toMatch(/state\.json not JSON/);
      expect((err as CheckpointError).message).toMatch(/state\.prev\.json checksum mismatch/);
    }));

  it('writeStateSync produces a loadable checkpoint and rotates prev', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta());
      await store.writeState(makeState({ step: 4 }));
      store.writeStateSync(makeState({ step: 5, stopReason: 'signal' }));
      const loaded = await store.load();
      expect(loaded.recoveredFrom).toBe('state');
      expect(loaded.state.step).toBe(5);
      expect(loaded.state.stopReason).toBe('signal');
      expect((await readEnvelope(dir, CHECKPOINT_FILES.prev)).state.step).toBe(4);
      expect((await readdir(dir)).filter((f) => f.includes('.tmp-'))).toEqual([]);
    }));

  it('serialises concurrent writeState calls in order', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta());
      await Promise.all([1, 2, 3, 4, 5].map((n) => store.writeState(makeState({ step: n }))));
      expect((await readEnvelope(dir, CHECKPOINT_FILES.state)).state.step).toBe(5);
      expect((await readEnvelope(dir, CHECKPOINT_FILES.prev)).state.step).toBe(4);
    }));

  it('parseEnvelope validates shape after the checksum', () => {
    const env = serialiseEnvelope(makeState(), identity);
    expect(parseEnvelope(env)).toMatchObject({ ok: true });
    const bad = JSON.stringify({ version: 1, checksum: sha256Hex('{"runId":"x"}'), state: { runId: 'x' } });
    expect(parseEnvelope(bad)).toEqual({ ok: false, reason: 'state shape invalid' });
  });
});

describe('appends', () => {
  it('100 concurrent appendDecisions produce 100 intact lines in call order', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      const payload = 'x'.repeat(4000); // large enough that interleaving would be visible
      await Promise.all(Array.from({ length: 100 }, (_, i) => store.appendDecisions([makeDecision(1, `d${i}-${payload}`)])));
      const lines = await readLines(dir, CHECKPOINT_FILES.decisions);
      expect(lines).toHaveLength(100);
      lines.forEach((line, i) => {
        const d = JSON.parse(line) as { id: string };
        expect(d.id.startsWith(`d${i}-`)).toBe(true);
      });
    }));

  it('a batch of decisions is one contiguous group of lines; an empty batch writes nothing', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.appendDecisions([]);
      await expect(readFile(join(dir, CHECKPOINT_FILES.decisions), 'utf8')).rejects.toBeTruthy();
      await store.appendDecisions([makeDecision(1, 'a'), makeDecision(1, 'b'), makeDecision(1, 'c')]);
      expect((await readLines(dir, CHECKPOINT_FILES.decisions)).map((l) => (JSON.parse(l) as { id: string }).id)).toEqual(['a', 'b', 'c']);
    }));

  it('appendStep / appendJevRequest / appendGenerator / appendTranscript write one line each', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.appendStep(makeStepRecord(1));
      await store.appendJevRequest({ step: 1, stage: 'intent', requestHash: 'h', latencyMs: 5, questions: 3, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 }, model: 'jev', attempts: 1 });
      await store.appendGenerator({ step: 1, attempt: 1, promptHash: 'p', model: 'm', temperature: null, maxTokens: 10, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 }, latencyMs: 1, stopReason: 'end_turn', malformed: false });
      await store.appendTranscript('hello\n');
      await store.appendTranscript('world');
      expect(await readLines(dir, CHECKPOINT_FILES.steps)).toHaveLength(1);
      expect(await readLines(dir, CHECKPOINT_FILES.jev)).toHaveLength(1);
      expect(await readLines(dir, CHECKPOINT_FILES.generator)).toHaveLength(1);
      expect(await readLines(dir, CHECKPOINT_FILES.transcript)).toEqual(['hello', 'world']);
    }));

  it('flush awaits fire-and-forget appends', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      for (let i = 0; i < 20; i++) void store.appendTranscript(`line ${i}`);
      await store.flush();
      expect(await readLines(dir, CHECKPOINT_FILES.transcript)).toHaveLength(20);
    }));

  it('a failed append rejects the caller with CheckpointError and does not stall the queue', () =>
    withTempDir(async (dir) => {
      const missing = join(dir, 'gone');
      const store = createCheckpointStore(missing, identity);
      const err = await store.appendTranscript('x').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CheckpointError);
      await mkdir(missing);
      await store.appendTranscript('y');
      await store.flush();
      expect(await readLines(missing, CHECKPOINT_FILES.transcript)).toEqual(['y']);
    }));
});

describe('readStepsAfter', () => {
  it('returns [] when steps.jsonl does not exist', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      expect(await store.readStepsAfter(0)).toEqual([]);
      expect(store.lastWarnings()).toEqual([]);
    }));

  it('skips a torn trailing line with a warning and keeps the last record per step', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.appendStep(makeStepRecord(1));
      await store.appendStep(makeStepRecord(2, { intent: 'edit' }));
      await store.appendStep(makeStepRecord(3));
      await store.appendStep(makeStepRecord(2, { intent: 'verify' })); // re-run of a discarded step (§9.1 rule 1)
      await appendFile(join(dir, CHECKPOINT_FILES.steps), '{"step":4,"startedAt":"2026-09-19T', 'utf8');
      const after1 = await store.readStepsAfter(1);
      expect(after1.map((r) => r.step)).toEqual([2, 3]);
      expect(after1[0]?.intent).toBe('verify');
      expect(store.lastWarnings()).toHaveLength(1);
      expect(store.lastWarnings()[0]).toMatch(/trailing line/);
      expect(await store.readStepsAfter(3)).toEqual([]);
      expect((await store.readStepsAfter(0)).map((r) => r.step)).toEqual([1, 2, 3]);
    }));

  it('skips a corrupt middle line and a row without a valid step, warning per line', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.appendStep(makeStepRecord(1));
      await appendFile(join(dir, CHECKPOINT_FILES.steps), 'not json\n{"step":"x"}\n\n', 'utf8');
      await store.appendStep(makeStepRecord(2));
      expect((await store.readStepsAfter(0)).map((r) => r.step)).toEqual([1, 2]);
      expect(store.lastWarnings()).toHaveLength(2);
      expect(store.lastWarnings()[0]).toMatch(/line 2/);
    }));
});

describe('redaction', () => {
  it('redactDeep maps string leaves only and drops undefined', () => {
    const out = redactDeep({ a: FAKE_KEY, b: [FAKE_KEY, 1, null], c: { d: `x ${FAKE_KEY} y` }, e: undefined }, fakeRedact);
    expect(out).toEqual({ a: REDACTED, b: [REDACTED, 1, null], c: { d: `x ${REDACTED} y` } });
  });

  it('a fake key never reaches disk through any artefact', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, fakeRedact);
      await store.create(makeMeta({ task: `use ${FAKE_KEY}` }));
      await store.updateMeta({ overrides: [{ setting: 'k', from: FAKE_KEY, to: FAKE_KEY, atStep: 1 }] });
      await store.writeState(makeState({ plan: { done: [], remaining: [FAKE_KEY], unverified: [], openProblems: [], harnessProblems: [] } }));
      await store.writeState(makeState({ step: 1, window: [{ step: 1, intent: null, action: FAKE_KEY, outcome: null, shownFiles: [], notes: [FAKE_KEY] }] }));
      store.writeStateSync(makeState({ step: 2, createdThisRun: [FAKE_KEY] }));
      await store.appendStep(makeStepRecord(1, { proposal: { goal: 'g', action: { kind: 'run', command: `curl -H 'x: ${FAKE_KEY}'` }, plan: { done: [], remaining: [], openProblems: [] }, rawText: FAKE_KEY } }));
      await store.appendDecisions([makeDecision(1, FAKE_KEY)]);
      await store.appendJevRequest({ step: 1, stage: 'intent', requestHash: FAKE_KEY, latencyMs: 1, questions: 1, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 1 }, model: 'm', attempts: 1 });
      await store.appendGenerator({ step: 1, attempt: 1, promptHash: FAKE_KEY, model: 'm', temperature: null, maxTokens: 1, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 1 }, latencyMs: 1, stopReason: 's', malformed: false });
      await store.appendTranscript(`$ export KEY=${FAKE_KEY}`);
      await store.writeUi({ draft: FAKE_KEY });
      await store.flush();
      const files = await readdir(dir);
      // every artefact the store itself writes (log / lock / pre / post / tmp / drafts belong to other modules)
      const F = CHECKPOINT_FILES;
      expect(files.sort()).toEqual([F.meta, F.state, F.prev, F.steps, F.decisions, F.jev, F.generator, F.transcript, F.ui].sort());
      for (const f of files) {
        const text = await readFile(join(dir, f), 'utf8');
        expect(text, f).not.toContain(FAKE_KEY);
        expect(text, f).toContain(REDACTED);
      }
      // the checksum is over the redacted state, so load() still verifies
      const loaded = await store.load();
      expect(loaded.state.createdThisRun).toEqual([REDACTED]);
      await rm(dir, { recursive: true, force: true });
    }));
});

describe('rotation after a failed load', () => {
  it('does not rename a corrupt state.json over the prev copy load() returned (async path)', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta());
      await store.writeState(makeState({ step: 1 }));
      await store.writeState(makeState({ step: 2 }));
      await writeFile(join(dir, CHECKPOINT_FILES.state), '{garbage');
      expect((await store.load()).recoveredFrom).toBe('prev');
      await store.writeState(makeState({ step: 3 }));
      // prev still holds the only envelope that was valid at load time; the garbage is parked aside
      expect((await readEnvelope(dir, CHECKPOINT_FILES.state)).state.step).toBe(3);
      expect((await readEnvelope(dir, CHECKPOINT_FILES.prev)).state.step).toBe(1);
      expect(await readFile(join(dir, CORRUPT_STATE_FILE), 'utf8')).toBe('{garbage');
      // the guard is one-shot: the next write rotates normally again
      await store.writeState(makeState({ step: 4 }));
      expect((await readEnvelope(dir, CHECKPOINT_FILES.prev)).state.step).toBe(3);
      const loaded = await store.load();
      expect(loaded.recoveredFrom).toBe('state');
      expect(loaded.state.step).toBe(4);
    }));

  it('applies the same guard on the sync path; a runId mismatch counts as unusable', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta());
      await store.writeState(makeState({ step: 1 }));
      await store.writeState(makeState({ step: 2, runId: '20260919-120000-zzzzzzzz' }));
      expect((await store.load()).recoveredFrom).toBe('prev');
      store.writeStateSync(makeState({ step: 3 }));
      expect((await readEnvelope(dir, CHECKPOINT_FILES.prev)).state.step).toBe(1);
      expect((await readEnvelope(dir, CORRUPT_STATE_FILE)).state.step).toBe(2);
      expect((await store.load()).state.step).toBe(3);
    }));

  it('a state.json that was merely missing at load time rotates normally afterwards', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta());
      await store.writeState(makeState({ step: 1 }));
      await rename(join(dir, CHECKPOINT_FILES.state), join(dir, CHECKPOINT_FILES.prev));
      expect((await store.load()).recoveredFrom).toBe('prev');
      await store.writeState(makeState({ step: 2 }));
      expect((await readEnvelope(dir, CHECKPOINT_FILES.prev)).state.step).toBe(1);
      expect((await readdir(dir)).includes(CORRUPT_STATE_FILE)).toBe(false);
    }));
});

describe('serialisation failures', () => {
  it('a throwing redactor rejects the append with CheckpointError instead of throwing synchronously', () =>
    withTempDir(async (dir) => {
      const boom = (): string => {
        throw new Error('redactor bug');
      };
      const store = createCheckpointStore(dir, boom);
      let pending: Promise<void> | undefined;
      expect(() => {
        pending = store.appendStep(makeStepRecord(1));
      }).not.toThrow();
      await expect(pending).rejects.toBeInstanceOf(CheckpointError);
      await expect(store.appendTranscript('x')).rejects.toBeInstanceOf(CheckpointError);
      await expect(store.appendDecisions([makeDecision(1, 'a')])).rejects.toBeInstanceOf(CheckpointError);
      await store.flush();
      expect((await readdir(dir)).length).toBe(0);
    }));
});

// ---------------------------------------------------------------------------------------
// TUI-DESIGN §15 item 10 / §13.3 / §19.0: CHECKPOINT_FILES additions, writeUi, updateMeta({ git }), classifyDiskError
// ---------------------------------------------------------------------------------------

describe('contract 1.4 additions (COORDINATION-DESIGN §7.2, §7.4)', () => {
  it('writeCache writes <run>/cache/<rel> atomically and redacted, readCache reads it back, a missing file is null', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, fakeRedact);
      await store.create(makeMeta());
      await store.writeCache('step-3.json', { v: 1, step: 3, partial: { text: `key ${FAKE_KEY}`, chars: 4 } });
      const files = await readdir(join(dir, CHECKPOINT_FILES.cache));
      expect(files).toEqual(['step-3.json']);
      const text = await readFile(join(dir, CHECKPOINT_FILES.cache, 'step-3.json'), 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      expect(text).not.toContain(FAKE_KEY);
      expect(text).toContain(REDACTED);
      expect(await store.readCache('step-3.json')).toEqual({ v: 1, step: 3, partial: { text: `key ${REDACTED}`, chars: 4 } });
      expect(await store.readCache('step-4.json')).toBeNull();
      // nested rels create their parents; the store's flush awaits the chain
      void store.writeCache('llm/g1/0/2.json', { body: 'x' });
      await store.flush();
      expect(await store.readCache('llm/g1/0/2.json')).toEqual({ body: 'x' });
      // not JSON → null, never a throw
      await writeFile(join(dir, CHECKPOINT_FILES.cache, 'bad.json'), '{');
      expect(await store.readCache('bad.json')).toBeNull();
    }));

  it('renameCache supersedes a cache file: the bytes move, the old name is gone, a missing source is not an error, a bad rel rejects', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta());
      await store.writeCache('step-3.json', { v: 1, step: 3 });
      await store.renameCache('step-3.json', 'step-3.superseded.json');
      expect(await store.readCache('step-3.json')).toBeNull();
      expect(await store.readCache('step-3.superseded.json')).toEqual({ v: 1, step: 3 });
      expect(await readdir(join(dir, CHECKPOINT_FILES.cache))).toEqual(['step-3.superseded.json']);
      // nothing to supersede is the common case (a boundary pause wrote no cache)
      await expect(store.renameCache('step-9.json', 'step-9.superseded.json')).resolves.toBeUndefined();
      await expect(store.renameCache('../escape.json', 'step-1.json')).rejects.toBeInstanceOf(CheckpointError);
      await expect(store.renameCache('step-1.json', '/abs.json')).rejects.toBeInstanceOf(CheckpointError);
    }));

  it('a cache rel is validated: relative, no .., no absolute, no backslash; the writer rejects with CheckpointError', () =>
    withTempDir(async (dir) => {
      expect(cacheRelPath('step-1.json')).toBe('step-1.json');
      expect(cacheRelPath('llm/./g1//0.json')).toBe('llm/g1/0.json');
      for (const bad of ['', '../x.json', '/abs.json', 'a/../../b.json', 'a\\b.json', '..', '.']) expect(cacheRelPath(bad)).toBeNull();
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta());
      await expect(store.writeCache('../escape.json', { v: 1 })).rejects.toBeInstanceOf(CheckpointError);
      expect(await store.readCache('../escape.json')).toBeNull();
    }));

  // -------------------------------------------------------------------------------------
  // contract 1.5 (ORCHESTRATION-DESIGN §8.2 D0 item 4, §3.7, §2.5): the `orchestrate/` directory
  // -------------------------------------------------------------------------------------

  it('contract 1.5: writeCache routes an `orchestrate/` rel to <run>/orchestrate/, redacted, with its own per-file chain', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, fakeRedact);
      await store.create(makeMeta());
      await store.writeCache('orchestrate/manifest-11.json', { v: 1, manifestId: 'abc', token: `key ${FAKE_KEY}` });
      // the run-relative layout is <run>/orchestrate/manifest-11.json, NOT <run>/cache/orchestrate/...
      expect(await readdir(join(dir, CHECKPOINT_FILES.orchestrate))).toEqual(['manifest-11.json']);
      await expect(readdir(join(dir, CHECKPOINT_FILES.cache))).rejects.toThrow();
      const text = await readFile(join(dir, CHECKPOINT_FILES.orchestrate, 'manifest-11.json'), 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      expect(text).not.toContain(FAKE_KEY);
      expect(text).toContain(REDACTED);
      expect(await store.readCache('orchestrate/manifest-11.json')).toEqual({ v: 1, manifestId: 'abc', token: `key ${REDACTED}` });
      expect(await store.readCache('orchestrate/manifest-12.json')).toBeNull();
      // nested rels under orchestrate/ create their parents too (agent-<slug>/ subtrees)
      void store.writeCache('orchestrate/inbox/a.json', { body: 'x' });
      await store.flush();
      expect(await store.readCache('orchestrate/inbox/a.json')).toEqual({ body: 'x' });
      // the two roots never collide: the same leaf name in each is two files
      await store.writeCache('manifest-11.json', { v: 1, where: 'cache' });
      expect(await store.readCache('manifest-11.json')).toEqual({ v: 1, where: 'cache' });
      expect(await store.readCache('orchestrate/manifest-11.json')).toEqual({ v: 1, manifestId: 'abc', token: `key ${REDACTED}` });
    }));

  it('contract 1.5: renameCache consumes a review answer within orchestrate/, and never across the two roots (§2.5)', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta());
      await store.writeCache('orchestrate/review-4.json', { id: 'r4', approved: true });
      await store.renameCache('orchestrate/review-4.json', 'orchestrate/review-4.used');
      expect(await store.readCache('orchestrate/review-4.json')).toBeNull();
      expect(await store.readCache('orchestrate/review-4.used')).toEqual({ id: 'r4', approved: true });
      expect(await readdir(join(dir, CHECKPOINT_FILES.orchestrate))).toEqual(['review-4.used']);
      // a missing source stays a no-op under orchestrate/ too
      await expect(store.renameCache('orchestrate/review-9.json', 'orchestrate/review-9.used')).resolves.toBeUndefined();
      // crossing the roots is refused in both directions
      await store.writeCache('orchestrate/manifest-1.json', { v: 1 });
      await expect(store.renameCache('orchestrate/manifest-1.json', 'manifest-1.json')).rejects.toBeInstanceOf(CheckpointError);
      await store.writeCache('step-1.json', { v: 1 });
      await expect(store.renameCache('step-1.json', 'orchestrate/step-1.json')).rejects.toBeInstanceOf(CheckpointError);
    }));

  it('contract 1.5: an orchestrate rel is validated and bounded exactly like a cache rel', () =>
    withTempDir(async (dir) => {
      expect(cacheRelPath('orchestrate/manifest-1.json')).toBe('orchestrate/manifest-1.json');
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta());
      // normalisation is the SAME function, so `orchestrate/..` climbs back to the cache root and never out of the run dir
      expect(cacheRelPath('orchestrate/../escape.json')).toBe('escape.json');
      expect(cacheRelPath('orchestrate//x.json')).toBe('orchestrate/x.json');
      for (const bad of ['orchestrate/../../escape.json', 'orchestrate/a\\b.json', '/orchestrate/x.json']) {
        await expect(store.writeCache(bad, { v: 1 })).rejects.toBeInstanceOf(CheckpointError);
        expect(await store.readCache(bad)).toBeNull();
      }
      // `orchestrate` alone is the directory, not a file: it writes under cache/ like any other leaf, never over the directory
      await store.writeCache('orchestrate', { v: 1 });
      expect(await store.readCache('orchestrate')).toEqual({ v: 1 });
      expect(await readdir(join(dir, CHECKPOINT_FILES.cache))).toContain('orchestrate');
      // §3.7: a manifest is <= MANIFEST_BYTES; the store refuses an oversized orchestrate artefact rather than writing it
      await expect(store.writeCache('orchestrate/huge.json', { blob: 'x'.repeat(ORCHESTRATE_FILE_BYTES + 1) })).rejects.toBeInstanceOf(CheckpointError);
      expect(await store.readCache('orchestrate/huge.json')).toBeNull();
    }));

  it('updateMeta({ ended }) replaces as a scalar and null clears it; resumes[] entries keep `reopened`', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta());
      await store.updateMeta({ ended: { at: '2026-09-21T12:00:00.000Z', by: 'human' } });
      let onDisk = JSON.parse(await readFile(join(dir, CHECKPOINT_FILES.meta), 'utf8')) as ReturnType<typeof makeMeta>;
      expect(onDisk.ended).toEqual({ at: '2026-09-21T12:00:00.000Z', by: 'human' });
      await store.updateMeta({ resumes: [{ resumedAt: '2026-09-21T13:00:00.000Z', previousStopReason: 'human_pause', reopened: true }], ended: null });
      onDisk = JSON.parse(await readFile(join(dir, CHECKPOINT_FILES.meta), 'utf8')) as ReturnType<typeof makeMeta>;
      expect(onDisk.ended).toBeNull();
      expect(onDisk.resumes).toEqual([{ resumedAt: '2026-09-21T13:00:00.000Z', previousStopReason: 'human_pause', reopened: true }]);
      expect(onDisk.task).toBe('fix the bug');
      // the loader still accepts the meta
      const loaded = await createCheckpointStore(dir, identity).load().catch((e: unknown) => e);
      expect(loaded).toBeInstanceOf(CheckpointError); // no state.json yet — but the meta parsed (the error names the state files, not run.json)
      expect(String((loaded as Error).message)).toContain('no usable checkpoint');
    }));
});

describe('contract 1.1 additions (TUI-DESIGN §15 item 19, §13.3)', () => {
  it('CHECKPOINT_FILES names the session-era artefacts', async () => {
    const { DISK_ERROR_CODES } = await import('../../../src/checkpoint/store.js');
    expect(CHECKPOINT_FILES.ui).toBe('ui.json');
    expect(CHECKPOINT_FILES.log).toBe('jevcode.log');
    expect(CHECKPOINT_FILES.lock).toBe('run.lock');
    expect(CHECKPOINT_FILES.pre).toBe('pre');
    expect(CHECKPOINT_FILES.post).toBe('post');
    expect(CHECKPOINT_FILES.tmp).toBe('tmp');
    expect(CHECKPOINT_FILES.drafts).toBe('drafts');
    // contract 1.5 (ORCHESTRATION-DESIGN §8.2 D0 item 4): the delegation's own run-dir directory
    expect(CHECKPOINT_FILES.orchestrate).toBe('orchestrate');
    // TUI-DESIGN-4 §7.2 edge 2: ENOENT joins the set (the `rundir:rm` fault and the measured silent run)
    expect(DISK_ERROR_CODES).toEqual(['ENOSPC', 'EACCES', 'EROFS', 'EDQUOT', 'EIO', 'EMFILE', 'ENOENT']);
  });

  it('writeUi writes ui.json atomically and redacted', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, fakeRedact);
      await store.writeUi({ theme: 'dark', note: `key ${FAKE_KEY}`, nested: { list: [1, 'two', null] } });
      const onDisk = JSON.parse(await readFile(join(dir, CHECKPOINT_FILES.ui), 'utf8')) as Record<string, unknown>;
      expect(onDisk['theme']).toBe('dark');
      expect(onDisk['note']).toBe(`key ${REDACTED}`);
      expect(onDisk['nested']).toEqual({ list: [1, 'two', null] });
      expect((await readdir(dir)).filter((f) => f.includes('.tmp-'))).toEqual([]);
      // a second write replaces the first (scalar file, no append)
      await store.writeUi({ theme: 'light' });
      expect(JSON.parse(await readFile(join(dir, CHECKPOINT_FILES.ui), 'utf8'))).toEqual({ theme: 'light' });
    }));

  it('updateMeta({ git }) / title / instructions replace as scalars and keep every other field', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta());
      const git = { repo: true, head: { kind: 'branch' as const, name: 'main', oid: 'abc123' }, upstream: 'origin/main', linkedWorktree: false, prefix: '', dirtyAtStart: { modified: 1, staged: 0, untracked: 2 } };
      await store.updateMeta({ git, title: 'first title', instructions: [{ path: 'AGENTS.md', sha256: 'deadbeef', bytes: 12 }] });
      let onDisk = JSON.parse(await readFile(join(dir, CHECKPOINT_FILES.meta), 'utf8')) as ReturnType<typeof makeMeta>;
      expect(onDisk.git).toEqual(git);
      expect(onDisk.title).toBe('first title');
      expect(onDisk.instructions).toEqual([{ path: 'AGENTS.md', sha256: 'deadbeef', bytes: 12 }]);
      expect(onDisk.task).toBe('fix the bug');
      // run:end re-probe (P51): the whole git record is replaced, not merged
      await store.updateMeta({ git: { ...git, end: { head: git.head, upstream: 'origin/main', ahead: 2, behind: 0, dirty: { modified: 0, staged: 0, untracked: 0 } } } });
      onDisk = JSON.parse(await readFile(join(dir, CHECKPOINT_FILES.meta), 'utf8')) as ReturnType<typeof makeMeta>;
      expect(onDisk.git?.end?.ahead).toBe(2);
      expect(onDisk.title).toBe('first title');
      // a patch without the new keys never writes `undefined` into them
      await store.updateMeta({ resolvedJevModel: 'jev-1.13' });
      const text = await readFile(join(dir, CHECKPOINT_FILES.meta), 'utf8');
      expect(text).not.toContain('undefined');
      expect((JSON.parse(text) as ReturnType<typeof makeMeta>).title).toBe('first title');
    }));

  it('classifyDiskError: the seven codes through a cause chain, file inferred from the message, null otherwise', async () => {
    const { classifyDiskError } = await import('../../../src/checkpoint/store.js');
    const errno = (code: string): Error & { code: string } => Object.assign(new Error(`${code}: boom`), { code });
    expect(classifyDiskError(errno('ENOSPC'), 'state.json')).toEqual({
      code: 'ENOSPC',
      file: 'state.json',
      text: 'checkpoint degraded: ENOSPC on state.json',
      // TUI-DESIGN-4 §7.2 edge 6: the whole sentence, never the raw `open '<path>'` suffix
      sentence: 'checkpoint degraded: ENOSPC on state.json — the disk is full; this run cannot be resumed',
      key: 'state.json:ENOSPC',
    });
    // wrapped by the store's fail(): the file is named in the message and the errno sits in `cause`
    const wrapped = new CheckpointError('cannot rotate state.json: ENOSPC: no space left on device (/tmp/run)', '/tmp/run', { cause: errno('ENOSPC') });
    expect(classifyDiskError(wrapped)).toMatchObject({ code: 'ENOSPC', file: 'state.json' });
    const append = new CheckpointError('append to steps.jsonl failed: EACCES (/tmp/run)', '/tmp/run', { cause: errno('EACCES') });
    expect(classifyDiskError(append)).toMatchObject({ code: 'EACCES', file: 'steps.jsonl', key: 'steps.jsonl:EACCES' });
    for (const code of ['EROFS', 'EDQUOT', 'EIO', 'EMFILE', 'ENOENT']) expect(classifyDiskError(errno(code))?.code).toBe(code);
    // unknown file → "run dir"
    expect(classifyDiskError(errno('EROFS'))).toEqual({
      code: 'EROFS',
      file: null,
      text: 'checkpoint degraded: EROFS on run dir',
      sentence: 'checkpoint degraded: EROFS on run dir — the run directory is not writable; this run cannot be resumed',
      key: 'run dir:EROFS',
    });
    // TUI-DESIGN-4 §7.2 edge 2: ENOENT now classifies (write paths only)
    expect(classifyDiskError(errno('ENOENT'))?.sentence).toBe('checkpoint degraded: ENOENT on run dir — the run directory was removed during the run; this run cannot be resumed');
    expect(classifyDiskError(new Error('plain'))).toBeNull();
    expect(classifyDiskError(null)).toBeNull();
    expect(classifyDiskError('ENOSPC')).toBeNull();
    // a cyclic cause chain terminates
    const cyclic: Error & { cause?: unknown } = new Error('loop');
    cyclic.cause = cyclic;
    expect(classifyDiskError(cyclic)).toBeNull();
    // the explicit file wins over the message
    expect(classifyDiskError(wrapped, 'ui.json')?.file).toBe('ui.json');
  });

  it('classifyDiskError: a run-dir path containing an artefact name never names that file; the earliest artefact in the text wins', async () => {
    const { classifyDiskError } = await import('../../../src/checkpoint/store.js');
    const errno = (code: string, msg = `${code}: boom`): Error & { code: string } => Object.assign(new Error(msg), { code });
    const runDir = '/tmp/ui.json-runs/abc';
    // no artefact outside the run dir → run dir
    const listing = new CheckpointError(`cannot list post images: ENOSPC (${runDir})`, runDir, { cause: errno('ENOSPC') });
    expect(classifyDiskError(listing)).toMatchObject({ code: 'ENOSPC', file: null, text: 'checkpoint degraded: ENOSPC on run dir', key: 'run dir:ENOSPC' });
    // the errno text names the temp file under the run dir: the artefact is state.json, not ui.json
    const tmp = new CheckpointError(`cannot write state.json temp file: ENOSPC: write '${runDir}/state.json.tmp-1-abcd' (${runDir})`, runDir, { cause: errno('ENOSPC') });
    expect(classifyDiskError(tmp)).toMatchObject({ file: 'state.json', key: 'state.json:ENOSPC' });
    // the rotation names both state.json and state.prev.json: the one that comes first in the text is the failing write
    const rotate = new CheckpointError(`cannot rotate state.json: EIO: rename '${runDir}/state.json' -> '${runDir}/state.prev.json' (${runDir})`, runDir, { cause: errno('EIO') });
    expect(classifyDiskError(rotate)?.file).toBe('state.json');
    const prevFirst = new CheckpointError(`cannot rename state.prev.json aside for state.json: EIO (${runDir})`, runDir, { cause: errno('EIO') });
    expect(classifyDiskError(prevFirst)?.file).toBe('state.prev.json');
    // a plain errno carries no runDir to strip: the explicit `file` argument is what every engine call site passes
    expect(classifyDiskError(errno('EACCES', `EACCES: open '/tmp/jevcode.log-dir/x'`), 'steps.jsonl')?.file).toBe('steps.jsonl');
    expect(classifyDiskError(errno('EACCES', `EACCES: open '/tmp/x'`))?.file).toBeNull();
  });

  it('overlapping writeUi calls serialise: the last wins, the file is whole JSON, no temp file is left behind', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      const writes: Promise<void>[] = [];
      for (let i = 0; i < 25; i++) writes.push(store.writeUi({ seq: i, pad: 'x'.repeat(2000 + i) }));
      await Promise.all(writes);
      await store.flush();
      const text = await readFile(join(dir, CHECKPOINT_FILES.ui), 'utf8');
      expect((JSON.parse(text) as { seq: number }).seq).toBe(24);
      expect(text.endsWith('}\n')).toBe(true);
      expect((await readdir(dir)).filter((f) => f.includes('.tmp-'))).toEqual([]);
      expect(await readdir(dir)).toEqual([CHECKPOINT_FILES.ui]);
    }));
});
