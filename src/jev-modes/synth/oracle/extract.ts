/**
 * Candidate reproduction snippets from an issue text (pure code, no Jev). The 30 SWE-bench
 * Verified problem statements in bench/data/swebench-verified-30.json come in four shapes:
 * markdown fences (sympy, pytest, pylint, requests), `>>>` REPL transcripts inside fences (sympy),
 * bare code lines with tab-indented bodies (Django's Trac strips the markdown: django-15128,
 * -15315, -14787, -15916), and IPython `In [n]:` transcripts (django-15375, -15563). Tracebacks
 * appear in Python style (`File "…", line N, in fn`) and pytest style (`path:NN: in fn`,
 * `E   ExcType: msg`). This module finds all of them and the sentences that state expected vs
 * actual behaviour; it never decides which block is the reproduction — that is Jev's question
 * (questions.ts).
 */
import type { CodeBlock, Expectation, ExpectationPattern, Extraction, NormalisedRepl, ReplStatement, ReplTranscript, Traceback, TracebackFrame } from './types.js';

export { type CodeBlock, type Expectation, type Extraction, type NormalisedRepl, type ReplTranscript, type Traceback } from './types.js';

/** Blocks kept per issue (sympy-20428 has 7 fences; the questions batch one Noul triple per block). */
export const MAX_BLOCKS = 12;
/** Longest block text kept (chars); pytest-7205's pasted traceback is ~4.5 KB. */
export const BLOCK_CHARS_MAX = 6000;
/** Longest expectation sentence kept. */
export const EXPECTATION_CHARS_MAX = 400;

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const PY_PROMPT = /^(\s*)>>>(?!>)(?: ?(.*))?$/;
const PY_CONT = /^(\s*)\.\.\. ?(.*)$/;
const IPY_PROMPT = /^(\s*)In \[(\d+)\]: ?(.*)$/;
const IPY_CONT = /^(\s*)\.\.\.: ?(.*)$/;
const IPY_OUT = /^(\s*)Out\[(\d+)\]: ?(.*)$/;
const TRACEBACK_HEAD = /^\s*Traceback \(most recent call last\):\s*$/;
const PY_FRAME = /^\s*File "([^"]+)", line (\d+)(?:, in (\S+))?\s*$/;
const PYTEST_FRAME = /^(\S+\.py):(\d+): in (\S+)\s*$/;
const PYTEST_LOCATION = /^(\S+\.py):(\d+):\s*(\S.*)?$/;
const PYTEST_E_LINE = /^E\s+([A-Z]\w*(?:Error|Exception|Warning|Exit|Interrupt|Fault)\w*):\s?(.*)$/;
const EXCEPTION_LINE = /^([A-Z]\w*(?:Error|Exception|Warning|Exit|Interrupt|Fault)\w*)(?::\s?(.*))?$/;
const PYTEST_SEPARATOR = /^(_ )+_?$|^_{3,} .+ _{3,}$|^={3,}/;

function normaliseNewlines(text: string): string {
  return text.split('\r\n').join('\n').split('\r').join('\n');
}

function dedent(lines: readonly string[]): string[] {
  let common: number | null = null;
  for (const l of lines) {
    if (l.trim() === '') continue;
    const n = (/^[ \t]*/.exec(l)?.[0] ?? '').length;
    common = common === null ? n : Math.min(common, n);
  }
  const cut = common ?? 0;
  return lines.map((l) => (l.trim() === '' ? '' : l.slice(cut)));
}

function trimBlank(lines: readonly string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && (lines[a] ?? '').trim() === '') a++;
  while (b > a && (lines[b - 1] ?? '').trim() === '') b--;
  return lines.slice(a, b);
}

// ---------------------------------------------------------------------------------------
// Tracebacks
// ---------------------------------------------------------------------------------------

/** Parse the first traceback in `text` (Python or pytest style, or a bare `ExcType: message` line). */
export function parseTraceback(text: string): Traceback | null {
  return tracebacksIn(text)[0] ?? null;
}

