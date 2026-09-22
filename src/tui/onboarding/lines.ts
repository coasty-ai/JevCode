/**
 * Wizard rows and setup strings (TUI-DESIGN §11.1–§11.3, §24 "Wizard"; TUI-DESIGN-2 §1.4, §2.7, §12 "Wizard"). Pure
 * `lines()` functions shared by the Ink wizard, `--plain`, `--screen-reader` and `--ascii` (§14.1 glyph table); the
 * rows never contain a key byte — the field is rendered from its masked length only. Rows are
 * measured in terminal cells (`stringWidth`/`truncateCells`, §4.2), never code points, so a CJK or
 * emoji git-root path never wraps and breaks the ≤ 4-row budget (D1). The `[setup]`/`[config]`
 * item builders live in `src/config/credentials.ts` (config never imports the TUI) and are
 * re-exported here for the renderers.
 */
import { isFieldStep, reuseJevOffered, reuseOffered, skipOffered, targetMode, type FoundKey, type FoundSource, type ImportOption, type ImportProbeCounts, type OnboardingState, type WizardOption, type WizardProvider, type WizardStep } from './reducer.js';
import type { EngineMode, JevProvider, SandboxLevel, SandboxProfile } from '../../core/types.js';
import type { TrustInputs } from '../../config/trust.js';
import { DEFAULT_MODE, MODE_BADGE_WORD, SESSION_CAP_MULTIPLIER } from '../../config/defaults.js';
import { defaultRunSpendCapUsd } from '../../config/ui.js';
import { ELLIPSIS, stringWidth, truncateCells } from '../composer/width.js';
import { fitRung } from '../fit.js';
import { PROVIDER_DISPLAY_NAME, PROVIDER_KEY_ENV, type ProviderId } from '../../provider/ids.js';

/** TUI-DESIGN §11.3: the trust prompt's inputs (declared in config/trust.ts; re-exported for the renderers). */
export type { TrustInputs } from '../../config/trust.js';
/** TUI-DESIGN §24 item builders (declared in config/credentials.ts; re-exported for the renderers). */
export { WINDOWS_ACL_NOTE, keyEnteredText, savedText, shadowingText } from '../../config/credentials.js';
/** TUI-DESIGN-3 §1.4.2: the `key` step's hints live beside the reducer's other hints (lines.ts imports the reducer, never the reverse); re-exported here as the one string source. */
export { HINT_PASTED_TWICE, HINT_PICK_OPTION, HINT_PREFIX_KEY } from './reducer.js';

/** TUI-DESIGN §11.1: geometry and twin flags for `wizardLines`. */
export interface WizardView {
  rows: number;
  columns: number;
  /** `--ascii`: `*` for `•`, `->` for `→`, `-` for `·`/`—`, `Bksp` for `⌫`, `...` for `…` (§14.1) */
  ascii?: boolean;
  /** `--screen-reader`: numbered lists + `Enter selection (1-N):`, no bullets */
  screenReader?: boolean;
  /** trust step inputs (sizes and counts only, never values — F-O) */
  trust?: TrustInputs;
  /** TUI-DESIGN-2 §4.3: the composer prompt glyph the masked row leads with (`› ` boxed, `> ` flat / ascii / plain); default `> ` */
  prompt?: string;
}

