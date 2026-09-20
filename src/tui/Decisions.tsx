/**
 * Decisions pane: the last N Decision rows (stage, id, answer, probability, confidence,
 * verdict). Fixed height with overflow hidden so the §10 budget holds under wrapping.
 */
import { Box, Text } from 'ink';
import type { Decision, DecisionVerdict } from '../core/types.js';
import { p2 } from './plain.js';

export const DERIVED_LABEL = 'derived';

export function verdictMarker(v: DecisionVerdict | undefined): string {
  return v ? `[${v}]` : '';
}

export function verdictColor(v: DecisionVerdict | undefined): { color?: string; dimColor?: boolean } {
  switch (v) {
    case 'block':
      return { color: 'red' };
    case 'review':
    case 'overridden':
    case 'fallback':
      return { color: 'yellow' };
    case 'ok':
    case 'chosen':
    default:
      return { dimColor: true };
  }
}

function answerText(d: Decision): string {
  switch (d.answer.type) {
    case 'noul':
      return `noul=${p2(d.answer.noul)}`;
    case 'choice':
      return `choice=${d.answer.choice}`;
    case 'score':
      return `score=${d.answer.score}`;
  }
}

/** One pane row; Noul confidence is harness-derived (|2p − 1|) and labelled as such (§16). */
export function formatDecisionRow(d: Decision): string {
  const derived = d.answer.type === 'noul' ? ` ${DERIVED_LABEL}` : '';
  const served = d.servedModel ? ` served=${d.servedModel}` : '';
  const marker = verdictMarker(d.verdict);
  return `s${d.step} ${d.stage} ${d.id} ${answerText(d)} p=${p2(d.probability)} c=${p2(d.confidence)}${derived}${marker ? ` ${marker}` : ''}${served}`;
}

export function Decisions({ decisions, rows }: { decisions: readonly Decision[]; rows: number }): React.JSX.Element | null {
  if (rows <= 0) return null;
  const shown = decisions.slice(-rows);
  return (
    <Box flexDirection="column" height={rows} overflow="hidden">
      {shown.map((d, i) => (
        <Text key={`${d.step}:${d.stage}:${d.id}:${d.requestHash}:${i}`} wrap="truncate" {...verdictColor(d.verdict)}>
          {formatDecisionRow(d)}
        </Text>
      ))}
    </Box>
  );
}
