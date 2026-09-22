/**
 * Gate hygiene: the two run-shape settings the sessions had been maintaining by hand live in vitest.config.ts,
 * where typing the short command cannot lose them.
 *
 *   - `maxWorkers` — docs/DECISIONS.md ratifies a three-worker bound for a full unit run on this shared machine.
 *     `npm test` is `vitest run --project unit`, which spawns the runner's default of `cpus - 1`, so the bound
 *     existed only in prose and only for whoever remembered to type the flag.
 *   - `allowOnly` — defaults to `!isCI`, and every gate in this wave is run locally: a committed `it.only` would
 *     narrow its file to one case and the run would still exit 0.
 *
 * Failing-first: both assertions are red against the config at d297b29, which sets neither.
 */
import { describe, expect, it } from 'vitest';
import config from '../../../vitest.config.js';

/** the project entries of the root config, by name */
function projects(): Map<string, Record<string, unknown>> {
  const list = config.test?.projects ?? [];
  const out = new Map<string, Record<string, unknown>>();
  for (const p of list) {
    // every project of this config is an inline object with a `test` block
    const t = (p as { test?: Record<string, unknown> }).test;
    if (t !== undefined && typeof t['name'] === 'string') out.set(t['name'], t);
  }
  return out;
}

describe('vitest.config.ts carries the ratified gate settings', () => {
  it('the unit project bounds a local run to three workers (and leaves CI the runner default)', () => {
    const unit = projects().get('unit');
    expect(unit, 'the unit project must be declared inline so the gate settings are readable here').toBeDefined();
    const ci = process.env['CI'];
    if (ci === undefined || ci === '') expect(unit?.['maxWorkers']).toBe(3);
    else expect(unit?.['maxWorkers']).toBeUndefined();
  });

  it('`it.only` fails the run in every project, in CI and out of it', () => {
    const byName = projects();
    expect([...byName.keys()].sort()).toEqual(['live', 'pty', 'unit']);
    for (const [name, t] of byName) expect(t['allowOnly'], `project ${name}`).toBe(false);
  });

  it('the unit project deletes the mechanism env vars before every file', () => {
    expect(projects().get('unit')?.['setupFiles']).toEqual(['test/unit/setup-env.ts']);
  });
});
