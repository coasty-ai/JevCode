/**
 * TUI-DESIGN §8.6 / §11.3 / §15 item 19 (provider/prompts.ts row): one `Instruction from the human …` hints line per
 * directive (≤ 8, each clipped at 600, after the replan line), the pinned-files line, and the `## Project instructions`
 * section of the system prompt (generator only, ≤ 32 KiB).
 */
import { describe, expect, it } from 'vitest';
import type { Plan } from '../../../src/core/types.js';
import { HUMAN_DIRECTIVE_CHARS, INSTRUCTIONS_MAX_CHARS, buildSystemPrompt, buildUserMessage, type PromptInput } from '../../../src/provider/prompts.js';

const plan: Plan = { done: [], remaining: ['fix f'], unverified: [], openProblems: [], harnessProblems: [{ kind: 'human', text: 'use pytest -x', step: 3 }] };
function input(over: Partial<PromptInput> = {}): PromptInput {
  return {
    mode: 'jev-on',
    step: 3,
    task: 'fix it',
    plan,
    intent: null,
    hints: {},
    directive: null,
    loopNotice: null,
    window: [],
    workspace: { changedFiles: [], resumed: false, testCommand: null, git: true },
    contextFiles: [],
    candidates: null,
    toolName: 'propose_action',
    ...over,
  };
}
const HINT = "- Instruction from the human for this step (it takes precedence over the plan's order): ";

describe('hintsSection: human directives (§8.6)', () => {
  it('renders one line per directive under the harness notes, after the replan line, each clipped at 600, at most 8', () => {
    const long = 'x'.repeat(HUMAN_DIRECTIVE_CHARS + 50);
    const text = buildUserMessage(input({ humanDirectives: ['first', long], directive: { move: 'change_approach', text: 'Jev directs `change_approach`', probability: 0.8, confidence: 0.6, taskImpossible: 0.1 } }));
    expect(text).toContain('## Notes from the harness');
    expect(text.indexOf('Replan directive from Jev')).toBeLessThan(text.indexOf(HINT));
    expect(text).toContain(`${HINT}first`);
    const lines = text.split('\n').filter((l) => l.startsWith(HINT));
    expect(lines).toHaveLength(2);
    expect(lines[1]!.slice(HINT.length)).toHaveLength(HUMAN_DIRECTIVE_CHARS);
    expect(lines[1]!.endsWith('…')).toBe(true);
    const nine = buildUserMessage(input({ humanDirectives: Array.from({ length: 9 }, (_, i) => `d${i}`) }));
    expect(nine.split('\n').filter((l) => l.startsWith(HINT))).toHaveLength(8);
    // the plan section names it as a harness problem too
    expect(text).toContain('[human, step 3] use pytest -x');
  });

  it('no directives and no pinned files → no human lines and no notes section when nothing else is hinted', () => {
    const text = buildUserMessage(input({ plan: { ...plan, harnessProblems: [] } }));
    expect(text).not.toContain('## Notes from the harness');
    expect(text).not.toContain('Instruction from the human');
    const empty = buildUserMessage(input({ humanDirectives: [], pinnedFiles: [], plan: { ...plan, harnessProblems: [] } }));
    expect(empty).not.toContain('## Notes from the harness');
  });

  it('pinned files are listed once, capped at 20 with a remainder count', () => {
    const text = buildUserMessage(input({ pinnedFiles: ['src/a.py', 'src/b.py'] }));
    expect(text).toContain('- The human pinned these files for this task (@-mentions): src/a.py, src/b.py');
    const many = buildUserMessage(input({ pinnedFiles: Array.from({ length: 23 }, (_, i) => `f${i}.py`) }));
    expect(many).toContain('f19.py, … (3 more)');
    expect(many).not.toContain('f20.py');
  });
});

describe('buildSystemPrompt: project instructions (§11.3, D6)', () => {
  it('appends `## Project instructions` with the text when given, nothing otherwise; whitespace-only counts as absent; clipped at 32 KiB', () => {
    const base = buildSystemPrompt({ mode: 'jev-on', sandboxLevel: 'none', toolName: 'propose_action' });
    expect(base).not.toContain('## Project instructions');
    expect(buildSystemPrompt({ mode: 'jev-on', sandboxLevel: 'none', toolName: 'propose_action', instructions: '   \n' })).toBe(base);
    const withText = buildSystemPrompt({ mode: 'jev-on', sandboxLevel: 'none', toolName: 'propose_action', instructions: 'Use tabs.\nRun `make test`.' });
    expect(withText).toBe(`${base}\n\n## Project instructions\nUse tabs.\nRun \`make test\`.`);
    const huge = buildSystemPrompt({ mode: 'jev-off', sandboxLevel: 'seatbelt', toolName: 'propose_action', instructions: 'y'.repeat(INSTRUCTIONS_MAX_CHARS + 10) });
    const section = huge.slice(huge.indexOf('## Project instructions\n') + '## Project instructions\n'.length);
    expect(section).toHaveLength(INSTRUCTIONS_MAX_CHARS);
    expect(section.endsWith('…')).toBe(true);
  });
});
