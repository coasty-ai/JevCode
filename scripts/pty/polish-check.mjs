#!/usr/bin/env node
// The hero-frame checklist (docs/TUI-DESIGN-3.md §9, V1–V21) over a pty capture:
//
//   node scripts/pty/polish-check.mjs <capture.cap> [--txt <capture.txt>] [--timing <timing.jsonl>] [--rows 24] [--cols 80]
//                                     [--ascii] [--version 0.3.0] [--max-fps 30] [--json]
//
// Frame grammar (§9): the capture is cut into frames at the synchronized-output bracket `ESC[?2026h` (every Ink frame of
// the App opens with one; the cursor hide `ESC[?25l` is the fallback). Inside a frame the rows above the rule row — the
// first row matching `^─{3,}` (or `^-{3,}` under --ascii) — are **scrollback** (`<Static>` rows committed by that frame),
// the rule row and below are the **dynamic region**. A wordmark row is one with ≥ 12 leading spaces followed by `██`
// (`##` under --ascii); a wrapped `<Static>` row is one whose predecessor is a labelled row of exactly `columns` cells.
// Predicates over scrollback skip wordmark rows and the first visible row (the capture's top edge may cut a block).
//
// Every predicate returns { id, pass, detail } — `pass: null` marks a check that needs a timing file (V19, V20's rate parts)
// or is deferred by the design (V13, D-M). The exit code is 1 when any predicate fails. The module is importable: the
// unit test (`test/unit/perf/polish-check.test.ts`) runs `checkPolish` over synthetic captures.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

export const BSU = '\x1b[?2026h';
export const CURSOR_HIDE = '\x1b[?25l';
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[c78=>]/g;
const SGR_RE = /\x1b\[([0-9;]*)m/g;
export const RUN_ID_RE = /\d{8}-\d{6}-[a-z0-9]{8}/;
const LABEL_RE = /^ {0,9}\[(?:run|step \d+|ui|setup|config|sandbox|you|jevcode)\] /;
const STEP_100_RE = /^\[step \d{3,}\] /;
/** the two pinks and their twins at every depth (TUI-DESIGN-3 §2): 256 cells 211 / 169 (dark), 125 / 89 (light); truecolor; ANSI-16 magenta(Bright) */
export const PINK_FG = new Set(['38;5;211', '38;5;169', '38;5;125', '38;5;89', '38;2;243;134;161', '38;2;212;91;182', '38;2;190;24;93', '38;2;131;24;67', '35', '95']);
/** the primary pink = the accent (TUI-DESIGN-3 D-P: the spinner glyph's colour) */
export const ACCENT_FG = new Set(['38;5;211', '38;2;243;134;161', '95', '38;5;125', '38;2;190;24;93', '35']);
const PROSE = new Set(['—', '–', '…', '’', '“', '”', '×', '·']);
const SPINNERS = new Set(['░', '▒', '▓', '█', '◆', '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏', '.', '+', '#', '*', '|', '/', '-', '\\', '•']);

export function stripAnsi(s) {
  return s.replace(ANSI_RE, '');
}

/** the cell width of a string: wide East Asian and emoji code points count 2, combining marks 0 (the checker's own approximation) */
export function cellWidth(s) {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
    if (cp >= 0x300 && cp <= 0x36f) continue;
    if (cp === 0x200d || cp === 0xfe0f) continue;
    w += (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd))) ? 2 : 1;
  }
  return w;
}

/** the glyph characters of `src/tui/glyphs.ts` (the UNICODE table's string literals), or the embedded set when the source is absent */
export function glyphChars() {
  const embedded = '─›✓✗↑↓⎇†•·┆█▏▎▍▌▋▊▉▁▂▃▄▅▆▇⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏░▒▓…│┌┐└┘−→≥≤×⚠—Σ≈–╭╮╰╯├┤▸▾╶◆⏎';
  const set = new Set([...embedded]);
  const p = join(ROOT, 'src', 'tui', 'glyphs.ts');
  if (existsSync(p)) {
    const src = readFileSync(p, 'utf8');
    const start = src.indexOf('const UNICODE: GlyphSet');
    const end = src.indexOf('const ASCII: GlyphSet');
    if (start >= 0 && end > start) for (const m of src.slice(start, end).matchAll(/'([^'\\]*)'/g)) for (const ch of m[1]) if (ch.codePointAt(0) > 0x7e) set.add(ch);
  }
  return set;
}

