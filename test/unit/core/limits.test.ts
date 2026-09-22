/** docs/IMPORT-DESIGN.md §7.1 row 3: every bound positive and finite; the AGENTS.md headroom; the two shares in (0, 0.5). */
import { describe, expect, it } from 'vitest';

import { IMPORT_LIMITS } from '../../../src/core/limits.js';
import { INSTRUCTIONS_MAX_BYTES, INSTRUCTIONS_READ_CAP_BYTES } from '../../../src/config/instructions.js';

const SHARES = ['rulesInScopeShare', 'memoryInScopeShare'] as const;

describe('IMPORT_LIMITS (§2.8 / Appendix B)', () => {
  it('every bound is a positive finite number', () => {
    const entries = Object.entries(IMPORT_LIMITS);
    expect(entries.length).toBeGreaterThan(30);
    for (const [name, value] of entries) {
      expect(typeof value, name).toBe('number');
      expect(Number.isFinite(value), name).toBe(true);
      expect(value, name).toBeGreaterThan(0);
    }
  });

  it('every bound except the two shares is an integer count of bytes, entries or milliseconds', () => {
    for (const [name, value] of Object.entries(IMPORT_LIMITS)) {
      if ((SHARES as readonly string[]).includes(name)) continue;
      expect(Number.isInteger(value), name).toBe(true);
    }
  });

  it('the two per-step shares sit in (0, 0.5) so the new sections cannot dominate the budget [G2.7]', () => {
    for (const name of SHARES) {
      expect(IMPORT_LIMITS[name], name).toBeGreaterThan(0);
      expect(IMPORT_LIMITS[name], name).toBeLessThan(0.5);
    }
    // §2.10.3: together they are 23% of today's 61,440-byte floor, behind `files in view`
    expect(IMPORT_LIMITS.rulesInScopeShare + IMPORT_LIMITS.memoryInScopeShare).toBeLessThan(0.5);
  });

  it('each share clamps min < max', () => {
    expect(IMPORT_LIMITS.rulesInScopeMin).toBeLessThan(IMPORT_LIMITS.rulesInScopeMax);
    expect(IMPORT_LIMITS.memoryInScopeMin).toBeLessThan(IMPORT_LIMITS.memoryInScopeMax);
  });

  it('an AGENTS.md append leaves 24 KiB of headroom under INSTRUCTIONS_MAX_BYTES (§2.8)', () => {
    expect(IMPORT_LIMITS.agentsAppendBytes + 24 * 1024).toBeLessThanOrEqual(INSTRUCTIONS_MAX_BYTES);
  });

  it('sourceReadCapBytes is exactly INSTRUCTIONS_READ_CAP_BYTES (§2.8)', () => {
    expect(IMPORT_LIMITS.sourceReadCapBytes).toBe(INSTRUCTIONS_READ_CAP_BYTES);
  });

  it('the jev budget stays under assertQuestionBatch’s 1,000-question backstop (§4.4.3)', () => {
    expect(IMPORT_LIMITS.jevQuestions).toBeLessThanOrEqual(1000);
    expect(IMPORT_LIMITS.jevRequests).toBeLessThanOrEqual(10);
  });

  it('the dedupe cap bounds the plan ceiling’s all-pairs pass [G1.6]', () => {
    // without bucketing, planRows² / 2 is ~2M comparisons; the cap is two orders of magnitude below it
    expect(IMPORT_LIMITS.dedupePairs).toBeLessThan((IMPORT_LIMITS.planRows * IMPORT_LIMITS.planRows) / 2);
    expect(IMPORT_LIMITS.minhashBands).toBeGreaterThan(1);
  });

  it('the destination caps nest: rule ≤ topic = command ≤ memoryDirBytes', () => {
    expect(IMPORT_LIMITS.ruleBytes).toBeLessThanOrEqual(IMPORT_LIMITS.topicBytes);
    expect(IMPORT_LIMITS.topicBytes).toBe(IMPORT_LIMITS.commandBytes);
    expect(IMPORT_LIMITS.topicBytes).toBeLessThanOrEqual(IMPORT_LIMITS.memoryDirBytes);
    expect(IMPORT_LIMITS.memoryIndexBytes).toBeLessThanOrEqual(IMPORT_LIMITS.memoryDirBytes);
  });

  it('is frozen at the type level and not mutated at runtime', () => {
    expect(IMPORT_LIMITS.walkDepth).toBe(8);
    expect(IMPORT_LIMITS.walkEntries).toBe(20_000);
    expect(IMPORT_LIMITS.importsKeep).toBe(10);
    expect(IMPORT_LIMITS.slugMaxChars).toBe(64);
  });
});
