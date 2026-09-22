import { describe, expect, it } from 'vitest';
import type { Answer, Decision } from '../../../src/core/types.js';
import { GLYPHS, cellWidth } from '../../../src/tui/glyphs.js';
import { WHY_KEPT_STEPS, WHY_MAX_LINES, findDecision, findIntakeDecision, intakeConsumedBy, parseWhyRef, stepWhyBlocks, whyBlock, whyErrorText, whyHead, whyRef } from '../../../src/tui/why.js';
import { INTAKE_KINDS, answersOfRows, buildAllIntakeQuestions, decisionRows, resolveIntake } from '../../../src/chat/intake.js';
import { annotateChoiceRows } from '../../../src/loop/stages/choose.js';
import { harnessFacts } from '../../../src/chat/facts.js';
import { ESCAPE_KEY } from '../../../src/jev/questions.js';
import { mkDecision } from '../../fixtures/tui/fixtures.js';
import { keyedFixture } from '../chat/facts.test.js';
import { stepSevenDecisions } from './pane/helpers.js';

/** TUI-DESIGN-2 §3.11: the step-0 `intent` rows of one intake (the Choice, five paired Nouls, the reply Choice, 14 fact Nouls) */
function intakeRows(kind: string, p: number, paired: number): Decision[] {
  const questions = buildAllIntakeQuestions(harnessFacts(keyedFixture()));
  const answers: Record<string, Answer> = {};
  const keys = [...INTAKE_KINDS, ESCAPE_KEY];
  for (const [id, q] of Object.entries(questions)) {
    if (id === 'intake') answers[id] = { type: 'choice', choice: kind, probabilities: Object.fromEntries(keys.map((k) => [k, k === kind ? p : (1 - p) / (keys.length - 1)])), confidence: 0.7 };
    else if (id === 'reply' && q.type === 'choice') answers[id] = { type: 'choice', choice: 'hello_first', probabilities: Object.fromEntries(Object.keys(q.criteria).map((k) => [k, k === 'hello_first' ? 0.9 : 0.01])), confidence: 0.8 };
    else if (id.startsWith('can_')) answers[id] = { type: 'noul', noul: id === `can_${kind}` ? paired : 0.1 };
    else answers[id] = { type: 'noul', noul: id === 'about_mode_now' ? 0.8 : 0.1 };
  }
  const rows = decisionRows(questions, answers, 118, 'a1b2c3d4e5f6', 'jev-1.13.0', 'jev-1.13.0');
  // what `runIntake` does after the request: the Choice row carries the resolution's verdict
  const r = resolveIntake(answersOfRows(rows));
  annotateChoiceRows(rows, 'intake', { option: r.kind, verdict: r.verdict, answer: r.answer, probability: r.probability, pairedNoul: r.pairedNoul });
  return rows;
}

describe('whyErrorText (TUI-DESIGN-3 §4.4 F8 / §10): one failure text for the App and the controller', () => {
  it('TUI-DESIGN-4 §3.1.7: both texts take the one error shape `error: /why <ref> — <what> — <what to do>`; the ref is trimmed', () => {
    expect(whyErrorText('s7.risk.plan_mismatch', 'missing')).toBe('error: /why s7.risk.plan_mismatch — no decision s7.risk.plan_mismatch in the last 3 steps — /decisions lists the recent ones');
    expect(whyErrorText(' 3 ', 'missing')).toBe('error: /why 3 — no decision 3 in the last 3 steps — /decisions lists the recent ones');
    expect(whyErrorText('intake.nope', 'missing')).toBe('error: /why intake.nope — no decision intake.nope in the last 3 steps — /decisions lists the recent ones');
    expect(whyErrorText('foo', 'grammar')).toBe('error: /why foo — not a decision ref — use s<N>.<stage>.<id>, a digit 1–5, or intake');
    expect(whyErrorText('intake.Nope', 'grammar')).toBe('error: /why intake.Nope — not a decision ref — use s<N>.<stage>.<id>, a digit 1–5, or intake');
    expect(WHY_KEPT_STEPS).toBe(3);
    // the two texts never depend on the renderer: a grammar failure is exactly what parseWhyRef rejects
    for (const ref of ['foo', '6', 's7.risk', 'intake.']) {
      expect(parseWhyRef(ref)).toBeNull();
      // §3.1.7's shape, asserted as a shape: `error: /<command> <arg> — <what went wrong> — <what to do instead>`
      expect(whyErrorText(ref, 'grammar')).toMatch(/^error: \/why \S+ — [^—]+ — .+$/);
      expect(whyErrorText(ref, 'missing')).toMatch(/^error: \/why \S+ — [^—]+ — .+$/);
    }
  });
});

