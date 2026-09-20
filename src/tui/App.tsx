/**
 * The one Ink render of JevCode (DESIGN.md §10, §12): first frame from argv only, panes under
 * a rows − 2 height budget of fixed-height overflow-hidden boxes, one always-active useInput
 * gated by Boolean(isRawModeSupported), Ctrl-C → onAbort('human_abort').
 */
import { useEffect, useMemo, useState } from 'react';
import { Box, Text, render, useInput, useStdin, useStdout } from 'ink';
import type { Engine, Renderer, RendererOptions } from '../core/types.js';
import { Transcript } from './Transcript.js';
import { Decisions } from './Decisions.js';
import { SPINNER_INTERVAL_MS, StatusLine } from './StatusLine.js';
import { Confirm } from './Confirm.js';
import { CONFIRM_HEADER_ROWS, IDENTITY_NO_TTY, confirmPreviewLines, headerItem } from './plain.js';
import { DECISIONS_KEPT, createEventBus, createTuiConfirmer, useEngine, type EventSource, type TuiConfirmer } from './useEngine.js';

export const DEFAULT_ROWS = 24;
export const DEFAULT_COLUMNS = 80;
export const LIVE_ROWS = 2;
export const STATUS_ROWS = 1;
/** The rule separating scrollback (<Static>) from the live panes; also how tests find the dynamic region. */
export const RULE_ROWS = 1;
export const RULE_CHAR = '─';
/** Preview never takes the whole budget on a tall terminal; the decisions pane keeps some rows. */
export const MAX_PREVIEW_ROWS = 8;
export const UNMOUNT_TIMEOUT_MS = 2000;

export interface Layout {
  budget: number;
  rule: number;
  live: number;
  status: number;
  confirmHeader: number;
  preview: number;
  decisions: number;
  total: number;
}

/**
 * Height budget (§10): dynamic rows never exceed rows − 2. Allocation order: status, rule,
 * live, confirmation header, preview, decisions (the decisions pane shrinks first).
 */
export function computeLayout(rows: number, pendingConfirm: boolean, previewLines: number): Layout {
  const budget = Math.max(0, Math.floor(rows) - 2);
  let rem = budget;
  const take = (want: number): number => {
    const got = Math.max(0, Math.min(want, rem));
    rem -= got;
    return got;
  };
  const status = take(STATUS_ROWS);
  const rule = take(RULE_ROWS);
  const live = take(LIVE_ROWS);
  const confirmHeader = pendingConfirm ? take(CONFIRM_HEADER_ROWS) : 0;
  const preview = pendingConfirm ? take(Math.min(previewLines, MAX_PREVIEW_ROWS)) : 0;
  const decisions = take(DECISIONS_KEPT);
  return { budget, rule, live, status, confirmHeader, preview, decisions, total: budget - rem };
}

/**
 * Last `rows` lines of the stream, or the char count while no line break has arrived yet. A lone
 * `\r` counts as a line break so a progress bar shows its latest state. Lines are cut to
 * `columns + 1` characters before Ink measures them (the +1 keeps Ink's truncation ellipsis), so a
 * 64 KB unbroken tail never costs a 64 KB width measurement per frame. With an empty text buffer
 * and tool-argument chars streaming, the region reads `streaming action… N chars` (§7, §10).
 */
export function liveLines(live: string, rows: number, columns: number = DEFAULT_COLUMNS, toolChars = 0): string[] {
  if (rows <= 0) return [];
  if (live === '') return toolChars > 0 ? [`streaming action… ${toolChars} chars`] : [];
  if (!/[\r\n]/.test(live)) return [`streaming… ${live.length} chars`];
  const parts = live.split(/\r\n|\r|\n/);
  if (parts[parts.length - 1] === '') parts.pop();
  const max = Math.max(1, Math.floor(columns)) + 1;
  return parts.slice(-rows).map((l) => (l.length > max ? l.slice(0, max) : l));
}

export interface AppProps {
  task: string;
  resumeId: string | null;
  source: EventSource;
  confirmer: TuiConfirmer;
  onAbort: (reason: 'human_abort') => void;
}

