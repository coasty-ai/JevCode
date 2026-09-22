/** core/redact.ts (DESIGN §8.4; TUI-DESIGN §10.1, §10.7, §19.0 row O7): moved from test/unit/config/ and extended with detectSecrets. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DRAFT_MARKER,
  EXACT_FAMILY,
  MIN_SECRET_LENGTH,
  PATTERN_MARKER,
  REDACTING_PATTERNS,
  WARN_ONLY_PATTERNS,
  createRedactor,
  detectSecrets,
  patternRedact,
  redactSpans,
  secretSpans,
  type SecretHit,
} from '../../../src/core/redact.js';
import { redactDeep } from '../../../src/checkpoint/store.js';
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

  it('dropSecret forgets every entry under a name and lets the value be re-added (the composer ring, §10.2)', () => {
    const rr = createRedactor([]);
    expect(rr.dropSecret('composer#1')).toBe(false);
    expect(rr.addSecret('composer#1', 'ring-secret-value-1')).toBe(true);
    expect(rr.addSecret('composer#1', 'ring-secret-value-2')).toBe(true);
    expect(rr.addSecret('composer#2', 'ring-secret-value-3')).toBe(true);
    expect(rr.size).toBe(3);
    expect(rr.dropSecret('composer#1')).toBe(true);
    expect(rr.size).toBe(1);
    expect(rr.redact('ring-secret-value-1 ring-secret-value-3')).toBe('ring-secret-value-1 [REDACTED:composer#2]');
    // the value is no longer "seen": it can join again under a new name
    expect(rr.addSecret('composer#3', 'ring-secret-value-1')).toBe(true);
    expect(rr.redact('ring-secret-value-1')).toBe('[REDACTED:composer#3]');
    expect(rr.dropSecret('composer#1')).toBe(false);
  });

  it('keeps 64 composer entries with dropSecret of the oldest (host-side ring shape)', () => {
    const rr = createRedactor([]);
    for (let n = 1; n <= 70; n++) {
      rr.addSecret(`composer#${n}`, `composer-secret-${String(n).padStart(3, '0')}`);
      if (n > 64) rr.dropSecret(`composer#${n - 64}`);
    }
    expect(rr.size).toBe(64);
    expect(rr.redact('composer-secret-001')).toBe('composer-secret-001');
    expect(rr.redact('composer-secret-070')).toBe('[REDACTED:composer#70]');
  });
});

// ---------------------------------------------------------------------------------------
// detectSecrets (TUI-DESIGN §10.1)
// ---------------------------------------------------------------------------------------

const AWS = 'AKIAIOSFODNN7EXAMPLE';
const SLACK = 'xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrSt';
const WEBHOOK = 'hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX';
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const STRIPE = 'sk_live_4eC39HqLyjWDarjtT1zdp7dc';
const NPM = 'npm_abcdefghijklmnopqrstuvwxyz0123456789';
const HF = 'hf_abcdefghijklmnopqrstuvwxyzABCDEFGH';
const GLPAT = 'glpat-abcdefghijklmnopqrstuvwxyz';
const PEM_BLOCK = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0K1\nabcdefghijklmnopqrstuvwxyz0123456789+/=\n-----END RSA PRIVATE KEY-----';
const PEM_HEADER_ONLY = '-----BEGIN OPENSSH PRIVATE KEY-----';

function one(s: string): SecretHit {
  const hits = detectSecrets(s);
  expect(hits, s).toHaveLength(1);
  return hits[0]!;
}

describe('detectSecrets (TUI-DESIGN §10.1)', () => {
  it('returns [] for empty input, no hits and non-string input', () => {
    expect(detectSecrets('')).toEqual([]);
    expect(detectSecrets('plain prose with numbers 12345678 and a sha ' + SHA)).toEqual([]);
    expect(detectSecrets(undefined as unknown as string)).toEqual([]);
  });

  it('reports every redacting family with its span, label and warnOnly=false', () => {
    const table: [string, string, string][] = [
      ['sk-or-v1-abcdefghijklmnopqrstuvwxyz0123', 'openrouter', 'sk-or-…'],
      ['sk-ant-api03-abcdefghijklmnopqrstuv_-x', 'anthropic', 'sk-ant-…'],
      ['sk-proj-abcdefghijklmnopqrstuvwxyz', 'sk', 'sk-proj-… (OpenAI)'],
      ['sk-abcdefghijklmnopqrstuvwxyz0123', 'sk', 'sk-…'],
      ['sk-live_abcdefghijklmnopqrstuvwxyz', 'sk', 'sk-…'],
      ['AIzaSyA-abcdefghijklmnopqrstuvwxyz01234', 'google', 'AIza…'],
      ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'github', 'ghp_…'],
      ['gho_abcdefghijklmnopqrstuvwxyz0123456789', 'github', 'gho_…'],
      ['github_pat_abcdefghijklmnopqrstuv_wx', 'github_pat', 'github_pat_…'],
    ];
    for (const [key, family, label] of table) {
      const text = `token=${key} end`;
      const h = one(text);
      expect(h.family, key).toBe(family);
      expect(h.label, key).toBe(label);
      expect(h.warnOnly, key).toBe(false);
      expect(text.slice(h.start, h.end), key).toBe(key);
    }
  });

  it('reports every warn-only family with warnOnly=true and a prefix-only label', () => {
    const table: [string, string, string][] = [
      [AWS, 'aws', 'AKIA…'],
      ['ASIAIOSFODNN7EXAMPLE', 'aws', 'ASIA…'],
      [SLACK, 'slack', 'xoxb-…'],
      [WEBHOOK, 'slack_webhook', 'hooks.slack.com/…'],
      [JWT, 'jwt', 'eyJ…'],
      [STRIPE, 'stripe', 'sk_live_…'],
      ['rk_test_4eC39HqLyjWDarjtT1zdp7dc', 'stripe', 'rk_test_…'],
      [NPM, 'npm', 'npm_…'],
      [HF, 'huggingface', 'hf_…'],
      [GLPAT, 'gitlab', 'glpat-…'],
      [PEM_HEADER_ONLY, 'pem', '-----BEGIN…'],
    ];
    for (const [key, family, label] of table) {
      const text = `x ${key} y`;
      const h = one(text);
      expect(h.family, key).toBe(family);
      expect(h.label, key).toBe(label);
      expect(h.warnOnly, key).toBe(true);
      expect(text.slice(h.start, h.end), key).toBe(key);
    }
    expect(WARN_ONLY_PATTERNS.map((p) => p.family)).toEqual(['aws', 'slack', 'slack_webhook', 'pem', 'jwt', 'stripe', 'npm', 'huggingface', 'gitlab']);
    expect(REDACTING_PATTERNS.map((p) => p.family)).toEqual(['openrouter', 'anthropic', 'sk', 'google', 'github', 'github_pat', 'xai', 'fireworks']);
    for (const p of WARN_ONLY_PATTERNS) expect(p.re.global, p.family).toBe(true);
  });

  it('PEM: the end-anchored form spans the whole block so the body is masked too; a header alone is a hit by itself', () => {
    const text = `key:\n${PEM_BLOCK}\nrest`;
    const h = one(text);
    expect(text.slice(h.start, h.end)).toBe(PEM_BLOCK);
    expect(h.label).toBe('-----BEGIN…');
    expect(secretSpans(text, [h])).toEqual([PEM_BLOCK]);
    const twice = `${PEM_BLOCK}\n\n${PEM_BLOCK}`;
    expect(detectSecrets(twice)).toHaveLength(2);
    expect(one(PEM_HEADER_ONLY).end).toBe(PEM_HEADER_ONLY.length);
  });

  it('warn-only patterns never mask automatically (C44): patternRedact leaves them intact', () => {
    for (const s of [AWS, SLACK, JWT, STRIPE, NPM, HF, GLPAT, PEM_BLOCK]) expect(patternRedact(`k=${s}`)).toBe(`k=${s}`);
  });

  it('labels never carry the secret tail: at most the fixed prefix (≤ 6 secret characters) plus …', () => {
    const samples = ['sk-or-v1-abcdefghijklmnopqrstuvwxyz0123', 'sk-ant-api03-abcdefghijklmnopqrstuv_-x', 'sk-proj-abcdefghijklmnopqrstuvwxyz', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', AWS, SLACK, JWT, STRIPE, NPM, HF, GLPAT, PEM_BLOCK, WEBHOOK];
    for (const s of samples) {
      const h = one(`q ${s} q`);
      const shown = h.label.replace(' (OpenAI)', '').replace('…', '');
      expect(s.startsWith(shown), h.label).toBe(true);
      // the shown part is the family prefix only: nothing after the last fixed separator of the family
      const tail = s.slice(shown.length);
      expect(tail.length, h.label).toBeGreaterThanOrEqual(10);
      expect(h.label.includes(tail.slice(0, 7)), h.label).toBe(false);
    }
  });

  it('exact configured secrets are reported first with `your <NAME>` and exact spans, even with no recognisable format', () => {
    const r = createRedactor([{ name: 'OPENROUTER_API_KEY', value: dotenv.get('OPENROUTER_API_KEY')! }, { name: 'UNUSED_DB_PASSWORD', value: 'plain-password-with-no-format-1234' }]);
    const text = `please use plain-password-with-no-format-1234 and ${dotenv.get('OPENROUTER_API_KEY')!} now`;
    const hits = detectSecrets(text, r);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.family)).toEqual([EXACT_FAMILY, EXACT_FAMILY]);
    expect(hits[0]!.label).toBe('your UNUSED_DB_PASSWORD');
    expect(text.slice(hits[0]!.start, hits[0]!.end)).toBe('plain-password-with-no-format-1234');
    expect(hits[1]!.label).toBe('your OPENROUTER_API_KEY');
    expect(text.slice(hits[1]!.start, hits[1]!.end)).toBe(dotenv.get('OPENROUTER_API_KEY')!);
    // the sk-or-v1- pattern overlapping the exact span is dropped: one hit per span, exact wins
    expect(hits.every((h) => !h.warnOnly)).toBe(true);
  });

  it('exact spans align at the start, the end, back to back and around the header rule whitespace normalisation', () => {
    const r = createRedactor([{ name: 'A', value: 'alpha-secret-0001' }, { name: 'B', value: 'bravo-secret-0002' }]);
    const pick = (t: string): string[] => detectSecrets(t, r).map((h) => `${h.label}:${t.slice(h.start, h.end)}`);
    expect(pick('alpha-secret-0001')).toEqual(['your A:alpha-secret-0001']);
    expect(pick('alpha-secret-0001 tail')).toEqual(['your A:alpha-secret-0001']);
    expect(pick('head alpha-secret-0001')).toEqual(['your A:alpha-secret-0001']);
    // a real Redactor knows the values: two glued secrets are two hits (a bare `redact` reports one span, see below)
    expect(pick('alpha-secret-0001bravo-secret-0002')).toEqual(['your A:alpha-secret-0001', 'your B:bravo-secret-0002']);
    expect(pick('x alpha-secret-0001 y bravo-secret-0002 z')).toEqual(['your A:alpha-secret-0001', 'your B:bravo-secret-0002']);
    const header = 'curl -H "Authorization: Bearer   alpha-secret-0001" -H "x-api-key:bravo-secret-0002" u';
    expect(pick(header)).toEqual(['your A:alpha-secret-0001', 'your B:bravo-secret-0002']);
    // a header value that is not a configured secret is not an exact hit (the pattern layer owns it, HEADER_PATTERN excluded from detection)
    expect(detectSecrets('Authorization: Bearer whatever-token-value', r)).toEqual([]);
  });

  it('`exact` is Pick<Redactor, "redact">: a bare redact function works', () => {
    const r = createRedactor([{ name: 'K', value: 'kappa-secret-0003' }]);
    const hits = detectSecrets('use kappa-secret-0003', { redact: r.redact });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.label).toBe('your K');
    // glued secrets through a bare redact are split too (bounded smallest-end scan)
    const two = createRedactor([{ name: 'A', value: 'alpha-secret-0001' }, { name: 'B', value: 'bravo-secret-0002' }]);
    const glued = 'alpha-secret-0001bravo-secret-0002';
    const bare = detectSecrets(glued, { redact: two.redact });
    expect(bare.map((h) => `${h.label}:${glued.slice(h.start, h.end)}`)).toEqual(['your A:alpha-secret-0001', 'your B:bravo-secret-0002']);
    // a pasted redacted log is literal text, never a hit (nothing was replaced)
    expect(detectSecrets('log: [REDACTED:generator.apiKey] ok', { redact: two.redact })).toEqual([]);
    expect(detectSecrets('log: [REDACTED:generator.apiKey] alpha-secret-0001 [REDACTED:x', { redact: two.redact }).map((h) => h.label)).toEqual(['your A']);
  });

  it('exactSpans on the redactor: every occurrence, longest secret first, non-overlapping, sorted; values never returned', () => {
    const r = createRedactor([{ name: 'INNER', value: 'innerkey12345678' }, { name: 'OUTER', value: 'prefix-innerkey12345678-suffix' }]);
    const t = 'a prefix-innerkey12345678-suffix b innerkey12345678 c innerkey12345678';
    const spans = r.exactSpans(t);
    expect(spans.map((sp) => `${sp.name}:${t.slice(sp.start, sp.end)}`)).toEqual(['OUTER:prefix-innerkey12345678-suffix', 'INNER:innerkey12345678', 'INNER:innerkey12345678']);
    expect(JSON.stringify(spans)).not.toContain('innerkey');
    expect(r.exactSpans('')).toEqual([]);
    expect(createRedactor([]).exactSpans('anything at all')).toEqual([]);
    // the redactor's own redact agrees with its spans
    expect(redactSpans(t, spans.map((sp) => ({ family: EXACT_FAMILY, label: sp.name, start: sp.start, end: sp.end, warnOnly: false })), '[X]')).toBe('a [X] b [X] c [X]');
  });

  it('adversarial alignment: text after the secret that also occurs inside its tail never cuts the span short (real redactor and bare redact alike)', () => {
    const key = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123';
    const r = createRedactor([{ name: 'OPENROUTER_API_KEY', value: key }]);
    const pw = createRedactor([{ name: 'DB_PASSWORD', value: 'aaaaaaaaXbb' }]);
    const cases: [string, ReturnType<typeof createRedactor>, string][] = [
      [`${key}e`, r, key],
      [`${key} stu`, r, key],
      [`${key}\nklm`, r, key],
      [`${key}0123`, r, key],
      [`x ${key} y ${key}e`, r, key],
      ['aaaaaaaaXbb bb', pw, 'aaaaaaaaXbb'],
      ['aaaaaaaaXbb aaaaaaaaXbb', pw, 'aaaaaaaaXbb'],
    ];
    for (const [text, red, secret] of cases) {
      for (const [mode, ex] of [
        ['redactor', red],
        ['bare', { redact: red.redact }],
      ] as const) {
        const hits = detectSecrets(text, ex);
        expect(hits.length, `${mode} ${JSON.stringify(text)}`).toBeGreaterThan(0);
        for (const h of hits) {
          expect(h.family, `${mode} ${JSON.stringify(text)}`).toBe(EXACT_FAMILY);
          expect(text.slice(h.start, h.end), `${mode} ${JSON.stringify(text)}`).toBe(secret);
        }
        const masked = redactSpans(text, hits);
        for (const sub of substrings8(secret)) expect(masked, `${mode} ${JSON.stringify(text)} leaks ${sub}`).not.toContain(sub);
        expect(secretSpans(text, hits), mode).toEqual([secret]);
      }
    }
  });

  it('the same secret glued twice: two hits labelled `your A` each (redactor and bare redact) — never `your A, A`', () => {
    const r = createRedactor([{ name: 'A', value: 'abcdefgh1' }]);
    const t = 'abcdefgh1abcdefgh1';
    for (const ex of [r, { redact: r.redact }]) {
      const hits = detectSecrets(t, ex);
      expect(hits.map((h) => h.label)).toEqual(['your A', 'your A']);
      expect(hits.map((h) => t.slice(h.start, h.end))).toEqual(['abcdefgh1', 'abcdefgh1']);
      for (const h of hits) expect(h.label).not.toContain(',');
      expect(redactSpans(t, hits)).toBe(DRAFT_MARKER);
    }
  });

  it('invariant: redactSpans(text, detectSecrets(text, redactor)) never contains any 8-char substring of a configured secret', () => {
    const secrets = [
      { name: 'OPENROUTER_API_KEY', value: 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123' },
      { name: 'DB_PASSWORD', value: 'aaaaaaaaXbb' },
      { name: 'TOKEN', value: 'tok-en-12345678-zz' },
      { name: 'REPEAT', value: 'abababababab' },
    ];
    const r = createRedactor(secrets);
    // glue never contains an 8-char substring of a secret itself (a typed prefix outside the secret is not a leak)
    const glue = ['', 'e', ' stu', '\nklm', 'bb', 'ab', 'ababab', '0123', ' ', 'sk-or-', '[REDACTED:', ']'];
    const texts: string[] = [];
    for (const a of secrets) for (const g of glue) for (const b of secrets) texts.push(`${a.value}${g}${b.value}${g}`);
    for (const a of secrets) for (const g of glue) texts.push(`${g}${a.value}${g}`);
    for (const text of texts) {
      for (const ex of [r, { redact: r.redact }]) {
        const masked = redactSpans(text, detectSecrets(text, ex));
        for (const sec of secrets) for (const sub of substrings8(sec.value)) expect(masked, `${JSON.stringify(text)} leaks ${sub}`).not.toContain(sub);
      }
    }
  });

  it('spans never overlap and are sorted by start; a more specific family wins over the generic sk- rule', () => {
    const text = `a ${AWS} b sk-or-v1-abcdefghijklmnopqrstuvwxyz0123 c ${JWT} d sk-ant-api03-abcdefghijklmnopqrstuv_-x`;
    const hits = detectSecrets(text);
    expect(hits.map((h) => h.family)).toEqual(['aws', 'openrouter', 'jwt', 'anthropic']);
    for (let i = 1; i < hits.length; i++) expect(hits[i]!.start).toBeGreaterThanOrEqual(hits[i - 1]!.end);
  });

  it('false positives: legitimate text that must NOT match', () => {
    const benign = [
      // base64 blobs (an `AIza`, an `ey`, a `gh` inside)
      'sha512-QUl6YUFJemFAIzaQUl6YUFJemFBSXphQUl6YUFJemFBSXphQUl6YQ==',
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      // sha256 hex, 40-hex SHA, UUID
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      SHA,
      '123e4567-e89b-12d3-a456-426614174000',
      // `sk-` inside words and identifiers
      'disk-usage-report-2026-09-19-final.txt',
      'task-abcdefghijklmnopqrstuvwxyz',
      'the desk-organizer-project-plan-v2 file',
      // a PEM header without PRIVATE KEY
      '-----BEGIN CERTIFICATE-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END CERTIFICATE-----',
      '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----',
      // AWS-like uppercase words that are not 16 chars of the base32 alphabet
      'AKIA is the prefix; AKIAEXAMPLE is too short',
      // Slack words, npm/hf words in prose
      'the xoxb prefix and npm_config_registry and hf_hub_download()',
      'highs_abcdefghijklmnopqrstuvwxyz0123456789',
      // JSON with metadata keys
      'metadata = {"n_episodes": 3, "api_request_times_msec": [12, 14]}',
      // Authorization header quoted in prose (HEADER_PATTERN is excluded from detection)
      'set `Authorization: Bearer <token>` and `Content-Type: application/json`',
      // a Stripe-shaped word too short
      'sk_live_short and rk_test_abc',
      // gitlab prefix inside a word
      'myglpat-abcdefghijklmnopqrstuvwxyz',
    ];
    for (const b of benign) expect(detectSecrets(b), b).toEqual([]);
  });

  it('unicode: graphemes, wide characters and emoji before a key keep the span indices exact', () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuv_-x';
    const text = `日本語 🎉👨‍👩‍👧 é ${key} 終`;
    const h = one(text);
    expect(text.slice(h.start, h.end)).toBe(key);
    expect(redactSpans(text, [h])).toBe(`日本語 🎉👨‍👩‍👧 é ${DRAFT_MARKER} 終`);
  });

  /** Best of N runs absorbs CI jitter while asserting the design's bound itself, not a multiple of it. */
  function bestOf(n: number, fn: () => void): number {
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      fn();
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  }
  function kb256(unit: string): string {
    let big = '';
    while (big.length < 256 * 1024) big += unit;
    return big.slice(0, 256 * 1024);
  }
  const BUDGET_MS = 5;

  it('a 256 KB input scans in < 5 ms (the §10.1 budget, best of 5) with and without an exact redactor', () => {
    const big = kb256('INFO 2026-09-20T19:15:06Z request id=7f3a disk-usage-report ok sha=deadbeefdeadbeef task-abcdefghij ey.eyJ npm_config\n');
    const r = createRedactor([{ name: 'K', value: 'kappa-secret-0003' }, { name: 'L', value: FLAG_KEY }]);
    expect(detectSecrets(big)).toEqual([]);
    expect(detectSecrets(big, r)).toEqual([]);
    const plainMs = bestOf(5, () => detectSecrets(big));
    const exactMs = bestOf(5, () => detectSecrets(big, r));
    const bareMs = bestOf(5, () => detectSecrets(big, { redact: r.redact }));
    process.stderr.write(`detectSecrets 256 KB: patterns ${plainMs.toFixed(2)} ms, with exact ${exactMs.toFixed(2)} ms, bare redact ${bareMs.toFixed(2)} ms\n`);
    expect(plainMs).toBeLessThan(BUDGET_MS);
    expect(exactMs).toBeLessThan(BUDGET_MS);
    expect(bareMs).toBeLessThan(BUDGET_MS);
  });

  it('backtracking guard: ≥ 2000 PEM headers in 256 KB, with and without END lines, scan in < 5 ms and every header is a hit', () => {
    const hdr = '-----BEGIN RSA PRIVATE KEY-----';
    const bareHeaders = kb256(`INFO saw ${hdr} in file\n`);
    const paired = kb256(`${hdr}\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn\n-----END RSA PRIVATE KEY-----\n`);
    const headerCount = (bareHeaders.match(/-----BEGIN RSA PRIVATE KEY-----/g) ?? []).length;
    expect(headerCount).toBeGreaterThanOrEqual(2000);
    const bareHits = detectSecrets(bareHeaders);
    expect(bareHits).toHaveLength(headerCount);
    for (const h of bareHits.slice(0, 50)) expect(bareHeaders.slice(h.start, h.end)).toBe(hdr);
    const pairedHits = detectSecrets(paired);
    expect(pairedHits.length).toBeGreaterThanOrEqual(2000);
    for (const h of pairedHits.slice(0, 50)) expect(paired.slice(h.start, h.end)).toMatch(/^-----BEGIN RSA PRIVATE KEY-----\n[^\n]*\n-----END RSA PRIVATE KEY-----$/);
    const bareMs = bestOf(5, () => detectSecrets(bareHeaders));
    const pairedMs = bestOf(5, () => detectSecrets(paired));
    // the pathological single header near the start of a big input, no END anywhere
    const pemHeavy = `${PEM_HEADER_ONLY}\n${kb256('x y z\n')}`;
    expect(detectSecrets(pemHeavy)).toHaveLength(1);
    const heavyMs = bestOf(5, () => detectSecrets(pemHeavy));
    process.stderr.write(`detectSecrets PEM 256 KB: ${headerCount} bare headers ${bareMs.toFixed(2)} ms, ${pairedHits.length} paired ${pairedMs.toFixed(2)} ms, one header ${heavyMs.toFixed(2)} ms\n`);
    expect(bareMs).toBeLessThan(BUDGET_MS);
    expect(pairedMs).toBeLessThan(BUDGET_MS);
    expect(heavyMs).toBeLessThan(BUDGET_MS);
    // an END of another kind between the header and its END is skipped; the next header bounds the search
    const mixed = `${hdr}\n-----END CERTIFICATE-----\nbody\n-----END RSA PRIVATE KEY-----\n${hdr}\nno end here`;
    const m = detectSecrets(mixed);
    expect(m).toHaveLength(2);
    expect(mixed.slice(m[0]!.start, m[0]!.end)).toBe(`${hdr}\n-----END CERTIFICATE-----\nbody\n-----END RSA PRIVATE KEY-----`);
    expect(mixed.slice(m[1]!.start, m[1]!.end)).toBe(hdr);
  });

  it('a 2 KB draft scans in well under a millisecond (the ⚠ secret? marker runs on every change)', () => {
    const draft = `${'refactor the parser and keep the tests green '.repeat(40)}sk-ant-api03-abcdefghijklmnopqrstuv_-x`;
    detectSecrets(draft);
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) detectSecrets(draft);
    const per = (performance.now() - t0) / 100;
    expect(per).toBeLessThan(0.5);
  });
});