/** Every traceback in `text`, in order. */
export function tracebacksIn(text: string): Traceback[] {
  const lines = normaliseNewlines(text).split('\n');
  const out: Traceback[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (TRACEBACK_HEAD.test(line)) {
      const { traceback, next } = pythonTraceback(lines, i + 1);
      if (traceback !== null) out.push(traceback);
      i = next;
      continue;
    }
    if (PYTEST_FRAME.test(line) || PYTEST_E_LINE.test(line)) {
      const { traceback, next } = pytestTraceback(lines, i);
      if (traceback !== null) {
        out.push(traceback);
        i = next;
        continue;
      }
    }
    const m = EXCEPTION_LINE.exec(line.trim());
    if (m !== null && m[2] !== undefined && line.trim().length > m[1]!.length + 1) {
      out.push({ frames: [], exceptionType: m[1] ?? '', message: (m[2] ?? '').trim(), style: 'line' });
    }
    i++;
  }
  return out;
}

function pythonTraceback(lines: readonly string[], start: number): { traceback: Traceback | null; next: number } {
  const frames: TracebackFrame[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const f = PY_FRAME.exec(line);
    if (f !== null) {
      const frame: TracebackFrame = { file: f[1] ?? '', line: Number(f[2]), fn: f[3] ?? null, code: null };
      const nextLine = lines[i + 1] ?? '';
      if (/^\s+\S/.test(nextLine) && !PY_FRAME.test(nextLine) && !EXCEPTION_LINE.test(nextLine.trim())) {
        frame.code = nextLine.trim();
        i++;
      }
      frames.push(frame);
      i++;
      continue;
    }
    if (line.trim() === '' || /^\s*(\^+|~+|\[Previous line repeated.*\])\s*$/.test(line) || /^\s*During handling of the above exception/.test(line)) {
      i++;
      continue;
    }
    const e = EXCEPTION_LINE.exec(line.trim());
    if (e !== null) return { traceback: { frames, exceptionType: e[1] ?? '', message: (e[2] ?? '').trim(), style: 'python' }, next: i + 1 };
    // a non-frame, non-exception line: the traceback was cut (sympy-20428's last transcript ends inside the frames)
    break;
  }
  return { traceback: frames.length > 0 ? { frames, exceptionType: '', message: '', style: 'python' } : null, next: i };
}

function pytestTraceback(lines: readonly string[], start: number): { traceback: Traceback | null; next: number } {
  const frames: TracebackFrame[] = [];
  let i = start;
  let exceptionType = '';
  let message = '';
  let sawE = false;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const f = PYTEST_FRAME.exec(line);
    if (f !== null) {
      const frame: TracebackFrame = { file: f[1] ?? '', line: Number(f[2]), fn: f[3] ?? null, code: null };
      const nextLine = lines[i + 1] ?? '';
      if (/^\s{2,}\S/.test(nextLine) && !PYTEST_FRAME.test(nextLine) && !PYTEST_E_LINE.test(nextLine)) {
        frame.code = nextLine.trim();
        i++;
      }
      frames.push(frame);
      i++;
      continue;
    }
    const e = PYTEST_E_LINE.exec(line);
    if (e !== null) {
      if (!sawE) {
        exceptionType = e[1] ?? '';
        message = (e[2] ?? '').trim();
        sawE = true;
      }
      i++;
      continue;
    }
    const loc = PYTEST_LOCATION.exec(line);
    if (loc !== null) {
      const trailer = (loc[3] ?? '').trim();
      const excOnly = EXCEPTION_LINE.exec(trailer);
      frames.push({ file: loc[1] ?? '', line: Number(loc[2]), fn: null, code: null });
      if (excOnly !== null && exceptionType === '') exceptionType = excOnly[1] ?? '';
      i++;
      continue;
    }
    if (line.trim() === '' || PYTEST_SEPARATOR.test(line.trim()) || /^[>E]?\s/.test(line) || /^\s*[\w.]+ = /.test(line)) {
      i++;
      continue;
    }
    break;
  }
  if (frames.length === 0 && !sawE) return { traceback: null, next: start + 1 };
  return { traceback: { frames, exceptionType, message, style: 'pytest' }, next: i };
}

// ---------------------------------------------------------------------------------------
// REPL transcripts (>>> and IPython)
// ---------------------------------------------------------------------------------------

