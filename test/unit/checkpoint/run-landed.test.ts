/**
 * contract 1.5 (ORCHESTRATION-DESIGN §5.7 / §5.8): `RunMeta.landed[]` and `RunMeta.undoUnavailableBelow` in `run.json`.
 *
 * `Engine.land` records one row per landed agent and raises the undo floor, both through `updateMeta` — whose Pick has
 * carried the two members since the engine wave while the implementation silently dropped them, so `landedUndoOffer` /
 * `rewindRefusal` had nothing to read. `landed` APPENDS (like overrides/resumes); `undoUnavailableBelow` is a monotonic
 * MAX, never a scalar replace.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunMeta } from '../../../src/core/types.js';
import { CHECKPOINT_FILES, createCheckpointStore } from '../../../src/checkpoint/store.js';
import { makeMeta, makeState, withTempDir } from '../../fixtures/checkpoint/make.js';

const identity = (s: string): string => s;

async function readMeta(dir: string): Promise<RunMeta> {
  return JSON.parse(await readFile(join(dir, CHECKPOINT_FILES.meta), 'utf8')) as RunMeta;
}

describe('run.json landed[] / undoUnavailableBelow', () => {
  it('two landings append two rows and the undo floor is the max of what was written', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta());
      await store.updateMeta({ landed: [{ step: 4, branch: 'jevcode/fix-store', commit: 'a'.repeat(40) }], undoUnavailableBelow: 4 });
      await store.updateMeta({ landed: [{ step: 7, branch: 'jevcode/fix-tui', commit: 'b'.repeat(40) }], undoUnavailableBelow: 7 });
      // a late write from an older incarnation must not lower the floor
      await store.updateMeta({ undoUnavailableBelow: 2 });
      await store.writeState(makeState());
      const meta = await readMeta(dir);
      expect(meta.landed?.map((l) => l.step)).toEqual([4, 7]);
      expect(meta.landed?.[1]?.branch).toBe('jevcode/fix-tui');
      expect(meta.undoUnavailableBelow).toBe(7);
      const loaded = await store.load();
      expect(loaded.meta.landed?.length).toBe(2);
      expect(loaded.meta.undoUnavailableBelow).toBe(7);
    }));

  it('a run that never lands carries neither member', () =>
    withTempDir(async (dir) => {
      const store = createCheckpointStore(dir, identity);
      await store.create(makeMeta());
      await store.updateMeta({ title: 'x' });
      const meta = await readMeta(dir);
      expect('landed' in meta).toBe(false);
      expect('undoUnavailableBelow' in meta).toBe(false);
    }));
});
