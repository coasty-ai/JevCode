/**
 * docs/AGENT-LOOP-DESIGN.md §12 / §A2 / §A5 / §8 / §15 S4 — the classifier's gate on an agent `act` step, through the real engine:
 * `block` refuses (outcome blocked + a `risk` event with the rule, nothing runs); `review` asks through the existing confirm path under
 * `--autonomy review`; under full autonomy a destructive command RUNS with its rule on the step and one truthful transcript line
 * (left the machine / /undo restores / /undo may not restore); AGENT_MAX_BLOCKS refusals pause the run; and an act step passes the
 * coordinate gate while an observe step never does.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPostImages } from '../../../src/checkpoint/images.js';
import { openLedger, type LedgerHandle } from '../../../src/coordination/index.js';
import { sha256Hex } from '../../../src/core/hash.js';
import type { ActionOutcome, AgentGate, GitState } from '../../../src/core/types.js';
import { AGENT_MAX_BLOCKS, AGENT_MAX_BLOCKS_LINE, destructiveCoverage, destructiveNote, isAgentRefusal, ruleRiskAssessment } from '../../../src/loop/stages/agent.js';
import { DEV_B, makeHeartbeat, makeLease, putHeartbeat, putLease, runId as peerRunId, tempHome } from '../coordination/helpers.js';
import type { AgentHarness, Harness, ScriptedCall, ToolTurn } from './fakes.js';
import { FIXED_RUN_ID, alwaysApprove, alwaysDecline, createFakeSandbox, createFakeWorkspace, execResult, makeAgentEngine, repoState } from './fakes.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
async function agent(...args: Parameters<typeof makeAgentEngine>): Promise<AgentHarness> {
  const h = await makeAgentEngine(...args);
  cleanups.push(() => h.cleanup());
  return h;
}

const bash = (command: string): ToolTurn => ({ toolCalls: [{ name: 'bash', input: { command } }] });
const commandOf = (c: ScriptedCall): string => (typeof c.input === 'object' && c.input !== null && !Array.isArray(c.input) && typeof c.input['command'] === 'string' ? c.input['command'] : '');
/** a driver gate: this rule for commands matching `re`, ok otherwise (what S3's classifier hands the engine) */
function gateFor(re: RegExp, gate: AgentGate): (c: ScriptedCall) => AgentGate {
  return (c) => (re.test(commandOf(c)) ? gate : { verdict: 'ok', reason: 'ok', rule: null });
}
const noteLines = (h: Harness): string[] => h.of('transcript').filter((t) => t.text.startsWith('destructive · ')).map((t) => t.text);

