/**
 * TUI-DESIGN-5 §4.5 (`CD §F` to-do 5) / §12.3 S76a (R5-4's §10 `test/unit/undo/**`): the land boundary.
 *
 * Once an agent has landed, `/undo` offers to undo the **merge** rather than the last local step, and `/rewind`
 * **refuses** across a land boundary with a named reason. The refusal is a refusal, not a clamp: the merge brought
 * in commits this run never made, so "undo steps last…n" would silently drop another agent's work.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isRefusedRewind, landBoundaryOf, landedUndoOffer, planRewind, rewindRefusal, type LandBoundary, type RewindStep } from '../../../src/undo/plan.js';

const steps: RewindStep[] = [
  { step: 5, changedFiles: ['a.ts'] },
  { step: 6, changedFiles: [] },
  { step: 7, changedFiles: ['b.ts'] },
  { step: 8, changedFiles: ['c.ts'] },
];
const LANDED: LandBoundary = { step: 7, agents: 3 };

describe('§12.3 S76a: the offer and the refusal are one sentence, built from one fact', () => {
  it('the string is verbatim', () => {
    expect(landedUndoOffer(LANDED)).toBe('step 7 landed 3 agents — /undo reverts the merge, /rewind cannot cross a land');
  });

  it('one agent is singular', () => {
    expect(landedUndoOffer({ step: 4, agents: 1 })).toBe('step 4 landed 1 agent — /undo reverts the merge, /rewind cannot cross a land');
  });

  it('the refusal IS the offer, so the two can never disagree about where the boundary is', () => {
    expect(rewindRefusal(7, LANDED)).toBe(landedUndoOffer(LANDED));
  });
});

describe('§4.5: a rewind across a land is refused, one above it is ordinary', () => {
  it('a target AT the boundary is refused', () => {
    expect(rewindRefusal(7, LANDED)).not.toBeNull();
  });

  it('a target BELOW the boundary is refused (it would cross the land)', () => {
    expect(rewindRefusal(5, LANDED)).not.toBeNull();
    expect(rewindRefusal(1, LANDED)).not.toBeNull();
  });

  it('a target ABOVE the boundary is ordinary', () => {
    expect(rewindRefusal(8, LANDED)).toBeNull();
    expect(rewindRefusal(99, LANDED)).toBeNull();
  });

  it('a run that never delegated is untouched — the whole rule is inert without a boundary', () => {
    expect(rewindRefusal(1, null)).toBeNull();
    expect(planRewind(steps, 5)).toEqual({ target: 5, order: [8, 7, 5], planAfterFrom: null, windowUpTo: 5 });
    expect(planRewind(steps, 5, null)).toEqual(planRewind(steps, 5));
  });
});

describe('planRewind carries the refusal and is inert in EVERY field (never half a rewind)', () => {
  it('a refused rewind has an EMPTY order, so a caller that ignores `refusal` cannot apply anything', () => {
    const p = planRewind(steps, 5, LANDED);
    expect(p.order).toEqual([]);
    expect(p.refusal).toBe(landedUndoOffer(LANDED));
    expect(p.planAfterFrom).toBeNull();
  });

  it('every OTHER field is inert too — an ignored `refusal` cannot seed a plan or trim the window', () => {
    /**
     * `order: []` alone was not the safety property the docblock claimed: the plan still carried
     * `windowUpTo: 5`, which trims every window entry above step 5, and `target: 5`, which
     * `src/cli/session.ts:2889` writes straight into `rewindSeed`. A caller that never reads `refusal`
     * therefore still applied most of the rewind it was refused.
     */
    const p = planRewind(steps, 5, LANDED);
    expect(p.windowUpTo).toBe(Number.POSITIVE_INFINITY); // every window entry survives
    expect(p.target).toBe(8); // the newest step: "rewinding" to it is the identity
    expect(p.planAfterFrom).toBeNull();
    expect(p.order).toEqual([]);
    // and the whole plan is exactly that shape — nothing else can carry a partial rewind
    expect(p).toEqual({ target: 8, order: [], planAfterFrom: null, windowUpTo: Number.POSITIVE_INFINITY, refusal: landedUndoOffer(LANDED) });
  });

  it('`isRefusedRewind` is the narrowing a call site uses before it touches anything', () => {
    const refused = planRewind(steps, 5, LANDED);
    const ok = planRewind(steps, 8, LANDED);
    expect(isRefusedRewind(refused)).toBe(true);
    expect(isRefusedRewind(ok)).toBe(false);
    if (isRefusedRewind(refused)) expect(refused.refusal).toBe(landedUndoOffer(LANDED));
    // S76a is what a `/rewind` prints instead of doing anything
    expect(refused.refusal).toBe('step 7 landed 3 agents — /undo reverts the merge, /rewind cannot cross a land');
  });

  it('a refused plan with NO steps still names a target (the clamp, not a crash)', () => {
    const p = planRewind([], 3, { step: 9, agents: 1 });
    expect(p.target).toBe(3);
    expect(p.order).toEqual([]);
    expect(p.windowUpTo).toBe(Number.POSITIVE_INFINITY);
  });

  it('NO production call site passes a boundary yet — S76a has no emitter, and that is a REQUEST, not a defect here', () => {
    // `landBoundaryOf` / `rewindRefusal` are unused in `src/` until R5-1 threads the boundary through
    // `src/cli/session.ts:2889` (R5-4's §9.2 request). The guard: if that ever regresses to a call site that
    // passes a boundary and ignores `refusal`, this case is where the reader is told to look.
    const root = fileURLToPath(new URL('../../../src', import.meta.url));
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if ((e.name.endsWith('.ts') || e.name.endsWith('.tsx')) && full !== join(root, 'undo', 'plan.ts')) {
          // comments first: `undo/apply.ts` DOCUMENTS `planRewind().order` in a docblock, and a call site a
          // comment satisfies is the same vacuity §14.2 #7 is about
          const text = readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
          if (/planRewind\(/.test(text)) hits.push(`${full.slice(root.length + 1)}${/plan\.refusal|isRefusedRewind/.test(text) ? ' (reads refusal)' : ' (IGNORES refusal)'}`);
        }
      }
    };
    walk(root);
    expect(hits).toEqual(['cli/session.ts (IGNORES refusal)']);
  });

  it('an allowed rewind above the boundary keeps round 3’s shape exactly, with no `refusal` key', () => {
    const p = planRewind(steps, 8, LANDED);
    expect(p).toEqual({ target: 8, order: [8], planAfterFrom: null, windowUpTo: 8 });
    expect('refusal' in p).toBe(false);
  });

  it('a non-integer or out-of-range target is clamped to 1 first, and then refused if 1 crosses the land', () => {
    expect(planRewind(steps, Number.NaN, LANDED).refusal).not.toBeUndefined();
    expect(planRewind(steps, 0, LANDED).refusal).not.toBeUndefined();
    expect(planRewind(steps, Number.NaN, null).order).toEqual([8, 7, 5]);
  });
});

describe('landBoundaryOf picks the HIGHEST land — the only one a rewind reaches first', () => {
  it('two lands: the later one bounds the rewind', () => {
    expect(landBoundaryOf([{ step: 4, agents: 2 }, { step: 9, agents: 1 }])).toEqual({ step: 9, agents: 1 });
  });
  it('no land is null, so nothing changes for a single-threaded session', () => {
    expect(landBoundaryOf([])).toBeNull();
  });
  it('one land is itself', () => {
    expect(landBoundaryOf([LANDED])).toBe(LANDED);
  });
});
