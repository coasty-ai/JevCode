/**
 * TUI-DESIGN-2 §3.5 (S3, §8.1 row `facts.test.ts`): `buildFactQuestions(harnessFacts(fixture))` builds without throwing for
 * every fixture (keyed, keyless, no run, paused run); every path in a text derives from the input; `how_to_task` suffix by
 * `nextMode`; no key material in any fact text for a keyed fixture; `selectFacts` ≥ 0.5 / top-2 / ≤ 4.
 */
import { describe, expect, it } from 'vitest';
import type { Answer, GitState } from '../../../src/core/types.js';
import { FACT_FALSE_EXAMPLES, FACT_KEYS, FACT_MAX_LINES, HOW_TO_TASK_SUFFIX, HOW_TO_TASK_TEXT, MODE_SENTENCE, NOTHING_RAN_TEXT, NO_TESTS_PARSED_TEXT, REVIEW_TEXT, REVIEW_TEXT_FULL, SWITCH_MODE_TEXT, WHAT_IT_IS_TEXT, buildFactQuestions, harnessFacts, reviewText, selectFacts, type FactsInput } from '../../../src/chat/facts.js';
import { MODE_BADGE_WORD, MODE_SETTING_VALUES } from '../../../src/config/defaults.js';
import { notRepoState } from '../../../src/workspace/gitstate.js';
import { sandboxText } from '../../../src/tui/onboarding/lines.js';

const SECRET = 'sk-ant-api03-SECRETSECRETSECRETSECRETSECRET1234';

function gitState(): GitState {
  return { repo: true, gitDir: '/Users/me/proj/.git', commonDir: '/Users/me/proj/.git', topLevel: '/Users/me/proj', prefix: '', linkedWorktree: false, head: { kind: 'branch', name: 'main', oid: 'abc' }, upstream: 'origin/main', ahead: 0, behind: 0, dirty: { modified: 2, staged: 0, untracked: 1, renamed: 0, unmerged: 0, submodules: 0, entries: [] }, probedAt: 't', probeMs: 1 };
}

export function keyedFixture(over: Partial<FactsInput> = {}): FactsInput {
  return {
    mode: 'jev-only',
    nextMode: 'jev-only',
    workspace: { root: '/Users/me/proj', git: gitState(), hasTests: true, testCommand: 'python -m pytest -q' },
    lastRun: { runId: '20260921-120000-abcdefgh', task: 'fix parse_date tz handling', stopReason: 'max_steps', steps: 7, costUsd: { generator: 0.281, jev: 0.029 }, paused: false },
    lastTests: { step: 6, command: 'python -m pytest -q', passed: 41, failed: 0, errors: 0, allPassed: true },
    keys: { jev: { provider: 'typesafe', source: 'dotenv /Users/me/proj/.env' }, generator: { provider: 'anthropic', source: 'environment' } },
    spend: { sessionUsd: 0.31, sessionCapUsd: 1.25, runs: 1, chats: 4 },
    sandbox: 'seatbelt',
    runsDir: '/Users/me/.jevcode/runs',
    provider: { name: 'typesafe', host: 'api.typesafe.ai', model: 'jev-1.13.0', p50Ms: 112 },
    ...over,
  };
}
const keyless = (): FactsInput => keyedFixture({ keys: { jev: null, generator: null }, provider: null, workspace: { root: '/tmp/ws', git: notRepoState('not-a-repo', { probedAt: 't', probeMs: 1 }), hasTests: false, testCommand: null } });
const noRun = (): FactsInput => keyedFixture({ lastRun: null, lastTests: null, spend: { sessionUsd: 0, sessionCapUsd: 1.25, runs: 0, chats: 0 } });
const paused = (): FactsInput => keyedFixture({ lastRun: { runId: 'r2', task: 'x', stopReason: 'human_pause', steps: 3, costUsd: { generator: 0, jev: 0.01 }, paused: true } });

const noul = (p: number): Answer => ({ type: 'noul', noul: p });

