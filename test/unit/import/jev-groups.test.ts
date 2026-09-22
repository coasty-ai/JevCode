/**
 * §4.4.3 groups III (`same_meaning`), IV (`matters_here`) and V (`contradicts`) **on the real
 * path**.
 *
 * The three builders existed, were unit-tested and were re-exported — and nothing ever called
 * them. `planImport` batched only groups I and II, and `buildPlan` is pure so it cannot ask; it
 * only ever *read* `same_meaning_<i>` / `rank_<i>` / `contradicts_<i>` out of an `answers` map
 * that nobody filled. The engine therefore behaved exactly as `--no-jev` for those three groups.
 *
 * No test caught it because the omission is invisible from the safe side: §0 principle 4 makes
 * every abstention conservative — uncertain duplicate → keep both, uncertain conflict → review,
 * and group IV only ever *orders* the index, never drops a note. A missing question and a
 * refused answer produce the same plan. That is exactly why it needs a test that asserts the
 * question was ASKED, not merely that the plan is sane.
 *
 * The question-id contract these pin, which the TUI also depends on. Review follow-up D2 made
 * the ids **content-keyed rather than ordinal**, because the plan is built twice: the second
 * pass runs after the duplicate folds the first pass's own answers caused, so an ordinal list
 * is shorter the second time and every entry after a fold silently took its neighbour's answer.
 *
 *   `same_meaning_<aItemId>_<bItemId>`  → that dedupe pair          (`sameMeaningId`)
 *   `rank_<planRowId>`                  → that memory-topic row     (`rankId`)
 *   `contradicts_<aItemId>_<bItemId>`   → that conflict pair        (`contradictsId`)
 *
 * All three helpers are exported from `src/import/index.ts`; item and row ids derive from the
 * source and the destination, never from position, so the ids are stable across passes and
 * across runs of the same corpus.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { nodeImportFs, planImport, renderPlanJson } from '../../../src/import/index.js';
import type { ImportClock, ImportEnvironment } from '../../../src/import/index.js';
import type { Answer, Decider, Json, Question } from '../../../src/core/types.js';

const clock: ImportClock = { now: () => new Date('2026-09-21T12:00:00.000Z'), monotonicMs: () => 0 };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface Capture {
  bodies: string[];
  ids: string[];
  decider: Decider;
}

/** Answers every `same_meaning_*` Noul 0.95 (“the same thing”), everything else abstains-safe. */
function capturingDecider(noulP = 0.95): Capture {
  const bodies: string[] = [];
  const ids: string[] = [];
  const decider: Decider = {
    model: 'jev-capture',
    provider: 'openrouter',
    ask: async (state: Json, questions: Record<string, Question>) => {
      bodies.push(JSON.stringify({ state, questions }));
      ids.push(...Object.keys(questions));
      const answers: Record<string, Answer> = {};
      for (const [id, q] of Object.entries(questions)) {
        if (q.type === 'noul') answers[id] = { type: 'noul', noul: id.startsWith('same_meaning_') ? noulP : 0 };
      }
      return { answers, usage: { inputTokens: 10, outputTokens: 0, costUsd: 0.0001, calls: 1 }, latencyMs: 1, model: 'jev-capture', requestHash: 'h', attempts: 1, id: null };
    },
  };
  return { bodies, ids, decider };
}

/** Two notes with a deliberate Jaccard inside the [0.6, 0.9) band: mostly shared, clearly not identical. */
async function nearDuplicates(): Promise<ImportEnvironment> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'jev-groups-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const ws = join(root, 'repo');
  const home = join(root, 'home');
  await mkdir(ws, { recursive: true });
  const mem = join(home, '.claude', 'projects', '-repo', 'memory');
  await mkdir(mem, { recursive: true });

  const shared = [
    'The workspace is verified with the unit suite before any claim of completion.',
    'Patches are kept small and each one is explained in a single sentence.',
    'Secrets never reach the transcript, the report or the plan artefact.',
    'Rules under the source directory apply to every step of the run.',
  ].join('\n');
  await writeFile(join(mem, 'conventions-a.md'), `---\nname: conventions-a\ndescription: house conventions\nmetadata:\n  type: project\n---\n# House conventions\n\n${shared}\nThe first copy adds one closing remark about review order.\n`);
  await writeFile(join(mem, 'conventions-b.md'), `---\nname: conventions-b\ndescription: house conventions again\nmetadata:\n  type: project\n---\n# House conventions\n\n${shared}\nThe second copy instead mentions branch naming and nothing else.\n`);

  return { home, env: {}, platform: process.platform, workspace: ws, gitRoot: ws, extraRoots: [] };
}

