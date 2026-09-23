/** Context policy (docs/AGENT-LOOP-DESIGN.md §7.1-§7.5) and the per-provider capabilities it keys on (§6.3, §7.3). */
import { describe, expect, it } from 'vitest';
import { ContextEstimate, budgetFor, clearToolResultsFor, codeSummary, compactionDue, compactionWriter, contextUsage, editedFiles, maskCandidates, maskDue } from '../../../src/agent/context.js';
import { agentReasoning, agentTemperature, isClaudeModel, lowEffortReasoning, maskingModeFor, providerLabel } from '../../../src/agent/providers.js';
import { initialState } from '../../../src/agent/state.js';
import { Transcript, transcriptPath } from '../../../src/agent/transcript.js';
import { createAgentContext, tempRunDir } from './helpers.js';

describe('budget and estimate', () => {
  it('budget = min(0.9 × window, 200k); an unknown window is 128k', () => {
    expect(budgetFor(1_000_000)).toEqual({ windowTokens: 1_000_000, budgetTokens: 200_000, boundBy: 'ceiling' });
    expect(budgetFor(128_000)).toEqual({ windowTokens: 128_000, budgetTokens: 115_200, boundBy: 'window' });
    expect(budgetFor(null)).toEqual({ windowTokens: 128_000, budgetTokens: 115_200, boundBy: 'window' });
  });

  it('estimates chars / 3.4 before the first turn, then the reported input plus the chars appended since', () => {
    const e = new ContextEstimate();
    expect(e.tokens(34_000)).toBe(10_000);
    e.observe({ inputTokens: 50_000, outputTokens: 10, costUsd: 0, calls: 1, cacheReadTokens: 40_000 }, 0, 100_000);
    expect(e.tokens(100_000)).toBe(50_000);
    expect(e.tokens(103_400)).toBe(51_000);
    e.observe({ inputTokens: 50_000, outputTokens: 10, costUsd: 0, calls: 1 }, 20_000, 100_000);
    expect(e.tokens(100_000)).toBe(30_000);
    e.reset();
    expect(e.tokens(3_400)).toBe(1_000);
  });
});

describe('masking', () => {
  async function withResults(sizes: number[]): Promise<Transcript> {
    const t = new Transcript(transcriptPath(tempRunDir()), () => 0);
    await t.reset([]);
    await t.append({ kind: 'user', text: 'task' });
    await t.append({ kind: 'assistant', text: '', calls: sizes.map((_s, i) => ({ id: `c${i}`, name: 'bash', input: { command: `cmd ${i}` } })), stopReason: 'tool_calls', sys: 's' });
    for (const [i, n] of sizes.entries()) await t.append({ kind: 'result', toolUseId: `c${i}`, name: 'bash', content: 'x'.repeat(n), isError: false, summary: `bash cmd ${i} (exit 0)` });
    return t;
  }

  it('elides results older than the newest 6 and longer than 800 chars', async () => {
    const t = await withResults([30_000, 500, 900, 10, 10, 10, 10, 10, 50_000]);
    const m = maskCandidates(t);
    expect(m.ids).toEqual(['c0', 'c2']);
    expect(m.reclaim).toBeGreaterThan(30_000);
  });

  it('is due past 50 % of the budget with at least 20,000 chars to reclaim, in client mode only', () => {
    const b = budgetFor(1_000_000);
    expect(maskDue('client', 100_001, b, 20_000)).toBe(true);
    expect(maskDue('client', 99_999, b, 50_000)).toBe(false);
    expect(maskDue('client', 150_000, b, 19_999)).toBe(false);
    expect(maskDue('server', 150_000, b, 50_000)).toBe(false);
    expect(maskDue('off', 150_000, b, 50_000)).toBe(false);
  });

  it('the masking mode: server on the Anthropic adapter, off for Claude elsewhere, client for everything else', () => {
    expect(maskingModeFor('anthropic', 'claude-sonnet-5')).toBe('server');
    expect(maskingModeFor('openrouter', 'anthropic/claude-sonnet-5')).toBe('off');
    expect(maskingModeFor('openrouter', 'z-ai/glm-5.3-flash')).toBe('client');
    expect(maskingModeFor('openai', 'gpt-5.6-luna')).toBe('client');
    expect(maskingModeFor('fireworks', 'glm-5p3-flash')).toBe('client');
    expect(isClaudeModel('claude-opus-5-5')).toBe(true);
    expect(isClaudeModel('z-ai/glm-5.3-flash')).toBe(false);
  });

  it('the server-side clearing request is constant for the session', () => {
    expect(clearToolResultsFor(budgetFor(1_000_000), 5_000)).toEqual({ triggerTokens: 100_000, keep: 6, clearAtLeastTokens: 5_000 });
  });
});

