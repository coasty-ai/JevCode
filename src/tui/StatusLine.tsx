/**
 * Status line, one row, rendered only from the `status` event payload (plus run:ready before
 * the first status arrives). The `step <n>/<max|–>` prefix is the first-frame sentinel that
 * perf/first-frame.ts waits for (§12), so it is present from the very first render.
 */
import { Box, Text } from 'ink';
import type { EngineStatus, RunResult } from '../core/types.js';
import { formatDuration } from '../core/time.js';
import { kTokens, usd } from './plain.js';

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
export const SPINNER_INTERVAL_MS = 125;

export interface StatusLineProps {
  status: EngineStatus | null;
  ready: { step: number; maxSteps: number } | null;
  done: RunResult | null;
  spinnerFrame: number;
}

export function statusSentinel(step: number, maxSteps: number | null): string {
  return `step ${step}/${maxSteps === null ? '–' : maxSteps}`;
}

export function formatStatusLine({ status, ready, done, spinnerFrame }: StatusLineProps): string {
  const spinner = done ? '' : `${SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!} `;
  if (status === null) {
    return `${statusSentinel(ready?.step ?? 0, ready?.maxSteps ?? null)}  ${spinner}${done ? `done ${done.stopReason}` : 'starting'}`;
  }
  const s = status.spend;
  const stage = done ? `done ${done.stopReason}` : status.stopReason ? `stopping ${status.stopReason}` : status.stage;
  return [
    statusSentinel(status.step, status.maxSteps),
    `${spinner}${stage}`,
    `wall ${formatDuration(status.wallMs)}/${formatDuration(status.maxWallMs)}`,
    `tokens gen ${kTokens(s.generator.inputTokens + s.generator.outputTokens)} jev ${kTokens(s.jev.inputTokens + s.jev.outputTokens)}`,
    `cost gen ${usd(s.generator.costUsd)} jev ${usd(s.jev.costUsd)} / cap ${usd(s.capUsd)}${s.exceeded ? ' EXCEEDED' : ''}`,
  ].join('  ');
}

export function StatusLine(props: StatusLineProps): React.JSX.Element {
  return (
    <Box height={1} overflow="hidden">
      <Text wrap="truncate" bold={props.done !== null} {...(props.done ? { color: props.done.stopReason === 'complete' ? 'green' : 'yellow' } : {})}>
        {formatStatusLine(props)}
      </Text>
    </Box>
  );
}
