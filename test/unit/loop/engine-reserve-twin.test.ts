/**
 * [D6] one arithmetic for the reserve. `src/tui/budget/lines.ts:sessionRemainingUsd(cap, spent, heldUsd = 0)` grew its
 * third argument (main d8490fa), so the private twin the orchestration wave carried in `src/loop/engine.ts`
 * (`sessionRemainingNetOfHolds`, with the comment "one line to delete when the third argument lands") has no reason to
 * exist: the engine already imports that module (`engine.ts:134`), and two copies of a money rule are exactly how a
 * parent comes to promise the same dollar to two children.
 *
 * The first `it` is a SOURCE-TEXT pin, because `decomposeReserveUsd` and `decomposeFacts` are private: the twin's name
 * must appear nowhere in the engine, and the TUI function must be the one it imports. The second is the behavioural
 * half — the edges the twin spelled out by hand, held to the TUI function's answers.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessionRemainingUsd } from '../../../src/tui/budget/lines.js';

const ROOT = join(import.meta.dirname, '../../..');
const engineSrc = readFileSync(join(ROOT, 'src/loop/engine.ts'), 'utf8');

describe('[D6] the reserve arithmetic is the TUI function, once', () => {
  it('src/loop/engine.ts holds no private twin and imports sessionRemainingUsd from the budget module', () => {
    expect(engineSrc).not.toContain('sessionRemainingNetOfHolds');
    const importLine = engineSrc.split('\n').find((l) => l.includes("from '../tui/budget/lines.js'"));
    expect(importLine, 'the engine must import the budget module it already depends on').toBeDefined();
    expect(importLine).toContain('sessionRemainingUsd');
    // and the reserve and the gate facts are both computed through it, clamped at 0 exactly where they were
    const uses = engineSrc.split('sessionRemainingUsd(snap.capUsd, snap.totalUsd, snap.heldUsd ?? 0)').length - 1;
    expect(uses).toBe(2);
  });

  it('the edges the twin spelled out are the TUI function`s answers', () => {
    // an uncapped session is unbounded, holds or not
    expect(sessionRemainingUsd(Number.POSITIVE_INFINITY, 1, 2)).toBe(Number.POSITIVE_INFINITY);
    // a non-finite cap is 0; a non-finite or negative spend / hold contributes nothing
    expect(sessionRemainingUsd(Number.NaN, 1, 1)).toBe(-2);
    expect(sessionRemainingUsd(10, Number.NaN, -5)).toBe(10);
    // a hold is money already gone
    expect(sessionRemainingUsd(10, 2, 3)).toBe(5);
    // and the clamp is the CALLER's, so an overspent session reads negative here
    expect(sessionRemainingUsd(10, 12, 0)).toBe(-2);
  });
});
