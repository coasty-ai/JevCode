/**
 * `PaneBoundary` (TUI-DESIGN §13.4, A161): a React error boundary that degrades one pane to a one-row notice —
 * `ui: <pane> pane failed to render (<Error.name>) — run continues; details in <log>` — so Ink's own
 * `InternalErrorBoundary` (42 rows, clears screen and scrollback) never fires. Wraps `live`, `Pane`, `Overlay`,
 * `Composer`, `StatusLine` and the `<Static>` child renderer separately.
 *
 * `componentDidCatch` reports `{ pane, error, componentStack }` through `onFail`; the App (O9) logs the redacted
 * stack to `jevcode.log`, dispatches the renderer-local `[ui]` item, declines a review held by a failed `Overlay`,
 * renders `statusLineText()` for a failed `StatusLine` and swaps in the plain-input `fallback` for a failed
 * `Composer`. `JEVCODE_FAULT=render:<pane>` (passed as `fault`) throws once inside the boundary for the pty and
 * unit tests: "once" is once per fault string per `faults` store — the module singleton by default, i.e. once per
 * process (§13.4 "throws once"); the App or a test may scope it with its own `Set`.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Text } from 'ink';
// TUI-DESIGN-4 §7.11: ONE grammar. `faults.ts` is zero-import by construction (it is on the first-frame path),
// so the boundary reads the typed union instead of comparing strings — `renderFaultMode` is the matcher §7.11
// requires of "every consumer", and it is what tells `render:<pane>` from `render:<pane>:lines[:sticky]`.
import { parseFault, renderFaultMode, renderFaultString, type Fault } from './faults.js';

export interface PaneFailure {
  pane: string;
  error: Error;
  /** React's component stack (a non-empty string under React 19); null only when React gave none */
  componentStack: string | null;
}

export interface PaneBoundaryProps {
  /** `live` | `pane` | `overlay` | `composer` | `status` | `static` */
  pane: string;
  /** shown in the notice; default `jevcode.log`. `null` = no log is open (TUI-DESIGN-4 §7.12: the headline drops the `see …` clause) */
  log?: string | null;
  /** TUI-DESIGN-4 §7.12: the frame's width, so the notice can drop its tail below `PANE_NOTICE_WIDE_MIN`; omitted = wide */
  columns?: number;
  onFail?: (failure: PaneFailure) => void;
  /** replaces the one-row notice (a failed Composer falls back to a single-row plain input, a failed StatusLine to `statusLineText()`) */
  fallback?: (failure: PaneFailure) => ReactNode;
  /** `process.env.JEVCODE_FAULT`; `render:<pane>` throws once, `render:<pane>:sticky` on every render (TUI-DESIGN-4 §7.11 scenario 1) */
  fault?: string | undefined;
  /** the store of fault strings already fired; default: the module singleton (once per process) */
  faults?: Set<string>;
  /** when it changes, a failed boundary tries its children again (the next run remounts the pane) */
  resetKey?: string | number;
  children?: ReactNode;
}

interface PaneBoundaryState {
  failed: Error | null;
}

export const DEFAULT_LOG_NAME = 'jevcode.log';

/**
 * TUI-DESIGN-4 §7.12 (P-D11): below this many columns the notice drops its `— run continues; see <log>` clause and
 * the log is named in the item's `detail` instead. The old 76-character line wrapped to 2–3 rows below 64 columns —
 * the very frame where rows are scarcest.
 */
export const PANE_NOTICE_WIDE_MIN = 64;

/**
 * TUI-DESIGN-4 §7.12 edge 1: `Error.name` can be attacker-influenced (a thrown object whose `name` is 10 000
 * characters). `toError` normalises the value; the name is additionally made terminal-safe and clipped here.
 */
export const PANE_ERROR_NAME_MAX = 32;

/**
 * TUI-DESIGN §14.1 on one row, restated locally: `PaneBoundary` is mounted in frame 1 and stays import-free, so it
 * does not pull in `blocking/lines.ts` (`plain.ts` + `composer/width.ts`) for four lines of sanitising.
 */