describe('ref grammar (TUI-DESIGN §7.6)', () => {
  it.each([
    ['s7.risk.plan_mismatch', { kind: 'ref', step: 7, stage: 'risk', id: 'plan_mismatch' }],
    ['risk.plan_mismatch', { kind: 'ref', step: null, stage: 'risk', id: 'plan_mismatch' }],
    ['s12.context.src/a.py', { kind: 'ref', step: 12, stage: 'context', id: 'src/a.py' }],
    [' 3 ', { kind: 'digit', digit: 3 }],
    ['5', { kind: 'digit', digit: 5 }],
  ])('%j parses', (text, expected) => {
    expect(parseWhyRef(text)).toEqual(expected);
  });
  it.each(['', 'foo', '6', '0', 'nostage.x', 's7.risk', 's7..x', 'risk.', 'sx.risk.y', 'intake.', 'intake.Reply', 'intake..reply', 'intakes'])('%j does not parse', (text) => {
    expect(parseWhyRef(text)).toBeNull();
  });
  it.each([
    ['intake', { kind: 'intake', id: 'intake' }],
    ['intake.reply', { kind: 'intake', id: 'reply' }],
    [' intake.about_mode_now ', { kind: 'intake', id: 'about_mode_now' }],
    ['intake.can_coding_task', { kind: 'intake', id: 'can_coding_task' }],
  ])('TUI-DESIGN-2 §3.11: %j parses as an intake ref', (text, expected) => {
    expect(parseWhyRef(text)).toEqual(expected);
  });
  it('whyRef round-trips and findDecision resolves refs and pane digits', () => {
    const decs = stepSevenDecisions();
    const pm = decs.find((d) => d.id === 'plan_mismatch')!;
    expect(whyRef(pm)).toBe('s7.risk.plan_mismatch');
    expect(findDecision(decs, parseWhyRef('s7.risk.plan_mismatch')!, null)).toBe(pm);
    expect(findDecision(decs, parseWhyRef('risk.plan_mismatch')!, 7)).toBe(pm);
    expect(findDecision(decs, parseWhyRef('risk.plan_mismatch')!, null)).toBeNull();
    expect(findDecision(decs, parseWhyRef('3')!, 7)).toBe(pm);
    expect(findDecision(decs, parseWhyRef('5')!, 7)?.id).toBe('matches_intent');
    expect(findDecision(decs, parseWhyRef('1')!, 7)).toBeNull();
    expect(findDecision(decs, parseWhyRef('3')!, null)).toBeNull();
    expect(findDecision(decs, parseWhyRef('s8.risk.plan_mismatch')!, 7)).toBeNull();
  });
});

