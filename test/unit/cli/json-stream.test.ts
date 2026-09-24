/**
 * TUI-DESIGN §8.9 / §19.0: the `--json` stream — the `stream:start` envelope, every redacted `EngineEvent` with
 * `v`/`t`/`runId`/`sessionId`, the controller lines `session:start/end/budget/refused` and `ui`, `status` only with
 * `--json=verbose`, every line parses, a non-serialisable value becomes a `stream:error` line consumers ignore, and
 * the `--json` renderer (envelope at firstFrame, events forwarded, silent decliner, `ui` lines for idle items).
 */
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../../../src/core/types.js';
import { JSON_STREAM_SCHEMA, JSON_STREAM_VERSION, IDENTITY_JSON, createJsonRenderer, createSilentDecliner, serializeLine, writeJsonStream, type JsonStreamLine, VERBOSE_ONLY_TYPES } from '../../../src/cli/json-stream.js';
import { fakeEngine, loadRunEvents, mkConfirmRequest } from '../../fixtures/tui/fixtures.js';

class Sink {
  chunks: string[] = [];
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
  get lines(): Record<string, unknown>[] {
    return this.chunks
      .join('')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}

const T = '2026-09-20T14:02:11.123Z';
const ctx = { runId: '20260920-140211-abcdefgh', sessionId: '20260920-140000-aaaaaaaa' };

/** TUI-DESIGN §8.9: `redact` is required by the type — the tests pass an explicit redactor (identity unless the case redacts) */
function stream(sink: Sink, o: { verbose?: boolean; redact?: (s: string) => string } = {}) {
  return writeJsonStream({ out: sink, version: '0.1.0', now: () => T, redact: o.redact ?? ((x) => x), ...(o.verbose !== undefined ? { verbose: o.verbose } : {}) });
}

describe('writeJsonStream (§8.9)', () => {
  it('writes the versioned envelope first, once', () => {
    const sink = new Sink();
    const s = stream(sink);
    expect(s.started).toBe(false);
    s.start();
    s.start();
    expect(sink.lines).toEqual([{ v: 1, type: 'stream:start', schema: 'jevcode.events/1', jevcode: '0.1.0', t: T }]);
    expect(s.lines).toBe(1);
    expect(s.started).toBe(true);
    expect(JSON_STREAM_VERSION).toBe(1);
    expect(JSON_STREAM_SCHEMA).toBe('jevcode.events/1');
    // every chunk is exactly one line
    for (const c of sink.chunks) expect(c.endsWith('\n') && c.slice(0, -1).includes('\n')).toBe(false);
  });

  it('every engine event becomes `{ v, t, runId, sessionId, ...event }`; each line parses back to the event', () => {
    const sink = new Sink();
    const s = stream(sink);
    const events = loadRunEvents();
    let written = 0;
    for (const e of events) if (s.event(e, ctx)) written += 1;
    const lines = sink.lines;
    expect(lines).toHaveLength(written);
    const nonStatus = events.filter((e) => e.type !== 'status');
    expect(lines).toHaveLength(nonStatus.length);
    for (const [i, e] of nonStatus.entries()) {
      const l = lines[i]!;
      // run:start / run:ready carry their own runId (and run:ready its sessionId): those win over the context
      const runId = 'runId' in e ? e.runId : ctx.runId;
      const sessionId = 'sessionId' in e && typeof e.sessionId === 'string' ? e.sessionId : ctx.sessionId;
      expect(l).toMatchObject({ v: 1, t: T, runId, sessionId, type: e.type });
      const { v, t, ...rest } = l;
      void v;
      void t;
      expect(rest).toEqual(JSON.parse(JSON.stringify({ runId, sessionId, ...e })));
    }
    // the envelope fields lead every line (readability of the raw stream)
    expect(Object.keys(lines[0]!).slice(0, 4)).toEqual(['v', 't', 'runId', 'sessionId']);
  });

  it('the verbose-only set is exactly status + decompose:skipped (ORCHESTRATION-DESIGN §4.1)', () => {
    expect([...VERBOSE_ONLY_TYPES].sort()).toEqual(['decompose:skipped', 'status']);
  });

  it('status events ride the stream only with --json=verbose; the event\'s own runId/sessionId win over the context', () => {
    const status: EngineEvent = loadRunEvents().find((e) => e.type === 'status')!;
    const quiet = new Sink();
    expect(stream(quiet).event(status, ctx)).toBe(false);
    expect(quiet.lines).toEqual([]);
    const verbose = new Sink();
    expect(stream(verbose, { verbose: true }).event(status, ctx)).toBe(true);
    expect(verbose.lines[0]).toMatchObject({ type: 'status', v: 1 });
    const sink = new Sink();
    const s = stream(sink);
    s.event({ type: 'run:start', runId: 'r-own', task: 't', mode: 'jev-on', resumedFromStep: null }, { runId: null, sessionId: null });
    s.event({ type: 'run:ready', runId: 'r-own', step: 0, maxSteps: 40, task: 't', resumed: false, sessionId: 's-own', parentRunId: null }, { runId: 'r-ctx', sessionId: 's-ctx' });
    s.event({ type: 'step:start', step: 1, startedAt: T }, { runId: 'r-ctx', sessionId: null });
    expect(sink.lines.map((l) => [l['runId'], l['sessionId']])).toEqual([['r-own', null], ['r-own', 's-own'], ['r-ctx', null]]);
  });

  it('controller lines: session:start / session:end / session:budget / session:refused / ui, strings through redact', () => {
    const sink = new Sink();
    const s = stream(sink, { redact: (x) => x.replace('sk-ant-SECRETSECRETSECRETSECRETSECRET', '[REDACTED:pattern]') });
    s.sessionStart({ sessionId: 'S', runId: null, parentRunId: null, workspace: '/Users/me/proj' });
    s.sessionBudget({ setting: 'session.spendCapUsd', from: '10', to: '15', appliesTo: 'now' }, { runId: null, sessionId: 'S' });
    s.sessionRefused({ reason: 'session-cap', spentUsd: 10.31, capUsd: 10, exitCode: 4 }, { runId: null, sessionId: 'S' });
    s.sessionRefused({ reason: 'secret', exitCode: 2 }, { runId: null, sessionId: 'S' });
    s.ui('recent: "tz fixes" · 2h ago  (Enter continues, /resume browses)', {}, { runId: null, sessionId: 'S' });
    s.ui('seatbelt — writes confined … key sk-ant-SECRETSECRETSECRETSECRETSECRET', { label: '[sandbox]', level: 'warn' }, { runId: null, sessionId: 'S' });
    s.sessionEnd({ reason: 'exit', runs: 3, exitCode: 0 }, { runId: 'R3', sessionId: 'S' });
    expect(sink.lines).toEqual([
      { v: 1, t: T, runId: null, sessionId: 'S', type: 'session:start', workspace: '/Users/me/proj', parentRunId: null },
      { v: 1, t: T, runId: null, sessionId: 'S', type: 'session:budget', setting: 'session.spendCapUsd', from: '10', to: '15', appliesTo: 'now' },
      { v: 1, t: T, runId: null, sessionId: 'S', type: 'session:refused', reason: 'session-cap', spentUsd: 10.31, capUsd: 10, exitCode: 4 },
      { v: 1, t: T, runId: null, sessionId: 'S', type: 'session:refused', reason: 'secret', exitCode: 2 },
      { v: 1, t: T, runId: null, sessionId: 'S', type: 'ui', text: 'recent: "tz fixes" · 2h ago  (Enter continues, /resume browses)', label: '[ui]', level: 'info' },
      { v: 1, t: T, runId: null, sessionId: 'S', type: 'ui', text: 'seatbelt — writes confined … key [REDACTED:pattern]', label: '[sandbox]', level: 'warn' },
      { v: 1, t: T, runId: 'R3', sessionId: 'S', type: 'session:end', reason: 'exit', runs: 3, exitCode: 0 },
    ]);
    // the refusal never carries `spentUsd: undefined` (exactOptionalPropertyTypes, and a clean wire shape)
    expect(sink.chunks[3]).not.toContain('spentUsd');
    expect(s.lines).toBe(7);
  });

  it('TUI-DESIGN-2 §6 item 17: `chat` lines carry the intake reading, probability, route, provider, cost, latency and the redacted request hash — never the message', () => {
    const sink = new Sink();
    const s = stream(sink, { redact: (x) => x.replace('SECRET', '[REDACTED:pattern]') });
    s.chat({ intake: 'greeting_or_smalltalk', probability: 0.94, route: 'reply', provider: 'typesafe', costUsd: 0.00018, latencyMs: 118, requestHash: 'a1b2SECRET' }, { runId: null, sessionId: null });
    s.chat({ intake: 'question_about_the_code', probability: 0.7, route: 'llm', provider: 'generator', costUsd: 0.0031, latencyMs: 900, requestHash: '' }, { runId: null, sessionId: 'S' });
    expect(sink.lines).toEqual([
      { v: 1, t: T, runId: null, sessionId: null, type: 'chat', intake: 'greeting_or_smalltalk', probability: 0.94, route: 'reply', provider: 'typesafe', costUsd: 0.00018, latencyMs: 118, requestHash: 'a1b2[REDACTED:pattern]' },
      { v: 1, t: T, runId: null, sessionId: 'S', type: 'chat', intake: 'question_about_the_code', probability: 0.7, route: 'llm', provider: 'generator', costUsd: 0.0031, latencyMs: 900, requestHash: '' },
    ]);
    expect(sink.chunks.join('')).not.toContain('message');
    expect(s.lines).toBe(2);
  });

  it('run:end carries exitCode, resumable and paths unchanged; session:refused takes reason unpriced; a live `notice ui` and an idle `ui` line carry the same text', () => {
    const sink = new Sink();
    const s = stream(sink);
    const end = loadRunEvents().at(-1)!;
    if (end.type !== 'run:end') throw new Error('fixture');
    const withExit: EngineEvent = { ...end, exitCode: 4, resumable: true, paths: { runDir: '/r/x', transcript: '/r/x/transcript.log', log: '/r/x/jevcode.log' } };
    expect(s.event(withExit, ctx)).toBe(true);
    expect(sink.lines[0]).toMatchObject({ type: 'run:end', exitCode: 4, resumable: true, paths: { runDir: '/r/x', transcript: '/r/x/transcript.log', log: '/r/x/jevcode.log' } });
    s.sessionRefused({ reason: 'unpriced', exitCode: 2 }, ctx);
    expect(sink.lines[1]).toEqual({ v: 1, t: T, runId: ctx.runId, sessionId: ctx.sessionId, type: 'session:refused', reason: 'unpriced', exitCode: 2 });
    // TUI-DESIGN §15.1: the same renderer-originated line is a `notice { kind: 'ui', label }` event while live and a `ui` line while idle
    const text = 'error: unknown command /foo; type / to list commands';
    s.event({ type: 'notice', step: 2, kind: 'ui', level: 'error', text, label: '[ui]' }, ctx);
    s.ui(text, { label: '[ui]', level: 'error' }, { runId: null, sessionId: ctx.sessionId });
    const live = sink.lines[2]!;
    const idle = sink.lines[3]!;
    expect(live).toMatchObject({ type: 'notice', kind: 'ui', label: '[ui]', level: 'error', text, runId: ctx.runId });
    expect(idle).toMatchObject({ type: 'ui', label: '[ui]', level: 'error', text, runId: null });
    expect(live['text']).toBe(idle['text']);
    // a stream without a redactor does not typecheck (§8.9: the guarantee is enforced by the type)
    // @ts-expect-error redact is required
    const untyped: Parameters<typeof writeJsonStream>[0] = { out: sink, version: '0.1.0' };
    void untyped;
  });

  it('serializeLine never throws: a value JSON cannot encode becomes a stream:error line (a type consumers ignore)', () => {
    const bad = { v: 1, t: T, runId: 'R', sessionId: null, type: 'transcript', step: 1, level: 'info', text: 'x', big: BigInt(1) } as unknown as JsonStreamLine;
    const line = JSON.parse(serializeLine(bad)) as Record<string, unknown>;
    expect(line).toMatchObject({ v: 1, t: T, runId: 'R', sessionId: null, type: 'stream:error', eventType: 'transcript' });
    expect(typeof line['message']).toBe('string');
    // NaN / Infinity are nulls by JSON.stringify, not errors
    const nan = JSON.parse(serializeLine({ v: 1, t: T, runId: null, sessionId: null, type: 'session:refused', reason: 'session-cap', spentUsd: Number.NaN, exitCode: 4 })) as Record<string, unknown>;
    expect(nan['spentUsd']).toBeNull();
  });
});

describe('createJsonRenderer (§1 `--json` row, §8.9)', () => {
  it('firstFrame writes the envelope; attach forwards events with the engine\'s runId; run:ready refreshes the sessionId; unmount detaches', async () => {
    const sink = new Sink();
    const s = stream(sink);
    const r = createJsonRenderer({ task: 't', resumeId: null, onAbort: () => undefined, stream: s, sessionId: 'S0' });
    await r.firstFrame();
    expect(sink.lines).toEqual([{ v: 1, type: 'stream:start', schema: 'jevcode.events/1', jevcode: '0.1.0', t: T }]);
    const fe = fakeEngine();
    r.attach(fe.engine);
    expect(r.context).toEqual({ runId: 'r1', sessionId: 'S0' });
    fe.emit({ type: 'run:start', runId: 'r1', task: 't', mode: 'jev-on', resumedFromStep: null });
    fe.emit({ type: 'run:ready', runId: 'r1', step: 0, maxSteps: 40, task: 't', resumed: false, sessionId: 'S1', parentRunId: null });
    fe.emit({ type: 'status', status: fe.engine.status() });
    fe.emit({ type: 'transcript', step: 1, level: 'info', text: 'hello' });
    expect(r.context).toEqual({ runId: 'r1', sessionId: 'S1' });
    const lines = sink.lines.slice(1);
    expect(lines.map((l) => l['type'])).toEqual(['run:start', 'run:ready', 'transcript']);
    expect(lines[2]).toMatchObject({ runId: 'r1', sessionId: 'S1', text: 'hello' });
    await r.unmount();
    fe.emit({ type: 'transcript', step: 1, level: 'info', text: 'after unmount' });
    expect(sink.lines).toHaveLength(4);
  });

  it('notify writes an idle-time `ui` line with its label; the confirmer declines silently and writes nothing', async () => {
    const sink = new Sink();
    const r = createJsonRenderer({ task: 't', resumeId: null, onAbort: () => undefined, stream: stream(sink) });
    await r.firstFrame();
    r.notify('recent: "x" · 1m ago  (Enter continues, /resume browses)');
    r.notify('seatbelt — writes confined', { label: '[sandbox]', level: 'warn' });
    expect(sink.lines.slice(1)).toEqual([
      { v: 1, t: T, runId: null, sessionId: null, type: 'ui', text: 'recent: "x" · 1m ago  (Enter continues, /resume browses)', label: '[ui]', level: 'info' },
      { v: 1, t: T, runId: null, sessionId: null, type: 'ui', text: 'seatbelt — writes confined', label: '[sandbox]', level: 'warn' },
    ]);
    const before = sink.chunks.length;
    expect(r.confirmer.identity).toBe(IDENTITY_JSON);
    await expect(r.confirmer.confirm(mkConfirmRequest(), { signal: new AbortController().signal })).resolves.toBe(false);
    await expect(r.confirmer.confirmDetailed!(mkConfirmRequest(), { signal: new AbortController().signal })).resolves.toEqual({ approved: false });
    expect(sink.chunks).toHaveLength(before);
    expect(createSilentDecliner('x').identity).toBe('x');
  });
});
