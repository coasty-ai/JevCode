import { describe, expect, it } from 'vitest';
import type { Decision } from '../../../src/core/types.js';
import { GLYPHS } from '../../../src/tui/glyphs.js';
import { WHY_MAX_LINES, findDecision, parseWhyRef, stepWhyBlocks, whyBlock, whyHead, whyRef } from '../../../src/tui/why.js';
import { mkDecision } from '../../fixtures/tui/fixtures.js';
import { stepSevenDecisions } from './pane/helpers.js';

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
  it.each(['', 'foo', '6', '0', 'nostage.x', 's7.risk', 's7..x', 'risk.', 'sx.risk.y'])('%j does not parse', (text) => {
    expect(parseWhyRef(text)).toBeNull();
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
