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

export interface PaneFailure {
  pane: string;
  error: Error;
  /** React's component stack (a non-empty string under React 19); null only when React gave none */
  componentStack: string | null;
}

export interface PaneBoundaryProps {
  /** `live` | `pane` | `overlay` | `composer` | `status` | `static` */
  pane: string;
  /** shown in the notice; default `jevcode.log` */
  log?: string;
  onFail?: (failure: PaneFailure) => void;
  /** replaces the one-row notice (a failed Composer falls back to a single-row plain input, a failed StatusLine to `statusLineText()`) */
  fallback?: (failure: PaneFailure) => ReactNode;
  /** `process.env.JEVCODE_FAULT`; `render:<pane>` throws once */
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

/** `ui: <pane> pane failed to render (<Error.name>) — run continues; details in <log>` (TUI-DESIGN §13.4, §24). */
export function paneFailedLine(pane: string, errorName: string, log: string = DEFAULT_LOG_NAME): string {
  return `ui: ${pane} pane failed to render (${errorName}) — run continues; details in ${log}`;
}

/** The `JEVCODE_FAULT` value that makes `pane` throw once (TUI-DESIGN §13.4, §19.6). */
export function renderFaultFor(pane: string): string {
  return `render:${pane}`;
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

  /** The injected fault string for this pane, when `fault` names it and it has not fired in the store yet. */
  private pendingFault(): string | null {
    const fault = this.props.fault;
    if (fault === undefined || fault !== renderFaultFor(this.props.pane)) return null;
    return (this.props.faults ?? RENDER_FAULTS_FIRED).has(fault) ? null : fault;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const fault = this.props.fault;
    if (fault !== undefined && fault === renderFaultFor(this.props.pane)) (this.props.faults ?? RENDER_FAULTS_FIRED).add(fault);
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
          {paneFailedLine(this.props.pane, failed.name, this.props.log)}
        </Text>
      );
    }
    const fault = this.pendingFault();
    if (fault !== null) return <FaultThrower fault={fault} />;
    return this.props.children ?? null;
  }
}
