/**
 * AGENT-LOOP-DESIGN §9.4 / §12 (slice S5a): a review raised by the agent's rule classifier (`--autonomy review` only —
 * under full autonomy nothing asks, §A2). `RiskAssessment.rule` is set and the dims are zeroed, so the card's title is the
 * rule sentence and the band shows the rule and the action instead of four gauges of zeros; every rung keeps its rows.
 */
import { describe, expect, it } from 'vitest';
import type { ConfirmRequest } from '../../../../src/core/types.js';
import { stringWidth } from '../../../../src/tui/composer/width.js';
import { isRuleConfirm, reviewCardLines, reviewCardTitle, reviewHeaderLines, reviewScreenReaderLines, reviewTitle, reviewWhyRefusal, ruleSentence } from '../../../../src/tui/review/lines.js';
import { mkConfirmRequest } from '../../../fixtures/tui/fixtures.js';

function ruleReq(): ConfirmRequest {
  const base = mkConfirmRequest('c9', 4, { kind: 'run', command: 'git reset --hard HEAD~1' });
  const zero = { risk: 0, probability: 0, expected: 0, tailMass: 0, bound: 'expected' as const, confidence: 0, level: 0 };
  return { ...base, risk: { dims: { destructive: zero, out_of_scope: zero, plan_mismatch: zero, irreversible: zero }, risk: 0, verdict: 'review', reason: 'git reset --hard discards uncommitted changes', rule: 'git_discard' } };
}

describe('the rule-verdict review card', () => {
  it('is recognised by `RiskAssessment.rule`; a Jev / code verdict is not', () => {
    expect(isRuleConfirm(ruleReq())).toBe(true);
    expect(isRuleConfirm(mkConfirmRequest())).toBe(false);
    expect(ruleSentence(ruleReq())).toBe('git reset --hard discards uncommitted changes');
  });

  it('the title is the rule sentence, in both the card and the flat header', () => {
    expect(reviewCardTitle(ruleReq(), 100)).toBe('review · step 4 · git reset --hard discards uncommitted changes');
    expect(reviewTitle(ruleReq(), 100)).toBe('review · step 4 · git reset --hard discards uncommitted changes');
    expect(reviewCardTitle(ruleReq(), 100)).not.toMatch(/risk 0\.00/);
  });

  it('no dimension row is drawn at any rung, and every rung keeps the row count of the gauge form', () => {
    for (const n of [3, 4, 5, 6, 7, 8, 9]) {
      const card = reviewCardLines(ruleReq(), n, 2, 80);
      const jev = reviewCardLines(mkConfirmRequest('c9', 4, { kind: 'run', command: 'git reset --hard HEAD~1' }), n, 2, 80);
      expect(card.length, `n=${n}`).toBe(jev.length);
      const text = card.join('\n');
      expect(text, `n=${n}`).not.toMatch(/destructive|out_of_scope|plan_mismatch|irreversible|matches_intent/);
      for (const row of card) expect(stringWidth(row)).toBe(80);
      if (n >= 5) {
        expect(text).toContain('rule git_discard');
        expect(text).toContain('$ git reset --hard HEAD~1');
      }
    }
    for (const n of [2, 5, 6, 7, 8]) {
      const flat = reviewHeaderLines(ruleReq(), n, 80);
      expect(flat.length).toBe(reviewHeaderLines(mkConfirmRequest(), n, 80).length);
      expect(flat.join('\n')).not.toMatch(/destructive|irreversible/);
    }
  });

  it('`review:why` refuses (there are no dimensions to explain) and the screen reader speaks the rule, not the zeros', () => {
    expect(reviewWhyRefusal(ruleReq())).toMatch(/^no risk dimensions on this card — rule git_discard decided it/);
    expect(reviewWhyRefusal(mkConfirmRequest())).toBeNull();
    const sr = reviewScreenReaderLines(ruleReq()).join('\n');
    expect(sr).toContain('rule git_discard');
    expect(sr).not.toMatch(/destructive level/);
  });
});