/** Parse a `>>>` or `In [n]:` transcript; null when the text has no prompt. */
export function parseRepl(text: string): ReplTranscript | null {
  const lines = normaliseNewlines(text).split('\n');
  const isPy = lines.some((l) => PY_PROMPT.test(l) && (PY_PROMPT.exec(l)?.[2] ?? '').trim() !== '');
  const isIpy = !isPy && lines.some((l) => IPY_PROMPT.test(l));
  if (!isPy && !isIpy) return null;
  const prompt = isPy ? PY_PROMPT : IPY_PROMPT;
  const cont = isPy ? PY_CONT : IPY_CONT;
  const statements: ReplStatement[] = [];
  let current: { source: string[]; output: string[] } | null = null;
  const flush = (): void => {
    if (current === null) return;
    const source = current.source.join('\n').replace(/\s+$/, '');
    const outputLines = trimBlank(current.output);
    let shown: string | null = outputLines.length > 0 ? outputLines.join('\n') : null;
    if (shown !== null && !isPy) shown = shown.replace(/^Out\[\d+\]: ?/, '');
    const traceback = shown === null ? null : parseTraceback(shown);
    if (source !== '') statements.push({ source, shown, traceback });
    current = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const p = prompt.exec(line);
    if (p !== null) {
      flush();
      const src = (isPy ? p[2] : p[3]) ?? '';
      current = { source: [src], output: [] };
      continue;
    }
    if (current === null) continue;
    const c = cont.exec(line);
    if (c !== null && current.output.length === 0) {
      current.source.push(c[2] ?? '');
      continue;
    }
    if (!isPy) {
      const o = IPY_OUT.exec(line);
      if (o !== null) {
        current.output.push(`Out[${o[2] ?? ''}]: ${o[3] ?? ''}`);
        continue;
      }
    }
    current.output.push(line);
  }
  flush();
  return statements.length > 0 ? { statements, prompt: isPy ? 'python' : 'ipython' } : null;
}

/** The transcript as a script plus the shown value per statement (the runner compares repr/stdout against these). */
export function normaliseRepl(t: ReplTranscript): NormalisedRepl {
  const statements = t.statements.map((s) => s.source);
  const shown: NormalisedRepl['shown'] = [];
  t.statements.forEach((s, i) => {
    if (s.shown !== null) shown.push({ statement: i, text: stripTrailingComment(s.shown), traceback: s.traceback });
  });
  return { script: statements.join('\n'), statements, shown };
}

/** `'3 \\, x^{2} \\, y' # I typed the thin spaces in` → the value only (a trailing comment on a single output line). */
export function stripTrailingComment(shown: string): string {
  if (shown.includes('\n')) return shown;
  const m = /^(.*?\S)\s+#\s.*$/.exec(shown);
  return m === null ? shown : m[1] ?? shown;
}

// ---------------------------------------------------------------------------------------
// Bare code lines (Django Trac strips markdown; tabs indent the bodies)
// ---------------------------------------------------------------------------------------

const CODE_START = /^(from \S+ import |import [\w.]+(\s*,\s*[\w.]+)*(\s+as\s+\w+)?\s*$|class \w+.*:\s*$|def \w+\s*\(.*:\s*$|@[\w.]+|assert\s|return\b|raise\b|with .*:\s*$|for .+ in .+:\s*$|while .+:\s*$|if .+:\s*$|elif .+:\s*$|else:\s*$|try:\s*$|except.*:\s*$|finally:\s*$|print\s*\()/;
const CODE_ASSIGN = /^[\w.]+(\[[^\]]*\])?(\s*,\s*[\w.]+)*\s*(=|\+=|-=)\s*\S/;
const CODE_CALL = /^[\w.]+\(.*\)\s*(\.[\w.]+(\(.*\))?)*\s*$/;
const CODE_CHAIN = /^[\w.]+(\(.*\))?(\.[\w]+(\(.*\))?)+\s*$/;
const CODE_OP = /^[\w.()]+ *([|&+\-*/%]|==|!=|<=|>=) *[\w.()]+\s*$/;
const CODE_CLOSER = /^[)\]}]+\s*,?\s*$/;
const PROSE_HINT = /^[A-Z][a-z]+\s+[a-z]+\s+[a-z]+/;

