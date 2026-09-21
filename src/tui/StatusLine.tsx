/**
 * Status line, one row (TUI-DESIGN §7.4, §24 "Status", F16): `statusLineText(state, columns)` from
 * `src/tui/status/lines.ts` is the one shared `lines()` function (the `--plain` / `--screen-reader` / `--ascii`
 * twins read it too). The `step N/M` sentinel is the first-frame marker `perf/first-frame.ts` waits for and is
 * present from the very first render (`step 0/–`); the jev-only `propose [synth]` marker is kept
 * (`SYNTH_MARKER`). The component maps `UiState` 1.1 to `StatusLineState` (`statusView`) — the reducer state
 * is a structural superset, the optional inputs (title, sandbox, disk count, Jev latencies, picker, the
 * extrapolated wall clock, the run:end exit code) are filled from the additive fields.
 */
import { Box, Text } from 'ink';
import { SYNTH_MARKER, statusLineText, stepText, type StatusLineOptions, type StatusLineState } from './status/lines.js';
import type { UiState } from './useEngine.js';
import { textProps, themeFor, type Theme } from './theme.js';

export { SYNTH_MARKER };

/** The `step N/M` sentinel (`–` when the maximum is unknown); `perf/first-frame.ts` searches the bytes for `step 0/`. */
export function statusSentinel(step: number, maxSteps: number | null): string {
  return stepText(step, maxSteps);
}

/** TUI-DESIGN §7.4: `UiState` 1.1 → the view `statusLineText` reads (the optional inputs come from the additive fields). */
export function statusView(s: UiState, o: { picker?: boolean } = {}): StatusLineState {
  const wall = s.status !== null && s.statusAt !== null && s.run !== 'none' && Number.isFinite(s.nowMs) ? s.status.wallMs + Math.max(0, s.nowMs - s.statusAt) : s.status?.wallMs ?? null;
  return {
    run: s.run,
    mode: s.mode,
    status: s.status,
    ready: s.ready,
    done: s.done,
    runId: s.runId,
    overlay: s.overlay,
    pendingReview: s.pendingReview,
    retrying: s.retrying,
    blocking: s.blocking,
    errors: s.errors,
    stageStartedAt: s.stageStartedAt,
    toasts: s.toasts,
    git: s.git,
    spend: s.spend,
    draft: { secretHits: s.draft.secretHits },
    nowMs: s.nowMs,
    title: s.title,
    sandbox: s.sandbox,
    noNetwork: s.noNetwork,
    diskErrors: s.diskErrors,
    jevLatencies: s.jevLatencies,
    picker: o.picker ?? s.picker,
    wallMs: wall,
    doneExitCode: s.doneExitCode,
  };
}

export interface StatusLineProps {
  state: StatusLineState;
  columns: number;
  options?: StatusLineOptions;
  theme?: Theme;
  color?: boolean;
}

export function StatusLine({ state, columns, options = {}, theme = themeFor('dark'), color = true }: StatusLineProps): React.JSX.Element {
  const text = statusLineText(state, columns, options);
  const done = state.done !== null && state.run === 'none';
  const role = done ? (state.done?.stopReason === 'complete' ? 'ok' : 'warn') : state.draft.secretHits > 0 ? 'secret' : null;
  return (
    <Box height={1} overflow="hidden">
      <Text wrap="truncate" bold={done} {...(role ? textProps(theme, role, color) : {})}>
        {text}
      </Text>
    </Box>
  );
}
