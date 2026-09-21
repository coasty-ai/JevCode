/** TUI-DESIGN §12.4 / §20: apply.ts is wave 2; wave 1 ships the typed surface that throws. */
import { describe, expect, it } from 'vitest';
import { NOT_WIRED, applyRewind, applyUndo, type ApplyUndoDeps } from '../../../src/undo/apply.js';
import type { UndoPlan } from '../../../src/undo/plan.js';

const plan: UndoPlan = { step: 1, decisions: [], refusals: [], asks: [] };
const deps: ApplyUndoDeps = {
  runDir: '/tmp/run',
  runId: 'r1',
  root: '/tmp/ws',
  restoreFromHead: () => Promise.resolve({ restored: [], failed: [] }),
  nowIso: () => '2026-09-20T00:00:00.000Z',
};

describe('undo/apply.ts (wave 2 stub)', () => {
  it('applyUndo and applyRewind throw `not wired in wave 1` synchronously and never touch deps', () => {
    let calls = 0;
    const spyDeps: ApplyUndoDeps = { ...deps, restoreFromHead: () => (calls++, Promise.resolve({ restored: [], failed: [] })) };
    expect(() => applyUndo(plan, spyDeps)).toThrow(NOT_WIRED);
    expect(() => applyRewind([plan], spyDeps)).toThrow(NOT_WIRED);
    expect(NOT_WIRED).toBe('not wired in wave 1');
    expect(calls).toBe(0);
  });
});
