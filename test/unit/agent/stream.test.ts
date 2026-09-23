/** The prose stream shaper (docs/AGENT-LOOP-DESIGN.md §9.3). */
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../../../src/core/types.js';
import { createProseShaper } from '../../../src/agent/stream.js';

function shaper(): { events: EngineEvent[]; s: ReturnType<typeof createProseShaper> } {
  const events: EngineEvent[] = [];
  return { events, s: createProseShaper({ step: 3, turn: 2, emit: (e) => events.push(e), redact: (t) => t.replace(/sk-secret/g, '[REDACTED]') }) };
}

const texts = (events: EngineEvent[]): [string, boolean][] => events.flatMap((e) => (e.type === 'assistant:text' ? [[e.text, e.final] as [string, boolean]] : []));

describe('the prose shaper', () => {
  it('commits whole lines as soon as they are complete, and the remainder at the end', () => {
    const { events, s } = shaper();
    s.push('First li');
    expect(events).toEqual([]);
    s.push('ne.\nSecond line.\nThird');
    s.push(' part');
    s.finish();
    expect(texts(events)).toEqual([
      ['First line.\nSecond line.', false],
      ['Third part', true],
    ]);
    expect(events[0]).toMatchObject({ type: 'assistant:text', step: 3, turn: 2, attempt: 1 });
  });

  it('an empty remainder commits nothing; blank lines survive', () => {
    const { events, s } = shaper();
    s.push('a\n\nb\n');
    s.finish();
    expect(texts(events)).toEqual([['a\n\nb', false]]);
  });

  it('holds an open code fence until it closes, so a code block lands in one piece', () => {
    const { events, s } = shaper();
    s.push('Here:\n```ts\nconst a = 1;\n');
    expect(texts(events)).toEqual([['Here:', false]]);
    s.push('const b = 2;\n```\nAfter.\n');
    expect(texts(events)).toEqual([
      ['Here:', false],
      ['```ts\nconst a = 1;\nconst b = 2;\n```\nAfter.', false],
    ]);
  });

  it('commits inside a fence once the pending text passes 2,000 chars', () => {
    const { events, s } = shaper();
    s.push('```\n');
    for (let i = 0; i < 30; i += 1) s.push(`${'x'.repeat(99)}\n`);
    const committed = texts(events);
    expect(committed.length).toBeGreaterThan(0);
    expect(committed[0]![0].startsWith('```\nxxx')).toBe(true);
    // still inside the fence: the closing line then commits the rest without re-sending anything
    s.push('```\ndone\n');
    s.finish();
    const all = texts(events).map(([t]) => t).join('\n');
    expect(all).toBe(`\`\`\`\n${Array.from({ length: 30 }, () => 'x'.repeat(99)).join('\n')}\n\`\`\`\ndone`);
  });

  it('a reset drops the pending text, emits assistant:reset and numbers the next commits with the new attempt', () => {
    const { events, s } = shaper();
    s.push('Line one.\nhalf a li');
    s.reset(2);
    s.push('Line one.\nLine two.\n');
    s.finish();
    expect(events.map((e) => e.type)).toEqual(['assistant:text', 'assistant:reset', 'assistant:text']);
    expect(events[1]).toEqual({ type: 'assistant:reset', step: 3, turn: 2, attempt: 2 });
    expect(events[2]).toMatchObject({ attempt: 2, text: 'Line one.\nLine two.' });
    // within one attempt no line is committed twice
    const firstAttempt = events.filter((e) => e.type === 'assistant:text' && e.attempt === 1).map((e) => (e.type === 'assistant:text' ? e.text : ''));
    expect(firstAttempt).toEqual(['Line one.']);
  });

  it('redacts what it commits', () => {
    const { events, s } = shaper();
    s.push('key sk-secret here\n');
    expect(texts(events)).toEqual([['key [REDACTED] here', false]]);
  });
});
