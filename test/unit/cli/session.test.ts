/**
 * TUI-DESIGN §19.0 `src/cli/session.ts` row and §19.4: host wiring (`addSecret` before `submit`/`steer`), `note()`
 * routing (`annotate` while live, a local item while idle), the startup order after `firstFrame()` (setHost → setUi →
 * warnings → sandbox line → recent hint), the follow-up gate (§9.3: start / clamp / refuse), the seed (§8.3), the
 * `/resume` child cap computed before the resumed spend is added (§9.1), `/budget` scopes (§9.4), the blocker answers
 * (§13.3), the exit paths (§13.5: one-shot exit code, `/exit` while live confirms and exits 0, signal → 130/143 without
 * reopening the composer), the argv secret gate (§10.2) and the exit hook.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BlockingRequest, Engine, EngineOptions } from '../../../src/core/types.js';
import { EXIT_CONFIRM_ROW, STARTING_STEER_CAP, applyRawEdits, exportFilePath, helpLines, isInCi, isInteractive, jevcodeDir, mockReviewStep, mostRecentSession, pausedItemText, sessionEndedText } from '../../../src/cli/session.js';
import { sessionCapChangedLine, sessionCapReachedItem } from '../../../src/tui/budget/lines.js';
import { sandboxText } from '../../../src/tui/onboarding/lines.js';
import { detectSandboxLevel } from '../../../src/sandbox/seatbelt.js';
import { gateRefusalLine } from '../../../src/tui/secrets/gate-lines.js';
import { detectSecrets } from '../../../src/core/redact.js';
import { NOT_RESUMABLE } from '../../../src/cli/epilogue.js';
import { finishedRunLines, loadedRun, makeController, scriptedRunId, tick, waitFor, type Harness } from './helpers.js';

const SECRET = 'sk-ant-api03-SECRETSECRETSECRETSECRETSECRET1234';
const AWS = 'AKIAIOSFODNN7EXAMPLE';
const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function build(...args: Parameters<typeof makeController>): Promise<Harness> {
  const h = await makeController(...args);
  harnesses.push(h);
  return h;
}

describe('pure helpers (§1)', () => {
  it('isInCi and isInteractive follow the §1 rule', () => {
    expect(isInCi({ CI: '1' })).toBe(true);
    expect(isInCi({ CI: 'false' })).toBe(false);
    expect(isInCi({ CONTINUOUS_INTEGRATION: 'true' })).toBe(true);
    expect(isInCi({})).toBe(false);
    const base = { stdinIsTTY: true, stdoutIsTTY: true, env: { TERM: 'xterm' }, flags: {} };
    expect(isInteractive(base)).toBe(true);
    expect(isInteractive({ ...base, stdinIsTTY: false })).toBe(false);
    expect(isInteractive({ ...base, env: { TERM: 'dumb' } })).toBe(false);
    expect(isInteractive({ ...base, env: { CI: '1' } })).toBe(false);
    expect(isInteractive({ ...base, flags: { plain: true } })).toBe(false);
    expect(isInteractive({ ...base, flags: { json: true } })).toBe(false);
    expect(isInteractive({ ...base, flags: { noInput: true } })).toBe(false);
  });
  it('jevcodeDir honours JEVCODE_HOME; export paths use the session/export sanitiser', () => {
    expect(jevcodeDir({}, '/home/me', '/cwd')).toBe('/home/me/.jevcode');
    expect(jevcodeDir({ JEVCODE_HOME: 'rel' }, '/home/me', '/cwd')).toBe('/cwd/rel');
    expect(exportFilePath('/h/.jevcode', 'a/b c')).toBe('/h/.jevcode/exports/a_b_c.log');
  });
  it('mostRecentSession picks the greatest lastUsed of the workspace only', () => {
    const rows = [
      { sessionId: 'a', workspace: '/w', title: 'a', task60: 'a', runs: [], lastUsed: '2026-09-20T10:00:00.000Z', createdAt: '', totalUsd: 0, mode: 'jev-on' as const, branch: null },
      { sessionId: 'b', workspace: '/w', title: 'b', task60: 'b', runs: [], lastUsed: '2026-09-20T12:00:00.000Z', createdAt: '', totalUsd: 0, mode: 'jev-on' as const, branch: null },
      { sessionId: 'c', workspace: '/other', title: 'c', task60: 'c', runs: [], lastUsed: '2026-09-20T13:00:00.000Z', createdAt: '', totalUsd: 0, mode: 'jev-on' as const, branch: null },
    ];
    expect(mostRecentSession(rows, '/w')?.sessionId).toBe('b');
    expect(mostRecentSession(rows, '/none')).toBeNull();
  });
  it('helpLines lists every command with its title, marks availability, keeps the per-terminal notes and stays ≤ 60 lines', () => {
    const lines = helpLines('all', { live: true });
    expect(lines.length).toBeLessThanOrEqual(60);
    expect(lines.some((l) => l.startsWith('/undo') && l.endsWith('(idle only)'))).toBe(true);
    expect(lines).toContain('Shift+Enter needs a keyboard protocol: use Ctrl+J or \\ then Enter');
    expect(helpLines('commands', { live: false }).some((l) => l.startsWith('keys ·'))).toBe(false);
    expect(helpLines('keys', { live: false }).some((l) => l.startsWith('/exit'))).toBe(false);
  });
  it('applyRawEdits applies Backspace / DEL / Ctrl-U and drops other control bytes', () => {
    expect(applyRawEdits('abc\u007fd')).toBe('abd');
    expect(applyRawEdits('abc\u0015xy')).toBe('xy');
    expect(applyRawEdits('a\u0001b')).toBe('ab');
  });
  it('§24 strings', () => {
    expect(EXIT_CONFIRM_ROW).toBe('a run is live: [y] abort and exit   [n] stay              (Enter does nothing)');
    expect(pausedItemText(5)).toBe('paused after step 5 — /resume continues, or type a follow-up');
    expect(sessionEndedText('s1', 2, 1.5)).toBe('session s1 ended: 2 runs, $1.50 total');
  });
});

describe('startup (§1 session loop)', () => {
  it('runs firstFrame → setHost → setUi → sandbox line → recent hint, in that order, and the first frame precedes every file read', async () => {
    const ws = '/tmp/x';
    const h = await build({ indexLines: finishedRunLines({ sessionId: 'S1', runId: scriptedRunId(900), workspace: ws, task: 'older task', cost: { generator: 0.2, jev: 0.02 }, title: 'fix parse_date tz' }) });
    void h.controller.run();
    await h.ready();
    expect(h.renderer.firstFrameResolved).toBe(true);
    expect(h.renderer.hosts).toHaveLength(1);
    expect(h.renderer.uis).toHaveLength(1);
    const sandbox = h.renderer.notes.find((n) => n.label === '[sandbox]');
    expect(sandbox?.text).toBe(sandboxText(detectSandboxLevel('auto')));
    // the index row is of another workspace → no recent hint
    expect(h.renderer.notes.some((n) => n.text.startsWith('recent:'))).toBe(false);
    expect(h.controller.view.firstFrameMs).not.toBeNull();
    expect(h.controller.view.phase).toBe('none');
  });

  it('the recent-session hint names the workspace\'s most recent session (§24 string)', async () => {
    const pre = await build();
    const h = await build({ indexLines: finishedRunLines({ sessionId: 'S1', runId: scriptedRunId(901), workspace: pre.workspace, task: 'older task', cost: { generator: 0.2, jev: 0.02 }, title: 'fix parse_date tz' }), options: { cwd: pre.workspace }, flags: { workspace: pre.workspace } });
    void h.controller.run();
    await h.ready();
    const hint = h.renderer.notes.find((n) => n.text.startsWith('recent:'));
    expect(hint?.text).toMatch(/^recent: "fix parse_date tz" · .+  \(Enter continues, \/resume browses\)$/);
  });

  it('one-shot: the argv task starts a run right after startup; the process exits with run:end\'s exit code', async () => {
    const h = await build({ mode: 'one-shot', task: 'probe task', script: () => ({ stop: 'max_steps', exitCode: 4 }) });
    const code = await h.controller.run();
    expect(code).toBe(4);
    expect(h.factory.calls).toHaveLength(1);
    expect(h.factory.calls[0]!.task).toBe('probe task');
    expect(h.renderer.unmounted).toBe(1);
    expect(h.restores).toBe(1);
    // the one-shot epilogue goes to stderr after unmount (§13.5)
    expect(h.stderr.join('')).toMatch(/^jevcode: stopped — max_steps \(exit 4\)\n  run {7}\d{8}-/);
  });

  it('one-shot: a complete run whose state.json exists prints `resume    jevcode run --resume <id>` (§13.5; its state seeds a follow-up, §5.2); without the file the row is `state.json missing — not resumable`', async () => {
    const h = await build({ mode: 'one-shot', task: 'probe task', script: () => ({ stop: 'complete', hold: true }) });
    const done = h.controller.run();
    const eng = await h.factory.nextLive();
    const runDir = join(eng.opts.runsDir, eng.runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'state.json'), '{}');
    eng.release();
    expect(await done).toBe(0);
    const err = h.stderr.join('');
    expect(err).toContain('jevcode: stopped — complete (exit 0)');
    expect(err).toContain(`resume    jevcode run --resume ${eng.runId}`);
    expect(err).not.toContain(NOT_RESUMABLE);

    const h2 = await build({ mode: 'one-shot', task: 'probe task', script: () => ({ stop: 'complete' }) });
    expect(await h2.controller.run()).toBe(0);
    expect(h2.stderr.join('')).toContain(`resume    ${NOT_RESUMABLE}`);
  });

  it('one-shot: a task with a secret and no prompt channel is refused with the §24 line and exit 2 (§10.2)', async () => {
    const h = await build({ mode: 'one-shot', task: `use ${SECRET} please`, interactive: false, rendererKind: 'plain' });
    const code = await h.controller.run();
    expect(code).toBe(2);
    expect(h.factory.calls).toHaveLength(0);
    const hits = detectSecrets(`use ${SECRET} please`);
    expect(h.stderr.join('')).toContain(gateRefusalLine(hits));
  });

  it('one-shot: the F-V gate `y` addSecrets the span before createEngine and passes secretsAcked (§10.2)', async () => {
    const h = await build({ mode: 'one-shot', task: `use ${AWS} please`, prompts: { secretGate: async () => true } });
    const code = await h.controller.run();
    expect(code).toBe(0);
    const opts = h.factory.calls[0]!;
    expect(opts.secretsAcked).toBe(1);
    // the warn-only AWS family is masked once acknowledged (addSecret before createEngine)
    expect(opts.redact(`x ${AWS} y`)).not.toContain(AWS);
  });

  it('a missing task in one-shot mode is a usage error (exit 2) after unmount', async () => {
    const h = await build({ mode: 'one-shot', task: null, interactive: false, rendererKind: 'plain' });
    const code = await h.controller.run();
    expect(code).toBe(2);
    expect(h.stderr.join('')).toContain('missing task text');
    expect(h.renderer.unmounted).toBe(1);
  });
});

describe('host wiring (§15 item 16, §10.2)', () => {
  it('submit: addSecret runs for every span before createEngine; the engine receives the raw text and secretsAcked', async () => {
    const h = await build();
    void h.controller.run();
    await h.ready();
    await h.submit(`task with ${SECRET} and ${AWS}`, { secretSpans: [SECRET, AWS] });
    const opts = h.factory.calls[0]!;
    expect(opts.task).toBe(`task with ${SECRET} and ${AWS}`);
    expect(opts.secretsAcked).toBe(2);
    expect(opts.redact(SECRET)).not.toContain(SECRET);
    expect(opts.redact(AWS)).toBe('[REDACTED:composer#2]');
    expect(h.renderer.attached).toHaveLength(1);
  });

  it('steer while live: addSecret first, engine.steer(raw, { secretsAcked }), the index gains a steer line; idle steer is refused', async () => {
    const h = await build({ script: () => ({ hold: true }) });
    void h.controller.run();
    await h.ready();
    expect(h.host.steer('nobody live', { secretSpans: [] })).toEqual({ ok: false, reason: 'finished', queued: 0 });
    const p = h.submit('fix it');
    const eng = await h.factory.nextLive();
    expect(h.host.phase()).toBe('live');
    const r = h.host.steer(`also ${AWS}`, { secretSpans: [AWS] });
    expect(r).toEqual({ ok: true, index: 1, queued: 1 });
    expect(eng.directives[0]!.text).toBe(`also ${AWS}`);
    expect(eng.emitted.some((e) => e.type === 'secret-ack' && e.count === 1)).toBe(true);
    expect(h.host.unsteer()?.text).toBe(`also ${AWS}`);
    eng.release();
    await p;
    const steer = h.index().find((l) => l.kind === 'steer');
    expect(steer).toMatchObject({ kind: 'steer', runId: eng.runId, step: 4 });
    // E13: the index text is redacted (the AWS span was acked, so the composer redactor masks it)
    expect(JSON.stringify(steer)).not.toContain(AWS);
  });

  it('note(): engine.annotate while live (a notice kind ui event), a renderer-local item while idle (§15.1)', async () => {
    const h = await build({ script: () => ({ hold: true }) });
    void h.controller.run();
    await h.ready();
    h.host.note('idle line', { label: '[ui]' });
    expect(h.renderer.notes.at(-1)).toMatchObject({ text: 'idle line', label: '[ui]' });
    const p = h.submit('go');
    const eng = await h.factory.nextLive();
    const before = h.renderer.notes.length;
    h.host.note('live line', { detail: 'body' });
    expect(eng.annotated).toEqual(['live line']);
    expect(h.renderer.notes.length).toBe(before);
    expect(h.renderer.events.some((e) => e.type === 'notice' && e.kind === 'ui' && e.text === 'live line')).toBe(true);
    eng.release();
    await p;
  });

  it('pause and abort reach the engine; a human_pause reopens the composer with the paused item (§8.7, §24)', async () => {
    const h = await build({ script: () => ({ hold: true, steps: 5 }) });
    void h.controller.run();
    await h.ready();
    const p = h.submit('pause me');
    await h.factory.nextLive();
    h.host.pause();
    await p;
    expect(h.controller.view.phase).toBe('none');
    expect(h.index().some((l) => l.kind === 'pause')).toBe(true);
    expect(h.renderer.notes.at(-1)?.text).toBe(pausedItemText(5));
    expect(h.controller.view.runs[0]?.exitCode).toBe(4);
    const p2 = h.submit('abort me');
    const eng2 = await h.factory.nextLive();
    h.host.abort('human_abort');
    await p2;
    expect(eng2.aborts).toEqual([{ reason: 'human_abort' }]);
    expect(h.controller.view.runs[1]?.exitCode).toBe(130);
    expect(h.controller.view.phase).toBe('none');
    expect(h.renderer.unmounted).toBe(0);
  });
});

describe('sessions, seeds and money (§8.3, §9.1, §9.3)', () => {
  it('the second run is seeded from the first: sessionId shared, parentRunId = R1, plan.done and window carried, index run:start/run:end pairs', async () => {
    const h = await build();
    void h.controller.run();
    await h.ready();
    await h.submit('fix parse_date tz handling');
    await h.submit('now update the docs');
    const [r1, r2] = h.factory.calls as [EngineOptions, EngineOptions];
    expect(r1.session).toMatchObject({ sessionId: null, parentRunId: null, source: 'cli' });
    expect(r1.seed).toBeUndefined();
    const id1 = h.factory.engines[0]!.runId;
    expect(r2.session).toMatchObject({ sessionId: id1, parentRunId: id1 });
    expect(r2.seed?.parentRunId).toBe(id1);
    expect(r2.seed?.plan.done.map((d) => d.text)).toEqual(['did fix parse_date tz handling']);
    expect(r2.seed?.window[0]?.notes).toContain(`from run ${id1}`);
    expect(r2.seed?.plan.harnessProblems[0]?.text).toContain(`Follow-up to run ${id1} (stopped: complete)`);
    const idx = h.index();
    expect(idx.filter((l) => l.kind === 'run:start')).toHaveLength(2);
    expect(idx.filter((l) => l.kind === 'run:end')).toHaveLength(2);
    expect(idx.filter((l) => l.kind === 'run:start').every((l) => l.sessionId === id1)).toBe(true);
    expect(h.controller.view.sessionMeter.snapshot().totalUsd).toBeCloseTo(0.23, 6);
    // each run's child meter forwards to the session root (default session cap = 5 × the $2.00 jev-on run cap)
    expect(r1.meter.snapshot().parent?.capUsd).toBe(10);
  });

  it('follow-up gate: remaining ≥ runCap starts; 0 < remaining < runCap clamps (silently without a prompt channel); remaining ≤ 0 refuses with the §24 item', async () => {
    const h = await build({ flags: { sessionSpendCap: '0.5', spendCap: '0.3' }, script: () => ({ cost: { generator: 0.2, jev: 0.05 } }) });
    void h.controller.run();
    await h.ready();
    await h.submit('one');
    expect(h.factory.calls[0]!.session?.clamp).toBeUndefined();
    await h.submit('two');
    // remaining 0.25 < runCap 0.30 → clamped child cap 0.25
    expect(h.factory.calls[1]!.session?.clamp).toEqual({ runCapUsd: 0.3, clampedToUsd: 0.25, sessionSpentUsd: 0.25, sessionCapUsd: 0.5 });
    expect(h.factory.calls[1]!.meter.snapshot().capUsd).toBeCloseTo(0.25, 9);
    await h.submit('three');
    expect(h.factory.calls).toHaveLength(2);
    expect(h.renderer.notes.at(-1)?.text).toBe(sessionCapReachedItem(0.5, 0.5));
  });

  it('follow-up confirm through the prompter: n cancels, y clamps (§9.3)', async () => {
    let answer: 'y' | 'r' | 'n' = 'n';
    const h = await build({ flags: { sessionSpendCap: '0.5', spendCap: '0.3' }, script: () => ({ cost: { generator: 0.2, jev: 0.05 } }), prompts: { followUp: async () => answer } });
    void h.controller.run();
    await h.ready();
    await h.submit('one');
    await h.submit('two');
    expect(h.factory.calls).toHaveLength(1);
    answer = 'y';
    await h.submit('two again');
    expect(h.factory.calls).toHaveLength(2);
    expect(h.factory.calls[1]!.session?.clamp?.clampedToUsd).toBe(0.25);
  });

  it('/budget session-spend-cap mutates the root meter now (setCap), writes the index budget line and the §24 item; spend-cap is pending for the next run', async () => {
    const h = await build({ flags: { sessionSpendCap: '10' } });
    void h.controller.run();
    await h.ready();
    await h.submit('one');
    await h.command('/budget session-spend-cap 15');
    expect(h.controller.view.sessionMeter.snapshot().capUsd).toBe(15);
    expect(h.renderer.notes.at(-1)?.text).toBe(sessionCapChangedLine(10, 15));
    expect(h.index().some((l) => l.kind === 'budget' && l.setting === 'session.spendCapUsd' && l.to === '15')).toBe(true);
    await h.command('/budget spend-cap 3');
    expect(h.controller.view.pending.spendCapUsd).toBe(3);
    expect(h.renderer.notes.at(-1)?.text).toBe('budget: spend-cap 3.00 pending (next /resume or run)');
    await h.submit('two');
    expect(h.factory.calls[1]!.limits.spendCapUsd).toBe(3);
    // §9.4 "whichever comes first": the pending value was consumed by the new run — the next run is back on the configured cap
    expect(h.controller.view.pending.spendCapUsd).toBeUndefined();
    await h.submit('three');
    expect(h.factory.calls[2]!.limits.spendCapUsd).toBe(2);
    await h.command('/budget spend-cap 0.01');
    expect(h.renderer.notes.at(-1)?.text).toMatch(/^error: \/budget spend-cap 0\.01 is not above this run's spend/);
    await h.command('/budget max-steps 14');
    expect(h.controller.view.pending.maxSteps).toBe(14);
    await h.command('/budget');
    expect(h.renderer.notes.at(-1)?.detail ?? h.renderer.notes.map((n) => n.text).join('\n')).toContain('pending: max-steps 14');
  });

  it('/budget session-spend-cap before the first run survives the first submit (setCap on the same root) and its index line lands with the first run\'s session id (§9.4, §8.2)', async () => {
    const h = await build({ flags: { sessionSpendCap: '10' } });
    void h.controller.run();
    await h.ready();
    await h.command('/budget session-spend-cap 15');
    expect(h.renderer.notes.at(-1)?.text).toBe(sessionCapChangedLine(10, 15));
    expect(h.controller.view.sessionMeter.snapshot().capUsd).toBe(15);
    // no session yet: nothing in the index until a run creates the session
    expect(h.index().some((l) => l.kind === 'budget')).toBe(false);
    await h.submit('one');
    expect(h.controller.view.sessionMeter.snapshot().capUsd).toBe(15);
    expect(h.factory.calls[0]!.meter.snapshot().parent?.capUsd).toBe(15);
    const sid = h.factory.engines[0]!.runId;
    const budget = h.index().find((l) => l.kind === 'budget');
    expect(budget).toMatchObject({ kind: 'budget', sessionId: sid, runId: null, setting: 'session.spendCapUsd', from: '10', to: '15' });
    await h.command('/budget');
    expect(h.renderer.notes.at(-1)?.detail).toContain('session cap $15.00');
    // /new: a fresh session with its own (configured) cap
    await h.command('/new');
    expect(h.controller.view.sessionMeter.snapshot().capUsd).toBe(10);
  });

  it('§9.1: /resume of another session folds the index excluding the resumed run and creates the child cap before adding the resumed spend', async () => {
    const ws = '/tmp/ws-resume';
    const resumed = scriptedRunId(910);
    const earlier = scriptedRunId(911);
    const lines = [
      ...finishedRunLines({ sessionId: 'S9', runId: earlier, workspace: ws, task: 'earlier', cost: { generator: 7, jev: 1 } }),
      ...finishedRunLines({ sessionId: 'S9', runId: resumed, workspace: ws, task: 'resumed', cost: { generator: 1.4, jev: 0.1 }, stop: 'max_steps' }),
    ];
    const h = await build({ flags: { sessionSpendCap: '10', spendCap: '2' }, indexLines: lines, deps: { loadForResume: async (_dir, runId) => ({ meta: loadedRun({ runId, sessionId: 'S9', workspace: realpathSync(h.workspace), task: 'resumed' }).meta, state: loadedRun({ runId, sessionId: 'S9', workspace: realpathSync(h.workspace), step: 23, stop: 'max_steps', spend: { generator: 1.4, jev: 0.1 } }).state!, previousStopReason: 'max_steps', warnings: [] }) } });
    void h.controller.run();
    await h.ready();
    await h.command(`/resume ${resumed}`);
    expect(h.factory.calls, h.renderer.notes.map((n) => n.text).join(' | ')).toHaveLength(1);
    const opts = h.factory.calls[0]!;
    expect(opts.resume).toEqual({ runId: resumed, force: false });
    // remaining = 10 − 8 = 2 → child cap 2.00, never 0.50; then the resumed $1.50 is added to the session root
    expect(opts.meter.snapshot().capUsd).toBe(2);
    expect(opts.session?.clamp).toBeUndefined();
    expect(h.controller.view.sessionMeter.snapshot().totalUsd).toBeCloseTo(8 + 1.5 + 0.115, 6);
    expect(h.controller.view.sessionId).toBe('S9');
  });

  it('/resume of a complete run without --force adopts its session for a follow-up instead of resuming', async () => {
    const done = scriptedRunId(920);
    const h = await build({ indexLines: finishedRunLines({ sessionId: 'S2', runId: done, workspace: '/tmp/ws', task: 'done task', cost: { generator: 0.3, jev: 0.03 } }), loaded: { [done]: loadedRun({ runId: done, sessionId: 'S2', workspace: '/tmp/ws', task: 'done task' }) } });
    void h.controller.run();
    await h.ready();
    await h.command(`/resume ${done}`);
    expect(h.factory.calls).toHaveLength(0);
    expect(h.controller.view.sessionId).toBe('S2');
    expect(h.renderer.notes.at(-1)?.text).toContain(`run ${done} is complete`);
    await h.submit('follow up on it');
    expect(h.factory.calls[0]!.session).toMatchObject({ sessionId: 'S2', parentRunId: done });
    expect(h.factory.calls[0]!.seed?.parentRunId).toBe(done);
  });

  it('/new ends the session: the §24 item, a fresh sessionId and root meter for the next run', async () => {
    const h = await build();
    void h.controller.run();
    await h.ready();
    await h.submit('one');
    const first = h.controller.view.sessionId;
    await h.command('/new');
    expect(h.renderer.notes.at(-1)?.text).toBe(sessionEndedText(first!, 1, 0.115));
    expect(h.controller.view.sessionId).toBeNull();
    await h.submit('two');
    expect(h.controller.view.sessionId).toBe(h.factory.engines[1]!.runId);
    expect(h.controller.view.sessionMeter.snapshot().totalUsd).toBeCloseTo(0.115, 6);
  });
});

describe('commands (§5.2)', () => {
  it('idle-only commands while live and live-only commands while idle append the §24 error items and never reach the engine', async () => {
    const h = await build({ script: () => ({ hold: true }) });
    void h.controller.run();
    await h.ready();
    await h.command('/pause');
    expect(h.renderer.notes.at(-1)).toMatchObject({ text: 'error: /pause needs a live run', label: '[ui]', level: 'error' });
    await h.command('/foo');
    expect(h.renderer.notes.at(-1)?.text).toBe('error: unknown command /foo; type / to list commands');
    const p = h.submit('go');
    const eng = await h.factory.nextLive();
    await h.command('/undo');
    expect(eng.annotated.at(-1)).toBe('error: /undo runs when the run is idle; Esc pauses first');
    await h.command('/rename tz fixes');
    expect(eng.annotated.at(-1)).toBe('renamed the session to "tz fixes"');
    eng.release();
    await p;
    expect(h.index().some((l) => l.kind === 'rename' && l.title60 === 'tz fixes')).toBe(true);
    expect(h.factory.calls[0]!.session?.title).toBeUndefined();
    const p2 = h.submit('next');
    const eng2 = await h.factory.nextLive();
    expect(h.factory.calls[1]!.session?.title).toBe('tz fixes');
    eng2.release();
    await p2;
  });

  it('/help, /status, /cost, /jev, /config, /errors, /plan and /decisions append blocks; /model /provider /mode are pending values', async () => {
    const h = await build();
    void h.controller.run();
    await h.ready();
    await h.submit('one');
    const texts = (): string[] => h.renderer.notes.map((n) => n.text);
    await h.command('/help');
    expect(texts().at(-1)).toBe('help');
    expect(h.renderer.notes.at(-1)?.detail).toContain('/exit  leave (exit 0; confirms first while a run is live)');
    await h.command('/status');
    expect(h.renderer.notes.at(-1)?.detail).toContain(`session ${h.controller.view.sessionId}`);
    await h.command('/cost');
    expect(h.renderer.notes.at(-1)?.text).toMatch(/^run \$0\.115 of \$2\.000/);
    await h.command('/jev');
    expect(h.renderer.notes.at(-1)?.detail).toContain('decider typesafe/jev-1.13-20260917');
    await h.command('/config');
    expect(h.renderer.notes.at(-1)?.detail).toContain('limits.spendCapUsd');
    await h.command('/errors');
    expect(h.renderer.notes.at(-1)?.detail).toBe('(no warnings or errors yet)');
    await h.command('/plan');
    expect(texts().at(-1)).toBe('plan');
    await h.command('/decisions 3');
    expect(texts().at(-1)).toBe('decisions (last 0)');
    await h.command('/model claude-opus-5');
    expect(h.controller.view.pending.model).toBe('claude-opus-5');
    await h.command('/mode jev-off');
    expect(h.controller.view.pending.mode).toBe('jev-off');
    await h.command('/theme light');
    expect(h.renderer.uis.at(-1)?.theme).toBe('light');
  });

  it('/export names each run\'s own task in its header for runs loaded from the index (§8.7)', async () => {
    const ws = '/tmp/ws-export';
    const r1 = scriptedRunId(930);
    const r2 = scriptedRunId(931);
    const h = await build({
      indexLines: [...finishedRunLines({ sessionId: 'S3', runId: r1, workspace: ws, task: 'first task of the session', cost: { generator: 0.1, jev: 0.01 } }), ...finishedRunLines({ sessionId: 'S3', runId: r2, workspace: ws, task: 'second task, quite different', cost: { generator: 0.1, jev: 0.01 }, t: '2026-09-20T14:05:00.000Z', parentRunId: r1 })],
      loaded: { [r1]: loadedRun({ runId: r1, sessionId: 'S3', workspace: ws, task: 'first task of the session' }), [r2]: loadedRun({ runId: r2, sessionId: 'S3', parentRunId: r1, workspace: ws, task: 'second task, quite different' }) },
    });
    void h.controller.run();
    await h.ready();
    await h.command(`/resume ${r2}`);
    expect(h.controller.view.sessionId).toBe('S3');
    await h.command('/export');
    const text = readFileSync(exportFilePath(h.home, 'S3'), 'utf8');
    const headers = text.split('\n').filter((l) => l.startsWith('==== run '));
    expect(headers).toHaveLength(2);
    expect(headers[0]).toContain(`${r1} · `);
    expect(headers[0]).toContain('first task of the session');
    expect(headers[1]).toContain(`${r2} · `);
    expect(headers[1]).toContain('second task, quite different');
  });

  it('/export writes one header per run of the session to the default path; /export <file> honours the path', async () => {
    const h = await build();
    void h.controller.run();
    await h.ready();
    await h.submit('one');
    await h.submit('two');
    await waitFor(() => h.controller.view.index.length > 0, 2000, 'refold');
    await h.command('/export');
    const sid = h.controller.view.sessionId!;
    const out = exportFilePath(h.home, sid);
    expect(existsSync(out)).toBe(true);
    const text = readFileSync(out, 'utf8');
    expect(text.match(/^==== run /gm)?.length).toBe(2);
    expect(h.renderer.notes.at(-1)?.text).toMatch(/^exported 2 runs to /);
    await h.command('/export out/custom.log');
    expect(existsSync(join(h.workspace, 'out', 'custom.log'))).toBe(true);
  });

  it('exclusive commands run one at a time: a second mutating command while one is in flight is refused with the §24 error item (§12.4)', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = await build({
      deps: {
        exportSession: async (runs, out) => {
          await gate;
          return { path: out, runs: runs.length, bytes: 0, truncated: false, missing: [] };
        },
      },
    });
    void h.controller.run();
    await h.ready();
    await h.submit('one');
    const exporting = h.host.command('/export');
    await tick(5);
    await h.command('/undo');
    expect(h.renderer.notes.at(-1)?.text).toBe('error: /undo: another command is still running (/export)');
    await h.command('/rewind');
    expect(h.renderer.notes.at(-1)?.text).toBe('error: /rewind: another command is still running (/export)');
    // a read-only command is never blocked
    await h.command('/status');
    expect(h.renderer.notes.at(-1)?.text).toBe('status');
    release!();
    await exporting;
    expect(h.renderer.notes.at(-1)?.text).toMatch(/^exported 1 run to /);
    await h.command('/undo');
    expect(h.renderer.notes.at(-1)?.text).toBe('error: /undo: no step of the last run changed files');
  });

  it('/theme outlives a re-resolution of the config (/login saved a key) (§8.7)', async () => {
    const h = await build({
      prompts: { wizard: async () => ({ kind: 'saved', patch: { provider: 'anthropic', apiKey: SECRET, jevApiKey: SECRET } }) },
      deps: { writeCredentials: async () => ({ path: '/tmp/config.json', displayPath: '~/.config/jevcode/config.json', dir: '/tmp', items: ['saved ~/.config/jevcode/config.json (mode 0600, dir 0700)'], warnings: [], fingerprints: { generator: 'e31150e9', jev: 'e31150e9' }, windows: false, dirSecured: true }) },
    });
    void h.controller.run();
    await h.ready();
    await h.command('/theme light');
    expect(h.renderer.uis.at(-1)?.theme).toBe('light');
    await h.command('/login');
    expect(h.renderer.uis.length).toBeGreaterThanOrEqual(3);
    expect(h.renderer.uis.at(-1)?.theme).toBe('light');
  });

  it('/undo and /rewind refuse cleanly when the last run recorded no file changes', async () => {
    const h = await build();
    void h.controller.run();
    await h.ready();
    await h.command('/undo');
    expect(h.renderer.notes.at(-1)?.text).toBe('error: /undo: no finished run in this session yet');
    await h.submit('one');
    await h.command('/undo');
    expect(h.renderer.notes.at(-1)?.text).toBe('error: /undo: no step of the last run changed files');
    await h.command('/rewind');
    expect(h.renderer.notes.at(-1)?.text).toBe('error: /rewind: no step of the last run changed files');
  });
});

describe('exit paths (§13.5, §3.3)', () => {
  it('/exit idle exits 0; --exit-code=last-run exits with the last run\'s code', async () => {
    const h = await build({ script: () => ({ stop: 'max_steps', exitCode: 4 }), flags: { exitCode: 'last-run' } });
    const p = h.controller.run();
    await h.ready();
    await h.submit('one');
    await h.command('/exit');
    expect(await p).toBe(4);
    expect(h.renderer.unmounted).toBe(1);
  });

  it('--exit-code=last-run applies at the one exit seam the TUI uses (host.exit(0) for /exit, Ctrl-C ×2, Ctrl-D ×2): idle → the last run\'s 4; live [y] → the aborted run\'s 130 (§1, §13.5)', async () => {
    const h = await build({ script: () => ({ stop: 'max_steps', exitCode: 4 }), flags: { exitCode: 'last-run' } });
    const p = h.controller.run();
    await h.ready();
    await h.submit('one');
    h.host.exit(0);
    expect(await p).toBe(4);
    // the default policy stays 0
    const h0 = await build({ script: () => ({ stop: 'max_steps', exitCode: 4 }) });
    const p0 = h0.controller.run();
    await h0.ready();
    await h0.submit('one');
    h0.host.exit(0);
    expect(await p0).toBe(0);
    // live: abort first, then the policy reads the aborted run's code
    const h2 = await build({ script: () => ({ hold: true }), flags: { exitCode: 'last-run' } });
    const p2 = h2.controller.run();
    await h2.ready();
    const run = h2.submit('long');
    const eng = await h2.factory.nextLive();
    h2.host.exit(0);
    expect(eng.aborts).toEqual([{ reason: 'human_abort' }]);
    await run;
    expect(await p2).toBe(130);
    // a non-zero request (the wizard's exit 2) is never rewritten
    const h3 = await build({ flags: { exitCode: 'last-run' } });
    const p3 = h3.controller.run();
    await h3.ready();
    h3.host.exit(2);
    expect(await p3).toBe(2);
  });

  it('finishSession flushes one render (firstFrame) before the unmount so the renderer\'s last item commits, and a second exit request is ignored (§3.3)', async () => {
    const h = await build();
    const p = h.controller.run();
    await h.ready();
    h.host.exit(0);
    h.host.exit(0);
    expect(await p).toBe(0);
    expect(h.renderer.unmounted).toBe(1);
    expect(h.renderer.calls.slice(-2)).toEqual(['firstFrame', 'unmount']);
  });

  it('--list-sessions in the TUI prints its rows to stdout only after the unmount (§13.6)', async () => {
    const writes: number[] = [];
    let h: Harness | null = null;
    const built = await build({ flags: { listSessions: true }, options: { stdout: { write: (s: string) => writes.push(h?.renderer.unmounted ?? -1) && s, isTTY: false, columns: 80 } } });
    h = built;
    const code = await built.controller.run();
    expect(code).toBe(0);
    expect(writes).toEqual([1]);
    expect(built.renderer.unmounted).toBe(1);
  });

  it('/exit while live confirms; [n] stays; [y] aborts with human_abort and exits 0 after run:end (the run:end item carries 130)', async () => {
    let yes = false;
    const h = await build({ script: () => ({ hold: true }), prompts: { exitConfirm: async () => yes } });
    const p = h.controller.run();
    await h.ready();
    const run = h.submit('long');
    const eng = await h.factory.nextLive();
    await h.command('/exit');
    expect(eng.aborts).toEqual([]);
    yes = true;
    await h.command('/exit');
    await run;
    expect(eng.aborts).toEqual([{ reason: 'human_abort' }]);
    expect(await p).toBe(0);
    expect(h.controller.view.runs[0]?.exitCode).toBe(130);
  });

  it('host.exit(0) while live (Ctrl-D [y]) aborts first and exits after run:end; idle exits at once', async () => {
    const h = await build({ script: () => ({ hold: true }) });
    const p = h.controller.run();
    await h.ready();
    const run = h.submit('long');
    const eng = await h.factory.nextLive();
    h.host.exit(0);
    expect(eng.aborts).toEqual([{ reason: 'human_abort' }]);
    await run;
    expect(await p).toBe(0);
  });

  it('an external SIGTERM while live aborts with signal and exits 143 without reopening the composer; SIGINT while idle exits 130 with the one-line epilogue', async () => {
    const h = await build({ script: () => ({ hold: true }) });
    const p = h.controller.run();
    await h.ready();
    const run = h.submit('long');
    const eng = await h.factory.nextLive();
    h.controller.signal('SIGTERM');
    expect(eng.aborts).toEqual([{ reason: 'signal', signal: 'SIGTERM' }]);
    await run;
    expect(await p).toBe(143);
    expect(h.stderr.join('')).toContain('jevcode: stopped — signal: SIGTERM (exit 143)');

    const h2 = await build();
    const p2 = h2.controller.run();
    await h2.ready();
    h2.controller.signal('SIGINT');
    expect(await p2).toBe(130);
    expect(h2.stderr.join('')).toBe('jevcode: stopped — signal: SIGINT (exit 130)\n');
  });

  it('a SIGINT before startup finished still exits 130 (the handler is installed before the first frame)', async () => {
    const h = await build();
    const p = h.controller.run();
    h.controller.signal('SIGINT');
    expect(await p).toBe(130);
  });

  it('a SIGINT while startup awaits the trust prompt resolves run() 130 at once, settles the prompt, stops startup and stores no trust decision (§14.2, F3)', async () => {
    let cancelled = 0;
    let resolveTrust: ((o: null) => void) | null = null;
    const h = await build({
      prompts: {
        trust: () =>
          new Promise((r) => {
            resolveTrust = r;
          }),
        cancelAll: () => {
          cancelled += 1;
          resolveTrust?.(null);
        },
      },
    });
    writeFileSync(join(h.workspace, 'AGENTS.md'), '# instructions\nBe careful.\n');
    const p = h.controller.run();
    await waitFor(() => resolveTrust !== null, 4000, 'trust prompt');
    h.controller.signal('SIGINT');
    expect(await p).toBe(130);
    expect(cancelled).toBe(1);
    expect(h.stderr.join('')).toBe('jevcode: stopped — signal: SIGINT (exit 130)\n');
    await tick(20);
    // startup stopped after finishSession: no sandbox line, no trust decision persisted from the cancelled prompt
    expect(h.renderer.notes.some((n) => n.label === '[sandbox]')).toBe(false);
    expect(existsSync(join(h.home, 'trust.json'))).toBe(false);
    expect(h.renderer.unmounted).toBe(1);
  });

  it('a SIGTERM while the missing-key wizard is open exits 143 without waiting for the wizard (F3)', async () => {
    const h = await build({ flags: { mock: false }, env: { ANTHROPIC_API_KEY: '', JEV_API_KEY: '', OPENROUTER_API_KEY: '' }, prompts: { wizard: () => new Promise(() => undefined) } });
    const p = h.controller.run();
    await tick(50);
    h.controller.signal('SIGTERM');
    expect(await p).toBe(143);
  });

  it('onAbort (today\'s Ctrl-C) aborts a live run and, idle in one-shot mode, exits 130', async () => {
    const h = await build({ mode: 'one-shot', task: 'x', script: () => ({ hold: true }) });
    const p = h.controller.run();
    const eng = await h.factory.nextLive();
    h.controller.onAbort('human_abort');
    expect(eng.aborts).toEqual([{ reason: 'human_abort' }]);
    expect(await p).toBe(130);
  });
});

describe('the blocker (§13.3)', () => {
  const req: BlockingRequest = { id: 'b1', step: 3, kind: 'key-rejected', side: 'jev', detail: 'HTTP 401', stop: 'error', exitCode: 2 };
  it('is passed only to interactive renderers (or ones with a blocking prompt); the prompt\'s answer resolves it', async () => {
    const h = await build({ prompts: { blocking: async () => 'retry' } });
    void h.controller.run();
    await h.ready();
    await h.submit('one');
    const blocker = h.factory.calls[0]!.blocker;
    expect(blocker).toBeDefined();
    expect(await blocker!(req)).toBe('retry');
    const plain = await build({ interactive: false, rendererKind: 'plain' });
    void plain.controller.run();
    await plain.ready();
    await plain.submit('one');
    expect(plain.factory.calls[0]!.blocker).toBeUndefined();
  });
  it('the pane\'s `login` answer opens the wizard; a cancelled or closed wizard answers stop (§13.3)', async () => {
    const h = await build({ script: () => ({ hold: true }), prompts: { wizard: async () => ({ kind: 'cancelled' }) } });
    void h.controller.run();
    await h.ready();
    const run = h.submit('one');
    const eng = await h.factory.nextLive();
    const blocker = h.factory.calls[0]!.blocker!;
    const a = blocker({ ...req, id: 'b7' });
    expect(h.host.answerBlocking('b7', 'login')).toBe(true);
    expect(await a).toBe('stop');
    eng.release();
    await run;
  });

  it('host.answerBlocking answers a pending pane; host.abort (Ctrl-C) is the pane\'s [q] = stop', async () => {
    const h = await build({ script: () => ({ hold: true }) });
    void h.controller.run();
    await h.ready();
    const run = h.submit('one');
    const eng = await h.factory.nextLive();
    const blocker = h.factory.calls[0]!.blocker!;
    const a1 = blocker(req);
    expect(h.host.answerBlocking('nope', 'retry')).toBe(false);
    expect(h.host.answerBlocking('b1', 'continue')).toBe(true);
    expect(await a1).toBe('continue');
    const a2 = blocker({ ...req, id: 'b2' });
    h.host.abort('human_abort');
    expect(await a2).toBe('stop');
    expect(eng.aborts).toEqual([]);
    eng.release();
    await run;
  });
});

describe('the engine exit hook (§13.4)', () => {
  it('the forced-exit epilogue names the current run, never the previous run\'s error', async () => {
    let n = 0;
    const h = await build({ script: () => (++n === 1 ? { stop: 'error', steps: 0, exitCode: 2 } : { hold: true }) });
    void h.controller.run();
    await h.ready();
    await h.submit('one');
    expect(h.renderer.notes.at(-1)?.text).toBe('stopped — jev_http: Jev HTTP 401: User not found. (exit 2)');
    const p = h.submit('two');
    const eng = await h.factory.nextLive();
    const before = h.stderr.length;
    expect(() => h.factory.calls[1]!.exit!(130)).toThrow('process.exit(130)');
    const epilogue = h.stderr.slice(before).join('');
    expect(epilogue).toContain('(exit 130)');
    expect(epilogue).not.toContain('User not found');
    expect(epilogue).toContain(eng.runId);
    eng.release();
    await p;
  });

  it('EngineOptions.exit restores the terminal, prints the epilogue and exits with the code', async () => {
    const h = await build();
    void h.controller.run();
    await h.ready();
    await h.submit('one');
    const exit = h.factory.calls[0]!.exit!;
    expect(() => exit(130)).toThrow('process.exit(130)');
    expect(h.exits).toEqual([130]);
    expect(h.restores).toBeGreaterThanOrEqual(1);
    expect(h.stderr.join('')).toContain('(exit 130)');
    expect(h.factory.calls[0]!.configDirs).toBeDefined();
  });
  it('steers typed while the engine is being created are capped at 8 and replayed; the engine\'s refusals surface as the §24 error item (§8.6)', async () => {
    let h: Harness | null = null;
    let open: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const built = await build({
      script: () => ({ hold: true }),
      deps: {
        createEngine: async (opts) => {
          await gate;
          return h!.factory.factory(opts);
        },
      },
    });
    h = built;
    void built.controller.run();
    await built.ready();
    const p = built.host.submit('slow start', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    await waitFor(() => built.host.phase() === 'starting', 4000, 'starting');
    for (let i = 1; i <= STARTING_STEER_CAP; i++) expect(built.host.steer(`directive ${i}`, { secretSpans: [] })).toEqual({ ok: true, index: i, queued: i });
    expect(built.host.steer('one too many', { secretSpans: [] })).toEqual({ ok: false, reason: 'full', queued: 8 });
    open!();
    await p;
    const eng = built.factory.current();
    expect(eng.directives.map((d) => d.text)).toEqual(Array.from({ length: 8 }, (_, i) => `directive ${i + 1}`));
    eng.release();
    await built.host.awaitRunEnd();

    // an engine that refuses the replay: the refusal is reported, not dropped
    let h2: Harness | null = null;
    let open2: (() => void) | null = null;
    const gate2 = new Promise<void>((r) => {
      open2 = r;
    });
    const built2 = await build({
      script: () => ({ hold: true }),
      deps: {
        createEngine: async (opts) => {
          await gate2;
          const eng2 = await h2!.factory.factory(opts);
          const full: Engine = { ...eng2, steer: () => ({ ok: false, reason: 'full', queued: 8 }) };
          return full;
        },
      },
    });
    h2 = built2;
    void built2.controller.run();
    await built2.ready();
    const p2 = built2.host.submit('slow start', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    await waitFor(() => built2.host.phase() === 'starting', 4000, 'starting');
    expect(built2.host.steer('early', { secretSpans: [] })).toMatchObject({ ok: true });
    open2!();
    await p2;
    expect(built2.renderer.notes.some((n) => n.text === 'error: steer queue full (8)')).toBe(true);
    built2.factory.current().release();
    await built2.host.awaitRunEnd();
  });

  it('config warnings reach stderr as `jevcode: <warning>` for the line renderers and become one warning item in the TUI (§9.5, A136)', async () => {
    const xdg = mkdtempSync(join(tmpdir(), 'jevcode-xdg-'));
    try {
      mkdirSync(join(xdg, 'jevcode'), { recursive: true });
      writeFileSync(join(xdg, 'jevcode', 'config.json'), '{"notASetting": 1}\n');
      const plain = await build({ rendererKind: 'plain', interactive: false, env: { XDG_CONFIG_HOME: xdg }, prompts: { followUp: async () => 'n' } });
      void plain.controller.run();
      await plain.ready();
      expect(plain.stderr.join('')).toMatch(/^jevcode: configFile: .*unknown keys ignored: notASetting\n/);
      expect(plain.renderer.notes.some((n) => n.text.startsWith('warning:'))).toBe(false);
      const tui = await build({ rendererKind: 'tui', env: { XDG_CONFIG_HOME: xdg } });
      void tui.controller.run();
      await tui.ready();
      expect(tui.stderr).toEqual([]);
      expect(tui.renderer.notes.some((n) => n.text.startsWith('warning: configFile:') && n.level === 'warn')).toBe(true);
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  it('the controller\'s lines of a run land in <runDir>/jevcode.log and return to the session log at run:end (§13.6)', async () => {
    const h = await build({ deps: { log: undefined } });
    void h.controller.run();
    await h.ready();
    await h.submit('one');
    const runId = h.factory.engines[0]!.runId;
    const runLog = join(h.home, 'runs', runId, 'jevcode.log');
    await waitFor(() => existsSync(runLog), 2000, 'run log');
    expect(readFileSync(runLog, 'utf8')).toContain(`run ${runId} ended: complete exit 0`);
    expect(existsSync(join(h.home, 'logs'))).toBe(true);
    await h.submit('two');
    const runId2 = h.factory.engines[1]!.runId;
    expect(readFileSync(join(h.home, 'runs', runId2, 'jevcode.log'), 'utf8')).toContain(`run ${runId2} ended`);
    expect(readFileSync(runLog, 'utf8')).not.toContain(runId2);
  });

  it('mockReviewStep reads the dev-only JEVCODE_MOCK_REVIEW_AT hook (§19.5 pty review scenario)', () => {
    expect(mockReviewStep({})).toBeNull();
    expect(mockReviewStep({ JEVCODE_MOCK_REVIEW_AT: 'x' })).toBeNull();
    expect(mockReviewStep({ JEVCODE_MOCK_REVIEW_AT: ' 2 ' })).toBe(2);
  });

  it('dispatchContext exposes the step, the changed steps and the index fold; ranBefore flips after the first run', async () => {
    const h = await build({ script: () => ({ steps: 7, events: [{ type: 'outcome', step: 2, outcome: { status: 'executed', summary: 'ok', changedFiles: ['a.py'] } }] }) });
    void h.controller.run();
    await h.ready();
    expect(h.host.ranBefore()).toBe(false);
    await h.submit('one');
    expect(h.host.ranBefore()).toBe(true);
    const ctx = h.controller.host.dispatchContext();
    expect(ctx.step).toBe(7);
    expect(ctx.changedSteps).toEqual([2]);
    await tick(20);
    expect(h.controller.view.runs[0]?.changedFiles).toEqual(['a.py']);
  });
});
