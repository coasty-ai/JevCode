/**
 * src/core/ansi.ts against REAL outputs captured through src/sandbox/run.ts (fixtures/terminal-output.json): vitest 5
 * colours into a pipe whenever TERM is not `dumb` (tinyrainbow ignores isatty), pytest under `addopts = --color=yes`,
 * `git -c color.ui=always`, `tput`, curl's progress meter, a tqdm-style bar, and a script with OSC 8 / DCS / C1 / NUL /
 * backspaces / wide and bidi text / a 5000-char line.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { binaryOutputNote, cleanCommandOutput, cleanCommandStreams, createTerminalStreamSanitizer, ESC_SEQ_RE, looksBinary, resolveOverwrites, stripAnsi, stripTerminalControls, STREAM_HOLD_MAX } from '../../../src/core/ansi.js';
import { patternRedact } from '../../../src/core/redact.js';
import { budgetMs } from '../helpers/perf-budget.js';

interface Fixtures {
  vitestColored: { text: string; chunks: string[] };
  vitestNoColor: string;
  pytestColorYes: string;
  pytestNoColor: string;
  gitColor: string;
  tput: string;
  script: string;
  curlProgress: string;
  tqdmProgress: { stdout: string; stderr: string };
}
const FX = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/terminal-output.json'), 'utf8')) as Fixtures;
/** timings and clock times differ between two runs of one suite; the layout does not */
const digitsOff = (s: string): string => s.replace(/\d+/g, '#');
/** anything that looks like the body of an SGR / CSI left behind by an ESC-only strip */
const REMNANT_RE = /\u001b|\u009b|\[[0-9;?]+[A-Za-z]|\(B\[m|\](?:0|2|8|52);/;

function streamed(parts: readonly string[]): string {
  const s = createTerminalStreamSanitizer();
  return parts.map((p) => s.push(p)).join('') + s.flush();
}

describe('stripTerminalControls / stripAnsi: whole sequences, never their bodies', () => {
  it('the user-reported line: vitest 5 slow-test tick loses its SGR entirely', () => {
    const raw = '     \u001b[33m\u001b[2m✓\u001b[22m\u001b[39m the parent kills a child whose alarm cannot fire (SIGALRM blocked) after timeout';
    expect(stripTerminalControls(raw)).toBe('     ✓ the parent kills a child whose alarm cannot fire (SIGALRM blocked) after timeout');
  });

  it('colored vitest output stripped IS the NO_COLOR output (same run layout, digits aside)', () => {
    expect(digitsOff(cleanCommandOutput(FX.vitestColored.text))).toBe(digitsOff(FX.vitestNoColor));
  });

  it('pytest --color=yes stripped IS the plain pytest output (digits aside)', () => {
    expect(digitsOff(cleanCommandOutput(FX.pytestColorYes))).toBe(digitsOff(FX.pytestNoColor));
  });

  it('no fixture keeps an ESC or an SGR/CSI/OSC body after the strip', () => {
    for (const text of [FX.vitestColored.text, FX.pytestColorYes, FX.gitColor, FX.tput, FX.script]) {
      expect(stripTerminalControls(text)).not.toMatch(REMNANT_RE);
      expect(cleanCommandOutput(text)).not.toMatch(REMNANT_RE);
    }
  });

  it('tput sgr0 (`ESC ( B ESC [ m`, an nF charset reset + CSI) and git color.ui=always', () => {
    expect(cleanCommandOutput(FX.tput)).toBe('red\nexit=0\nTERM=xterm-256color\n');
    expect(cleanCommandOutput(FX.gitColor)).toContain('diff --git a/build.sh b/build.sh\nnew file mode 100755');
  });

  it('OSC 8 hyperlinks, an OSC title (BEL), a DCS string, 8-bit C1 CSI, NUL and binary bytes', () => {
    const out = cleanCommandOutput(FX.script);
    expect(out).toContain('\nlink text and title end\n');
    expect(out).toContain('\nbefore' + 'after\n');
    expect(out).toContain('\nC1 red\n');
    expect(out).toContain('\nnul::bin:��:end\n');
  });

  it('keeps what is text: tabs, wide and combining characters, emoji, a 5000-char line', () => {
    const out = cleanCommandOutput(FX.script);
    expect(out).toContain('wide: 漢字テスト 🚀 é');
    expect(out).toContain('x'.repeat(5000));
    expect(cleanCommandOutput('a\tb\n')).toBe('a\tb\n');
  });

  it('a sequence cut off by the end of the text or a line break is dropped, not half-kept', () => {
    expect(stripAnsi('ok \u001b[3')).toBe('ok ');
    expect(stripAnsi('ok \u001b[31\nnext')).toBe('ok \nnext');
    expect(stripAnsi('\u001b]8;;https://x.test/unterminated\nnext line')).toBe('\nnext line');
  });

  it('a stray OSC introducer hides at most the rest of its line', () => {
    expect(stripAnsi('a\u001b]not really\nb\nc')).toBe('a\nb\nc');
  });
});

describe('resolveOverwrites / cleanCommandOutput: what a terminal leaves on the line', () => {
  it("curl's progress meter (CR redraws on stderr, in a pipe) keeps its final state only", () => {
    const lines = cleanCommandOutput(FX.curlProgress).split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[2]).toMatch(/^100 {2}150k {2}100 {2}150k/);
  });

  it('a tqdm-style bar of 21 redraws is one line', () => {
    expect(cleanCommandOutput(FX.tqdmProgress.stderr)).toBe('100%|####################| 100/100 [00:00<00:00, 999.0it/s]\n');
    expect(FX.tqdmProgress.stderr.length).toBeGreaterThan(1000);
  });

  it('cargo-style `\\r ESC[K` redraws, backspace spinners and CRLF', () => {
    const out = cleanCommandOutput(FX.script);
    expect(out).toContain('   Compiling foo v0.1.0\n    Finished dev profile\n');
    expect(out).toContain('\nworking  done\n');
    expect(resolveOverwrites('a\r\nb\r\n')).toBe('a\nb\n');
    expect(resolveOverwrites('50%\r100%\r    \r')).toBe('100%');
  });
});

describe('createTerminalStreamSanitizer: a sequence split across chunks is held, not half-emitted', () => {
  it('the live-tail case: `ESC[3` | `3m✓` never shows `3m`', () => {
    const s = createTerminalStreamSanitizer();
    expect(s.push('ok \u001b[3')).toBe('ok ');
    expect(s.push('3m\u001b[2m✓\u001b[22m\u001b[39m slow')).toBe('✓ slow');
    expect(s.flush()).toBe('');
  });

  it('every two-way split of real vitest output equals the whole-text strip', () => {
    const whole = FX.vitestColored.text;
    const want = stripTerminalControls(whole);
    for (let i = 0; i <= whole.length; i++) expect(streamed([whole.slice(0, i), whole.slice(i)])).toBe(want);
  });

  it('every two-way split of the OSC / DCS / C1 script output equals the whole-text strip', () => {
    const whole = FX.script.replace('x'.repeat(5000), 'x'.repeat(50));
    const want = stripTerminalControls(whole);
    for (let i = 0; i <= whole.length; i++) expect(streamed([whole.slice(0, i), whole.slice(i)])).toBe(want);
  });

  it('the real chunk boundaries the sandbox delivered', () => {
    expect(streamed(FX.vitestColored.chunks)).toBe(stripTerminalControls(FX.vitestColored.chunks.join('')));
  });

  it('an open OSC longer than STREAM_HOLD_MAX is discarded up to its terminator, never held without bound', () => {
    const payload = 'A'.repeat(STREAM_HOLD_MAX * 3);
    const s = createTerminalStreamSanitizer();
    expect(s.push(`before\u001b]52;c;${payload.slice(0, STREAM_HOLD_MAX * 2)}`)).toBe('before');
    expect(s.push(payload.slice(STREAM_HOLD_MAX * 2))).toBe('');
    expect(s.push('\u0007after')).toBe('after');
    expect(s.flush()).toBe('');
  });
});

describe('order: strip BEFORE the redactor', () => {
  it('a key an SGR splits in two is recognised only on the cleaned text', () => {
    const key = `sk-ant-${'a1B2c3D4e5'.repeat(4)}`;
    const raw = `token: ${key.slice(0, 12)}\u001b[1m${key.slice(12)}\u001b[0m\n`;
    expect(stripAnsi(patternRedact(raw))).toContain(key); // redact-then-strip leaks the whole key
    expect(patternRedact(cleanCommandOutput(raw))).not.toContain(key.slice(12));
  });
});

describe('looksBinary', () => {
  it('flags NUL-heavy output, not a stray NUL in text', () => {
    expect(looksBinary(`\u0000\u0000\u0000\u0000ELF${'\u0000'.repeat(40)}text`)).toBe(true);
    expect(looksBinary(FX.script)).toBe(false);
    expect(looksBinary(FX.vitestColored.text)).toBe(false);
    expect(looksBinary('')).toBe(false);
  });
});

describe('cleanCommandStreams: what the model reads of a finished command', () => {
  it('cleans each stream; a binary one becomes a note naming its size (the sandbox count when it is the only stream)', () => {
    const bin = `\u007fELF${'\u0000'.repeat(500)}`;
    expect(cleanCommandStreams({ stdout: '\u001b[32mok\u001b[0m\r\n', stderr: '', bytesSeen: 60_000 })).toEqual({ stdout: 'ok\n', stderr: '' });
    expect(cleanCommandStreams({ stdout: bin, stderr: '', bytesSeen: 60_000 })).toEqual({ stdout: binaryOutputNote(60_000), stderr: '' });
    // with both streams present the size is what was captured of this one (UTF-8 bytes, an undecodable byte as one)
    expect(cleanCommandStreams({ stdout: bin, stderr: 'warn\n', bytesSeen: 60_000 })).toEqual({ stdout: binaryOutputNote(504), stderr: 'warn\n' });
    expect(cleanCommandStreams({ stdout: `é${'\uFFFD'.repeat(20)}`, stderr: 'x', bytesSeen: 9 }).stdout).toBe(binaryOutputNote(22));
    expect(binaryOutputNote(12)).toBe('(binary output: 12 bytes, not shown — write it to a file, or pipe it through xxd | head or file)');
  });
});

describe('ESC_SEQ_RE: the one shared grammar', () => {
  it('is global and stateless under replace (log.ts, markdown.ts and the TUI share one instance)', () => {
    expect(ESC_SEQ_RE.flags).toContain('g');
    for (let i = 0; i < 3; i++) expect('a\u001b[1mb\u001b]0;t\u0007c'.replace(ESC_SEQ_RE, '')).toBe('abc');
    expect(ESC_SEQ_RE.lastIndex).toBe(0);
  });
});

describe('cost', () => {
  it('200 KB of colored test output cleans well inside a frame budget', () => {
    const line = '     \u001b[33m\u001b[2m✓\u001b[22m\u001b[39m a test name that is long enough\u001b[33m 351\u001b[2mms\u001b[22m\u001b[39m\n';
    const big = line.repeat(Math.ceil((200 * 1024) / line.length));
    const t0 = performance.now();
    const out = cleanCommandOutput(big);
    const streamedOut = streamed(big.match(/[\s\S]{1,65536}/g) ?? []);
    expect(performance.now() - t0).toBeLessThan(budgetMs(250));
    expect(out).not.toMatch(REMNANT_RE);
    expect(streamedOut).toBe(stripTerminalControls(big));
  });
});
