/** import/parse/jsonc.ts (IMPORT-DESIGN §4.3; §6 row 20): comments, trailing commas, string-awareness. */
import { describe, expect, it } from 'vitest';
import { parseJsonc, stripJsonComments } from '../../../../src/import/parse/jsonc.js';

describe('stripJsonComments', () => {
  it('drops line and block comments and preserves offsets', () => {
    const src = '{ // note\n  "a": 1 /* mid */, "b": 2\n}';
    const out = stripJsonComments(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('note');
    expect(out).not.toContain('mid');
    expect(JSON.parse(out)).toEqual({ a: 1, b: 2 });
  });

  it('§6 row 20: a // inside a string is data, not a comment', () => {
    const src = '{"url": "https://example.com/x", "p": "a /* b */ c"}';
    expect(stripJsonComments(src)).toBe(src);
    const r = parseJsonc(src);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ url: 'https://example.com/x', p: 'a /* b */ c' });
  });

  it('an unterminated block comment does not hang or throw', () => {
    expect(() => stripJsonComments('{ /* never closed')).not.toThrow();
  });
});

describe('parseJsonc', () => {
  it('parses the real shapes: comments plus trailing commas, and reports both', () => {
    const r = parseJsonc('{\n  // opencode.jsonc\n  "model": "x",\n  "mcp": { "a": { "type": "local" }, },\n}\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ model: 'x', mcp: { a: { type: 'local' } } });
    expect(r.warnings).toEqual(['comments dropped', '2 trailing commas dropped']);
  });

  it('plain JSON parses with no warnings', () => {
    const r = parseJsonc('{"a":[1,2,3]}');
    expect(r).toEqual({ ok: true, value: { a: [1, 2, 3] }, warnings: [] });
  });

  it('a BOM is tolerated', () => {
    const r = parseJsonc('﻿{"a":1}');
    expect(r.ok).toBe(true);
  });

  it('malformed JSON is one {ok:false}, never a throw', () => {
    const r = parseJsonc('{"a": }');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.length).toBeGreaterThan(0);
    expect(parseJsonc('   ')).toMatchObject({ ok: false, error: 'empty document' });
  });
});
