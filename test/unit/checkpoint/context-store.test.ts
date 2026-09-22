/**
 * The context policy's artefacts under the run dir (docs/COORDINATION-DESIGN.md §8.3, §8.6, W2 item 20) and the checkpoint
 * compatibility the round promised: the envelope version is unchanged, the state additions are optional, and a restored
 * state is treated as untrusted input (§9.3, §10).
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckpointState } from '../../../src/core/types.js';
import { CHECKPOINT_FILES, CHECKPOINT_VERSION, CONTEXT_SUMMARY_FILE, OUTPUT_FILE_MAX_CHARS, createCheckpointStore, outputFileName, parseEnvelope, serialiseEnvelope } from '../../../src/checkpoint/store.js';
import { hasContextStore, readContextExtension } from '../../../src/checkpoint/types.js';
import { FAKE_KEY, REDACTED, fakeRedact, makeState, withTempDir } from '../../fixtures/checkpoint/make.js';
import { fileMemoryFromPostImage } from '../../../src/checkpoint/images.js';
import type { PostImage } from '../../../src/checkpoint/images.js';

const identity = (s: string): string => s;

describe('§8.3 outputs/step-<n>.txt', () => {
  it('writes the whole output, redacted, and reads it back', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, fakeRedact);
      expect(hasContextStore(store)).toBe(true);
      await store.writeOutput(7, `FAILED test_f\nkey ${FAKE_KEY}\n${'x'.repeat(50_000)}`);
      const text = await store.readOutput(7);
      expect(text).toContain(REDACTED);
      expect(text).not.toContain(FAKE_KEY);
      expect(text!.length).toBeGreaterThan(50_000);
      expect(await readdir(join(dir, CHECKPOINT_FILES.outputs))).toEqual([outputFileName(7)]);
      expect(await store.readOutput(8)).toBeNull();
    }));

  it('one file is at most 1 MiB (head + tail with the omission marker)', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.writeOutput(1, 'A'.repeat(3 * 1024 * 1024));
      const text = (await store.readOutput(1))!;
      expect(text.length).toBeLessThanOrEqual(OUTPUT_FILE_MAX_CHARS);
      expect(text).toContain('chars omitted');
    }));

  it('refuses a step that is not a positive integer (never joins a caller string into a path)', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await expect(store.writeOutput(0, 'x')).rejects.toThrow();
      await expect(store.writeOutput(-1, 'x')).rejects.toThrow();
      await expect(store.writeOutput(1.5, 'x')).rejects.toThrow();
      expect(() => outputFileName(2)).not.toThrow();
    }));

  it('a run of many outputs keeps the newest when the directory bound is passed', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      // the bound is 64 MiB; write it with 1 MiB files so the oldest are deleted
      for (let step = 1; step <= 70; step++) await store.writeOutput(step, 'y'.repeat(1024 * 1024));
      const names = await readdir(join(dir, CHECKPOINT_FILES.outputs));
      expect(names).toContain(outputFileName(70));
      expect(names.length).toBeLessThanOrEqual(65);
      expect(names.length).toBeGreaterThan(50);
      expect(await store.readOutput(70)).not.toBeNull();
    }), 60_000);
});

describe('§8.6 context/summary.json', () => {
  it('writes and reads the rolling summary, redacted and atomic', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, fakeRedact);
      await store.writeContextSummary({ v: 1, step: 8, text: `Objective:\n- use ${FAKE_KEY}` });
      const raw = await readFile(join(dir, CHECKPOINT_FILES.context, CONTEXT_SUMMARY_FILE), 'utf8');
      expect(raw.endsWith('\n')).toBe(true);
      expect(raw).toContain(REDACTED);
      const back = (await store.readContextSummary()) as { step: number; text: string };
      expect(back.step).toBe(8);
      expect(back.text).toContain(REDACTED);
    }));

  it('a missing or unparsable summary reads as null, never throws into the loop', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      expect(await store.readContextSummary()).toBeNull();
      await mkdir(join(dir, CHECKPOINT_FILES.context), { recursive: true });
      await writeFile(join(dir, CHECKPOINT_FILES.context, CONTEXT_SUMMARY_FILE), '{not json');
      expect(await store.readContextSummary()).toBeNull();
    }));
});

describe('§8 checkpoint compatibility', () => {
  it('the envelope version is unchanged and a state carrying the additions round-trips', () => {
    expect(CHECKPOINT_VERSION).toBe(1);
    const state = {
      ...makeState({ step: 9 }),
      history: [{ step: 9, intent: 'run', action: 'run pytest -q', outcome: 'executed', shownFiles: [], notes: [], output: 'tail', outputRef: 'outputs/step-9.txt', fullOutputChars: 41_000 }],
      fileCache: [{ rel: 'src/a.ts', pinnedBy: 'edit', lastUsedStep: 9, bytesShown: 120 }],
      fileMemory: { 'src/a.ts': { sha12: 'abcdef012345', bytes: 120, readAt: 4, editedAt: 9 } },
      summaryAt: 8,
      compactions: 1,
      lastCompactionAt: '2026-09-21T10:00:00.000Z',
    } as unknown as CheckpointState;
    const parsed = parseEnvelope(serialiseEnvelope(state, identity));
    expect(parsed.ok).toBe(true);
    const ext = readContextExtension(parsed.ok ? parsed.state : makeState());
    expect(ext.history).toHaveLength(1);
    expect(ext.history![0]!.outputRef).toBe('outputs/step-9.txt');
    expect(ext.fileCache).toEqual([{ rel: 'src/a.ts', pinnedBy: 'edit', lastUsedStep: 9, bytesShown: 120 }]);
    expect(ext.fileMemory).toEqual({ 'src/a.ts': { sha12: 'abcdef012345', bytes: 120, readAt: 4, editedAt: 9 } });
    expect(ext).toMatchObject({ summaryAt: 8, compactions: 1, lastCompactionAt: '2026-09-21T10:00:00.000Z' });
  });

  it('a state written before the additions landed yields an empty extension', () => {
    expect(readContextExtension(makeState())).toEqual({});
  });

  it('a hostile or half-typed state is dropped member by member, never trusted', () => {
    const state = {
      ...makeState(),
      history: [
        'not an object',
        { step: 0, action: 'x', shownFiles: [], notes: [] },
        { step: 3, action: 'run x', shownFiles: 'oops', notes: null, outcome: 7, outputRef: '../../etc/passwd', fullOutputChars: 'big' },
        { step: 2, action: 'run y', shownFiles: [], notes: [], outputRef: 'outputs/step-9.txt' },
      ],
      fileCache: [{ rel: '../escape.ts', pinnedBy: 'read', lastUsedStep: 1, bytesShown: 0 }, { rel: 'ok.ts', pinnedBy: 'nope', lastUsedStep: 1, bytesShown: 0 }, { rel: 'ok.ts', pinnedBy: 'read', lastUsedStep: -5, bytesShown: -9 }, { rel: 'ok.ts', pinnedBy: 'human', lastUsedStep: 2, bytesShown: 1 }],
      fileMemory: { '/etc/passwd': { sha12: 'a', bytes: 1, readAt: 1, editedAt: null }, 'fine.ts': { sha12: 'NOT HEX', bytes: '10', readAt: 'x', editedAt: 3 } },
      summaryAt: 'soon',
      compactions: -4,
      lastCompactionAt: 42,
    } as unknown as CheckpointState;
    const ext = readContextExtension(state);
    // step 0 and the non-object are dropped; the escaping ref is dropped; the sane rows survive in step order
    expect(ext.history!.map((e) => e.step)).toEqual([2, 3]);
    expect(ext.history!.find((e) => e.step === 3)!.outputRef).toBeUndefined();
    expect(ext.history!.find((e) => e.step === 3)!.shownFiles).toEqual([]);
    expect(ext.history!.find((e) => e.step === 3)!.fullOutputChars).toBeUndefined();
    // a ref that names another step is not accepted for this entry
    expect(ext.history!.find((e) => e.step === 2)!.outputRef).toBeUndefined();
    expect(ext.fileCache!.map((e) => e.rel)).toEqual(['ok.ts']);
    expect(ext.fileCache![0]).toMatchObject({ pinnedBy: 'read', lastUsedStep: 0, bytesShown: 0 });
    expect(Object.keys(ext.fileMemory!)).toEqual(['fine.ts']);
    expect(ext.fileMemory!['fine.ts']).toEqual({ sha12: null, bytes: 0, readAt: null, editedAt: 3 });
    expect(ext.summaryAt).toBeUndefined();
    expect(ext.compactions).toBeUndefined();
    expect(ext.lastCompactionAt).toBeUndefined();
  });

  it('history is bounded to the newest N entries', () => {
    const history = Array.from({ length: 40 }, (_, i) => ({ step: i + 1, intent: null, action: `run ${i}`, outcome: 'executed', shownFiles: [], notes: [] }));
    const ext = readContextExtension({ ...makeState(), history } as unknown as CheckpointState, 12);
    expect(ext.history).toHaveLength(12);
    expect(ext.history!.map((e) => e.step)).toEqual([29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40]);
  });
});

describe('§8.4 fileMemory from the post image (no second read)', () => {
  it('carries the sha12 and size already computed, and flags deletions', () => {
    const image = {
      step: 6,
      files: { 'src/a.ts': { sha256: 'abcdef0123456789', bytes: 120 }, 'src/gone.ts': { deleted: true }, 'src/skipped.ts': { bytes: 40_000_000, hashSkipped: true } },
    } as unknown as PostImage;
    expect(fileMemoryFromPostImage(image)).toEqual([
      { rel: 'src/a.ts', sha12: 'abcdef012345', bytes: 120, deleted: false },
      { rel: 'src/gone.ts', sha12: null, bytes: null, deleted: true },
      { rel: 'src/skipped.ts', sha12: null, bytes: 40_000_000, deleted: false },
    ]);
  });
});
