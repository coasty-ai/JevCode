/**
 * **I2, byte identity when the routers are off** (docs/LLM-LOOP-DESIGN.md §0.4).
 *
 * The claim contract 1.9 makes is that a `jev-on` run with `routers: 'off'` — the default in every mode on
 * `main` — is byte-identical to the same run before the wave: the same assembled generator prompts, the same
 * Jev requests (stage, step, question ids and the STATE those questions were asked about), the same event
 * order, the same sandbox commands. The router code is entered from one `if` per stage and all of them are
 * false.
 *
 * A same-tree A/B cannot prove that, because both arms are this tree. The golden below was therefore captured
 * by running this very fixture in a DETACHED checkout of `main` at the branch point (`commit` in the file),
 * with the capture switch:
 *
 *   JEVCODE_ROUTER_GOLDEN_OUT=<path> npx vitest run --project unit test/unit/loop/router-golden.test.ts
 *
 * Re-capture only when a change to the run is INTENDED, and say in the commit what moved and why.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../../../src/core/types.js';
import { sha12 } from '../../../src/core/hash.js';
import { createFakeWorkspace, execResult, makeEngine, repoState, turn, type Harness } from './fakes.js';

const GOLDEN = join(import.meta.dirname, '../../fixtures/loop/router-golden-d86c385.json');
const OUT = process.env['JEVCODE_ROUTER_GOLDEN_OUT'];

/** the fixture: a read, a test-command run and a `done` — intent, context, risk, execute, judge, complete on every step */
const TURNS = [turn({ kind: 'read', paths: ['src/a.py'] }), turn({ kind: 'run', command: 'pytest -q' }), turn({ kind: 'done', summary: 'the suite passes' })];

interface Trace {
  commit: string;
  prompts: string[];
  eventTypes: string[];
  /** every Jev request: where it was asked, what it asked, and a digest of the state it asked about */
  jev: string[];
  sandboxCommands: string[];
  invalidations: number;
  decisions: string[];
}

function traceOf(h: Harness): Omit<Trace, 'commit'> {
  return {
    prompts: h.provider.requests.map((r) => r.messages.map((m) => m.content).join('\n---\n')),
    eventTypes: h.events.map((e: EngineEvent) => e.type),
    jev: h.decider.calls.map((c) => `${c.stage}#${c.step} ${Object.keys(c.questions).join(',')} state=${sha12(JSON.stringify(c.state))} q=${sha12(JSON.stringify(c.questions))}`),
    sandboxCommands: [...h.sandbox.commands],
    invalidations: h.workspace.invalidations,
    decisions: h.events.filter((e): e is Extract<EngineEvent, { type: 'decision' }> => e.type === 'decision').map((e) => `${e.decision.stage}#${e.decision.step} ${e.decision.id} p=${e.decision.probability.toFixed(4)} c=${e.decision.confidence.toFixed(4)}${e.decision.verdict === undefined ? '' : ` v=${e.decision.verdict}`}`),
  };
}

async function run(): Promise<Omit<Trace, 'commit'>> {
  const h = await makeEngine({
    turns: [...TURNS],
    mode: 'jev-on',
    probeGitState: repoState(),
    workspace: createFakeWorkspace({ files: { 'src/a.py': 'def f():\n    return 1\n' }, gitState: repoState() }),
  });
  try {
    await h.engine.run();
    return traceOf(h);
  } finally {
    h.cleanup();
  }
}

describe('I2: `routers: off` is byte-identical to the pre-1.9 tree', () => {
  it('the same prompts, the same Jev requests and states, the same events, the same sandbox commands', async () => {
    // the routers must be OFF for this run: the default, and never inherited from an exported env var
    delete process.env['JEVCODE_ROUTERS'];
    const now = await run();
    if (OUT !== undefined) {
      mkdirSync(dirname(OUT), { recursive: true });
      writeFileSync(OUT, `${JSON.stringify({ commit: process.env['JEVCODE_ROUTER_GOLDEN_COMMIT'] ?? 'unknown', ...now }, null, 2)}\n`);
      return;
    }
    expect(existsSync(GOLDEN), `${GOLDEN} is missing — capture it in a detached checkout of the branch point`).toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Trace;
    expect(golden.commit).toBe('d86c385');
    expect(now.prompts).toEqual(golden.prompts);
    expect(now.jev).toEqual(golden.jev);
    expect(now.decisions).toEqual(golden.decisions);
    expect(now.eventTypes).toEqual(golden.eventTypes);
    expect(now.sandboxCommands).toEqual(golden.sandboxCommands);
    expect(now.invalidations).toBe(golden.invalidations);
  });

  it('with the routers ON the same questions are asked of the same states — a router changes what is DONE with a late or failed answer, not what is asked', async () => {
    process.env['JEVCODE_ROUTERS'] = 'on';
    try {
      const on = await run();
      const golden = existsSync(GOLDEN) ? (JSON.parse(readFileSync(GOLDEN, 'utf8')) as Trace) : null;
      if (golden === null) return;
      // Nothing on this fixture drops, no command is deny-listed and the one test run is unparsed, so every
      // routed site takes Jev's answer exactly as before. The behaviour differences the switch DOES make — the
      // code judge on a parsed run, the demoted stop, the code verdict under an outage — are driven against a
      // failing decider in test/unit/loop/router.test.ts, where they can be asserted rather than hoped for.
      expect(on.jev).toEqual(golden.jev);
      expect(on.prompts).toEqual(golden.prompts);
    } finally {
      delete process.env['JEVCODE_ROUTERS'];
    }
  });
});

/** the fake sandbox's `pytest -q` answer, kept next to the fixture so a reader can see what the run saw */
export const FIXTURE_RUN = execResult({ exitCode: 0, stdout: '2 passed in 0.10s\n' });
