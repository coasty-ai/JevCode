/**
 * docs/IMPORT-DESIGN.md §4.3 `jsonc.ts` — JSON with line comments, block comments and trailing commas
 * (`opencode.jsonc`, `~/.copilot/config.json`, `.vscode/mcp.json` all use them; §6 row 20).
 *
 * The scanner is **string-aware**: a `//` inside a JSON string is data, not a comment. Comments
 * are replaced by spaces so byte offsets are preserved for any caller that reports a position.
 * Total: a file that is still not JSON afterwards costs one `{ok:false}` and nothing else.
 */
import type { Json } from '../../core/types.js';
import type { ParseResult } from '../types.js';

/** §6 row 20: strip line and block comments outside strings, preserving offsets (spaces replace them). */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      let escaped = false;
      while (j < text.length) {
        const c = text[j]!;
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') break;
        j++;
      }
      out += text.slice(i, Math.min(j + 1, text.length));
      i = j + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      let j = i;
      while (j < text.length && text[j] !== '\n') j++;
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const j = close === -1 ? text.length : close + 2;
      // keep newlines so line numbers survive
      out += text.slice(i, j).replace(/[^\n]/g, ' ');
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Drop `,` that is immediately followed by `}` or `]` (outside strings — the input is already comment-free). */
function stripTrailingCommas(text: string): { text: string; dropped: number } {
  let out = '';
  let dropped = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      let escaped = false;
      while (j < text.length) {
        const c = text[j]!;
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') break;
        j++;
      }
      out += text.slice(i, Math.min(j + 1, text.length));
      i = j + 1;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === '}' || text[j] === ']') {
        out += ' ';
        dropped++;
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return { text: out, dropped };
}

/** §4.3: tolerant JSONC. Comments and trailing commas are reported as warnings, never as errors. */
export function parseJsonc(text: string): ParseResult<Json> {
  const warnings: string[] = [];
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const noComments = stripJsonComments(noBom);
  if (noComments !== noBom) warnings.push('comments dropped');
  const { text: clean, dropped } = stripTrailingCommas(noComments);
  if (dropped > 0) warnings.push(`${dropped} trailing comma${dropped === 1 ? '' : 's'} dropped`);
  if (clean.trim().length === 0) return { ok: false, error: 'empty document', warnings };
  try {
    return { ok: true, value: JSON.parse(clean) as Json, warnings };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), warnings };
  }
}
