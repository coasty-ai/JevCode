/**
 * contract 1.4 (docs/COORDINATION-DESIGN.md §7.2–§7.3, §12.0.2): the step cache shape and its parser, the proposal's target
 * paths, the hash gate over a real directory, the resume-card DATA, and the checkpoint envelope with the new optional fields
 * (version stays 1; a state without them still parses).
 */
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckpointState, Json, PausePoint } from '../../../src/core/types.js';
import { sha256Hex } from '../../../src/core/hash.js';
import { CHECKPOINT_VERSION, isCheckpointState, parseEnvelope, serialiseEnvelope } from '../../../src/checkpoint/store.js';
import { foldStepsIntoState } from '../../../src/checkpoint/resume.js';
import {
  CACHED_SAMPLES_MAX,
  PARTIAL_TEXT_MAX_CHARS,
  REPLAY_HASH_MAX_FILES,
  buildResumeCard,
  hashTargets,
  parseStepCache,
  promptHashOf,
  proposalPaths,
  stepCacheName,
  stepCacheRel,
  verifyTargets,
  type StepCache,
} from '../../../src/checkpoint/replay.js';
import { makeMeta, makeProposal, makeState, makeStepRecord, withTempDir } from '../../fixtures/checkpoint/make.js';

const identity = (s: string): string => s;

function cacheJson(over: Partial<StepCache> = {}): Json {
  const c: StepCache = {
    v: 1,
    step: 3,
    stage: 'risk',
    proposal: makeProposal({ action: { kind: 'edit', path: 'src/a.py', old: 'a', new: 'b' } }),
    patchTargets: [],
    risk: null,
    matchesIntent: null,
    intent: null,
    proposer: null,
    contextFiles: ['src/a.py'],
    directive: null,
    targets: [{ rel: 'src/a.py', sha256: 'ab'.repeat(32) }],
    partial: { text: 'Working', chars: 7 },
    llmRound: null,
    resumes: 0,
    at: '2026-09-21T12:00:00.000Z',
    ...over,
  };
  return JSON.parse(JSON.stringify(c)) as Json;
}

describe('the step cache', () => {
  it('names the file both ways and bounds the snapshot', () => {
    expect(stepCacheRel(7)).toBe('cache/step-7.json');
    expect(stepCacheName(7)).toBe('step-7.json');
    expect(PARTIAL_TEXT_MAX_CHARS).toBe(32 * 1024);
    expect(CACHED_SAMPLES_MAX).toBe(32);
    expect(REPLAY_HASH_MAX_FILES).toBe(64);
  });

  it('parses a valid file and refuses the wrong version, a bad step, a malformed proposal, sample or target', () => {
    expect(parseStepCache(cacheJson())).toMatchObject({ v: 1, step: 3, stage: 'risk' });
    expect(parseStepCache(cacheJson({ proposal: null, partial: null }))).toMatchObject({ proposal: null, partial: null });
    const sample = { sample: 0, purpose: 'propose_fix', promptHash: 'h', result: { text: '', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 }, model: 'm', stopReason: 'tool_use', latencyMs: 1 } };
    expect(parseStepCache(cacheJson({ llmRound: { goalId: 'g1', round: 0, arrived: [sample as never] } }))?.llmRound).toMatchObject({ goalId: 'g1', round: 0 });
    expect(parseStepCache(cacheJson({ llmRound: { goalId: null, round: 2, arrived: [] } }))?.llmRound).toMatchObject({ goalId: null, round: 2 });
    expect(parseStepCache({ ...(cacheJson() as Record<string, Json>), v: 2 })).toBeNull();
    expect(parseStepCache({ ...(cacheJson() as Record<string, Json>), step: 0 })).toBeNull();
    expect(parseStepCache({ ...(cacheJson() as Record<string, Json>), stage: 'nope' })).toBeNull();
    expect(parseStepCache({ ...(cacheJson() as Record<string, Json>), proposal: { action: 'edit' } })).toBeNull();
    expect(parseStepCache({ ...(cacheJson() as Record<string, Json>), targets: [{ rel: 1 }] })).toBeNull();
    expect(parseStepCache({ ...(cacheJson() as Record<string, Json>), llmRound: { goalId: 'g1', round: 0, arrived: [{ sample: 'x' }] } })).toBeNull();
    expect(parseStepCache({ ...(cacheJson() as Record<string, Json>), llmRound: { goalId: 7, round: 0, arrived: [] } })).toBeNull();
    // the intent block is copied into the draft (and from there into state.json), so every field it names is typed
    expect(parseStepCache({ ...(cacheJson() as Record<string, Json>), intent: { intent: 'fix', answer: 'fix', verdict: 'jev', probability: 'high', confidence: 1, pairedNoul: 1, planStillValid: 1 } })).toBeNull();
    expect(parseStepCache({ ...(cacheJson() as Record<string, Json>), intent: null })).toMatchObject({ intent: null });
    expect(parseStepCache({ ...(cacheJson() as Record<string, Json>), resumes: -1 })).toBeNull();
    expect(parseStepCache({ ...(cacheJson() as Record<string, Json>), resumes: null })).toBeNull();
    expect(parseStepCache('text')).toBeNull();
    expect(parseStepCache(null)).toBeNull();
  });

  it('proposalPaths: edit / write name the path, a patch its headers (a/ b/ stripped, /dev/null skipped), run / read / done none', () => {
    expect(proposalPaths({ kind: 'edit', path: 'src/a.py', old: 'a', new: 'b' })).toEqual(['src/a.py']);
    expect(proposalPaths({ kind: 'write', path: 'new.txt', content: '' })).toEqual(['new.txt']);
    expect(proposalPaths({ kind: 'patch', diff: '--- a/src/a.py\n+++ b/src/a.py\n@@ -1 +1 @@\n-x\n+y\n--- /dev/null\n+++ b/src/new.py\n@@ -0,0 +1 @@\n+z\n' })).toEqual(['src/a.py', 'src/new.py']);
    expect(proposalPaths({ kind: 'run', command: 'pytest' })).toEqual([]);
    expect(proposalPaths({ kind: 'read', paths: ['x'] })).toEqual([]);
    expect(proposalPaths({ kind: 'done', summary: '' })).toEqual([]);
  });

  it('promptHashOf is the generator row hash: same prompt → same key, a different message → a different key', () => {
    const a = promptHashOf({ system: 's', messages: [{ role: 'user', content: 'x' }] });
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(promptHashOf({ system: 's', messages: [{ role: 'user', content: 'x' }] })).toBe(a);
    expect(promptHashOf({ system: 's', messages: [{ role: 'user', content: 'y' }] })).not.toBe(a);
  });
});

