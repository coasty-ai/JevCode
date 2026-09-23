/** The agent loop detector and the progress schedule (docs/AGENT-LOOP-DESIGN.md §3.6). */
import { describe, expect, it } from 'vitest';
import type { AgentToolName, JsonObject } from '../../../src/core/types.js';
import { callSignature, feedLoop, progressCheckDue, resultHash, type LoopTripWithTest } from '../../../src/agent/loop.js';

function feed(window: string[], name: AgentToolName, args: JsonObject, result: string, testCommand: string | null = null): LoopTripWithTest | null {
  return feedLoop(window, { name, signature: callSignature(name, args, resultHash({ kind: 'text', text: result })), testCommand });
}

describe('the loop detector', () => {
  it('10 distinct greps do not trip', () => {
    const w: string[] = [];
    for (let i = 0; i < 10; i += 1) expect(feed(w, 'grep', { pattern: `p${i}` }, `${i} matches`)).toBeNull();
  });

  it('three read_file pages of one file do not trip (each page is new information)', () => {
    const w: string[] = [];
    for (const offset of [1, 2001, 4001]) expect(feed(w, 'read_file', { path: 'big.ts', offset }, `page at ${offset}`)).toBeNull();
  });

  it('a re-read after an edit does not trip', () => {
    const w: string[] = [];
    expect(feed(w, 'read_file', { path: 'a.ts' }, 'v1')).toBeNull();
    expect(feed(w, 'read_file', { path: 'a.ts' }, 'v1')).toBeNull();
    expect(feed(w, 'read_file', { path: 'a.ts' }, 'v2 after the edit')).toBeNull();
  });

  it('todo_write turns are never signed', () => {
    const w: string[] = [];
    for (let i = 0; i < 3; i += 1) expect(feed(w, 'todo_write', { todos: [] }, 'OK')).toBeNull();
    expect(w).toEqual([]);
  });

  it('three identical failing test runs trip on the failing set, and 6/10 → 8/10 is progress', () => {
    const fail = (stdout: string): string => resultHash({ kind: 'test', command: 'pytest -q', exec: { stdout, stderr: '' }, runner: 'pytest', fallback: stdout });
    const same = 'FAILED tests/test_a.py::test_x - assert\n1 failed, 3 passed in 0.10s\n';
    const sameLater = 'FAILED tests/test_a.py::test_x - assert\n1 failed, 3 passed in 0.31s\n';
    expect(fail(same)).toBe(fail(sameLater));
    const w: string[] = [];
    const run = (stdout: string): LoopTripWithTest | null => feedLoop(w, { name: 'bash', signature: callSignature('bash', { command: 'pytest  -q' }, fail(stdout)), testCommand: 'pytest -q' });
    expect(run(same)).toBeNull();
    expect(run(sameLater)).toBeNull();
    expect(run(same)).toMatchObject({ rule: 'repeat', count: 3, tool: 'bash', testCommand: 'pytest -q' });
    const w2: string[] = [];
    const run2 = (stdout: string): LoopTripWithTest | null => feedLoop(w2, { name: 'bash', signature: callSignature('bash', { command: 'pytest -q' }, fail(stdout)), testCommand: 'pytest -q' });
    expect(run2('FAILED tests/t.py::a\nFAILED tests/t.py::b\n2 failed')).toBeNull();
    expect(run2('FAILED tests/t.py::a\n1 failed')).toBeNull();
    expect(run2('FAILED tests/t.py::a\nFAILED tests/t.py::b\n2 failed')).toBeNull();
  });

  it('`cat x` three times with identical output trips (whitespace in the command does not matter)', () => {
    const w: string[] = [];
    expect(feed(w, 'bash', { command: 'cat x' }, '0\nhello')).toBeNull();
    expect(feed(w, 'bash', { command: 'cat  x' }, '0\nhello')).toBeNull();
    expect(feed(w, 'bash', { command: 'cat x ' }, '0\nhello')).toMatchObject({ rule: 'repeat', count: 3 });
    // the window was cleared after the trip
    expect(w).toEqual([]);
  });

  it('a workdir makes a different call', () => {
    const w: string[] = [];
    expect(feed(w, 'bash', { command: 'ls', workdir: 'a' }, 'x')).toBeNull();
    expect(feed(w, 'bash', { command: 'ls', workdir: 'b' }, 'x')).toBeNull();
    expect(feed(w, 'bash', { command: 'ls' }, 'x')).toBeNull();
  });

  it('A-B-A-B-A-B-A-B-A-B-A-B trips on the window rule', () => {
    const w: string[] = [];
    const trips: (LoopTripWithTest | null)[] = [];
    for (let i = 0; i < 12; i += 1) trips.push(i % 2 === 0 ? feed(w, 'grep', { pattern: 'a' }, 'A') : feed(w, 'glob', { pattern: 'b' }, 'B'));
    const first = trips.findIndex((t) => t !== null);
    expect(first).toBe(10);
    expect(trips[first]).toMatchObject({ rule: 'window', count: 6, tool: 'grep' });
  });

  it('refused calls sign as refused, so the same refused call three times trips', () => {
    const w: string[] = [];
    const refused = (): LoopTripWithTest | null => feedLoop(w, { name: 'bash', signature: callSignature('bash', { command: 'rm -rf /' }, resultHash({ kind: 'refused' })), testCommand: null });
    expect(refused()).toBeNull();
    expect(refused()).toBeNull();
    expect(refused()).toMatchObject({ rule: 'repeat' });
  });
});

describe('the progress-check schedule', () => {
  it('first at 30 turns, then every 10', () => {
    expect(progressCheckDue(29, null)).toBe(false);
    expect(progressCheckDue(30, null)).toBe(true);
    expect(progressCheckDue(35, 30)).toBe(false);
    expect(progressCheckDue(40, 30)).toBe(true);
  });
});