/** TUI-DESIGN §11.1: the env variable each provider's key is read from. */
export const PROVIDER_ENV: Readonly<Record<WizardProvider, string>> = { anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY' };
/**
 * Display names for the `<Provider> API key (<ENV>)` title. TUI-DESIGN-5 §8.2 R14: the two wizard providers' names
 * are READ from `src/provider/ids.ts` (zero-import, so the first-frame graph is untouched) rather than re-declared,
 * so the wizard title, the picker column and `errorLabel` cannot drift to two spellings of one provider.
 */
export const PROVIDER_DISPLAY: Readonly<Record<WizardProvider, string>> = { anthropic: PROVIDER_DISPLAY_NAME.anthropic, openrouter: PROVIDER_DISPLAY_NAME.openrouter };
/** TUI-DESIGN-2 §1.4: the wizard's prompted generator provider default follows `DEFAULT_PROVIDER` (openrouter, commit 2a92d0b). */
export const DEFAULT_WIZARD_PROVIDER: WizardProvider = 'openrouter';
/** TUI-DESIGN-2 §2.2: the variable each Jev provider's key is read from (the OpenRouter row falls back to `OPENROUTER_API_KEY`). */
export const JEV_PROVIDER_ENV: Readonly<Record<JevProvider, string>> = { typesafe: 'TYPESAFE_API_KEY', openrouter: 'JEV_API_KEY' };

// §24 "Wizard" strings, verbatim.
export const WIZARD_PROVIDER_TITLE = 'No API key found. Pick the generator provider:';
export const WIZARD_PROVIDER_OPTIONS = '  1 anthropic (ANTHROPIC_API_KEY)   2 openrouter (OPENROUTER_API_KEY, also Jev)';
export const WIZARD_PROVIDER_OPTIONS_NARROW = '  1 anthropic   2 openrouter';
export const WIZARD_PROVIDER_HINT = 'Keys are never shown, logged or echoed · Esc back · Ctrl-C quits (prints fix)';
export const WIZARD_JEV_TITLE = 'Jev API key (JEV_API_KEY; falls back to OPENROUTER_API_KEY)  2/2';
export const WIZARD_REUSE_HINT = 'Enter = reuse the OpenRouter key for Jev';
export const WIZARD_VERIFY_TITLE = 'Verify the keys now? [y] yes (one priced Jev call, ~$0.0001)  [n] skip';
export const WIZARD_VERIFY_DETAIL = 'GET openrouter.ai/api/v1/key $0 · GET api.anthropic.com/v1/models $0 · one Jev decision ~$0.0001';
export const WIZARD_VERIFYING = 'verifying… (Ctrl-C cancels)';
export const WIZARD_TRUST_OPTIONS = "  1 trust   2 this session only   3 don't trust (AGENTS.md ignored; .env read)";
export const FIX_BLOCK_FOOTER = 'Keys are never accepted as command-line arguments in the interactive flow';
/** TUI-DESIGN §14.2 screen reader: the masked field's aria-label (research 13 §5.11). */
export const SR_KEY_FIELD_LABEL = (n: number): string => `API key field, ${n} characters entered, hidden`;

// TUI-DESIGN-2 §12 "Wizard" strings, verbatim.
/** §1.4: the jevProvider step — shown only when no §2.3 rule inferred the Jev provider. */
export const WIZARD_JEV_PROVIDER_TITLE = 'No Jev key found. Where do you reach Jev?';
export const WIZARD_JEV_PROVIDER_OPTIONS = '  1 typesafe (TYPESAFE_API_KEY, api.typesafe.ai)   2 openrouter (OPENROUTER_API_KEY, also the generator)';
export const WIZARD_JEV_PROVIDER_OPTIONS_NARROW = '  1 typesafe   2 openrouter';
/** §1.4: the provider step opened by `/mode jev-on` with no generator key (reason `mode`); `providerTitleMode` keys it by the target mode. */
export const WIZARD_PROVIDER_TITLE_MODE = 'jev+llm needs a generator. Pick the provider:';
/**
 * TUI-DESIGN-3 §1.9: the reason-`mode` hint names the CURRENT mode's badge (the one Ctrl-C keeps) through `MODE_BADGE_WORD` — 75
 * cells with the longest badge (`llm+jev · verified`); the first draft's wording reached 83 and was clipped. `WIZARD_PROVIDER_HINT_MODE`
 * is the jev-only form, kept for the callers that pinned it.
 */
export function providerHintMode(current: EngineMode): string {
  return `Keys are never shown or logged · Esc back · Ctrl-C keeps ${MODE_BADGE_WORD[current]}`;
}
export const WIZARD_PROVIDER_HINT_MODE = providerHintMode('jev-only');
/**
 * §1.4 / §1.5: the reason-`mode` provider title names the TARGET mode's badge word — `jev+llm needs a generator. Pick the
 * provider:` for `/mode jev-on`, `llm-only needs a generator. Pick the provider:` for `/mode jev-off` (the same wizard,
 * `session.ts` opens it for both); `llm+jev · verified needs a generator. Pick the provider:` for `/mode llm-jev` (docs/LLM-JEV-DESIGN.md:
 * both keys); jev-only never needs a generator and keeps the jev+llm text. The word comes from `MODE_BADGE_WORD` (D-N).
 */
export function providerTitleMode(mode: EngineMode): string {
  return `${MODE_BADGE_WORD[mode === 'jev-off' || mode === 'llm-jev' ? mode : 'jev-on']} needs a generator. Pick the provider:`;
}
/** TUI-DESIGN-3 §4.4 F19: the `/login` re-entry title of the jevProvider step — no "No Jev key found." (a key may well resolve). */
export const WIZARD_JEV_PROVIDER_TITLE_LOGIN = 'Where do you reach Jev?';
/** §2.7: the verify detail under the typesafe provider (one priced decision; the OpenRouter twin is `WIZARD_VERIFY_DETAIL`). */
export const WIZARD_VERIFY_DETAIL_TYPESAFE = 'one Jev decision at api.typesafe.ai ~$0.00002 (jev-1.13.0)';
/** §12 "Wizard": the `jevcode login` provider question (a plain line, not masked). */
export const LOGIN_JEV_PROVIDER_PROMPT = 'Where do you reach Jev?  1 typesafe  2 openrouter';
/** §12 "Wizard": `--jev-key-stdin` on a pipe with nothing to infer the provider from. */
export const LOGIN_JEV_PROVIDER_REQUIRED = 'jevcode login: pass --jev-provider typesafe|openrouter with --jev-key-stdin';

// TUI-DESIGN-3 §1.4.2 / §10 "Wizard" strings, verbatim; every console-hosted row ≤ 76 cells (`consoleInnerWidth(80)`).
/** the `key` step (both keys missing, nothing inferred): one masked OpenRouter field (56) */
export const WIZARD_KEY_TITLE = 'OpenRouter API key — one key runs Jev and the code model';
/** the empty `key` field's hint (73): the next Esc opens `options`, Ctrl-C prints the fix block */
export const WIZARD_KEY_HINT_EMPTY = 'Paste, then Enter · Esc: other ways to start · Ctrl-C quits (shows setup)';
/** the empty `key` field under a found TypeSafe key (64) */
export const WIZARD_KEY_HINT_FOUND_TYPESAFE = 'Paste it and press Enter · Esc: other ways (Jev only, Anthropic)';
/** the empty `key` field under a found Anthropic key (71): the field is the Jev key */
export const WIZARD_KEY_HINT_FOUND_ANTHROPIC = 'Paste it and press Enter (Jev only) · TypeSafe key for Jev? Esc, then 2';
/** found `jev` from env / dotenv, the value an OpenRouter key (70): it says a secret from the environment is about to be written to disk */
export const WIZARD_REUSE_JEV_HINT = 'Enter = save the JEV_API_KEY value as the code-model key (config file)';
/** found `jev` from the file (54) */
export const WIZARD_REUSE_JEV_FILE_HINT = 'Enter = reuse the saved Jev key for the code model too';
/** the `options` step title; `optionsTitle(n)` is the highlighted form */
export const WIZARD_OPTIONS_TITLE = 'Other ways to start:';
/** the four options (` (default)` joins the route of `DEFAULT_MODE` at render time; 88 cells before it, ≤ 98 after) */
export const WIZARD_OPTIONS = '  1 OpenRouter for both   2 TypeSafe for Jev   3 Jev only, no LLM   4 Anthropic for code';
/** the narrow twin (54), chosen whenever the wide form does not fit the inner width */
export const WIZARD_OPTIONS_NARROW = '  1 OpenRouter   2 TypeSafe   3 Jev only   4 Anthropic';
/** the `options` hint with nothing highlighted */
export const WIZARD_OPTIONS_HINT = 'pick 1–4 · Esc back';
/** the one-key verify title (75); jev-only wizards keep `WIZARD_VERIFY_TITLE` */
export const WIZARD_VERIFY_TITLE_ONE_KEY = 'Verify now? [y] one Jev decision + 1 code-model token (< $0.0001)  [n] skip';
/** the verify detail under openrouter with a generator (73) */
export const WIZARD_VERIFY_DETAIL_ONE_KEY = 'decision ~$0.00002 · completion ~$0.000002 · key info $0 · Enter/Esc skip';
/** the verify detail under typesafe with a generator (72) */
export const WIZARD_VERIFY_DETAIL_TYPESAFE_GENERATOR = 'api.typesafe.ai decision ~$0.00002 · completion ~$0.000002 · key info $0';
/** option `2`'s generator field title (70): an empty Enter keeps Jev-only */
export const WIZARD_GENERATOR_TITLE_SKIPPABLE = 'OpenRouter API key (OPENROUTER_API_KEY) — Enter = skip (stay Jev-only)';
/** the screen-reader `key` hint (63) */
export const SR_KEY_HINT = 'Enter saves; Escape clears, then Escape again for other options';
/** the screen-reader `options` rows (three, each ≤ 76) */
export const SR_OPTIONS_ROWS: readonly [string, string, string] = [WIZARD_OPTIONS_TITLE, '1. OpenRouter key for both  2. TypeSafe key for Jev  3. Jev only, no LLM', '4. Anthropic key for the code model · Enter selection (1-4):'];
/** the plain / `jevcode login` twin of `options` (79; a prompt line, not a console row) */
export const LOGIN_OTHER_WAYS_PROMPT = 'other ways: [t] TypeSafe Jev · [j] Jev only · [a] Anthropic · Enter continues: ';
/** the plain / `jevcode login` one-key prompt */
export const LOGIN_ONE_KEY_PROMPT = 'OpenRouter API key (one key: Jev + the code model): ';
/** TUI-DESIGN-3 §1.8 edge 30: `/login --verify` (or `y`) in a `--mock` session never reaches the network */
export const MOCK_VERIFY_NOTE = '(mock session: verification uses the network)';
/** TUI-DESIGN-3 §4.4 F3: `/panel` reaching the host while the wizard owns the input (the TUI keeps every spelling App-local) */
export const PANEL_HANDLED_BY_TUI = 'panel: handled by the TUI';
/** TUI-DESIGN-3 §4.4 F3: `/transcript` under `--plain` */
export const TRANSCRIPT_ALWAYS_FULL = 'transcript full (--plain is always full)';

/** TUI-DESIGN-3 §1.4.2: the option whose route equals `DEFAULT_MODE`'s — `3` for jev-only, `1` (one OpenRouter key) for every generator mode */
export function defaultOption(mode: EngineMode = DEFAULT_MODE): WizardOption {
  return mode === 'jev-only' ? 3 : 1;
}

/** TUI-DESIGN-3 §1.4.2: `Other ways to start — Enter confirms <n>:` (41) */
export function optionsTitle(highlight: WizardOption | null): string {
  return highlight === null ? WIZARD_OPTIONS_TITLE : `Other ways to start — Enter confirms ${highlight}:`;
}

/**
 * TUI-DESIGN-3 §1.4.2: the options row — the wide form when it fits the inner width (never a column threshold), else the narrow
 * twin; ` (default)` after the option of `DEFAULT_MODE`'s route (wide form only); the highlighted digit's leading space becomes `▌` (`>` ascii).
 */
export function optionsRow(highlight: WizardOption | null, columns: number, ascii = false, mode: EngineMode = DEFAULT_MODE): string {
  const inner = cols(columns);
  const d = defaultOption(mode);
  const wide = WIZARD_OPTIONS.replace(new RegExp(`(${d} [^0-9]+?)(   |$)`), '$1 (default)$2');
  const row = stringWidth(wide) <= inner ? wide : WIZARD_OPTIONS_NARROW;
  if (highlight === null) return row;
  const marker = ascii ? '>' : '▌';
  return row.replace(new RegExp(` (${highlight} )`), `${marker}$1`);
}

/** TUI-DESIGN-3 §1.4.2: the highlighted option's one-line consequence (65 / 75 / 73 / 75); the amounts are never literal */
export function optionHint(n: WizardOption, runCapUsd: number = defaultRunSpendCapUsd('jev-only'), sessionCapUsd: number = defaultRunSpendCapUsd('jev-only') * SESSION_CAP_MULTIPLIER, mode: EngineMode = DEFAULT_MODE): string {
  const dflt = defaultOption(mode) === n ? ' (default)' : '';
  switch (n) {
    case 1:
      return `1: one key runs Jev and the code model${dflt} · Enter confirms`;
    case 2:
      return '2: TypeSafe key for Jev, OpenRouter key for the code model · Enter confirms';
    case 3:
      return `3: no LLM — code proposes, Jev decides, tests verify · caps ${usd2(runCapUsd)} / ${usd2(sessionCapUsd)}${dflt}`;
    case 4:
      return "4: Anthropic writes the code (~20× GLM's price) · Jev: OpenRouter/TypeSafe";
  }
}

/** TUI-DESIGN-3 §1.4.2: the `key` step's found-title — a source, never a value (72 / 65 / 70) */
export function keyFoundTitle(found: Exclude<FoundKey, null>, source: FoundSource | null = null): string {
  switch (found) {
    case 'typesafe':
      return 'TypeSafe key found — Jev runs there. Code model: paste an OpenRouter key';
    case 'jev':
      return `Jev key found (${source === 'file' ? 'config file' : source === 'dotenv' ? 'dotenv' : 'JEV_API_KEY'}) — code model: paste an OpenRouter key`;
    case 'anthropic':
      return 'Anthropic key found — it writes the code. Jev needs an OpenRouter key:';
  }
}

/** TUI-DESIGN-3 §1.4.2: the typing hint of the `key` field (71 at n = 20); the narrow twin when it does not fit */
export function oneKeyHintRow(length: number, columns: number, ascii = false): string {
  const g = glyphs(ascii);
  const n = Number.isFinite(length) && length > 0 ? Math.floor(length) : 0;
  const wide = `${n} chars ${g.dot} Enter saves ${g.dot} Ctrl-U clears ${g.dot} Esc clears (again: other ways)`;
  if (stringWidth(wide) <= cols(columns)) return wide;
  return `${n} ${g.dot} Enter ${g.dot} ^U ${g.dot} Esc`;
}

/** `$2.00` — two decimals for caps (§5.1 rule 6) */
function usd2(n: number): string {
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : 'none';
}
/** `$0.00002` — the per-call figures of the verification items: up to six decimals, trailing zeros dropped, never scientific notation */
export function usdMicro(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00';
  const t = n.toFixed(6).replace(/0+$/, '');
  return `$${t.endsWith('.') ? `${t}00` : t}`;
}

/** TUI-DESIGN-3 §1.7 / §10: the `[setup]` caps item after a wizard save (`none (uncapped)` for a lifted session cap) */
export function capsItem(mode: EngineMode, runCapUsd: number, sessionCapUsd: number): string {
  const session = Number.isFinite(sessionCapUsd) ? `${usd2(sessionCapUsd)} per session` : 'none (uncapped) per session';
  const jo = defaultRunSpendCapUsd('jev-only');
  return `spend caps: ${usd2(runCapUsd)} per run ${'·'} ${session} (${MODE_BADGE_WORD[mode]}) — /budget changes them; /mode jev-only runs on Jev alone at ${usd2(jo)} / ${usd2(jo * SESSION_CAP_MULTIPLIER)}`;
}

/** TUI-DESIGN-3 §1.7 (D-Q) / §10: the one-time `[setup]` item of a keyed start whose `mode` resolves from `default` (159 cells; the words from the tables) */
export function defaultModeItem(mode: EngineMode, runCapUsd: number, sessionCapUsd: number): string {
  const jo = defaultRunSpendCapUsd('jev-only');
  const session = Number.isFinite(sessionCapUsd) ? usd2(sessionCapUsd) : 'none (uncapped)';
  return `mode ${MODE_BADGE_WORD[mode]} (default) — caps ${usd2(runCapUsd)} per run · ${session} per session; /mode jev-only runs on Jev alone at ${usd2(jo)} / ${usd2(jo * SESSION_CAP_MULTIPLIER)}; jevcode config set mode <m> keeps a choice`;
}

/** TUI-DESIGN-3 §1.4.3 / §10: option `3` at a startup wizard persisted the mode */
export function modeSavedItem(mode: EngineMode, displayPath: string): string {
  return `mode ${mode} saved to ${displayPath} — jevcode config set mode <m> changes it`;
}

/** TUI-DESIGN-3 §1.4.2 (edges 11, 17): the reuse Enter's item — `generator key: reused from JEV_API_KEY (sha256:…) source=env→file` */
export function keyReusedText(source: FoundSource, fp: string): string {
  const from = source === 'env' ? 'JEV_API_KEY' : source === 'dotenv' ? 'JEV_API_KEY (dotenv)' : 'the saved Jev key';
  return `generator key: reused from ${from} (sha256:${fp.slice(0, 8)}) source=${source}→file`;
}

/** TUI-DESIGN-3 §1.5: `verified: jev ok (<model>, <n> input tokens, $<usd>)` */
export function verifiedJevText(model: string, inputTokens: number | null, usd: number | null): string {
  const tokens = inputTokens === null || !Number.isFinite(inputTokens) ? 'usage unknown' : `${Math.round(inputTokens)} input tokens`;
  return `verified: jev ok (${model}, ${tokens}, ${usd === null ? 'cost unknown' : usdMicro(usd)})`;
}
/** TUI-DESIGN-3 §1.5: `verified: <model> ok (1 token, $<usd>)` */
export function verifiedGeneratorText(model: string, usd: number | null): string {
  return `verified: ${model} ok (1 token, ${usd === null ? 'cost unknown' : usdMicro(usd)})`;
}
/** TUI-DESIGN-3 §1.5 / §1.8 edge 12: a 402 on the verify decision or completion */
export function verificationCreditsText(status = 402): string {
  return `verification: no credits left on this OpenRouter key (HTTP ${status}) — add credits at openrouter.ai/credits; the key was kept`;
}
/** TUI-DESIGN-3 §1.5 / §1.8 edge 13: a 429 with its Retry-After */
export function verificationRateLimitedText(retryAfterS: number | null): string {
  const when = retryAfterS === null || !Number.isFinite(retryAfterS) ? 'in a moment' : `in ${Math.max(1, Math.round(retryAfterS))}s`;
  return `verification: OpenRouter is rate-limiting this key (HTTP 429) — try again ${when}; the key was kept`;
}
/** TUI-DESIGN-3 §1.5 / §1.8 edge 25: the code model is not served (400/404 on the completion) */
export function verificationModelText(model: string, status: number): string {
  return `verification: the code model "${model}" is not served by openrouter.ai (HTTP ${status}) — pass --model, or jevcode config set generator.model <id>; the key was kept`;
}
/** TUI-DESIGN-3 §1.8 edge 34 / §10: a saved Jev key sits under an env TypeSafe key */
export function typesafeWinsText(): string {
  return 'decider.apiKey: env TYPESAFE_API_KEY wins over the saved key (typesafe) — pass --jev-provider openrouter to use the saved one';
}

/** TUI-DESIGN-3 §1.4.2: the hint under option `2`'s empty generator field */
export const LOGIN_JEV_SKIP_HINT_ROW = 'Enter = skip · stays Jev-only · Ctrl-U clears · Esc back';

/** TUI-DESIGN §14.1 glyph substitutions used by these rows. */
function glyphs(ascii: boolean): { bullet: string; arrow: string; dot: string; bksp: string } {
  return ascii ? { bullet: '*', arrow: '->', dot: '-', bksp: 'Bksp' } : { bullet: '•', arrow: '→', dot: '·', bksp: '⌫' };
}

/** TUI-DESIGN §14.1: the `--ascii` twin of a row — every glyph these rows use has an ASCII form; user paths pass through. */
export function asciiRow(s: string): string {
  return s.replace(/·/g, '-').replace(/→/g, '->').replace(/•/g, '*').replace(/⌫/g, 'Bksp').replace(/—/g, '-').replace(/…/g, '...').replace(/⚠/g, '!').replace(/›/g, '>').replace(/▌/g, '>').replace(/×/g, 'x').replace(/–/g, '-');
}

function cols(columns: number): number {
  return Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80;
}

/**
 * TUI-DESIGN §4.2 / D1: clip a row to `columns` terminal cells by whole graphemes. Unicode rows end
 * in `…` (one cell); ASCII rows end in `...` (three cells) and still fit. Non-finite or
 * non-positive columns mean "80".
 */
export function clipRow(s: string, columns: number, ascii = false): string {
  const c = cols(columns);
  const text = ascii ? asciiRow(s) : s;
  if (stringWidth(text) <= c) return text;
  if (!ascii) return truncateCells(text, c);
  if (c <= 3) return '.'.repeat(c);
  const cut = truncateCells(text, c - 2);
  return cut.endsWith(ELLIPSIS) ? `${cut.slice(0, -ELLIPSIS.length)}...` : cut;
}

/** the default composer prompt of the flat tier, `--plain` and `--ascii` (TUI-DESIGN §4.3); the boxed tier passes `› ` (TUI-DESIGN-2 §4.4) */
export const MASKED_PROMPT_DEFAULT = '> ';

/**
 * TUI-DESIGN §11.1: `'•'.repeat(min(len, columns − <prompt cells> − 1))` (`*` in ASCII) after the prompt. TUI-DESIGN-2 §4.3: the
 * boxed tier passes `glyphs.prompt` (`› `) so the console draws `│ › •••••`; the default `> ` keeps every flat / plain twin. Pure.
 */
export function maskedFieldRow(length: number, columns: number, ascii = false, prompt: string = MASKED_PROMPT_DEFAULT): string {
  const c = cols(columns);
  const p = ascii ? asciiRow(prompt) : prompt;
  // NaN and negatives show nothing; Infinity shows as many bullets as fit.
  const n = length > 0 ? Math.min(Math.floor(Math.min(length, c)), Math.max(0, c - stringWidth(p) - 1)) : 0;
  return `${p}${glyphs(ascii).bullet.repeat(n)}`;
}

/** TUI-DESIGN §11.1: cursor column of the masked field (after the prompt and the shown bullets). */
export function maskedFieldCursorX(length: number, columns: number, prompt: string = MASKED_PROMPT_DEFAULT): number {
  return stringWidth(maskedFieldRow(length, columns, false, prompt));
}

/** TUI-DESIGN §24: `N chars · Enter saves · Backspace · Ctrl-U clears · paste ok · Esc back` (narrow: `N · Enter · ⌫ · ^U · Esc`), measured in cells. Pure. */
export function keyHintRow(length: number, columns: number, ascii = false): string {
  const g = glyphs(ascii);
  const n = Number.isFinite(length) && length > 0 ? Math.floor(length) : 0;
  const wide = `${n} chars ${g.dot} Enter saves ${g.dot} Backspace ${g.dot} Ctrl-U clears ${g.dot} paste ok ${g.dot} Esc back`;
  if (stringWidth(wide) <= cols(columns)) return wide;
  return `${n} ${g.dot} Enter ${g.dot} ${g.bksp} ${g.dot} ^U ${g.dot} Esc`;
}

/** TUI-DESIGN §24: `<Provider> API key (<ENV>)` — verbatim, no step counter; TUI-DESIGN-2 §1.4: the unprompted default is openrouter. */
export function generatorKeyTitle(provider: WizardProvider | null): string {
  const p = provider ?? DEFAULT_WIZARD_PROVIDER;
  return `${PROVIDER_DISPLAY[p]} API key (${PROVIDER_ENV[p]})`;
}

/**
 * TUI-DESIGN-2 §12 "Wizard": `Jev API key (TYPESAFE_API_KEY)  1/1` under typesafe, `Jev API key (JEV_API_KEY; falls back to
 * OPENROUTER_API_KEY)  1/1` under openrouter (and when no provider was chosen: those two variables are OpenRouter keys); the
 * counter is `2/2` after a generator step, `1/1` when the Jev key is the only field.
 */
export function jevKeyTitle(provider: JevProvider | null, counter: '1/1' | '2/2'): string {
  const env = provider === 'typesafe' ? 'TYPESAFE_API_KEY' : 'JEV_API_KEY; falls back to OPENROUTER_API_KEY';
  return `Jev API key (${env})  ${counter}`;
}

/**
 * TUI-DESIGN-2 §2.7 / TUI-DESIGN-3 §1.4.2: the verify detail keyed by the Jev provider and the target mode — openrouter with a
 * generator: the one-key row (decision · completion · key info); typesafe with a generator: its twin; typesafe alone: the one
 * decision; an anthropic generator (or jev-only under openrouter) keeps today's `WIZARD_VERIFY_DETAIL` (the models GET).
 */
export function verifyDetail(provider: JevProvider | null, mode: EngineMode = 'jev-only', generatorProvider: WizardProvider | null = null): string {
  const generator = mode !== 'jev-only' && generatorProvider !== 'anthropic';
  if (provider === 'typesafe') return generator ? WIZARD_VERIFY_DETAIL_TYPESAFE_GENERATOR : WIZARD_VERIFY_DETAIL_TYPESAFE;
  return generator ? WIZARD_VERIFY_DETAIL_ONE_KEY : WIZARD_VERIFY_DETAIL;
}
/** TUI-DESIGN-3 §1.4.2: the one-key title whenever the verify includes a code-model completion; jev-only (and anthropic) wizards keep today's */
export function verifyTitle(mode: EngineMode, generatorProvider: WizardProvider | null = null): string {
  return mode !== 'jev-only' && generatorProvider !== 'anthropic' ? WIZARD_VERIFY_TITLE_ONE_KEY : WIZARD_VERIFY_TITLE;
}

/** TUI-DESIGN-2 §1.4 / §4.3 / §12 "Console": the boxed console's hosted title for a wizard step — `setup · <step>`; null when no step is up. */
export function wizardConsoleTitle(state: Pick<OnboardingState, 'step'>): string | null {
  switch (state.step) {
    case 'key':
      return 'setup · key';
    case 'options':
      return 'setup · options';
    case 'jevProvider':
      return 'setup · jev provider';
    case 'provider':
      return 'setup · provider';
    case 'generatorKey':
      return 'setup · generator key';
    case 'jevKey':
      return 'setup · jev key';
    case 'verify':
      return 'setup · verify';
    case 'trust':
      return 'setup · trust';
    case 'import':
      return 'setup · import';
    default:
      return null;
  }
}

/** Bytes as `2.1 KiB` / `512 B` (sizes only, never contents). */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  const k = bytes / 1024;
  if (k < 1024) return `${k < 10 ? k.toFixed(1) : Math.round(k)} KiB`;
  return `${(k / 1024).toFixed(1)} MiB`;
}