describe('whyBlock shape', () => {
  it('head carries the ref, 8-char request hash, latency and model (servedModel wins over the context model)', () => {
    const decs = stepSevenDecisions();
    const pm = decs.find((d) => d.id === 'plan_mismatch')!;
    expect(whyHead(pm, { model: 'other' })).toBe('why s7.risk.plan_mismatch  request a1b2c3d4  244ms  typesafe/jev-1.13-20260917');
    const intent = decs[0]!;
    expect(whyHead(intent)).toBe('why s7.intent.intent  request a1b2c3d4  231ms');
    expect(whyHead(intent, { model: 'typesafe/jev-1.13' })).toBe('why s7.intent.intent  request a1b2c3d4  231ms  typesafe/jev-1.13');
    expect(whyHead(mkDecision({ latencyMs: Number.NaN }))).toContain('?ms');
  });
  it('body lines are indented two spaces and free of control characters', () => {
    const evil = mkDecision({ question: { type: 'noul', instructions: 'a\u001b[2Jb\nc', criteria: { true: 'x\ty', false: 'z' } } });
    const block = whyBlock(evil);
    for (const l of block.slice(1)) {
      expect(l.startsWith('  ')).toBe(true);
      expect(l).not.toMatch(/[\u0000-\u001f]/);
    }
    expect(block[1]).toBe('  a[2Jb c');
  });
  it('is capped at 60 lines with an omitted-lines marker', () => {
    const levels = Array.from({ length: 100 }, (_, i) => `level ${i}`);
    const probs: Record<string, number> = {};
    for (let i = 0; i < 100; i++) probs[String(i)] = i === 0 ? 1 : 0;
    const big: Decision = mkDecision({ question: { type: 'score', instructions: 'q', criteria: levels }, answer: { type: 'score', score: 0, legend: {}, probabilities: probs, confidence: 1 }, probability: 1, confidence: 1 });
    const block = whyBlock(big);
    expect(block.length).toBe(WHY_MAX_LINES);
    expect(block[WHY_MAX_LINES - 1]).toMatch(/^ {2}…\[\d+ lines omitted\]$/);
  });
  it('a context Noul without criteria says so', () => {
    const ctx = stepSevenDecisions().find((d) => d.stage === 'context')!;
    const block = whyBlock(ctx);
    expect(block[2]).toBe('  noul (context: the shared criteria.context of the request)');
    expect(block).toContain('  p=0.52  |2p−1|=0.04 (derived confidence)');
    expect(block).toContain('  consumed by: selected iff p ≥ 0.5');
  });
  it('the ascii twin uses ascii bars and operators, and every block is pure ASCII end to end', () => {
    const decs = stepSevenDecisions();
    const pm = decs.find((d) => d.id === 'plan_mismatch')!;
    const block = whyBlock(pm, {}, GLYPHS.ascii);
    expect(block[3]).toBe('  L0 ######2---  0.62  matches `intent` and the plan');
    expect(block[8]).toBe('  argmax L0 p=0.62  E[k]=0.56->0.14  P(k>=3)=0.04  bound=tail  risk=0.04 [ok]');
    expect(block[9]).toBe('  confidence = 1 - sum p_k-|k-k*| / U_5 = 1 - 0.56/1.2 = 0.53');
    expect(block[10]).toBe('  consumed by: risk band (review >= 0.30, block >= 0.70); wire two-decimal, noise sd ~= 0.02');
    const ascii = /^[\x20-\x7e]*$/;
    for (const d of decs) for (const l of whyBlock(d, { siblings: decs }, GLYPHS.ascii)) expect(l.replace(/…/g, '')).toMatch(ascii);
    for (const l of whyBlock(decs[0]!, { siblings: decs }, GLYPHS.ascii)) expect(l).toMatch(ascii);
    expect(whyBlock(decs.find((d) => d.id === 'task_complete')!, {}, GLYPHS.ascii).at(-1)).toBe('  consumed by: >= 0.85 -> stop');
    for (const l of stepWhyBlocks(decs, 7, GLYPHS.ascii).flat()) expect(l).toMatch(ascii);
  });
});