describe('the hash gate', () => {
  it('hashTargets: sha256 of a regular file, null for a missing path, a symlink, an escaping path; verifyTargets compares', () =>
    withTempDir(async (dir) => {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src/a.py'), 'return 1\n');
      await symlink(join(dir, 'src/a.py'), join(dir, 'link.py'));
      const now = await hashTargets(dir, ['src/a.py', 'missing.py', 'link.py', '../escape.py', '/abs.py']);
      expect(now).toEqual({ 'src/a.py': sha256Hex('return 1\n'), 'missing.py': null, 'link.py': null, '../escape.py': null, '/abs.py': null });
      expect(await verifyTargets(dir, now)).toEqual({ ok: true, changed: [] });
      expect(await verifyTargets(dir, {})).toEqual({ ok: true, changed: [] });
      await writeFile(join(dir, 'src/a.py'), 'return 2\n');
      expect(await verifyTargets(dir, now)).toEqual({ ok: false, changed: ['src/a.py'] });
      // a file that appeared where the pause saw none is a change too
      await writeFile(join(dir, 'missing.py'), '');
      expect((await verifyTargets(dir, now)).changed).toEqual(['src/a.py', 'missing.py']);
    }));
});

describe('the resume card (data, not rendering)', () => {
  const point: PausePoint = { step: 3, round: null, phase: 'risk', reason: 'now', resumableAt: 'cache/step-3.json', replayable: true, by: 'self', end: false };
  const paused = makeState({
    step: 2,
    stopReason: 'human_pause',
    interrupted: { step: 3, stage: 'risk', proposal: makeProposal({ action: { kind: 'edit', path: 'src/a.py', old: 'a', new: 'b' } }) },
    interruptedDetail: { cache: 'cache/step-3.json', resumes: 0, at: '2026-09-21T11:58:00.000Z', targetsSha: { 'src/a.py': 'ab'.repeat(32) }, replayable: true, partialChars: 120 },
    pausePoint: point,
    pendingDirectives: [{ text: 'then run tests', at: '2026-09-21T12:00:00.000Z', index: 0 }],
    updatedAt: '2026-09-21T12:00:00.000Z',
  });

  it('a paused run: what was in flight, the pending steers, [r] only when the state says replayable AND the check passed', () => {
    const nowMs = Date.parse('2026-09-21T12:42:00.000Z');
    const unchecked = buildResumeCard({ state: paused, meta: makeMeta({ title: 'fix store rotation' }), nowMs });
    expect(unchecked).toMatchObject({
      kind: 'paused',
      title: 'fix store rotation',
      stopReason: 'human_pause',
      agoMs: 42 * 60_000,
      needsForce: false,
      step: { committed: 2, next: 3 },
      point,
      inFlight: { step: 3, phase: 'risk', reason: 'now', proposal: { kind: 'edit', summary: 'edit src/a.py' }, partialChars: 120, round: null, arrivedSamples: 0, llm: null, pane: null },
      replay: { possible: false, cache: 'cache/step-3.json', reason: 'targets not verified yet', changedTargets: [] },
      pendingSteers: 1,
      resumes: 0,
    });
    const ok = buildResumeCard({ state: paused, meta: makeMeta(), targetsCheck: { ok: true, changed: [] } });
    expect(ok.replay).toEqual({ possible: true, cache: 'cache/step-3.json', reason: '', changedTargets: [] });
    expect(ok.agoMs).toBeNull();
    const changed = buildResumeCard({ state: paused, meta: makeMeta(), targetsCheck: { ok: false, changed: ['src/a.py'] } });
    expect(changed.replay).toEqual({ possible: false, cache: 'cache/step-3.json', reason: 'targets changed since the proposal (src/a.py) — replay unavailable', changedTargets: ['src/a.py'] });
    // §7.2 step 2: a cache file from another attempt is refused even when the state still points at that name
    const other = parseStepCache(cacheJson({ step: 3, resumes: 0, at: '2026-09-21T10:00:00.000Z' }));
    const mismatched = buildResumeCard({ state: paused, meta: makeMeta(), cache: other, targetsCheck: { ok: true, changed: [] } });
    expect(mismatched.replay).toMatchObject({ possible: false, reason: 'cache/step-3.json belongs to another attempt (written 2026-09-21T10:00:00.000Z, the state names 2026-09-21T11:58:00.000Z) — replay unavailable' });
    const matching = parseStepCache(cacheJson({ step: 3, resumes: 0, at: '2026-09-21T11:58:00.000Z' }));
    expect(buildResumeCard({ state: paused, meta: makeMeta(), cache: matching, targetsCheck: { ok: true, changed: [] } }).replay.possible).toBe(true);
    // D1 (§7.3 step 4): a detail stamped for an earlier resume is dead — the step already ran fresh once
    const stale = buildResumeCard({ state: { ...paused, resumes: 1 }, meta: makeMeta(), targetsCheck: { ok: true, changed: [] } });
    expect(stale.replay).toEqual({ possible: false, cache: 'cache/step-3.json', reason: 'the paused proposal was already superseded by a fresh resume (stamped for resume 0, this is 1) — replay unavailable', changedTargets: [] });
  });

  it('a boundary pause, an ended run (needs --force), a crash and a complete run', () => {
    const boundary = makeState({ step: 5, stopReason: 'human_pause', pausePoint: { step: 6, round: null, phase: 'idle', reason: 'step', resumableAt: 'boundary', replayable: false, by: 'self', end: false } });
    expect(buildResumeCard({ state: boundary, meta: makeMeta() })).toMatchObject({ kind: 'paused', step: { committed: 5, next: 6 }, inFlight: { step: 6, phase: 'idle', reason: 'step', proposal: null }, replay: { possible: false, reason: 'nothing to replay: the resume is a fresh step at intent' } });
    const ended = buildResumeCard({ state: boundary, meta: makeMeta({ ended: { at: '2026-09-21T12:00:00.000Z', by: 'remote' } }) });
    expect(ended).toMatchObject({ kind: 'ended', needsForce: true, ended: { by: 'remote' } });
    const crashed = buildResumeCard({ state: makeState({ step: 7, stopReason: null, interrupted: { step: 8, stage: 'propose', proposal: null } }), meta: makeMeta() });
    expect(crashed).toMatchObject({ kind: 'crashed', step: { committed: 7, next: 8 }, inFlight: { step: 8, phase: 'propose', reason: 'crash', proposal: null }, point: null });
    const complete = buildResumeCard({ state: makeState({ step: 9, stopReason: 'complete' }), meta: makeMeta() });
    expect(complete).toMatchObject({ kind: 'complete', needsForce: true, inFlight: null });
    const notReplayable = buildResumeCard({ state: makeState({ step: 1, stopReason: 'human_pause', interrupted: { step: 2, stage: 'propose', proposal: null }, interruptedDetail: { cache: 'cache/step-2.json', resumes: 0, at: '2026-09-21T12:00:00.000Z', targetsSha: {}, replayable: false, partialChars: 40 } }), meta: makeMeta() });
    expect(notReplayable.replay).toMatchObject({ possible: false, cache: 'cache/step-2.json', reason: 'nothing to replay: no proposal or sample had arrived when the run paused' });
  });

  it('an llm-jev mid-round pause reads the round and the arrived samples from the cache file', () => {
    const state = makeState({ mode: 'llm-jev', step: 0, stopReason: 'human_pause', interrupted: { step: 1, stage: 'propose', proposal: null }, interruptedDetail: { cache: 'cache/step-1.json', resumes: 0, at: '2026-09-21T12:00:00.000Z', targetsSha: {}, replayable: true, partialChars: 0 }, pausePoint: { step: 1, round: 2, phase: 'propose', reason: 'now', resumableAt: 'cache/step-1.json', replayable: true, llm: { goalId: 'g1', round: 2, arrived: [0, 1] }, by: 'peer:rpywkq2v', end: false } });
    const sample = { sample: 0, purpose: 'propose_fix', promptHash: 'h', result: { text: '', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 }, model: 'm', stopReason: 'tool_use', latencyMs: 1 } };
    const cache = parseStepCache(cacheJson({ step: 1, stage: 'propose', proposal: null, targets: [], llmRound: { goalId: 'g1', round: 2, arrived: [sample as never, { ...sample, sample: 1 } as never] } }));
    const card = buildResumeCard({ state, meta: makeMeta({ mode: 'llm-jev' }), cache, targetsCheck: { ok: true, changed: [] } });
    // the typed round (D4): the goal, its round and the sample ids — no free-text synth phase
    expect(card.inFlight).toMatchObject({ step: 1, phase: 'propose', reason: 'now', round: 2, arrivedSamples: 2, llm: { goalId: 'g1', round: 2, arrived: [0, 1] }, partialChars: 0 });
    expect(card.replay.possible).toBe(true);
    // a cache whose round names no goal still reports the round; `llm` stays null
    const noGoal = parseStepCache(cacheJson({ step: 1, stage: 'propose', proposal: null, targets: [], llmRound: { goalId: null, round: 0, arrived: [sample as never] } }));
    const { pausePoint: _dropped, ...pointless } = state;
    void _dropped;
    const plain = buildResumeCard({ state: pointless, meta: makeMeta({ mode: 'llm-jev' }), cache: noGoal, targetsCheck: { ok: true, changed: [] } });
    expect(plain.inFlight).toMatchObject({ round: 0, arrivedSamples: 1, llm: null });
  });
});

