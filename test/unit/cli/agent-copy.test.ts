/**
 * AGENT-LOOP-DESIGN §14.1 / §14.5 (copy and the mode surface), slice S5b. The agent-mode copy never says "Jev decides": the chat
 * identity and capabilities, the how-to-task fact, the onboarding wording (when the wizard collects keys FOR agent mode), the fix
 * block. The advertised mode surface — `/mode` lists agent · jev-only · legacy, `/llm on` is agent, jev / panel leave Popular — is
 * stated by the pure `(defaultMode)` forms and goes live with slice S6's default flip; until then a legacy-default session's palette,
 * `/llm` and Popular are byte-identical (asserted), and `/mode legacy` already answers.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODE } from '../../../src/config/defaults.js';
import { HOW_TO_TASK_TEXT, HOW_TO_TASK_TEXT_AGENT, MODE_SENTENCE, SWITCH_MODE_TEXT, harnessFacts } from '../../../src/chat/facts.js';
import { CHAT_CAPABILITIES, CHAT_IDENTITY } from '../../../src/chat/llm-turn.js';
import { dispatchCommand } from '../../../src/tui/commands/dispatch.js';
import { LLM_STATE_MODE, MODE_LEGACY_TEXT, POPULAR, advertisedSurface, llmStateMode, modeArgAccepts, modeArgValues, popularFor } from '../../../src/tui/commands/registry.js';
import { FIX_BLOCK_ONE_KEY, FIX_BLOCK_ONE_KEY_AGENT_FIRST, LOGIN_ONE_KEY_PROMPT, WIZARD_KEY_TITLE, WIZARD_KEY_TITLE_AGENT, WIZARD_OPTIONS_AGENT, fixBlockLines, loginOneKeyPrompt, optionHint, optionsRow, providerTitleMode, wizardLines } from '../../../src/tui/onboarding/lines.js';
import { INITIAL_ONBOARDING, type OnboardingState } from '../../../src/tui/onboarding/reducer.js';
import { stringWidth } from '../../../src/tui/composer/width.js';
import { keyedFixture } from '../chat/facts.test.js';
import { BARE_JEVCODE_SENTENCE, MODE_FLAG_ARG, bareJevcodeSentence, modeFlagArg, modeFlagHelp } from '../../../src/cli/args.js';
import { makeController, type Harness } from './helpers.js';

const JEV_DECIDES = /Jev decides/;

describe('the agent copy never says "Jev decides"', () => {
  it('chat identity and capabilities, the how-to-task sentence, the mode sentence, the onboarding title and options, the fix block', () => {
    for (const text of [CHAT_IDENTITY, CHAT_CAPABILITIES, HOW_TO_TASK_TEXT_AGENT, MODE_SENTENCE.agent, WIZARD_KEY_TITLE_AGENT, WIZARD_OPTIONS_AGENT, FIX_BLOCK_ONE_KEY_AGENT_FIRST, loginOneKeyPrompt('agent'), optionHint(1, 1, 5, 'agent'), optionHint(3, 1, 5, 'agent')]) {
      expect(text).not.toMatch(JEV_DECIDES);
    }
  });

  it('how_to_task: agent mode says what holds under full autonomy (§A2 — destructive commands are not refused)', () => {
    const facts = Object.fromEntries(harnessFacts({ ...keyedFixture(), nextMode: 'agent' }).map((f) => [f.key, f.text]));
    expect(facts['how_to_task']).toBe(`${HOW_TO_TASK_TEXT_AGENT} The code model works through tools and your tests verify it.`);
    expect(facts['how_to_task']).not.toMatch(/refused|stops to ask/);
    // a legacy next mode keeps its sentence
    const legacy = Object.fromEntries(harnessFacts({ ...keyedFixture(), nextMode: 'jev-on' }).map((f) => [f.key, f.text]));
    expect(legacy['how_to_task']?.startsWith(HOW_TO_TASK_TEXT)).toBe(true);
  });
});

describe('onboarding in agent mode (§14.5): one key runs the code model; option 3 is the jev-only mode', () => {
  const state = (patch: Partial<OnboardingState>): OnboardingState => ({ ...INITIAL_ONBOARDING, ...patch });
  it('the key step titles the one key for the code model; a legacy wizard keeps its title', () => {
    expect(wizardLines(state({ step: 'key', mode: 'agent', missing: ['generator.apiKey'] }), { rows: 24, columns: 100 })[0]).toBe(WIZARD_KEY_TITLE_AGENT);
    expect(wizardLines(state({ step: 'key', mode: 'llm-jev', missing: ['generator.apiKey', 'decider.apiKey'] }), { rows: 24, columns: 100 })[0]).toBe(WIZARD_KEY_TITLE);
    expect(stringWidth(WIZARD_KEY_TITLE_AGENT)).toBeLessThanOrEqual(76);
  });

  it('the options step names the jev-only mode; the wide row fits 98 cells with its default marker, the narrow one 76', () => {
    const wide = optionsRow(null, 120, false, 'agent');
    expect(wide).toContain('3 jev-only (no code model)');
    expect(wide).toContain('1 OpenRouter (default)');
    expect(stringWidth(wide)).toBeLessThanOrEqual(98);
    expect(stringWidth(optionsRow(null, 80, false, 'agent'))).toBeLessThanOrEqual(76);
    const rows = wizardLines(state({ step: 'options', mode: 'agent' }), { rows: 24, columns: 80 });
    expect(rows[1]).toContain('jev-only');
    expect(stringWidth(optionHint(1, 10, 50, 'agent'))).toBeLessThanOrEqual(76);
    expect(optionHint(3, 1, 5, 'agent')).toBe('3: jev-only — no code model; code proposes, tests verify · caps $1.00 / $5.00');
  });

  it('`/mode agent` with no generator key names agent; the fix block and the one-key prompt name the code model with Jev optional', () => {
    expect(providerTitleMode('agent')).toBe('agent needs a generator. Pick the provider:');
    expect(providerTitleMode('jev-on')).toBe('jev+llm needs a generator. Pick the provider:');
    const fix = fixBlockLines('agent');
    expect(fix[0]).toBe(FIX_BLOCK_ONE_KEY_AGENT_FIRST);
    expect(fix.slice(1, FIX_BLOCK_ONE_KEY.length)).toEqual(FIX_BLOCK_ONE_KEY.slice(1));
    expect(fixBlockLines('llm-jev')[0]).toBe(FIX_BLOCK_ONE_KEY[0]);
    expect(loginOneKeyPrompt('llm-jev')).toBe(LOGIN_ONE_KEY_PROMPT);
  });
});

describe('the advertised mode surface (§14.1): live with the default flip, byte-identical before it', () => {
  it('after the flip: /mode lists agent · jev-only · legacy and accepts the legacy modes; /llm on is agent; jev and panel leave Popular', () => {
    expect(advertisedSurface('agent')).toBe(true);
    expect(modeArgValues('agent')).toEqual(['agent', 'jev-only', 'legacy']);
    expect(modeArgAccepts('agent')).toEqual(['jev-on', 'jev-off', 'llm-jev']);
    expect(llmStateMode('agent')).toEqual({ on: 'agent', off: 'jev-only' });
    expect(popularFor('agent')).not.toContain('jev');
    expect(popularFor('agent')).not.toContain('panel');
    expect(popularFor('agent')).toHaveLength(14);
  });

  it('before the flip (this base: the default stays llm-jev until S6) nothing a legacy session shows moves', () => {
    expect(DEFAULT_MODE).not.toBe('agent');
    expect(advertisedSurface()).toBe(false);
    expect(LLM_STATE_MODE).toEqual({ on: 'jev-on', off: 'jev-only' });
    expect(POPULAR).toHaveLength(16);
    expect(SWITCH_MODE_TEXT).toContain('/mode jev-on (alias /llm on)');
    expect(modeArgValues()).toEqual(['jev-only', 'jev-on', 'jev-off', 'llm-jev', 'agent']);
  });

  it('/mode legacy is accepted in both states and lists the modes kept for saved configs, resume and the bench', () => {
    expect(dispatchCommand('/mode legacy', { run: 'none', step: 0 })).toMatchObject({ ok: true, action: { kind: 'mode', mode: 'legacy' } });
    expect(dispatchCommand('/mode llm-jev', { run: 'none', step: 0 })).toMatchObject({ ok: true, action: { kind: 'mode', mode: 'llm-jev' } });
    expect(MODE_LEGACY_TEXT).toBe('legacy modes, accepted for saved configs, resume and the bench: llm-jev · jev-on · jev-off — /mode <name> switches to one');
  });

  it('the session answers /mode legacy with that line and changes no mode', async () => {
    const h: Harness = await makeController();
    try {
      void h.controller.run();
      await h.ready();
      await h.command('/mode legacy');
      expect(h.renderer.notes.at(-1)?.text).toBe(MODE_LEGACY_TEXT);
      expect(h.controller.mode()).toBe(DEFAULT_MODE);
    } finally {
      h.cleanup();
    }
  });
});

describe('the CLI help (§14.5 "CLI help footnote"): advertised after the flip, byte-identical before it', () => {
  it('--mode lists agent|jev-only plus one legacy clause, and the footnote names /mode and /mode legacy, once the default is agent', () => {
    expect(modeFlagArg('agent')).toBe('agent|jev-only');
    expect(modeFlagHelp('agent')).toBe('engine mode (default agent): agent (the code model works through tools, tests verify), jev-only (Jev alone, no generating LLM); legacy, accepted for saved configs, resume and the bench: llm-jev, jev-on, jev-off');
    expect(bareJevcodeSentence('agent')).toBe('A bare `jevcode` opens the interactive session in agent mode (one OpenRouter key serves the code model and Jev); `/mode` switches to jev-only, and `/mode legacy` lists the older modes; `/` lists commands, `?` shows the keys.');
    for (const t of [modeFlagHelp('agent'), bareJevcodeSentence('agent')]) expect(t).not.toMatch(JEV_DECIDES);
    // today (default llm-jev) the help is unchanged
    expect(MODE_FLAG_ARG).toBe('jev-only|jev-on|jev-off|llm-jev');
    expect(BARE_JEVCODE_SENTENCE).toBe(bareJevcodeSentence(DEFAULT_MODE));
  });
});