/** TUI-DESIGN §11.3 / §24: `AGENTS.md changed since you trusted it (sha256 <8> → <8>)`. */
export function agentsChangedLine(from: string, to: string, ascii = false, name = 'AGENTS.md'): string {
  return `${name} changed since you trusted it (sha256 ${from.slice(0, 8)} ${glyphs(ascii).arrow} ${to.slice(0, 8)})`;
}

/** TUI-DESIGN §11.3 / §24 trust rows (4; 2 below rows 12: title + options). Sizes and counts only; measured in cells. Pure. */
export function trustLines(t: TrustInputs, rows: number, columns: number, ascii = false): string[] {
  const g = glyphs(ascii);
  const title = `Do you trust the files in ${t.root}?  (git root; stored per repository)`;
  const agents = t.agents ? `${t.agents.name} (${formatSize(t.agents.bytes)}) ${g.arrow} generator system prompt` : `AGENTS.md (none)`;
  const dotenv = t.dotenv === null ? './.env (none)' : t.dotenv.unreadable ? './.env (unreadable)' : `./.env (${t.dotenv.vars} vars, ${t.dotenv.secretLike} secret-like)`;
  const line2 = t.changed ? agentsChangedLine(t.changed.from, t.changed.to, ascii, t.agents?.name ?? 'AGENTS.md') : `  ${agents}   ${dotenv}`;
  const line3 = `  jevcode.json (${t.jevcodeJson ? formatSize(t.jevcodeJson.bytes) : 'none'})`;
  const all = Number.isFinite(rows) && rows < 12 ? [title, WIZARD_TRUST_OPTIONS] : [title, line2, line3, WIZARD_TRUST_OPTIONS];
  return all.map((l) => clipRow(l, columns, ascii));
}

