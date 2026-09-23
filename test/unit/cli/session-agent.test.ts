/**
 * The session controller in `agent` mode (AGENT-LOOP-DESIGN §A1, §A5, §7.6, §14.2) over the scripted engine factory — never a real
 * agent run (the agent factory in this base is a stub). Jev is optional: with no Jev key both engine sites (a run start and a
 * resume) build the absent decider and nothing opens a wizard for it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ABSENT_DECIDER_MODEL } from '../../../src/jev/absent.js';
import { loadedRun, makeController, scriptedRunId, type Harness } from './helpers.js';

/** the `<JEVCODE_EXTRA_ENV_FILE>` fallback must never find this machine's sibling checkout in a `mock: false` test */
const NO_EXTRA_ENV = '/nonexistent/extra.env';
/** agent mode, a mocked generator, and NO Jev key anywhere (`--mock` would stand in for Jev; `--mock-generator` does not) */
const NO_JEV = { flags: { mode: 'agent', mock: false, mockGenerator: true }, env: { JEVCODE_EXTRA_ENV_FILE: NO_EXTRA_ENV } } as const;

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function build(...args: Parameters<typeof makeController>): Promise<Harness> {
  const h = await makeController(...args);
  harnesses.push(h);
  return h;
}

describe('Jev optional (§14.2): the absent decider at both engine sites', () => {
  it('run start: an agent run with no Jev key gets the absent decider; no wizard, no missing-key error', async () => {
    const asked: string[] = [];
    const h = await build({ ...NO_JEV, mode: 'one-shot', task: 'fix the failing test', prompts: { wizard: async () => (asked.push('wizard'), { kind: 'cancelled' }) } });
    const code = await h.controller.run();
    expect(code).toBe(0);
    expect(asked).toEqual([]);
    expect(h.factory.calls).toHaveLength(1);
    const opts = h.factory.calls[0]!;
    expect(opts.mode).toBe('agent');
    expect(opts.decider.model).toBe(ABSENT_DECIDER_MODEL);
    expect(opts.deciderModel).toEqual({ configured: ABSENT_DECIDER_MODEL, pinned: false });
    expect(h.stderr.join('')).not.toContain('decider.apiKey');
  });

  it('resume: /resume of an agent run with no Jev key builds the absent decider too', async () => {
    const id = scriptedRunId(7001);
    const h = await build({
      ...NO_JEV,
      deps: {
        loadForResume: async (_dir, runId) => {
          const l = loadedRun({ runId, workspace: h.workspace, task: 'fix the failing test', stop: 'human_pause', step: 4 });
          return { meta: { ...l.meta, mode: 'agent' }, state: { ...l.state!, mode: 'agent' }, previousStopReason: 'human_pause', warnings: [] };
        },
      },
    });
    void h.controller.run();
    await h.ready();
    await h.command(`/resume ${id}`);
    expect(h.factory.calls, h.renderer.notes.map((n) => n.text).join(' | ')).toHaveLength(1);
    const opts = h.factory.calls[0]!;
    expect(opts.resume).toEqual({ runId: id, force: false });
    expect(opts.mode).toBe('agent');
    expect(opts.decider.model).toBe(ABSENT_DECIDER_MODEL);
    expect(opts.deciderModel.configured).toBe(ABSENT_DECIDER_MODEL);
  });

  it('a legacy mode still requires the Jev key: the same keyless start under llm-jev fails (the pipe names the missing key)', async () => {
    const h = await build({ flags: { mode: 'llm-jev', mock: false, mockGenerator: true }, env: { JEVCODE_EXTRA_ENV_FILE: NO_EXTRA_ENV }, mode: 'one-shot', task: 'fix the failing test', interactive: false });
    const code = await h.controller.run();
    expect(code).not.toBe(0);
    expect(h.factory.calls).toHaveLength(0);
    expect(h.stderr.join('')).toContain('decider.apiKey');
  });
});
