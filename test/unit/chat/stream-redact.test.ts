/**
 * chat/stream-redact.ts — the live region's append-only, redacted, sanitized view of a streamed chat reply. The
 * property: over random texts built from all eight redacting pattern families, header lines, exact secrets (without
 * whitespace, with interior whitespace, with LEADING whitespace, multi-line PEM-shaped, and one that is a prefix of
 * another), unfinished prefixes of those secrets, control characters and glue, split at random delta boundaries, every
 * intermediate output is a prefix of the final one, the final one is exactly `redact(stripTerminalControls(full))`, and no
 * fragment of a secret the final output redacts is ever shown on the way.
 */
import { describe, expect, it } from 'vitest';
import { createStreamRedactor, type StreamRedactor } from '../../../src/chat/stream-redact.js';
import { createRedactor, MIN_SECRET_LENGTH, PATTERN_MARKER, type Redactor } from '../../../src/core/redact.js';
import { stripTerminalControls } from '../../../src/core/ansi.js';

/** the stream redactor the session builds: the redactor's own `redact` and `pendingSecretStart` */
function streamOf(red: Redactor): StreamRedactor {
  return createStreamRedactor(red.redact, (s) => red.pendingSecretStart(s));
}

/** `pendingSecretStart` by its definition, over the values the redactor keeps (≥ MIN_SECRET_LENGTH) */
function brutePending(values: readonly string[], s: string): number {
  const kept = values.filter((v) => v.length >= MIN_SECRET_LENGTH);
  for (let i = 0; i < s.length; i++) {
    const tail = s.slice(i);
    if (kept.some((v) => v.length > tail.length && v.startsWith(tail))) return i;
  }
  return s.length;
}

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
  // leading whitespace: right after a header value its marker would glue onto the value (the header rule keeps it open)
  const lead = `${pick(r, [' ', '\n', '\t'])}Zl7${chars(r, `${ALNUM}+/`, 6, 20)}`;
  // a PEM-shaped block: multi-line, starts with `-` (ordinary prose has dashes too), longer than anything else here
  const pemLines: string[] = [];
  for (let k = 0, n = 1 + Math.floor(r() * 4); k < n; k++) pemLines.push(chars(r, `${ALNUM}+/`, 8, 64));
  const pem = `-----BEGIN Zk6 PRIVATE KEY-----\n${pemLines.join('\n')}\n-----END PRIVATE KEY-----`;
  // a secret that is a proper prefix of another: the longer one claims first, the shorter one is still pending inside it
  const short = plain.slice(0, MIN_SECRET_LENGTH + Math.floor(r() * (plain.length - MIN_SECRET_LENGTH)));
  const secrets = [
    { name: 'DB_PASSWORD', value: spaced },
    { name: 'generator.apiKey', value: plain },
    { name: 'LEAD_TOKEN', value: lead },
    { name: 'FIREBASE_PRIVATE_KEY', value: pem },
    { name: 'SHORT_KEY', value: short },
  ];
  const fragments = [plain.slice(0, 6), spaced.slice(0, 5), lead.slice(1, 6), pem.slice(0, 16)];
  const parts: string[] = [];
  const count = 4 + Math.floor(r() * 14);
  for (let i = 0; i < count; i++) {
    const kind = r();
    if (kind < 0.24) parts.push(pick(r, WORDS));
    else if (kind < 0.27) parts.push(pick(r, ['-', '--', '-----', '- item', '-----BEGIN', '-----BEGIN Zk6 PRIVATE', ' Zl', short]));
    else if (kind < 0.3) {
      // an unfinished prefix of a secret that the next part diverges from: held, then released unredacted
      const v = pick(r, [plain, spaced, lead, pem]);
      parts.push(v.slice(0, 1 + Math.floor(r() * (v.length - 1))));
    } else if (kind < 0.5) {
      const key = pick(r, FAMILIES)(r);
      parts.push(key);
      // the body right after the family prefix: redacted unless glue blocks the lookbehind
      fragments.push(key.slice(0, Math.min(key.length, 14)));
    } else if (kind < 0.6) {
      const tok = chars(r, `${ALNUM}._~+/`, 6, 30);
      const header = pick(r, [`Authorization: Bearer ${tok}`, `authorization:\n  bearer   ${tok}`, `x-api-key: ${tok}`, `X-API-KEY:${tok}`, `Authorization: Basic ${tok}`]);
      // sometimes glued to a secret that begins with or spans whitespace: its marker eats the whitespace that would have
      // closed the value, which then runs on to the next whitespace
      parts.push(r() < 0.3 ? `${header}${pick(r, [lead, spaced, pem, plain])}` : header);
    } else if (kind < 0.67) parts.push(plain);
    else if (kind < 0.74) parts.push(spaced);
    else if (kind < 0.78) parts.push(lead);
    else if (kind < 0.81) parts.push(pem);
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
    // FUZZ_SEEDS=20000 (with --testTimeout=900000) for a longer run; 20,000 seeds passed when this was written
    for (let seed = 1; seed <= Number(process.env['FUZZ_SEEDS'] ?? 600); seed++) {
      const c = makeCase(seed);
      const red = createRedactor(c.secrets);
      const expected = red.redact(stripTerminalControls(c.text));
      const values = c.secrets.map((x) => x.value);
      for (const variant of ['redactor', 'reference'] as const) {
        // the redactor's own pendingSecretStart, and the definition itself (brute force) as a cross-check
        const sr = variant === 'redactor' ? streamOf(red) : createStreamRedactor(red.redact, (s) => brutePending(values, s));
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
      const sr = streamOf(red);
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
    const sr = streamOf(red);
    sr.push('see foo.bar');
    expect(sr.text).toBe('see foo.');
  });

  it('a key never shows a single character before it is complete, then shows as the marker', () => {
    const red = createRedactor([{ name: 'OPENROUTER_API_KEY', value: key }]);
    const sr = streamOf(red);
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
    const sr = streamOf(red);
    sr.push('send Authorization: Bea');
    expect(sr.text).toBe('send ');
    sr.push('rer abc.def');
    expect(sr.text).toBe('send ');
    sr.push(' now ');
    expect(sr.text).toBe(`send Authorization: Bearer ${PATTERN_MARKER} now `);
  });

  it('a secret with whitespace is held across words while the tail is a prefix of it; none of its words shows early', () => {
    const red = createRedactor([{ name: 'DB_PASSWORD', value: 'correct horse battery staple' }]);
    const sr = streamOf(red);
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
    const sr = streamOf(red);
    sr.push('a\x07b \x1b[5mblink\x1b[0m \x00\x7f\x9bend ');
    // escape sequences go WHOLE (core/ansi.ts): no ESC and no `[5m` body is left behind
    expect(sr.text).toBe('ab blink end ');
    expect(sr.text).not.toMatch(/\x1b|\[\d*m/);
  });

  it('an escape sequence split between two deltas is held, never shown half-stripped', () => {
    const red = createRedactor([]);
    const sr = streamOf(red);
    sr.push('ok \x1b[3');
    sr.push('3mwarn\x1b[0m done ');
    sr.push('tail \x1b[');
    sr.end();
    expect(sr.text).toBe('ok warn done tail ');
  });

  it('reset() (a provider retry) restarts the reply: nothing of the first attempt survives', () => {
    const red = createRedactor([]);
    const sr = streamOf(red);
    sr.push('first attempt ');
    expect(sr.text).toBe('first attempt ');
    sr.reset();
    expect(sr.text).toBe('');
    sr.push('second');
    sr.end();
    expect(sr.text).toBe('second');
  });
});

