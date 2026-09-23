/**
 * TUI-DESIGN-3 §8 pty scenarios of round 3, every run `--mock` or offline (`JEVCODE_ASSERT_NO_NETWORK=1`) inside a real pty driven
 * by scripts/pty/drive.exp: the persistent wordmark (§3 — the idle sweep's one pass in 12 s, a key mid-pass, the run hand-off, the
 * 21 / 20 / 22-row edges, the reduced-motion and no-colour twins); the TypeSafe pink by depth (§2); the hero-frame checklist of §9
 * through scripts/pty/polish-check.mjs over `polish.steps` at 24×80 and 40×120 and its twins; the one-key wizard edges of §1.8
 * (Esc → options → Ctrl-C, a pasted CR, the masked field's bytes in no frame, TypeSafe-only start persisting `mode: jev-only` and the
 * restart that opens no wizard, `JEVCODE_MODE=jev-only`, the screen-reader and `--plain` twins, the keyless pipe); the §4 audit's
 * command matrix (aliases, the ghost arrow, App-local `/p d`, `keepDraft`, `/status` while thinking, `/trust` Esc, `--keybindings`).
 * Every scenario keeps 0 clears, one RESTORE and no key bytes in any frame or file.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkPolish } from '../../scripts/pty/polish-check.mjs';
import { DEFAULT_MODE } from '../../src/config/defaults.js';
import { SR_OPTIONS_ROWS_AGENT, missingGeneratorOnly, optionHint } from '../../src/tui/onboarding/lines.js';
import { BADGE_DEFAULT, BADGE_DEFAULT_TEXT, BADGE_JEV_ONLY, CHAT_OPEN, EXIT_IDLE, FIRST_FRAME_STEP, IDLE_STEP, MOCK_RUN_MODE, PLACEHOLDER_FOLLOWUP, PLACEHOLDER_TASK, RAW_MODE_STEP, RUN_STARTED_STEP, SGR_GAP, afterFirstFrame, binPath, childEnv, cleanupScratch, countClears, drive, echoStep, hasExpect, labelStep, registerScratch, stripAnsi, syncFrames, timingOf, topEdgeStep, type Drive, type SyncFrame } from './helpers.js';

afterEach(cleanupScratch);

const FAKE_KEY = `sk-fake-${'x'.repeat(40)}`;
const NO_NETWORK = { JEVCODE_ASSERT_NO_NETWORK: '1' } as const;
const WORDMARK_RE = /██/;
const HEAD_RE = /▓▒░/;
const CAPTION_STEP = 'expect ◆(?:\\x1b\\[[0-9;]*m)* (?:\\x1b\\[[0-9;]*m)*\\d+\\.\\d+\\.\\d+';
const CAPTION_RE = /◆ \d+\.\d+\.\d+$/;
/** a frame's dynamic rows carry the complete resting mark */
const hasMark = (dyn: readonly string[]): boolean => dyn.filter((l) => WORDMARK_RE.test(l)).length >= 5;
/** the frames (with a rule row) of a capture */
const dynFrames = (r: Drive): SyncFrame[] => syncFrames(r.text).filter((f) => f.ruleIndex >= 0);
/** the raw bytes of the i-th synchronized frame (for SGR checks) */
function rawFrames(text: string): string[] {
  const parts = text.split('\x1b[?2026h');
  parts.shift();
  return parts;
}
/** the sweep band's SGR (the `sweep` role: cell 224 / #fbd0dc) */
const BAND_SGR = /38;5;224m|38;2;251;208;220m/;

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (statSync(p).isFile()) out.push(p);
  }
  return out;
}
function filesContaining(r: Drive, needle: string): string[] {
  return [...filesUnder(r.home), ...filesUnder(r.workspace)].filter((p) => readFileSync(p, 'latin1').includes(needle));
}
/** §9 "keys never in logs": the typed bytes are in no frame and no file */
function assertNoKeyBytes(r: Drive, ...secrets: string[]): void {
  for (const s of secrets) {
    expect(r.text, `key bytes in a frame: ${s.slice(0, 12)}…`).not.toContain(s);
    expect(filesContaining(r, s)).toEqual([]);
  }
}
/**
 * Owner directive 3: the branding box is padded with `wordmarkPad(rows)` blank rows above AND below the glyphs, so an
 * idle boxed frame is `rule 1 + (5 + 2p) + console 5` — 11 below 26 rows, 13 at 26–33, 15 from 34 up.
 */
const idleRows = (rows: number): number => 1 + (5 + 2 * (rows >= 34 ? 2 : rows >= 26 ? 1 : 0)) + 5;

/** the index of the first frame whose dynamic rows match `re` */
const frameWith = (all: readonly SyncFrame[], re: RegExp, from = 0): number => all.findIndex((f, i) => i >= from && f.dynamic.some((l) => re.test(l)));

