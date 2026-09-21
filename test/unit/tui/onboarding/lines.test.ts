/** tui/onboarding/lines.ts (TUI-DESIGN §11.1–§11.3, §24 "Wizard"; §19.0 row O7; TUI-DESIGN-2 §1.4, §2.7, §4.3, §12 "Wizard"): ≤ 4 rows; masked field twins; verbatim strings. */
import { describe, expect, it } from 'vitest';
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
} from '../../../../src/tui/onboarding/lines.js';
import { INITIAL_ONBOARDING, onboardingReducer as reduce, wizardRows, type OnboardingAction, type OnboardingState } from '../../../../src/tui/onboarding/reducer.js';
import { stringWidth } from '../../../../src/tui/composer/width.js';
import * as credentials from '../../../../src/config/credentials.js';
import { asciiRow, clipRow } from '../../../../src/tui/onboarding/lines.js';

const detectBoth: OnboardingAction = { type: 'detect', missing: ['generator.apiKey', 'decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: true };
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
    expect(sandboxText('seatbelt')).toBe('seatbelt — writes confined to the workspace and run dirs; harness secret files, ~/.ssh, ~/.aws unreadable; reads elsewhere and network allowed unless --no-network');
    expect(sandboxText('none', 'linux')).toBe('none — sandbox-exec is not available on linux: cwd confinement, env scrubbing, timeout, output cap and tree kill only');
    expect(agentsChangedLine('1a2b3c4d5e6f7890', '9f8e7d6c5b4a3210')).toBe('AGENTS.md changed since you trusted it (sha256 1a2b3c4d → 9f8e7d6c)');
    expect(agentsChangedLine('1a2b3c4d', '9f8e7d6c', true)).toBe('AGENTS.md changed since you trusted it (sha256 1a2b3c4d -> 9f8e7d6c)');
  });

  it('TUI-DESIGN-2 §1.4 / §12: the fix block leads with the two Jev variables and the piped TypeSafe login; the Anthropic line joins only when the mode needs a non-openrouter generator', () => {
    const jev = ['export TYPESAFE_API_KEY=…', 'export OPENROUTER_API_KEY=…', 'printenv TYPESAFE_API_KEY | jevcode login --jev-provider typesafe --jev-key-stdin', 'jevcode login'];
    expect(fixBlockLines()).toEqual([...jev, FIX_BLOCK_FOOTER]);
    expect(fixBlockLines('jev-only')).toEqual([...jev, FIX_BLOCK_FOOTER]);
    expect(fixBlockLines('jev-only', 'anthropic')).toEqual([...jev, FIX_BLOCK_FOOTER]);
    expect(fixBlockLines('jev-on')).toEqual([...jev, 'export ANTHROPIC_API_KEY=…', FIX_BLOCK_FOOTER]);
    expect(fixBlockLines('jev-off', 'anthropic')).toEqual([...jev, 'export ANTHROPIC_API_KEY=…', FIX_BLOCK_FOOTER]);
    // the default generator is OpenRouter (glm-5.3-flash): its variable is already the second line
    expect(fixBlockLines('jev-on', 'openrouter')).toEqual([...jev, FIX_BLOCK_FOOTER]);
    for (const l of fixBlockLines('jev-on')) expect(l).not.toMatch(/sk-|[A-Za-z0-9]{20,}/);
  });

  it('TUI-DESIGN-2 §12 "Wizard": the round-2 strings are verbatim', () => {
    expect(WIZARD_JEV_PROVIDER_TITLE).toBe('No Jev key found. Where do you reach Jev?');
    expect(WIZARD_JEV_PROVIDER_OPTIONS).toBe('  1 typesafe (TYPESAFE_API_KEY, api.typesafe.ai)   2 openrouter (OPENROUTER_API_KEY, also the generator)');
    expect(WIZARD_JEV_PROVIDER_OPTIONS_NARROW).toBe('  1 typesafe   2 openrouter');
    expect(WIZARD_PROVIDER_TITLE_MODE).toBe('jev+llm needs a generator. Pick the provider:');
    expect(WIZARD_PROVIDER_HINT_MODE).toBe('Keys are never shown, logged or echoed · Esc back · Ctrl-C keeps jev-only');
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
    const at80 = wizardLines(s, { rows: 24, columns: 80 });
    expect(at80).toEqual([WIZARD_PROVIDER_TITLE, WIZARD_PROVIDER_OPTIONS, WIZARD_PROVIDER_HINT]);
    expect(at80.length).toBe(wizardRows(s, 24));
    for (const l of at80) expect(cells(l)).toBeLessThanOrEqual(80);
    const at40 = wizardLines(s, { rows: 8, columns: 40 });
    expect(at40[1]).toBe('  1 anthropic   2 openrouter');
    for (const l of at40) expect(cells(l)).toBeLessThanOrEqual(40);
    const pre = wizardLines(reduce(INITIAL_ONBOARDING, { ...detectBoth, provider: 'openrouter' }), { rows: 24, columns: 120 });
    expect(pre[2]).toBe(`${WIZARD_PROVIDER_HINT} · Enter = openrouter`);
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
    // llm-jev (docs/LLM-JEV-DESIGN.md): the same wizard names the target badge word; the prompted provider default stays openrouter
    expect(providerTitleMode('llm-jev')).toBe('llm-jev needs a generator. Pick the provider:');
    const llmJev = reduce(reduce(INITIAL_ONBOARDING, { ...detectJevOnly, jevProvider: 'typesafe' }), { type: 'reopen', at: 'provider', runLive: false, reason: 'mode', mode: 'llm-jev' });
    expect(llmJev.mode).toBe('llm-jev');
    expect(wizardLines(llmJev, { rows: 24, columns: 120 })[0]).toBe('llm-jev needs a generator. Pick the provider:');
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
    expect(lines[0]).toBe(WIZARD_VERIFY_TITLE);
    expect(lines[1]).toBe('GET openrouter.ai/api/v1/key $0 · GET api.anthropic.com/v1/models $0 · one Jev decision ~$0.0001');
    expect(wizardLines(reduce(v, { type: 'verify-answer', yes: true }), { rows: 24, columns: 120 })[1]).toBe('verifying… (Ctrl-C cancels)');
    const ts = run([detectJevOnly, { type: 'choose', option: 1 }, { type: 'enter', length: 40, prefixOk: true }, { type: 'saved' }]);
    expect(wizardLines(ts, { rows: 24, columns: 120 })).toEqual([WIZARD_VERIFY_TITLE, 'one Jev decision at api.typesafe.ai ~$0.00002 (jev-1.13.0)']);
    expect(wizardLines(ts, { rows: 24, columns: 120, ascii: true })[1]).toBe('one Jev decision at api.typesafe.ai ~$0.00002 (jev-1.13.0)');
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
