/**
 * TUI-DESIGN-2 §3.10 (S3, §8.1 row `bubbles.test.ts`): bubbles are redacted at emission and split per line (never
 * `oneLine`-flattened); the identity rule — every sink prints `[you] <text>` / `[jevcode] <text>` for one line — through
 * `localItem` + `formatTranscriptItem` (the plain renderer and the TUI's `<Static>` rows) and a live `notice` (annotate).
 */
import { describe, expect, it } from 'vitest';
import { CHAT_LABELS, bubbleLines, bubbleText, isChatLabel } from '../../../src/chat/bubbles.js';
import { TRANSCRIPT_TEXT_MAX, formatTranscriptItem, itemsFromEvent, localItem } from '../../../src/tui/plain.js';

const SECRET = 'sk-ant-api03-SECRETSECRETSECRETSECRETSECRET1234';
const redact = (s: string): string => s.replaceAll(SECRET, '[REDACTED:composer#1]');

describe('§3.10 bubbles', () => {
  it('bubbleLines redacts at emission, splits per line, drops blank lines, folds tabs and clips each line to TRANSCRIPT_TEXT_MAX', () => {
    expect(bubbleLines(`fix it with ${SECRET}\n\n  second\tline  \r\nthird`, redact)).toEqual(['fix it with [REDACTED:composer#1]', '  second line', 'third']);
    expect(bubbleLines('   \n\n', redact)).toEqual([]);
    const long = bubbleLines('x'.repeat(2000), redact);
    expect(long).toHaveLength(1);
    expect(long[0]).toHaveLength(TRANSCRIPT_TEXT_MAX);
    expect(bubbleLines('hi', redact)).toEqual(['hi']);
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