describe('§3.5 the harness facts', () => {
  it('builds 15 facts in the table\'s order for every fixture, and every fact Noul builds without throwing (definition + ≥ 2 examples both sides)', () => {
    for (const [name, fixture] of [['keyed', keyedFixture()], ['keyless', keyless()], ['no run', noRun()], ['paused', paused()]] as const) {
      const facts = harnessFacts(fixture);
      expect(facts.map((f) => f.key), name).toEqual(FACT_KEYS);
      for (const f of facts) {
        expect(f.examples.length, `${name} ${f.key}`).toBeGreaterThanOrEqual(2);
        expect(FACT_FALSE_EXAMPLES[f.key].length).toBeGreaterThanOrEqual(2);
        expect(f.text.length).toBeGreaterThan(10);
        expect(f.text).not.toMatch(/\n/);
      }
      const qs = buildFactQuestions(facts);
      expect(Object.keys(qs)).toEqual(FACT_KEYS.map((k) => `about_${k}`));
      const q = qs['about_mode_now'];
      expect(q?.type).toBe('noul');
      if (q?.type === 'noul') {
        expect(String(q.instructions)).toBe('Does `message` ask about which mode the session is in?');
        expect(q.criteria?.true).toEqual({ definition: 'the human wants to know which mode the session is in', examples: ['which mode is this?', 'are you using the LLM?', 'is Claude on?'] });
        expect(q.criteria?.false).toEqual({ definition: 'which mode the session is in is not what the message is about', examples: ['what does parse_date do?', 'run the tests'] });
      }
    }
  });

  it('the fixed texts are the table\'s, verbatim', () => {
    const t = Object.fromEntries(harnessFacts(keyedFixture()).map((f) => [f.key, f.text]));
    expect(t['what_it_is']).toBe(WHAT_IT_IS_TEXT);
    // TUI-DESIGN-3 §1.7 / §1.9: the switch sentence names the jev-only cap; the copy names the code model, never a vendor
    expect(t['switch_mode']).toBe('Switch with /mode jev-only (Jev alone, $1.00 run cap) or /mode jev-on (alias /llm on); it applies to the next run. Persist it with jevcode config set mode <m>.');
    expect(t['switch_mode']).toBe(SWITCH_MODE_TEXT);
    expect(WHAT_IT_IS_TEXT.endsWith('in jev+llm mode the code model writes the code.')).toBe(true);
    // complete autonomy by default: the fact follows `autonomy`, and the `full` sentence never claims nothing is auto-approved
    expect(t['review']).toBe(REVIEW_TEXT_FULL);
    expect(t['review']).toBe(reviewText('full'));
    expect(t['review']).toContain('auto-approved and logged');
    expect(t['review']).not.toContain('Nothing is ever auto-approved');
    const asked = Object.fromEntries(harnessFacts(keyedFixture({ autonomy: 'review' })).map((f) => [f.key, f.text]));
    expect(asked['review']).toBe('Risky actions stop for review: y approves once, n declines, d declines with a note. Nothing is auto-approved under --autonomy review; Enter does nothing there.');
    expect(asked['review']).toBe(REVIEW_TEXT);
    expect(t['undo']).toBe("/undo reverts the last step's file changes, /rewind picks a step, /diff shows what changed.");
    expect(t['commands']).toBe('Commands start with /; type / to list them, /help for keys.');
    expect(t['sandbox']).toBe(sandboxText('seatbelt'));
    expect(t['mode_now']).toBe('Mode: jev-only — no generating LLM; code proposes, Jev decides, tests verify.');
  });

  it('mode_now follows mode and appends the pending mode; how_to_task gets the nextMode suffix', () => {
    const on = Object.fromEntries(harnessFacts(keyedFixture({ mode: 'jev-on', nextMode: 'jev-on' })).map((f) => [f.key, f.text]));
    expect(on['mode_now']).toBe('Mode: jev+llm — the code model writes the code, Jev decides every step.');
    expect(on['mode_now']).toBe(MODE_SENTENCE['jev-on']);
    expect(on['how_to_task']).toBe(HOW_TO_TASK_TEXT + HOW_TO_TASK_SUFFIX['jev-on']);
    const pending = Object.fromEntries(harnessFacts(keyedFixture({ mode: 'jev-only', nextMode: 'jev-on' })).map((f) => [f.key, f.text]));
    expect(pending['mode_now']).toBe('Mode: jev-only — no generating LLM; code proposes, Jev decides, tests verify. Next run: jev+llm.');
    expect(pending['how_to_task']).toBe(`${HOW_TO_TASK_TEXT} The code model writes the code, Jev decides each step.`);
    const only = Object.fromEntries(harnessFacts(keyedFixture()).map((f) => [f.key, f.text]));
    expect(only['how_to_task']).toBe(`${HOW_TO_TASK_TEXT} In jev-only I fix what tests can verify; for open-ended changes switch with /mode jev-on.`);
    const off = Object.fromEntries(harnessFacts(keyedFixture({ mode: 'jev-off', nextMode: 'jev-off' })).map((f) => [f.key, f.text]));
    expect(off['how_to_task']).toBe(`${HOW_TO_TASK_TEXT} The generator alone runs it; reviews still ask.`);
    expect(off['mode_now']).toBe('Mode: llm-only — the generator alone, no Jev (bench condition; reviews still ask).');
    const llm = Object.fromEntries(harnessFacts(keyedFixture({ mode: 'llm-jev', nextMode: 'llm-jev' })).map((f) => [f.key, f.text]));
    expect(llm['mode_now']).toBe('Mode: llm+jev · verified — the code model writes candidate patches, tests verify them, Jev arbitrates.');
    expect(llm['how_to_task']).toBe(`${HOW_TO_TASK_TEXT} The code model writes candidate patches, tests verify them, Jev arbitrates.`);
    // the pending suffix reads the badge table (D-N)
    const toLlm = Object.fromEntries(harnessFacts(keyedFixture({ mode: 'jev-only', nextMode: 'llm-jev' })).map((f) => [f.key, f.text]));
    expect(toLlm['mode_now']).toBe(`${MODE_SENTENCE['jev-only']} Next run: ${MODE_BADGE_WORD['llm-jev']}.`);
  });

  it('TUI-DESIGN-3 §1.9 (R3 F9): no vendor name in any fact text or mode sentence — the copy says "the code model"; every MODE_SENTENCE row reads its badge word', () => {
    for (const fixture of [keyedFixture(), keyless(), keyedFixture({ mode: 'jev-on', nextMode: 'jev-on' }), keyedFixture({ mode: 'llm-jev', nextMode: 'llm-jev' }), keyedFixture({ mode: 'jev-off', nextMode: 'jev-off' })]) {
      for (const f of harnessFacts(fixture)) expect(f.text, f.key).not.toMatch(/Claude|GLM writes|Sonnet/);
    }
    for (const m of MODE_SETTING_VALUES) {
      expect(MODE_SENTENCE[m], m).toMatch(new RegExp(`^Mode: ${MODE_BADGE_WORD[m].replace(/[+·]/g, (c) => `\\${c}`)} — `));
      expect(HOW_TO_TASK_SUFFIX[m], m).not.toMatch(/Claude|GLM/);
    }
    expect(WHAT_IT_IS_TEXT).not.toMatch(/Claude/);
    expect(SWITCH_MODE_TEXT).not.toMatch(/Claude/);
  });

  it('every path or figure in a text derives from the input: workspace root, branch and dirty counts, run id, task, cost, spend, host, model, latency', () => {
    const t = Object.fromEntries(harnessFacts(keyedFixture()).map((f) => [f.key, f.text]));
    expect(t['workspace']).toBe('Workspace: /Users/me/proj (git main, 2 modified · 1 untracked; tests: python -m pytest -q)');
    expect(t['last_run']).toBe('Last run 20260921-120000-abcdefgh: "fix parse_date tz handling" ended max_steps after 7 steps, $0.31; /resume continues, /diff shows the changes.');
    expect(t['last_tests']).toBe('Last test run: 41 passed, 0 failed, 0 errors (step 6).');
    // the spend in /cost's form (`stepCostText`: three decimals, four below $0.001), the cap in two — the two answers to "how much has this cost?" agree
    expect(t['cost_so_far']).toBe('Session spend: $0.310 of $1.25 (1 run, 4 chat messages). /cost has the breakdown.');
    expect(t['provider']).toBe('Jev: typesafe (api.typesafe.ai), model jev-1.13.0, about 112 ms per decision, $0.042 per million input tokens (output free).');
    expect(t['keys']).toBe('Keys: Jev through typesafe (dotenv /Users/me/proj/.env, never printed); generator: anthropic (environment)');
    const k = Object.fromEntries(harnessFacts(keyless()).map((f) => [f.key, f.text]));
    expect(k['workspace']).toBe('Workspace: /tmp/ws (not a git repository; no test command found)');
    expect(k['keys']).toBe('Keys: Jev — no key resolves yet (jevcode login saves one); generator: none — needed for jev+llm; /mode jev-on asks for one.');
    expect(k['provider']).toBe('Jev: not configured yet — jevcode login saves a key; $0.042 per million input tokens (output free).');
    const n = Object.fromEntries(harnessFacts(noRun()).map((f) => [f.key, f.text]));
    expect(n['last_run']).toBe(NOTHING_RAN_TEXT);
    expect(n['last_tests']).toBe(NO_TESTS_PARSED_TEXT);
    expect(n['cost_so_far']).toBe('Session spend: $0.000 of $1.25 (0 runs, 0 chat messages). /cost has the breakdown.');
    // finding 8: three intakes ≈ $0.0006 never read as "$0.00"
    const cents = Object.fromEntries(harnessFacts(keyedFixture({ spend: { sessionUsd: 0.0006, sessionCapUsd: 1.25, runs: 0, chats: 3 } })).map((f) => [f.key, f.text]));
    expect(cents['cost_so_far']).toBe('Session spend: $0.0006 of $1.25 (0 runs, 3 chat messages). /cost has the breakdown.');
    const p = Object.fromEntries(harnessFacts(paused()).map((f) => [f.key, f.text]));
    expect(p['last_run']).toBe('Last run r2: "x" is paused after 3 steps, $0.01; /resume continues, /diff shows the changes.');
    const noLatency = Object.fromEntries(harnessFacts(keyedFixture({ provider: { name: 'openrouter', host: 'openrouter.ai', model: 'typesafe/jev-1.13-20260917', p50Ms: null } })).map((f) => [f.key, f.text]));
    expect(noLatency['provider']).toBe('Jev: openrouter (openrouter.ai), model typesafe/jev-1.13-20260917, $0.042 per million input tokens (output free).');
  });

  it('no key material reaches any text: the input carries sources only (`env <NAME>` names the variable, never a value — finding 7)', () => {
    const facts = harnessFacts(keyedFixture({ keys: { jev: { provider: 'typesafe', source: 'env TYPESAFE_API_KEY' }, generator: { provider: 'anthropic', source: 'env ANTHROPIC_API_KEY' } } }));
    const texts = facts.map((f) => f.text);
    for (const t of texts) expect(t).not.toContain(SECRET);
    expect(facts.find((f) => f.key === 'keys')?.text).toBe('Keys: Jev through typesafe (env TYPESAFE_API_KEY, never printed); generator: anthropic (env ANTHROPIC_API_KEY)');
  });

  it('workspace: the parsed test command wins; before any run the detected runner prints `tests: <runner> (detected)`; `unknown` or none → `no test command found` (finding 9)', () => {
    const text = (workspace: FactsInput['workspace']): string | undefined => harnessFacts(keyedFixture({ workspace })).find((f) => f.key === 'workspace')?.text;
    const base = keyedFixture().workspace;
    expect(text({ ...base, testCommand: null, testRunner: 'pytest' })).toBe('Workspace: /Users/me/proj (git main, 2 modified · 1 untracked; tests: pytest (detected))');
    expect(text({ ...base, testCommand: 'python -m pytest -q', testRunner: 'pytest' })).toContain('tests: python -m pytest -q)');
    expect(text({ ...base, testCommand: null, testRunner: 'unknown' })).toContain('no test command found');
    expect(text({ ...base, testCommand: null, testRunner: null })).toContain('no test command found');
    expect(text({ ...base, testCommand: null })).toContain('no test command found');
  });

  it('selectFacts keeps p ≥ 0.5 in probability order, ≤ 4; none ≥ 0.5 → the top 2 (input order breaks ties)', () => {
    const facts = harnessFacts(keyedFixture());
    const a: Record<string, Answer> = {};
    for (const f of facts) a[`about_${f.key}`] = noul(0.1);
    a['about_cost_so_far'] = noul(0.9);
    a['about_mode_now'] = noul(0.7);
    a['about_keys'] = noul(0.5);
    a['about_what_it_is'] = noul(0.49);
    expect(selectFacts(facts, a).map((f) => f.key)).toEqual(['cost_so_far', 'mode_now', 'keys']);
    for (const f of facts) a[`about_${f.key}`] = noul(0.8);
    expect(selectFacts(facts, a)).toHaveLength(FACT_MAX_LINES);
    expect(selectFacts(facts, a).map((f) => f.key)).toEqual(FACT_KEYS.slice(0, 4));
    for (const f of facts) a[`about_${f.key}`] = noul(0.2);
    a['about_review'] = noul(0.4);
    expect(selectFacts(facts, a).map((f) => f.key)).toEqual(['review', 'what_it_is']);
    expect(selectFacts(facts, {}).map((f) => f.key)).toEqual(['what_it_is', 'mode_now']);
  });
});
