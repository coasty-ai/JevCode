/**
 * TUI-DESIGN-2 §3.4 (S3, §8.1 row `replies.test.ts`): 14 rows, unique keys, templates ≤ 160, no emoji, `fillReply`
 * incl. `<runsDir>` from the input (`~`-abbreviated, never hardcoded), the group-B Choice shape, `pickReply` argmax / fallback.
 */
import { describe, expect, it } from 'vitest';
import type { Answer } from '../../../src/core/types.js';
import { REPLIES, REPLY_FALLBACK_KEY, REPLY_TEXT_MAX, buildReplyQuestion, fillReply, modeWord, pickReply, replyByKey, replyCriteria, tildify } from '../../../src/chat/replies.js';
import { ESCAPE_KEY } from '../../../src/jev/questions.js';
import { MODE_BADGE_WORD, MODE_SETTING_VALUES } from '../../../src/config/defaults.js';

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u;

describe('§3.4 the reply catalogue', () => {
  it('has the 14 rows of the table in order, unique snake_case keys, `when` + ≥ 2 examples each, templates ≤ 160 chars without emoji', () => {
    expect(REPLIES.map((r) => r.key)).toEqual(['hello_first', 'hello_again', 'how_are_you', 'good_morning', 'good_evening', 'thanks', 'bye', 'praise', 'apology', 'checking_alive', 'ok_ack', 'whats_up', 'laughing', REPLY_FALLBACK_KEY]);
    expect(new Set(REPLIES.map((r) => r.key)).size).toBe(14);
    for (const r of REPLIES) {
      expect(r.key).toMatch(/^[a-z][a-z0-9_]{1,63}$/);
      expect(r.when.length).toBeGreaterThan(5);
      expect(r.examples.length).toBeGreaterThanOrEqual(2);
      expect(r.text.length, r.key).toBeLessThanOrEqual(REPLY_TEXT_MAX);
      expect(EMOJI_RE.test(r.text), r.key).toBe(false);
      expect(replyCriteria(r)).toEqual({ definition: r.when, examples: r.examples });
    }
  });

  it('the texts are the table\'s, verbatim', () => {
    expect(replyByKey('hello_first').text).toBe("Hi. I'm ready when you are — describe a change you want in <dir>, or ask what I can do.");
    expect(replyByKey('bye').text).toBe('Bye for now. /exit closes the session; runs are saved under <runsDir>.');
    expect(replyByKey('whats_up').text).toBe("Not much: the composer's open, the workspace is <dir>, <last>.");
    expect(replyByKey(REPLY_FALLBACK_KEY).text).toBe("Happy to chat, though I'm best at code. Ask me anything about <dir>, or hand me a task.");
    expect(replyByKey('does_not_exist').key).toBe(REPLY_FALLBACK_KEY);
  });

  it('buildReplyQuestion: one option per row with { definition: when, examples } criteria plus the escape option', () => {
    const q = buildReplyQuestion();
    expect(q.type).toBe('choice');
    if (q.type !== 'choice') return;
    expect(Object.keys(q.criteria)).toEqual([...REPLIES.map((r) => r.key), ESCAPE_KEY]);
    expect(q.criteria['thanks']).toEqual({ definition: 'thanks or appreciation for something done', examples: ['thanks', 'thank you, that worked'] });
    expect(String(q.instructions)).toBe('Which reply in the catalogue answers `message` best, read with `conversation` and `session`?');
  });

  it('pickReply is the argmax over catalogue keys; the escape option, a missing answer or an all-zero mass fall back to smalltalk_other at p 0', () => {
    const a: Answer = { type: 'choice', choice: 'thanks', probabilities: { thanks: 0.6, hello_first: 0.3, [ESCAPE_KEY]: 0.1 }, confidence: 0.7 };
    expect(pickReply({ reply: a })).toEqual({ key: 'thanks', probability: 0.6 });
    expect(pickReply({ reply: { type: 'choice', choice: ESCAPE_KEY, probabilities: { [ESCAPE_KEY]: 1 }, confidence: 1 } })).toEqual({ key: REPLY_FALLBACK_KEY, probability: 0 });
    expect(pickReply({})).toEqual({ key: REPLY_FALLBACK_KEY, probability: 0 });
    expect(pickReply({ reply: { type: 'noul', noul: 0.9 } })).toEqual({ key: REPLY_FALLBACK_KEY, probability: 0 });
  });

  it('fillReply fills <dir>, <last>, <mode> and <runsDir> from the input; the runs dir is `~`-abbreviated and never hardcoded', () => {
    const facts = { dir: 'proj', lastRun: null, mode: 'jev-only' as const, runsDir: '/Users/me/custom/runs', home: '/Users/me' };
    expect(fillReply(replyByKey('hello_first'), facts)).toBe("Hi. I'm ready when you are — describe a change you want in proj, or ask what I can do.");
    expect(fillReply(replyByKey('bye'), facts)).toBe('Bye for now. /exit closes the session; runs are saved under ~/custom/runs.');
    expect(fillReply(replyByKey('bye'), { ...facts, runsDir: '/srv/jevcode/runs' })).toBe('Bye for now. /exit closes the session; runs are saved under /srv/jevcode/runs.');
    expect(fillReply(replyByKey('whats_up'), facts)).toBe("Not much: the composer's open, the workspace is proj, nothing has run yet.");
    expect(fillReply(replyByKey('whats_up'), { ...facts, lastRun: 'the last run ended max_steps after 7 steps' })).toBe("Not much: the composer's open, the workspace is proj, the last run ended max_steps after 7 steps.");
    // every template with a placeholder fills it from the input
    for (const r of REPLIES) {
      const filled = fillReply(r, facts);
      expect(filled, r.key).not.toMatch(/<(dir|last|mode|runsDir)>/);
      if (r.text.includes('<dir>')) expect(filled).toContain('proj');
      if (r.text.includes('<runsDir>')) expect(filled).toContain('~/custom/runs');
    }
  });

  it('tildify and modeWord', () => {
    expect(tildify('/Users/me/.jevcode/runs', '/Users/me')).toBe('~/.jevcode/runs');
    expect(tildify('/Users/me', '/Users/me')).toBe('~');
    expect(tildify('/Users/meow/x', '/Users/me')).toBe('/Users/meow/x');
    expect(tildify('/tmp/x', '/')).toBe('/tmp/x');
    // TUI-DESIGN-3 §1.1 (D-N): the ONE badge table — llm-jev reads `llm+jev · verified`
    expect([modeWord('jev-only'), modeWord('jev-on'), modeWord('jev-off'), modeWord('llm-jev')]).toEqual(['jev-only', 'jev+llm', 'llm-only', 'llm+jev · verified']);
    for (const m of MODE_SETTING_VALUES) expect(modeWord(m)).toBe(MODE_BADGE_WORD[m]);
  });
});