/** Does a line read as a line of Python (a strong starter, an assignment, a call, a chain, a closer)? */
export function looksLikeCode(line: string): boolean {
  const t = line.trim();
  if (t === '') return false;
  if (CODE_START.test(t)) return true;
  if (CODE_CLOSER.test(t)) return true;
  if (CODE_ASSIGN.test(t) && !/\s(is|are|was|were)\s/.test(t)) return true;
  if (CODE_CALL.test(t) && !PROSE_HINT.test(t)) return true;
  if (CODE_CHAIN.test(t) && !PROSE_HINT.test(t) && !/^\w+\.$/.test(t)) return true;
  if (CODE_OP.test(t)) return true;
  return false;
}

/** A comment line, an indented body line or a shell/python prompt line that belongs to a code run once one has started. */
function continuesCode(line: string, inRun: boolean): boolean {
  if (!inRun) return false;
  const t = line.trim();
  if (t === '') return false;
  if (/^\t| {2,}/.test(line) && !/^\s*[A-Z][a-z]+\s+[a-z]+\s+[a-z]+.*[.:]$/.test(line)) return true;
  if (t.startsWith('#')) return true;
  return false;
}

// ---------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------

interface RawBlock {
  origin: CodeBlock['origin'];
  lang: string | null;
  lines: string[];
  startLine: number;
  endLine: number;
}

/** A shell transcript (`$ pytest …` + its output) is output, not code. */
function isShellTranscript(lines: readonly string[], lang: string | null): boolean {
  if (lang !== null && /^(sh|shell|bash|console|zsh|text|txt|c|cpp|json|yaml|ini|toml|diff|html|xml)$/.test(lang)) return true;
  return lines.some((l) => /^\s*\$ /.test(l)) && !lines.some((l) => PY_PROMPT.test(l));
}

function classify(raw: RawBlock): CodeBlock {
  const text = trimBlank(dedent(raw.lines)).join('\n').slice(0, BLOCK_CHARS_MAX);
  const repl = parseRepl(text);
  const tracebacks = tracebacksIn(text);
  let kind: CodeBlock['kind'];
  if (repl !== null) kind = 'repl';
  else if (tracebacks.some((t) => t.frames.length > 0 || t.style === 'pytest')) kind = 'traceback';
  else if (isShellTranscript(raw.lines, raw.lang)) kind = 'output';
  else {
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    const codeish = lines.filter((l) => looksLikeCode(l) || /^\s/.test(l) || l.trim().startsWith('#')).length;
    const langIsPython = raw.lang !== null && /^(py|python|python3|py3|pycon)$/.test(raw.lang);
    kind = langIsPython || (lines.length > 0 && codeish / lines.length >= 0.5) ? 'code' : 'output';
  }
  const block: CodeBlock = { index: -1, kind, origin: raw.origin, lang: raw.lang, text, startLine: raw.startLine, endLine: raw.endLine, tracebacks };
  if (repl !== null) block.repl = repl;
  return block;
}

