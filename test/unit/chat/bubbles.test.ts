/**
 * TUI-DESIGN-2 §3.10 (S3, §8.1 row `bubbles.test.ts`): bubbles are redacted at emission and split per line (never
 * `oneLine`-flattened); the identity rule — every sink prints `[you] <text>` / `[jevcode] <text>` for one line — through
 * `localItem` + `formatTranscriptItem` (the plain renderer and the TUI's `<Static>` rows) and a live `notice` (annotate).
 */
import { describe, expect, it } from 'vitest';
import { BUBBLE_BLANK_RUN_MAX, CHAT_LABELS, bubbleLines, bubbleText, clipMarkerText, expandTabs, isChatLabel } from '../../../src/chat/bubbles.js';
import { TRANSCRIPT_TEXT_MAX, formatTranscriptItem, itemsFromEvent, localItem } from '../../../src/tui/plain.js';

const SECRET = 'sk-ant-api03-SECRETSECRETSECRETSECRETSECRET1234';
const redact = (s: string): string => s.replaceAll(SECRET, '[REDACTED:composer#1]');

describe('§3.10 bubbles', () => {
  it('bubbleLines redacts at emission, splits per line, KEEPS interior blank lines, expands tabs to the 4-stop and clips each line (TUI-DESIGN-4 §5.2 P-C4)', () => {
    expect(bubbleLines(`fix it with ${SECRET}\n\n  second\tline  \r\nthird`, redact)).toEqual(['fix it with [REDACTED:composer#1]', '', '  second    line', 'third']);
    // §5.2's two pinned cases
    expect(bubbleLines('a\n\n\tb\n', redact)).toEqual(['a', '', '    b']);
    expect(bubbleLines('a\n\n\n\n\nb', redact)).toEqual(['a', '', '', 'b']);
    expect(bubbleLines('   \n\n', redact)).toEqual([]);
    expect(bubbleLines('hi', redact)).toEqual(['hi']);
    // edges (b)/(c): leading and trailing blank lines of a paste are dropped, so a turn never opens or closes with a gap
    expect(bubbleLines('\n\nhi\n\n', redact)).toEqual(['hi']);
    expect(BUBBLE_BLANK_RUN_MAX).toBe(2);
    // the tab stop is counted from the start of the line, not per character
    expect(expandTabs('ab\tc')).toBe('ab  c');
    expect(expandTabs('abcd\te')).toBe('abcd    e');
  });

  it('§5.2 P-C5: a clipped turn says how much is missing, once, after the last line — and the count is post-redaction', () => {
    const long = bubbleLines('x'.repeat(2000), redact);
    expect(long).toHaveLength(2);
    expect(long[0]).toHaveLength(TRANSCRIPT_TEXT_MAX);
    expect(long[1]).toBe('…(+1,401 characters not shown — /copy last copies the whole message)');
    // edge (h): exactly 600 chars → no marker
    expect(bubbleLines('y'.repeat(TRANSCRIPT_TEXT_MAX), redact)).toHaveLength(1);
    // edge (i): several clipped lines in one turn → ONE marker carrying the summed count, after the last line
    const two = bubbleLines(`${'x'.repeat(1000)}\n${'y'.repeat(1000)}`, redact);
    expect(two).toHaveLength(3);
    expect(two[2]).toBe(clipMarkerText(2 * (1000 - 599)));
    expect(clipMarkerText(1401)).toContain('+1,401');
    expect(clipMarkerText(12)).toContain('+12');
  });

  it('§5.2 P-C4: an empty item\'s stored row is `[you]` with no trailing space, in every sink', () => {
    const items = bubbleLines('a\n\nb', redact).map((l, i) => localItem(l, i, { label: CHAT_LABELS.you }));
    expect(items.map(formatTranscriptItem)).toEqual(['[you] a', '[you]', '[you] b']);
    expect(bubbleText('you', '')).toBe('[you]');
  });

  it('a multi-line draft yields one item per line — never oneLine()\'s ` ⏎ ` flattening — and every item prints `[you] <line>`', () => {
    const items = bubbleLines('first\nsecond', redact).map((l, i) => localItem(l, i, { label: CHAT_LABELS.you }));
    expect(items.map(formatTranscriptItem)).toEqual(['[you] first', '[you] second']);
    for (const i of items) expect(i).toMatchObject({ kind: 'chat', local: true, label: '[you]' });
    expect(items.some((i) => i.text.includes('⏎'))).toBe(false);
  });

  it('the identity rule: idle (localItem) and live (a labelled notice from annotate) produce the same row text for one line', () => {
    const line = "Hi. I'm ready when you are — describe a change you want in proj, or ask what I can do.";
    const idle = localItem(line, 3, { label: '[jevcode]' });
    const live = itemsFromEvent({ type: 'notice', step: null, kind: 'ui', level: 'info', text: line, label: '[jevcode]' }, 3)[0];
    expect(live).toBeDefined();
    expect(formatTranscriptItem(idle)).toBe(`[jevcode] ${line}`);
    expect(formatTranscriptItem(live!)).toBe(formatTranscriptItem(idle));
    expect(live?.kind).toBe('chat');
    expect(idle.kind).toBe('chat');
    expect(bubbleText('jevcode', line)).toBe(formatTranscriptItem(idle));
    expect(bubbleText('you', 'hi')).toBe('[you] hi');
  });

  it('isChatLabel recognises exactly the two bubble labels', () => {
    expect(isChatLabel('[you]')).toBe(true);
    expect(isChatLabel('[jevcode]')).toBe(true);
    expect(isChatLabel('[ui]')).toBe(false);
    expect(isChatLabel(undefined)).toBe(false);
  });
});