// ---------------------------------------------------------------------------------------
// TUI-DESIGN-5 §5.1 / §12.4 S87–S88: the `import` wizard step. The three rows fit D1's ≤ 4-row budget.
// ---------------------------------------------------------------------------------------

/** §12.4 S87 row 1, without the probe summary (the narrow rung). */
export const WIZARD_IMPORT_TITLE = 'Import your memory and workflows?';
/** §12.4 S87 row 2, verbatim (ONE leading space, exactly as S87 spells the fragment). */
export const WIZARD_IMPORT_OPTIONS = ' 1 import now   2 later   3 never';
/** IMPORT-DESIGN §5.1 / F-57: the narrow twin of the options row. */
export const WIZARD_IMPORT_OPTIONS_NARROW = ' 1 import  2 later  3 never';
/** §12.4 S87 row 3 — Esc is `2 later`, said out loud so nobody has to guess. */
export const WIZARD_IMPORT_HINT = ' (Esc = later)';
/** IMPORT-DESIGN §5.1: the wider hint, when the row has room for the promise that matters most. */
export const WIZARD_IMPORT_HINT_FULL = 'Nothing is written until you approve it · Esc later · Ctrl-C closes';
/** §12.4 S87 SR: numbered, counts spoken as words, no glyphs. */
export const SR_IMPORT_ROWS: readonly [string, string] = [WIZARD_IMPORT_TITLE, '1. Import now  2. Later  3. Never · Enter selection (1-3):'];
/** §12.4 S88: the read-only minsize row of the import step — it names `choose`, not `type` (nothing is typed here). */
export const WIZARD_IMPORT_MINSIZE_CLAUSE = 'terminal too small';