/** Fenced, indented, REPL/IPython and bare-code blocks of an issue text, with their tracebacks. */
export function extractBlocks(taskText: string): Extraction {
  const lines = normaliseNewlines(taskText).split('\n');
  const raws: RawBlock[] = [];
  const covered = new Array<boolean>(lines.length).fill(false);
  // 1. fences
  let i = 0;
  while (i < lines.length) {
    const open = FENCE.exec(lines[i] ?? '');
    if (open === null) {
      i++;
      continue;
    }
    const marker = open[1] ?? '```';
    const lang = (open[2] ?? '') === '' ? null : (open[2] ?? '').toLowerCase();
    let j = i + 1;
    while (j < lines.length) {
      const close = FENCE.exec(lines[j] ?? '');
      if (close !== null && (close[1] ?? '').startsWith(marker[0] ?? '`') && (close[2] ?? '') === '') break;
      j++;
    }
    const body = lines.slice(i + 1, j);
    if (trimBlank(body).length > 0) raws.push({ origin: 'fence', lang, lines: body, startLine: i + 2, endLine: j });
    for (let k = i; k <= Math.min(j, lines.length - 1); k++) covered[k] = true;
    i = j + 1;
  }
  // 2. REPL / IPython transcripts outside fences
  i = 0;
  while (i < lines.length) {
    if (covered[i] === true || !(PY_PROMPT.test(lines[i] ?? '') || IPY_PROMPT.test(lines[i] ?? ''))) {
      i++;
      continue;
    }
    const ipy = IPY_PROMPT.test(lines[i] ?? '');
    let j = i;
    let lastPrompt = i;
    while (j < lines.length && covered[j] !== true) {
      const l = lines[j] ?? '';
      if ((ipy ? IPY_PROMPT : PY_PROMPT).test(l)) lastPrompt = j;
      else if (l.trim() === '') {
        // a blank line ends the transcript unless another prompt follows within two lines
        const n1 = lines[j + 1] ?? '';
        const n2 = lines[j + 2] ?? '';
        const re = ipy ? IPY_PROMPT : PY_PROMPT;
        if (!(re.test(n1) || (n1.trim() === '' && re.test(n2)))) break;
      } else if (j > lastPrompt && !/^\s/.test(l) && /^[A-Z][a-z]+ [a-z]+ [a-z]+/.test(l) && !TRACEBACK_HEAD.test(l) && !EXCEPTION_LINE.test(l.trim()) && !(ipy && IPY_OUT.test(l))) {
        // a prose sentence after the output ends the transcript
        break;
      }
      j++;
    }
    const body = trimBlank(lines.slice(i, j));
    if (body.length > 0) raws.push({ origin: 'bare', lang: null, lines: body, startLine: i + 1, endLine: i + body.length });
    for (let k = i; k < j; k++) covered[k] = true;
    i = j;
  }
  // 3. tracebacks outside fences (Python style)
  i = 0;
  while (i < lines.length) {
    if (covered[i] === true || !TRACEBACK_HEAD.test(lines[i] ?? '')) {
      i++;
      continue;
    }
    const { next } = pythonTraceback(lines, i + 1);
    const body = lines.slice(i, next);
    raws.push({ origin: 'bare', lang: null, lines: body, startLine: i + 1, endLine: next });
    for (let k = i; k < next; k++) covered[k] = true;
    i = next;
  }
  // 4. indented blocks (markdown: every line indented by 4 spaces or a tab) and bare code runs
  i = 0;
  while (i < lines.length) {
    if (covered[i] === true || !looksLikeCode(lines[i] ?? '')) {
      i++;
      continue;
    }
    let j = i;
    let blanks = 0;
    let last = i;
    while (j < lines.length && covered[j] !== true) {
      const l = lines[j] ?? '';
      if (l.trim() === '') {
        blanks++;
        if (blanks > 1) break;
        j++;
        continue;
      }
      if (looksLikeCode(l) || continuesCode(l, true)) {
        blanks = 0;
        last = j;
        j++;
        continue;
      }
      break;
    }
    const body = lines.slice(i, last + 1);
    const codeLines = body.filter((l) => looksLikeCode(l)).length;
    if (body.length >= 2 && codeLines >= 2) {
      const indented = body.every((l) => l.trim() === '' || /^( {4}|\t)/.test(l));
      raws.push({ origin: indented ? 'indent' : 'bare', lang: null, lines: body, startLine: i + 1, endLine: last + 1 });
      for (let k = i; k <= last; k++) covered[k] = true;
    }
    i = Math.max(last + 1, i + 1);
  }
  raws.sort((a, b) => a.startLine - b.startLine);
  const blocks = raws.map(classify).slice(0, MAX_BLOCKS);
  blocks.forEach((b, idx) => {
    b.index = idx;
  });
  // tracebacks: block-embedded first (in block order), then any bare exception line outside blocks
  const tracebacks: Traceback[] = [];
  for (const b of blocks) tracebacks.push(...b.tracebacks);
  lines.forEach((l, idx) => {
    if (covered[idx] === true) return;
    const m = EXCEPTION_LINE.exec(l.trim());
    if (m !== null && m[2] !== undefined && m[2].trim() !== '') tracebacks.push({ frames: [], exceptionType: m[1] ?? '', message: m[2].trim(), style: 'line' });
  });
  return { blocks, tracebacks, expectations: expectationsIn(taskText, covered) };
}

