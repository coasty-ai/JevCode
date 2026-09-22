/**
 * The slash-command grammar (TUI-DESIGN §5.1), pure:
 *
 *   line := '/' name (ws arg)* ws?
 *   name := [a-z][a-z0-9-]*                        // case-insensitive; aliases resolved by the registry
 *   arg  := bare | '"' (esc | [^"\\])* '"' | "'" [^']* "'"
 *   bare := (esc | [^ \t"'\\])+                     // esc := '\' any ; `--flag` and `--flag=value` become options
 *
 * Tokeniser errors (`unterminated quote`, `dangling backslash`) are returned, never thrown; the caller
 * appends `[ui] error: /<name>: <reason>` and keeps the draft with the cursor at the end.
 */

/** TUI-DESIGN §5.1: one parsed command line. */
export interface ParsedCommand {
  /** lower-cased name as typed (alias resolution is the registry's job) */
  readonly name: string;
  /** positional arguments in order, quotes and escapes removed */
  readonly args: readonly string[];
  /** `--flag` → true, `--flag=value` → "value"; later occurrences win */
  readonly options: Readonly<Record<string, string | true>>;
  /** the line as typed, trimmed */
  readonly raw: string;
}

/** TUI-DESIGN §5.1: the grammar's error kinds. */
export type ParseErrorKind = 'not-a-command' | 'empty name' | 'bad name' | 'unterminated quote' | 'dangling backslash';

/** TUI-DESIGN §5.1: a parse either yields a command or one error the caller renders as `/<name>: <reason>`. */
export type ParseResult =
  | { readonly ok: true; readonly command: ParsedCommand }
  | { readonly ok: false; readonly error: ParseErrorKind; readonly name: string | null; readonly reason: string };

const NAME_RE = /^[a-z][a-z0-9-]*$/;

/** TUI-DESIGN §4.9: true when the text is a command line — `/` at column 0 that is not the `//` literal-slash escape. */
export function isCommandLine(text: string): boolean {
  return text.startsWith('/') && !text.startsWith('//');
}

/** TUI-DESIGN §5.3: the `/name` token of a draft (up to the first whitespace), lower-cased; '' when not a command line. */
export function commandToken(text: string): string {
  if (!isCommandLine(text)) return '';
  const m = /^\/(\S*)/.exec(text);
  return m ? `/${(m[1] ?? '').toLowerCase()}` : '/';
}

/** TUI-DESIGN §5.1: the lower-cased name token of a command line (`/Budget x` → `budget`), or null when the line is not a command line or the name is malformed. */
export function commandName(line: string): string | null {
  const raw = line.trim();
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  const m = /^\/(\S*)/.exec(raw);
  const name = (m?.[1] ?? '').toLowerCase();
  return NAME_RE.test(name) ? name : null;
}

/** TUI-DESIGN §5.1 `parseCommand` — the tokeniser; input up to any length, never throws. */
export function parseCommand(line: string): ParseResult {
  const raw = line.trim();
  if (!raw.startsWith('/') || raw.startsWith('//')) return { ok: false, error: 'not-a-command', name: null, reason: 'not a command' };
  let i = 1;
  const n = raw.length;
  // name
  let name = '';
  while (i < n && !/\s/.test(raw[i] as string)) name += raw[i++] as string;
  name = name.toLowerCase();
  if (name === '') return { ok: false, error: 'empty name', name: null, reason: 'expected a command name after /' };
  if (!NAME_RE.test(name)) return { ok: false, error: 'bad name', name, reason: `"${name}" is not a command name (letters, digits and - only)` };
  const args: string[] = [];
  const options: Record<string, string | true> = {};
  while (i < n) {
    while (i < n && /\s/.test(raw[i] as string)) i++;
    if (i >= n) break;
    const ch = raw[i] as string;
    if (ch === '"') {
      let v = '';
      i++;
      let closed = false;
      while (i < n) {
        const c = raw[i] as string;
        if (c === '\\') {
          if (i + 1 >= n) return { ok: false, error: 'dangling backslash', name, reason: 'dangling backslash' };
          v += raw[i + 1] as string;
          i += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        v += c;
        i++;
      }
      if (!closed) return { ok: false, error: 'unterminated quote', name, reason: 'unterminated quote' };
      args.push(v);
      continue;
    }
    if (ch === "'") {
      const end = raw.indexOf("'", i + 1);
      if (end < 0) return { ok: false, error: 'unterminated quote', name, reason: 'unterminated quote' };
      args.push(raw.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    // bare
    let v = '';
    let escaped = false;
    while (i < n) {
      const c = raw[i] as string;
      if (c === '\\') {
        if (i + 1 >= n) return { ok: false, error: 'dangling backslash', name, reason: 'dangling backslash' };
        v += raw[i + 1] as string;
        escaped = true;
        i += 2;
        continue;
      }
      if (/\s/.test(c) || c === '"' || c === "'") break;
      v += c;
      i++;
    }
    if (!escaped && v.startsWith('--') && v.length > 2) {
      const eq = v.indexOf('=');
      const key = eq >= 0 ? v.slice(2, eq) : v.slice(2);
      if (/^[a-z][a-z0-9-]*$/i.test(key)) {
        options[key.toLowerCase()] = eq >= 0 ? v.slice(eq + 1) : true;
        continue;
      }
    }
    args.push(v);
  }
  return { ok: true, command: { name, args, options, raw } };
}

/**
 * TUI-DESIGN-5 §2.9 / §2.5: one leading positional off a line whose LAST argument is a raw `rest`
 * (`/tell <target> <text>`, `/request <target> <verb> <text>`).
 *
 * §2.5 makes an **exact title** a first-class target and multi-word titles are the norm (`fix store rotation`),
 * so the token is quote-aware: `"…"` (with backslash escapes, as `parseCommand`) and `'…'` are taken whole, and
 * anything else is the bare `\S+` run. An **unterminated** quote falls back to the bare rule rather than failing
 * the line: the whole point of the rest path is that a stray quote in natural-language text is text
 * (`/tell mbp don't touch the tests`), and a target is the one token before that text.
 *
 * Returns the token and the untouched remainder (leading whitespace already dropped); `null` when the input is
 * empty after trimming.
 */
export function takeLeadingToken(text: string): { value: string; rest: string } | null {
  const s = text.replace(/^\s+/, '');
  if (s === '') return null;
  const quote = s[0];
  if (quote === '"' || quote === "'") {
    let v = '';
    let i = 1;
    while (i < s.length) {
      const c = s[i] as string;
      if (quote === '"' && c === '\\' && i + 1 < s.length) {
        v += s[i + 1] as string;
        i += 2;
        continue;
      }
      if (c === quote) return { value: v, rest: s.slice(i + 1).replace(/^\s+/, '') };
      v += c;
      i++;
    }
    // unterminated: fall through to the bare rule, so the quote is just a character in the token
  }
  const m = /^(\S+)\s*([\s\S]*)$/.exec(s);
  if (m === null) return null;
  return { value: m[1] as string, rest: m[2] as string };
}

/** TUI-DESIGN §5.1: the raw remainder after the name for `rest` arguments — trimmed, one line, ≤ `max` chars. */
export function restOf(line: string, max = 600): string {
  const raw = line.trim();
  const m = /^\/\S*\s*([\s\S]*)$/.exec(raw);
  const rest = (m?.[1] ?? '').replace(/\s+/g, ' ').trim();
  return rest.length > max ? rest.slice(0, max) : rest;
}