describe('createStreamRedactor — a long secret with newlines does not stall the stream', () => {
  /** the shape `util.parseEnv` hands over for a double-quoted FIREBASE_PRIVATE_KEY: real newlines, ~1.7 KB */
  function pemKey(): string {
    const r = rng(42);
    const lines: string[] = [];
    for (let i = 0; i < 26; i++) lines.push(chars(r, `${ALNUM}+/`, 64, 64));
    return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
  }
  const orKey = 'sk-or-v1-0123456789abcdef0123456789abcdef';
  const reply =
    'Sure. The build failed because the test runner could not find its config file; the path in package.json points at ' +
    'a directory that was renamed last week. Update the "test" script to use the new location, then run the suite again - ' +
    'it should pass. If it does not, paste the first error here.\n';

  it('a prose reply pushed 4 characters at a time is released word by word (all of it before end()), with a 1.7 KB PEM configured', () => {
    const pem = pemKey();
    expect(pem.length).toBeGreaterThan(1700);
    const red = createRedactor([
      { name: 'OPENROUTER_API_KEY', value: orKey },
      { name: 'FIREBASE_PRIVATE_KEY', value: pem },
    ]);
    const sr = streamOf(red);
    let pushed = '';
    for (let i = 0; i < reply.length; i += 4) {
      pushed += reply.slice(i, i + 4);
      sr.push(reply.slice(i, i + 4));
      // everything up to the last whitespace is out (a trailing `-` may wait one delta: the PEM starts with one)
      const boundary = Math.max(pushed.lastIndexOf(' '), pushed.lastIndexOf('\n')) + 1;
      const wanted = pushed.slice(0, boundary).replace(/-\s*$/, '');
      expect(reply.startsWith(sr.text)).toBe(true);
      expect(sr.text.length).toBeGreaterThanOrEqual(wanted.length);
    }
    expect(sr.text).toBe(reply);
    expect(sr.end()).toBe('');
  });

  it('the PEM itself never shows a character, then shows as its marker', () => {
    const pem = pemKey();
    const red = createRedactor([{ name: 'FIREBASE_PRIVATE_KEY', value: pem }]);
    const sr = streamOf(red);
    const text = `the key is:\n${pem}done.\n`;
    for (let i = 0; i < text.length; i += 4) {
      sr.push(text.slice(i, i + 4));
      expect(sr.text).not.toContain('-----');
      expect(sr.text.replace('[REDACTED:FIREBASE_PRIVATE_KEY]', '')).not.toContain('PRIVATE');
    }
    sr.end();
    expect(sr.text).toBe('the key is:\n[REDACTED:FIREBASE_PRIVATE_KEY]done.\n');
  });

  it('a secret that begins with whitespace right after a header value: the live text stays a prefix of the final one', () => {
    const red = createRedactor([{ name: 'LEAD_TOKEN', value: ' Zl7secretvalue' }]);
    const text = 'use x-api-key: abc Zl7secretvalue and go ';
    const expected = red.redact(text);
    expect(expected).toBe(`use x-api-key: ${PATTERN_MARKER} and go `);
    const sr = streamOf(red);
    for (const ch of text) {
      sr.push(ch);
      expect(expected.startsWith(sr.text), JSON.stringify(sr.text)).toBe(true);
    }
    sr.end();
    expect(sr.text).toBe(expected);
  });
});