/**
 * §5.1 / F-O: `found claude-code (43 notes), codex (3 servers)` — tool names and counts only, never a path.
 * Falls back to `found 4 tools (61 items)` when the list would not fit, and to `''` when nothing was found (the
 * step does not render at all in that case, §7 row 52).
 */
/**
 * **Declared string deviation (§13.2).** §12.4 S87 and F-57 spell per-tool nouns —
 * `found claude-code (43 notes), codex (3 servers)` — but `ImportProbe.tools` (`src/core/types.ts:3384`) carries
 * `{ tool, display, items }` and no noun, so `items` is the only honest word this build can say. The harness
 * request for a `noun` field is filed in the implementer report; until it lands, `items` is the substitution and
 * `import-step.test.tsx` asserts it rather than leaving it to drift.
 */
export function importProbeSummary(probe: ImportProbeCounts | null, width = 80): string {
  if (probe === null || probe.total === 0 || probe.tools.length === 0) return '';
  const parts = probe.tools.map((t) => `${t.display} (${t.items} item${t.items === 1 ? '' : 's'})`);
  const full = `found ${parts.join(', ')}`;
  if (stringWidth(full) <= width) return full;
  const short = `found ${probe.tools.length} tool${probe.tools.length === 1 ? '' : 's'} (${probe.total} item${probe.total === 1 ? '' : 's'})`;
  // §5.8: at 40 columns the title row is the title alone — a summary that does not fit is DROPPED, never clipped
  // (a clipped `found claude-co…` names a tool the user does not have).
  return stringWidth(short) <= width ? short : '';
}

/** §12.4 S87 row 1: the title plus the probe summary when both fit; the bare title otherwise. */
export function importTitleRow(probe: ImportProbeCounts | null, columns: number): string {
  const c = cols(columns);
  const summary = importProbeSummary(probe, Math.max(0, c - stringWidth(WIZARD_IMPORT_TITLE) - 2));
  return summary === '' ? WIZARD_IMPORT_TITLE : `${WIZARD_IMPORT_TITLE}  ${summary}`;
}

