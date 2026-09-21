/**
 * Wizard rows and setup strings (TUI-DESIGN §11.1–§11.3, §24 "Wizard"). Pure `lines()` functions
 * shared by the Ink wizard, `--plain`, `--screen-reader` and `--ascii` (§14.1 glyph table); the
 * rows never contain a key byte — the field is rendered from its masked length only. Rows are
 * measured in terminal cells (`stringWidth`/`truncateCells`, §4.2), never code points, so a CJK or
 * emoji git-root path never wraps and breaks the ≤ 4-row budget (D1). The `[setup]`/`[config]`
 * item builders live in `src/config/credentials.ts` (config never imports the TUI) and are
 * re-exported here for the renderers.
 */
import type { OnboardingState, WizardProvider } from './reducer.js';
import type { SandboxLevel } from '../../core/types.js';
import type { TrustInputs } from '../../config/trust.js';
import { ELLIPSIS, stringWidth, truncateCells } from '../composer/width.js';

/** TUI-DESIGN §11.3: the trust prompt's inputs (declared in config/trust.ts; re-exported for the renderers). */
export type { TrustInputs } from '../../config/trust.js';
/** TUI-DESIGN §24 item builders (declared in config/credentials.ts; re-exported for the renderers). */
export { WINDOWS_ACL_NOTE, keyEnteredText, savedText, shadowingText } from '../../config/credentials.js';

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
}

/** TUI-DESIGN §11.1: the env variable each provider's key is read from. */
export const PROVIDER_ENV: Readonly<Record<WizardProvider, string>> = { anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY' };
/** Display names for the `<Provider> API key (<ENV>)` title. */
export const PROVIDER_DISPLAY: Readonly<Record<WizardProvider, string>> = { anthropic: 'Anthropic', openrouter: 'OpenRouter' };

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

/** TUI-DESIGN §14.1 glyph substitutions used by these rows. */
function glyphs(ascii: boolean): { bullet: string; arrow: string; dot: string; bksp: string } {
  return ascii ? { bullet: '*', arrow: '->', dot: '-', bksp: 'Bksp' } : { bullet: '•', arrow: '→', dot: '·', bksp: '⌫' };
}

/** TUI-DESIGN §14.1: the `--ascii` twin of a row — every glyph these rows use has an ASCII form; user paths pass through. */
export function asciiRow(s: string): string {
  return s.replace(/·/g, '-').replace(/→/g, '->').replace(/•/g, '*').replace(/⌫/g, 'Bksp').replace(/—/g, '-').replace(/…/g, '...').replace(/⚠/g, '!');
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

/** TUI-DESIGN §11.1: `'•'.repeat(min(len, columns − 3))` (`*` in ASCII) after the `> ` prompt. Pure. */
export function maskedFieldRow(length: number, columns: number, ascii = false): string {
  const c = cols(columns);
  // NaN and negatives show nothing; Infinity shows as many bullets as fit.
  const n = length > 0 ? Math.min(Math.floor(Math.min(length, c)), Math.max(0, c - 3)) : 0;
  return `> ${glyphs(ascii).bullet.repeat(n)}`;
}

/** TUI-DESIGN §11.1: cursor column of the masked field (after the `> ` prompt and the shown bullets). */
export function maskedFieldCursorX(length: number, columns: number): number {
  return stringWidth(maskedFieldRow(length, columns));
}

/** TUI-DESIGN §24: `N chars · Enter saves · Backspace · Ctrl-U clears · paste ok · Esc back` (narrow: `N · Enter · ⌫ · ^U · Esc`), measured in cells. Pure. */
export function keyHintRow(length: number, columns: number, ascii = false): string {
  const g = glyphs(ascii);
  const n = Number.isFinite(length) && length > 0 ? Math.floor(length) : 0;
  const wide = `${n} chars ${g.dot} Enter saves ${g.dot} Backspace ${g.dot} Ctrl-U clears ${g.dot} paste ok ${g.dot} Esc back`;
  if (stringWidth(wide) <= cols(columns)) return wide;
  return `${n} ${g.dot} Enter ${g.dot} ${g.bksp} ${g.dot} ^U ${g.dot} Esc`;
}

/** TUI-DESIGN §24: `<Provider> API key (<ENV>)` — verbatim, no step counter (the Jev title carries its own `2/2`). */
export function generatorKeyTitle(provider: WizardProvider | null): string {
  const p = provider ?? 'anthropic';
  return `${PROVIDER_DISPLAY[p]} API key (${PROVIDER_ENV[p]})`;
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
    case 'provider': {
      if (sr) return [WIZARD_PROVIDER_TITLE, '1. anthropic (ANTHROPIC_API_KEY)  2. openrouter (OPENROUTER_API_KEY, also Jev)', 'Enter selection (1-2):'].map(clip);
      const options = stringWidth(WIZARD_PROVIDER_OPTIONS) <= cols(c) ? WIZARD_PROVIDER_OPTIONS : WIZARD_PROVIDER_OPTIONS_NARROW;
      const hint = state.hint ?? (state.provider ? `${WIZARD_PROVIDER_HINT} · Enter = ${state.provider}` : WIZARD_PROVIDER_HINT);
      return [WIZARD_PROVIDER_TITLE, options, hint].map(clip);
    }
    case 'generatorKey':
    case 'jevKey': {
      const title = state.step === 'jevKey' ? WIZARD_JEV_TITLE : generatorKeyTitle(state.provider);
      const reuse = state.step === 'jevKey' && state.length === 0 && state.provider === 'openrouter' && state.entered.includes('generator.apiKey');
      const hint = state.hint ?? (reuse ? WIZARD_REUSE_HINT : keyHintRow(state.length, c, ascii));
      if (sr) return [title, SR_KEY_FIELD_LABEL(state.length), hint].map(clip);
      return [title, maskedFieldRow(state.length, c, ascii), hint].map(clip);
    }
    case 'verify': {
      const second = state.verifying ? WIZARD_VERIFYING : WIZARD_VERIFY_DETAIL;
      return [WIZARD_VERIFY_TITLE, second].map(clip);
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

/** TUI-DESIGN §24 sandbox line (`[sandbox]` label). */
export function sandboxText(level: SandboxLevel, platform: string = process.platform): string {
  return level === 'seatbelt'
    ? 'seatbelt — writes confined to the workspace and run dirs; harness secret files, ~/.ssh, ~/.aws unreadable; reads elsewhere and network allowed unless --no-network'
    : `none — sandbox-exec is not available on ${platform}: cwd confinement, env scrubbing, timeout, output cap and tree kill only`;
}

/**
 * TUI-DESIGN §11.1 / §24: the four-line fix block printed after the ConfigError line on a
 * non-TTY / `--plain` pipe / `CI` / `--no-input`, plus the footer — verbatim (§24 names the
 * Anthropic variable regardless of provider; `jevcode login` covers the rest).
 */
export function fixBlockLines(): string[] {
  return ['export ANTHROPIC_API_KEY=…', 'export JEV_API_KEY=…', 'printenv OPENROUTER_API_KEY | jevcode login --jev-key-stdin', 'jevcode login', FIX_BLOCK_FOOTER];
}

/** TUI-DESIGN §11.3: the non-interactive skip line (research 13 §5.7). */
export const INSTRUCTIONS_NOT_TRUSTED_LINE = 'AGENTS.md not loaded: workspace not trusted (run interactively once, or pass --trust-workspace)';