describe('Redactor.pendingSecretStart', () => {
  it('is the earliest start of a non-empty proper prefix of an exact secret, else the length', () => {
    const red = createRedactor([{ name: 'A', value: 'abcdefgh' }]);
    expect(red.pendingSecretStart('')).toBe(0);
    expect(red.pendingSecretStart('xyz')).toBe(3);
    expect(red.pendingSecretStart('xyz a')).toBe(4);
    expect(red.pendingSecretStart('xyz abcdefg')).toBe(4);
    // a complete occurrence is not pending (the straddle check owns it); nor is a tail that diverged
    expect(red.pendingSecretStart('xyz abcdefgh')).toBe(12);
    expect(red.pendingSecretStart('xyz abcx')).toBe(8);
    // the earliest start wins across secrets, and a secret shorter than MIN_SECRET_LENGTH is never pending
    red.addSecret('B', 'zabcdefghij');
    expect(red.pendingSecretStart('zabcdefgh')).toBe(0);
    expect(red.addSecret('C', 'short')).toBe(false);
    expect(red.pendingSecretStart('xx shor')).toBe(7);
    red.dropSecret('B');
    red.dropSecret('A');
    expect(red.pendingSecretStart('xyz abcdefg')).toBe(11);
    expect(createRedactor([]).pendingSecretStart('anything')).toBe(8);
  });

  it('agrees with its definition over random strings built from the secrets\' own characters', () => {
    const r = rng(7);
    for (let round = 0; round < 300; round++) {
      const values = [chars(r, 'ab \n', 8, 20), chars(r, 'ab-', 8, 30), `-${chars(r, 'ab\n', 7, 40)}`];
      const red = createRedactor(values.map((value, i) => ({ name: `S${i}`, value })));
      for (let k = 0; k < 10; k++) {
        const s = chars(r, 'ab- \n', 0, 50);
        expect(red.pendingSecretStart(s), `${JSON.stringify(values)} / ${JSON.stringify(s)}`).toBe(brutePending(values, s));
      }
    }
  });
});