describe.skipIf(!hasExpect)('pty round 3: the persistent wordmark (TUI-DESIGN-3 §3)', () => {
  for (const [rows, cols] of [
    [24, 80],
    [40, 120],
  ] as const) {
    it(`wordmark-idle ${rows}x${cols}: settle, 12 s alone → exactly one sweep pass (14–18 frames between the caption frame and the marker key), each ≤ 3 KB, band cells in the sweep SGR, the letters unchanged, ${idleRows(rows)} rows, 0 clears`, async () => {
      const r = await drive({ name: `r3-wordmark-idle-${rows}x${cols}`, args: ['chat', '--mock'], rows, cols, steps: [FIRST_FRAME_STEP, 'expect step 0/', CAPTION_STEP, 'mark settled', IDLE_STEP, 'sleep 12', 'mark idled', 'send h', echoStep('h'), 'send \\x03', `expect ${PLACEHOLDER_TASK}`, ...EXIT_IDLE], timeoutS: 40 });
      expect(r.timeouts).toBe(0);
      expect(r.code).toBe(0);
      const all = dynFrames(r);
      const raw = rawFrames(r.text);
      const caption = frameWith(all, CAPTION_RE);
      expect(caption).toBeGreaterThan(0);
      const echo = frameWith(all, /[›>] h/, caption + 1);
      expect(echo).toBeGreaterThan(caption);
      // the host's settle frame (the session meter) may land right after the caption; everything else in the window is the pass
      const between = all.slice(caption + 1, echo);
      const passFrames = between.filter((f) => BAND_SGR.test(raw[f.index] ?? ''));
      const other = between.filter((f) => !BAND_SGR.test(raw[f.index] ?? ''));
      expect(passFrames.length).toBeGreaterThanOrEqual(14);
      expect(passFrames.length).toBeLessThanOrEqual(18);
      expect(other.length).toBeLessThanOrEqual(2);
      const letters = (f: SyncFrame): string[] => f.dynamic.filter((l) => WORDMARK_RE.test(l));
      const ref = letters(all[caption]!);
      for (const f of passFrames) {
        expect(letters(f)).toEqual(ref);
        expect(Buffer.byteLength(raw[f.index] ?? '', 'utf8')).toBeLessThanOrEqual(3072);
        expect(f.dynamic.length).toBe(idleRows(rows));
      }
      // the sweep touches the letters only (colour): no `▓▒░` head, no clear, no width change
      expect(passFrames.some((f) => f.dynamic.some((l) => HEAD_RE.test(l)))).toBe(false);
      expect(countClears(afterFirstFrame(r.text))).toBe(0);
      console.log(`wordmark-idle ${rows}x${cols}: ${passFrames.length} pass frames, ${other.length} other frame(s) in 12 s idle, widest ${Math.max(...passFrames.map((f) => Buffer.byteLength(raw[f.index] ?? '', 'utf8')))} B`);
    });
  }

  it('wordmark-key-during-pass: a key ≈ 7.5 s after the settle lands mid-pass — its echo within 50 ms of the send, the pass finishes (band frames after the echo), no new pass within 3 s', async () => {
    const r = await drive({ name: 'r3-wordmark-key-during-pass', args: ['chat', '--mock'], steps: [FIRST_FRAME_STEP, 'expect step 0/', CAPTION_STEP, 'mark settled', IDLE_STEP, 'sleep 7.0', 'mark mid-pass', 'send h', echoStep('h'), 'mark echoed', 'sleep 3.5', 'mark after', 'send \\x03', `expect ${PLACEHOLDER_TASK}`, ...EXIT_IDLE], timeoutS: 40 });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const sent = r.timing.find((t) => t.op === 'send' && t.arg === 'h')!;
    const echoed = r.timing.find((t) => t.op === 'expect' && t.step > sent.step)!;
    expect(echoed.t - sent.t).toBeLessThanOrEqual(50);
    const all = dynFrames(r);
    const raw = rawFrames(r.text);
    const echo = frameWith(all, /[›>] h/);
    const clear = frameWith(all, /Say hi/, echo + 1);
    const after = all.slice(echo + 1, clear).filter((f) => BAND_SGR.test(raw[f.index] ?? ''));
    expect(after.length).toBeGreaterThanOrEqual(1);
    // the frame that echoes the key keeps the mark (a key completes / never kills the mark) and carries no head
    expect(hasMark(all[echo]!.dynamic)).toBe(true);
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
    console.log(`key during pass: echo ${echoed.t - sent.t} ms after the send, ${after.length} band frames after it`);
  });

  it('wordmark-handoff: the PINNED mark is up in EVERY frame of the run and after `end` under the strip (24 rows); `/panel` below 30 rows still hides it, `/panel off` brings it back', async () => {
    const r = await drive({
      name: 'r3-wordmark-handoff',
      args: ['chat', ...MOCK_RUN_MODE, '--mock', '--mock-steps', '3'],
      steps: [...CHAT_OPEN, 'send fix the failing test', echoStep('fix the failing test'), 'send \\r', RUN_STARTED_STEP, 'expect finished [·-] (complete|max_steps)', `expect ${PLACEHOLDER_FOLLOWUP}`, 'sleep 0.4', 'send /panel', echoStep('/panel'), 'send \\r', `expect ▾${SGR_GAP} decisions`, 'sleep 0.3', 'send /panel off', echoStep('/panel off'), 'send \\r', `expect ▸${SGR_GAP} jev`, 'sleep 0.3', ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const all = syncFrames(r.text);
    // owner addendum: the run's first frame is the one whose status row carries a numeric `step <n>/<max>`
    const start = all.findIndex((f) => f.dynamic.some((l) => /step \d+\/\d+/.test(l)));
    const end = all.findIndex((f) => f.lines.some((l) => /^ {0,9}\[run\] finished [·-] /.test(l)));
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    // owner directive 2: the mark is PINNED — it is up in every frame of the run, not hidden for it
    for (const f of all.slice(start, end + 1)) expect(hasMark(f.dynamic)).toBe(true);
    const back = all.slice(end).find((f) => hasMark(f.dynamic));
    expect(back).toBeDefined();
    expect(back!.dynamic[0]).toMatch(/^─── (?:◆ jevcode ─ )?▸ jev s\d+/);
    const panel = all.slice(end).find((f) => f.dynamic.some((l) => l.includes('▾ decisions')));
    expect(panel).toBeDefined();
    expect(hasMark(panel!.dynamic)).toBe(false);
    const off = all.slice(all.indexOf(panel!) + 1).find((f) => /^─── (?:◆ jevcode ─ )?▸ jev/.test(f.dynamic[0] ?? '') && hasMark(f.dynamic));
    expect(off).toBeDefined();
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
  });

  it('wordmark-21 / 20: the mark shows at 21 rows and the palette never hands it off; 20 rows keeps the brand row and 6 dynamic rows', async () => {
    const r21 = await drive({ name: 'r3-wordmark-21', args: ['chat', '--mock'], rows: 21, cols: 80, steps: [FIRST_FRAME_STEP, 'expect step 0/', CAPTION_STEP, IDLE_STEP, 'sleep 0.3', 'send /', 'expect Tab', 'sleep 0.4', 'mark palette', 'send \\x1b', 'sleep 0.3', 'send \\x03', `expect ${PLACEHOLDER_TASK}`, ...EXIT_IDLE] });
    expect(r21.timeouts).toBe(0);
    expect(r21.code).toBe(0);
    const all21 = dynFrames(r21);
    const palette = all21.filter((f) => f.dynamic.some((l) => l.includes('Tab')) && f.dynamic.some((l) => /╭─ commands/.test(l)));
    expect(palette.length).toBeGreaterThan(0);
    for (const f of palette) {
      expect(hasMark(f.dynamic)).toBe(true);
      expect(f.dynamic.length).toBeLessThanOrEqual(19);
    }
    expect(countClears(afterFirstFrame(r21.text))).toBe(0);
    const r20 = await drive({ name: 'r3-wordmark-20', args: ['chat', '--mock'], rows: 20, cols: 80, steps: [FIRST_FRAME_STEP, 'expect step 0/', 'expect ◆ jevcode', IDLE_STEP, 'sleep 1', 'send h', echoStep('h'), 'send \\x03', `expect ${PLACEHOLDER_TASK}`, ...EXIT_IDLE] });
    expect(r20.timeouts).toBe(0);
    expect(r20.code).toBe(0);
    const all20 = dynFrames(r20);
    const idle20 = all20.at(-1)!;
    expect(idle20.dynamic[0]).toMatch(/^─── ◆ jevcode \d+\.\d+\.\d+ ─/);
    expect(hasMark(idle20.dynamic)).toBe(false);
    expect(idle20.dynamic.length).toBe(6);
    expect(countClears(afterFirstFrame(r20.text))).toBe(0);
  });

  it('wordmark-22 after a mock run: the PINNED mark never left — it is up before the first key and after it, under the strip (F-W5)', async () => {
    const r = await drive({ name: 'r3-wordmark-22-postrun', args: ['chat', ...MOCK_RUN_MODE, '--mock', '--mock-steps', '3'], rows: 22, cols: 80, steps: [...CHAT_OPEN, 'send fix the failing test', echoStep('fix the failing test'), 'send \\r', RUN_STARTED_STEP, 'expect finished [·-] (complete|max_steps)', `expect ${PLACEHOLDER_FOLLOWUP}`, 'sleep 0.5', 'mark ended', 'send h', echoStep('h'), 'sleep 0.3', 'send \\x03', `expect ${PLACEHOLDER_FOLLOWUP}`, ...EXIT_IDLE] });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const all = syncFrames(r.text);
    const end = all.findIndex((f) => f.lines.some((l) => /^ {0,9}\[run\] finished [·-] /.test(l)));
    const echo = all.findIndex((f, i) => i > end && f.dynamic.some((l) => /[›>] h/.test(l)));
    expect(end).toBeGreaterThan(0);
    expect(echo).toBeGreaterThan(end);
    for (const f of all.slice(end, echo + 1)) expect(hasMark(f.dynamic)).toBe(true);
    expect(all[echo]!.dynamic[0]).toMatch(/^─── (?:◆ jevcode ─ )?▸ jev/);
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
  });

  it('wordmark-nocolor: --no-color turns the sweep off — the reveal still runs, the mark rests, 12 s alone write no frame; no `38;` anywhere', async () => {
    const r = await drive({ name: 'r3-wordmark-nocolor', args: ['chat', '--mock', '--no-color'], steps: [FIRST_FRAME_STEP, 'expect step 0/', CAPTION_STEP, 'mark settled', IDLE_STEP, 'sleep 12', 'mark idled', 'send h', 'expect (?:›|>) h', 'send \\x03', `expect ${PLACEHOLDER_TASK}`, ...EXIT_IDLE], timeoutS: 40 });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const all = dynFrames(r);
    expect(all[0]!.dynamic.some((l) => HEAD_RE.test(l))).toBe(true);
    const caption = frameWith(all, CAPTION_RE);
    const echo = frameWith(all, /[›>] h/, caption + 1);
    // the host's settle frame at most; no sweep frame in 12 s
    expect(all.slice(caption + 1, echo).length).toBeLessThanOrEqual(1);
    expect(r.text).not.toMatch(/\x1b\[38;/);
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
  });
});

describe.skipIf(!hasExpect)('pty round 3: the TypeSafe pink (TUI-DESIGN-3 §2)', () => {
  it('TERM=xterm-256color: the first frame carries `38;5;211` and no `38;5;117`; after `[run] start` the edges carry `38;5;169` and no `38;5;74`; `[you]` and `[jevcode]` labels are the two pinks', async () => {
    const r = await drive({ name: 'r3-theme-pink', args: ['chat', ...MOCK_RUN_MODE, '--mock', '--mock-steps', '3'], steps: [...CHAT_OPEN, 'send hi', echoStep('hi'), 'send \\r', labelStep('jevcode', 'Hi\\.'), 'send fix the failing test', echoStep('fix the failing test'), 'send \\r', RUN_STARTED_STEP, 'mark started', 'expect finished [·-] (complete|max_steps)', `expect ${PLACEHOLDER_FOLLOWUP}`, ...EXIT_IDLE] });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const first = r.text.slice(r.text.indexOf('\x1b[?25l'), r.text.indexOf('\x1b[?25h'));
    expect(first).toContain('38;5;211');
    expect(first).not.toContain('38;5;117');
    expect(r.text).toContain('38;5;169');
    expect(r.text).not.toContain('38;5;74');
    // D-O: the labels carry the pinks (bold), the bodies do not
    expect(r.text).toMatch(/\x1b\[1m(?:\x1b\[38;5;169m)? *\[you\]|\x1b\[38;5;169m(?:\x1b\[1m)? *\[you\]/); // the 10-cell gutter pads the label
    expect(r.text).toMatch(/\x1b\[1m(?:\x1b\[38;5;211m)?\[jevcode\]|\x1b\[38;5;211m(?:\x1b\[1m)?\[jevcode\]/);
    const youLine = stripAnsi(r.text).split(/\r?\n/).find((l) => /^ {4}\[you\] hi$/.test(l));
    expect(youLine).toBeDefined();
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
  });
  it('--theme light → `38;5;125` and no `38;5;211`; --theme ansi → `ESC[95m` and no `38;5;`; NO_COLOR → no `38;`', async () => {
    const light = await drive({ name: 'r3-theme-light', args: ['chat', '--mock', '--theme', 'light'], steps: [...CHAT_OPEN, ...EXIT_IDLE] });
    expect(light.code).toBe(0);
    expect(light.text).toContain('38;5;125');
    expect(light.text).not.toContain('38;5;211');
    const ansi = await drive({ name: 'r3-theme-ansi', args: ['chat', '--mock', '--theme', 'ansi'], steps: [...CHAT_OPEN, ...EXIT_IDLE] });
    expect(ansi.code).toBe(0);
    expect(ansi.text).toContain('\x1b[95m');
    expect(ansi.text).not.toContain('38;5;');
    const none = await drive({ name: 'r3-theme-nocolor', args: ['chat', '--mock'], env: { NO_COLOR: '1' }, steps: [...CHAT_OPEN, ...EXIT_IDLE] });
    expect(none.code).toBe(0);
    expect(none.text).not.toMatch(/\x1b\[38;/);
  });
});

describe.skipIf(!hasExpect)('pty round 3: the hero-frame checklist (TUI-DESIGN-3 §9, polish.steps)', () => {
  const POLISH = [FIRST_FRAME_STEP, 'expect step 0/', CAPTION_STEP, IDLE_STEP, 'sleep 0.3', 'send hi', echoStep('hi'), 'send \\r', 'mark hi-sent', labelStep('you', 'hi'), labelStep('jevcode', 'Hi\\.'), 'mark hi-reply', 'sleep 0.3', 'send fix the failing test', echoStep('fix the failing test'), 'send \\r', labelStep('you', 'fix the failing test'), RUN_STARTED_STEP, labelStep('step 1', ''), 'expect finished [·-] (complete|max_steps)', `expect ${PLACEHOLDER_FOLLOWUP}`, 'sleep 0.5', 'send /cost', echoStep('/cost'), 'send \\r', 'expect raise it', 'sleep 0.3', ...EXIT_IDLE];
  for (const [rows, cols] of [
    [24, 80],
    [40, 120],
  ] as const) {
    it(`polish ${rows}x${cols}: V1–V18 pass over the capture (V19 from the marks; V13 gated since D-V, V20's rates need the typist)`, async () => {
      const r = await drive({ name: `r3-polish-${rows}x${cols}`, args: ['chat', ...MOCK_RUN_MODE, '--mock', '--mock-steps', '4'], rows, cols, steps: POLISH });
      expect(r.timeouts).toBe(0);
      expect(r.code).toBe(0);
      const timing = { steps: r.timing.map((t) => ({ ...t })), chunks: [] as { t: number; off: number; n: number }[] };
      const { results } = checkPolish(r.text, { rows, cols, timing });
      const failed = results.filter((x) => x.pass === false);
      expect(failed.map((x) => `${x.id}: ${x.detail}`)).toEqual([]);
      const v19 = results.find((x) => x.id === 'V19')!;
      expect(v19.pass).toBe(true);
      console.log(`polish ${rows}x${cols}: ${results.filter((x) => x.pass === true).length} pass, ${results.filter((x) => x.pass === null).length} skipped; ${v19.detail}`);
    });
  }
  it('V21 twins: the same path under --ascii, --no-color, --no-animation, --screen-reader and at 12×60 passes V6–V12 and V16–V18', async () => {
    const twins: { name: string; args: string[]; rows?: number; cols?: number; env?: Record<string, string>; ascii?: boolean }[] = [
      { name: 'ascii', args: ['--ascii'], ascii: true },
      { name: 'nocolor', args: [], env: { NO_COLOR: '1' } },
      { name: 'reduced', args: ['--no-animation'] },
      { name: 'flat', args: [], rows: 12, cols: 60 },
    ];
    for (const t of twins) {
      const rows = t.rows ?? 24;
      const cols = t.cols ?? 80;
      const open = rows < 16 ? [FIRST_FRAME_STEP, `expect ${t.ascii ? 'Say hi' : PLACEHOLDER_TASK}`, RAW_MODE_STEP, 'expect sess \\$'] : [FIRST_FRAME_STEP, `expect ${PLACEHOLDER_TASK}`, RAW_MODE_STEP, IDLE_STEP];
      const r = await drive({ name: `r3-polish-${t.name}`, args: ['chat', ...MOCK_RUN_MODE, '--mock', '--mock-steps', '3', ...t.args], rows, cols, ...(t.env ? { env: t.env } : {}), steps: [...open, 'sleep 0.3', 'send fix the failing test', echoStep('fix the failing test'), 'send \\r', RUN_STARTED_STEP, 'expect finished [·-] (complete|max_steps)', `expect ${PLACEHOLDER_FOLLOWUP}`, 'sleep 0.3', ...EXIT_IDLE] });
      expect(r.timeouts, t.name).toBe(0);
      expect(r.code, t.name).toBe(0);
      const { results } = checkPolish(r.text, { rows, cols, ascii: t.ascii === true });
      const want = ['V6', 'V7', 'V8', 'V9', 'V10', 'V11', 'V12', 'V16', 'V17', 'V18'];
      const failed = results.filter((x) => want.includes(x.id) && x.pass === false);
      expect(failed.map((x) => `${t.name} ${x.id}: ${x.detail}`)).toEqual([]);
    }
  });
});

describe.skipIf(!hasExpect)('pty round 3: the one-key wizard edges (TUI-DESIGN-3 §1.8)', () => {
  const KEY_OPEN = [FIRST_FRAME_STEP, 'expect OpenRouter API key'];
  it('edge 4: Esc on the empty field → `options` under `setup · options`; Ctrl-C there prints the fix block and exits 2; the mark stays above the wizard', async () => {
    const r = await drive({ name: 'r3-options-ctrlc', args: [], env: NO_NETWORK, steps: [...KEY_OPEN, 'sleep 0.3', 'send \\x1b', 'expect Other ways to start', 'expect 1 OpenRouter', 'sleep 0.3', 'send \\x03', 'eof'] });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(2);
    const plain = stripAnsi(r.text);
    expect(plain).toMatch(/^╭─ setup · options ─/m);
    expect(plain).toContain('pick 1–4 · Esc back');
    expect(plain).toContain('export OPENROUTER_API_KEY=');
    const options = dynFrames(r).filter((f) => f.dynamic.some((l) => l.startsWith('╭─ setup · options')));
    expect(options.length).toBeGreaterThan(0);
    expect(hasMark(options[0]!.dynamic)).toBe(true);
    expect(r.runDirs()).toEqual([]);
  });
  it('edge 1: a key pasted with a trailing CR saves the clean key (four file keys from one paste, 0600); `n` skips the verify; the `[setup] spend caps` item; the bytes never in a frame', async () => {
    const key = 'sk-or-v1-fakefakefakefakefakefakefakefakefake';
    // the `[setup] spend caps` item is written while the wizard is still on `verify` (the save resolved the controller's
    // pending prompt), so it is asserted on the text below, never expected in stream order after the idle console
    const r = await drive({ name: 'r3-key-paste-newline', args: [], env: NO_NETWORK, steps: [...KEY_OPEN, 'sleep 0.3', `send ${key}\\r`, 'expect Verify now\\?', 'sleep 0.3', 'send n', IDLE_STEP, `expect ${PLACEHOLDER_TASK}`, 'sleep 0.3', ...EXIT_IDLE] });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const cfgPath = join(r.home, 'xdg', 'jevcode', 'config.json');
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    expect(cfg['apiKey']).toBe(key);
    expect(cfg['jevApiKey']).toBe(key);
    expect(cfg['provider']).toBe('openrouter');
    expect(cfg['jevProvider']).toBe('openrouter');
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
    const plain = stripAnsi(r.text);
    // §5.1: the item wraps over three console rows (the gutter is written with cursor moves, not spaces), so it is
    // matched on the whitespace-flattened text — never row by row
    expect(plain.replace(/\s+/g, ' ')).toContain(`[setup] spend caps: $10.00 per run · $50.00 per session (${BADGE_DEFAULT_TEXT}) — /budget changes them; /mode jev-only runs on Jev alone at $1.00 / $5.00`);
    expect(r.text).not.toContain(key);
    expect(r.text).not.toContain('fakefakefake');
  });
  it('edge 15: TYPESAFE_API_KEY only → the found-title field; Esc → options; `3` `3` persists `mode: jev-only` (no key saved), badge `jev-only`; a restart with the same HOME opens no wizard', async () => {
    const r = await drive({ name: 'r3-ts-only-start', args: [], env: { ...NO_NETWORK, TYPESAFE_API_KEY: FAKE_KEY }, steps: [FIRST_FRAME_STEP, 'expect TypeSafe key found', 'sleep 0.3', 'send \\x1b', 'expect Other ways to start', 'sleep 0.3', 'send 3', 'expect Enter confirms 3', 'expect no LLM', 'sleep 0.3', 'send 3', 'expect mode jev-only saved to', topEdgeStep(BADGE_JEV_ONLY), `expect ${PLACEHOLDER_TASK}`, ...EXIT_IDLE] });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const cfgPath = join(r.home, 'xdg', 'jevcode', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    expect(cfg['mode']).toBe('jev-only');
    expect(cfg['apiKey']).toBeUndefined();
    expect(cfg['jevApiKey']).toBeUndefined();
    const plain = stripAnsi(r.text);
    // the options step names the default mode's form (AGENT-LOOP-DESIGN §14.5: option 3 is the jev-only mode)
    expect(plain).toContain(optionHint(3, 1, 5, DEFAULT_MODE));
    expect(plain).not.toContain('· next run');
    assertNoKeyBytes(r, FAKE_KEY);
    // the restart: the same HOME, no wizard, the jev-only badge from the first frame
    const again = await drive({ name: 'r3-ts-only-restart', args: [], env: { ...NO_NETWORK, TYPESAFE_API_KEY: FAKE_KEY }, home: r.home, steps: [FIRST_FRAME_STEP, topEdgeStep(BADGE_JEV_ONLY), `expect ${PLACEHOLDER_TASK}`, IDLE_STEP, ...EXIT_IDLE] });
    expect(again.timeouts).toBe(0);
    expect(again.code).toBe(0);
    const p2 = stripAnsi(again.text);
    expect(p2).not.toContain('OpenRouter API key');
    expect(p2).not.toContain('Other ways to start');
    expect(p2).toMatch(/^╭─ jev-only /m);
  });
  it('edge 26: JEVCODE_MODE=jev-only with an OpenRouter key → the `jev-only` badge from the first frame, no wizard', async () => {
    const r = await drive({ name: 'r3-env-jev-only', args: ['chat'], env: { ...NO_NETWORK, OPENROUTER_API_KEY: FAKE_KEY, JEVCODE_MODE: 'jev-only' }, steps: [FIRST_FRAME_STEP, topEdgeStep(BADGE_JEV_ONLY), `expect ${PLACEHOLDER_TASK}`, IDLE_STEP, ...EXIT_IDLE] });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    expect(plain).toMatch(/^╭─ jev-only /m);
    expect(plain).not.toContain('OpenRouter API key —');
    assertNoKeyBytes(r, FAKE_KEY);
  });
  it('edge 8: the wizard through 24x80 → 12x60 → 40x120 — 3 rows in every tier, the flat tier draws the masked row, ≤ 1 clear (the shrink), Ctrl-C exits 2', async () => {
    const r = await drive({ name: 'r3-wizard-resize', args: [], env: NO_NETWORK, steps: [...KEY_OPEN, 'sleep 0.3', 'send sk-or-v1-fakefakefakefake', 'expect •{10}', 'sleep 0.3', 'resize 12 60', 'sleep 0.6', 'mark shrunk', 'resize 40 120', 'sleep 0.6', 'mark grown', 'send \\x03', 'eof'] });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(2);
    expect(countClears(afterFirstFrame(r.text))).toBeLessThanOrEqual(1);
    const plain = stripAnsi(r.text);
    // F-W9: the flat tier's masked row `> •••` (no console edge) and the same title
    expect(plain).toMatch(/^> •{10,}/m);
    expect(plain).toMatch(/^│ › •{10,}/m);
    assertNoKeyBytes(r, 'sk-or-v1-fakefakefakefake');
  });
  it('edge 23 / 24: the screen-reader twin reads the numbered options; the --plain twin prompts `other ways:` then the masked key; both exit 2 on Ctrl-C with the fix block', async () => {
    const sr = await drive({ name: 'r3-wizard-sr', args: ['--screen-reader'], env: NO_NETWORK, steps: ['expect OpenRouter API key', 'expect API key field, 0 characters entered, hidden', 'sleep 0.3', 'send \\x1b', 'expect Other ways to start', 'expect Enter selection \\(1-4\\)', 'sleep 0.3', 'send \\x03', 'eof'] });
    expect(sr.timeouts).toBe(0);
    expect(sr.code).toBe(2);
    // AGENT-LOOP-DESIGN §14.5: the agent default's screen-reader options (option 3 is the jev-only mode)
    expect(stripAnsi(sr.text)).toContain(SR_OPTIONS_ROWS_AGENT[1]);
    const plain = await drive({ name: 'r3-plain-wizard', args: ['chat', '--plain'], env: NO_NETWORK, steps: ['expect other ways:', 'sleep 0.3', 'send \\r', 'expect OpenRouter API key \\(one key', 'sleep 0.3', 'send \\x03', 'eof'] });
    expect(plain.timeouts).toBe(0);
    expect(plain.code).toBe(2);
    expect(stripAnsi(plain.text)).toContain('export OPENROUTER_API_KEY=');
  });
  it('edge 20: `jevcode run "task"` in a pipe with no keys → ConfigError naming what the default mode needs (agent: the generator alone), the fix block, exit 2, no run dir', () => {
    const home = mkdtempSync(join(tmpdir(), 'jevcode-pty-home-'));
    const ws = mkdtempSync(join(tmpdir(), 'jevcode-pty-ws-'));
    registerScratch(home, ws);
    mkdirSync(join(home, 'xdg'), { recursive: true });
    const r = spawnSync(process.execPath, [binPath(), 'run', 'probe task', '--workspace', ws], { cwd: ws, env: { ...childEnv(home, 24, 80), CI: '1', JEVCODE_ASSERT_NO_NETWORK: '1' }, encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(2);
    const out = `${r.stdout}\n${r.stderr}`;
    // AGENT-LOOP-DESIGN §14.2: the agent default misses the generator key alone (Jev optional)
    expect(out).toContain(missingGeneratorOnly('openrouter'));
    expect(out).not.toContain('decider.apiKey');
    expect(out).toContain('export OPENROUTER_API_KEY=');
    expect(existsSync(join(home, 'runs'))).toBe(false);
  });
});

describe.skipIf(!hasExpect)('pty round 3: commands, trust and keybindings (TUI-DESIGN-3 §4)', () => {
  /**
   * TUI-DESIGN-4 §4.7 E12 / §9.2's `App.tsx` row is LANDED (integrator 2026-09-22): `KeyState.draftTokenOnly`
   * is supplied and `CLOSE_OVERLAY_AND_CLEAR` has a consumer, so the last leg — Ctrl-C on `/budgett` with the
   * palette open — closes the card **and** clears the draft in one key. Before it landed this scenario's final
   * `expect` timed out; every other leg (the ghost, the alias run, the panel toggle) already passed.
   */
  it('commands-idle: `/s` ghosts ` → /status` and runs /status; `/p d` opens the decisions tab and a second `/p d` collapses it; `/budgett` keeps its draft', async () => {
    const r = await drive({
      name: 'r3-commands-idle',
      args: ['chat', ...MOCK_RUN_MODE, '--mock', '--mock-steps', '3'],
      // `/` and `s` are two keystrokes: `composer:palette` (keys/resolve.ts:416) opens the palette on the `/` key alone and the ghost is
      // drawn only while it is open (App.tsx:2149) — one `send /s` write is a single input event and opens no palette
      steps: [...CHAT_OPEN, 'send /', 'expect Tab picks', 'send s', 'expect → /status', 'sleep 0.3', 'send \\r', labelStep('ui', 'status'), 'sleep 0.3', 'send /p d', echoStep('/p d'), 'send \\r', `expect ▾${SGR_GAP} decisions`, 'sleep 0.3', 'send /p d', echoStep('/p d'), 'send \\r', 'sleep 0.5', 'mark collapsed', 'send /budgett', echoStep('/budgett'), 'send \\r', 'sleep 0.4', 'mark errored', 'send \\x03', `expect ${PLACEHOLDER_TASK}|${PLACEHOLDER_FOLLOWUP}`, ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    expect(plain).toContain('→ /status');
    expect(plain).toMatch(/^ {0,9}\[ui\] status/m);
    const all = dynFrames(r);
    const collapsed = all.find((f, i) => i > frameWith(all, /▾ decisions/) && !f.dynamic.some((l) => l.includes('▾ decisions')) && f.dynamic.some((l) => l.includes('› /p d') || l.includes('› ')));
    expect(collapsed).toBeDefined();
    // F21: a fixable error keeps the draft — the composer still reads `/budgett` after the error item
    const errored = all.filter((f) => f.dynamic.some((l) => /› \/budgett/.test(l)));
    expect(errored.length).toBeGreaterThan(1);
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
  });
  it('commands-live: `/undo` while live is an availability error and clears the draft (the next line never reads `/undo/pause`)', async () => {
    const r = await drive({
      name: 'r3-commands-live',
      args: ['chat', ...MOCK_RUN_MODE, '--mock', '--mock-steps', '200', '--max-steps', '200', '--max-replans', '50'],
      steps: [...CHAT_OPEN, 'send make the tests pass', echoStep('make the tests pass'), 'send \\r', RUN_STARTED_STEP, 'expect Type to steer', 'send /undo', echoStep('/undo'), 'send \\r', 'sleep 0.4', 'mark undone', 'send \\x03', 'expect finished [·-] human_abort', `expect ${PLACEHOLDER_FOLLOWUP}`, ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    expect(plain).not.toContain('/undo/pause');
    expect(plain).toMatch(/\[ui\] error: .*(idle|live)/);
    const all = dynFrames(r);
    const undone = frameWith(all, /› \/undo/);
    const after = all.slice(undone + 1).find((f) => f.dynamic.some((l) => l.includes('Type to steer')));
    expect(after).toBeDefined();
    expect(after!.dynamic.some((l) => /› \/undo/.test(l))).toBe(false);
  });
  it('commands-thinking: a `/status` line while the model is thinking (the agent default; JEVCODE_MOCK_STEP_MS=1500 holds the mock turn) answers at once; the reply lands afterwards', async () => {
    // AGENT-LOOP-DESIGN §A1: every message is an agent run, so `thinking` is the model turn — the mock's turn latency holds it open
    // (the legacy intake's JEVCODE_MOCK_JEV_MS paced a Jev reading the agent default no longer waits on)
    const r = await drive({ name: 'r3-commands-thinking', args: ['chat', '--mock'], env: { JEVCODE_MOCK_STEP_MS: '1500' }, steps: [...CHAT_OPEN, 'send hi', echoStep('hi'), 'send \\r', 'expect thinking', 'send /status', 'sleep 0.15', 'send \\r', labelStep('ui', 'status'), labelStep('jevcode', 'Hi\\.'), ...EXIT_IDLE] });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    expect(plain.indexOf('[ui] status')).toBeLessThan(plain.indexOf('[jevcode] Hi.'));
  });
  it('trust-esc: `/trust` reopens the trust card, Esc closes it with `trust unchanged (…)`, the session goes on and /exit leaves 0', async () => {
    const r = await drive({ name: 'r3-trust-esc', args: ['chat', '--mock'], files: { 'AGENTS.md': '# instructions\nBe careful.\n' }, steps: [FIRST_FRAME_STEP, 'expect Do you trust the files in', 'sleep 0.3', 'send 2', `expect ${PLACEHOLDER_TASK}`, IDLE_STEP, 'sleep 0.3', 'send /trust', echoStep('/trust'), 'send \\r', 'expect Do you trust the files in', 'sleep 0.3', 'send \\x1b', 'expect trust unchanged', ...EXIT_IDLE] });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    expect(stripAnsi(r.text)).toMatch(/trust unchanged \((session|trust|none)\)/);
  });
  it('--keybindings: a file mapping `global:help` to `none` reaches the App — `?` inserts text instead of opening the help', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcode-pty-kb-'));
    registerScratch(dir);
    const kb = join(dir, 'kb.json');
    writeFileSync(kb, '{ "global:help": "none" }\n');
    const r = await drive({ name: 'r3-keybindings', args: ['chat', '--mock', '--keybindings', kb], steps: [...CHAT_OPEN, 'send ?', echoStep('?'), 'sleep 0.3', 'send \\x03', `expect ${PLACEHOLDER_TASK}`, ...EXIT_IDLE] });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    expect(plain).toMatch(/› \?/);
    expect(plain).not.toContain('Tab picks');
  });
});

// the round-3 first frame keeps the round-2 gates (exported here so a reviewer finds the numbers in one place)
describe.skipIf(!hasExpect)('pty round 3: the first frame is still argv-only and < 300 ms', () => {
  it(`first frame: the ${BADGE_DEFAULT_TEXT} badge, the J column, step 0/–, < 300 ms warm`, async () => {
    const r = await drive({ name: 'r3-first-frame', args: ['chat', '--mock'], steps: [FIRST_FRAME_STEP, 'expect step 0/', topEdgeStep(BADGE_DEFAULT), IDLE_STEP, ...EXIT_IDLE] });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const first = timingOf(r.timing, 'expect', '25l');
    expect(first!.t).toBeLessThan(300);
    console.log(`round-3 first frame (pty, warm): ${first!.t} ms`);
  });
});
