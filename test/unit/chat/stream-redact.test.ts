/**
 * chat/stream-redact.ts — the live region's append-only, redacted, sanitized view of a streamed chat reply. The
 * property: over random texts built from all eight redacting pattern families, header lines, exact secrets (with and
 * without whitespace), control characters and glue, split at random delta boundaries, every intermediate output is a
 * prefix of the final one, the final one is exactly `redact(sanitizeStream(full))`, and no fragment of a secret the
 * final output redacts is ever shown on the way.
 */
import { describe, expect, it } from 'vitest';
import { createStreamRedactor } from '../../../src/chat/stream-redact.js';
import { createRedactor, PATTERN_MARKER } from '../../../src/core/redact.js';
import { sanitizeStream } from '../../../src/tui/plain.js';

/** mulberry32: a seeded PRNG, so a failing case is reproducible from its seed */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const KEYCH = `${ALNUM}_-`;

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}
function chars(r: () => number, alphabet: string, min: number, max: number): string {
  const n = min + Math.floor(r() * (max - min + 1));
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(r() * alphabet.length)];
  return s;
}

/** one valid key of each of the eight FORMAT_PATTERNS families (core/redact.ts) */
const FAMILIES: readonly ((r: () => number) => string)[] = [
  (r) => `sk-or-v1-${chars(r, ALNUM, 20, 64)}`,
  (r) => `sk-ant-${chars(r, KEYCH, 20, 40)}`,
  (r) => `sk-${pick(r, ['', 'proj-', 'live_', 'test_'])}${chars(r, KEYCH, 20, 40)}`,
  (r) => `AIza${chars(r, KEYCH, 35, 35)}`,
  (r) => `gh${pick(r, ['p', 'o', 'u', 's', 'r'])}_${chars(r, ALNUM, 36, 40)}`,
  (r) => `github_pat_${chars(r, `${ALNUM}_`, 22, 40)}`,
  (r) => `xai-${chars(r, ALNUM, 40, 50)}`,
  (r) => `fw_${chars(r, ALNUM, 20, 30)}`,
];

const WORDS = ['hello', 'the', 'key', 'is', 'Bearer', 'token', 'sk', 'AIza', 'x-api', 'fw', 'config', 'README.md', 'src/app.ts', '42', 'ok'];
const SEPS = [' ', ' ', ' ', '\n', ', ', '. ', '', '', ':', '(', ')', '"', '\t', '  '];
const CONTROL = ['\x07', '\x1b[5m', '\x1b[0m', '\x00', '\x7f'];

interface Case {
  text: string;
  secrets: { name: string; value: string }[];
  /** fragments that must never be shown unless the final output shows them too */
  fragments: string[];
}

function makeCase(seed: number): Case {
  const r = rng(seed);
  // exact secrets: a distinctive head (never produced by anything else) so a leak is unambiguous
  const plain = `Zq9${chars(r, `${ALNUM}+/=.`, 9, 40)}`;
  const spaced = `Zp8 ${chars(r, 'abcdefgh', 3, 8)} ${chars(r, 'ijklmnop', 3, 8)}${pick(r, [' ', '\n', '  '])}${chars(r, 'qrstuvwx', 2, 6)}`;
  const secrets = [
    { name: 'DB_PASSWORD', value: spaced },
    { name: 'generator.apiKey', value: plain },
  ];
  const fragments = [plain.slice(0, 6), spaced.slice(0, 5)];
  const parts: string[] = [];
  const count = 4 + Math.floor(r() * 14);
  for (let i = 0; i < count; i++) {
    const kind = r();
    if (kind < 0.3) parts.push(pick(r, WORDS));
    else if (kind < 0.5) {
      const key = pick(r, FAMILIES)(r);
      parts.push(key);
      // the body right after the family prefix: redacted unless glue blocks the lookbehind
      fragments.push(key.slice(0, Math.min(key.length, 14)));
    } else if (kind < 0.6) {
      const tok = chars(r, `${ALNUM}._~+/`, 6, 30);
      parts.push(pick(r, [`Authorization: Bearer ${tok}`, `authorization:\n  bearer   ${tok}`, `x-api-key: ${tok}`, `X-API-KEY:${tok}`, `Authorization: Basic ${tok}`]));
    } else if (kind < 0.7) parts.push(plain);
    else if (kind < 0.8) parts.push(spaced);
    else if (kind < 0.88) parts.push(pick(r, CONTROL));
    else parts.push(chars(r, `${ALNUM}-_`, 1, 12));
    parts.push(pick(r, SEPS));
  }
  return { text: parts.join(''), secrets, fragments };
}

function splitRandom(r: () => number, text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; ) {
    const n = 1 + Math.floor(r() * 9);
    out.push(text.slice(i, i + n));
    i += n;
  }
  return out;
}