describe('secretSpans / redactSpans (TUI-DESIGN §10.2, §10.7)', () => {
  it('secretSpans returns distinct spans ≥ MIN_SECRET_LENGTH in order', () => {
    const text = `a ${AWS} b ${AWS} c sk-ant-api03-abcdefghijklmnopqrstuv_-x`;
    const hits = detectSecrets(text);
    expect(secretSpans(text, hits)).toEqual([AWS, 'sk-ant-api03-abcdefghijklmnopqrstuv_-x']);
    expect(secretSpans('short', [{ family: 'x', label: 'x', start: 0, end: 5, warnOnly: true }])).toEqual([]);
  });

  it('redactSpans masks every hit (warn-only included) with [REDACTED:draft], merging overlaps and ignoring out-of-range spans', () => {
    const text = `send ${AWS} and ${JWT} please`;
    const hits = detectSecrets(text);
    expect(redactSpans(text, hits)).toBe(`send ${DRAFT_MARKER} and ${DRAFT_MARKER} please`);
    expect(redactSpans(text, [])).toBe(text);
    const overlapping: SecretHit[] = [
      { family: 'a', label: 'a', start: 5, end: 12, warnOnly: false },
      { family: 'b', label: 'b', start: 10, end: 25, warnOnly: true },
      { family: 'c', label: 'c', start: -5, end: 0, warnOnly: true },
      { family: 'd', label: 'd', start: 1000, end: 2000, warnOnly: true },
    ];
    expect(redactSpans(text, overlapping)).toBe(`send ${DRAFT_MARKER}${text.slice(25)}`);
    expect(redactSpans('', [])).toBe('');
    expect(redactSpans(text, hits, '[REDACTED:composer#1]')).toContain('[REDACTED:composer#1]');
  });
});