// ---------------------------------------------------------------------------------------
// Expected vs actual sentences
// ---------------------------------------------------------------------------------------

const PATTERNS: { pattern: ExpectationPattern; re: RegExp }[] = [
  { pattern: 'instead_of', re: /\binstead of\b/i },
  { pattern: 'but_got', re: /\b(?:but|however)[^.]{0,40}?\b(?:i\s+)?(?:got|get|gets|see|sees|receive|receives|returns?|is|fails?)\b|\binstead (?:i\s+)?(?:got|get|see|fails?)\b/i },
  { pattern: 'raises', re: /\b(?:raise|raises|raised|throws?|thrown|crash(?:es)?|fails? with)\b/i },
  { pattern: 'expected', re: /\bexpect(?:ed|s|ing)?\b/i },
  { pattern: 'should', re: /\bshould(?:n't| not)?\b|\bought to\b|\bmust\b/i },
  { pattern: 'returns', re: /\b(?:returns?|returned|gives?|outputs?|prints?|yields?|results? in)\b/i },
];

const VALUE = /`([^`\n]+)`|'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;

/** Sentences of the prose (outside code blocks) that state expected or actual behaviour, with their backticked/quoted values. */
export function expectationsIn(taskText: string, coveredLines?: readonly boolean[]): Expectation[] {
  const lines = normaliseNewlines(taskText).split('\n');
  const out: Expectation[] = [];
  // sentences: split each prose paragraph on sentence ends; a line is its own unit when it ends without punctuation
  let para: { text: string; line: number }[] = [];
  const flush = (): void => {
    if (para.length === 0) return;
    const startLine = para[0]?.line ?? 1;
    const text = para.map((p) => p.text).join(' ');
    for (const sentence of text.split(/(?<=[.!?])\s+(?=[A-Z`'"(])/)) {
      const s = sentence.replace(/\s+/g, ' ').trim();
      if (s.length < 8) continue;
      const hit = PATTERNS.find((p) => p.re.test(s));
      if (hit === undefined) continue;
      const values: string[] = [];
      for (const m of s.matchAll(VALUE)) {
        const v = (m[1] ?? m[2] ?? m[3] ?? '').trim();
        if (v !== '' && !values.includes(v)) values.push(v);
      }
      out.push({ text: s.slice(0, EXPECTATION_CHARS_MAX), pattern: hit.pattern, values, line: startLine });
    }
    para = [];
  };
  lines.forEach((l, idx) => {
    if (coveredLines?.[idx] === true || l.trim() === '' || FENCE.test(l)) {
      flush();
      return;
    }
    para.push({ text: l, line: idx + 1 });
  });
  flush();
  return out;
}

/** Filler words allowed between a keyword and the value it introduces ("expect the output `X`", "should of course return `X`"). */
const GAP_WORDS = new Set(['the', 'a', 'an', 'value', 'values', 'output', 'result', 'results', 'be', 'to', 'is', 'as', 'correct', 'correctly', 'always', 'also', 'now', 'instead', 'string', 'list', 'following', 'this', 'that', 'then', 'it', 'expected', 'would', 'should', 'return', 'returns', 'returned', 'get', 'got', 'see', 'print', 'printed', 'prints', 'gives', 'give', 'produce', 'produces', 'here', 'back', 'exactly', 'like', 'something', 'i', 'we', 'you', 'have', 'been', 'not', 'course', 'of']);

function gapOk(gap: string): boolean {
  const words = gap.replace(/of course/g, ' ').replace(/[:,()]/g, ' ').trim().split(/\s+/).filter((w) => w !== '');
  // "return of `X`" names no value: a bare "of" right before the value is possessive, not filler
  if (/\bof\s*$/.test(gap.replace(/of course/g, ' '))) return false;
  return words.every((w) => GAP_WORDS.has(w.toLowerCase()));
}

