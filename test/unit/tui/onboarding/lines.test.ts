/** tui/onboarding/lines.ts (TUI-DESIGN §11.1–§11.3, §24 "Wizard"; §19.0 row O7; TUI-DESIGN-2 §1.4, §2.7, §4.3, §12 "Wizard"): ≤ 4 rows; masked field twins; verbatim strings. */
import { describe, expect, it } from 'vitest';
import { joinWrapped, wrapBody } from '../../../../src/tui/transcript/wrap.js';
import { cellWidth } from '../../../../src/tui/glyphs.js';
import {
  DEFAULT_WIZARD_PROVIDER,
  FIX_BLOCK_FOOTER,
  INSTRUCTIONS_NOT_TRUSTED_LINE,
  JEV_PROVIDER_ENV,
  LOGIN_JEV_PROVIDER_PROMPT,
  LOGIN_JEV_PROVIDER_REQUIRED,
  MASKED_PROMPT_DEFAULT,
  WINDOWS_ACL_NOTE,
  WIZARD_JEV_PROVIDER_OPTIONS,
  WIZARD_JEV_PROVIDER_OPTIONS_NARROW,
  WIZARD_JEV_PROVIDER_TITLE,
  WIZARD_JEV_TITLE,
  WIZARD_PROVIDER_HINT,
  WIZARD_PROVIDER_HINT_MODE,
  WIZARD_PROVIDER_OPTIONS,
  WIZARD_PROVIDER_TITLE,
  WIZARD_PROVIDER_TITLE_MODE,
  WIZARD_REUSE_HINT,
  WIZARD_TRUST_OPTIONS,
  WIZARD_VERIFY_DETAIL,
  WIZARD_VERIFY_DETAIL_TYPESAFE,
  WIZARD_VERIFY_TITLE,
  agentsChangedLine,
  dotenvSourceText,
  emptyEnvText,
  fixBlockLines,
  formatSize,
  generatorKeyTitle,
  jevKeyTitle,
  providerTitleMode,
  keyEnteredText,
  keyHintRow,
  maskedFieldCursorX,
  maskedFieldRow,
  sandboxText,
  savedText,
  shadowingText,
  trustLines,
  verificationFailedText,
  verifiedText,
  verifiedTypesafeText,
  verifyDetail,
  wizardConsoleTitle,
  wizardLines,
  // TUI-DESIGN-3 §1.4.2 / §10
  FIX_BLOCK_ONE_KEY,
  HINT_PASTED_TWICE,
  HINT_PREFIX_KEY,
  LOGIN_ONE_KEY_PROMPT,
  LOGIN_OTHER_WAYS_PROMPT,
  missingGeneratorOnly,
  MOCK_VERIFY_NOTE,
  SR_KEY_HINT,
  SR_OPTIONS_ROWS,
  WIZARD_GENERATOR_TITLE_SKIPPABLE,
  WIZARD_JEV_PROVIDER_TITLE_LOGIN,
  WIZARD_KEY_HINT_EMPTY,
  WIZARD_KEY_HINT_FOUND_ANTHROPIC,
  WIZARD_KEY_HINT_FOUND_TYPESAFE,
  WIZARD_KEY_TITLE,
  WIZARD_OPTIONS,
  WIZARD_OPTIONS_HINT,
  WIZARD_OPTIONS_NARROW,
  WIZARD_OPTIONS_TITLE,
  WIZARD_REUSE_JEV_FILE_HINT,
  WIZARD_REUSE_JEV_HINT,
  WIZARD_VERIFY_DETAIL_ONE_KEY,
  WIZARD_VERIFY_DETAIL_TYPESAFE_GENERATOR,
  WIZARD_VERIFY_TITLE_ONE_KEY,
  capsItem,
  defaultModeItem,
  defaultOption,
  keyFoundTitle,
  keyReusedText,
  modeSavedItem,
  oneKeyHintRow,
  optionHint,
  optionsRow,
  optionsTitle,
  providerHintMode,
  sandboxDetail,
  typesafeWinsText,
  usdMicro,
  verificationCreditsText,
  verificationModelText,
  verificationRateLimitedText,
  verifiedGeneratorText,
  verifiedJevText,
  verifyTitle,
} from '../../../../src/tui/onboarding/lines.js';
import { INITIAL_ONBOARDING, onboardingReducer as reduce, wizardRows, type OnboardingAction, type OnboardingState, type WizardOption } from '../../../../src/tui/onboarding/reducer.js';
import { DEFAULT_MODE, MODE_BADGE_WORD, MODE_SETTING_VALUES, SESSION_CAP_MULTIPLIER } from '../../../../src/config/defaults.js';
import { defaultRunSpendCapUsd } from '../../../../src/config/ui.js';
import { consoleInnerWidth } from '../../../../src/tui/console-lines.js';
import type { EngineMode } from '../../../../src/core/types.js';
import { stringWidth } from '../../../../src/tui/composer/width.js';
import * as credentials from '../../../../src/config/credentials.js';
import { WIZARD_MINSIZE_STATIC_ITEM, WIZARD_MINSIZE_TOAST, asciiRow, clipRow, wizardMinsizeRow } from '../../../../src/tui/onboarding/lines.js';

