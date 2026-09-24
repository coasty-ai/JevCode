/** The agent's prompts (docs/AGENT-LOOP-DESIGN.md §5, §A1, §A2, §A5). */
import { describe, expect, it } from 'vitest';
import { chatIdentityHeader } from '../../../src/chat/llm-turn.js';
import { buildAgentSystemPrompt, familyAddendum, invalidArguments, loopNudgeText, loopTripWhat, verifyFailedNudge, verifyResult, verifyTimeout, type SystemPromptFacts } from '../../../src/agent/prompt.js';

const facts: SystemPromptFacts = { model: 'z-ai/glm-5.3-flash', providerLabel: 'OpenRouter', sandboxLevel: 'seatbelt', testCommand: 'npm test', autonomy: 'full', instructions: null, memoryIndex: null };

describe('the system prompt', () => {
  it('leads with the verified identity header, verbatim', () => {
    const p = buildAgentSystemPrompt(facts);
    expect(p.startsWith(chatIdentityHeader('z-ai/glm-5.3-flash', 'OpenRouter'))).toBe(true);
    expect(p).toContain('built by coasty-ai');
  });

  it('keeps the design section order and carries the chat voice rules', () => {
    const p = buildAgentSystemPrompt(facts);
    const headings = p.split('\n').filter((l) => l.startsWith('#'));
    expect(headings).toEqual(['# Who you are', '# How you work', '# How to answer', '# Tools', '# Verifying', '# Finishing', '# Git and scratch files', '# Safety']);
    expect(p).toContain('- A greeting gets one or two friendly sentences; a question gets a direct answer.');
    // S6 live (2026-09-23): glm-5.3-flash edited src/math.js in answer to "the mean function … divides by the wrong number, right?"
    expect(p).toContain('- A question is not a request for a change, even when it points at a bug ("this is wrong, right?"): answer it, reading what you need, and offer to make the change.');
    expect(p).toContain('without tools');
    expect(p).toContain('read-only tools');
    expect(p).toContain('(`npm test` was detected)');
    expect(p).toContain('writes are allowed only inside the workspace and the run temp dir');
  });

  it('is byte-stable for the same facts and never mentions Jev, the date or the step', () => {
    const a = buildAgentSystemPrompt(facts);
    expect(buildAgentSystemPrompt({ ...facts })).toBe(a);
    expect(a).not.toMatch(/\bJev\b/);
    expect(a).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
    expect(a).not.toMatch(/\bstep \d/);
  });

  it('under full autonomy asks for restraint instead of promising a refusal; under review names the human', () => {
    expect(buildAgentSystemPrompt(facts)).not.toContain('refuses');
    expect(buildAgentSystemPrompt(facts)).toContain('without asking');
    expect(buildAgentSystemPrompt({ ...facts, autonomy: 'review' })).toContain('The human reviews destructive and unrecognised commands');
  });

  it('§A2 / directive 5: under full autonomy a command the user explicitly asks for is run, never refused or confirmed; the restraint is only for the model\'s own choices (S6 review L7)', () => {
    const full = buildAgentSystemPrompt(facts);
    expect(full).toContain('when the user explicitly asks you to run a command, run it as asked, even a destructive one, without asking for confirmation and without refusing');
    expect(full).toContain('On your own initiative, never run destructive commands the task does not need');
    // the line the model quoted when it refused `rm -rf <dir outside the workspace>` as "not permitted" is gone from full autonomy
    expect(full).not.toContain('Stay inside the workspace');
    expect(full).toContain('Never read secrets');
    // review keeps its human gate and does not tell the model to run anything unasked-for
    const review = buildAgentSystemPrompt({ ...facts, autonomy: 'review' });
    expect(review).toContain('Stay inside the workspace. Never read secrets (.env files, keys, credential stores).');
    expect(review).not.toContain('explicitly asks you to run a command');
  });

  it('appends project instructions, the memory index and the family addendum, in that order', () => {
    const p = buildAgentSystemPrompt({ ...facts, instructions: 'Use tabs.', memoryIndex: '# notes\n- [a](a.md) — tabs', testCommand: null });
    const i = p.indexOf('## Project instructions\nUse tabs.');
    const m = p.indexOf('## Memory (index)\n```text\nnotes\n- [a](a.md) — tabs\n```');
    const g = p.indexOf('Call tools only through the native function-calling interface.');
    expect(i).toBeGreaterThan(0);
    expect(m).toBeGreaterThan(i);
    expect(g).toBeGreaterThan(m);
    expect(p).toContain('no test command was detected: run what the project uses, if anything');
  });

  it.each([
    ['z-ai/glm-5.3-flash', 'Never write tool calls as XML'],
    ['glm-5p3-flash', 'Never write tool calls as XML'],
    ['gpt-5.6-luna', 'Prefer edit_file over rewriting files'],
    ['o4-mini', 'Prefer edit_file over rewriting files'],
    ['claude-sonnet-5', 'parallel tool calls'],
    ['anthropic/claude-opus-5-5', 'parallel tool calls'],
    ['gemini-3.8-flash', 'plain JSON values'],
  ])('the %s addendum', (model, text) => {
    expect(familyAddendum(model)).toContain(text);
  });

  it('Grok, Muse and others get no addendum', () => {
    expect(familyAddendum('grok-4.7')).toBeNull();
    expect(familyAddendum('muse-spark-1.3')).toBeNull();
  });
});

describe('harness texts', () => {
  it('fills the §5.4 placeholders', () => {
    expect(verifyFailedNudge('npm test', 2, 1, 0)).toBe('The last run of `npm test` after your change failed (2 passed, 1 failed, 0 errors). Fix it, or explain why the failures are unrelated, before you finish.');
    expect(verifyResult('npm test', 'exit 0 · 1.2s', 'ok')).toBe('The harness ran `npm test` to verify your change: exit 0 · 1.2s\nok\nIf it failed, fix it and verify again. If it passed, your summary stands: reply with one short sentence that says the tests passed.');
    expect(verifyTimeout('npm test', 600)).toContain('did not finish within 600s, so the change is not verified');
    expect(invalidArguments('read_file', 'path is required', '{path: string}')).toBe('INVALID ARGUMENTS for read_file: path is required. Expected {path: string}.');
  });

  it('builds the loop nudge from the trip and one of four wordings', () => {
    const what = loopTripWhat({ rule: 'repeat', tool: 'grep', count: 3, testCommand: null });
    expect(what).toBe('You have called grep with the same arguments 3 times in a row and got the same result');
    expect(loopTripWhat({ rule: 'window', tool: 'bash', count: 6, testCommand: null })).toBe('You have made the same bash call with the same result 6 times in your last 10 calls');
    expect(loopTripWhat({ rule: 'repeat', tool: 'bash', count: 3, testCommand: 'npm test' })).toBe('You have run `npm test` 3 times with the same failing tests');
    expect(loopNudgeText('change_approach', what)).toBe(`${what}. Stop and try a different approach.`);
    expect(loopNudgeText('gather_context', what)).toContain('You are missing information');
    expect(loopNudgeText('fix_environment', what)).toContain('The failure may be in the environment');
    expect(loopNudgeText('revert_changes', what)).toContain('review them (git diff)');
  });
});