/** Position of the first value (backticked or quoted) in `text` at or after `from`, with the value itself; null when filler other than GAP_WORDS sits between. */
function valueAfter(text: string, from: number, maxGapChars: number): { value: string; at: number } | null {
  const re = new RegExp(VALUE.source, 'g');
  for (const m of text.slice(from).matchAll(re)) {
    const at = from + (m.index ?? 0);
    const gap = text.slice(from, at);
    if (gap.length > maxGapChars || !gapOk(gap)) return null;
    const v = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (v !== '') return { value: v, at };
  }
  return null;
}

/** Words allowed between a keyword and the value it introduces ("expected the output `X`", "should of course return `X`"). */
const GAP_CHARS = 48;

/**
 * The expected and the actual value a sentence names, by its pattern: "expect the output `X` …
 * but instead I get `Y`" → X expected, Y actual; "`Y` is computed instead of `X`" → X expected,
 * Y actual; "should return `X`" → X. A value counts only when it directly follows the keyword
 * (a few words at most), so "the return of `_imp_`" names nothing.
 */
export function expectedActualOf(e: Expectation): { expected: string | null; actual: string | null } {
  const t = e.text;
  const idx = (re: RegExp): number => {
    const m = re.exec(t);
    return m === null ? -1 : m.index + m[0].length;
  };
  switch (e.pattern) {
    case 'instead_of': {
      const at = idx(/\binstead of\b/i);
      const exp = at < 0 ? null : valueAfter(t, at, GAP_CHARS);
      const before = e.values.find((v) => v !== exp?.value) ?? null;
      return { expected: exp?.value ?? null, actual: before };
    }
    case 'but_got': {
      const expAt = idx(/\b(?:expect(?:ed|s|ing)?|should(?: be| return| give| print| output| produce)?)\b/i);
      const gotAt = idx(/\b(?:but|however|instead)\b[^`'"]{0,40}?\b(?:got|get|gets|see|sees|receive|receives|returns?|is|fails?)\b/i);
      const exp = expAt < 0 ? null : valueAfter(t, expAt, GAP_CHARS);
      const act = gotAt < 0 ? null : valueAfter(t, gotAt, GAP_CHARS);
      return { expected: exp?.value ?? null, actual: act?.value ?? null };
    }
    case 'expected': {
      const at = idx(/\bexpect(?:ed|s|ing)?\b/i);
      const exp = at < 0 ? null : valueAfter(t, at, GAP_CHARS);
      const act = exp === null ? null : (e.values.find((v) => v !== exp.value && t.indexOf(v) > exp.at) ?? null);
      return { expected: exp?.value ?? null, actual: act };
    }
    case 'should': {
      const at = idx(/\b(?:should(?:n't| not)?|ought to|must)\b/i);
      const exp = at < 0 ? null : valueAfter(t, at, GAP_CHARS);
      return { expected: exp?.value ?? null, actual: null };
    }
    case 'returns': {
      const at = idx(/\b(?:returns?|returned|gives?|outputs?|prints?|yields?|results? in)\b/i);
      const exp = at < 0 ? null : valueAfter(t, at, 24);
      return { expected: exp?.value ?? null, actual: null };
    }
    case 'raises':
      return { expected: null, actual: e.values[0] ?? null };
    default:
      return { expected: null, actual: null };
  }
}

const TEST_MODULE = /^\s*(?:def test\w*\s*\(|class \w+\((?:unittest\.)?TestCase\)|@pytest\.(?:mark|fixture)|import pytest\b|import unittest\b|from pytest import)/m;

/**
 * A block that is a test module (pytest/unittest tests, fixtures, marks) or a module meant for a
 * tool (`pylint a.py`): executing it as a script only defines things and raises nothing. It needs a
 * command oracle (`pytest <file>`), which runner.ts does not provide; chooseBlocks never runs it.
 */
export function isTestModule(text: string): boolean {
  return TEST_MODULE.test(text);
}

/** The exception type an expectation sentence names (`raises X`, `should raise X`), when any. */
export function exceptionTypeIn(text: string): string | null {
  const m = /\b([A-Z]\w*(?:Error|Exception|Warning))\b/.exec(text);
  return m === null ? null : m[1] ?? null;
}