/** Cut a capture into frames (BSU brackets; the cursor hide when the capture has no bracket). Bytes before the first frame are the prologue. */
export function splitFrames(capture) {
  const sep = capture.includes(BSU) ? BSU : CURSOR_HIDE;
  const parts = capture.split(sep);
  const prologue = parts.shift() ?? '';
  return { prologue, frames: parts.map((raw, index) => frameOf(raw, index)) };
}

function isRule(row, ascii) {
  return ascii ? /^-{3}/.test(row) : /^─{3}/.test(row);
}

/** one frame: raw bytes, rows (ANSI stripped), the rule index, scrollback and dynamic rows, clears */
export function frameOf(raw, index) {
  const text = stripAnsi(raw).replace(/\r\n|\r/g, '\n');
  const rows = text.split('\n').map((r) => r.replace(/\s+$/, ''));
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  const rawRows = raw.replace(/\r\n|\r/g, '\n').split('\n');
  const ascii = !rows.some((r) => /─{3}/.test(r)) && rows.some((r) => /^-{3}/.test(r));
  let ruleIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    if (isRule(rows[i], ascii)) {
      ruleIndex = i;
      break;
    }
  }
  return {
    index,
    raw,
    rows,
    rawRows,
    ruleIndex,
    scrollback: ruleIndex >= 0 ? rows.slice(0, ruleIndex) : [],
    dynamic: ruleIndex >= 0 ? rows.slice(ruleIndex) : [],
    clears: (raw.match(/\x1b\[[0-9;]*[23]J|\x1bc|\x1b\[\?1049[hl]/g) ?? []).length,
    hasFrame: ruleIndex >= 0,
  };
}

export function isWordmarkRow(row, ascii = false) {
  return ascii ? /^ {12,}##/.test(row) : /^ {12,}██/.test(row) || /^ {4,}██ {2}██/.test(row) || /^ {5,}████ {2}███████/.test(row);
}
export function wordmarkCells(text) {
  return (text.match(/█/g) ?? []).length;
}

/** the SGR state along one raw row: an array of { ch, fg, bold, dim } per visible character */
export function paintRow(raw) {
  const out = [];
  let fg = null;
  let bold = false;
  let dim = false;
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '\x1b') {
      const m = /^\x1b\[([0-9;?]*)([ -/]*)([@-~])/.exec(raw.slice(i));
      if (m) {
        if (m[3] === 'm') {
          const params = m[1] === '' ? ['0'] : m[1].split(';');
          for (let k = 0; k < params.length; k++) {
            const p = params[k];
            if (p === '0' || p === '') {
              fg = null;
              bold = false;
              dim = false;
            } else if (p === '1') bold = true;
            else if (p === '2') dim = true;
            else if (p === '22') {
              bold = false;
              dim = false;
            } else if (p === '39') fg = null;
            else if (p === '38') {
              if (params[k + 1] === '5') {
                fg = `38;5;${params[k + 2]}`;
                k += 2;
              } else if (params[k + 1] === '2') {
                fg = `38;2;${params[k + 2]};${params[k + 3]};${params[k + 4]}`;
                k += 4;
              }
            } else if (/^(3[0-7]|9[0-7])$/.test(p)) fg = p;
          }
        }
        i += m[0].length;
        continue;
      }
      const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(raw.slice(i));
      if (osc) {
        i += osc[0].length;
        continue;
      }
      i += 1;
      continue;
    }
    const cp = raw.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    if (cp >= 0x20 && cp !== 0x7f) out.push({ ch, fg, bold, dim });
    i += ch.length;
  }
  return out;
}