function useTerminalSize(): { rows: number; columns: number } {
  const { stdout } = useStdout();
  const [, bump] = useState(0);
  useEffect(() => {
    const onResize = (): void => bump((n) => n + 1);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  const rows = typeof stdout.rows === 'number' && stdout.rows > 0 ? stdout.rows : DEFAULT_ROWS;
  const columns = typeof stdout.columns === 'number' && stdout.columns > 0 ? stdout.columns : DEFAULT_COLUMNS;
  return { rows, columns };
}

function useSpinner(active: boolean): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % 1000), SPINNER_INTERVAL_MS);
    t.unref();
    return () => clearInterval(t);
  }, [active]);
  return frame;
}

export function App({ task, resumeId, source, confirmer, onAbort }: AppProps): React.JSX.Element {
  const { rows, columns } = useTerminalSize();
  const { isRawModeSupported } = useStdin();
  const { state, dispatch } = useEngine(source, confirmer, task, resumeId);
  const spinner = useSpinner(state.done === null);
  const pending = state.pendingConfirm;

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        onAbort('human_abort');
        return;
      }
      if (!pending) return;
      const c = input.toLowerCase();
      if (c === 'y' || c === 'n') {
        if (confirmer.resolve(pending.id, c === 'y')) dispatch({ type: 'confirm:settled', id: pending.id });
      }
    },
    // `stdin.isTTY` is undefined (not false) on a pipe; Ink only skips raw mode for `=== false`.
    { isActive: Boolean(isRawModeSupported) },
  );

  const layout = computeLayout(rows, pending !== null, pending ? confirmPreviewLines(pending).length : 0);
  const live = liveLines(state.live, layout.live, columns, state.toolChars);
  const header = useMemo(() => headerItem(task, resumeId), [task, resumeId]);

  return (
    <Box flexDirection="column">
      <Transcript items={state.items} header={header} />
      {layout.rule > 0 ? (
        <Box height={layout.rule} overflow="hidden">
          <Text dimColor wrap="truncate">
            {RULE_CHAR.repeat(columns)}
          </Text>
        </Box>
      ) : null}
      {layout.live > 0 ? (
        <Box flexDirection="column" height={layout.live} overflow="hidden">
          {live.map((line, i) => (
            <Text key={`l${i}`} wrap="truncate">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
      <Decisions decisions={state.decisions} rows={layout.decisions} />
      {pending ? <Confirm request={pending} headerRows={layout.confirmHeader} previewRows={layout.preview} /> : null}
      {layout.status > 0 ? <StatusLine status={state.status} ready={state.ready} done={state.done} spinnerFrame={spinner} /> : null}
    </Box>
  );
}

/** Ink renderer: renders the first frame synchronously from argv-only props; attach(engine) later. */
export function createTuiRenderer(opts: RendererOptions): Renderer {
  const stdout = opts.stdout ?? process.stdout;
  const stdin = opts.stdin ?? process.stdin;
  const bus = createEventBus();
  // With a piped stdin nobody can press y/n, so the box renders and then declines (§10).
  const confirmer = stdin.isTTY ? createTuiConfirmer() : createTuiConfirmer({ autoDeclineMs: opts.confirmTimeoutMs ?? 0, identity: IDENTITY_NO_TTY });
  let detach: (() => void) | null = null;

  const instance = render(<App task={opts.task} resumeId={opts.resumeId} source={bus} confirmer={confirmer} onAbort={opts.onAbort} />, {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  return {
    confirmer,
    attach(engine: Engine) {
      detach?.();
      detach = engine.events.onAny((e) => bus.emit(e));
    },
    firstFrame: () => instance.waitUntilRenderFlush(),
    async unmount() {
      detach?.();
      detach = null;
      instance.unmount();
      let timer: NodeJS.Timeout | null = null;
      const bounded = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, UNMOUNT_TIMEOUT_MS);
        timer.unref();
      });
      await Promise.race([instance.waitUntilExit().catch(() => undefined), bounded]);
      if (timer) clearTimeout(timer);
    },
  };
}