/**
 * §5.1: the options row, with the highlighted digit marked exactly as the `options` step marks its own.
 *
 * The rung is chosen **after** the mark is applied. The mark is one cell wider than the space it replaces, so
 * picking the wide rung first and then inserting it produced a row one cell wider than the width it had been
 * measured against — which `clipRow` then ate the tail of (`3 neve…`) at exactly 34 and 27 columns. The last
 * resort is a clip here rather than in the caller, so the row is never wider than the terminal at any width.
 */
export function importOptionsRow(highlight: ImportOption | null, columns: number, ascii = false): string {
  const marked = (base: string): string => {
    const row = ascii ? asciiRow(base) : base;
    if (highlight === null) return row;
    const mark = ascii ? '>' : '▌';
    return row.replace(new RegExp(`(^|\\s)${highlight} `), (m) => `${m.slice(0, -2)}${mark}${highlight} `);
  };
  return clipRow(fitRung([marked(WIZARD_IMPORT_OPTIONS), marked(WIZARD_IMPORT_OPTIONS_NARROW)], cols(columns)), columns, ascii);
}

/** TUI-DESIGN-4 §2.5 / §12: the wizard's minimum terminal size, as the rows and the toast say it. */
export const WIZARD_MINSIZE_COLUMNS = 40;
export const WIZARD_MINSIZE_ROWS = 8;
/** TUI-DESIGN-4 §2.5 edge 3 / §12: the one `<Static>` item a `rows < 3` terminal gets (per size drop, never per frame; the App commits it). */
export const WIZARD_MINSIZE_STATIC_ITEM = 'setup needs a terminal of at least 40×8';
/** TUI-DESIGN-4 §2.5 / §12: the read-only-wizard toast — every key at minsize produces this and changes no wizard state. */
export const WIZARD_MINSIZE_TOAST = 'resize to at least 40×8 to continue setup';
/** TUI-DESIGN-4 §2.5 edge 2: the minsize row never shows more than this many `•`, so a long key is a progress mark, not a length leak. */
export const WIZARD_MINSIZE_MASK_MAX = 8;

/** TUI-DESIGN-4 §2.5: the one-row wizard twin's step word (the console title's tail, so the two never drift). */
function minsizeStepWord(step: WizardStep): string | null {
  const title = wizardConsoleTitle({ step });
  return title === null ? null : title.replace(/^setup · /, '');
}

/**
 * TUI-DESIGN-4 §2.5 (P-R6, D4): **one row per wizard step at minimum size, read-only.** `computeLayout` grants
 * notice(1) · wizard(1) and no composer below 40×8, and this is the wizard's row. Every step's row is informational:
 * keys are consumed and produce `WIZARD_MINSIZE_TOAST`, so a first-run user is never invited to type into a composer
 * whose Enter cannot start anything, and — edge 2 — an invisible masked field is never drawn. When text was already
 * entered at a larger size the row shows a **`•` count of what exists** (capped, never a caret, never a character):
 * a progress indicator for text that exists, never an invitation to add to it.
 *
 * Every candidate is measured after substitution and chosen with `fitRung` (§2.6), so the row is never truncated and
 * `cellWidth(row) ≤ columns` at every width. Returns `''` for a step with no wizard row (`detect`, `save`, `sandbox`,
 * `done`, `exit`).
 */
export interface WizardMinsizeOptions {
  /**
   * TUI-DESIGN-4 §2.5 (P-R6): the row is the **only** one the overlay draws — `computeLayout`'s minsize branch grants
   * one row, not P-R6's notice(1) · wizard(1), so no sentence above it says why the panes are gone. The ladder then
   * leads with the rungs that name the size, because a numbered choice the user cannot act on (the wizard is
   * read-only at minsize) is worth less than the reason it is read-only. With the notice above it, the choices lead.
   */
  readonly alone?: boolean;
}

export function wizardMinsizeRow(state: OnboardingState, columns: number, ascii = false, opts: WizardMinsizeOptions = {}): string {
  const word = minsizeStepWord(state.step);
  if (word === null) return '';
  const c = cols(columns);
  const g = glyphs(ascii);
  const dash = ascii ? '-' : '—';
  const ge = ascii ? '>=' : '≥';
  const times = ascii ? 'x' : '×';
  const size = `${WIZARD_MINSIZE_COLUMNS}${times}${WIZARD_MINSIZE_ROWS}`;
  const head = `setup ${g.dot} ${word}`;
  if (isFieldStep(state.step)) {
    // edge 2: the `•` count of already-entered text only — never a caret, never a character, never the length itself
    const mask = state.length > 0 ? g.bullet.repeat(Math.min(state.length, WIZARD_MINSIZE_MASK_MAX)) : '';
    const clause = mask === '' ? 'terminal too small' : mask;
    // the widest rung is §12's normative key row and already names the size, so `alone` changes nothing here
    return fitRung([`${head} ${dash} ${clause}; ${ge} ${size} to type`, `${head} ${dash} ${ge} ${size}`, `${head} ${dash} ${size}`, head, 'setup'], c);
  }
  const choices = choiceRow(state, ascii);
  const tail = `${ge} ${size} to continue`;
  // TUI-DESIGN-5 §12.4 S88: the import step's own widest rung names what the size buys — `to choose`, not
  // `to continue`, because nothing on that step continues by itself. Only this step gains a rung; every other
  // step's ladder is round 4's, untouched (its rows are pinned by `onboarding/lines.test.ts`).
  const sized =
    state.step === 'import'
      ? [`${head} ${dash} ${WIZARD_IMPORT_MINSIZE_CLAUSE}; ${ge} ${size} to choose`, `${head} ${dash} ${tail}`, `${head} ${dash} ${size}`]
      : [`${head} ${dash} ${tail}`, `${head} ${dash} ${size}`];
  const picked = choices === null ? [] : [`${head} ${dash} ${choices}`, choices];
  // TUI-DESIGN-5 §12.4 S88: the IMPORT step always leads with the sized rungs, `alone` or not — S88 is the pinned
  // string, and the import choice is the one that costs nothing to postpone (Esc is `2 later`), so naming the size
  // beats naming three digits the read-only minsize wizard cannot act on.
  const sizedFirst = opts.alone === true || state.step === 'import';
  return fitRung([...(sizedFirst ? [...sized, ...picked] : [...picked, ...sized]), head, 'setup'], c);
}

/** TUI-DESIGN-4 §2.5 edge 1: the numbered choice row of a picking step, from the same narrow tables the full wizard uses (`1 typesafe  2 openrouter` is 24 cells). */
function choiceRow(state: OnboardingState, ascii: boolean): string | null {
  const squeeze = (s: string): string => s.trim().replace(/ {2,}/g, '  ');
  switch (state.step) {
    case 'options':
      return squeeze(ascii ? asciiRow(WIZARD_OPTIONS_NARROW) : WIZARD_OPTIONS_NARROW);
    case 'provider':
      return squeeze(WIZARD_PROVIDER_OPTIONS_NARROW);
    case 'jevProvider':
      return squeeze(WIZARD_JEV_PROVIDER_OPTIONS_NARROW);
    case 'trust':
      return '1 trust  2 session  3 no';
    case 'verify':
      return '[y] verify  [n] skip';
    case 'import':
      return '1 import  2 later  3 never';
    default:
      return null;
  }
}

/**
 * TUI-DESIGN §11.1: the rows of the wizard's current step (≤ 4, per `wizardRows`), one string per
 * row, clipped to `columns` cells. The key field row is built from `state.length` only. Pure.
 */
