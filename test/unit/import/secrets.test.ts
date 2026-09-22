/**
 * src/import/secrets.ts (IMPORT-DESIGN §4.4.2 rules 1–3 + 8, §4.4.3 group I, §4.8.1 invariants
 * 1–2, §8.2 **R9**, §6 group D rows 38, 42, 45, 46, 47).
 *
 * The load-bearing test is the property one: over 200 pseudo-random values, **no substring of
 * length ≥ 4 of a value appears anywhere in the serialised `ValueShape`**. That is the structural
 * half of §1 property 4 for the value path — the leak gate is the other half.
 */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../src/core/hash.js';
import { MIN_SECRET_LENGTH, SECRET_NAME_RE } from '../../../src/core/redact.js';
import {
  BAND_MIN_LENGTH,
  ENTROPY_BAND_BITS,
  KNOWN_SECRET_PATHS,
  NON_SECRET_LEAF_NAMES,
  charsetOf,
  classifyValue,
  entropyBits,
  inBand,
  isAllowlistedLeaf,
  isEnvReference,
  joinSecretVerdict,
  matchesPath,
  referenceName,
  shapeOf,
} from '../../../src/import/secrets.js';

/** A seeded xorshift so the property test is deterministic across runs and platforms (§8.2 R9). */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';

function randomValues(n: number, seed = 0x5eed_1234): string[] {
  const rnd = prng(seed);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const len = 8 + Math.floor(rnd() * 56);
    let s = '';
    for (let j = 0; j < len; j++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)] ?? 'a';
    out.push(s);
  }
  return out;
}

describe('shapeOf retains no substring of the value (§4.8.1 invariant 1)', () => {
  it('no 4-character window of any of 200 values appears in its serialised shape', () => {
    const values = randomValues(200);
    expect(new Set(values).size).toBe(200);
    for (const v of values) {
      const serialised = JSON.stringify(shapeOf(v));
      for (let i = 0; i + 4 <= v.length; i++) {
        const window = v.slice(i, i + 4);
        expect(serialised.includes(window), `"${window.replace(/./g, '*')}" (offset ${i}, length ${v.length}) leaked`).toBe(false);
      }
    }
  });

  it('the shape is only ever seven scalar fields', () => {
    expect(Object.keys(shapeOf('abcdefghijklmnop')).sort()).toEqual(['charset', 'entropyBucket', 'family', 'fingerprint', 'length', 'reference']);
  });

  it('§8.2 R9 — the fingerprint is sha256[0..8] and is stable across calls', () => {
    const v = 'a7f3b2c1d4e5f60718293a4b5c6d7e8f';
    expect(shapeOf(v).fingerprint).toBe(sha256Hex(v).slice(0, 8));
    expect(shapeOf(v).fingerprint).toBe(shapeOf(v).fingerprint);
    expect(shapeOf(v).fingerprint).toHaveLength(8);
    expect(shapeOf(`${v}x`).fingerprint).not.toBe(shapeOf(v).fingerprint);
  });

  it('records the family when a redacting pattern recognises the value', () => {
    expect(shapeOf(`ghp_${'A'.repeat(36)}`).family).toBe('github');
    expect(shapeOf(`sk-ant-${'a'.repeat(30)}`).family).toBe('anthropic');
    expect(shapeOf('z-ai/glm-5.3-flash').family).toBe(null);
  });
});

describe('charsetOf and entropyBits', () => {
  it('names the six charsets', () => {
    expect(charsetOf('deadbeef0123')).toBe('hex');
    expect(charsetOf('Abc123xyzQ')).toBe('alnum');
    expect(charsetOf('a-b_c123XYZ')).toBe('base64url');
    expect(charsetOf('z-ai/glm 5.3')).toBe('ascii');
    expect(charsetOf('naïve-héllo')).toBe('mixed');
    expect(charsetOf('a\u0000b')).toBe('other');
    expect(charsetOf('')).toBe('other');
  });

  it('is Shannon entropy in bits per character', () => {
    expect(entropyBits('')).toBe(0);
    expect(entropyBits('aaaaaaaa')).toBe(0);
    expect(entropyBits('abab')).toBeCloseTo(1, 10);
    expect(entropyBits('abcd')).toBeCloseTo(2, 10);
    expect(entropyBits('a7f3b2c1d4e5f60718293a4b5c6d7e8f')).toBeGreaterThan(ENTROPY_BAND_BITS);
  });

  it('buckets low / medium / high', () => {
    expect(shapeOf('aaaaaaaaaaaaaaaaaaaaaaaa').entropyBucket).toBe('low');
    expect(shapeOf('a7f3b2c1d4e5f60718293a4b5c6d7e8f').entropyBucket).toBe('high');
  });
});