function safeName(s: string): string {
  const flat = s
    .replace(/\r\n|\r|\n|\u2028|\u2029|\t/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .trim();
  const cps = [...flat];
  const clipped = cps.length <= PANE_ERROR_NAME_MAX ? flat : `${cps.slice(0, PANE_ERROR_NAME_MAX - 1).join('')}\u2026`;
  return clipped.length > 0 ? clipped : 'Error';
}

/**
 * TUI-DESIGN-4 §7.12: the degradation notice, width-aware and naming a log that exists.
 *
 * | room | text |
 * | --- | --- |
 * | `columns >= 64` | `ui: <pane> failed (<Error.name>) — run continues; see <log>` |
 * | `columns < 64` | `ui: <pane> failed (<Error.name>)` (the log moves to `detail`) |
 * | no log open | the headline drops the `see …` clause at every width |
 *
 * **Identity: text.** This one formatter feeds the Ink fallback, the `[ui]` item that reaches `transcript.log`
 * and `--plain`, and the screen-reader twin — one change, one place (§7.12).
 */
export function paneFailedLine(pane: string, errorName: string, log: string | null = DEFAULT_LOG_NAME, columns?: number): string {
  const head = `ui: ${pane} failed (${safeName(errorName)})`;
  const wide = columns === undefined || !Number.isFinite(columns) || columns >= PANE_NOTICE_WIDE_MIN;
  if (!wide || log === null || log.length === 0) return head;
  return `${head} — run continues; see ${log}`;
}

/**
 * TUI-DESIGN-4 §7.12: the item's `detail` — the log the headline could not name. With no log open it says how to
 * open one; `transcript.log` therefore always carries the full information even when the row was cut (edge 2).
 */
export function paneFailedDetail(log: string | null = DEFAULT_LOG_NAME): string {
  return log === null || log.length === 0 ? 'the run log (start with --log <file>)' : log;
}

/** TUI-DESIGN-4 §7.1: the `[ui]` item appended at `info` when a latched pane is unlatched and renders again. */
export function paneRecoveredLine(pane: string): string {
  return `ui: ${pane} pane recovered`;
}

/** The `JEVCODE_FAULT` value that makes `pane` throw once (TUI-DESIGN §13.4, §19.6; the grammar is `faults.ts`). */
export function renderFaultFor(pane: string): string {
  return renderFaultString(pane);
}

/** TUI-DESIGN-4 §7.11 scenario 1: `render:<pane>:sticky` throws on **every** render, not once. */
export function stickyRenderFaultFor(pane: string): string {
  return renderFaultString(pane, { sticky: true });
}

/**
 * TUI-DESIGN-4 §7.11 / §7.1: the value whose **line builder** throws — `render:<pane>:lines[:sticky]`. The
 * boundary never catches this one (the builder runs inside `guard()`, above the boundary); it is here so the
 * App-level latch and the boundary agree on one spelling.
 */
export function linesFaultFor(pane: string, opts: { sticky?: boolean } = {}): string {
  return renderFaultString(pane, { lines: true, ...(opts.sticky === true ? { sticky: true } : {}) });
}

function toError(e: unknown): Error {
  if (e instanceof Error) return e;
  const err = new Error(typeof e === 'string' ? e : String(e));
  err.name = 'NonError';
  return err;
}

/** TUI-DESIGN §13.4 / §19.6: the process-wide store of injected faults already thrown (keyed by the full `render:<pane>` string). */
export const RENDER_FAULTS_FIRED: Set<string> = new Set<string>();

/** TUI-DESIGN §19.6 test hook: forget which injected faults already fired (the module singleton, or the given store). */
export function resetRenderFaults(store: Set<string> = RENDER_FAULTS_FIRED): void {
  store.clear();
}

/**
 * Throws every time it renders; the boundary records the fault as fired in componentDidCatch. React replays a
 * render whose error a boundary caught once before committing the error state, so marking "fired" here would
 * make the replay succeed and the fault vanish.
 */
function FaultThrower({ fault }: { fault: string }): ReactNode {
  const err = new Error(`injected render fault (${fault})`);
  err.name = 'InjectedRenderFault';
  throw err;
}

/** TUI-DESIGN §13.4: per-pane error boundary; a failure degrades this pane only and the run continues. */
export class PaneBoundary extends Component<PaneBoundaryProps, PaneBoundaryState> {
  override state: PaneBoundaryState = { failed: null };

  static getDerivedStateFromError(error: unknown): PaneBoundaryState {
    return { failed: toError(error) };
  }

  /**
   * TUI-DESIGN-4 §7.11: how `fault` applies to THIS boundary, through the typed parser — `null` when the value
   * names another pane, the `:lines` variant (which belongs to the App's `guard()`, not to the boundary) or is
   * not a fault at all. String comparison could not tell `render:transcript:lines:sticky` from anything.
   */
  private ownFault(): 'once' | 'sticky' | null {
    const fault = this.props.fault;
    if (fault === undefined) return null;
    const parsed: Fault | null = parseFault(fault);
    return renderFaultMode(parsed, this.props.pane);
  }

  /**
   * The injected fault string for this pane, when `fault` names it and it has not fired in the store yet. A
   * `:sticky` fault (TUI-DESIGN-4 §7.11 scenario 1) is never recorded as fired, so every remount and every
   * `resetKey` change throws again — which is what §7.1's latch must survive.
   */
  private pendingFault(): string | null {
    const mode = this.ownFault();
    if (mode === null) return null;
    const fault = this.props.fault as string;
    if (mode === 'sticky') return fault;
    return (this.props.faults ?? RENDER_FAULTS_FIRED).has(fault) ? null : fault;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const fault = this.props.fault;
    if (fault !== undefined && this.ownFault() === 'once') (this.props.faults ?? RENDER_FAULTS_FIRED).add(fault);
    const stack = typeof info.componentStack === 'string' && info.componentStack.length > 0 ? info.componentStack : null;
    this.props.onFail?.({ pane: this.props.pane, error: toError(error), componentStack: stack });
  }

  override componentDidUpdate(prev: PaneBoundaryProps): void {
    if (this.state.failed !== null && prev.resetKey !== this.props.resetKey) this.setState({ failed: null });
  }

  override render(): ReactNode {
    const { failed } = this.state;
    if (failed !== null) {
      const failure: PaneFailure = { pane: this.props.pane, error: failed, componentStack: null };
      if (this.props.fallback) return this.props.fallback(failure);
      return (
        <Text color="red" wrap="truncate">
          {paneFailedLine(this.props.pane, failed.name, this.props.log, this.props.columns)}
        </Text>
      );
    }
    const fault = this.pendingFault();
    if (fault !== null) return <FaultThrower fault={fault} />;
    return this.props.children ?? null;
  }
}
