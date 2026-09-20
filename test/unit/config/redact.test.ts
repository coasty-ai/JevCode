import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIN_SECRET_LENGTH, PATTERN_MARKER, createRedactor, patternRedact } from '../../../src/core/redact.js';
import { parseDotenvText } from '../../../src/config/env.js';

const FIX = join(import.meta.dirname, '../../fixtures/config');
const dotenv = parseDotenvText(readFileSync(join(FIX, 'redaction.env'), 'utf8'));
const execOutput = readFileSync(join(FIX, 'exec-output.txt'), 'utf8');
const SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const FLAG_KEY = 'flagkey-ABCDEF0123456789-XYZ';

function substrings8(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 8 <= s.length; i++) out.push(s.slice(i, i + 8));
  return out;
}

describe('patternRedact (before config resolution)', () => {
  it('masks every §8.4 format and header values, keeps a 40-hex SHA and an integrity hash', () => {
    const out = patternRedact(execOutput);
    for (const [name, value] of dotenv) {
      if (name === 'LAST_COMMIT' || name === 'SOME_PLAIN' || name === 'UNUSED_DB_PASSWORD') continue;
      expect(out, name).not.toContain(value);
    }
    expect(out).toContain(SHA);
    expect(out).toContain('sha512-abcdefghijklmnop');
    expect(out).toMatch(/Authorization: Bearer \[REDACTED:pattern\]/);
    expect(out).toMatch(/x-api-key: \[REDACTED:pattern\]/);
    expect(out).not.toContain('sk-live_FAKE');
    // The unused plain-format password has no recognisable shape: only the exact-string layer can catch it.
    expect(out).toContain('plain-password-with-no-format-1234');
  });

  it('matches each pattern family in isolation', () => {
    const cases = [
      'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123',
      'sk-ant-api03-abcdefghijklmnopqrstuv_-x',
      'sk-proj-abcdefghijklmnopqrstuvwxyz',
      'sk-live_abcdefghijklmnopqrstuvwxyz',
      'sk-test_abcdefghijklmnopqrstuvwxyz',
      'sk-abcdefghijklmnopqrstuvwxyz0123',
      'AIzaSyA-abcdefghijklmnopqrstuvwxyz01234',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'gho_abcdefghijklmnopqrstuvwxyz0123456789',
      'ghu_abcdefghijklmnopqrstuvwxyz0123456789',
      'ghs_abcdefghijklmnopqrstuvwxyz0123456789',
      'ghr_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_abcdefghijklmnopqrstuv_wx',
    ];
    for (const c of cases) expect(patternRedact(`token=${c} end`), c).toBe(`token=${PATTERN_MARKER} end`);
  });

  it('only matches a key that starts a token: ordinary identifiers and base64 blobs that embed a prefix survive', () => {
    // Without a boundary `disk-` + 20 safe characters is an `sk-` match and `AIza` occurs inside base64 output.
    const benign = [
      'disk-usage-report-2026-09-19-final.txt',
      'task-abcdefghijklmnopqrstuvwxyz',
      'sha512-QUl6YUFJemFAIzaQUl6YUFJemFBSXphQUl6YUFJemFBSXphQUl6YQ==',
      'highs_abcdefghijklmnopqrstuvwxyz0123456789',
    ];
    for (const b of benign) expect(patternRedact(`x ${b} y`), b).toBe(`x ${b} y`);
    // Every separator a key is realistically preceded by still triggers the pattern.
    const key = 'sk-abcdefghijklmnopqrstuvwxyz0123';
    for (const sep of ['=', ' ', '"', "'", ':', '(', ',', '\t', '\n']) expect(patternRedact(`k${sep}${key}`), JSON.stringify(sep)).toBe(`k${sep}${PATTERN_MARKER}`);
    expect(patternRedact(key)).toBe(PATTERN_MARKER);
  });

  it('leaves short or shapeless tokens alone', () => {
    for (const s of ['sk-short', 'ghp_short', 'AIzaTooShort', 'a'.repeat(200), SHA, 'authorization: none']) expect(patternRedact(s)).toBe(s);
    expect(patternRedact('')).toBe('');
  });
});

describe('createRedactor', () => {
  const secrets = [
    { name: 'generator.apiKey', value: FLAG_KEY },
    { name: 'decider.apiKey', value: dotenv.get('OPENROUTER_API_KEY')! },
    ...[...dotenv].filter(([k]) => /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(k)).map(([name, value]) => ({ name, value })),
  ];
  const r = createRedactor(secrets);

  it('names configured secrets, then applies patterns, and never leaks an 8-char substring of a configured key', () => {
    const out = r.redact(execOutput);
    expect(out).toContain('[REDACTED:generator.apiKey]');
    expect(out).toContain('[REDACTED:decider.apiKey]');
    expect(out).toContain('[REDACTED:UNUSED_DB_PASSWORD]');
    expect(out).toContain('[REDACTED:GITHUB_TOKEN]');
    expect(out).toContain(SHA);
    for (const [name, value] of dotenv) if (name !== 'LAST_COMMIT' && name !== 'SOME_PLAIN') expect(out, name).not.toContain(value);
    for (const key of [FLAG_KEY, dotenv.get('OPENROUTER_API_KEY')!]) for (const sub of substrings8(key)) expect(out).not.toContain(sub);
    expect(out).toContain('x-api-key: [REDACTED:generator.apiKey]');
  });

  it('is idempotent and stable across repeated application', () => {
    const once = r.redact(execOutput);
    expect(r.redact(once)).toBe(once);
  });

  it('replaces longest secret first so a key containing another key keeps its own name', () => {
    const inner = 'innerkey12345678';
    const outer = `prefix-${inner}-suffix`;
    const rr = createRedactor([
      { name: 'INNER', value: inner },
      { name: 'OUTER', value: outer },
    ]);
    expect(rr.redact(`a ${outer} b ${inner} c`)).toBe('a [REDACTED:OUTER] b [REDACTED:INNER] c');
  });

  it('ignores secrets shorter than 8 chars and de-duplicates values', () => {
    const rr = createRedactor([{ name: 'A', value: 'short' }]);
    expect(rr.size).toBe(0);
    expect(rr.redact('short text')).toBe('short text');
    expect(rr.addSecret('B', 'x'.repeat(MIN_SECRET_LENGTH))).toBe(true);
    expect(rr.addSecret('C', 'x'.repeat(MIN_SECRET_LENGTH))).toBe(false);
    expect(rr.size).toBe(1);
    expect(rr.redact(`k=${'x'.repeat(8)}`)).toBe('k=[REDACTED:B]');
  });

  it('redactJson touches string leaves only, at every depth', () => {
    const key = dotenv.get('GITHUB_TOKEN')!;
    const out = r.redactJson({ a: [key, 1, null, { b: `x ${key} y`, c: true }], [key]: 'k' });
    expect(out).toEqual({ a: ['[REDACTED:GITHUB_TOKEN]', 1, null, { b: 'x [REDACTED:GITHUB_TOKEN] y', c: true }], [key]: 'k' });
    expect(r.redactJson(42)).toBe(42);
    expect(r.redactJson(null)).toBe(null);
  });
});