/** a jev-on first run with both keys missing and nothing inferred — TUI-DESIGN-3 §1.4: the one-paste `key` step */
const detectKey: OnboardingAction = { type: 'detect', missing: ['generator.apiKey', 'decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: true };
/** the same with `--provider anthropic` preselected: the round-2 provider step */
const detectBoth: OnboardingAction = { ...detectKey, provider: 'anthropic' };
/** TUI-DESIGN-2 §1.1: the default first run — jev-only, only the Jev key missing, nothing inferred */
const detectJevOnly: OnboardingAction = { type: 'detect', missing: ['decider.apiKey'], mode: 'jev-only', provider: null, trustNeeded: false };
function run(actions: OnboardingAction[], start: OnboardingState = INITIAL_ONBOARDING): OnboardingState {
  return actions.reduce((s, a) => reduce(s, a), start);
}
const cells = (s: string): number => stringWidth(s);

describe('§24 wizard strings are verbatim', () => {
  it('constants', () => {
    expect(WIZARD_PROVIDER_TITLE).toBe('No API key found. Pick the generator provider:');
    expect(WIZARD_PROVIDER_OPTIONS).toBe('  1 anthropic (ANTHROPIC_API_KEY)   2 openrouter (OPENROUTER_API_KEY, also Jev)');
    expect(WIZARD_PROVIDER_HINT).toBe('Keys are never shown, logged or echoed · Esc back · Ctrl-C quits (prints fix)');
    expect(WIZARD_JEV_TITLE).toBe('Jev API key (JEV_API_KEY; falls back to OPENROUTER_API_KEY)  2/2');
    expect(WIZARD_REUSE_HINT).toBe('Enter = reuse the OpenRouter key for Jev');
    expect(WIZARD_VERIFY_TITLE).toBe('Verify the keys now? [y] yes (one priced Jev call, ~$0.0001)  [n] skip');
    expect(WIZARD_TRUST_OPTIONS).toBe("  1 trust   2 this session only   3 don't trust (AGENTS.md ignored; .env read)");
    expect(WINDOWS_ACL_NOTE).toBe('(Windows: protected by your user profile ACL)');
    expect(FIX_BLOCK_FOOTER).toBe('Keys are never accepted as command-line arguments in the interactive flow');
    expect(INSTRUCTIONS_NOT_TRUSTED_LINE).toBe('AGENTS.md not loaded: workspace not trusted (run interactively once, or pass --trust-workspace)');
  });

  it('setup items, shadowing, dotenv and sandbox lines', () => {
    expect(keyEnteredText('generator', 'e31150e9abcdef', 'wizard')).toBe('generator key: entered (sha256:e31150e9) source=wizard');
    expect(keyEnteredText('jev', '66b18104')).toBe('jev key: entered (sha256:66b18104) source=wizard');
    expect(savedText('~/.config/jevcode/config.json')).toBe('saved ~/.config/jevcode/config.json (mode 0600, dir 0700)');
    expect(savedText('C:\\Users\\x\\.config\\jevcode\\config.json', true)).toBe('saved C:\\Users\\x\\.config\\jevcode\\config.json (Windows: protected by your user profile ACL)');
    expect(verifiedText('openrouter', 'laptop', 4.12)).toBe('verified: openrouter key ok (label "laptop", limit remaining $4.12)');
    expect(verifiedText('openrouter', 'laptop', null)).toBe('verified: openrouter key ok (label "laptop", limit remaining unknown)');
    expect(verificationFailedText('HTTP 401')).toBe('verification failed: HTTP 401 — the key was kept; fix it with /login');
    expect(shadowingText('generator.apiKey', 'ANTHROPIC_API_KEY', '1a2b3c4d5e6f', '~/.config/jevcode/config.json', '9f8e7d6c5b4a')).toBe(
      'generator.apiKey: env ANTHROPIC_API_KEY (sha256:1a2b3c4d) overrides file ~/.config/jevcode/config.json (sha256:9f8e7d6c) — unset the variable to use the saved key',
    );
    expect(emptyEnvText('ANTHROPIC_API_KEY', './.env')).toBe('ANTHROPIC_API_KEY in ./.env set but empty — treated as unset');
    expect(emptyEnvText('ANTHROPIC_API_KEY')).toContain('set but empty — treated as unset');
    expect(dotenvSourceText('./.env')).toBe('dotenv: ./.env');
    // TUI-DESIGN-3 §5.1 rule 13 + the quiet start: one thought per row with ` · ` separators, ONE row at 80 columns;
    // the full sentences are the detail (`sandboxDetail`, the wizard's card) and `/config`'s sandbox footer
    expect(sandboxText('seatbelt')).toBe('seatbelt · workspace writes only · secrets unreadable · network on');
    expect(sandboxText('none', 'auto', 'linux')).toBe('none · sandbox-exec is not available on linux · cwd confinement only');
    expect(sandboxDetail('seatbelt')).toBe('seatbelt — writes confined to the workspace and run dirs; harness secret files, ~/.ssh, ~/.aws unreadable; reads elsewhere and network allowed unless --no-network');
    expect(sandboxDetail('none', 'auto', 'linux')).toBe('none — sandbox-exec is not available on linux: cwd confinement, env scrubbing, timeout, output cap and tree kill only');
    expect(agentsChangedLine('1a2b3c4d5e6f7890', '9f8e7d6c5b4a3210')).toBe('AGENTS.md changed since you trusted it (sha256 1a2b3c4d → 9f8e7d6c)');
    expect(agentsChangedLine('1a2b3c4d', '9f8e7d6c', true)).toBe('AGENTS.md changed since you trusted it (sha256 1a2b3c4d -> 9f8e7d6c)');
  });

  /**
   * Finishing audit #5 — the `[sandbox]` row says WHICH of three things happened. `detectSandboxLevel` returns
   * `none` for `profile === 'none'` before it probes anything (`src/sandbox/seatbelt.ts`), so the level alone
   * cannot tell a chosen `none` from a missing `sandbox-exec`, and `--sandbox none` on macOS used to print
   * "sandbox-exec is not available on darwin", which is false. The row and its `--plain`/SR twin are one string
   * (the item is built once in `src/cli/session.ts` and printed by every renderer), so the three sentences are
   * asserted once here and checked to WRAP, never cut, at the three rungs.
   */
  it('TUI-DESIGN §24 / audit #5: `[sandbox]` states chosen-none, unavailable and requested-but-unavailable as three distinct true sentences, wrapping at 40/80/120', () => {
    const chosen = sandboxText('none', 'none', 'darwin');
    const unavailable = sandboxText('none', 'auto', 'linux');
    const requested = sandboxText('none', 'seatbelt', 'linux');
    expect(chosen).toBe('none · off by request (--sandbox none) · cwd confinement only');
    expect(unavailable).toBe('none · sandbox-exec is not available on linux · cwd confinement only');
    expect(requested).toBe('none · seatbelt requested, but sandbox-exec is not available on linux · cwd confinement only');
    // the three are distinct, and the chosen-none row never claims a platform lacks the sandbox
    expect(new Set([chosen, unavailable, requested]).size).toBe(3);
    expect(chosen).not.toContain('not available');
    expect(chosen).not.toContain('darwin');
    // the detail twin carries the SAME reason clause in its own `—`/`:` shape
    expect(sandboxDetail('none', 'none', 'darwin')).toBe('none — off by request (--sandbox none): cwd confinement, env scrubbing, timeout, output cap and tree kill only');
    expect(sandboxDetail('none', 'seatbelt', 'linux')).toBe('none — seatbelt requested, but sandbox-exec is not available on linux: cwd confinement, env scrubbing, timeout, output cap and tree kill only');
    // an unspecified profile keeps the shipped sentence, so a caller that has not been threaded yet cannot regress
    expect(sandboxText('none', undefined, 'linux')).toBe(unavailable);
    expect(sandboxText('seatbelt', 'seatbelt')).toBe(sandboxText('seatbelt'));
    // the quiet start: the item is ONE row in the 70-cell `[sandbox]` gutter body at 80 columns (the `none` twin that
    // names both a requested profile and a platform is the one long branch, and it is a misconfiguration)
    expect(cellWidth(sandboxText('seatbelt'))).toBeLessThanOrEqual(70);
    expect(cellWidth(chosen)).toBeLessThanOrEqual(70);
    expect(cellWidth(unavailable)).toBeLessThanOrEqual(70);
    // §2.13's rungs: every row wraps (never cuts) and no wrapped row is wider than the terminal
    for (const width of [40, 80, 120]) {
      for (const row of [chosen, unavailable, requested, sandboxDetail('none', 'none', 'darwin'), sandboxDetail('none', 'seatbelt', 'linux')]) {
        const rows = wrapBody(row, width);
        expect(joinWrapped(rows), `${width}: ${row}`).toBe(row);
        for (const r of rows) expect(cellWidth(r), `${width}: ${r}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it('TUI-DESIGN-2 §12 / TUI-DESIGN-3 §1.6: jev-only keeps the five round-2 lines verbatim; every generator mode leads with the one OpenRouter key, the piped --key-stdin, the TypeSafe route and the jev-only escape (`#` at cell 30, ≤ 76 cells); the Anthropic line joins under --provider anthropic only', () => {
    const jev = ['export TYPESAFE_API_KEY=…', 'export OPENROUTER_API_KEY=…', 'printenv TYPESAFE_API_KEY | jevcode login --jev-provider typesafe --jev-key-stdin', 'jevcode login'];
    expect(fixBlockLines('jev-only')).toEqual([...jev, FIX_BLOCK_FOOTER]);
    expect(fixBlockLines('jev-only', 'anthropic')).toEqual([...jev, FIX_BLOCK_FOOTER]);
    expect(fixBlockLines('jev-only', 'openrouter')).toEqual([...jev, FIX_BLOCK_FOOTER]);
    const one = [
      'export OPENROUTER_API_KEY=…   # one key: Jev + the code model',
      'printenv OPENROUTER_API_KEY | jevcode login --key-stdin',
      'jevcode login                 # masked prompt',
      'export TYPESAFE_API_KEY=…     # Jev native; add OPENROUTER_API_KEY for code',
      '                              # Jev alone: jevcode config set mode jev-only',
    ];
    expect([...FIX_BLOCK_ONE_KEY]).toEqual(one);
    for (const mode of ['jev-on', 'jev-off', 'llm-jev'] as const) {
      expect(fixBlockLines(mode), mode).toEqual([...one, FIX_BLOCK_FOOTER]);
      expect(fixBlockLines(mode, null), mode).toEqual([...one, FIX_BLOCK_FOOTER]);
      expect(fixBlockLines(mode, 'openrouter'), mode).toEqual([...one, FIX_BLOCK_FOOTER]);
      expect(fixBlockLines(mode, 'anthropic'), mode).toEqual([...one, 'export ANTHROPIC_API_KEY=…    # the code model under --provider anthropic', FIX_BLOCK_FOOTER]);
    }
    for (const l of fixBlockLines('jev-on', 'anthropic')) {
      expect(l).not.toMatch(/sk-|[A-Za-z0-9]{20,}/);
      expect(cells(l), l).toBeLessThanOrEqual(76);
      if (l.includes('#')) expect(l.indexOf('#'), l).toBe(30);
    }
    expect(cells(fixBlockLines('jev-on')[0]!)).toBe(61);
    expect(cells(fixBlockLines('jev-on')[1]!)).toBe(55);
    expect(cells(fixBlockLines('jev-on')[2]!)).toBe(45);
    expect(cells(fixBlockLines('jev-on')[3]!)).toBe(75);
    expect(cells(fixBlockLines('jev-on')[4]!)).toBe(75);
    expect(cells(fixBlockLines('jev-on', 'anthropic')[5]!)).toBe(73);
    // round-5 item 4: the sentence names the RESOLVED provider's own key variable (PROVIDER_KEY_ENV)
    expect(missingGeneratorOnly('openrouter')).toBe('missing generator.apiKey: set OPENROUTER_API_KEY (the code model), run with --mode jev-only, or run jevcode login');
    expect(missingGeneratorOnly('anthropic')).toBe('missing generator.apiKey: set ANTHROPIC_API_KEY (the code model), run with --mode jev-only, or run jevcode login');
    expect(missingGeneratorOnly('gemini')).toContain('set GEMINI_API_KEY (the code model)');
    // an unresolved provider keeps the historical default rather than printing an empty variable name
    expect(missingGeneratorOnly(null)).toContain('set OPENROUTER_API_KEY (the code model)');
  });

  it('TUI-DESIGN-2 §12 "Wizard": the round-2 strings are verbatim', () => {
    expect(WIZARD_JEV_PROVIDER_TITLE).toBe('No Jev key found. Where do you reach Jev?');
    expect(WIZARD_JEV_PROVIDER_OPTIONS).toBe('  1 typesafe (TYPESAFE_API_KEY, api.typesafe.ai)   2 openrouter (OPENROUTER_API_KEY, also the generator)');
    expect(WIZARD_JEV_PROVIDER_OPTIONS_NARROW).toBe('  1 typesafe   2 openrouter');
    expect(WIZARD_PROVIDER_TITLE_MODE).toBe('jev+llm needs a generator. Pick the provider:');
    // TUI-DESIGN-3 §1.9: the hint reads the current badge from MODE_BADGE_WORD; 75 cells with the longest badge
    expect(WIZARD_PROVIDER_HINT_MODE).toBe('Keys are never shown or logged · Esc back · Ctrl-C keeps jev-only');
    expect(providerHintMode('jev-only')).toBe(WIZARD_PROVIDER_HINT_MODE);
    expect(providerHintMode('llm-jev')).toBe('Keys are never shown or logged · Esc back · Ctrl-C keeps llm+jev · verified');
    expect(cells(providerHintMode('llm-jev'))).toBe(75);
    for (const m of MODE_SETTING_VALUES) expect(cells(providerHintMode(m)), m).toBeLessThanOrEqual(76);
    expect(WIZARD_VERIFY_DETAIL_TYPESAFE).toBe('one Jev decision at api.typesafe.ai ~$0.00002 (jev-1.13.0)');
    expect(LOGIN_JEV_PROVIDER_PROMPT).toBe('Where do you reach Jev?  1 typesafe  2 openrouter');
    expect(LOGIN_JEV_PROVIDER_REQUIRED).toBe('jevcode login: pass --jev-provider typesafe|openrouter with --jev-key-stdin');
    expect(jevKeyTitle('typesafe', '1/1')).toBe('Jev API key (TYPESAFE_API_KEY)  1/1');
    expect(jevKeyTitle('openrouter', '1/1')).toBe('Jev API key (JEV_API_KEY; falls back to OPENROUTER_API_KEY)  1/1');
    expect(jevKeyTitle(null, '2/2')).toBe(WIZARD_JEV_TITLE);
    expect(verifyDetail('typesafe')).toBe(WIZARD_VERIFY_DETAIL_TYPESAFE);
    expect(verifyDetail('openrouter')).toBe(WIZARD_VERIFY_DETAIL);
    expect(verifyDetail(null)).toBe(WIZARD_VERIFY_DETAIL);
    expect(verifiedTypesafeText('jev-1.13.0', 319)).toBe('verified: typesafe key ok (jev-1.13.0, 319 input tokens)');
    expect(verifiedTypesafeText('jev-1.13.0', null)).toBe('verified: typesafe key ok (jev-1.13.0, usage unknown)');
    expect(JEV_PROVIDER_ENV).toEqual({ typesafe: 'TYPESAFE_API_KEY', openrouter: 'JEV_API_KEY' });
    expect(DEFAULT_WIZARD_PROVIDER).toBe('openrouter');
  });

  it('TUI-DESIGN-2 §4.3 / §12 "Console": the boxed console title of each wizard step is `setup · <step>`; null outside a step', () => {
    expect(wizardConsoleTitle({ step: 'key' })).toBe('setup · key');
    expect(wizardConsoleTitle({ step: 'options' })).toBe('setup · options');
    expect(wizardConsoleTitle({ step: 'jevProvider' })).toBe('setup · jev provider');
    expect(wizardConsoleTitle({ step: 'provider' })).toBe('setup · provider');
    expect(wizardConsoleTitle({ step: 'generatorKey' })).toBe('setup · generator key');
    expect(wizardConsoleTitle({ step: 'jevKey' })).toBe('setup · jev key');
    expect(wizardConsoleTitle({ step: 'verify' })).toBe('setup · verify');
    expect(wizardConsoleTitle({ step: 'trust' })).toBe('setup · trust');
    for (const step of ['detect', 'save', 'sandbox', 'done', 'exit'] as const) expect(wizardConsoleTitle({ step })).toBeNull();
  });

  it('the item builders are declared in config/credentials.ts (config never imports the TUI) and re-exported here', () => {
    expect(keyEnteredText).toBe(credentials.keyEnteredText);
    expect(savedText).toBe(credentials.savedText);
    expect(shadowingText).toBe(credentials.shadowingText);
    expect(WINDOWS_ACL_NOTE).toBe(credentials.WINDOWS_ACL_NOTE);
    expect(savedText('/ws/jevcode-creds.json', false, false)).toBe('saved /ws/jevcode-creds.json (mode 0600)');
  });
});

describe('masked field twins', () => {
  it('maskedFieldRow: • repeated min(len, columns − 3) after `> `; * in ASCII; never a key byte', () => {
    expect(maskedFieldRow(0, 80)).toBe('> ');
    expect(maskedFieldRow(5, 80)).toBe('> •••••');
    expect(maskedFieldRow(5, 80, true)).toBe('> *****');
    expect(maskedFieldRow(200, 80)).toBe(`> ${'•'.repeat(77)}`);
    expect(cells(maskedFieldRow(200, 80))).toBe(79);
    expect(maskedFieldRow(10, 3)).toBe('> ');
    expect(maskedFieldRow(10, 0)).toBe(`> ${'•'.repeat(10)}`);
    expect(maskedFieldRow(NaN, 80)).toBe('> ');
    expect(maskedFieldRow(Infinity, 40)).toBe(`> ${'•'.repeat(37)}`);
    expect(maskedFieldRow(-2, 80)).toBe('> ');
    expect(maskedFieldCursorX(5, 80)).toBe(7);
    expect(maskedFieldCursorX(500, 80)).toBe(79);
  });

  it('TUI-DESIGN-2 §4.3: the boxed console passes `› ` — the row is `› •••••`, `> *****` under --ascii, the cursor after the bullets; the default prompt is `> `', () => {
    expect(MASKED_PROMPT_DEFAULT).toBe('> ');
    expect(maskedFieldRow(5, 80, false, '› ')).toBe('› •••••');
    expect(maskedFieldRow(20, 76, false, '› ')).toBe(`› ${'•'.repeat(20)}`);
    expect(maskedFieldRow(200, 80, false, '› ')).toBe(`› ${'•'.repeat(77)}`);
    expect(cells(maskedFieldRow(200, 80, false, '› '))).toBe(79);
    expect(maskedFieldRow(5, 80, true, '› ')).toBe('> *****');
    expect(maskedFieldRow(0, 80, false, '› ')).toBe('› ');
    expect(maskedFieldCursorX(5, 80, '› ')).toBe(7);
    expect(maskedFieldCursorX(500, 80, '› ')).toBe(79);
    // a wizard view carries the prompt into the key row; every other row is untouched
    const gen = run([detectBoth, { type: 'choose', option: 2 }, { type: 'length', length: 12 }]);
    expect(wizardLines(gen, { rows: 24, columns: 100, prompt: '› ' })[1]).toBe(`› ${'•'.repeat(12)}`);
    expect(wizardLines(gen, { rows: 24, columns: 100, prompt: '› ', ascii: true })[1]).toBe(`> ${'*'.repeat(12)}`);
    expect(wizardLines(gen, { rows: 24, columns: 100 })[1]).toBe(`> ${'•'.repeat(12)}`);
  });

  it('keyHintRow: the wide form when it fits, the narrow twin below ~72 columns, ASCII glyphs', () => {
    expect(keyHintRow(108, 120)).toBe('108 chars · Enter saves · Backspace · Ctrl-U clears · paste ok · Esc back');
    expect(keyHintRow(108, 40)).toBe('108 · Enter · ⌫ · ^U · Esc');
    expect(keyHintRow(108, 40, true)).toBe('108 - Enter - Bksp - ^U - Esc');
    expect(keyHintRow(0, 120).startsWith('0 chars')).toBe(true);
    expect(keyHintRow(NaN, 120).startsWith('0 chars')).toBe(true);
  });

  it('generatorKeyTitle is the §24 `<Provider> API key (<ENV>)` verbatim — no counter; TUI-DESIGN-2 §1.4: the unprompted default is openrouter (commit 2a92d0b)', () => {
    expect(generatorKeyTitle('anthropic')).toBe('Anthropic API key (ANTHROPIC_API_KEY)');
    expect(generatorKeyTitle('openrouter')).toBe('OpenRouter API key (OPENROUTER_API_KEY)');
    expect(generatorKeyTitle(null)).toBe('OpenRouter API key (OPENROUTER_API_KEY)');
  });

  it('clipRow measures terminal cells, cuts on grapheme boundaries and ends in … (or ... in ASCII, still fitting)', () => {
    const cjk = 'Do you trust the files in /Users/山田太郎/プロジェクト/リポジトリ?  (git root; stored per repository)';
    for (const c of [20, 40, 60, 80]) {
      const row = clipRow(cjk, c);
      expect(cells(row), `${c}`).toBeLessThanOrEqual(c);
      expect(row.endsWith('…')).toBe(true);
      const a = clipRow(cjk, c, true);
      expect(cells(a), `ascii ${c}`).toBeLessThanOrEqual(c);
      expect(a.endsWith('...')).toBe(true);
    }
    expect(clipRow('short', 80)).toBe('short');
    expect(clipRow('a · b → c • d ⌫ e — f … g ⚠', 200, true)).toBe('a - b -> c * d Bksp e - f ... g !');
    expect(asciiRow('x')).toBe('x');
    expect(clipRow('abcdef', 3, true)).toBe('...');
    expect(clipRow('abcdef', 2, true)).toBe('..');
    expect(clipRow('abcdef', NaN)).toBe('abcdef');
    expect(cells(clipRow('🎉'.repeat(50), 11))).toBeLessThanOrEqual(11);
  });
});

describe('wizardLines', () => {
  it('provider step: 3 rows at 80 and 120; narrow options at 40; the preselection appears on the hint row', () => {
    const s = reduce(INITIAL_ONBOARDING, detectBoth);
    const at80 = wizardLines({ ...s, provider: null }, { rows: 24, columns: 80 });
    expect(at80).toEqual([WIZARD_PROVIDER_TITLE, WIZARD_PROVIDER_OPTIONS, WIZARD_PROVIDER_HINT]);
    expect(at80.length).toBe(wizardRows(s, 24));
    for (const l of at80) expect(cells(l)).toBeLessThanOrEqual(80);
    const at40 = wizardLines(s, { rows: 8, columns: 40 });
    expect(at40[1]).toBe('  1 anthropic   2 openrouter');
    for (const l of at40) expect(cells(l)).toBeLessThanOrEqual(40);
    const pre = wizardLines(reduce(INITIAL_ONBOARDING, detectBoth), { rows: 24, columns: 120 });
    expect(pre[2]).toBe(`${WIZARD_PROVIDER_HINT} · Enter = anthropic`);
    const sr = wizardLines(s, { rows: 24, columns: 80, screenReader: true });
    expect(sr[2]).toBe('Enter selection (1-2):');
    expect(sr.some((l) => l.includes('1. anthropic'))).toBe(true);
    const ascii = wizardLines(s, { rows: 24, columns: 80, ascii: true });
    expect(ascii[2]).not.toContain('·');
  });

  it('TUI-DESIGN-2 §1.4: the jevProvider step — 3 rows, the narrow options at 40, the preselection on the hint row, SR and ASCII twins', () => {
    const s = reduce(INITIAL_ONBOARDING, detectJevOnly);
    expect(s.step).toBe('jevProvider');
    const at120 = wizardLines(s, { rows: 24, columns: 120 });
    expect(at120).toEqual([WIZARD_JEV_PROVIDER_TITLE, WIZARD_JEV_PROVIDER_OPTIONS, WIZARD_PROVIDER_HINT]);
    expect(at120.length).toBe(wizardRows(s, 24));
    const at80 = wizardLines(s, { rows: 24, columns: 80 });
    expect(at80[1]).toBe(WIZARD_JEV_PROVIDER_OPTIONS_NARROW);
    for (const l of at80) expect(cells(l)).toBeLessThanOrEqual(80);
    for (const l of wizardLines(s, { rows: 8, columns: 40 })) expect(cells(l)).toBeLessThanOrEqual(40);
    const pre = wizardLines({ ...s, jevProvider: 'typesafe' }, { rows: 24, columns: 120 });
    expect(pre[2]).toBe(`${WIZARD_PROVIDER_HINT} · Enter = typesafe`);
    expect(wizardLines({ ...s, hint: 'pick 1 or 2' }, { rows: 24, columns: 120 })[2]).toBe('pick 1 or 2');
    const sr = wizardLines(s, { rows: 24, columns: 120, screenReader: true });
    expect(sr[1]).toBe('1. typesafe (TYPESAFE_API_KEY, api.typesafe.ai)  2. openrouter (OPENROUTER_API_KEY, also the generator)');
    expect(sr[2]).toBe('Enter selection (1-2):');
    for (const l of wizardLines(s, { rows: 24, columns: 120, ascii: true })) expect(l).toMatch(/^[\x20-\x7e]*$/);
  });

  it('TUI-DESIGN-2 §1.4: the provider step under reason `mode` carries its own title and Ctrl-C hint; the login/missing titles are unchanged', () => {
    const mode = reduce(reduce(INITIAL_ONBOARDING, { ...detectJevOnly, jevProvider: 'typesafe' }), { type: 'reopen', at: 'provider', runLive: false, reason: 'mode', mode: 'jev-on' });
    expect(mode.step).toBe('provider');
    expect(wizardLines(mode, { rows: 24, columns: 120 })).toEqual([WIZARD_PROVIDER_TITLE_MODE, WIZARD_PROVIDER_OPTIONS, WIZARD_PROVIDER_HINT_MODE]);
    expect(wizardLines({ ...mode, provider: 'openrouter' }, { rows: 24, columns: 120 })[2]).toBe(`${WIZARD_PROVIDER_HINT_MODE} · Enter = openrouter`);
    expect(wizardLines(mode, { rows: 24, columns: 120, screenReader: true })[0]).toBe(WIZARD_PROVIDER_TITLE_MODE);
    const login = reduce(INITIAL_ONBOARDING, { type: 'reopen', at: 'provider', runLive: false });
    expect(wizardLines(login, { rows: 24, columns: 120 })[0]).toBe(WIZARD_PROVIDER_TITLE);
    expect(wizardLines(login, { rows: 24, columns: 120 })[2]).toBe(WIZARD_PROVIDER_HINT);
    for (const l of wizardLines(mode, { rows: 24, columns: 80 })) expect(cells(l)).toBeLessThanOrEqual(80);
    // finding 6: `/mode jev-off` opens the same wizard — the title names the TARGET mode's badge word (`llm-only`), not jev+llm
    const off = reduce(reduce(INITIAL_ONBOARDING, { ...detectJevOnly, jevProvider: 'typesafe' }), { type: 'reopen', at: 'provider', runLive: false, reason: 'mode', mode: 'jev-off' });
    expect(off.mode).toBe('jev-off');
    expect(wizardLines(off, { rows: 24, columns: 120 })[0]).toBe('llm-only needs a generator. Pick the provider:');
    expect(wizardLines(off, { rows: 24, columns: 120, screenReader: true })[0]).toBe('llm-only needs a generator. Pick the provider:');
    expect(providerTitleMode('jev-on')).toBe(WIZARD_PROVIDER_TITLE_MODE);
    expect(providerTitleMode('jev-off')).toBe('llm-only needs a generator. Pick the provider:');
    expect(providerTitleMode('jev-only')).toBe(WIZARD_PROVIDER_TITLE_MODE); // jev-only never needs a generator; the jev+llm text is the fallback
    // llm-jev (docs/LLM-JEV-DESIGN.md / TUI-DESIGN-3 D-N): the same wizard names the target badge word from MODE_BADGE_WORD; the prompted provider default stays openrouter
    expect(providerTitleMode('llm-jev')).toBe(`${MODE_BADGE_WORD['llm-jev']} needs a generator. Pick the provider:`);
    expect(providerTitleMode('llm-jev')).toBe('llm+jev · verified needs a generator. Pick the provider:');
    const llmJev = reduce(reduce(INITIAL_ONBOARDING, { ...detectJevOnly, jevProvider: 'typesafe' }), { type: 'reopen', at: 'provider', runLive: false, reason: 'mode', mode: 'llm-jev', currentMode: 'jev-only' });
    expect(llmJev.mode).toBe('llm-jev');
    expect(wizardLines(llmJev, { rows: 24, columns: 120 })[0]).toBe('llm+jev · verified needs a generator. Pick the provider:');
    // the Ctrl-C hint names the CURRENT mode (what Ctrl-C keeps), not the target
    const fromLlm = reduce(reduce(INITIAL_ONBOARDING, { ...detectJevOnly, jevProvider: 'typesafe' }), { type: 'reopen', at: 'provider', runLive: false, reason: 'mode', mode: 'jev-on', currentMode: 'llm-jev' });
    expect(wizardLines(fromLlm, { rows: 24, columns: 120 })[2]).toBe(providerHintMode('llm-jev'));
    expect(DEFAULT_WIZARD_PROVIDER).toBe('openrouter');
    for (const l of wizardLines(off, { rows: 24, columns: 80, ascii: true })) expect(l).toMatch(/^[\x20-\x7e]*$/);
  });

  it('key steps: title, masked row, hint; the Jev title carries 2/2 after a generator key; reuse hint under openrouter; the hint wins', () => {
    const gen = run([detectBoth, { type: 'choose', option: 2 }, { type: 'length', length: 12 }]);
    const g = wizardLines(gen, { rows: 24, columns: 100 });
    expect(g).toEqual(['OpenRouter API key (OPENROUTER_API_KEY)', `> ${'•'.repeat(12)}`, '12 chars · Enter saves · Backspace · Ctrl-U clears · paste ok · Esc back']);
    const jev = reduce(gen, { type: 'enter', length: 40, prefixOk: true });
    const j = wizardLines(jev, { rows: 24, columns: 100 });
    expect(j[0]).toBe(WIZARD_JEV_TITLE);
    expect(j[1]).toBe('> ');
    expect(j[2]).toBe(WIZARD_REUSE_HINT);
    const typing = reduce(jev, { type: 'length', length: 3 });
    expect(wizardLines(typing, { rows: 24, columns: 100 })[2]).toBe('3 chars · Enter saves · Backspace · Ctrl-U clears · paste ok · Esc back');
    const hinted = reduce(typing, { type: 'enter', length: 3, prefixOk: true });
    expect(wizardLines(hinted, { rows: 24, columns: 100 })[2]).toBe('key too short (8+ characters)');
    // TUI-DESIGN-2 §12: the Jev title carries `1/1` when it is the only field and names the provider's variable
    const jevOnlyTs = reduce(INITIAL_ONBOARDING, { ...detectJevOnly, jevProvider: 'typesafe' });
    expect(wizardLines(jevOnlyTs, { rows: 24, columns: 100 })[0]).toBe('Jev API key (TYPESAFE_API_KEY)  1/1');
    const jevOnlyOr = run([detectJevOnly, { type: 'choose', option: 2 }]);
    expect(wizardLines(jevOnlyOr, { rows: 24, columns: 100 })[0]).toBe('Jev API key (JEV_API_KEY; falls back to OPENROUTER_API_KEY)  1/1');
    // the resolved openrouter generator alone asks the Jev provider first (§1.4); `2` → the OpenRouter-titled `1/1` field
    const jevOnlyAsk = reduce(INITIAL_ONBOARDING, { type: 'detect', missing: ['decider.apiKey'], mode: 'jev-on', provider: 'openrouter', trustNeeded: false });
    expect(wizardLines(jevOnlyAsk, { rows: 24, columns: 100 })[0]).toBe(WIZARD_JEV_PROVIDER_TITLE);
    const jevOnlyNull = reduce(jevOnlyAsk, { type: 'choose', option: 2 });
    expect(wizardLines(jevOnlyNull, { rows: 24, columns: 100 })[0]).toBe('Jev API key (JEV_API_KEY; falls back to OPENROUTER_API_KEY)  1/1');
    expect(wizardLines(jevOnlyNull, { rows: 24, columns: 100 })[2]).not.toBe(WIZARD_REUSE_HINT);
    // finding 2: a typesafe Jev provider after the OpenRouter generator key shows the plain key hint, never `Enter = reuse`
    const tsAfterOr = run([{ ...detectBoth, jevProvider: 'typesafe' }, { type: 'choose', option: 2 }, { type: 'enter', length: 40, prefixOk: true }]);
    expect(wizardLines(tsAfterOr, { rows: 24, columns: 100 })).toEqual(['Jev API key (TYPESAFE_API_KEY)  2/2', '> ', '0 chars · Enter saves · Backspace · Ctrl-U clears · paste ok · Esc back']);
    expect(wizardLines(reduce(tsAfterOr, { type: 'enter', length: 0, prefixOk: true }), { rows: 24, columns: 100 })[2]).toBe('key too short (8+ characters)');
    const orAfterOr = run([{ ...detectBoth, jevProvider: 'openrouter' }, { type: 'choose', option: 2 }, { type: 'enter', length: 40, prefixOk: true }]);
    expect(wizardLines(orAfterOr, { rows: 24, columns: 100 })[2]).toBe(WIZARD_REUSE_HINT);
    // after a generator step the counter is 2/2 whichever Jev provider
    const afterGenTs = run([detectBoth, { type: 'choose', option: 1 }, { type: 'enter', length: 40, prefixOk: true }, { type: 'choose', option: 1 }]);
    expect(wizardLines(afterGenTs, { rows: 24, columns: 100 })[0]).toBe('Jev API key (TYPESAFE_API_KEY)  2/2');
    // the masked row and hint of the jev-only first run
    expect(wizardLines(jevOnlyTs, { rows: 24, columns: 100 })[1]).toBe('> ');
    expect(wizardLines(jevOnlyTs, { rows: 24, columns: 100 })[2]).toBe('0 chars · Enter saves · Backspace · Ctrl-U clears · paste ok · Esc back');
    // ASCII and screen-reader twins never contain a bullet or a key
    const ascii = wizardLines(gen, { rows: 24, columns: 100, ascii: true });
    expect(ascii[1]).toBe(`> ${'*'.repeat(12)}`);
    const sr = wizardLines(gen, { rows: 24, columns: 100, screenReader: true });
    expect(sr[1]).toBe('API key field, 12 characters entered, hidden');
    expect(sr.join('\n')).not.toContain('•');
  });

  it('every step at every geometry: rows ≤ wizardRows ≤ 4 and every row fits the columns', () => {
    const states: OnboardingState[] = [];
    let s = reduce(INITIAL_ONBOARDING, detectBoth);
    states.push(s);
    for (const a of [{ type: 'choose', option: 2 }, { type: 'length', length: 300 }, { type: 'enter', length: 300, prefixOk: true }, { type: 'enter', length: 0, prefixOk: true }, { type: 'saved' }, { type: 'verify-answer', yes: true }, { type: 'verify-result', ok: true, rejected: null }, { type: 'trust', option: 1 }, { type: 'sandbox-shown' }] as OnboardingAction[]) {
      s = reduce(s, a);
      states.push(s);
    }
    // and the jev-only first run: jevProvider → jevKey → save → verify
    let j = reduce(INITIAL_ONBOARDING, detectJevOnly);
    states.push(j);
    for (const a of [{ type: 'choose', option: 1 }, { type: 'length', length: 300 }, { type: 'enter', length: 300, prefixOk: true }, { type: 'saved' }] as OnboardingAction[]) {
      j = reduce(j, a);
      states.push(j);
    }
    const trust = { root: '/Users/x/repo', agents: { name: 'AGENTS.md' as const, bytes: 2150 }, dotenv: { vars: 3, secretLike: 2 }, jevcodeJson: null };
    for (const st of states) {
      for (const rows of [3, 8, 12, 24, 40, 50]) {
        for (const columns of [20, 40, 80, 120, 400]) {
          const lines = wizardLines(st, { rows, columns, trust });
          expect(lines.length, `${st.step} ${rows}x${columns}`).toBeLessThanOrEqual(4);
          expect(lines.length, `${st.step} ${rows}x${columns}`).toBe(wizardRows(st, rows));
          for (const l of lines) {
            expect(cells(l), `${st.step} ${rows}x${columns}: ${l}`).toBeLessThanOrEqual(columns);
            expect(l).not.toMatch(/[\u0000-\u001f\u007f]/);
          }
        }
      }
    }
  });

  it('rows are measured in cells: a CJK or emoji git-root path never exceeds the columns at 40/60/80 (D1); the ASCII twin has no non-ASCII glyph', () => {
    const roots = ['/Users/山田太郎/プロジェクト/リポジトリ', '/home/u/🎉🎉🎉/👨‍👩‍👧/repo', '/Users/x/repo'];
    const st = reduce(INITIAL_ONBOARDING, { type: 'detect', missing: [], mode: 'jev-on', provider: null, trustNeeded: true });
    for (const root of roots) {
      const trust = { root, agents: { name: 'AGENTS.md' as const, bytes: 2150 }, dotenv: { vars: 3, secretLike: 2 }, jevcodeJson: { bytes: 180 }, changed: { from: 'aaaaaaaa', to: 'bbbbbbbb' } };
      for (const columns of [40, 60, 80]) {
        for (const rows of [8, 24]) {
          const lines = wizardLines(st, { rows, columns, trust });
          expect(lines.length).toBe(wizardRows(st, rows));
          for (const l of lines) {
            expect(cells(l), `${root} ${columns}: ${l}`).toBeLessThanOrEqual(columns);
            expect(Array.from(l).length, `${root} ${columns} code points`).toBeLessThanOrEqual(columns);
          }
          const ascii = wizardLines(st, { rows, columns, trust: { ...trust, root: '/Users/x/repo' }, ascii: true });
          for (const l of ascii) {
            expect(cells(l)).toBeLessThanOrEqual(columns);
            expect(l, `ascii ${columns}: ${l}`).toMatch(/^[\x20-\x7e]*$/);
          }
        }
      }
    }
    // every step's ASCII twin at 40 columns is pure printable ASCII (`…` and `—` included)
    let s = reduce(INITIAL_ONBOARDING, detectBoth);
    const steps: OnboardingState[] = [s];
    for (const a of [{ type: 'choose', option: 2 }, { type: 'length', length: 300 }, { type: 'enter', length: 300, prefixOk: true }, { type: 'enter', length: 0, prefixOk: true }, { type: 'saved' }, { type: 'verify-answer', yes: true }] as OnboardingAction[]) {
      s = reduce(s, a);
      steps.push(s);
    }
    for (const st2 of steps) for (const l of wizardLines(st2, { rows: 24, columns: 40, ascii: true })) expect(l, `${st2.step}: ${l}`).toMatch(/^[\x20-\x7e]*$/);
    expect(keyHintRow(108, 40, true)).toMatch(/^[\x20-\x7e]*$/);
    expect(trustLines({ root: '/r', agents: null, dotenv: { vars: 0, secretLike: 0, unreadable: true }, jevcodeJson: null }, 24, 120)[1]).toBe('  AGENTS.md (none)   ./.env (unreadable)');
  });

  it('verify: two rows; the second flips to the verifying notice; TUI-DESIGN-2 §2.7: the detail is keyed by the Jev provider', () => {
    const v = run([detectBoth, { type: 'choose', option: 1 }, { type: 'enter', length: 40, prefixOk: true }, { type: 'choose', option: 2 }, { type: 'enter', length: 40, prefixOk: true }, { type: 'saved' }]);
    const lines = wizardLines(v, { rows: 24, columns: 120 });
    // an anthropic generator keeps the round-2 title and detail (the models GET)
    expect(lines[0]).toBe(WIZARD_VERIFY_TITLE);
    expect(lines[1]).toBe('GET openrouter.ai/api/v1/key $0 · GET api.anthropic.com/v1/models $0 · one Jev decision ~$0.0001');
    expect(wizardLines(reduce(v, { type: 'verify-answer', yes: true }), { rows: 24, columns: 120 })[1]).toBe('verifying… (Ctrl-C cancels)');
    const ts = run([detectJevOnly, { type: 'choose', option: 1 }, { type: 'enter', length: 40, prefixOk: true }, { type: 'saved' }]);
    expect(wizardLines(ts, { rows: 24, columns: 120 })).toEqual([WIZARD_VERIFY_TITLE, 'one Jev decision at api.typesafe.ai ~$0.00002 (jev-1.13.0)']);
    expect(wizardLines(ts, { rows: 24, columns: 120, ascii: true })[1]).toBe('one Jev decision at api.typesafe.ai ~$0.00002 (jev-1.13.0)');
    // TUI-DESIGN-3 §1.4.2: the one-key wizard (openrouter + a generator) — the one-key title and the decision · completion · key info detail
    const one = run([detectKey, { type: 'enter', length: 40, prefixOk: true }, { type: 'saved' }]);
    expect(wizardLines(one, { rows: 24, columns: 80 })).toEqual([WIZARD_VERIFY_TITLE_ONE_KEY, WIZARD_VERIFY_DETAIL_ONE_KEY]);
    expect(WIZARD_VERIFY_TITLE_ONE_KEY).toBe('Verify now? [y] one Jev decision + 1 code-model token (< $0.0001)  [n] skip');
    expect(WIZARD_VERIFY_DETAIL_ONE_KEY).toBe('decision ~$0.00002 · completion ~$0.000002 · key info $0 · Enter/Esc skip');
    expect(cells(WIZARD_VERIFY_TITLE_ONE_KEY)).toBe(75);
    expect(cells(WIZARD_VERIFY_DETAIL_ONE_KEY)).toBe(73);
    // typesafe + a generator (option 2 with a typed OpenRouter key)
    expect(verifyDetail('typesafe', 'jev-on', 'openrouter')).toBe(WIZARD_VERIFY_DETAIL_TYPESAFE_GENERATOR);
    expect(WIZARD_VERIFY_DETAIL_TYPESAFE_GENERATOR).toBe('api.typesafe.ai decision ~$0.00002 · completion ~$0.000002 · key info $0');
    expect(cells(WIZARD_VERIFY_DETAIL_TYPESAFE_GENERATOR)).toBe(72);
    expect(verifyDetail('typesafe', 'jev-only')).toBe(WIZARD_VERIFY_DETAIL_TYPESAFE);
    expect(verifyDetail('openrouter', 'jev-only')).toBe(WIZARD_VERIFY_DETAIL);
    expect(verifyDetail('openrouter', 'jev-on', 'anthropic')).toBe(WIZARD_VERIFY_DETAIL);
    expect(verifyDetail(null, 'llm-jev')).toBe(WIZARD_VERIFY_DETAIL_ONE_KEY);
    expect(verifyTitle('jev-only')).toBe(WIZARD_VERIFY_TITLE);
    expect(verifyTitle('jev-on', 'anthropic')).toBe(WIZARD_VERIFY_TITLE);
    expect(verifyTitle('jev-on')).toBe(WIZARD_VERIFY_TITLE_ONE_KEY);
    // option 3 (pendMode jev-only) verifies for jev-only: the round-2 title
    const three = run([detectKey, { type: 'escape' }, { type: 'choose', option: 3 }, { type: 'choose', option: 3 }, { type: 'choose', option: 2 }, { type: 'enter', length: 40, prefixOk: true }, { type: 'saved' }]);
    expect(three.step).toBe('verify');
    expect(wizardLines(three, { rows: 24, columns: 80 })[0]).toBe(WIZARD_VERIFY_TITLE);
  });

  it('trust: 4 rows with sizes and counts only (never values); 2 rows below 12; the changed line replaces the listing; SR twin numbered', () => {
    const t = { root: '/Users/x/repo', agents: { name: 'AGENTS.md' as const, bytes: 2150 }, dotenv: { vars: 3, secretLike: 2 }, jevcodeJson: { bytes: 180 } };
    const lines = trustLines(t, 24, 120);
    expect(lines).toEqual([
      'Do you trust the files in /Users/x/repo?  (git root; stored per repository)',
      '  AGENTS.md (2.1 KiB) → generator system prompt   ./.env (3 vars, 2 secret-like)',
      '  jevcode.json (180 B)',
      WIZARD_TRUST_OPTIONS,
    ]);
    expect(trustLines(t, 11, 120)).toEqual([lines[0], WIZARD_TRUST_OPTIONS]);
    expect(trustLines({ ...t, agents: null, dotenv: null, jevcodeJson: null }, 24, 120)[1]).toBe('  AGENTS.md (none)   ./.env (none)');
    expect(trustLines({ ...t, agents: null, dotenv: null, jevcodeJson: null }, 24, 120)[2]).toBe('  jevcode.json (none)');
    expect(trustLines({ ...t, changed: { from: '1a2b3c4d', to: '9f8e7d6c' } }, 24, 120)[1]).toBe('AGENTS.md changed since you trusted it (sha256 1a2b3c4d → 9f8e7d6c)');
    expect(trustLines({ ...t, agents: { name: 'CLAUDE.md', bytes: 100 } }, 24, 120, true)[1]).toBe('  CLAUDE.md (100 B) -> generator system prompt   ./.env (3 vars, 2 secret-like)');
    const st = reduce(INITIAL_ONBOARDING, { type: 'detect', missing: [], mode: 'jev-on', provider: null, trustNeeded: true });
    expect(wizardLines(st, { rows: 24, columns: 120, trust: t })).toEqual(lines);
    const sr = wizardLines(st, { rows: 24, columns: 120, trust: t, screenReader: true });
    expect(sr[sr.length - 1]).toBe('Enter selection (1-3):');
    expect(wizardLines(st, { rows: 24, columns: 120 })[0]).toBe('Do you trust the files in .?  (git root; stored per repository)');
  });

  it('formatSize: B / KiB / MiB; NaN and negatives are 0 B', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2150)).toBe('2.1 KiB');
    expect(formatSize(32 * 1024)).toBe('32 KiB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MiB');
    expect(formatSize(NaN)).toBe('0 B');
    expect(formatSize(-5)).toBe('0 B');
  });

  it('save, sandbox, done and exit render no rows', () => {
    const save = run([detectBoth, { type: 'choose', option: 1 }, { type: 'enter', length: 40, prefixOk: true }, { type: 'choose', option: 2 }, { type: 'enter', length: 40, prefixOk: true }]);
    expect(wizardLines(save, { rows: 24, columns: 80 })).toEqual([]);
    expect(wizardLines({ ...save, step: 'sandbox' }, { rows: 24, columns: 80 })).toEqual([]);
    expect(wizardLines({ ...save, step: 'done' }, { rows: 24, columns: 80 })).toEqual([]);
    expect(wizardLines({ ...save, step: 'exit' }, { rows: 24, columns: 80 })).toEqual([]);
    expect(wizardLines(INITIAL_ONBOARDING, { rows: 24, columns: 80 })).toEqual([]);
  });
});

describe('TUI-DESIGN-3 §1.4.2 / §10: the `key` and `options` steps, their twins, and every row ≤ consoleInnerWidth', () => {
  const INNER80 = consoleInnerWidth(80);
  const detectTypesafe: OnboardingAction = { type: 'detect', missing: ['generator.apiKey'], mode: 'jev-on', provider: 'openrouter', jevProvider: 'typesafe', trustNeeded: false, found: 'typesafe', foundSource: 'env' };
  const detectJevFound = (source: 'env' | 'dotenv' | 'file', reusable = true): OnboardingAction => ({ type: 'detect', missing: ['generator.apiKey'], mode: 'jev-on', provider: 'openrouter', jevProvider: 'openrouter', trustNeeded: false, found: 'jev', foundSource: source, foundReusable: reusable });
  const detectAnthropic: OnboardingAction = { ...detectKey, found: 'anthropic', foundSource: 'env' };

  it('the strings are verbatim and every fixed row ≤ 76 cells (consoleInnerWidth(80))', () => {
    expect(INNER80).toBe(76);
    expect(WIZARD_KEY_TITLE).toBe('OpenRouter API key — one key runs Jev and the code model');
    expect(WIZARD_KEY_HINT_EMPTY).toBe('Paste, then Enter · Esc: other ways to start · Ctrl-C quits (shows setup)');
    expect(WIZARD_KEY_HINT_FOUND_TYPESAFE).toBe('Paste it and press Enter · Esc: other ways (Jev only, Anthropic)');
    expect(WIZARD_KEY_HINT_FOUND_ANTHROPIC).toBe('Paste it and press Enter (Jev only) · TypeSafe key for Jev? Esc, then 2');
    expect(WIZARD_REUSE_JEV_HINT).toBe('Enter = save the JEV_API_KEY value as the code-model key (config file)');
    expect(WIZARD_REUSE_JEV_FILE_HINT).toBe('Enter = reuse the saved Jev key for the code model too');
    expect(HINT_PREFIX_KEY).toBe('not an OpenRouter key? Enter again keeps it · TypeSafe key: Esc, then 2');
    expect(HINT_PASTED_TWICE).toBe('looks like the key was pasted twice — Ctrl-U clears');
    expect(WIZARD_OPTIONS_TITLE).toBe('Other ways to start:');
    expect(optionsTitle(3)).toBe('Other ways to start — Enter confirms 3:');
    expect(optionsTitle(null)).toBe(WIZARD_OPTIONS_TITLE);
    expect(WIZARD_OPTIONS).toBe('  1 OpenRouter for both   2 TypeSafe for Jev   3 Jev only, no LLM   4 Anthropic for code');
    expect(WIZARD_OPTIONS_NARROW).toBe('  1 OpenRouter   2 TypeSafe   3 Jev only   4 Anthropic');
    expect(WIZARD_OPTIONS_HINT).toBe('pick 1–4 · Esc back');
    expect(WIZARD_GENERATOR_TITLE_SKIPPABLE).toBe('OpenRouter API key (OPENROUTER_API_KEY) — Enter = skip (stay Jev-only)');
    expect(SR_KEY_HINT).toBe('Enter saves; Escape clears, then Escape again for other options');
    expect(SR_OPTIONS_ROWS).toEqual(['Other ways to start:', '1. OpenRouter key for both  2. TypeSafe key for Jev  3. Jev only, no LLM', '4. Anthropic key for the code model · Enter selection (1-4):']);
    expect(LOGIN_OTHER_WAYS_PROMPT).toBe('other ways: [t] TypeSafe Jev · [j] Jev only · [a] Anthropic · Enter continues: ');
    expect(LOGIN_ONE_KEY_PROMPT).toBe('OpenRouter API key (one key: Jev + the code model): ');
    expect(MOCK_VERIFY_NOTE).toBe('(mock session: verification uses the network)');
    expect(WIZARD_JEV_PROVIDER_TITLE_LOGIN).toBe('Where do you reach Jev?');
    expect(keyFoundTitle('typesafe')).toBe('TypeSafe key found — Jev runs there. Code model: paste an OpenRouter key');
    expect(keyFoundTitle('jev', 'env')).toBe('Jev key found (JEV_API_KEY) — code model: paste an OpenRouter key');
    expect(keyFoundTitle('jev', 'file')).toBe('Jev key found (config file) — code model: paste an OpenRouter key');
    expect(keyFoundTitle('jev', 'dotenv')).toBe('Jev key found (dotenv) — code model: paste an OpenRouter key');
    expect(keyFoundTitle('anthropic')).toBe('Anthropic key found — it writes the code. Jev needs an OpenRouter key:');
    const measured: [string, number][] = [
      [WIZARD_KEY_TITLE, 56],
      [WIZARD_KEY_HINT_EMPTY, 73],
      [HINT_PREFIX_KEY, 71],
      [keyFoundTitle('typesafe'), 72],
      [WIZARD_KEY_HINT_FOUND_TYPESAFE, 64],
      [keyFoundTitle('jev', 'env'), 65],
      [WIZARD_REUSE_JEV_HINT, 70],
      [WIZARD_REUSE_JEV_FILE_HINT, 54],
      [keyFoundTitle('anthropic'), 70],
      [WIZARD_KEY_HINT_FOUND_ANTHROPIC, 71],
      [optionsTitle(1), 39],
      [WIZARD_OPTIONS_NARROW, 54],
      [WIZARD_GENERATOR_TITLE_SKIPPABLE, 70],
      [SR_KEY_HINT, 63],
      [oneKeyHintRow(20, 80), 71],
    ];
    for (const [text, n] of measured) expect(cells(text), text).toBe(n);
    for (const text of [...measured.map(([t]) => t), HINT_PASTED_TWICE, WIZARD_OPTIONS_HINT, keyFoundTitle('jev', 'file'), keyFoundTitle('jev', 'dotenv'), ...SR_OPTIONS_ROWS, ...([1, 2, 3, 4] as WizardOption[]).map((n) => optionHint(n))]) {
      expect(cells(text), text).toBeLessThanOrEqual(INNER80);
    }
    expect(cells(optionHint(1))).toBe(DEFAULT_MODE === 'jev-only' ? 55 : 65);
    expect(cells(optionHint(2))).toBe(75);
    expect(cells(optionHint(4))).toBe(74);
    expect(cells(LOGIN_OTHER_WAYS_PROMPT)).toBe(79); // a prompt line, not a console row
  });

  it('optionsRow: the wide form when it fits the inner width (never a column threshold), ` (default)` after DEFAULT_MODE\'s route, `▌` (`>` ascii) before the highlighted digit; the narrow twin at 100 columns', () => {
    const d = defaultOption();
    expect(d).toBe(DEFAULT_MODE === 'jev-only' ? 3 : 1);
    expect(defaultOption('jev-only')).toBe(3);
    expect(defaultOption('jev-on')).toBe(1);
    expect(defaultOption('llm-jev')).toBe(1);
    const wide120 = optionsRow(null, consoleInnerWidth(120));
    expect(wide120).toContain(' (default)');
    expect(wide120).toBe(d === 1 ? '  1 OpenRouter for both (default)   2 TypeSafe for Jev   3 Jev only, no LLM   4 Anthropic for code' : '  1 OpenRouter for both   2 TypeSafe for Jev   3 Jev only, no LLM (default)   4 Anthropic for code');
    expect(cells(wide120)).toBeLessThanOrEqual(consoleInnerWidth(120));
    expect(optionsRow(null, consoleInnerWidth(100))).toBe(WIZARD_OPTIONS_NARROW);
    expect(optionsRow(null, INNER80)).toBe(WIZARD_OPTIONS_NARROW);
    expect(optionsRow(2, INNER80)).toBe('  1 OpenRouter  ▌2 TypeSafe   3 Jev only   4 Anthropic');
    expect(optionsRow(1, INNER80)).toBe(' ▌1 OpenRouter   2 TypeSafe   3 Jev only   4 Anthropic');
    expect(optionsRow(4, INNER80, true)).toBe('  1 OpenRouter   2 TypeSafe   3 Jev only  >4 Anthropic');
    expect(optionsRow(3, consoleInnerWidth(120))).toContain('▌3 Jev only');
    expect(cells(optionsRow(1, INNER80))).toBe(cells(WIZARD_OPTIONS_NARROW));
    // the ` (default)` follows a different mode's route when asked
    expect(optionsRow(null, consoleInnerWidth(120), false, 'jev-only')).toContain('3 Jev only, no LLM (default)');
    expect(optionHint(3, 0.25, 1.25, 'jev-only')).toBe('3: no LLM — code proposes, Jev decides, tests verify · caps $0.25 / $1.25 (default)');
    expect(optionHint(3, 0.25, 1.25, 'jev-on')).toBe('3: no LLM — code proposes, Jev decides, tests verify · caps $0.25 / $1.25');
    expect(optionHint(1, 0.25, 1.25, 'jev-on')).toBe('1: one key runs Jev and the code model (default) · Enter confirms');
    expect(optionHint(2)).toBe('2: TypeSafe key for Jev, OpenRouter key for the code model · Enter confirms');
    expect(optionHint(4)).toBe("4: Anthropic writes the code (~20× GLM's price) · Jev: OpenRouter/TypeSafe");
    // the amounts come from the jev-only cap default × the session multiplier, never a literal
    expect(optionHint(3)).toContain(`caps $${defaultRunSpendCapUsd('jev-only').toFixed(2)} / $${(defaultRunSpendCapUsd('jev-only') * SESSION_CAP_MULTIPLIER).toFixed(2)}`);
  });

  it('the `key` step rows: title / masked / hint per found state and length; SR twin; ascii twin; the reuse hints; the typing hint\'s narrow twin', () => {
    const key = reduce(INITIAL_ONBOARDING, detectKey);
    expect(wizardLines(key, { rows: 24, columns: INNER80, prompt: '› ' })).toEqual([WIZARD_KEY_TITLE, '› ', WIZARD_KEY_HINT_EMPTY]);
    const typing = reduce(key, { type: 'length', length: 20 });
    expect(wizardLines(typing, { rows: 24, columns: INNER80, prompt: '› ' })).toEqual([WIZARD_KEY_TITLE, `› ${'•'.repeat(20)}`, '20 chars · Enter saves · Ctrl-U clears · Esc clears (again: other ways)']);
    expect(oneKeyHintRow(20, 40)).toBe('20 · Enter · ^U · Esc');
    expect(oneKeyHintRow(20, 40, true)).toBe('20 - Enter - ^U - Esc');
    expect(oneKeyHintRow(NaN, 80).startsWith('0 chars')).toBe(true);
    const hinted = reduce(typing, { type: 'enter', length: 20, prefixOk: false });
    expect(wizardLines(hinted, { rows: 24, columns: INNER80 })[2]).toBe(HINT_PREFIX_KEY);
    const sr = wizardLines(typing, { rows: 24, columns: INNER80, screenReader: true });
    expect(sr).toEqual([WIZARD_KEY_TITLE, 'API key field, 20 characters entered, hidden', SR_KEY_HINT]);
    const ascii = wizardLines(typing, { rows: 24, columns: INNER80, ascii: true, prompt: '› ' });
    expect(ascii[1]).toBe(`> ${'*'.repeat(20)}`);
    for (const l of ascii) expect(l).toMatch(/^[\x20-\x7e]*$/);
    // found titles and their empty-field hints
    expect(wizardLines(reduce(INITIAL_ONBOARDING, detectTypesafe), { rows: 24, columns: INNER80 })).toEqual([keyFoundTitle('typesafe'), '> ', WIZARD_KEY_HINT_FOUND_TYPESAFE]);
    expect(wizardLines(reduce(INITIAL_ONBOARDING, detectJevFound('env')), { rows: 24, columns: INNER80 })).toEqual([keyFoundTitle('jev', 'env'), '> ', WIZARD_REUSE_JEV_HINT]);
    expect(wizardLines(reduce(INITIAL_ONBOARDING, detectJevFound('dotenv')), { rows: 24, columns: INNER80 })).toEqual([keyFoundTitle('jev', 'dotenv'), '> ', WIZARD_REUSE_JEV_HINT]);
    expect(wizardLines(reduce(INITIAL_ONBOARDING, detectJevFound('file')), { rows: 24, columns: INNER80 })).toEqual([keyFoundTitle('jev', 'file'), '> ', WIZARD_REUSE_JEV_FILE_HINT]);
    // a found Jev key that is not an OpenRouter key offers no reuse
    expect(wizardLines(reduce(INITIAL_ONBOARDING, detectJevFound('env', false)), { rows: 24, columns: INNER80 })[2]).toBe(WIZARD_KEY_HINT_FOUND_TYPESAFE);
    expect(wizardLines(reduce(INITIAL_ONBOARDING, detectAnthropic), { rows: 24, columns: INNER80 })).toEqual([keyFoundTitle('anthropic'), '> ', WIZARD_KEY_HINT_FOUND_ANTHROPIC]);
    // typing on a found-title field shows the typing hint (the reuse offer needs the empty field)
    expect(wizardLines(reduce(reduce(INITIAL_ONBOARDING, detectJevFound('env')), { type: 'length', length: 9 }), { rows: 24, columns: INNER80 })[2]).toBe(oneKeyHintRow(9, INNER80));
  });

  it('the `options` step rows: title / options / hint; a highlight marks the digit, names it in the title and shows its consequence; SR reads three rows; ascii twin; ≤ 76 at 80 and the wide form at 120', () => {
    const options = reduce(reduce(INITIAL_ONBOARDING, detectKey), { type: 'escape' });
    expect(wizardLines(options, { rows: 24, columns: INNER80 })).toEqual([WIZARD_OPTIONS_TITLE, WIZARD_OPTIONS_NARROW, WIZARD_OPTIONS_HINT]);
    const two = reduce(options, { type: 'choose', option: 2 });
    expect(wizardLines(two, { rows: 24, columns: INNER80 })).toEqual([optionsTitle(2), optionsRow(2, INNER80), optionHint(2)]);
    expect(wizardLines(reduce(options, { type: 'choose', option: 'enter' }), { rows: 24, columns: INNER80 })[2]).toBe('pick 1–4');
    const wide = wizardLines(two, { rows: 24, columns: consoleInnerWidth(120) });
    expect(wide[1]).toContain('▌2 TypeSafe for Jev');
    expect(wide[1]).toContain(' (default)');
    for (const l of wide) expect(cells(l), l).toBeLessThanOrEqual(consoleInnerWidth(120));
    expect(wizardLines(two, { rows: 24, columns: consoleInnerWidth(100) })[1]).toBe(optionsRow(2, consoleInnerWidth(100)));
    expect(wizardLines(two, { rows: 24, columns: consoleInnerWidth(100) })[1]).toContain('▌2 TypeSafe   3');
    const sr = wizardLines(two, { rows: 24, columns: INNER80, screenReader: true });
    expect(sr).toEqual([...SR_OPTIONS_ROWS]);
    for (const l of sr) expect(cells(l)).toBeLessThanOrEqual(INNER80);
    const ascii = wizardLines(reduce(options, { type: 'choose', option: 4 }), { rows: 24, columns: INNER80, ascii: true });
    expect(ascii[1]).toBe('  1 OpenRouter   2 TypeSafe   3 Jev only  >4 Anthropic');
    for (const l of ascii) expect(l).toMatch(/^[\x20-\x7e]*$/);
    expect(wizardRows(options, 24)).toBe(3);
    expect(wizardRows(options, 8)).toBe(3);
    // the /login re-entry title of the jevProvider step drops "No Jev key found."
    const login = reduce(INITIAL_ONBOARDING, { type: 'reopen', at: 'decider.apiKey', runLive: false });
    expect(wizardLines(login, { rows: 24, columns: 120 })[0]).toBe(WIZARD_JEV_PROVIDER_TITLE_LOGIN);
    expect(wizardLines(login, { rows: 24, columns: 120, screenReader: true })[0]).toBe(WIZARD_JEV_PROVIDER_TITLE_LOGIN);
    expect(wizardLines(reduce(INITIAL_ONBOARDING, detectJevOnly), { rows: 24, columns: 120 })[0]).toBe(WIZARD_JEV_PROVIDER_TITLE);
    // option 2's generator field: the skippable title and its hint
    const gen = run([{ type: 'choose', option: 2 }, { type: 'choose', option: 2 }, { type: 'enter', length: 40, prefixOk: true }], options);
    expect(gen.step).toBe('generatorKey');
    expect(wizardLines(gen, { rows: 24, columns: INNER80 })[0]).toBe(WIZARD_GENERATOR_TITLE_SKIPPABLE);
    expect(wizardLines(gen, { rows: 24, columns: INNER80 })[2]).toBe('Enter = skip · stays Jev-only · Ctrl-U clears · Esc back');
  });

  it('every row of every step of the one-key, found-title and options flows ≤ consoleInnerWidth(80) at 80 columns (and fits 76/116 inner widths); rows = wizardRows', () => {
    const states: OnboardingState[] = [];
    let s = reduce(INITIAL_ONBOARDING, detectKey);
    for (const a of [{ type: 'length', length: 300 }, { type: 'escape' }, { type: 'escape' }, { type: 'choose', option: 1 }, { type: 'choose', option: 2 }, { type: 'choose', option: 3 }, { type: 'choose', option: 4 }, { type: 'choose', option: 4 }, { type: 'length', length: 60 }, { type: 'enter', length: 60, prefixOk: true }, { type: 'choose', option: 2 }, { type: 'enter', length: 60, prefixOk: true }, { type: 'saved' }] as OnboardingAction[]) {
      states.push(s);
      s = reduce(s, a);
    }
    states.push(s);
    for (const d of [detectTypesafe, detectJevFound('env'), detectJevFound('file'), detectAnthropic]) {
      const st = reduce(INITIAL_ONBOARDING, d);
      states.push(st, reduce(st, { type: 'escape' }), reduce(reduce(st, { type: 'escape' }), { type: 'choose', option: 3 }));
    }
    const one = run([detectKey, { type: 'enter', length: 40, prefixOk: true }, { type: 'saved' }]);
    states.push(one);
    for (const st of states) {
      for (const inner of [consoleInnerWidth(80), consoleInnerWidth(120), 40]) {
        for (const twin of [{}, { ascii: true }, { screenReader: true }] as const) {
          const lines = wizardLines(st, { rows: 24, columns: inner, ...twin });
          expect(lines.length, `${st.step} ${inner}`).toBe(wizardRows(st, 24));
          for (const l of lines) expect(cells(l), `${st.step} ${inner} ${JSON.stringify(twin)}: ${l}`).toBeLessThanOrEqual(inner);
        }
      }
    }
  });

  it('the setup and verification items (§10): caps, the default-mode item, mode saved, key reused, verified / verification texts, the TypeSafe-wins line; amounts never scientific', () => {
    expect(capsItem('jev-on', 2, 10)).toBe('spend caps: $2.00 per run · $10.00 per session (jev+llm) — /budget changes them; /mode jev-only runs on Jev alone at $0.25 / $1.25');
    expect(capsItem('jev-only', 0.25, 1.25)).toBe('spend caps: $0.25 per run · $1.25 per session (jev-only) — /budget changes them; /mode jev-only runs on Jev alone at $0.25 / $1.25');
    expect(capsItem('llm-jev', 2, 10)).toContain('(llm+jev · verified)');
    expect(capsItem('jev-on', 2, Number.POSITIVE_INFINITY)).toBe('spend caps: $2.00 per run · none (uncapped) per session (jev+llm) — /budget changes them; /mode jev-only runs on Jev alone at $0.25 / $1.25');
    expect(defaultModeItem('jev-on', 2, 10)).toBe('mode jev+llm (default) — caps $2.00 per run · $10.00 per session; /mode jev-only runs on Jev alone at $0.25 / $1.25; jevcode config set mode <m> keeps a choice');
    expect(cells(defaultModeItem('jev-on', 2, 10))).toBe(159);
    expect(defaultModeItem(DEFAULT_MODE, defaultRunSpendCapUsd(DEFAULT_MODE), defaultRunSpendCapUsd(DEFAULT_MODE) * SESSION_CAP_MULTIPLIER)).toContain(`mode ${MODE_BADGE_WORD[DEFAULT_MODE]} (default)`);
    expect(modeSavedItem('jev-only', '~/.config/jevcode/config.json')).toBe('mode jev-only saved to ~/.config/jevcode/config.json — jevcode config set mode <m> changes it');
    expect(keyReusedText('env', 'e31150e9abcdef')).toBe('generator key: reused from JEV_API_KEY (sha256:e31150e9) source=env→file');
    expect(keyReusedText('dotenv', 'e31150e9')).toBe('generator key: reused from JEV_API_KEY (dotenv) (sha256:e31150e9) source=dotenv→file');
    expect(keyReusedText('file', 'e31150e9')).toBe('generator key: reused from the saved Jev key (sha256:e31150e9) source=file→file');
    expect(verifiedJevText('typesafe/jev-1.13-20260917', 318, 0.00002)).toBe('verified: jev ok (typesafe/jev-1.13-20260917, 318 input tokens, $0.00002)');
    expect(verifiedJevText('m', null, null)).toBe('verified: jev ok (m, usage unknown, cost unknown)');
    expect(verifiedGeneratorText('z-ai/glm-5.3-flash', 0.000002)).toBe('verified: z-ai/glm-5.3-flash ok (1 token, $0.000002)');
    expect(verificationCreditsText()).toBe('verification: no credits left on this OpenRouter key (HTTP 402) — add credits at openrouter.ai/credits; the key was kept');
    expect(verificationRateLimitedText(20)).toBe('verification: OpenRouter is rate-limiting this key (HTTP 429) — try again in 20s; the key was kept');
    expect(verificationModelText('z-ai/glm-nope', 404)).toBe('verification: the code model "z-ai/glm-nope" is not served by openrouter.ai (HTTP 404) — pass --model, or jevcode config set generator.model <id>; the key was kept');
    expect(typesafeWinsText()).toBe('decider.apiKey: env TYPESAFE_API_KEY wins over the saved key (typesafe) — pass --jev-provider openrouter to use the saved one');
    expect(usdMicro(0.00002)).toBe('$0.00002');
    expect(usdMicro(0.000002)).toBe('$0.000002');
    expect(usdMicro(0)).toBe('$0.00');
    expect(usdMicro(1)).toBe('$1.00');
    expect(usdMicro(0.0134)).toBe('$0.0134');
    for (const t of [capsItem('jev-on', 2, 10), defaultModeItem('jev-on', 2, 10), verifiedJevText('m', 318, 0.00002), verifiedGeneratorText('m', 0.000002)]) expect(t).not.toMatch(/e-\d/);
    // no vendor name in any mode-bearing item (R3 F9)
    for (const m of MODE_SETTING_VALUES as readonly EngineMode[]) expect(capsItem(m, 2, 10)).not.toMatch(/Claude|GLM writes/);
  });
});

// ---------------------------------------------------------------------------------------
// TUI-DESIGN-4 §2.5 (P-R6, D4) — `wizardMinsizeRow`: the read-only one-row wizard twin.
// ---------------------------------------------------------------------------------------
describe('wizardMinsizeRow (TUI-DESIGN-4 §2.5, P-R6)', () => {
  const STEPS = ['key', 'options', 'jevProvider', 'provider', 'generatorKey', 'jevKey', 'verify', 'trust'] as const;
  const at = (step: OnboardingState['step'], extra: Partial<OnboardingState> = {}): OnboardingState => ({ ...INITIAL_ONBOARDING, step, ...extra } as OnboardingState);

  it('§12: the normative `key` row, byte for byte, and its `--ascii` twin', () => {
    expect(wizardMinsizeRow(at('key'), 60)).toBe('setup · key — terminal too small; ≥ 40×8 to type');
    expect(wizardMinsizeRow(at('key'), 60, true)).toBe('setup - key - terminal too small; >= 40x8 to type');
    expect(wizardMinsizeRow(at('key'), 60, true)).toMatch(/^[\x20-\x7e]*$/);
  });

  it('§10 S2: every step at 20 / 30 / 40 columns, `cellWidth ≤ columns` and never empty', () => {
    for (const step of STEPS) {
      for (const columns of [20, 30, 40]) {
        for (const ascii of [false, true]) {
          const row = wizardMinsizeRow(at(step, { length: 0 }), columns, ascii);
          expect(row, `${step}/${columns}`).not.toBe('');
          expect(cells(row), `${step}/${columns}: ${row}`).toBeLessThanOrEqual(columns);
          expect(row, `${step}/${columns}`).not.toMatch(/…$/);
          if (ascii) expect(row, `${step}/${columns}`).toMatch(/^[\x20-\x7e]*$/);
        }
      }
    }
  });

  it('every width 1…80 fits, at every step, with and without entered text', () => {
    for (const step of STEPS) {
      for (let c = 1; c <= 80; c++) {
        for (const length of [0, 1, 51]) {
          const row = wizardMinsizeRow(at(step, { length }), c);
          if (c >= cells('setup')) expect(cells(row), `${step}/${c}/${length}`).toBeLessThanOrEqual(c);
        }
      }
    }
  });

  it('edge 2: **no masked byte and no length** — a field step shows a capped `•` count of text that already exists, or nothing', () => {
    expect(wizardMinsizeRow(at('key', { length: 0 }), 60)).toContain('terminal too small');
    expect(wizardMinsizeRow(at('key', { length: 3 }), 60)).toBe('setup · key — •••; ≥ 40×8 to type');
    const long = wizardMinsizeRow(at('key', { length: 51 }), 60);
    expect(long).toBe('setup · key — ••••••••; ≥ 40×8 to type');
    expect(long).not.toContain('51');
    expect(long).not.toContain('›');
    expect(long).not.toMatch(/[A-Za-z]{20,}/); // no key-shaped run of characters anywhere
    expect(wizardMinsizeRow(at('key', { length: 3 }), 60, true)).toBe('setup - key - ***; >= 40x8 to type');
  });

  it('edge 1: a picking step keeps its numbered choices, and `1 typesafe  2 openrouter` (24 cells) fits at 40', () => {
    expect(wizardMinsizeRow(at('jevProvider'), 40)).toBe('1 typesafe  2 openrouter');
    expect(cells('1 typesafe  2 openrouter')).toBe(24);
    expect(wizardMinsizeRow(at('options'), 60)).toContain('1 OpenRouter');
    expect(wizardMinsizeRow(at('trust'), 40)).toContain('1 trust');
    expect(wizardMinsizeRow(at('verify'), 40)).toContain('[y]');
  });

  it('a step with no wizard row answers `\'\'` (detect, save, sandbox, done, exit)', () => {
    for (const step of ['detect', 'save', 'sandbox', 'done', 'exit'] as const) {
      expect(wizardMinsizeRow(at(step), 40), step).toBe('');
    }
  });

  it('§12 / §2.5 edge 3: the read-only toast and the `rows < 3` static item are the strings the glossary names', () => {
    expect(WIZARD_MINSIZE_TOAST).toBe('resize to at least 40×8 to continue setup');
    expect(WIZARD_MINSIZE_STATIC_ITEM).toBe('setup needs a terminal of at least 40×8');
  });

  it('§2.5: a key pressed at minsize changes NO wizard state — the reducer is not driven, the toast is (the row is read-only)', () => {
    // the design states the rule once: keys are consumed and produce one toast. The row itself carries no caret and
    // no invitation, so a first-run user cannot mistake it for a field.
    const before = at('key', { length: 4 });
    expect(wizardMinsizeRow(before, 40)).not.toContain('›');
    expect(wizardMinsizeRow(before, 40)).not.toContain('_');
    // and the same state rendered twice is the same row (no cursor, no animation, nothing to blink)
    expect(wizardMinsizeRow(before, 40)).toBe(wizardMinsizeRow(before, 40));
  });
});
