/**
 * TUI-DESIGN-2 §3.9 "Ledger" (S3, §8.1 row `ledger.test.ts`): ≤ 200 turns, the last 6 for Jev, `stats()` (messages, cost,
 * p50 latency, last kind + probability) feeding `/jev` line 3 and `/cost`'s chat line.
 */
import { describe, expect, it } from 'vitest';
import { LEDGER_MAX_TURNS, LEDGER_RECENT, createChatLedger, type ChatTurn } from '../../../src/chat/ledger.js';

const you = (text: string, o: Partial<ChatTurn> = {}): ChatTurn => ({ role: 'you', text, at: 't', kind: 'greeting_or_smalltalk', probability: 0.9, latencyMs: 100, costUsd: 0.0001, provider: 'typesafe', ...o });
const bot = (text: string, costUsd = 0): ChatTurn => ({ role: 'jevcode', text, at: 't', costUsd });

describe('§3.9 the chat ledger', () => {
  it('keeps at most 200 turns and hands the newest 6 to Jev, oldest first', () => {
    const l = createChatLedger();
    for (let i = 0; i < 250; i++) l.push(i % 2 === 0 ? you(`m${i}`) : bot(`r${i}`));
    expect(l.turns).toHaveLength(LEDGER_MAX_TURNS);
    expect(l.turns[0]?.text).toBe('m50');
    expect(l.recent()).toHaveLength(LEDGER_RECENT);
    expect(l.recent().map((t) => t.text)).toEqual(['m244', 'r245', 'm246', 'r247', 'm248', 'r249']);
    expect(l.recent(2).map((t) => t.text)).toEqual(['m248', 'r249']);
    expect(l.recent(0)).toEqual([]);
    expect(l.messages).toBe(100);
  });

  it('stats: messages = you turns, cost = Σ over every turn, p50 of the intake latencies, last = the newest reading', () => {
    const l = createChatLedger();
    expect(l.stats()).toEqual({ messages: 0, costUsd: 0, p50Ms: null, last: null });
    l.push(you('hi', { latencyMs: 118, costUsd: 0.00007 }));
    l.push(bot('Hi.'));
    l.push(you('what can you do?', { kind: 'question_about_this_tool', probability: 0.82, latencyMs: 130, costUsd: 0.00007 }));
    l.push(bot('JevCode is …'));
    l.push(you('where is the parsing?', { kind: 'question_about_the_code', probability: 0.71, latencyMs: 125, costUsd: 0.00007 }));
    l.push(bot('utils/dates.py', 0.00005));
    const s = l.stats();
    expect(s.messages).toBe(3);
    expect(s.costUsd).toBeCloseTo(0.00026, 9);
    expect(s.p50Ms).toBe(125);
    expect(s.last).toEqual({ kind: 'question_about_the_code', probability: 0.71 });
    l.push(you('again', { latencyMs: Number.NaN, costUsd: Number.NaN }));
    expect(l.stats().p50Ms).toBe(125);
    expect(l.stats().costUsd).toBeCloseTo(0.00026, 9);
  });
});
