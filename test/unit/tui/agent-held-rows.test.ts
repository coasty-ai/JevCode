/** isHoldableAgentRow: which rows a run still in its reply phase holds back (AGENT-LOOP-DESIGN §A1/§A5). */
import { describe, expect, it } from 'vitest';
import { isHoldableAgentRow } from '../../../src/tui/plain.js';

const notice = (label: string | undefined, level: 'info' | 'warn' = 'info') => ({ kind: 'notice' as const, level, text: 'x', ...(label !== undefined ? { label: label as never } : {}) });

describe('isHoldableAgentRow', () => {
  it('holds the run chrome of a reply: its steps and info notices', () => {
    expect(isHoldableAgentRow({ kind: 'step', level: 'info', text: 'x' })).toBe(true);
    expect(isHoldableAgentRow(notice('[session]'))).toBe(true);
    expect(isHoldableAgentRow(notice(undefined))).toBe(true);
  });

  it('never holds the human\'s own [ui] answers, warnings, or chat bubbles — a message typed while the reply streamed is the conversation', () => {
    expect(isHoldableAgentRow(notice('[ui]'))).toBe(false);
    expect(isHoldableAgentRow(notice('[session]', 'warn'))).toBe(false);
    expect(isHoldableAgentRow(notice('[you]'))).toBe(false);
    expect(isHoldableAgentRow(notice('[jevcode]'))).toBe(false);
  });
});