describe('compaction policy', () => {
  it('is due past 85 % of the budget', () => {
    const b = budgetFor(1_000_000);
    expect(compactionDue(170_001, b)).toBe(true);
    expect(compactionDue(169_999, b)).toBe(false);
  });

  it('the writer: llm unless the user set context.compaction explicitly', () => {
    expect(compactionWriter({ mode: 'code', explicit: false })).toBe('llm');
    expect(compactionWriter({ mode: 'code', explicit: true })).toBe('code');
    expect(compactionWriter({ mode: 'off', explicit: true })).toBe('off');
    expect(compactionWriter({ mode: 'llm', explicit: true })).toBe('llm');
  });

  it('the code writer fills the template from the transcript and the run', async () => {
    const ctx = createAgentContext({ task: 'fix the parser' });
    ctx.lastTestRun = { step: 4, command: 'pytest -q', passed: 3, failed: 1, errors: 0, allPassed: false };
    const t = new Transcript(transcriptPath(ctx.runDir), () => 0);
    await t.reset([]);
    await t.append({ kind: 'user', text: 'task' });
    await t.append({ kind: 'assistant', text: 'The parser drops the last token.', calls: [{ id: 'e1', name: 'edit_file', input: { path: 'src/p.py' } }, { id: 'b1', name: 'bash', input: { command: 'pytest -q' } }, { id: 'w1', name: 'write_file', input: { path: 'src/new.py' } }], stopReason: 'tool_calls', sys: 's' });
    await t.append({ kind: 'result', toolUseId: 'e1', name: 'edit_file', content: 'OK: edited src/p.py (1 replacement, lines 3-3)', isError: false, summary: 'edit_file src/p.py' });
    await t.append({ kind: 'result', toolUseId: 'b1', name: 'bash', content: 'exit 1 · 0.2s · tests: 3 passed, 1 failed, 0 errors\n…', isError: true, summary: 'bash pytest -q (exit 1)' });
    await t.append({ kind: 'result', toolUseId: 'w1', name: 'write_file', content: 'OK: created src/new.py (3 lines)', isError: false, summary: 'write_file src/new.py' });
    const s = initialState('h');
    s.todos = [{ content: 'find the bug', status: 'completed' }, { content: 'fix it', status: 'in_progress' }];
    const text = codeSummary(ctx, t, s);
    expect(text.split('\n').filter((l) => l.startsWith('#'))).toEqual([
      '# Context summary (compacted at step 1; earlier turns were removed)',
      '## Goal and constraints',
      '## Todo',
      '## Files changed so far',
      '## Commands run',
      '## Last test run',
      '## Findings and decisions',
      '## Open questions and next step',
    ]);
    expect(text).toContain('- [x] find the bug\n- [>] fix it');
    expect(text).toContain('- src/new.py — 1 edit, created\n- src/p.py — 1 edit');
    expect(text).toContain('- `pytest -q` → exit 1 · 0.2s · tests: 3 passed, 1 failed, 0 errors');
    expect(text).toContain('`pytest -q` 3 passed, 1 failed, 0 errors (step 4)');
    expect(text).toContain('- The parser drops the last token.');
    expect(editedFiles(t.records).map((f) => f.path)).toEqual(['src/new.py', 'src/p.py']);
  });
});

describe('request settings and the meter', () => {
  it('reasoning per provider, the RA0 low effort, temperature and the display label', () => {
    expect(agentReasoning('anthropic')).toEqual({ effort: 'high' });
    expect(agentReasoning('openrouter')).toEqual({ effort: 'low' });
    expect(lowEffortReasoning('anthropic')).toEqual({ effort: 'low' });
    expect(lowEffortReasoning('mock')).toBeNull();
    expect(agentTemperature('anthropic', 0.2)).toBeNull();
    expect(agentTemperature('openrouter', 0.2)).toBe(0.2);
    expect(providerLabel('openrouter')).toBe('OpenRouter');
    expect(providerLabel('mock')).toBe('mock');
  });

  it('reports a complete ContextUsage', () => {
    const s = initialState('h');
    const u = contextUsage({ tokens: 50_000, budget: budgetFor(1_000_000), promptChars: 170_000, turns: 7, state: s, writer: 'llm', buildMs: 3 });
    expect(u).toMatchObject({ tokensInWindow: 50_000, budgetTokens: 200_000, windowTokens: 1_000_000, pct: 25, budgetChars: 680_000, historyEntries: 7, files: 0, compaction: 'llm', budgetBoundBy: 'ceiling', usdPerStep: null, windowTooSmall: false, promptBuildMs: 3, refreshMs: 0 });
  });
});
