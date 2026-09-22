/**
 * docs/IMPORT-DESIGN.md §4.3 `toml.ts` — the Codex `config.toml` / Gemini command reader.
 *
 * It returns **leaves**, not a tree: one `ConfigLeaf` per scalar or array, addressed by its dotted
 * path, because §4.4.2 classifies per *key* and not per file (§0 principle 5). A quoted table key
 * survives as exactly **one** segment — `[projects."/Users/x/y"]` is six real rows on the author's
 * machine and must not become eight path segments (§6 row 21).
 *
 * Tolerant and total: a line that does not parse costs one warning and is skipped; a document in
 * which nothing at all parses returns `{ok:false}`. Nothing here throws.
 */
import type { Json } from '../../core/types.js';
import type { ConfigLeaf, ParseResult } from '../types.js';

const BARE_KEY_RE = /^[A-Za-z0-9_-]+/;

/** §4.4.2: the dotted rendering — a segment holding a `.`, a space or a quote is re-quoted. */
export function dottedPath(path: readonly string[]): string {
  return path.map((s) => (/^[A-Za-z0-9_-]+$/.test(s) ? s : JSON.stringify(s))).join('.');
}

function leafOf(path: readonly string[], value: Json): ConfigLeaf {
  return { path: [...path], dotted: dottedPath(path), value };
}

interface Cursor {
  text: string;
  i: number;
}

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

function skipSpace(c: Cursor, newlines: boolean): void {
  for (;;) {
    const ch = c.text[c.i];
    if (ch === undefined) return;
    if (ch === ' ' || ch === '\t' || ch === '\r' || (newlines && ch === '\n')) {
      c.i++;
      continue;
    }
    if (ch === '#') {
      while (c.i < c.text.length && c.text[c.i] !== '\n') c.i++;
      continue;
    }
    return;
  }
}

function readQuoted(c: Cursor, quote: string): string | null {
  const triple = c.text.startsWith(quote.repeat(3), c.i);
  if (triple) {
    const close = c.text.indexOf(quote.repeat(3), c.i + 3);
    if (close === -1) return null;
    const raw = c.text.slice(c.i + 3, close);
    c.i = close + 3;
    return raw.startsWith('\n') ? raw.slice(1) : raw;
  }
  let out = '';
  let i = c.i + 1;
  const basic = quote === '"';
  while (i < c.text.length) {
    const ch = c.text[i]!;
    if (ch === '\n') return null;
    if (basic && ch === '\\') {
      const n = c.text[i + 1];
      if (n === undefined) return null;
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
      i += 2;
      continue;
    }
    if (ch === quote) {
      c.i = i + 1;
      return out;
    }
    out += ch;
    i++;
  }
  return null;
}

/** One key segment: bare, `"quoted"` or `'literal'`. */
function readKeySegment(c: Cursor): string | null {
  skipSpace(c, false);
  const ch = c.text[c.i];
  if (ch === '"' || ch === "'") return readQuoted(c, ch);
  const m = BARE_KEY_RE.exec(c.text.slice(c.i));
  if (m === null) return null;
  c.i += m[0].length;
  return m[0];
}

function readKeyPath(c: Cursor): string[] | null {
  const path: string[] = [];
  for (;;) {
    const seg = readKeySegment(c);
    if (seg === null) return null;
    path.push(seg);
    skipSpace(c, false);
    if (c.text[c.i] === '.') {
      c.i++;
      continue;
    }
    return path;
  }
}

