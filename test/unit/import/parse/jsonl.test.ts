/** import/parse/jsonl.ts (IMPORT-DESIGN §4.3, §4.2.6): byte-capped JSONL and the transcript metadata pass. */
import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS } from '../../../../src/core/limits.js';
import { parseJsonl, transcriptMeta } from '../../../../src/import/parse/jsonl.js';

describe('parseJsonl', () => {
  it('parses one record per line and skips blank lines', () => {
    const r = parseJsonl('{"a":1}\n\n{"b":2}\n');
    expect(r).toEqual({ ok: true, value: [{ a: 1 }, { b: 2 }], warnings: [] });
  });

  it('§4.3: a truncated last line is dropped, not fatal', () => {
    const text = '{"a":1}\n{"b":2}\n{"c":3';
    const r = parseJsonl(text, { maxBytes: text.length - 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual([{ a: 1 }, { b: 2 }]);
    expect(r.warnings[0]).toContain('last partial line dropped');
  });

  it('a complete final line without a trailing newline is kept', () => {
    const r = parseJsonl('{"a":1}\n{"b":2}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toHaveLength(2);
  });

  it('one bad line among good ones is a warning; an all-bad document is {ok:false}', () => {
    const r = parseJsonl('{"a":1}\nnot json\n{"b":2}\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual([{ a: 1 }, { b: 2 }]);
    expect(r.warnings).toContain('1 malformed line dropped');
    expect(parseJsonl('nope\nalso nope\n').ok).toBe(false);
  });

  it('maxRecords stops the read with a warning', () => {
    const r = parseJsonl('{"a":1}\n{"a":2}\n{"a":3}\n', { maxRecords: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(2);
    expect(r.warnings).toContain('stopped at 2 records');
  });

  it('accepts a Buffer and never throws', () => {
    expect(parseJsonl(Buffer.from('{"a":1}\n')).ok).toBe(true);
    expect(() => parseJsonl(Buffer.alloc(0))).not.toThrow();
  });
});

describe('transcriptMeta — §4.2.6, metadata only', () => {
  const claude = [
    JSON.stringify({ type: 'summary', sessionId: 'sess-1', cwd: '/Users/x/repo', gitBranch: 'main', timestamp: '2026-09-20T10:00:00.000Z' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'fix   the failing test please' }, timestamp: '2026-09-20T10:00:01.000Z' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, timestamp: '2026-09-20T10:05:00.000Z' }),
  ].join('\n');

  it('pulls session, cwd, branch, the first user message and the timestamps — and nothing else', () => {
    const m = transcriptMeta(claude);
    expect(m.sessionId).toBe('sess-1');
    expect(m.cwd).toBe('/Users/x/repo');
    expect(m.gitBranch).toBe('main');
    expect(m.firstUserMessage).toBe('fix the failing test please');
    expect(m.startedAt).toBe('2026-09-20T10:00:00.000Z');
    expect(m.endedAt).toBe('2026-09-20T10:05:00.000Z');
    expect(m.records).toBe(3);
    expect(m.truncated).toBe(false);
  });

  it('reads the Codex rollout shape (payload.id / payload.cwd / git.branch)', () => {
    const codex = [
      JSON.stringify({ timestamp: '2026-09-01T00:00:00Z', type: 'session_meta', payload: { id: 'roll-9', cwd: '/srv/app', git: { branch: 'dev' } } }),
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'hello codex' }] }),
    ].join('\n');
    const m = transcriptMeta(codex);
    expect([m.sessionId, m.cwd, m.gitBranch, m.firstUserMessage]).toEqual(['roll-9', '/srv/app', 'dev', 'hello codex']);
  });

  it('redacts and clips the first user message', () => {
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: `here is my key sk-ant-${'a'.repeat(30)} and ${'x'.repeat(300)}` } });
    const m = transcriptMeta(line);
    expect(m.firstUserMessage).not.toContain('sk-ant-aaaa');
    expect(m.firstUserMessage).toContain('[REDACTED:pattern]');
    expect((m.firstUserMessage ?? '').length).toBeLessThanOrEqual(120);
    expect(transcriptMeta(line, { messageChars: 20 }).firstUserMessage?.length).toBe(20);
  });

  it('stops at transcriptScanBytes — the 151 MB transcript costs one 256 KiB read', () => {
    const filler = `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'x'.repeat(200) } })}\n`;
    const big = Buffer.from(`${claude}\n${filler.repeat(4000)}`);
    expect(big.length).toBeGreaterThan(IMPORT_LIMITS.transcriptScanBytes);
    const m = transcriptMeta(big);
    expect(m.truncated).toBe(true);
    expect(m.bytes).toBe(IMPORT_LIMITS.transcriptScanBytes);
    expect(m.sessionId).toBe('sess-1');
  });

  it('an empty or unparsable transcript yields nulls, not an exception', () => {
    const m = transcriptMeta('');
    expect(m).toMatchObject({ sessionId: null, cwd: null, gitBranch: null, firstUserMessage: null, records: 0 });
    expect(() => transcriptMeta('garbage\n')).not.toThrow();
  });
});
