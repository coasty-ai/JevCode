/**
 * TUI-DESIGN-2 §2.4 / §2.5 / §6 items 3, 6, 8 in the engine (S1): the cross-provider --resume (the checkpoint's resolved id
 * re-keyed to the new provider's naming, the `[run] decider provider changed …` notice instead of a budget:override, no drift),
 * provider-aware alias resolution under TypeSafe naming, the recorded Jev cost basis and its run-level aggregate, step:end.costUsd,
 * and the emit re-entrancy queue (one order across transcript.log, typed listeners and onAny; a throwing nested dispatch strands nothing).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineEvent, GenerateRequest, Synthesizer } from '../../../src/core/types.js';
import { providerChangedText } from '../../../src/loop/engine.js';
import { createNullProvider } from '../../../src/provider/null.js';
import { formatTranscriptItem, itemsFromEvent } from '../../../src/tui/plain.js';
import type { Harness } from './fakes.js';
import { answer, createFakeDecider, makeEngine, noulA, turn } from './fakes.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}
const read = () => turn({ kind: 'read', paths: ['src/a.py'] });
const OR_ID = 'typesafe/jev-1.13-20260917';
const TS_ID = 'jev-1.13.0';
const TO_TYPESAFE = { setting: 'decider.provider', from: 'openrouter', to: 'typesafe', atStep: 1 };
const CHANGED = 'decider provider changed openrouter → typesafe (same weights: jev-1.13-20260917 ≡ jev-1.13.0)';

describe('cross-provider --resume (TUI-DESIGN-2 §2.5, §12)', () => {
  it('openrouter → typesafe: the checkpoint’s resolved id is re-keyed, the first call is not drift, the §12 notice replaces the budget:override, run.json keeps the override', async () => {
    const h = await build({ decider: createFakeDecider({ model: OR_ID }), turns: [read()], limits: { maxSteps: 1 } });
    const r1 = await h.engine.run();
    expect(r1.resolvedJevModel).toBe(OR_ID);
    expect(h.store.meta!.resolvedJevModel).toBe(OR_ID);

    const h2 = await build({
      store: h.store,
      runsDir: h.runsDir,
      resume: { runId: h.engine.runId, force: false },
      decider: createFakeDecider({ model: TS_ID, provider: 'typesafe' }),
      deciderModel: { configured: TS_ID, pinned: true, provider: 'typesafe' },
      turns: [read()],
      limits: { maxSteps: 2 },
      engine: { resumeOverrides: [TO_TYPESAFE] },
    });
    const r2 = await h2.engine.run();
    expect(r2.stopReason).toBe('max_steps');
    expect(r2.steps).toBe(2);
    // no drift anywhere: result, run.json, decision rows, transcript
    expect(r2.jevModelDrift).toBeNull();
    expect(h.store.meta!.jevModelDrift).toBeNull();
    expect(h.store.steps.at(-1)!.decisions.every((d) => d.servedModel === undefined)).toBe(true);
    expect(h2.of('transcript').some((t) => /Jev served model/.test(t.text))).toBe(false);
    // the resolved id follows the served naming (verbatim) and is persisted
    expect(r2.resolvedJevModel).toBe(TS_ID);
    expect(h.store.meta!.resolvedJevModel).toBe(TS_ID);
    // §12: `[run] decider provider changed openrouter → typesafe (same weights: jev-1.13-20260917 ≡ jev-1.13.0)` as a config notice, once
    expect(h2.of('notice').filter((n) => n.kind === 'config').map((n) => ({ text: n.text, level: n.level, step: n.step }))).toEqual([{ text: CHANGED, level: 'info', step: null }]);
    expect(h2.of('budget:override')).toEqual([]);
    expect(h.store.transcript).toContain(`[run] ${CHANGED}`);
    const types = h2.events.map((e) => e.type);
    const iNotice = h2.events.findIndex((e) => e.type === 'notice' && e.kind === 'config');
    expect(iNotice).toBeGreaterThan(types.indexOf('workspace'));
    expect(iNotice).toBeLessThan(types.indexOf('step:start'));
    // run.json.overrides[] keeps the entry for --resume history
    expect(h.store.meta!.overrides).toEqual([TO_TYPESAFE]);
    expect(h.store.meta!.resumes).toHaveLength(1);
  });

  it('typesafe → openrouter (the reverse), a resume WITHOUT the override (an older controller), and a resume whose served id is other weights (drift stays drift)', async () => {
    const first = await build({ decider: createFakeDecider({ model: TS_ID, provider: 'typesafe' }), deciderModel: { configured: TS_ID, pinned: true, provider: 'typesafe' }, turns: [read()], limits: { maxSteps: 1 } });
    await first.engine.run();
    expect(first.store.meta!.resolvedJevModel).toBe(TS_ID);
    // the override's `to` steers the re-key even when the caller built deciderModel without `provider` (session.ts today)
    const back = await build({
      store: first.store,
      runsDir: first.runsDir,
      resume: { runId: first.engine.runId, force: false },
      decider: createFakeDecider({ model: OR_ID }),
      deciderModel: { configured: OR_ID, pinned: true },
      turns: [read()],
      limits: { maxSteps: 2 },
      engine: { resumeOverrides: [{ setting: 'decider.provider', from: 'typesafe', to: 'openrouter', atStep: 1 }] },
    });
    const rb = await back.engine.run();
    expect(rb.jevModelDrift).toBeNull();
    expect(rb.resolvedJevModel).toBe(OR_ID);
    expect(first.store.meta!.resolvedJevModel).toBe(OR_ID);
    expect(back.of('notice').filter((n) => n.kind === 'config').map((n) => n.text)).toEqual(['decider provider changed typesafe → openrouter (same weights: jev-1.13-20260917 ≡ jev-1.13.0)']);
    expect(back.of('budget:override')).toEqual([]);

    // no override passed: the same weights under the other naming are recognised on the first call (sameJevWeights) and re-keyed
    const h = await build({ decider: createFakeDecider({ model: OR_ID }), turns: [read()], limits: { maxSteps: 1 } });
    await h.engine.run();
    const noOverride = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, decider: createFakeDecider({ model: TS_ID, provider: 'typesafe' }), deciderModel: { configured: TS_ID, pinned: true, provider: 'typesafe' }, turns: [read()], limits: { maxSteps: 2 } });
    const rn = await noOverride.engine.run();
    expect(rn.jevModelDrift).toBeNull();
    expect(rn.resolvedJevModel).toBe(TS_ID);
    expect(h.store.meta!.resolvedJevModel).toBe(TS_ID);
    expect(noOverride.of('transcript').some((t) => /Jev served model/.test(t.text))).toBe(false);

    // other weights under the new provider: recorded as drift at the step, the warn line once, the run continues
    const h3 = await build({ decider: createFakeDecider({ model: OR_ID }), turns: [read()], limits: { maxSteps: 1 } });
    await h3.engine.run();
    const drifting = await build({ store: h3.store, runsDir: h3.runsDir, resume: { runId: h3.engine.runId, force: false }, decider: createFakeDecider({ model: 'jev-1.14.0', provider: 'typesafe' }), deciderModel: { configured: TS_ID, pinned: true, provider: 'typesafe' }, turns: [read()], limits: { maxSteps: 2 }, engine: { resumeOverrides: [TO_TYPESAFE] } });
    const rd = await drifting.engine.run();
    expect(rd.stopReason).toBe('max_steps');
    expect(rd.jevModelDrift).toEqual({ step: 2, served: 'jev-1.14.0' });
    expect(h3.store.meta!.jevModelDrift).toEqual({ step: 2, served: 'jev-1.14.0' });
    expect(drifting.of('transcript').filter((t) => /Jev served model/.test(t.text)).map((t) => t.text)).toEqual(['Jev served model "jev-1.14.0" but --jev-model is "jev-1.13.0"']);
  });

  it('providerChangedText: the EQUIVALENT_IDS row of the id in either naming; the table’s first row for an alias', () => {
    expect(providerChangedText('openrouter', 'typesafe', OR_ID)).toBe(CHANGED);
    expect(providerChangedText('openrouter', 'typesafe', TS_ID)).toBe(CHANGED);
    expect(providerChangedText('typesafe', 'openrouter', 'jev-latest')).toBe('decider provider changed typesafe → openrouter (same weights: jev-1.13-20260917 ≡ jev-1.13.0)');
  });
});

describe('provider-aware alias resolution (TUI-DESIGN-2 §2.5, §6 item 8)', () => {
  it('typesafe: jev-latest resolves to jev-1.13.0 with the alias warning naming jev-1.13.0; jev-1.13 never matches jev-1.13.0 (first-call drift, exit 2)', async () => {
    const h = await build({ decider: createFakeDecider({ model: TS_ID, provider: 'typesafe' }), deciderModel: { configured: 'jev-latest', pinned: false, provider: 'typesafe' }, turns: [read()], limits: { maxSteps: 1 } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('max_steps');
    expect(r.resolvedJevModel).toBe(TS_ID);
    expect(h.store.meta!.resolvedJevModel).toBe(TS_ID);
    expect(h.of('transcript').map((t) => t.text)).toContain('jev model alias jev-latest resolved to jev-1.13.0; pin it with --jev-model jev-1.13.0 for reproducible thresholds');
    expect(h.store.transcript).toContain('[step 1] warn: jev model alias jev-latest resolved to jev-1.13.0; pin it with --jev-model jev-1.13.0 for reproducible thresholds');
    const bad = await build({ decider: createFakeDecider({ model: TS_ID, provider: 'typesafe' }), deciderModel: { configured: 'jev-1.13', pinned: false, provider: 'typesafe' }, turns: [read()], limits: { maxSteps: 1 } });
    const rb = await bad.engine.run();
    expect(rb.stopReason).toBe('error');
    expect(rb.error?.code).toBe('jev_model_drift');
    expect(rb.error?.exitCode).toBe(2);
    expect(rb.steps).toBe(0);
    // the default provider (openrouter) keeps today's verdicts: jev-1.13 → jev-1.13-20260917 is an alias resolution
    const or = await build({ decider: createFakeDecider({ model: OR_ID }), deciderModel: { configured: 'typesafe/jev-1.13', pinned: false }, turns: [read()], limits: { maxSteps: 1 } });
    expect((await or.engine.run()).resolvedJevModel).toBe(OR_ID);
  });
});

describe('Jev cost basis and step:end.costUsd (TUI-DESIGN-2 §2.4, §6 items 3 and 6)', () => {
  it('every JevRequestRecord carries the client’s basis; status() and the RunResult aggregate it as table | provider | mixed | null', async () => {
    const table = await build({ deciderOptions: { costBasis: 'table' }, turns: [read()], limits: { maxSteps: 1 } });
    expect(table.engine.status().jevCostBasis).toBeNull();
    const r = await table.engine.run();
    expect(table.store.jevRequests.length).toBeGreaterThan(1);
    expect(table.store.jevRequests.every((j) => j.costBasis === 'table')).toBe(true);
    expect(table.of('jev:request').every((e) => e.record.costBasis === 'table')).toBe(true);
    expect(table.engine.status().jevCostBasis).toBe('table');
    expect(r.jevCostBasis).toBe('table');
    expect(table.of('run:end')[0]!.result.jevCostBasis).toBe('table');

    const provider = await build({ deciderOptions: { costBasis: 'provider' }, turns: [read()], limits: { maxSteps: 1 } });
    expect((await provider.engine.run()).jevCostBasis).toBe('provider');

    // a decider that does not say (an older client, the fakes): no key on the record, null aggregate
    const none = await build({ turns: [read()], limits: { maxSteps: 1 } });
    const rn = await none.engine.run();
    expect(none.store.jevRequests.every((j) => !('costBasis' in j))).toBe(true);
    expect(rn.jevCostBasis).toBeNull();
    expect(none.engine.status().jevCostBasis).toBeNull();

    // one table-priced request among provider-priced ones → mixed
    const d = createFakeDecider({ costBasis: 'provider' });
    let n = 0;
    const inner = d.ask.bind(d);
    d.ask = async (state, questions, o) => {
      const res = await inner(state, questions, o);
      n += 1;
      return n === 1 ? { ...res, costBasis: 'table' } : res;
    };
    const mixed = await build({ decider: d, turns: [read()], limits: { maxSteps: 1 } });
    expect((await mixed.engine.run()).jevCostBasis).toBe('mixed');
    expect(mixed.store.jevRequests[0]!.costBasis).toBe('table');
    expect(mixed.store.jevRequests[1]!.costBasis).toBe('provider');
  });

  it('step:end.costUsd is { generator, jev } of the committed record — a jev-on step and a jev-only step (generator 0)', async () => {
    const h = await build({ turns: [read()], limits: { maxSteps: 1 } });
    await h.engine.run();
    const [end] = h.of('step:end');
    expect(end).toBeDefined();
    expect(end!.costUsd).toEqual({ generator: end!.record.usage.generator.costUsd, jev: end!.record.usage.jev.costUsd });
    expect(end!.costUsd!.jev).toBeGreaterThan(0);
    expect(end!.costUsd!.generator).toBeGreaterThan(0);
    // the `[step N]` summary line reaches transcript.log through the shared item model (line identity)
    expect(h.store.transcript).toContain(formatTranscriptItem(itemsFromEvent(end!, 0)[0]!));

    const synth: Synthesizer = {
      name: 'scripted',
      async synthesize() {
        return { goal: 'finish', action: { kind: 'done', summary: 'nothing to do' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' };
      },
    };
    const provider = Object.assign(createNullProvider(), { requests: [] as GenerateRequest[] });
    const jo = await build({ mode: 'jev-only', synthesizer: synth, provider, deciderOptions: { rules: [answer('judge', 'task_complete', noulA(0.95))] }, limits: { maxSteps: 1 } });
    const r = await jo.engine.run();
    expect(r.usage.generator.costUsd).toBe(0);
    const [e2] = jo.of('step:end');
    expect(e2!.costUsd).toEqual({ generator: 0, jev: e2!.record.usage.jev.costUsd });
    expect(e2!.costUsd!.jev).toBeGreaterThan(0);
  });
});

describe('emit re-entrancy (TUI-DESIGN §10 / §15.1 line identity; TUI-DESIGN-2 §4.5 step:end yields a line)', () => {
  it('a listener re-entering the engine on step:end: transcript.log, a second typed listener and onAny all see step:end before the nested steer and note', async () => {
    const h = await build({ turns: [read(), read()], limits: { maxSteps: 2 } });
    const typed: string[] = [];
    h.engine.events.on('step:end', (e) => {
      typed.push(`step:end:${e.record.step}`);
      if (e.record.step === 1) {
        expect(h.engine.steer('look at the tests').ok).toBe(true);
        expect(h.engine.annotate('nested note', { label: '[ui]' })).toBe(true);
      }
    });
    h.engine.events.on('steer:queued', () => typed.push('steer:queued'));
    h.engine.events.on('notice', (e) => {
      if (e.kind === 'ui') typed.push('notice:ui');
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('max_steps');
    // typed listeners: the event in flight completes before the nested ones start
    expect(typed.slice(0, 3)).toEqual(['step:end:1', 'steer:queued', 'notice:ui']);
    // onAny (the harness recorder) sees the same order: step:end, then everything steer() raised (steer:queued + a status), then the note,
    // all before the next step starts
    const i = h.events.findIndex((e) => e.type === 'step:end');
    const iSteerEv = h.events.findIndex((e) => e.type === 'steer:queued');
    const iNoteEv = h.events.findIndex((e) => e.type === 'notice' && e.kind === 'ui' && e.text === 'nested note');
    const iNextStep = h.events.findIndex((e, k) => k > i && e.type === 'step:start');
    expect(iSteerEv).toBe(i + 1);
    expect(iNoteEv).toBeGreaterThan(iSteerEv);
    expect(iNoteEv).toBeLessThan(iNextStep);
    expect(h.events.slice(i + 1, iNoteEv).every((e) => e.type === 'steer:queued' || e.type === 'status')).toBe(true);
    // transcript.log: the `[step 1]` summary line, then the steer line, then the note — in that order
    const lines = h.store.transcript;
    const summary = formatTranscriptItem(itemsFromEvent(h.events[i]!, 0)[0]!);
    const iSummary = lines.indexOf(summary);
    const iSteer = lines.findIndex((l) => /steer queued .*look at the tests/.test(l));
    const iNote = lines.indexOf('[ui] nested note');
    expect(iSummary).toBeGreaterThanOrEqual(0);
    expect(iSteer).toBe(iSummary + 1);
    expect(iNote).toBe(iSteer + 1);
  });

  it('a nested dispatch that throws is contained: a warn line names it, the events queued after it still follow step:end in order, the run is unaffected', async () => {
    const redact = (s: string): string => {
      if (s.includes('boom')) throw new Error('redactor exploded');
      return s;
    };
    const h = await build({ turns: [read()], limits: { maxSteps: 1 }, engine: { redact } });
    h.engine.events.on('step:end', () => {
      h.engine.annotate('boom', { label: '[ui]' });
      h.engine.annotate('second nested', { label: '[ui]' });
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('max_steps');
    const i = h.events.findIndex((e) => e.type === 'step:end');
    const after: EngineEvent[] = h.events.slice(i + 1, i + 3);
    expect(after[0]).toMatchObject({ type: 'transcript', level: 'warn', step: null, text: 'nested emit failed on notice: redactor exploded' });
    expect(after[1]).toMatchObject({ type: 'notice', kind: 'ui', text: 'second nested' });
    expect(h.events.some((e) => e.type === 'notice' && e.text === 'boom')).toBe(false);
    expect(h.store.transcript.some((l) => l.includes('boom'))).toBe(false);
    expect(h.store.transcript).toContain('[ui] second nested');
    expect(h.store.transcript).toContain('[run] warn: nested emit failed on notice: redactor exploded');
  });
});