describe('§4.4.2 rule 4 / §4.8.3 — env references', () => {
  it('recognises every reference syntax as a whole value, and nothing else', () => {
    const table: [string, string | null][] = [
      ['${GITHUB_TOKEN}', 'GITHUB_TOKEN'],
      // a default-value form is not a *pure* reference: it carries a literal (see below)
      ['${GITHUB_TOKEN:-default}', null],
      ['${GITHUB_TOKEN:default}', null],
      ['${env:GITHUB_TOKEN}', 'GITHUB_TOKEN'],
      ['{env:GITHUB_TOKEN}', 'GITHUB_TOKEN'],
      ['$GITHUB_TOKEN', 'GITHUB_TOKEN'],
      ['%GITHUB_TOKEN%', 'GITHUB_TOKEN'],
      ['Bearer ${GITHUB_TOKEN}', null],
      ['ghp_abcdefghij', null],
      ['', null],
    ];
    for (const [value, want] of table) {
      expect(referenceName(value), value).toBe(want);
      expect(isEnvReference(value), value).toBe(want !== null);
    }
  });

  it('a reference is never a secret, whatever its path (§4.4.3 group I false example)', () => {
    const v = classifyValue('mcpServers.x.env.OPENROUTER_API_KEY', 'OPENROUTER_API_KEY', '${OPENROUTER_API_KEY}');
    expect(v).toMatchObject({ secret: false, band: false, rule: 4 });
    expect(v.shape?.reference).toBe(true);
  });

  // review, lower — `${VAR:-<literal>}` was a *pure* reference, so it bypassed rules 1, 2 and the band
  it('a default-value form carries a literal, so it is not the free pass rule 4 gives a pure reference', () => {
    const withDefault = '${TOKEN:-sk-ant-api03-0123456789012345678901234567890123456789}';
    expect(referenceName(withDefault)).toBe(null);
    expect(isEnvReference(withDefault)).toBe(false);
    expect(shapeOf(withDefault).reference).toBe(false);
    // …and the literal inside it is now reachable by the rules that catch literals
    expect(classifyValue('mcpServers.x.env.TOKEN', 'TOKEN', withDefault)).toMatchObject({ secret: true, rule: 3 });
    expect(classifyValue('a.myToken', 'myToken', '${MY_TOKEN:-hunter2hunter2}')).toMatchObject({ secret: true, rule: 2 });
    // the forms that carry no literal at all are still pure references
    for (const pure of ['${TOKEN}', '${env:TOKEN}', '{env:TOKEN}', '$TOKEN', '%TOKEN%']) {
      expect(referenceName(pure), pure).toBe('TOKEN');
    }
  });
});