describe('§4.4.3 groups III–V reach Jev on the real path', () => {
  it('a near-duplicate pair answered “same meaning” folds to one row carrying a `same as` note', async () => {
    const env = await nearDuplicates();
    const cap = capturingDecider(0.95);
    const plan = await planImport({ env, fs: nodeImportFs(), clock, jevcodeVersion: '0.3.0', trust: 'trust', decider: cap.decider });

    // the question was actually asked — the half that abstention makes invisible
    expect(cap.ids.some((id) => id.startsWith('same_meaning_')), `no same_meaning question was asked; ids: ${cap.ids.join(',')}`).toBe(true);

    const notes = plan.rows.filter((r) => r.source.display.includes('conventions-'));
    expect(notes, 'the pair folded into a single row').toHaveLength(1);
    expect(notes[0]?.warnings.join(' ')).toMatch(/same as .*conventions-/);
    expect(notes[0]?.warnings.join(' ')).toMatch(/jev same_meaning_[0-9a-f]+_[0-9a-f]+ p=0\.95/);
  });

  it('the group III payload carries the headings the sample permits, and never a body', async () => {
    const env = await nearDuplicates();
    const cap = capturingDecider();
    await planImport({ env, fs: nodeImportFs(), clock, jevcodeVersion: '0.3.0', trust: 'trust', decider: cap.decider, jevSample: 'headings' });
    const body = cap.bodies.join('\n');
    expect(body).toContain('House conventions');
    // …and no sentence of either body ever travels
    expect(body).not.toContain('branch naming');
    expect(body).not.toContain('closing remark about review order');
  });

  it('--jev-sample=none withholds the heading payload but still asks the pair', async () => {
    const env = await nearDuplicates();
    const cap = capturingDecider();
    await planImport({ env, fs: nodeImportFs(), clock, jevcodeVersion: '0.3.0', trust: 'trust', decider: cap.decider, jevSample: 'none' });
    expect(cap.ids.some((id) => id.startsWith('same_meaning_'))).toBe(true);
    expect(cap.bodies.join('\n')).not.toContain('House conventions');
  });

  it('--no-jev keeps both copies and asks nothing — the conservative side of §0 principle 4', async () => {
    const env = await nearDuplicates();
    const plan = await planImport({ env, fs: nodeImportFs(), clock, jevcodeVersion: '0.3.0', trust: 'trust', decider: null });
    expect(plan.jev.requests).toBe(0);
    const notes = plan.rows.filter((r) => r.source.display.includes('conventions-'));
    expect(notes, 'uncertain duplicate ⇒ keep both').toHaveLength(2);
    for (const r of notes) expect(r.warnings.join(' ')).not.toMatch(/same as/);
  });

  it('the plan carries Jev COUNTERS only — the answer map never reaches plan.json (D3)', async () => {
    const env = await nearDuplicates();
    const cap = capturingDecider(0.95);
    const plan = await planImport({ env, fs: nodeImportFs(), clock, jevcodeVersion: '0.3.0', trust: 'trust', decider: cap.decider });
    expect(Object.keys(plan.jev).sort()).toEqual(['fallbacks', 'questions', 'requests', 'usd']);
    const json = renderPlanJson(plan);
    expect(json).not.toContain('"answers"');
    // the answer OBJECTS are what must not be there; a `why`/`warning` that cites the question
    // id is provenance and is meant to be there (§4.6.1's `why` examples do exactly that), so
    // assert on the serialised Answer shape rather than on the id text
    expect(json).not.toContain('"noul":');
    expect(json).not.toContain('"probabilities"');

    // …and on the path that does NOT re-plan (a refusal: no answers, so no row changes) the
    // metadata is still merged onto the first plan, which is where the leak used to be
    const refusing: Decider = { model: 'x', provider: 'openrouter', ask: async () => { throw new Error('HTTP 429'); } };
    const refused = await planImport({ env, fs: nodeImportFs(), clock, jevcodeVersion: '0.3.0', trust: 'trust', decider: refusing });
    expect(Object.keys(refused.jev).sort()).toEqual(['fallbacks', 'questions', 'reason', 'requests', 'usd']);
    expect(renderPlanJson(refused)).not.toContain('"answers"');
  });

  it('a refusing Jev is indistinguishable from --no-jev in its effect, and never throws', async () => {
    const env = await nearDuplicates();
    const refusing: Decider = {
      model: 'jev-429',
      provider: 'openrouter',
      ask: async () => {
        throw new Error('HTTP 429');
      },
    };
    const plan = await planImport({ env, fs: nodeImportFs(), clock, jevcodeVersion: '0.3.0', trust: 'trust', decider: refusing });
    expect(plan.rows.filter((r) => r.source.display.includes('conventions-'))).toHaveLength(2);
    expect(plan.jev.reason ?? '').not.toBe('');
  });
});