describe('TUI-DESIGN-4 §3.3: `/why` takes the block body width and hangs its continuations', () => {
  const long = (): Decision => {
    const decs = stepSevenDecisions();
    return decs.find((d) => d.id === 'plan_mismatch') as Decision;
  };

  it('width 0 (the default) is today\'s un-wrapped block — no caller is changed by the new parameter', () => {
    expect(whyBlock(long(), {}, GLYPHS.unicode, 0)).toEqual(whyBlock(long()));
  });

  it('every row fits the width at 30 / 50 / 70 / 110', () => {
    for (const width of [30, 50, 70, 110]) {
      // row 0 is the block HEAD (`session.ts` sends it as such); the BODY is what the width governs
      for (const line of whyBlock(long(), { siblings: stepSevenDecisions() }, GLYPHS.unicode, width).slice(1)) {
        expect(cellWidth(line), `${width}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it('an L-row continuation hangs UNDER the probability column, never at column 0 (§3.3)', () => {
    const rows = whyBlock(long(), { siblings: stepSevenDecisions() }, GLYPHS.unicode, 40);
    const wrapped = rows.filter((r) => /^ {6,}\S/.test(r));
    expect(wrapped.length).toBeGreaterThan(0);
    // no body row ever starts at column 0: the head is row 0 and every body row is indented at least two cells
    for (const r of rows.slice(1)) expect(r === '' || r.startsWith('  ')).toBe(true);
  });

  it('an L3 row\'s continuation starts at the SAME column as its criterion text (§3.3, the measured defect)', () => {
    const decs = stepSevenDecisions();
    const score = decs.find((d) => d.answer.type === 'score') as Decision;
    const rows = whyBlock(score, { siblings: decs }, GLYPHS.unicode, 50);
    const i = rows.findIndex((r) => /^ {2}L\d /.test(r) && rows[rows.indexOf(r) + 1]?.startsWith('     ') === true);
    expect(i, rows.join('|')).toBeGreaterThan(0);
    const first = rows[i] as string;
    const cont = rows[i + 1] as string;
    // the criterion text starts right after `L<k> <bar>  <p>  ` — the continuation hangs at exactly that column
    const prefix = /^( {2}L\d \S*\s{2}[01]\.\d{2}\s{2})/.exec(first)?.[1] ?? '';
    expect(prefix, JSON.stringify(first)).not.toBe('');
    expect(cont.startsWith(' '.repeat(cellWidth(prefix))), `${JSON.stringify(first)} / ${JSON.stringify(cont)}`).toBe(true);
    expect(cont.trimStart().length, JSON.stringify(cont)).toBeGreaterThan(0);
    // and never at column 4, under the level marker, where a continuation reads as a new criterion
    expect(/^ {4}\S/.test(cont)).toBe(false);
  });

  it('no row of the block carries a trailing space at any width (the App-local caller prints them verbatim)', () => {
    const decs = stepSevenDecisions();
    for (const width of [0, 24, 30, 40, 50, 70, 110]) {
      for (const d of decs) {
        for (const r of whyBlock(d, { siblings: decs }, GLYPHS.unicode, width)) {
          expect(r, `${width}: ${JSON.stringify(r)}`).not.toMatch(/ $/);
        }
      }
    }
  });

  it('the cap still applies after wrapping — a narrow width never grows the block past WHY_MAX_LINES', () => {
    const decs = stepSevenDecisions();
    for (const d of decs) expect(whyBlock(d, { siblings: decs }, GLYPHS.unicode, 24).length).toBeLessThanOrEqual(WHY_MAX_LINES);
  });
});

describe('TUI-DESIGN-2 §3.11: /why intake — the last intake\'s step-0 rows and their consumers', () => {
  it('findDecision resolves intake refs against step-0 intent rows only; an unknown id is null', () => {
    const rows = intakeRows('coding_task', 0.78, 0.9);
    expect(rows.length).toBe(1 + 5 + 1 + 14);
    expect(findDecision(rows, parseWhyRef('intake')!, null)?.id).toBe('intake');
    expect(findDecision(rows, parseWhyRef('intake.reply')!, 7)?.id).toBe('reply');
    expect(findIntakeDecision(rows, { kind: 'intake', id: 'about_mode_now' })?.id).toBe('about_mode_now');
    expect(findDecision(rows, parseWhyRef('intake.nope')!, null)).toBeNull();
    // a run's step-7 intent row is never an intake row
    expect(findDecision(stepSevenDecisions(), parseWhyRef('intake')!, 7)).toBeNull();
  });

  it('the standard block with the §3.11 consumers: `resolveChoice → run floor 0.60 → <kind>` (re-derived from the rows), `argmax → catalogue`, `≥ 0.5 → answer line`; paired Nouls keep the §7.1 `paired ≥ 0.5`', () => {
    const rows = intakeRows('coding_task', 0.78, 0.9);
    const by = (id: string): Decision => rows.find((d) => d.id === id)!;
    const intake = whyBlock(by('intake'), { siblings: rows, model: 'jev-1.13.0' });
    expect(intake[0]).toBe('why s0.intent.intake  request a1b2c3d4  118ms  jev-1.13.0');
    expect(intake.at(-1)).toBe('  consumed by: resolveChoice → run floor 0.60 → coding_task');
    expect(intake.some((l) => l.startsWith('  resolution: chosen'))).toBe(true);
    expect(whyBlock(by('reply'), { siblings: rows }).at(-1)).toBe('  consumed by: argmax → catalogue');
    expect(whyBlock(by('about_mode_now'), { siblings: rows }).at(-1)).toBe('  consumed by: ≥ 0.5 → answer line');
    expect(whyBlock(by('can_coding_task'), { siblings: rows }).at(-1)).toBe('  consumed by: paired ≥ 0.5');
    // a weak coding_task (p 0.55 < the 0.60 floor) re-derives to ambiguous
    const weak = intakeRows('coding_task', 0.55, 0.9);
    expect(whyBlock(weak.find((d) => d.id === 'intake')!, { siblings: weak }).at(-1)).toBe('  consumed by: resolveChoice → run floor 0.60 → ambiguous');
    expect(intakeConsumedBy(stepSevenDecisions()[0]!, [])).toBeNull();
    expect(intakeConsumedBy(by('can_coding_task'), rows)).toBeNull();
  });

  it('the ascii twin', () => {
    const rows = intakeRows('greeting_or_smalltalk', 0.9, 0.9);
    const by = (id: string): Decision => rows.find((d) => d.id === id)!;
    expect(whyBlock(by('intake'), { siblings: rows }, GLYPHS.ascii).at(-1)).toBe('  consumed by: resolveChoice -> run floor 0.60 -> greeting_or_smalltalk');
    expect(whyBlock(by('about_mode_now'), { siblings: rows }, GLYPHS.ascii).at(-1)).toBe('  consumed by: >= 0.5 -> answer line');
    expect(whyBlock(by('reply'), { siblings: rows }, GLYPHS.ascii).at(-1)).toBe('  consumed by: argmax -> catalogue');
  });
});

describe('stepWhyBlocks (Ctrl+O, §7.7)', () => {
  it('yields one block per stage in stage order with one row per decision', () => {
    const blocks = stepWhyBlocks(stepSevenDecisions(), 7);
    expect(blocks.map((b) => b[0])).toEqual(['why s7.intent  3 decisions', 'why s7.context  1 decision', 'why s7.risk  2 decisions', 'why s7.complete  1 decision']);
    expect(blocks[0]!.length).toBe(4);
    expect(blocks[0]![1]).toBe('  intent           ██████▍···  0.64  c 0.55   choice edit');
    expect(blocks[2]![1]).toBe('  plan_mismatch    ██████▎···  0.62  c 0.53   L0');
    expect(stepWhyBlocks(stepSevenDecisions(), 99)).toEqual([]);
    for (const l of stepWhyBlocks(stepSevenDecisions(), 7, GLYPHS.sr).flat()) expect(l).not.toContain('█');
  });
  it('caps a stage block at 60 lines', () => {
    const many: Decision[] = Array.from({ length: 200 }, (_, i) => mkDecision({ step: 4, stage: 'context', id: `file_${i}.py`, question: { type: 'noul', instructions: 'q' }, answer: { type: 'noul', noul: 0.5 }, probability: 0.5, confidence: 0 }));
    const blocks = stepWhyBlocks(many, 4);
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.length).toBe(WHY_MAX_LINES);
    expect(blocks[0]![0]).toBe('why s4.context  200 decisions');
  });
});