describe('§4.4.2 rules 1–3 and the band', () => {
  it('rule 1 — the known-secret set', () => {
    expect(classifyValue('env.ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'x'.repeat(40))).toMatchObject({ secret: true, rule: 1 });
    expect(classifyValue('awsCredentialExport', 'awsCredentialExport', '/bin/creds')).toMatchObject({ secret: true, rule: 1 });
    expect(matchesPath('headers.Authorization', KNOWN_SECRET_PATHS)).toBe(true);
    expect(matchesPath('headers.Accept', KNOWN_SECRET_PATHS)).toBe(false);
  });

  it('rule 2 — SECRET_NAME_RE on the leaf plus MIN_SECRET_LENGTH on the value', () => {
    expect(SECRET_NAME_RE.test('myToken')).toBe(true);
    expect(classifyValue('a.myToken', 'myToken', 'x'.repeat(MIN_SECRET_LENGTH))).toMatchObject({ secret: true, rule: 2 });
    expect(classifyValue('a.myToken', 'myToken', 'x'.repeat(MIN_SECRET_LENGTH - 1)).rule).not.toBe(2);
    expect(classifyValue('a.myToken', 'myToken', 42)).toMatchObject({ secret: false, shape: null });
  });

  it('rule 3 — a family fires before the band (§4.4.2)', () => {
    const v = classifyValue('a.clientCode', 'clientCode', `ghp_${'A'.repeat(36)}`);
    expect(v).toMatchObject({ secret: true, band: false, rule: 3 });
  });

  it('rule 8 — the band predicate and its allowlist (§6 rows 45, 47)', () => {
    const banded = classifyValue('a.clientId', 'clientId', 'a7f3b2c1d4e5f60718293a4b5c6d7e8f');
    expect(banded).toMatchObject({ secret: false, band: true, rule: 8 });
    for (const name of NON_SECRET_LEAF_NAMES) {
      expect(isAllowlistedLeaf(name), name).toBe(true);
      expect(classifyValue(`x.${name}`, name, '9f8e7d6c5b4a39281706f5e4d3c2b1a0998877665544332211ffeeddccbbaa99').band, name).toBe(false);
    }
    // just under the length floor, and the wrong charset, both stay out of the band
    expect(inBand('clientId', 'a'.repeat(BAND_MIN_LENGTH - 1))).toBe(false);
    expect(inBand('clientId', 'this is a sentence with spaces in it')).toBe(false);
  });

  // review, lower — the floor was the *medium bucket* (2.5 b/c); the design says 3.2, and
  // `ENTROPY_BAND_BITS` was declared and never read
  it('rule 8’s entropy floor is ENTROPY_BAND_BITS (3.2 b/c), not the medium bucket (2.5)', () => {
    expect(ENTROPY_BAND_BITS).toBe(3.2);
    // 24 chars over 8 distinct symbols, uniform ⇒ exactly 3.0 b/c: medium bucket, below the floor
    const belowFloor = 'abcdefghabcdefghabcdefgh';
    expect(entropyBits(belowFloor)).toBeCloseTo(3.0, 10);
    expect(shapeOf(belowFloor)).toMatchObject({ charset: 'alnum', entropyBucket: 'medium', length: 24 });
    expect(inBand('clientId', belowFloor), '3.0 b/c is below the 3.2 floor').toBe(false);
    expect(classifyValue('a.clientId', 'clientId', belowFloor)).toMatchObject({ band: false, rule: 9 });

    // 20 chars over 10 distinct symbols ⇒ 3.3219 b/c: still the medium bucket, but above the floor
    const aboveFloor = 'abcdefghijabcdefghij';
    expect(entropyBits(aboveFloor)).toBeGreaterThan(ENTROPY_BAND_BITS);
    expect(shapeOf(aboveFloor).entropyBucket, 'the bucket cannot decide this on its own').toBe('medium');
    expect(inBand('clientId', aboveFloor)).toBe(true);
    expect(classifyValue('a.clientId', 'clientId', aboveFloor)).toMatchObject({ band: true, rule: 8 });
  });
});

describe('§4.4.3 group I — the decision joiner promotes and never demotes (§6 row 46)', () => {
  const codeSecret = { secret: true, band: false, rule: 2, why: 'key rule 2' };
  const codeBand = { secret: false, band: true, rule: 8, why: 'key rule 8 (band)' };
  const codeConfig = { secret: false, band: false, rule: 9, why: 'key rule 9 (config)' };

  it('a code secret stays a secret whatever Jev says', () => {
    for (const p of [null, 0, 0.1, 0.49, 0.5, 0.99]) expect(joinSecretVerdict(codeSecret, p).secret, String(p)).toBe(true);
    expect(joinSecretVerdict(codeSecret, 0).why).toBe('key rule 2');
  });

  it('a band item with no Jev answer is a secret — the conservative side (§0 principle 4)', () => {
    const v = joinSecretVerdict(codeBand, null);
    expect(v.secret).toBe(true);
    expect(v.why).toContain('code fallback (jev unavailable)');
  });

  it('a band item is promoted at p ≥ 0.5 and left alone below it', () => {
    expect(joinSecretVerdict(codeBand, 0.5).secret).toBe(true);
    expect(joinSecretVerdict(codeBand, 0.82).why).toContain('p=0.82');
    expect(joinSecretVerdict(codeBand, 0.49).secret).toBe(false);
  });

  it('a non-band, non-secret key is never touched by Jev', () => {
    expect(joinSecretVerdict(codeConfig, 0.99)).toEqual(codeConfig);
  });

  it('never leaks a value through the why string', () => {
    const value = 'a7f3b2c1d4e5f60718293a4b5c6d7e8f';
    const code = classifyValue('a.clientId', 'clientId', value);
    for (const p of [null, 0.9]) expect(joinSecretVerdict(code, p).why).not.toContain(value.slice(0, 5));
  });
});
