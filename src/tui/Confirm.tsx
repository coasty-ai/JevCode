/**
 * Inline confirmation box, rendered only while a confirm:request is pending. The header is
 * exactly CONFIRM_HEADER_ROWS rows and the preview is clipped to whatever the §10 budget
 * leaves, so the box can never push the dynamic region past rows − 2.
 */
import { Box, Text } from 'ink';
import type { ConfirmRequest } from '../core/types.js';
import { CONFIRM_HEADER_ROWS, confirmHeaderLines, confirmPreviewLines } from './plain.js';

export interface ConfirmProps {
  request: ConfirmRequest;
  /** rows granted to the header (≤ CONFIRM_HEADER_ROWS on tiny terminals) */
  headerRows: number;
  previewRows: number;
}

export function Confirm({ request, headerRows, previewRows }: ConfirmProps): React.JSX.Element | null {
  const total = headerRows + previewRows;
  if (total <= 0) return null;
  const header = confirmHeaderLines(request).slice(0, headerRows);
  const preview = previewRows > 0 ? confirmPreviewLines(request) : [];
  const shown = preview.slice(0, previewRows);
  if (shown.length > 0 && preview.length > shown.length) shown[shown.length - 1] = `…[${preview.length - shown.length + 1} more preview lines]`;
  const verdictColor = request.risk.verdict === 'block' ? 'red' : 'yellow';
  return (
    <Box flexDirection="column" height={total} overflow="hidden">
      {header.map((line, i) => (
        <Text key={`h${i}`} wrap="truncate" {...(i === 0 || i === CONFIRM_HEADER_ROWS - 1 ? { color: verdictColor } : {})} bold={i === CONFIRM_HEADER_ROWS - 1}>
          {line}
        </Text>
      ))}
      {shown.map((line, i) => (
        <Text key={`p${i}`} wrap="truncate" dimColor>
          {`  ${line}`}
        </Text>
      ))}
    </Box>
  );
}