// ---------------------------------------------------------------------------------------
// DESIGN §8.4 — the two provider families added in hygiene round 5
// ---------------------------------------------------------------------------------------

/**
 * xAI and Fireworks keys are handed to JevCode through `generator.apiKey` / `XAI_API_KEY` /
 * `FIREWORKS_API_KEY` like every other provider's, but until now neither shape was a family: a key
 * pasted into a prompt, echoed by a `printenv` or quoted in an error body went to `report.md`,
 * `state.json` and the transcript intact unless it happened to be registered as an exact secret.
 *
 * Meta's Model API is deliberately NOT here — its key shape is not documented anywhere in this
 * repository, and a guessed prefix would either mangle ordinary output or mask nothing at all.
 */
const XAI_KEY = `xai-${'abcdefghij0123456789ABCDEFGHIJ0123456789'}`;
const FW_KEY = `fw_${'abcdefghij0123456789'}`;
/** One character short of each family's minimum tail: ordinary output, and it must survive. */
const XAI_SHORT = `xai-${'abcdefghij0123456789ABCDEFGHIJ012345678'}`;
const FW_SHORT = `fw_${'abcdefghij012345678'}`;

describe('xAI and Fireworks are redacting families (DESIGN §8.4)', () => {
  it('patternRedact masks both in text, before config resolution', () => {
    for (const key of [XAI_KEY, FW_KEY]) {
      const out = patternRedact(`export KEY=${key}\n`);
      expect(out, key).not.toContain(key);
      expect(out, key).toContain(PATTERN_MARKER);
    }
  });

  it('both are masked in nested JSON through redactDeep', () => {
    const redactor = createRedactor([]);
    const doc = { env: { XAI_API_KEY: XAI_KEY }, rows: [{ note: `fireworks ${FW_KEY} ok` }] };
    const out = JSON.stringify(redactDeep(doc, (s) => redactor.redact(s)));
    expect(out).not.toContain(XAI_KEY);
    expect(out).not.toContain(FW_KEY);
    expect(out.match(/\[REDACTED:pattern\]/g)).toHaveLength(2);
  });

  it('a near-miss (one character short of the minimum tail) is ordinary output and survives', () => {
    for (const near of [XAI_SHORT, FW_SHORT]) {
      expect(patternRedact(`value=${near}`), near).toContain(near);
      expect(detectSecrets(`value=${near}`), near).toEqual([]);
    }
  });

  it('detectSecrets reports each with its prefix-only label and warnOnly=false', () => {
    const table: [string, string, string][] = [
      [XAI_KEY, 'xai', 'xai-…'],
      [FW_KEY, 'fireworks', 'fw_…'],
    ];
    for (const [key, family, label] of table) {
      const text = `token=${key} end`;
      const hits = detectSecrets(text);
      expect(hits, key).toHaveLength(1);
      const h = hits[0]!;
      expect(h.family, key).toBe(family);
      expect(h.label, key).toBe(label);
      expect(h.warnOnly, key).toBe(false);
      expect(text.slice(h.start, h.end), key).toBe(key);
    }
  });

  it('the two families join REDACTING_PATTERNS, which is now eight of the seventeen', () => {
    expect(REDACTING_PATTERNS.map((p) => p.family)).toEqual(['openrouter', 'anthropic', 'sk', 'google', 'github', 'github_pat', 'xai', 'fireworks']);
    expect(REDACTING_PATTERNS.length + WARN_ONLY_PATTERNS.length).toBe(17);
    for (const p of REDACTING_PATTERNS) expect(p.re.global, p.family).toBe(true);
  });
});
