/**
 * `JEVCODE_JEV=off` through the bench runner (HARNESS-NEXT-DESIGN §1.2 last paragraph, §5 Ring 1).
 *
 * The switch substitutes the Decider slot, and two other places already decide what the decider model of an arm
 * is: `deciderModelOf` (what `summary.json` records) and `buildEngineOptions` (what the engine's drift check is
 * pinned to). Both check `usesStubDecider` **first**, so the substitution has to check it first too. It did not:
 * an `llm-sieve` arm under the switch got a decider serving `none (--jev off)` against a `deciderModel` pinned to
 * `none (llm-sieve: jev stubbed)`, and `checkModelDrift` on a pinned model is `served === configured` — so the
 * first ask threw `JevModelDriftError` and the arm aborted with exit 2. The safety gate would have crashed the
 * degraded path instead of exercising it.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runBenchWithSources } from '../../../src/bench/runner.js';
import { STUB_DECIDER_MODEL } from '../../../src/bench/stub-decider.js';
import { JEV_OFF_MODEL } from '../../../src/jev/off.js';
import { baseOptions, createFakeDeps, syntheticSource, tempDir, type EngineScript } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

let previous: string | undefined;
beforeEach(() => {
  previous = process.env['JEVCODE_JEV'];
  process.env['JEVCODE_JEV'] = 'off';
});
afterEach(() => {
  if (previous === undefined) delete process.env['JEVCODE_JEV'];
  else process.env['JEVCODE_JEV'] = previous;
});

describe('the --jev off switch inside the bench runner', () => {
  it('substitutes the decider of a Jev arm and leaves the stubbed arm stubbed, so no arm drifts from its pinned model', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const script: EngineScript = () => ({ result: { steps: 1 } });
    const { deps, captured } = createFakeDeps({ script });
    const out = await runBenchWithSources(
      [syntheticSource({ id: 't1' })],
      baseOptions(join(t.dir, 'runs'), join(t.dir, 'out'), { conditions: ['llm-jev', 'llm-sieve'] }),
      deps,
    );
    const [jev, sieve] = captured.engines;

    // the Jev arm: the switch's double, and the drift check pinned to the same name
    expect(jev!.opts.decider.model).toBe(JEV_OFF_MODEL);
    expect(jev!.opts.deciderModel).toEqual({ configured: JEV_OFF_MODEL, pinned: true });

    // the stubbed arm: untouched by the switch — the stub is already "no Jev", and the pin says so
    expect(sieve!.opts.decider.model).toBe(STUB_DECIDER_MODEL);
    expect(sieve!.opts.deciderModel).toEqual({ configured: STUB_DECIDER_MODEL, pinned: true });

    // the invariant that makes the drift check pass on every arm: served model === pinned model
    for (const e of captured.engines) expect(e.opts.decider.model).toBe(e.opts.deciderModel?.configured);

    expect(out.summary.conditions['llm-jev']).toMatchObject({ deciderModel: JEV_OFF_MODEL });
    expect(out.summary.conditions['llm-sieve']).toMatchObject({ deciderModel: STUB_DECIDER_MODEL });
  });
});