function readValue(c: Cursor): { value: Json } | null {
  skipSpace(c, false);
  const ch = c.text[c.i];
  if (ch === undefined) return null;
  if (ch === '"' || ch === "'") {
    const s = readQuoted(c, ch);
    return s === null ? null : { value: s };
  }
  if (ch === '[') {
    c.i++;
    const arr: Json[] = [];
    for (;;) {
      skipSpace(c, true);
      if (c.text[c.i] === ']') {
        c.i++;
        return { value: arr };
      }
      const v = readValue(c);
      if (v === null) return null;
      arr.push(v.value);
      skipSpace(c, true);
      if (c.text[c.i] === ',') {
        c.i++;
        continue;
      }
      if (c.text[c.i] === ']') {
        c.i++;
        return { value: arr };
      }
      return null;
    }
  }
  if (ch === '{') {
    c.i++;
    const obj: Record<string, Json> = {};
    for (;;) {
      skipSpace(c, true);
      if (c.text[c.i] === '}') {
        c.i++;
        return { value: obj };
      }
      const key = readKeyPath(c);
      if (key === null) return null;
      skipSpace(c, false);
      if (c.text[c.i] !== '=') return null;
      c.i++;
      const v = readValue(c);
      if (v === null) return null;
      let target = obj;
      for (let k = 0; k < key.length - 1; k++) {
        const seg = key[k]!;
        const next = target[seg];
        if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) target[seg] = {};
        target = target[seg] as Record<string, Json>;
      }
      target[key[key.length - 1]!] = v.value;
      skipSpace(c, true);
      if (c.text[c.i] === ',') {
        c.i++;
        continue;
      }
      if (c.text[c.i] === '}') {
        c.i++;
        return { value: obj };
      }
      return null;
    }
  }
  // bare token: boolean, number, datetime (kept verbatim as a string)
  let j = c.i;
  while (j < c.text.length && !'\n,]}#'.includes(c.text[j]!)) j++;
  const raw = c.text.slice(c.i, j).trim();
  if (raw.length === 0) return null;
  c.i = j;
  if (raw === 'true') return { value: true };
  if (raw === 'false') return { value: false };
  if (/^[+-]?(\d[\d_]*)$/.test(raw)) {
    const n = Number(raw.replace(/_/g, ''));
    return { value: Number.isSafeInteger(n) ? n : raw };
  }
  if (/^[+-]?(\d[\d_]*)\.(\d[\d_]*)([eE][+-]?\d+)?$/.test(raw) || /^[+-]?\d+[eE][+-]?\d+$/.test(raw)) return { value: Number(raw.replace(/_/g, '')) };
  if (/^0x[0-9a-fA-F_]+$/.test(raw)) return { value: Number.parseInt(raw.replace(/_/g, ''), 16) };
  return { value: raw };
}

function emit(out: ConfigLeaf[], path: readonly string[], value: Json): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      out.push(leafOf(path, {}));
      return;
    }
    for (const [k, v] of entries) emit(out, [...path, k], v as Json);
    return;
  }
  out.push(leafOf(path, value));
}

/** §4.3 / §6 row 21: TOML → dotted leaves. Quoted table keys stay one segment. Never throws. */
export function parseToml(text: string): ParseResult<readonly ConfigLeaf[]> {
  const warnings: string[] = [];
  const leaves: ConfigLeaf[] = [];
  const c: Cursor = { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, i: 0 };
  const tableArrayCounts = new Map<string, number>();
  let table: string[] = [];
  let errors = 0;

  const skipLine = (): void => {
    while (c.i < c.text.length && c.text[c.i] !== '\n') c.i++;
    if (c.i < c.text.length) c.i++;
  };

  for (;;) {
    skipSpace(c, true);
    if (c.i >= c.text.length) break;
    const start = c.i;
    if (c.text[c.i] === '[') {
      const isArray = c.text[c.i + 1] === '[';
      c.i += isArray ? 2 : 1;
      const path = readKeyPath(c);
      skipSpace(c, false);
      const closes = isArray ? c.text.startsWith(']]', c.i) : c.text[c.i] === ']';
      if (path === null || !closes) {
        warnings.push(`line ${lineOf(c.text, start)} not parsed`);
        errors++;
        c.i = start;
        skipLine();
        continue;
      }
      c.i += isArray ? 2 : 1;
      if (isArray) {
        const key = dottedPath(path);
        const n = tableArrayCounts.get(key) ?? 0;
        tableArrayCounts.set(key, n + 1);
        table = [...path, String(n)];
      } else {
        table = path;
      }
      skipLine();
      continue;
    }
    const key = readKeyPath(c);
    skipSpace(c, false);
    if (key === null || c.text[c.i] !== '=') {
      warnings.push(`line ${lineOf(c.text, start)} not parsed`);
      errors++;
      c.i = start;
      skipLine();
      continue;
    }
    c.i++;
    const v = readValue(c);
    if (v === null) {
      warnings.push(`line ${lineOf(c.text, start)} not parsed`);
      errors++;
      c.i = start;
      skipLine();
      continue;
    }
    emit(leaves, [...table, ...key], v.value);
    skipSpace(c, false);
    if (c.text[c.i] === '\n') c.i++;
  }

  if (leaves.length === 0 && errors > 0) return { ok: false, error: `no key parsed (${errors} malformed line${errors === 1 ? '' : 's'})`, warnings };
  return { ok: true, value: leaves, warnings };
}
