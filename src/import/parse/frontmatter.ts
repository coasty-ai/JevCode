/**
 * docs/IMPORT-DESIGN.md §4.3 `frontmatter.ts` — the tolerant YAML-subset frontmatter reader.
 *
 * `---` on line 1 **only**; scalars, lists and exactly **one** nesting level (`metadata:`). It is
 * total: a block that never closes, or a line that does not parse, yields `broken: true` and a
 * warning, and the body is still imported (§6 row 19). Nothing here throws, and no value text is
 * ever echoed into a warning — a warning names the line number, never its content (§0 principle 3).
 */
import type { Frontmatter, FrontmatterValue, MemoryKind, ParseResult } from '../types.js';

/** Keys are matched loosely: tools in the wild use `applyTo`, `argument-hint`, `metadata.type`. */
const KEY_RE = /^([A-Za-z_][A-Za-z0-9_.$-]*)\s*:\s*(.*)$/;
const LIST_ITEM_RE = /^\s+-\s*(.*)$/;
const NESTED_RE = /^\s+([A-Za-z_][A-Za-z0-9_.$-]*)\s*:\s*(.*)$/;

/** §4.3: the six boolean spellings Claude skills accept, plus their quoted forms. */
const TRUE_WORDS = new Set(['true', 'yes', 'on', '1']);
const FALSE_WORDS = new Set(['false', 'no', 'off', '0']);

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Drop an unquoted trailing ` # comment`, the YAML rule (a `#` with no leading space is data). */
function stripTrailingComment(raw: string): string {
  const i = raw.search(/\s#/);
  return i === -1 ? raw : raw.slice(0, i);
}

function unquote(raw: string): { text: string; quoted: boolean } {
  const s = raw.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    const inner = s.slice(1, -1);
    return { text: s.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'"), quoted: true };
  }
  return { text: s, quoted: false };
}

/** A bare scalar: `true`/`false` become booleans, a plain number becomes a number, everything else stays a string. */
function scalarOf(raw: string): string | number | boolean {
  const { text, quoted } = unquote(raw);
  if (quoted) return text;
  const bare = stripTrailingComment(text).trim();
  if (bare === 'true') return true;
  if (bare === 'false') return false;
  if (bare === 'null' || bare === '~') return '';
  if (/^-?\d+$/.test(bare)) {
    const n = Number(bare);
    return Number.isSafeInteger(n) ? n : bare;
  }
  if (/^-?\d+\.\d+$/.test(bare)) return Number(bare);
  return bare;
}

/** Split a flow sequence `[a, "b, c", d]` on commas that are outside quotes. */
function splitFlow(inner: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote !== null) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ',') {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) out.push(buf);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

function flowList(raw: string): readonly string[] | null {
  const s = raw.trim();
  if (!s.startsWith('[') || !s.endsWith(']')) return null;
  return splitFlow(s.slice(1, -1)).map((v) => unquote(v).text);
}

/**
 * §4.3: parse a `---` frontmatter block. `ok: false` means there was none (`---` must be line 1);
 * `ok: true` with `broken: true` means the block was malformed and the body is imported anyway.
 */