describe('checkpoint envelope: version unchanged, the new fields optional', () => {
  it('a state with interruptedDetail / pausePoint / compactions round-trips at version 1; a state without them parses; the fold drops the detail with interrupted', () => {
    expect(CHECKPOINT_VERSION).toBe(1);
    const full: CheckpointState = makeState({
      step: 2,
      stopReason: 'human_pause',
      interrupted: { step: 3, stage: 'propose', proposal: null },
      interruptedDetail: { cache: 'cache/step-3.json', resumes: 1, at: '2026-09-21T12:00:00.000Z', targetsSha: { 'src/a.py': null }, replayable: false, partialChars: 12, relocate: { slug: 'fix-store', reason: 'lease-conflict' } },
      pausePoint: { step: 3, round: 1, phase: 'propose', reason: 'now', resumableAt: 'cache/step-3.json', replayable: false, llm: { goalId: 'g1', round: 1, arrived: [0] }, by: 'device:mbp', end: true },
      lastPromptChars: 4_210,
      compactions: 2,
      lastCompactionAt: '2026-09-21T12:00:00.000Z',
    });
    const text = serialiseEnvelope(full, identity);
    expect(text.startsWith('{"version":1,')).toBe(true);
    const parsed = parseEnvelope(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.state).toEqual(full);
    const bare = makeState();
    expect(isCheckpointState(bare)).toBe(true);
    expect(parseEnvelope(serialiseEnvelope(bare, identity)).ok).toBe(true);
    // the fold: a committed row at or past the interrupted step drops `interrupted` and `interruptedDetail` together; otherwise both stay
    const folded = foldStepsIntoState(full, [makeStepRecord(3)], '2026-09-21T13:00:00.000Z');
    expect(folded.interrupted).toBeNull();
    expect(folded.interruptedDetail).toBeUndefined();
    // D11: the point named step 3 and step 3 committed after it — it is stale, like the detail
    expect(folded.pausePoint).toBeUndefined();
    expect(folded.lastPromptChars).toBe(4_210);
    // a boundary point (step = committed + 1) survives the fold: nothing committed past it
    const boundaryState = makeState({ step: 2, stopReason: 'human_pause', pausePoint: { step: 4, round: null, phase: 'idle', reason: 'step', resumableAt: 'boundary', replayable: false, by: 'self', end: false } });
    expect(foldStepsIntoState(boundaryState, [makeStepRecord(3)], '2026-09-21T13:00:00.000Z').pausePoint).toEqual(boundaryState.pausePoint);
    const kept = foldStepsIntoState(full, [], '2026-09-21T13:00:00.000Z');
    expect(kept.interrupted).toEqual(full.interrupted);
    expect(kept.interruptedDetail).toEqual(full.interruptedDetail);
  });
});
