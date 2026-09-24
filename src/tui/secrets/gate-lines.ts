/**
 * Secret gate strings (TUI-DESIGN §4.10, §10.2, §24 "Overlays"/"Toasts"/"CLI"). Pure functions
 * over `SecretHit[]` shared by the Ink overlay row, the readline twin and the non-TTY refusal so
 * every writer renders the same words. Labels come from `detectSecrets` and never carry the
 * secret's tail.
 */
import type { SecretHit } from '../../core/types.js';
import { EXACT_FAMILY } from '../../core/redact.js';
import { truncateCells } from '../composer/width.js';

/** TUI-DESIGN §4.10: dismiss tip (one frame). */
export const GATE_DISMISS_TIP = 'Tip: put it in .env and refer to it by name';
/** TUI-DESIGN §10.4: the per-mention row behind --allow-secret-mention. */
export const ATTACH_ANYWAY_ROW = 'Attach anyway? y/N';
/** TUI-DESIGN §4.10: a `y` within this many ms of the Enter that opened the gate is text, not consent. */
export const GATE_ARM_MS = 150;

/** Distinct labels in hit order (two `sk-ant-…` hits list the label once; the count still says 2). */
export function gateLabels(hits: readonly SecretHit[]): string[] {
  const out: string[] = [];
  for (const h of hits) if (!out.includes(h.label)) out.push(h.label);
  return out;
}

function exactNames(hits: readonly SecretHit[]): string[] {
  const out: string[] = [];
  for (const h of hits) {
    if (h.family !== EXACT_FAMILY) continue;
    const name = h.label.startsWith('your ') ? h.label.slice(5) : h.label;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** Clip to `columns` terminal cells (§4.2), not code points; no cap → the row as is. */
function clipRow(s: string, columns: number | undefined): string {
  if (columns === undefined || !Number.isFinite(columns) || columns <= 0) return s;
  return truncateCells(s, Math.floor(columns));
}

/**
 * TUI-DESIGN §4.10 / §24: the one-row gate — `Looks like this contains a secret (<label>). Send
 * anyway? y/N`, plural `… N secrets (<labels>) …`, exact `… your <NAME> …`. Empty hits → [].
 */
export function gateLines(hits: readonly SecretHit[], columns?: number): string[] {
  if (hits.length === 0) return [];
  const exact = exactNames(hits);
  let row: string;
  if (exact.length > 0 && exact.length === hits.length) {
    row = `Looks like this contains your ${exact.join(', ')}. Send anyway? y/N`;
  } else if (hits.length === 1) {
    row = `Looks like this contains a secret (${hits[0]!.label}). Send anyway? y/N`;
  } else {
    row = `Looks like this contains ${hits.length} secrets (${gateLabels(hits).join(', ')}). Send anyway? y/N`;
  }
  return [clipRow(row, columns)];
}

/** TUI-DESIGN §4.10: the readline twin — `jevcode: looks like this contains a secret (<label>); type y to send, anything else to cancel:`. */
export function gatePlainPrompt(hits: readonly SecretHit[]): string {
  const exact = exactNames(hits);
  const what = exact.length > 0 && exact.length === hits.length ? `your ${exact.join(', ')}` : hits.length === 1 ? `a secret (${hits[0]?.label ?? ''})` : `${hits.length} secrets (${gateLabels(hits).join(', ')})`;
  return `jevcode: looks like this contains ${what}; type y to send, anything else to cancel:`;
}

/** TUI-DESIGN §10.2 / §24: non-TTY, --no-input or --json — `jevcode: the task contains a secret (<label>); refusing to start (exit 2)`. */
export function gateRefusalLine(hits: readonly SecretHit[]): string {
  const label = hits.length === 0 ? '' : hits.length === 1 ? hits[0]!.label : gateLabels(hits).join(', ');
  return `jevcode: the task contains a secret (${label}); refusing to start (exit 2)`;
}

/** TUI-DESIGN §4.8 / §24: `editor: the draft contains a secret (<label>); remove it or send it first`. */
export function editorRefusalToast(hits: readonly SecretHit[]): string {
  const label = hits.length === 0 ? '' : hits.length === 1 ? hits[0]!.label : gateLabels(hits).join(', ');
  return `editor: the draft contains a secret (${label}); remove it or send it first`;
}

/** TUI-DESIGN §24: `[step n] sent K secret(s) to the generator on request` body (the label is `stepLabel()`). */
export function secretAckText(count: number): string {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return `sent ${n} ${n === 1 ? 'secret' : 'secrets'} to the generator on request`;
}

/** TUI-DESIGN §7.4 / §24: the dim status badge while the draft has a hit. */
export const SECRET_BADGE = '⚠ secret?';
/** §14.1: ASCII twin of the badge (never `⚠️` with VS16). */
export const SECRET_BADGE_ASCII = '! secret?';

/**
 * TUI-DESIGN §4.10: is a `y` at `atMs` a consent? Only on a frame after the row was armed
 * (`armedAtMs !== null`) and not within GATE_ARM_MS of the Enter that opened it (`openedAtMs`).
 * Pure; clocks are passed in.
 */
export function gateAccepts(input: string, openedAtMs: number, armedAtMs: number | null, atMs: number): boolean {
  if (input !== 'y' && input !== 'Y') return false;
  if (armedAtMs === null) return false;
  if (!Number.isFinite(atMs) || !Number.isFinite(openedAtMs)) return false;
  return atMs >= armedAtMs && atMs - openedAtMs >= GATE_ARM_MS;
}