export function wizardLines(state: OnboardingState, view: WizardView): string[] {
  const ascii = view.ascii ?? false;
  const sr = view.screenReader ?? false;
  const c = view.columns;
  const clip = (l: string): string => clipRow(l, c, ascii);
  switch (state.step) {
    case 'key': {
      // TUI-DESIGN-3 §1.4.2: the one-paste field — the found-title when a key already resolves, else the OpenRouter title
      const title = state.found === null ? WIZARD_KEY_TITLE : keyFoundTitle(state.found, state.foundSource);
      const empty = state.length === 0;
      const reuse = reuseJevOffered(state);
      const emptyHint = reuse ? (state.foundSource === 'file' ? WIZARD_REUSE_JEV_FILE_HINT : WIZARD_REUSE_JEV_HINT) : state.found === 'typesafe' || state.found === 'jev' ? WIZARD_KEY_HINT_FOUND_TYPESAFE : state.found === 'anthropic' ? WIZARD_KEY_HINT_FOUND_ANTHROPIC : WIZARD_KEY_HINT_EMPTY;
      const hint = state.hint ?? (empty ? emptyHint : oneKeyHintRow(state.length, c, ascii));
      if (sr) return [title, SR_KEY_FIELD_LABEL(state.length), state.hint ?? SR_KEY_HINT].map(clip);
      return [title, maskedFieldRow(state.length, c, ascii, view.prompt ?? MASKED_PROMPT_DEFAULT), hint].map(clip);
    }
    case 'options': {
      // TUI-DESIGN-3 §1.4.2: a digit highlights (`▌`, the title names it, the hint is its consequence); the same digit or Enter confirms
      if (sr) return [...SR_OPTIONS_ROWS].map(clip);
      const hint = state.hint ?? (state.highlight === null ? WIZARD_OPTIONS_HINT : optionHint(state.highlight));
      return [optionsTitle(state.highlight), optionsRow(state.highlight, c, ascii), hint].map(clip);
    }
    case 'jevProvider': {
      // TUI-DESIGN-2 §1.4 / §12: `1 typesafe … 2 openrouter …`; Enter accepts a preselection. TUI-DESIGN-3 §4.4 F19: `/login` re-entry drops "No Jev key found."
      const title = state.reason === 'login' ? WIZARD_JEV_PROVIDER_TITLE_LOGIN : WIZARD_JEV_PROVIDER_TITLE;
      if (sr) return [title, '1. typesafe (TYPESAFE_API_KEY, api.typesafe.ai)  2. openrouter (OPENROUTER_API_KEY, also the generator)', 'Enter selection (1-2):'].map(clip);
      const options = stringWidth(WIZARD_JEV_PROVIDER_OPTIONS) <= cols(c) ? WIZARD_JEV_PROVIDER_OPTIONS : WIZARD_JEV_PROVIDER_OPTIONS_NARROW;
      const hint = state.hint ?? (state.jevProvider ? `${WIZARD_PROVIDER_HINT} · Enter = ${state.jevProvider}` : WIZARD_PROVIDER_HINT);
      return [title, options, hint].map(clip);
    }
    case 'provider': {
      // TUI-DESIGN-2 §1.4: under reason `mode` the step is the generator step in place — its own title (keyed by the target mode) and Ctrl-C hint
      const title = state.reason === 'mode' ? providerTitleMode(state.mode) : WIZARD_PROVIDER_TITLE;
      const base = state.reason === 'mode' ? providerHintMode(state.currentMode) : WIZARD_PROVIDER_HINT;
      if (sr) return [title, '1. anthropic (ANTHROPIC_API_KEY)  2. openrouter (OPENROUTER_API_KEY, also Jev)', 'Enter selection (1-2):'].map(clip);
      const options = stringWidth(WIZARD_PROVIDER_OPTIONS) <= cols(c) ? WIZARD_PROVIDER_OPTIONS : WIZARD_PROVIDER_OPTIONS_NARROW;
      const hint = state.hint ?? (state.provider ? `${base} · Enter = ${state.provider}` : base);
      return [title, options, hint].map(clip);
    }
    case 'generatorKey':
    case 'jevKey': {
      const counter = state.entered.includes('generator.apiKey') || state.providerShown ? '2/2' : '1/1';
      // TUI-DESIGN-3 §1.4.2: option `2`'s generator field says Enter skips it
      const title = state.step === 'jevKey' ? jevKeyTitle(state.jevProvider, counter) : state.optionsChoice === 2 ? WIZARD_GENERATOR_TITLE_SKIPPABLE : generatorKeyTitle(state.provider);
      // TUI-DESIGN-2 §1.4: `Enter = reuse` only when the OpenRouter generator key was typed here and the Jev provider is openrouter (or unresolved) — never under typesafe
      const reuse = state.length === 0 && reuseOffered(state);
      const hint = state.hint ?? (reuse ? WIZARD_REUSE_HINT : skipOffered(state) ? LOGIN_JEV_SKIP_HINT_ROW : keyHintRow(state.length, c, ascii));
      if (sr) return [title, SR_KEY_FIELD_LABEL(state.length), hint].map(clip);
      return [title, maskedFieldRow(state.length, c, ascii, view.prompt ?? MASKED_PROMPT_DEFAULT), hint].map(clip);
    }
    case 'verify': {
      // TUI-DESIGN-3 §1.4.2: the title and detail follow the target mode and the providers (one decision + one completion + the key info under openrouter)
      const mode = targetMode(state);
      const second = state.verifying ? WIZARD_VERIFYING : verifyDetail(state.jevProvider, mode, state.provider);
      return [verifyTitle(mode, state.provider), second].map(clip);
    }
    case 'import': {
      // TUI-DESIGN-5 §12.4 S87: title (+ the probe summary when it fits) · the three options · `(Esc = later)`.
      if (sr) return [...SR_IMPORT_ROWS].map(clip);
      const title = importTitleRow(state.importProbe, c);
      const options = importOptionsRow(state.importHighlight, c, ascii);
      // F-57 (§5.7), the 40-column frame: when the summary does not fit BESIDE the title but does fit on a row
      // of its own, it takes that row — `setup · import` / `found claude-code (43 items)` / `1 import  2 later
      // 3 never`. Dropping it entirely (the old behaviour) asked "Import your memory and workflows?" with no
      // statement of what was found, which is the one fact that makes the offer answerable; the row it replaces
      // is `(Esc = later)`, which the options row's own `2 later` already implies.
      const summary = importProbeSummary(state.importProbe, cols(c));
      if (state.hint === null && summary !== '' && !title.includes(summary)) return [title, summary, options].map(clip);
      const hint = state.hint ?? (stringWidth(WIZARD_IMPORT_HINT_FULL) <= cols(c) ? WIZARD_IMPORT_HINT_FULL : WIZARD_IMPORT_HINT);
      return [title, options, hint].map(clip);
    }
    case 'trust': {
      const t = view.trust ?? { root: '.', agents: null, dotenv: null, jevcodeJson: null };
      const lines = trustLines(t, view.rows, c, ascii);
      if (sr) return [lines[0]!, ...lines.slice(1, -1), "1. trust  2. this session only  3. don't trust", 'Enter selection (1-3):'].map(clip);
      return lines;
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------------------
// Setup items (§24): committed by the host as `[setup]` / `[config]` / `[sandbox]` lines
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN §24: `verified: openrouter key ok (label "<label>", limit remaining $x)`. */
export function verifiedText(provider: string, label: string, limitRemaining: number | null): string {
  const limit = limitRemaining === null || !Number.isFinite(limitRemaining) ? 'unknown' : `$${limitRemaining.toFixed(2)}`;
  return `verified: ${provider} key ok (label "${label}", limit remaining ${limit})`;
}

/** TUI-DESIGN-2 §2.7: the typesafe verification — one priced decision; status only (`verified: typesafe key ok (jev-1.13.0, 319 input tokens)`). */
export function verifiedTypesafeText(model: string, inputTokens: number | null): string {
  const tokens = inputTokens === null || !Number.isFinite(inputTokens) ? 'usage unknown' : `${Math.round(inputTokens)} input tokens`;
  return `verified: typesafe key ok (${model}, ${tokens})`;
}

/** TUI-DESIGN §24: `verification failed: <short> — the key was kept; fix it with /login`. */
export function verificationFailedText(short: string): string {
  return `verification failed: ${short} — the key was kept; fix it with /login`;
}

/** TUI-DESIGN §24: `<VAR> set but empty — treated as unset` (the `.env.example` case); `where` names the dotenv file. */
export function emptyEnvText(envVar: string, where: string | null = null): string {
  return `${envVar}${where ? ` in ${where}` : ''} set but empty — treated as unset`;
}

/** TUI-DESIGN §24: `dotenv: <path>` — the source line shown when `3 don't trust` still reads `./.env` for keys (P38). */
export function dotenvSourceText(path: string): string {
  return `dotenv: ${path}`;
}

/** the fallbacks every `none` sentence ends with, whatever the reason the sandbox is not there */
const SANDBOX_NONE_TAIL = 'cwd confinement, env scrubbing, timeout, output cap and tree kill only';

/**
 * Why `detectSandboxLevel` reported `none`, from the profile the user asked for. `detectSandboxLevel` returns `none`
 * for `profile === 'none'` BEFORE it probes anything (`src/sandbox/seatbelt.ts`), so the level alone cannot tell
 * "the user turned it off" from "this platform has no sandbox-exec" — and printing the platform sentence for
 * `--sandbox none` on macOS was a false statement (finishing audit #5).
 */
function sandboxNoneReason(profile: SandboxProfile, platform: string): string {
  if (profile === 'none') return 'off by request (--sandbox none)';
  if (profile === 'seatbelt') return `seatbelt requested, but sandbox-exec is not available on ${platform}`;
  return `sandbox-exec is not available on ${platform}`;
}

/**
 * TUI-DESIGN §24 sandbox line (`[sandbox]` label). TUI-DESIGN-3 §5.1 rule 13: one thought per row, ` · ` separators (the renderer
 * breaks it at ` · `); the old sentence is the TUI-only `detail` (`sandboxDetail`). A renderer-local item, never in `transcript.log`.
 *
 * `profile` is what the user ASKED for and `level` is what was detected, so the `none` row states which of the three
 * true things happened: chosen, unavailable, or requested-and-unavailable.
 */
export function sandboxText(level: SandboxLevel, profile: SandboxProfile = 'auto', platform: string = process.platform): string {
  return level === 'seatbelt' ? 'seatbelt · writes only in the workspace and run dirs · secrets, ~/.ssh, ~/.aws unreadable · network on (--no-network)' : `none · ${sandboxNoneReason(profile, platform)} · ${SANDBOX_NONE_TAIL}`;
}
/** TUI-DESIGN-3 §5.1 rule 13: the `[sandbox]` item's TUI-only detail body — the same three reasons, in the detail's `—`/`:` shape */
export function sandboxDetail(level: SandboxLevel, profile: SandboxProfile = 'auto', platform: string = process.platform): string {
  return level === 'seatbelt'
    ? 'seatbelt — writes confined to the workspace and run dirs; harness secret files, ~/.ssh, ~/.aws unreadable; reads elsewhere and network allowed unless --no-network'
    : `none — ${sandboxNoneReason(profile, platform)}: ${SANDBOX_NONE_TAIL}`;
}

/** TUI-DESIGN-3 §1.6 / §10: the jev-only fix block keeps today's five lines verbatim */
export const FIX_BLOCK_JEV_ONLY: readonly string[] = ['export TYPESAFE_API_KEY=…', 'export OPENROUTER_API_KEY=…', 'printenv TYPESAFE_API_KEY | jevcode login --jev-provider typesafe --jev-key-stdin', 'jevcode login', FIX_BLOCK_FOOTER];
/** TUI-DESIGN-3 §1.6 / §10: the generator-mode fix block — the `#` column is cell 30, every line ≤ 76 cells */
export const FIX_BLOCK_ONE_KEY: readonly string[] = [
  'export OPENROUTER_API_KEY=…   # one key: Jev + the code model',
  'printenv OPENROUTER_API_KEY | jevcode login --key-stdin',
  'jevcode login                 # masked prompt',
  'export TYPESAFE_API_KEY=…     # Jev native; add OPENROUTER_API_KEY for code',
  '                              # Jev alone: jevcode config set mode jev-only',
];
export const FIX_BLOCK_ANTHROPIC_LINE = 'export ANTHROPIC_API_KEY=…    # the code model under --provider anthropic';
/**
 * TUI-DESIGN-3 §1.6 / round-5 item 4: the pipe ConfigError text when only the generator key is missing under a
 * generator mode. It names the RESOLVED provider's own variable: the constant this replaced always said
 * `OPENROUTER_API_KEY`, so `--provider anthropic --no-input` told the user to export a variable that would not
 * work. `PROVIDER_KEY_ENV` (src/provider/ids.ts, zero-import) is the one table of key names.
 */
export function missingGeneratorOnly(provider: ProviderId | null): string {
  const env = (provider !== null ? PROVIDER_KEY_ENV[provider][0] : undefined) ?? 'OPENROUTER_API_KEY';
  return `missing generator.apiKey: set ${env} (the code model), run with --mode jev-only, or run jevcode login`;
}

/**
 * TUI-DESIGN §11.1 / §24, TUI-DESIGN-2 §1.4 / §12 "Wizard" and TUI-DESIGN-3 §1.6: the ONE fix block, printed after the ConfigError
 * line on a non-TTY / `--plain` pipe / `CI` / `--no-input` and as a `[setup]` block after a wizard Ctrl-C. `mode` is required (§1.1:
 * no default argument names a mode): jev-only keeps today's five lines; every generator mode (jev-on / llm-jev / jev-off) leads with the
 * one OpenRouter key and the piped `--key-stdin`, names the TypeSafe route and the jev-only escape, and adds the Anthropic line only
 * under `--provider anthropic`.
 */
export function fixBlockLines(mode: EngineMode, provider: WizardProvider | null = null): string[] {
  if (mode === 'jev-only') return [...FIX_BLOCK_JEV_ONLY];
  const lines = [...FIX_BLOCK_ONE_KEY];
  if (provider === 'anthropic') lines.push(FIX_BLOCK_ANTHROPIC_LINE);
  lines.push(FIX_BLOCK_FOOTER);
  return lines;
}

/** TUI-DESIGN §11.3: the non-interactive skip line (research 13 §5.7). */
export const INSTRUCTIONS_NOT_TRUSTED_LINE = 'AGENTS.md not loaded: workspace not trusted (run interactively once, or pass --trust-workspace)';
