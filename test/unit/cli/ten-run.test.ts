/**
 * TUI-DESIGN §19.7: the ten-run session, controller-driven (O10, wave 3) — the rows that involve the controller:
 * follow-up seeding (2, 6, 8), steer while live (2), pause (3), `/resume` (3b, 4b), `/budget` (4b, 10b), Ctrl-C during
 * a step (5), the 401 run and `/login` (7, 7b), the session-cap refusal (10b), `/export` (10b) and `/exit` with the
 * live run aborted first (10b). The engines are scripted (`helpers.ts`); the seed/index/meter arithmetic of the pure
 * rows lives in `test/unit/session/ten-run-seed.test.ts` (O6).
 */
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { CredentialsPatch } from '../../../src/config/credentials.js';
import type { EngineOptions } from '../../../src/core/types.js';
import { LOGIN_SAVED_TOAST, SESSION_CAP_CHAT_REFUSAL, exportFilePath, pausedItemText } from '../../../src/cli/session.js';
import { sessionCapChangedLine } from '../../../src/tui/budget/lines.js';
import { makeController, waitFor, type Harness, type RunScript } from './helpers.js';

const NEW_KEY = 'sk-ant-api03-NEWKEYNEWKEYNEWKEYNEWKEYNEWKEY42';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

describe('the ten-run session (§19.7, controller rows)', () => {
  it('runs rows 1–10b end to end', async () => {
    const scripts: RunScript[] = [];
    let saved: CredentialsPatch | null = null;
    const h = await makeController({
      // the ten-run session is the legacy run flow (pause → resume, Ctrl-C during a step): its scripted engines report no tool
      // calls, which under the agent default makes each a reply whose pause is a stopped reply (AGENT-LOOP-DESIGN §A5)
      flags: { sessionSpendCap: '10', spendCap: '2', mode: 'llm-jev' },
      script: (_opts, n) => scripts[n - 1] ?? {},
      prompts: {
        wizard: async () => ({ kind: 'saved', patch: { provider: 'anthropic', apiKey: NEW_KEY, jevApiKey: NEW_KEY } }),
        exitConfirm: async () => true,
      },
      deps: {
        writeCredentials: async (patch) => {
          saved = patch;
          return { path: '/tmp/config.json', displayPath: '~/.config/jevcode/config.json', dir: '/tmp', items: ['saved ~/.config/jevcode/config.json (mode 0600, dir 0700)'], warnings: [], fingerprints: { generator: 'e31150e9', jev: 'e31150e9' }, windows: false, dirSecured: true };
        },
      },
    });
    harnesses.push(h);
    const p = h.controller.run();
    await h.ready();
    const calls = (): EngineOptions[] => h.factory.calls;
    const runIdOf = (n: number): string => h.factory.engines[n - 1]!.runId;
    const lastNote = (): string => h.renderer.notes.at(-1)?.text ?? '';

    // 1 — R1 complete: sessionId = R1, parentRunId null, index run:start + run:end, meters $0.115, item exit 0
    scripts.push({ stop: 'complete', steps: 9, cost: { generator: 0.104, jev: 0.011 } });
    await h.submit('fix parse_date tz handling');
    const R1 = runIdOf(1);
    expect(h.controller.view.sessionId).toBe(R1);
    expect(calls()[0]!.session).toMatchObject({ sessionId: null, parentRunId: null });
    expect(h.index().filter((l) => l.kind === 'run:start' || l.kind === 'run:end').map((l) => l.kind)).toEqual(['run:start', 'run:end']);
    expect(h.controller.view.sessionMeter.snapshot().totalUsd).toBeCloseTo(0.115, 6);
    expect(h.controller.view.runs[0]?.exitCode).toBe(0);
    expect(lastNote()).toBe('stopped — complete (exit 0)');

    // 2 — R2 seeded from R1; a steer while live is queued and indexed
    scripts.push({ hold: true, stop: 'complete', steps: 6, cost: { generator: 0.2, jev: 0.02 } });
    const p2 = h.submit('now update the docs');
    const e2 = await h.factory.nextLive();
    expect(calls()[1]!.seed?.parentRunId).toBe(R1);
    expect(calls()[1]!.seed?.window[0]?.notes).toContain(`from run ${R1}`);
    expect(h.host.steer('keep CHANGELOG format', { secretSpans: [] })).toEqual({ ok: true, index: 1, queued: 1 });
    expect(e2.directives.map((d) => d.text)).toEqual(['keep CHANGELOG format']);
    e2.release();
    await p2;
    expect(h.index().some((l) => l.kind === 'steer' && l.text60 === 'keep CHANGELOG format')).toBe(true);

    // 3 — Esc at step 5: human_pause, item exit 4, index pause
    scripts.push({ hold: true, steps: 5, cost: { generator: 0.1, jev: 0.01 } });
    const p3 = h.submit('add tests for edge cases');
    await h.factory.nextLive();
    h.host.pause();
    await p3;
    const R3 = runIdOf(3);
    expect(h.controller.view.runs[2]).toMatchObject({ stopReason: 'human_pause', exitCode: 4 });
    expect(h.index().some((l) => l.kind === 'pause' && l.runId === R3)).toBe(true);
    expect(lastNote()).toBe(pausedItemText(5));

    // 3b — /resume continues R3: the engine is created with resume: { runId: R3 } and resumes: the fold excluded R3's earlier run:end
    scripts.push({ stop: 'complete', steps: 8, cost: { generator: 0.05, jev: 0.005 } });
    await h.command(`/resume ${R3}`);
    expect(calls()[3]!.resume).toEqual({ runId: R3, force: false });
    expect(calls()[3]!.resumeOverrides).toBeUndefined();
    expect(h.controller.view.runs[3]).toMatchObject({ runId: R3, stopReason: 'complete' });
    // the session meter counted R3's own spend once: $0.115 + $0.22 + $0.11 + $0.055
    expect(h.controller.view.sessionMeter.snapshot().totalUsd).toBeCloseTo(0.5, 6);

    // 4 — R4 stops spend_cap at step 23; the epilogue names /budget spend-cap 3.00 then /resume
    scripts.push({ stop: 'spend_cap', steps: 23, exitCode: 4, cost: { generator: 1.9, jev: 0.11 } });
    await h.submit('refactor date helpers');
    const spendNotes = h.renderer.notes.slice(-4).map((n) => n.text + (n.detail ? `\n${n.detail}` : ''));
    expect(spendNotes.join('\n')).toContain('stopped by the run spend cap: $2.010 of $2.000');
    expect(spendNotes.join('\n')).toContain('continue this run: /budget spend-cap 3.00 then /resume');

    // 4b — /budget spend-cap 3 then /resume: run.json.overrides gains limits.spendCapUsd 2 → 3 (source /budget) and the run completes
    await h.command('/budget spend-cap 3');
    expect(h.controller.view.pending.spendCapUsd).toBe(3);
    expect(lastNote()).toBe('budget: spend-cap 3.00 pending (next /resume or run)');
    const R4 = runIdOf(5);
    scripts.push({ stop: 'complete', steps: 25, cost: { generator: 0.2, jev: 0.02 } });
    await h.command(`/resume ${R4}`);
    expect(calls()[5]!.resume).toEqual({ runId: R4, force: false });
    expect(calls()[5]!.limits.spendCapUsd).toBe(3);
    expect(calls()[5]!.resumeOverrides).toEqual([{ setting: 'limits.spendCapUsd', from: '2', to: '3', atStep: 23, source: '/budget' }]);
    expect(h.controller.view.pending.spendCapUsd).toBeUndefined();

    // 5 — Ctrl-C during propose: human_abort, composer reopens (no exit), item exit 130
    scripts.push({ hold: true, steps: 5, cost: { generator: 0.3, jev: 0.03 } });
    const p5 = h.submit('migrate loader to TOML');
    const e5 = await h.factory.nextLive();
    h.host.abort('human_abort');
    await p5;
    expect(e5.aborts).toEqual([{ reason: 'human_abort' }]);
    expect(h.controller.view.runs[6]).toMatchObject({ stopReason: 'human_abort', exitCode: 130 });
    expect(h.renderer.unmounted).toBe(0);
    expect(h.controller.view.phase).toBe('none');
    // the pending spend-cap was consumed by the 4b resume: R5 runs under the configured $2 cap again
    expect(calls()[6]!.limits.spendCapUsd).toBe(2);
    const R5 = runIdOf(7);

    // 6 — R6 seeded from R5's committed plan (the seed source is the most recent run with step > 0)
    scripts.push({ stop: 'complete', steps: 13, cost: { generator: 0.4, jev: 0.04 }, events: [{ type: 'outcome', step: 13, outcome: { status: 'executed', summary: 'ok', changedFiles: ['src/a.py', 'src/b.py', 'tests/test_a.py', 'build/out.txt'] } }] });
    await h.submit('finish the TOML migration but skip legacy/');
    expect(calls()[7]!.seed?.parentRunId).toBe(R5);
    expect(calls()[7]!.seed?.plan.harnessProblems[0]?.text).toContain(`Follow-up to run ${R5} (stopped: human_abort)`);
    const R6 = runIdOf(8);

    // 7 — a revoked key: run:end error, exit 2 item; the composer reopens
    scripts.push({ stop: 'error', steps: 0, exitCode: 2, cost: { generator: 0, jev: 0 } });
    await h.submit('rerun the suite');
    expect(h.controller.view.runs[8]).toMatchObject({ stopReason: 'error', exitCode: 2 });
    expect(lastNote()).toBe('stopped — jev_http: Jev HTTP 401: User not found. (exit 2)');
    expect(h.controller.view.phase).toBe('none');

    // 7b — /login: addSecret at once, saved items, the §24 toast, resolveConfig re-run
    await h.command('/login');
    expect(saved).toEqual({ provider: 'anthropic', apiKey: NEW_KEY, jevApiKey: NEW_KEY });
    expect(h.controller.redact(`x ${NEW_KEY} y`)).not.toContain(NEW_KEY);
    const setupNotes = h.renderer.notes.filter((n) => n.label === '[setup]').map((n) => n.text);
    expect(setupNotes.some((t) => t.startsWith('generator key: entered (sha256:'))).toBe(true);
    expect(setupNotes).toContain('saved ~/.config/jevcode/config.json (mode 0600, dir 0700)');
    expect(setupNotes.at(-1)).toBe(LOGIN_SAVED_TOAST);
    expect(h.renderer.uis.length).toBeGreaterThanOrEqual(2);

    // 8 — R8 is seeded from R6: the seed source skips the step-0 run R7 (§8.3)
    scripts.push({ stop: 'complete', steps: 4, cost: { generator: 0.3, jev: 0.03 } });
    await h.submit('rerun the suite');
    expect(calls()[9]!.seed?.parentRunId).toBe(R6);
    expect(calls()[9]!.session?.parentRunId).toBe(R6);

    // 9 — remaining ≥ runCap → no confirm (spent so far ≈ 3.66 of 10; run cap 2)
    scripts.push({ stop: 'complete', steps: 3, cost: { generator: 1.8, jev: 0.2 } });
    await h.submit('polish error messages');
    expect(calls()[10]!.session?.clamp).toBeUndefined();

    // 10 — the session cap trips inside the child (engine side, spend_cap by: 'session'); here the run reports spend_cap
    scripts.push({ stop: 'spend_cap', steps: 19, exitCode: 4, cost: { generator: 2.5, jev: 0.3 } });
    await h.submit('final cleanup pass');
    const spent = h.controller.view.sessionMeter.snapshot().totalUsd;
    expect(spent).toBeGreaterThan(8.4);

    // 10b — a follow-up while the remaining session budget is < the run cap … then the refusal once the cap is reached
    scripts.push({ stop: 'complete', steps: 1, cost: { generator: 1.5, jev: 0.2 } });
    await h.submit('one more');
    const call13 = calls()[12]!;
    expect(call13.session?.clamp?.clampedToUsd, `spent ${spent}; runs ${JSON.stringify(h.controller.view.runs.map((r) => [r.runId.slice(-4), r.stopReason, r.costUsd]))}`).toBeCloseTo(10 - spent, 6);
    const spent2 = h.controller.view.sessionMeter.snapshot().totalUsd;
    expect(spent2).toBeGreaterThanOrEqual(10);
    await h.submit('and another');
    expect(calls()).toHaveLength(13);
    // TUI-DESIGN-2 §3.1 row 3: over the cap the submission is refused before intake — the chat refusal, not the follow-up gate's item
    expect(lastNote()).toBe(SESSION_CAP_CHAT_REFUSAL(10));
    await h.command('/budget session-spend-cap 15');
    expect(lastNote()).toBe(sessionCapChangedLine(10, 15));
    expect(h.controller.view.sessionMeter.snapshot().capUsd).toBe(15);
    expect(h.index().some((l) => l.kind === 'budget' && l.setting === 'session.spendCapUsd' && l.from === '10' && l.to === '15')).toBe(true);
    // R12 starts clamped to min(runCap 2, remaining)
    scripts.push({ hold: true, steps: 1, cost: { generator: 0.1, jev: 0.01 } });
    const p14 = h.submit('one more');
    const e14 = await h.factory.nextLive();
    const call14 = calls()[13]!;
    // R12 starts with the child cap min(runCap 2, remaining 15 − spent): remaining ≥ 2 → no clamp, the child cap is the run cap
    expect(call14.session?.clamp).toBeUndefined();
    expect(call14.meter.snapshot().capUsd).toBe(Math.min(2, 15 - spent2));
    e14.release();
    await p14;
    // 12 distinct runs (R3 and R4 were resumed, not new runs)
    await waitFor(() => h.controller.view.index.some((s) => s.sessionId === R1 && s.runs.length >= 12), 3000, 'index refold');
    await h.command('/export');
    const out = exportFilePath(h.home, R1);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, 'utf8').match(/^==== run /gm)?.length).toBe(12);

    // /exit while live: the confirm answers y → the run is aborted first, then exit 0
    scripts.push({ hold: true });
    const p13 = h.submit('last one');
    const e13 = await h.factory.nextLive();
    await h.command('/exit');
    await p13;
    expect(e13.aborts).toEqual([{ reason: 'human_abort' }]);
    expect(await p).toBe(0);
    expect(h.renderer.unmounted).toBe(1);
  }, 30_000);
});