describe('createStreamRedactor — property over random texts and random splits', () => {
  it('every intermediate output is a prefix of the final one; the final one is redact(sanitize(full)); no redacted fragment is ever shown', () => {
    for (let seed = 1; seed <= 600; seed++) {
      const c = makeCase(seed);
      const red = createRedactor(c.secrets);
      const expected = red.redact(sanitizeStream(c.text));
      for (const variant of ['precise', 'conservative'] as const) {
        const sr = variant === 'precise' ? createStreamRedactor(red.redact, red.maxLength, red.maxSpacedLength) : createStreamRedactor(red.redact, red.maxLength);
        const shown: string[] = [];
        let appended = '';
        for (const d of splitRandom(rng(seed * 7919), c.text)) {
          appended += sr.push(d);
          shown.push(sr.text);
        }
        appended += sr.end();
        const final = sr.text;
        const where = `seed ${seed} (${variant}): ${JSON.stringify(c.text)}`;
        expect(final, where).toBe(expected);
        expect(appended, where).toBe(final);
        let prev = '';
        for (const t of shown) {
          expect(t.startsWith(prev), where).toBe(true);
          expect(final.startsWith(t), where).toBe(true);
          prev = t;
        }
        for (const f of c.fragments) {
          if (final.includes(f)) continue; // glue blocked the pattern: the final text shows it, so may the stream
          for (const t of shown) expect(t.includes(f), `${where} leaked ${JSON.stringify(f)}`).toBe(false);
        }
      }
    }
  });
});

describe('createStreamRedactor — the stream still flows', () => {
  const key = 'sk-or-v1-0123456789abcdef0123456789abcdef';

  it('plain prose is released word by word, with or without exact secrets configured', () => {
    for (const red of [createRedactor([]), createRedactor([{ name: 'OPENROUTER_API_KEY', value: key }])]) {
      const sr = createStreamRedactor(red.redact, red.maxLength, red.maxSpacedLength);
      sr.push('Hel');
      sr.push('lo there, h');
      sr.push('ow');
      expect(sr.text).toBe('Hello there, ');
      sr.push(' are you?\n');
      expect(sr.text).toBe('Hello there, how are you?\n');
      expect(sr.end()).toBe('');
    }
  });

  it('without exact secrets only a key-shaped tail is held: `foo.` goes out while `bar` may still grow into a key', () => {
    const red = createRedactor([]);
    const sr = createStreamRedactor(red.redact, red.maxLength, red.maxSpacedLength);
    sr.push('see foo.bar');
    expect(sr.text).toBe('see foo.');
  });

  it('a key never shows a single character before it is complete, then shows as the marker', () => {
    const red = createRedactor([{ name: 'OPENROUTER_API_KEY', value: key }]);
    const sr = createStreamRedactor(red.redact, red.maxLength, red.maxSpacedLength);
    let seen = '';
    for (const ch of `your key: ${key} is set`) {
      sr.push(ch);
      seen = sr.text;
      expect(seen).not.toContain('sk-');
    }
    sr.end();
    expect(sr.text).toBe('your key: [REDACTED:OPENROUTER_API_KEY] is set');
  });

  it('a header value is held from its anchor until whitespace ends it', () => {
    const red = createRedactor([]);
    const sr = createStreamRedactor(red.redact, red.maxLength, red.maxSpacedLength);
    sr.push('send Authorization: Bea');
    expect(sr.text).toBe('send ');
    sr.push('rer abc.def');
    expect(sr.text).toBe('send ');
    sr.push(' now ');
    expect(sr.text).toBe(`send Authorization: Bearer ${PATTERN_MARKER} now `);
  });

  it('a secret with whitespace is held across words (maxSpacedLength); none of its words shows early', () => {
    const red = createRedactor([{ name: 'DB_PASSWORD', value: 'correct horse battery staple' }]);
    expect(red.maxSpacedLength).toBe(28);
    const sr = createStreamRedactor(red.redact, red.maxLength, red.maxSpacedLength);
    for (const w of ['the ', 'password ', 'is ', 'correct ', 'horse ', 'battery ']) {
      sr.push(w);
      expect(sr.text).not.toContain('correct');
    }
    sr.push('staple, ok ');
    sr.end();
    expect(sr.text).toBe('the password is [REDACTED:DB_PASSWORD], ok ');
  });

  it('control characters never reach the output (BEL, ESC, NUL, DEL, C1)', () => {
    const red = createRedactor([]);
    const sr = createStreamRedactor(red.redact, red.maxLength, red.maxSpacedLength);
    sr.push('a\x07b \x1b[5mblink\x1b[0m \x00\x7f\x9bend ');
    expect(sr.text).toBe('ab [5mblink[0m end ');
  });

  it('reset() (a provider retry) restarts the reply: nothing of the first attempt survives', () => {
    const red = createRedactor([]);
    const sr = createStreamRedactor(red.redact, red.maxLength, red.maxSpacedLength);
    sr.push('first attempt ');
    expect(sr.text).toBe('first attempt ');
    sr.reset();
    expect(sr.text).toBe('');
    sr.push('second');
    sr.end();
    expect(sr.text).toBe('second');
  });
});

describe('Redactor.maxLength / maxSpacedLength', () => {
  it('track the longest exact secret and the longest one containing whitespace, through addSecret and dropSecret', () => {
    const red = createRedactor([{ name: 'A', value: 'abcdefgh' }]);
    expect([red.maxLength, red.maxSpacedLength]).toEqual([8, 0]);
    red.addSecret('B', 'two words here');
    red.addSecret('C', 'x'.repeat(40));
    expect([red.maxLength, red.maxSpacedLength]).toEqual([40, 14]);
    red.dropSecret('C');
    red.dropSecret('B');
    expect([red.maxLength, red.maxSpacedLength]).toEqual([8, 0]);
    expect(createRedactor([]).maxLength).toBe(0);
  });
});