describe('block and review (§12)', () => {
  it('block: outcome blocked, a `risk` event carrying the rule, nothing executed, the driver observes the refusal, the run goes on', async () => {
    const h = await agent([bash('rm -rf /tmp/scratch'), { text: 'The command was refused; I left /tmp alone.' }], {
      engine: { autonomy: 'review' },
      driver: { gate: gateFor(/rm -rf/, { verdict: 'block', reason: 'rm -rf of a path outside the workspace', rule: 'rm_outside' }) },
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('generator_done');
    expect(h.sandbox.commands).toEqual([]);
    const step1 = h.store.steps[0]!;
    expect(step1.outcome).toEqual({ status: 'blocked', reason: 'rm -rf of a path outside the workspace' });
    expect(step1.risk).toMatchObject({ verdict: 'block', risk: 1, rule: 'rm_outside', reason: 'rm -rf of a path outside the workspace' });
    expect(Object.values(step1.risk!.dims).every((d) => d.risk === 0 && d.level === 0)).toBe(true);
    const risk = h.of('risk');
    expect(risk).toHaveLength(1);
    expect(risk[0]!.risk.rule).toBe('rm_outside');
    expect(h.of('confirm:request')).toHaveLength(0);
    expect(r.counters.blocked).toBe(1);
    expect(h.driver.observations[0]!.outcome.status).toBe('blocked');
    expect(h.driver.observations[0]!.changedFiles).toEqual([]);
  });

  it('review under --autonomy review: the confirm path asks; declined → outcome declined; approved → the command runs', async () => {
    const reviewGate = gateFor(/^rm notes/, { verdict: 'review', reason: 'rm of an untracked file (unknown command)', rule: null });
    const declined = await agent([bash('rm notes.txt'), { text: 'Not removed.' }], { engine: { autonomy: 'review' }, confirmer: alwaysDecline, driver: { gate: reviewGate } });
    await declined.engine.run();
    expect(declined.of('confirm:request')).toHaveLength(1);
    expect(declined.of('confirm:request')[0]!.request.risk).toMatchObject({ verdict: 'review', risk: 1 });
    expect(declined.of('risk')).toHaveLength(1);
    expect(declined.store.steps[0]!.outcome).toMatchObject({ status: 'declined' });
    expect(declined.sandbox.commands).toEqual([]);
    expect(declined.driver.observations[0]!.outcome.status).toBe('declined');

    const approved = await agent([bash('rm notes.txt'), { text: 'Removed.' }], { engine: { autonomy: 'review' }, confirmer: alwaysApprove, driver: { gate: reviewGate } });
    await approved.engine.run();
    expect(approved.of('confirm:resolved')[0]).toMatchObject({ approved: true });
    expect(approved.sandbox.commands).toEqual(['rm notes.txt']);
    expect(approved.store.steps[0]!.outcome?.status).toBe('executed');
  });

  it('a review verdict under full autonomy is approved and logged without asking (a non-child run), as the legacy review is', async () => {
    const h = await agent([bash('make deploy'), { text: 'done' }], { driver: { gate: gateFor(/deploy/, { verdict: 'review', reason: 'unknown command', rule: null }) } });
    await h.engine.run();
    expect(h.of('confirm:request')).toHaveLength(0);
    expect(h.sandbox.commands).toEqual(['make deploy']);
    expect(h.of('transcript').some((t) => t.text === 'review · auto-approved (autonomy: full) · unknown command')).toBe(true);
  });

  it(`${AGENT_MAX_BLOCKS} gate refusals pause the run (human_pause, exit 4, resumable) with the review line`, async () => {
    let n = 0;
    const h = await agent(() => ({ toolCalls: [{ id: `rm_${++n}`, name: 'bash', input: { command: 'sudo rm -rf /' } }] }), {
      engine: { autonomy: 'review' },
      driver: { gate: () => ({ verdict: 'block', reason: 'privilege escalation', rule: 'privilege' }) },
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_pause');
    expect(r.steps).toBe(AGENT_MAX_BLOCKS);
    const end = h.of('run:end')[0]!;
    expect(end.exitCode).toBe(4);
    expect(end.resumable).toBe(true);
    expect(h.of('transcript').some((t) => t.text === AGENT_MAX_BLOCKS_LINE)).toBe(true);
    expect(h.sandbox.commands).toEqual([]);
  });

  it(`the classifier's own shape under --autonomy review: ${AGENT_MAX_BLOCKS} declined rule-matched reviews pause the run too`, async () => {
    let n = 0;
    const h = await agent(() => ({ toolCalls: [{ id: `push_${++n}`, name: 'bash', input: { command: 'git push --force origin main' } }] }), {
      engine: { autonomy: 'review' },
      confirmer: alwaysDecline,
      driver: { gate: () => ({ verdict: 'review', reason: 'git push --force rewrites the remote branch', rule: 'force_push' }) },
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_pause');
    expect(r.steps).toBe(AGENT_MAX_BLOCKS);
    expect(h.of('confirm:request')).toHaveLength(AGENT_MAX_BLOCKS);
    expect(h.store.steps.every((s) => s.outcome?.status === 'declined')).toBe(true);
    expect(h.of('transcript').some((t) => t.text === AGENT_MAX_BLOCKS_LINE)).toBe(true);
    expect(h.sandbox.commands).toEqual([]);
  });

  it('a declined review of an UNKNOWN command (no rule) is not a destructive refusal: it never counts toward the pause', async () => {
    let n = 0;
    const h = await agent((_req, i) => (i < AGENT_MAX_BLOCKS + 1 ? { toolCalls: [{ id: `mk_${++n}`, name: 'bash', input: { command: 'make deploy' } }] } : { text: 'Stopped asking.' }), {
      engine: { autonomy: 'review' },
      confirmer: alwaysDecline,
      driver: { gate: () => ({ verdict: 'review', reason: 'unknown command', rule: null }) },
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('generator_done');
    expect(r.steps).toBe(AGENT_MAX_BLOCKS + 2);
  });

  it('isAgentRefusal: block+blocked, or rule+review+declined; nothing else', () => {
    const blocked: ActionOutcome = { status: 'blocked', reason: 'x' };
    const declined: ActionOutcome = { status: 'declined', reason: 'x' };
    const executed: ActionOutcome = { status: 'executed', summary: 'ok', changedFiles: [] };
    expect(isAgentRefusal({ verdict: 'block', reason: 'r', rule: 'privilege' }, blocked)).toBe(true);
    expect(isAgentRefusal({ verdict: 'review', reason: 'r', rule: 'force_push' }, declined)).toBe(true);
    expect(isAgentRefusal({ verdict: 'review', reason: 'r', rule: null }, declined)).toBe(false);
    expect(isAgentRefusal({ verdict: 'review', reason: 'r', rule: 'force_push' }, executed)).toBe(false);
    expect(isAgentRefusal({ verdict: 'ok', reason: 'r', rule: 'force_push' }, executed)).toBe(false);
    expect(isAgentRefusal(null, blocked)).toBe(false);
  });
});

describe('§A2 full autonomy never refuses and never asks; §A5 the note tells the truth', () => {
  it('a destructive command under full autonomy RUNS: no risk event, no card, StepRecord.risk.rule, one transcript note', async () => {
    const h = await agent([bash('git push --force origin main'), { text: 'Pushed.' }], {
      driver: { gate: gateFor(/push/, { verdict: 'ok', reason: 'git push --force rewrites the remote branch', rule: 'force_push' }) },
    });
    await h.engine.run();
    expect(h.sandbox.commands).toEqual(['git push --force origin main']);
    expect(h.of('risk')).toHaveLength(0);
    expect(h.of('confirm:request')).toHaveLength(0);
    expect(h.store.steps[0]!.risk).toMatchObject({ verdict: 'ok', rule: 'force_push' });
    expect(h.store.steps[0]!.outcome?.status).toBe('executed');
    expect(noteLines(h)).toEqual(['destructive · ran git push --force origin main (rule force_push) — this left the machine; /undo cannot reverse it']);
    // the note written from what ran is the one reason the record keeps (the driver's pre-execution reason is replaced)
    expect(h.store.steps[0]!.risk!.reason).toBe(noteLines(h)[0]);
  });

  it('git_discard of dirty files, every file captured and HEAD unmoved: "/undo restores the workspace" — and the post image carries the run-start dirty file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jevcode-agent-gate-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    const original = 'def f():\n    return 1\n';
    const local = 'def f():\n    return 1  # my local note\n';
    writeFileSync(join(root, 'src', 'a.py'), local);
    const git = repoState({ dirty: ['src/a.py'] });
    const h = await agent([bash('git reset --hard'), { text: 'Discarded.' }], {
      runsDir: root,
      workspace: createFakeWorkspace({ root, gitState: git, dirtySet: new Set(['src/a.py']) }),
      probeGitState: git,
      // the "reset" puts the committed bytes back, as git would
      sandbox: createFakeSandbox((cmd) => {
        if (cmd === 'git reset --hard') writeFileSync(join(root, 'src', 'a.py'), original);
        return execResult({ exitCode: 0 });
      }),
      driver: { gate: gateFor(/reset --hard/, { verdict: 'ok', reason: 'git reset --hard discards uncommitted changes', rule: 'git_discard' }) },
    });
    await h.engine.run();
    expect(noteLines(h)).toEqual(['destructive · ran git reset --hard (rule git_discard) — /undo restores the workspace']);
    // the run-start dirty file never shows in changedFiles(), yet the step changed it: it is in the per-step set and the post image
    expect(h.driver.observations[0]!.changedFiles).toEqual(['src/a.py']);
    const post = await readPostImages(join(root, FIXED_RUN_ID), 1);
    expect(post.ok).toBe(true);
    if (post.ok) expect(post.image.files['src/a.py']).toMatchObject({ source: 'run', preImage: true });
    // the pre copy holds the human's bytes, which is what /undo puts back
    expect(readFileSync(join(root, FIXED_RUN_ID, 'pre', '1', sha256Hex('src/a.py')), 'utf8')).toBe(local);
  });

  it('anything not provably covered says "/undo may not restore this": ignored files (clean -x), a stash, rm outside, a moved HEAD', async () => {
    const cases: { command: string; rule: string }[] = [
      { command: 'git clean -fdx', rule: 'git_discard' },
      { command: 'git stash drop', rule: 'git_discard' },
      { command: 'rm -rf ../sibling', rule: 'rm_outside' },
    ];
    for (const c of cases) {
      const h = await agent([bash(c.command), { text: 'ok' }], { driver: { gate: gateFor(/./, { verdict: 'ok', reason: c.rule, rule: c.rule }) } });
      await h.engine.run();
      expect(noteLines(h)).toEqual([`destructive · ran ${c.command} (rule ${c.rule}) — /undo may not restore this`]);
    }
    // `git reset --hard HEAD~1` moves HEAD: /undo's HEAD rule would refuse, so the note must not promise a restore
    let head: GitState = repoState({ oid: 'a'.repeat(40) });
    const workspace = createFakeWorkspace({ gitState: head });
    workspace.gitState = () => head;
    const moved = await agent([bash('git reset --hard HEAD~1'), { text: 'ok' }], {
      workspace,
      probeGitState: head,
      sandbox: createFakeSandbox(() => {
        head = repoState({ oid: 'b'.repeat(40) });
        return execResult({ exitCode: 0 });
      }),
      driver: { gate: gateFor(/reset/, { verdict: 'ok', reason: 'discard', rule: 'git_discard' }) },
    });
    await moved.engine.run();
    expect(noteLines(moved)).toEqual(['destructive · ran git reset --hard HEAD~1 (rule git_discard) — /undo may not restore this']);
  });

  it('destructiveCoverage / destructiveNote / ruleRiskAssessment are the pure pieces of the same rule', () => {
    for (const rule of ['force_push', 'publish', 'exfiltrate', 'remote_exec']) expect(destructiveCoverage({ rule, command: 'x', imagesComplete: true, headMoved: false })).toBe('left-machine');
    expect(destructiveCoverage({ rule: 'git_discard', command: 'git checkout -- src/a.py', imagesComplete: true, headMoved: false })).toBe('restores');
    expect(destructiveCoverage({ rule: 'git_discard', command: 'git restore .', imagesComplete: true, headMoved: false })).toBe('restores');
    expect(destructiveCoverage({ rule: 'git_discard', command: 'git clean -fd', imagesComplete: true, headMoved: false })).toBe('restores');
    expect(destructiveCoverage({ rule: 'git_discard', command: 'git clean -fd', imagesComplete: false, headMoved: false })).toBe('may-not');
    expect(destructiveCoverage({ rule: 'git_discard', command: 'git clean -fd -X', imagesComplete: true, headMoved: false })).toBe('may-not');
    expect(destructiveCoverage({ rule: 'git_discard', command: 'git branch -D topic', imagesComplete: true, headMoved: false })).toBe('may-not');
    expect(destructiveCoverage({ rule: 'git_discard', command: 'git worktree remove --force ../wt', imagesComplete: true, headMoved: false })).toBe('may-not');
    expect(destructiveCoverage({ rule: 'outside_write', command: 'echo x > ~/.bashrc', imagesComplete: true, headMoved: false })).toBe('may-not');
    expect(destructiveNote('git   reset\n --hard', 'git_discard', 'restores')).toBe('destructive · ran git reset --hard (rule git_discard) — /undo restores the workspace');
    expect(ruleRiskAssessment({ verdict: 'ok', reason: 'fine', rule: null })).toMatchObject({ verdict: 'ok', risk: 0 });
    expect('rule' in ruleRiskAssessment({ verdict: 'ok', reason: 'fine', rule: null })).toBe(false);
  });
});

describe('the coordinate gate (COORDINATION-DESIGN §4.2) runs for act steps, never for observe steps', () => {
  async function ledgerWithPeerOn(path: string): Promise<LedgerHandle> {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const now = Date.now();
    const at = (ms: number): string => new Date(now + ms).toISOString();
    const peer = peerRunId(9);
    await putHeartbeat(t.root, makeHeartbeat({ deviceId: DEV_B, runId: peer, label: 'studio', step: 7, stage: 'propose', startedAt: at(-60_000), beatAt: at(-1_000), claim: { epoch: 1, deviceId: DEV_B, runId: peer, at: at(-60_000), pid: 5151 }, stamp: { n: 1, deviceId: DEV_B, runId: peer } }));
    await putLease(t.root, makeLease({ deviceId: DEV_B, runId: peer, label: 'studio', paths: [path], type: 'exclusive', step: 7, issuedAt: at(-1_000), renewedAt: at(-1_000), expiresAt: at(600_000) }));
    const ledger = openLedger({
      home: t.home,
      self: { deviceId: 'k3q7m2ab', label: 'mbp', host: 'mbp.local', user: 'p', bootAt: '2026-09-21T06:00:00.000Z', bootId: 'boot-1', sessionId: null, runId: null, wsKey: 'ws:3f9a2c1d8bc0d11e', repoKey: '9c3a7ac066816f2b', remoteKey: null, branch: 'main' },
      isPidAlive: () => true,
      watch: (() => {
        throw Object.assign(new Error('no fs.watch in tests'), { code: 'ENOSYS' });
      }) as never,
    });
    cleanups.push(() => ledger.close());
    await ledger.open();
    return ledger;
  }

  it('read → observe (no coordinate stage); write → act (coordinate stage, the peer conflict recorded on StepRecord.coord)', async () => {
    const ledger = await ledgerWithPeerOn('src/a.py');
    const h = await agent([{ toolCalls: [{ name: 'read_file', input: { path: 'src/a.py' } }] }, { toolCalls: [{ name: 'write_file', input: { path: 'src/a.py', content: 'x = 1\n' } }] }, { text: 'Wrote it.' }], {
      probeGitState: repoState(),
      engine: { coordination: { ledger } },
    });
    await h.engine.run();
    expect(h.of('stage:start').filter((e) => e.stage === 'coordinate').map((e) => e.step)).toEqual([2]);
    expect(h.store.steps[0]!.coord).toBeUndefined();
    expect(h.store.steps[1]!.coord?.conflicts.map((c) => c.path)).toEqual(['src/a.py']);
    expect(h.store.steps[1]!.outcome?.status).toBe('executed');
  });
});
