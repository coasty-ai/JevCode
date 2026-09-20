/**
 * Committed transcript rows in <Static>: Ink writes each item once and never re-lays it out,
 * so the array is append-only and every row is keyed by the item's immutable key (§10).
 */
import { useMemo } from 'react';
import { Box, Static, Text } from 'ink';
import { formatTranscriptItem, type TranscriptItem } from './plain.js';

export function itemColor(item: TranscriptItem): { color?: string; dimColor?: boolean } {
  if (item.level === 'error' || item.verdict === 'block') return { color: 'red' };
  if (item.level === 'warn' || item.verdict === 'review') return { color: 'yellow' };
  if (item.kind === 'proposal' || item.kind === 'run:start' || item.kind === 'run:end') return {};
  return { dimColor: true };
}

export interface TranscriptProps {
  items: readonly TranscriptItem[];
  /** rendered once at the top of the scrollback (the task header, present from the first frame) */
  header?: TranscriptItem;
}

export function Transcript({ items, header }: TranscriptProps): React.JSX.Element {
  // Prepending keeps the array append-only from <Static>'s point of view: index 0 never changes.
  const all = useMemo(() => (header ? [header, ...items] : [...items]), [header, items]);
  return (
    <Static items={all}>
      {(item) => (
        <Box key={item.key} flexDirection="column">
          <Text {...itemColor(item)}>{formatTranscriptItem(item)}</Text>
          {item.detail !== undefined ? <Text dimColor>{item.detail}</Text> : null}
        </Box>
      )}
    </Static>
  );
}
