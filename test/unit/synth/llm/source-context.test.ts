/**
 * contract 1.4 (COORDINATION-DESIGN §8.8 column 3) / TUI-DESIGN-5 §8.2 R13: the engine's relaxed context view inside a
 * `propose_fix` sample. It rides `LlmFireInput.contextText` and `withSampleContext` splices it into EVERY sample's
 * user message — after the goal / failing behaviour / localisation / code material, before the `## Reply` answer
 * schema, fenced as data, bounded by `LLM_SAMPLE_CONTEXT_MAX_CHARS` and never clipped in silence. Absent or blank
 * adds not one character, which is what keeps a run that builds no view (`jev-only`, `view: 'legacy'`) byte-identical
 * and every generator row's `promptHash` (sha12 of system + messages) what it was.
 */
import { describe, expect, it } from 'vitest';

import { sha12 } from '../../../../src/core/hash.js';
import { LLM_SAMPLE_CONTEXT_MAX_CHARS } from '../../../../src/core/limits.js';
import { buildFixSystemPrompt, buildFixUserMessage, listingSet } from '../../../../src/synth/llm/prompt.js';
import { LLM_SAMPLE_CONTEXT_HEADER, createLlmSource, llmSampleContextNotice, withSampleContext, type LlmBudget, type LlmFireInput, type LlmSource } from '../../../../src/synth/llm/source.js';
import { calcFiles, proposeFixCall, scriptedGenerate, type HunkIn } from './fixtures.js';

const files = calcFiles();
const listings = listingSet({ files, frames: [{ path: 'src/calc.py', line: 4 }], anchors: [] });
const PRICING = { inputPerM: 0.5, outputPerM: 2 };
const FIX_A: HunkIn[] = [{ old: '    return a + b', new: '    return (a or 0) + b', near_line: 4 }];

const FIX_PROMPT = buildFixUserMessage({
  goal: { tests: ['tests/test_calc.py::test_add'], path: 'src/calc.py' },
  task: 'make add() tolerate None',
  failures: [{ testId: 'tests/test_calc.py::test_add', call: 'add(None, 1)', expected: '1', actual: 'TypeError' }],
  localisation: [{ path: 'src/calc.py', line: 4, fn: 'add', origin: 'traceback' }],
  listings,
  attempts: [],
  hint: { tiers: [] },
});

function budget(over: Partial<LlmBudget> = {}): LlmBudget {
  return { roundsLeft: 2, samplesLeft: 8, usdLeft: 0.02, ...over };
}

function fireInput(over: Partial<LlmFireInput> = {}): LlmFireInput {
  return { goalId: 'g1', step: 3, round: 1, klass: 'quixbugs', system: buildFixSystemPrompt(), userFor: () => FIX_PROMPT, files, listings, signal: new AbortController().signal, budget: budget(), deadlineMs: 5_000, n: 1, stagger: false, ...over };
}

async function sentMessage(input: Partial<LlmFireInput>): Promise<string> {
  const gen = scriptedGenerate(() => ({ toolCall: proposeFixCall([FIX_A]) }));
  const src: LlmSource = createLlmSource({ generate: gen.generate, pricing: PRICING });
  src.fire(fireInput(input));
  await src.collectAll();
  return gen.requests()[0]!.messages[0]!.content;
}

describe('contract 1.4 (§8.8 column 3): contextText in the propose_fix sample', () => {
  it('a small view is verbatim, fenced as data, after the code and before the answer schema', async () => {
    const view = ['# Step 7', '', '## Task', 'make add() tolerate None', '', '## Plan (accepted by the harness)', 'remaining:', '- fix add', '', '## Recent steps (last 1, oldest first)', '### step 6: run pytest -q'].join('\n');
    const sent = await sentMessage({ contextText: view });

    // verbatim: not one character of the view was dropped
    expect(sent).toContain(view);
    expect(sent).toContain(LLM_SAMPLE_CONTEXT_HEADER);
    expect(sent).not.toContain('harness context clipped');
    // ordering: the goal, the failure and the code keep their place; the view sits between them and `## Reply`
    const at = (s: string): number => sent.indexOf(s);
    expect(at('# Goal')).toBeLessThan(at('## Failing behaviour'));
    expect(at('## Code')).toBeLessThan(at(LLM_SAMPLE_CONTEXT_HEADER));
    expect(at(LLM_SAMPLE_CONTEXT_HEADER)).toBeLessThan(at('## Reply'));
    expect(sent.endsWith('## Reply\nCall `propose_fix`.')).toBe(true);
    expect(sent).toContain('```text\n# Step 7');
  });

  it('a 200 KB view clips at LLM_SAMPLE_CONTEXT_MAX_CHARS with a named notice — never silently', async () => {
    const view = `HEAD-MARKER\n${'context line that says nothing in particular\n'.repeat(4_500)}TAIL-MARKER`;
    expect(view.length).toBeGreaterThan(200_000);
    const sent = await sentMessage({ contextText: view });

    // head-first: the task and the plan survive, the oldest tail is what goes
    expect(sent).toContain('HEAD-MARKER');
    expect(sent).not.toContain('TAIL-MARKER');
    const notice = llmSampleContextNotice(view.length - LLM_SAMPLE_CONTEXT_MAX_CHARS);
    expect(sent).toContain(notice);
    // the section carries exactly the bound…
    const open = sent.indexOf('```text\n') + '```text\n'.length;
    const close = sent.indexOf('\n```\n', open);
    expect(sent.slice(open, close)).toHaveLength(LLM_SAMPLE_CONTEXT_MAX_CHARS);
    // …and the notice is OUTSIDE the fence, so it cannot read as part of the view
    expect(sent.indexOf(notice)).toBeGreaterThan(close);
    // the whole message is still bounded: the fix prompt's own sections plus this one section
    expect(sent.length).toBeLessThan(FIX_PROMPT.length + LLM_SAMPLE_CONTEXT_MAX_CHARS + 500);
  });

  it('no view = not one character added, and the same view twice builds the same bytes (promptHash stays deterministic)', async () => {
    expect(await sentMessage({})).toBe(FIX_PROMPT);
    // blank is the same as absent
    expect(withSampleContext(FIX_PROMPT, '   \n  ')).toBe(FIX_PROMPT);
    expect(withSampleContext(FIX_PROMPT, undefined)).toBe(FIX_PROMPT);

    // a view holding its own fenced code cannot break out of the section's fence
    const fenced = ['files in view:', '```python', 'def add(a, b):', '    return a + b', '```'].join('\n');
    const spliced = withSampleContext(FIX_PROMPT, fenced);
    expect(spliced).toContain('````text\n');
    expect(spliced).toContain(fenced);
    expect(spliced.indexOf(LLM_SAMPLE_CONTEXT_HEADER)).toBeLessThan(spliced.indexOf('## Reply'));

    // deterministic: same inputs, same bytes — what the generator row's `promptHash` is pinned on
    const hashOf = (content: string): string => sha12({ system: buildFixSystemPrompt(), messages: [{ role: 'user', content }] });
    expect(hashOf(spliced)).toBe(hashOf(withSampleContext(FIX_PROMPT, fenced)));
    expect(hashOf(spliced)).not.toBe(hashOf(FIX_PROMPT));
  });
});
