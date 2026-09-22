/** Types for `scripts/pty/polish-check.mjs` (the TUI-DESIGN-3 §9 hero-frame checklist), for the vitest callers. */
export interface PolishResult {
  id: string;
  /** null = skipped (needs the timing file, or deferred by the design) */
  pass: boolean | null;
  detail: string;
}
export interface PolishFrame {
  index: number;
  raw: string;
  rows: string[];
  rawRows: string[];
  ruleIndex: number;
  scrollback: string[];
  dynamic: string[];
  clears: number;
  hasFrame: boolean;
}
export interface PolishTiming {
  steps: { t: number; step?: number; op: string; arg?: string; off?: number }[];
  chunks: { t: number; off: number; n: number }[];
}
export interface PolishOptions {
  rows?: number;
  cols?: number;
  ascii?: boolean;
  version?: string | null;
  maxFps?: number;
  txt?: string;
  timing?: PolishTiming | null;
  /** the capture decoded as latin1 (byte offsets for the timing's chunk records); defaults to `capture` */
  byteCapture?: string;
}
export interface PaintedCell {
  ch: string;
  fg: string | null;
  bold: boolean;
  dim: boolean;
}
export const BSU: string;
export const CURSOR_HIDE: string;
export const RUN_ID_RE: RegExp;
export const PINK_FG: Set<string>;
export const ACCENT_FG: Set<string>;
export function stripAnsi(s: string): string;
export function cellWidth(s: string): number;
export function glyphChars(): Set<string>;
export function splitFrames(capture: string): { prologue: string; frames: PolishFrame[] };
export function frameOf(raw: string, index: number): PolishFrame;
export function isWordmarkRow(row: string, ascii?: boolean): boolean;
export function wordmarkCells(text: string): number;
export function paintRow(raw: string): PaintedCell[];
export function statusRowIndex(frame: PolishFrame): number;
export function checkPolish(capture: string, opts?: PolishOptions): { results: PolishResult[]; frames: PolishFrame[]; scrollback: string[] };
export function formatResults(results: readonly PolishResult[]): string;
