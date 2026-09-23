/**
 * Zero-dependency repair of a model's tool-call arguments (docs/AGENT-LOOP-DESIGN.md §4.4 step 2; `jsonrepair` is the
 * reference behaviour). It fixes what GLM and friends actually emit: a code fence around the object, prose before it,
 * trailing commas, raw newlines and tabs inside strings, unquoted keys, Python literals (`True`, `None`), and a reply cut
 * off mid-object (open strings and brackets are closed). It never invents content: a value that is not there stays
 * absent, and anything it cannot turn into JSON returns null.
 */
import type { Json } from '../core/types.js';

function tryParse(text: string): Json | null {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return null;
  }
}

const FENCE = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```\s*$/;
const PYTHON_LITERALS: Readonly<Record<string, string>> = { True: 'true', False: 'false', None: 'null' };

function lastNonSpace(s: string): string {
  const m = /\S(?=\s*$)/.exec(s);
  return m === null ? '' : m[0];
}

function nextNonSpace(s: string, from: number): string {
  for (let i = from; i < s.length; i += 1) if (!/\s/.test(s[i]!)) return s[i]!;
  return '';
}

/** Walk the text once, fixing strings, commas, keys and literals, then close whatever is still open. */
function rebuild(text: string): string {
  let out = '';
  const closers: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === '\\') {
        out += ch;
        escaped = true;
      } else if (ch === '"') {
        out += ch;
        inString = false;
      } else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (ch.charCodeAt(0) < 0x20) out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
      else out += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '{' || ch === '[') {
      closers.push(ch === '{' ? '}' : ']');
      out += ch;
    } else if (ch === '}' || ch === ']') {
      if (closers[closers.length - 1] === ch) closers.pop();
      else continue; // a stray closer is dropped
      out = out.replace(/,\s*$/, '');
      out += ch;
      if (closers.length === 0) break; // the value is complete; trailing prose is not part of it
    } else if (ch === ',') {
      const next = nextNonSpace(text, i + 1);
      if (next === '}' || next === ']' || next === '') continue; // trailing comma
      out += ch;
    } else if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < text.length && /[\w$]/.test(text[j]!)) j += 1;
      const word = text.slice(i, j);
      i = j - 1;
      const literal = PYTHON_LITERALS[word];
      if (literal !== undefined) out += literal;
      else if (word === 'true' || word === 'false' || word === 'null') out += word;
      else if (nextNonSpace(text, j) === ':') out += JSON.stringify(word); // an unquoted key
      else out += word;
    } else out += ch;
  }
  if (inString) {
    if (escaped) out = out.slice(0, -1);
    out += '"';
  }
  if (lastNonSpace(out) === ',') out = out.replace(/,\s*$/, '');
  if (lastNonSpace(out) === ':') out += 'null';
  while (closers.length > 0) out += closers.pop()!;
  return out;
}

/** The JSON a model meant, or null. A string that is already valid JSON parses unchanged. */
export function repairJson(text: string): Json | null {
  let t = text.trim();
  if (t === '') return null;
  const direct = tryParse(t);
  if (direct !== null) return direct;
  const fenced = FENCE.exec(t);
  if (fenced !== null) t = (fenced[1] ?? '').trim();
  const start = t.search(/[{[]/);
  if (start < 0) return null;
  t = t.slice(start);
  return tryParse(t) ?? tryParse(rebuild(t));
}
