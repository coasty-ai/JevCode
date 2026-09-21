/**
 * TUI-DESIGN §19.0 (`spinner.test.ts` / `retry.test.ts` row, §7.4, §13.2, §14.2): the spinner runs only while a
 * stage runs and no review is pending, `|/-\` in ASCII, the static glyph under reduced motion, `still waiting`
 * after 45 s; the retry row model (`jev: retrying 2/3 in 12 s · HTTP 429 rate limited (Retry-After)    [r] retry
 * now`, the `last:` cause row only when the cause changed, Retry-After capped at 60 s, offline copy), and the
 * 1 Hz ticker; `setInterval(` appears in `src/tui/**` only in spinner.ts and retry.ts.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS, STILL_WAITING_MS, elapsedSeconds, spinnerActive, spinnerGlyph, stillWaiting } from '../../../src/tui/spinner.js';
import { RETRY_AFTER_CAP_S, retryCauseText, retryLastRow, retryLiveLines, retryRow, retryViewFrom, secondsLeft, startTicker, type RetryView } from '../../../src/tui/retry.js';
import { GLYPHS } from '../../../src/tui/glyphs.js';
import { mkConfirmRequest, mkStatus } from '../../fixtures/tui/fixtures.js';

const base = { run: 'live' as const, status: mkStatus(3, 'propose'), pendingReview: null, overlay: 'none' as const, blocking: null };

describe('spinner (§7.4, A50)', () => {
  it('8 fps braille frames only while a stage runs and no review is pending; ASCII and reduced-motion twins', () => {
    expect(SPINNER_INTERVAL_MS).toBe(125);
    expect(SPINNER_FRAMES).toEqual(GLYPHS.unicode.spinner);
    expect(spinnerActive(base)).toBe(true);
    expect(spinnerActive({ ...base, pendingReview: mkConfirmRequest() })).toBe(false);
    expect(spinnerActive({ ...base, overlay: 'review' })).toBe(false);
    expect(spinnerActive({ ...base, run: 'none' })).toBe(false);
    expect(spinnerActive({ ...base, run: 'aborting' })).toBe(false);
    expect(spinnerActive({ ...base, run: 'starting', status: null })).toBe(true);
    expect(spinnerActive({ ...base, status: mkStatus(3, 'idle') })).toBe(false);
    expect(spinnerActive({ ...base, blocking: { id: 'b' } })).toBe(false);
    expect(spinnerGlyph(2)).toBe('⠹');
    expect(spinnerGlyph(12)).toBe(SPINNER_FRAMES[2]);
    expect(spinnerGlyph(1, GLYPHS.ascii)).toBe('/');
    expect(spinnerGlyph(5, GLYPHS.unicode, true)).toBe(GLYPHS.unicode.spinnerStatic);
    expect(spinnerGlyph(5, GLYPHS.ascii, true)).toBe(GLYPHS.ascii.spinnerStatic);
    expect(spinnerGlyph(Number.NaN)).toBe(SPINNER_FRAMES[0]);
  });

  it('still waiting after 45 s in one stage; elapsed seconds', () => {
    expect(STILL_WAITING_MS).toBe(45_000);
    expect(stillWaiting(0, 44_999)).toBe(false);
    expect(stillWaiting(0, 45_000)).toBe(true);
    expect(stillWaiting(null, 99_000)).toBe(false);
    expect(elapsedSeconds(1000, 62_500)).toBe(61);
  });
});

describe('retry row (§13.2, §24)', () => {
  const view: RetryView = { side: 'jev', attempt: 2, maxAttempts: 3, untilMs: 12_000, cause: { kind: 'http', status: 429, code: null, message: 'rate limited' }, lastCause: null, retryAfter: true };

  it('renders the §24 row with the countdown and the right-aligned [r] hint; the cause row only when the cause changed', () => {
    const row = retryRow(view, 0, 80);
    expect(row).toMatch(/^jev: retrying 2\/3 in 12 s · HTTP 429 rate limited \(Retry-After\) +\[r\] retry now$/);
    expect(row.length).toBe(80);
    expect(retryRow(view, 5000, 80)).toContain('in 7 s');
    expect(retryRow({ ...view, side: 'generator', cause: { kind: 'http', status: 529, code: null, message: 'overloaded' }, retryAfter: false }, 0, 80)).toContain('generator: retrying 2/3 in 12 s · HTTP 529 overloaded');
    expect(retryLastRow(view, 80)).toBeNull();
    const changed: RetryView = { ...view, lastCause: { kind: 'http', status: 529, code: null, message: 'overloaded · request-id gen-abc123' } };
    expect(retryLastRow(changed, 80)).toBe('last: HTTP 529 overloaded · request-id gen-abc123');
    expect(retryLastRow({ ...view, lastCause: view.cause }, 80)).toBeNull();
    expect(retryLiveLines(changed, 0, 2, 80)).toHaveLength(2);
    expect(retryLiveLines(changed, 0, 1, 80)).toHaveLength(1);
    expect(retryLiveLines(changed, 0, 0, 80)).toEqual([]);
    // narrow: the [r] hint drops before the text is cut
    const narrow = retryRow(view, 0, 50);
    expect(narrow.length).toBeLessThanOrEqual(50);
  });

  it('Retry-After is shown capped at 60 s; the offline copy names the host only', () => {
    expect(RETRY_AFTER_CAP_S).toBe(60);
    expect(retryRow({ ...view, untilMs: 600_000 }, 0, 100)).toContain('in 60 s');
    expect(retryRow({ ...view, untilMs: 600_000, retryAfter: false }, 0, 100)).toContain('in 600 s');
    expect(retryCauseText({ kind: 'network', status: null, code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND openrouter.ai/api/v1/chat' })).toBe('offline: DNS lookup failed for openrouter.ai');
    expect(retryCauseText({ kind: 'network', status: null, code: 'ECONNREFUSED', message: 'connect ECONNREFUSED api.anthropic.com:443' })).toBe('offline: cannot reach api.anthropic.com:443');
    expect(retryCauseText({ kind: 'timeout', status: null, code: null, message: 'openrouter.ai' })).toBe('no response from openrouter.ai in 10 s');
    expect(retryCauseText({ kind: 'http', status: 429, code: null, message: '' }, true)).toBe('HTTP 429 rate limited (Retry-After)');
    expect(secondsLeft(5000, 2500)).toBe(3);
    expect(secondsLeft(1000, 5000)).toBe(0);
  });

  it('retryViewFrom carries the previous cause as lastCause for the same side only', () => {
    const e = { side: 'jev' as const, info: { attempt: 2, maxAttempts: 3, waitMs: 8000, retryAfter: false, cause: { kind: 'http' as const, status: 529, code: null, message: 'x' } } };
    const v = retryViewFrom(e, view, 100);
    expect(v).toMatchObject({ attempt: 2, untilMs: 8100, lastCause: view.cause, retryAfter: false });
    expect(retryViewFrom({ ...e, side: 'generator' }, view, 100).lastCause).toBeNull();
  });

  it('startTicker uses one unref\'d interval and stops', async () => {
    let n = 0;
    const stop = startTicker(() => (n += 1), 5);
    await new Promise((r) => setTimeout(r, 30));
    stop();
    const seen = n;
    expect(seen).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 15));
    expect(n).toBe(seen);
  });
});

describe('§14.2 source scan: setInterval only in spinner.ts and retry.ts; no useFocus; no process.stdout.rows/columns outside plain.ts', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(e)) out.push(p);
    }
    return out;
  }
  const files = walk(join(process.cwd(), 'src', 'tui'));
  it('setInterval(', () => {
    const offenders = files.filter((f) => /setInterval\(/.test(readFileSync(f, 'utf8')) && !/\/(spinner|retry)\.ts$/.test(f));
    expect(offenders).toEqual([]);
  });
  it('useFocus', () => {
    const offenders = files.filter((f) => /\buseFocus(Manager)?\b/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
  it('process.stdout.rows/columns', () => {
    const offenders = files.filter((f) => /process\.stdout\.(rows|columns)/.test(readFileSync(f, 'utf8')) && !/plain\.ts$/.test(f));
    expect(offenders).toEqual([]);
  });
  it('one useInput and one usePaste, both in App.tsx', () => {
    const uses = files.filter((f) => /\buseInput\(|\busePaste\(/.test(readFileSync(f, 'utf8')));
    expect(uses.map((f) => f.split('/').at(-1))).toEqual(['App.tsx']);
    const app = readFileSync(join(process.cwd(), 'src', 'tui', 'App.tsx'), 'utf8');
    expect(app.match(/\buseInput\(/g)).toHaveLength(1);
    expect(app.match(/\busePaste\(/g)).toHaveLength(1);
    expect(app.match(/\buseCursor\(/g)).toHaveLength(1);
  });
});