export function parseFrontmatter(text: string): ParseResult<Frontmatter> {
  const warnings: string[] = [];
  const src = stripBom(text);
  const bomOffset = text.length - src.length;
  const firstBreak = src.indexOf('\n');
  const firstLine = (firstBreak === -1 ? src : src.slice(0, firstBreak)).replace(/\r$/, '');
  if (firstLine.trimEnd() !== '---') return { ok: false, error: 'no frontmatter', warnings };
  if (firstBreak === -1) return { ok: true, value: { keys: [], values: {}, bodyOffset: 0, broken: true }, warnings: ['frontmatter block not closed'] };

  const lines: string[] = [];
  let pos = firstBreak + 1;
  let close = -1;
  while (pos <= src.length) {
    const nl = src.indexOf('\n', pos);
    const end = nl === -1 ? src.length : nl;
    const line = src.slice(pos, end).replace(/\r$/, '');
    if (line.trimEnd() === '---' || line.trimEnd() === '...') {
      close = nl === -1 ? src.length : nl + 1;
      break;
    }
    lines.push(line);
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (close === -1) {
    // an unterminated block: the whole file is body (Claude's own behaviour); warn, import it anyway
    return { ok: true, value: { keys: [], values: {}, bodyOffset: 0, broken: true }, warnings: ['frontmatter block not closed'] };
  }

  const keys: string[] = [];
  const values: Record<string, FrontmatterValue> = {};
  let broken = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) {
      broken = true;
      warnings.push(`line ${i + 2} not parsed`);
      continue;
    }
    const m = KEY_RE.exec(line);
    if (m === null) {
      broken = true;
      warnings.push(`line ${i + 2} not parsed`);
      continue;
    }
    const key = m[1]!;
    const rest = m[2]!.trim();
    if (!keys.includes(key)) keys.push(key);
    if (rest.length > 0) {
      const list = flowList(rest);
      values[key] = list !== null ? list : scalarOf(rest);
      continue;
    }
    // block form: either `- item` lines or one level of `sub: value`
    const items: string[] = [];
    const nested: Record<string, string | number | boolean> = {};
    let nestedCount = 0;
    while (i + 1 < lines.length) {
      const next = lines[i + 1]!;
      if (next.trim().length === 0) {
        i++;
        continue;
      }
      if (!/^\s/.test(next)) break;
      const li = LIST_ITEM_RE.exec(next);
      if (li !== null) {
        items.push(unquote(li[1]!).text);
        i++;
        continue;
      }
      const ne = NESTED_RE.exec(next);
      if (ne !== null) {
        nested[ne[1]!] = scalarOf(ne[2]!);
        nestedCount++;
        i++;
        continue;
      }
      broken = true;
      warnings.push(`line ${i + 3} not parsed`);
      i++;
    }
    if (items.length > 0) values[key] = items;
    else if (nestedCount > 0) values[key] = nested;
    else values[key] = '';
  }
  return { ok: true, value: { keys, values, bodyOffset: bomOffset + close, broken }, warnings };
}

function lookup(fm: Frontmatter | null, key: string): FrontmatterValue | undefined {
  if (fm === null) return undefined;
  const direct = Object.prototype.hasOwnProperty.call(fm.values, key) ? fm.values[key] : undefined;
  if (direct !== undefined) return direct;
  const dot = key.indexOf('.');
  if (dot === -1) return undefined;
  const parent = fm.values[key.slice(0, dot)];
  if (parent === undefined || typeof parent !== 'object' || Array.isArray(parent)) return undefined;
  return (parent as Readonly<Record<string, string | number | boolean>>)[key.slice(dot + 1)];
}

/** §4.3: one scalar as a string (a list or a map is not a string). `metadata.type` dotted access works. */
export function fmString(fm: Frontmatter | null, key: string): string | null {
  const v = lookup(fm, key);
  if (v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/** §2.3 / §6 row 23: `kind` from a flat `type:` **or** a nested `metadata.type:`; neither ⇒ `reference`. */
export function kindOf(fm: Frontmatter | null): MemoryKind {
  const raw = fmString(fm, 'type') ?? fmString(fm, 'metadata.type');
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'project':
      return 'project';
    case 'preference':
    case 'user':
      return 'preference';
    case 'feedback':
      return 'feedback';
    case 'rule':
      return 'rule';
    default:
      return 'reference';
  }
}

/** §3.5 / §3.9: a list value, or a scalar string split on commas (`globs:`, `applyTo:` are both spellings). */
export function fmList(fm: Frontmatter | null, key: string): readonly string[] | null {
  const v = lookup(fm, key);
  if (v === undefined) return null;
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter((s) => s.length > 0);
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((s) => unquote(s).text.trim())
      .filter((s) => s.length > 0);
  }
  if (typeof v === 'number' || typeof v === 'boolean') return [String(v)];
  return null;
}

/** §6 row 22: `true/false/yes/no/on/off/1/0`, quoted or not; anything else is `null` (kept as a string). */
export function fmBool(fm: Frontmatter | null, key: string): boolean | null {
  const v = lookup(fm, key);
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : null;
  if (typeof v !== 'string') return null;
  const s = unquote(v).text.trim().toLowerCase();
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return false;
  return null;
}
