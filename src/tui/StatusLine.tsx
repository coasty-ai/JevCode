/**
 * Status line, one row (TUI-DESIGN §7.4, §24 "Status", F16; TUI-DESIGN-3 §5.2 P6): `statusLineText(state, columns)` from
 * `src/tui/status/lines.ts` is the one shared `lines()` function (the `--plain` / `--screen-reader` / `--ascii`
 * twins read it too). The `step N/M` sentinel is the first-frame marker `perf/first-frame.ts` waits for and is
 * present from the very first render (`step 0/–`); the jev-only `propose [synth]` marker is kept
 * (`SYNTH_MARKER`). The component maps `UiState` 1.1 to `StatusLineState` (`statusView`) — the reducer state
 * is a structural superset, the optional inputs (title, sandbox, disk count, Jev latencies, picker, the
 * extrapolated wall clock, the run:end exit code) are filled from the additive fields. Colour (D-P): the row is
 * rendered from `statusSpans` — the spinner glyph, the done word, the meter words, `⚠ secret?` and a toast carry a
 * role; the rest of the row is the terminal's default foreground, never a whole-row colour or bold.
 */
import { Box, Text } from 'ink';
import { SYNTH_MARKER, statusSpans, stepText, type StatusLineOptions, type StatusLineState, type StatusSpan } from './status/lines.js';
import type { UiState } from './useEngine.js';
import { textProps, themeFor, type ColorOn, type Theme } from './theme.js';

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
    // TUI-DESIGN-2 §1.5 / §4.8
    modeBadge: s.modeBadge,
    thinking: s.thinking,
  };
}

export interface StatusLineProps {
  state: StatusLineState;
  columns: number;
  options?: StatusLineOptions;
  theme?: Theme;
  color?: ColorOn;
}

/**
 * TUI-DESIGN-3 §5.2 P6: the `<Text>` pieces of a row from its text and spans — plain runs between the spans, each span in
 * its role (bold where the span says so). Shared by the flat status row and the console's status compartment. Pure.
 */
export function spanPieces(text: string, spans: readonly StatusSpan[], theme: Theme, color: ColorOn, keyPrefix = 's'): React.JSX.Element[] {
  const out: React.JSX.Element[] = [];
  let at = 0;
  spans.forEach((sp, i) => {
    if (sp.from > at) out.push(<Text key={`${keyPrefix}p${i}`}>{text.slice(at, sp.from)}</Text>);
    if (sp.to > sp.from) {
      const props = textProps(theme, sp.role, color);
      out.push(
        <Text key={`${keyPrefix}${i}`} {...props} {...(sp.bold === true && Object.keys(props).length > 0 ? { bold: true } : {})}>
          {text.slice(sp.from, sp.to)}
        </Text>,
      );
    }
    at = Math.max(at, sp.to);
  });
  if (at < text.length) out.push(<Text key={`${keyPrefix}tail`}>{text.slice(at)}</Text>);
  return out;
}

export function StatusLine({ state, columns, options = {}, theme = themeFor('dark'), color = true }: StatusLineProps): React.JSX.Element {
  const { text, spans } = statusSpans(state, columns, options);
  return (
    <Box height={1} overflow="hidden">
      <Text wrap="truncate">{spanPieces(text, spans, theme, color)}</Text>
    </Box>
  );
}