/** the status row of a dynamic region: the row above the bottom edge in the boxed tier, the last row in the flat tier */
export function statusRowIndex(frame) {
  const d = frame.dynamic;
  if (d.length === 0) return -1;
  const last = d[d.length - 1];
  if (/^[╰+]/.test(last) && d.length >= 2) return frame.ruleIndex + d.length - 2;
  return frame.ruleIndex + d.length - 1;
}

function parseTiming(text) {
  const steps = [];
  const chunks = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (s === '') continue;
    let v;
    try {
      v = JSON.parse(s);
    } catch {
      continue;
    }
    if (typeof v !== 'object' || v === null || typeof v.t !== 'number') continue;
    if (v.op === 'chunk') chunks.push(v);
    else steps.push(v);
  }
  return { steps, chunks };
}

/**
 * Frame arrival times from the typist's chunk records (the chunk holding the frame's last byte); null without chunks. The
 * offsets are byte offsets, so they are computed over `byteCapture` — the capture decoded as latin1 (one code unit per byte);
 * its frames align one to one with the utf8 frames because the separators are ASCII.
 */
function frameTimes(byteCapture, chunks) {
  if (chunks.length === 0) return null;
  const sep = byteCapture.includes(BSU) ? BSU : CURSOR_HIDE;
  const parts = byteCapture.split(sep);
  parts.shift();
  const offsets = [];
  let off = byteCapture.indexOf(sep);
  for (const raw of parts) {
    const end = off + sep.length + raw.length;
    offsets.push(end - 1);
    off = end;
  }
  return offsets.map((o) => {
    let lo = 0;
    let hi = chunks.length - 1;
    let best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (chunks[mid].off <= o) {
        best = chunks[mid];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best && o < best.off + best.n ? best.t : null;
  });
}

const money = (s) => s.match(/\$\d[\d.,]*/g) ?? [];

/**
 * Run V1–V21 over a capture. `opts`: rows, cols, ascii, version, maxFps, txt (the stripped session text, derived when absent),
 * timing ({ steps, chunks } or null). Returns { results, frames, scrollback }.
 */
export function checkPolish(capture, opts = {}) {
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  const ascii = opts.ascii === true;
  const maxFps = opts.maxFps ?? 30;
  const version = opts.version ?? null;
  const { frames: all } = splitFrames(capture);
  const frames = all.filter((f) => f.hasFrame);
  const results = [];
  const add = (id, pass, detail) => results.push({ id, pass, detail });
  const txt = opts.txt ?? stripAnsi(capture).replace(/\r\n|\r/g, '\n');
  const sessionRows = txt.split('\n').map((r) => r.replace(/\s+$/, ''));

  // the scrollback in order: every frame's rows above its rule row (a clear frame repeats the whole static output — deduped by prefix)
  const scrollback = [];
  for (const f of all) {
    const srows = f.hasFrame ? f.scrollback : f.index === 0 ? f.rows : [];
    if (f.clears > 0 && srows.length >= scrollback.length && scrollback.every((r, i) => srows[i] === r)) scrollback.push(...srows.slice(scrollback.length));
    else if (f.clears === 0) scrollback.push(...srows);
  }
  const prologueRows = stripAnsi(splitFrames(capture).prologue).replace(/\r\n|\r/g, '\n').split('\n').map((r) => r.replace(/\s+$/, ''));
  while (prologueRows.length > 0 && prologueRows[prologueRows.length - 1] === '') prologueRows.pop();
  const allScroll = [...prologueRows, ...scrollback];
  const runStartAt = frames.findIndex((f) => f.scrollback.some((r) => /^ {0,9}\[run\] start /.test(r)));
  const captionFits = cols >= 73;
  const settledIdx = frames.findIndex((f, i) => (runStartAt < 0 || i < runStartAt) && f.dynamic.filter((r) => isWordmarkRow(r, ascii)).length >= 5 && !/[▓▒░]{3}|#\+\./.test(f.dynamic.slice(0, 7).join('\n')) && (!captionFits || /[◆*] \d+\.\d+\.\d+/.test(f.dynamic.join('\n'))));

  // V1 — the settled idle frame
  if (settledIdx < 0) add('V1', false, 'no settled idle frame (5 wordmark rows without the sweep head' + (captionFits ? ' and with the caption `◆ <version>`' : '') + ') before the first [run] start');
  else {
    const f = frames[settledIdx];
    const dyn = f.dynamic.join('\n');
    const problems = [];
    if (f.dynamic.filter((r) => /██|##/.test(r)).length < 5) problems.push('fewer than 5 wordmark rows');
    if (captionFits && !new RegExp(`[◆*] ${version ? version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '\\d+\\.\\d+\\.\\d+'}`).test(dyn)) problems.push('no caption `◆ <version>`');
    if (!/[›>] Say hi, ask a question, or describe a task/.test(dyn)) problems.push('no `› Say hi, ask a question, or describe a task…` prompt');
    if (f.dynamic.length !== 11) problems.push(`${f.dynamic.length} dynamic rows (want 11)`);
    add('V1', problems.length === 0, problems.length === 0 ? `frame ${f.index}: 5 wordmark rows, caption, prompt, 11 dynamic rows` : `frame ${f.index}: ${problems.join('; ')}`);
  }
  // V2 — wordmark cells in the settled frame and every idle frame until the first [run] start
  if (settledIdx >= 0) {
    const until = runStartAt < 0 ? frames.length : runStartAt;
    const bare = frames.slice(settledIdx, until).filter((f) => wordmarkCells(f.dynamic.join('')) === 0 && !ascii);
    add('V2', bare.length === 0, bare.length === 0 ? `wordmark cells in frames ${settledIdx}..${until - 1}` : `${bare.length} idle frame(s) without the mark before the first run: ${bare.slice(0, 5).map((f) => f.index).join(', ')}`);
  } else add('V2', false, 'no settled frame');
  // V3 / V4 / V5 / V14 / V15 — colours
  const fgs = new Set();
  let rowsOver3 = 0;
  const over3 = [];
  const pinkBad = [];
  for (const f of all) {
    for (const rr of f.rawRows) {
      const cells = paintRow(rr);
      const rowFg = new Set();
      let pinkText = '';
      for (const c of cells) {
        if (c.fg !== null) {
          fgs.add(c.fg);
          rowFg.add(c.fg);
        }
        if (c.fg !== null && PINK_FG.has(c.fg)) pinkText += c.ch;
        else pinkText += ' ';
      }
      if (rowFg.size > 3) {
        rowsOver3 += 1;
        if (over3.length < 3) over3.push(`frame ${f.index}: ${[...rowFg].join(' ')} on ${JSON.stringify(stripAnsi(rr).slice(0, 60))}`);
      }
      if (/\[block\]|\[review\]|\berror\b/.test(pinkText)) pinkBad.push(`frame ${f.index}: ${JSON.stringify(pinkText.trim().slice(0, 60))}`);
    }
  }
  add('V3', fgs.size <= 7, `${fgs.size} distinct SGR foregrounds: ${[...fgs].join(' ')}`);
  add('V4', rowsOver3 === 0, rowsOver3 === 0 ? 'no row with more than 3 colours' : `${rowsOver3} row(s) with > 3 colours: ${over3.join(' | ')}`);
  add('V5', pinkBad.length === 0, pinkBad.length === 0 ? 'no [block] / [review] / error inside a pink span' : pinkBad.slice(0, 3).join(' | '));
  // V6 — width
  const wide = [];
  for (const f of all) for (const r of f.rows) if (cellWidth(r) > cols) wide.push(`frame ${f.index}: ${cellWidth(r)} cells: ${JSON.stringify(r.slice(0, 70))}`);
  add('V6', wide.length === 0, wide.length === 0 ? `no row wider than ${cols}` : wide.slice(0, 3).join(' | '));
  // V7 / V8 / V10 / V18 — scrollback grammar
  const orphans = [];
  const badRows = [];
  const spacers = [];
  const uiIndent = [];
  const isLabel = (r) => LABEL_RE.test(r) && (r.indexOf(']') === 8 || STEP_100_RE.test(r) || /^\[(?:jevcode|sandbox)\] /.test(r) || /^\[step \d{3,}\]/.test(r));
  const labelAt8 = (r) => LABEL_RE.test(r) && r.indexOf(']') === 8;
  for (let i = 1; i < allScroll.length; i++) {
    const r = allScroll[i];
    const prev = allScroll[i - 1];
    if (r === '' || isWordmarkRow(r, ascii)) continue;
    const cont = /^ {10,}\S/.test(r);
    if (cont) {
      const own = r.trim();
      if (cellWidth(own) < 4 || /^[\d)\]·]+$/.test(own)) orphans.push(JSON.stringify(r));
    }
    const wrapped = LABEL_RE.test(prev) && cellWidth(prev) === cols;
    if (!(labelAt8(r) || STEP_100_RE.test(r) || cont || wrapped || /^ {0,9}\[run\] jevcode /.test(r))) badRows.push(JSON.stringify(r.slice(0, 70)));
    // V10: a blank row precedes [you], the first [jevcode] of a turn, [run] start, [run] end, a [ui] head with detail
    const isYou = /^ {0,9}\[you\] /.test(r);
    const isBot = /^\[jevcode\] /.test(r) && !/^\[jevcode\] /.test(prev);
    const isRun = /^ {0,9}\[run\] (?:start|end) /.test(r);
    const isUiHead = /^ {0,9}\[ui\] /.test(r) && /^ {10,}\S/.test(allScroll[i + 1] ?? '');
    if ((isYou || isBot || isRun || isUiHead) && prev !== '') spacers.push(JSON.stringify(r.slice(0, 60)));
    // V18: after a [ui] head every row until the next label starts with ≥ 10 spaces
    if (/^ {0,9}\[ui\] /.test(r)) {
      for (let k = i + 1; k < allScroll.length; k++) {
        const n = allScroll[k];
        if (n === '' || LABEL_RE.test(n) || isWordmarkRow(n, ascii)) break;
        if (!/^ {10}/.test(n)) uiIndent.push(JSON.stringify(n.slice(0, 60)));
      }
    }
  }
  add('V7', orphans.length === 0, orphans.length === 0 ? 'no orphan continuation row' : `orphans: ${orphans.slice(0, 5).join(', ')}`);
  add('V8', badRows.length === 0, badRows.length === 0 ? `${allScroll.length} scrollback rows follow the grammar` : `${badRows.length} row(s) outside the grammar: ${badRows.slice(0, 4).join(', ')}`);
  // V9 — glyphs
  const glyphs = glyphChars();
  const strange = new Set();
  for (const r of sessionRows) for (const ch of r) if (ch.codePointAt(0) > 0x7e && !glyphs.has(ch) && !PROSE.has(ch) && ch !== '█') strange.add(ch);
  add('V9', strange.size === 0, strange.size === 0 ? 'every non-ASCII code point is a glyph, a wordmark cell or prose' : `unknown code points: ${[...strange].map((c) => `${c} (U+${c.codePointAt(0).toString(16)})`).join(' ')}`);
  add('V10', spacers.length === 0, spacers.length === 0 ? 'a blank row precedes every turn, run edge and [ui] block' : `missing spacer before: ${spacers.slice(0, 4).join(', ')}`);
  // V11 — numbers
  const sci = sessionRows.filter((r) => /\d[eE]-\d/.test(r));
  const badMoney = [];
  const badDur = [];
  for (const r of allScroll) {
    for (const m of money(r)) if (!/^\$\d+\.\d{2,6}$/.test(m.replace(/,$/, ''))) badMoney.push(m);
    for (const m of r.match(/\b\d+(?:\.\d+)?s\b|\b\d+m\d+s\b|\b\d+h\d+m\b/g) ?? []) if (!/^\d+(?:\.\d)?s$|^\d+m\d{2}s$|^\d+h\d{2}m$/.test(m)) badDur.push(m);
  }
  add('V11', sci.length === 0 && badMoney.length === 0 && badDur.length === 0, [sci.length ? `scientific notation in ${sci.length} row(s)` : '', badMoney.length ? `money: ${[...new Set(badMoney)].slice(0, 5).join(' ')}` : '', badDur.length ? `durations: ${[...new Set(badDur)].slice(0, 5).join(' ')}` : ''].filter(Boolean).join('; ') || 'money `$d.dd[dd]`, durations `4.9s` / `1m02s` / `1h05m`, no e-notation');
  // V12 — run id never in a status row
  const idRows = [];
  for (const f of frames) {
    const si = statusRowIndex(f);
    if (si >= 0 && RUN_ID_RE.test(f.rows[si] ?? '')) idRows.push(`frame ${f.index}`);
  }
  add('V12', idRows.length === 0, idRows.length === 0 ? 'no run id in a status row' : `run id in the status row of ${idRows.slice(0, 3).join(', ')}`);
  add('V13', null, 'deferred with D-M (engine item text rewrites go to round 4)');
  // V14 / V15 — the status row's colours
  const v14 = [];
  const v15 = [];
  for (const f of frames) {
    const si = statusRowIndex(f);
    if (si < 0) continue;
    const raw = f.rawRows[si] ?? '';
    const cells = paintRow(raw);
    const boxed = /^[│|]/.test(f.rows[si] ?? '');
    const inner = boxed ? cells.slice(2, -2) : cells;
    const coloured = inner.filter((c) => c.fg !== null).length;
    const width = Math.max(1, boxed ? cols - 4 : cols);
    // a toast (`! press Ctrl-C again to exit`, `✓ …`) is a transient message coloured by its level (TUI-DESIGN-3 §5.2 A7): exempt from V14
    const toastRow = /^\s*[!✓•*] \S/.test(inner.map((c) => c.ch).join(''));
    if (!toastRow && coloured > width * 0.3) v14.push(`frame ${f.index}: ${coloured}/${width} cells coloured`);
    const first = inner.find((c) => c.ch !== ' ');
    if (first && SPINNERS.has(first.ch) && inner[inner.indexOf(first) + 1]?.ch === ' ' && /^[a-z]/.test((inner[inner.indexOf(first) + 2]?.ch ?? '')) && !ascii) {
      if (first.fg === null || !ACCENT_FG.has(first.fg)) v15.push(`frame ${f.index}: ${first.ch} in ${first.fg ?? 'default'}`);
    }
  }
  add('V14', v14.length === 0, v14.length === 0 ? 'the coloured span of every status row is ≤ 30 % of the inner width' : v14.slice(0, 3).join(' | '));
  add('V15', v15.length === 0, v15.length === 0 ? 'every leading spinner glyph is in the accent' : v15.slice(0, 3).join(' | '));
  // V16 — starting + Type to steer never together
  const v16 = frames.filter((f) => f.dynamic.some((r) => /\bstarting\b/.test(r)) && f.dynamic.some((r) => r.includes('Type to steer'))).map((f) => f.index);
  add('V16', v16.length === 0, v16.length === 0 ? 'no frame reads `starting` beside `Type to steer`' : `frames ${v16.slice(0, 5).join(', ')}`);
  // V17 — no loop banner in the dynamic region after [run] end
  const endAt = frames.findIndex((f) => f.scrollback.some((r) => /^ {0,9}\[run\] end /.test(r)));
  const v17 = endAt < 0 ? [] : frames.slice(endAt).filter((f) => f.dynamic.some((r) => /^loop ·|^loop {2}/.test(r))).map((f) => f.index);
  add('V17', v17.length === 0, endAt < 0 ? 'no run ended in this capture' : v17.length === 0 ? 'no loop banner after [run] end' : `banner rows in frames ${v17.slice(0, 5).join(', ')}`);
  add('V18', uiIndent.length === 0, uiIndent.length === 0 ? 'every row after a [ui] head is indented' : `rows after a [ui] head not at column 10: ${uiIndent.slice(0, 4).join(', ')}`);
  // V19 / V20 — timing-based
  const timing = opts.timing ?? null;
  if (timing === null) {
    add('V19', null, 'needs the timing file (--timing <timing.jsonl>)');
    add('V20', null, 'rates need the timing file; clears: ' + String(all.slice(1).reduce((n, f) => n + f.clears, 0)));
  } else {
    // V19: every `send \r` after a typed `hi`-class message → the next expect/mark that names [jevcode]; from marks `hi-sent` / `hi-reply` when present
    const waits = [];
    const marks = timing.steps.filter((s) => s.op === 'mark');
    for (let i = 0; i < marks.length - 1; i++) if (/-sent$/.test(marks[i].arg) && /-reply$/.test(marks[i + 1].arg)) waits.push(marks[i + 1].t - marks[i].t);
    if (waits.length === 0) {
      const sends = timing.steps.filter((s) => s.op === 'send' && s.arg === '\\r');
      for (const s of sends) {
        const reply = timing.steps.find((x) => x.op === 'expect' && x.t > s.t && /jevcode/.test(x.arg));
        const run = timing.steps.find((x) => x.op === 'expect' && x.t > s.t && /run.*start/.test(x.arg));
        if (reply && (!run || reply.t < run.t)) waits.push(reply.t - s.t);
      }
    }
    if (waits.length === 0) add('V19', null, 'no intake in this capture');
    else {
      const sorted = [...waits].sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1))];
      add('V19', p95 <= 1500, `hi → [jevcode] p95 ${p95} ms over ${waits.length} intake(s) (median ${sorted[Math.floor(sorted.length / 2)]} ms)`);
    }
    const times = frameTimes(opts.byteCapture ?? capture, timing.chunks);
    if (times === null) add('V20', null, 'the timing file carries no chunk records (drive.exp): only the typist timestamps frames');
    else {
      const firstIdx = all.findIndex((f) => f.hasFrame);
      const t0 = times[firstIdx];
      const problems = [];
      const inSplash = all.filter((f, i) => f.hasFrame && times[i] !== null && times[i] - t0 <= 700 && wordmarkCells(f.dynamic.join('')) > 0).length;
      if (inSplash > 15) problems.push(`${inSplash} wordmark frames in the first 700 ms (≤ 15)`);
      const runIdx = all.findIndex((f) => f.scrollback.some((r) => /^ {0,9}\[run\] start /.test(r)));
      if (runIdx >= 0 && times[runIdx] !== null) {
        const t = times[runIdx];
        const sweep = all.filter((f, i) => i >= runIdx && times[i] !== null && times[i] - t <= 300 && f.rawRows.some((r) => /^(?:\x1b\[[0-9;]*m)*─/.test(r) && /38;5;169|38;2;212;91;182|\x1b\[35m/.test(r))).length;
        if (sweep > 6) problems.push(`${sweep} rule-sweep frames in the 300 ms after [run] start (≤ 6)`);
        const burst = all.filter((f, i) => i >= runIdx && times[i] !== null && times[i] - t < 1000).length;
        if (burst > maxFps + 1) problems.push(`${burst} frames in the run's first second (≤ ${maxFps + 1})`);
      }
      // idle fps: the seconds between the settle and the first send (or the run start) — dynamic frames per second ≤ 4
      const firstSend = timing.steps.find((s) => s.op === 'send');
      const settleT = settledIdx >= 0 ? times[all.indexOf(frames[settledIdx])] : null;
      if (settleT !== null && settleT !== undefined) {
        const until = firstSend ? firstSend.t : Number.POSITIVE_INFINITY;
        const buckets = new Map();
        for (let i = 0; i < all.length; i++) {
          const t = times[i];
          if (t === null || t <= settleT || t >= until || !all[i].hasFrame) continue;
          const b = Math.floor((t - settleT) / 1000);
          buckets.set(b, (buckets.get(b) ?? 0) + 1);
        }
        const peak = Math.max(0, ...buckets.values());
        if (peak > 4) problems.push(`idle fps peak ${peak} (≤ 4)`);
      }
      const live = runIdx >= 0 ? all.filter((f, i) => i >= runIdx && times[i] !== null) : [];
      if (live.length > 0) {
        const buckets = new Map();
        for (const f of live) {
          const t = times[all.indexOf(f)];
          const b = Math.floor(t / 1000);
          buckets.set(b, (buckets.get(b) ?? 0) + 1);
        }
        // the live flush and static frames ride along here: the check is the loose one (dynamic ≤ maxFps + 1 needs the class split of render-lag.ts)
        const peak = Math.max(0, ...buckets.values());
        if (peak > (maxFps + 1) * 3) problems.push(`${peak} frames in one live second`);
      }
      const clears = all.slice(1).reduce((n, f) => n + f.clears, 0);
      if (clears > 0) problems.push(`${clears} clear(s) after the first frame`);
      add('V20', problems.length === 0, problems.length === 0 ? `splash ≤ 15 wordmark frames, run-start bucket inside the gate, idle fps ≤ 4, 0 clears` : problems.join('; '));
    }
  }
  add('V21', null, 'run this checker on the --ascii, --no-color, --no-animation, --screen-reader and 12×60 captures: V6–V12 and V16–V18 must pass there too');
  return { results, frames: all, scrollback: allScroll };
}

export function formatResults(results) {
  const w = Math.max(...results.map((r) => r.id.length));
  return results.map((r) => `${r.id.padEnd(w)}  ${r.pass === null ? 'skip' : r.pass ? 'pass' : 'FAIL'}  ${r.detail}`).join('\n');
}

function main(argv) {
  const args = [...argv];
  const opts = {};
  let cap = null;
  let txt = null;
  let timing = null;
  let json = false;
  while (args.length > 0) {
    const a = args.shift();
    if (a === '--txt') txt = args.shift();
    else if (a === '--timing') timing = args.shift();
    else if (a === '--rows') opts.rows = Number(args.shift());
    else if (a === '--cols') opts.cols = Number(args.shift());
    else if (a === '--version') opts.version = args.shift();
    else if (a === '--max-fps') opts.maxFps = Number(args.shift());
    else if (a === '--ascii') opts.ascii = true;
    else if (a === '--json') json = true;
    else if (a.startsWith('--')) {
      process.stderr.write(`polish-check: unknown option ${a}\n`);
      return 2;
    } else cap = a;
  }
  if (cap === null) {
    process.stderr.write('usage: node scripts/pty/polish-check.mjs <capture.cap> [--txt <capture.txt>] [--timing <timing.jsonl>] [--rows 24] [--cols 80] [--ascii] [--version 0.3.0] [--json]\n');
    return 2;
  }
  const capture = readFileSync(cap, 'latin1');
  if (txt !== null) opts.txt = readFileSync(txt, 'utf8');
  else opts.txt = stripAnsi(Buffer.from(capture, 'latin1').toString('utf8')).replace(/\r\n|\r/g, '\n');
  if (timing !== null && existsSync(timing)) opts.timing = parseTiming(readFileSync(timing, 'utf8'));
  // the capture is decoded as utf8 for the text predicates (the row grammar is about cells); frame bytes stay latin1 for the offsets
  const utf8 = Buffer.from(capture, 'latin1').toString('utf8');
  const { results } = checkPolish(utf8, { ...opts, byteCapture: capture, timing: opts.timing ?? null });
  if (json) process.stdout.write(`${JSON.stringify({ capture: cap, results }, null, 2)}\n`);
  else process.stdout.write(`${formatResults(results)}\n`);
  return results.some((r) => r.pass === false) ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
