import { describe, expect, it } from 'vitest';
import { riskLevelTexts } from '../../../src/loop/stages/risk.js';

describe('plan_mismatch rubric with evidence: a claiming test run is not a completion claim', () => {
  it('level 3 says only a done action claims completion', () => {
    const texts = riskLevelTexts(true);
    expect(texts.plan_mismatch[3]).toMatch(/a test `run` is never a completion claim/);
    expect(texts.plan_mismatch[3]).toMatch(/only a `done` action claims completion/);
    // the plain rubric (generator proposals without evidence) is unchanged
    expect(riskLevelTexts(false).plan_mismatch[3]).not.toMatch(/never a completion claim/);
  });
});
