/**
 * A small POSIX-shell reader for the command classifier (docs/AGENT-LOOP-DESIGN.md §12). It does not run or expand
 * anything; it only recovers the structure a classifier needs to be conservative:
 *
 *  - simple commands, split on `;`, `&&`, `||`, `|`, `|&`, `&`, newlines and `( )` / `{ }` grouping;
 *  - each word after quote removal, remembering whether part of it was a substitution, a parameter or a glob;
 *  - redirects with their fd, operator and target (`2>/dev/null`, `>&2`, `&>log`);
 *  - the commands inside `$(…)`, backticks and `<(…)` / `>(…)`, parsed recursively — and those nested in a `${…}` operand,
 *    an arithmetic `$((…))` or an unquoted heredoc body, which the shell expands too;
 *  - ANSI-C `$'…'` quoting, whose `\'` does not close the quote.
 *
 * Anything it cannot read makes the word opaque (`subst` / `param`), and the classifier treats opaque words as doubt. A
 * command that ends inside an open quote or substitution is `incomplete`, and the classifier does not call it read-only.
 */

export interface Word {
  /** the text after quote removal; `$VAR` / `${VAR}` references outside single quotes are kept verbatim */
  text: string;
  /** part of the word came from `$(…)`, backticks or a process substitution */
  subst: boolean;
  /** the word holds an unexpanded parameter reference outside single quotes */
  param: boolean;
  /** an unquoted glob character (`*`, `?`, `[`) */
  glob: boolean;
}

export interface Redirect {
  /** `>`, `>>`, `>|`, `<`, `<>`, `<<`, `<<<`, `&>`, `&>>`, `>&`, `<&` */
  op: string;
  fd: number | null;
  /** the file target; null for an fd duplication (`2>&1`, `>&2`, `>&-`) */
  target: Word | null;
}

export interface SimpleCommand {
  words: Word[];
  redirects: Redirect[];
  /** the operator that follows this command (`;`, `&&`, `||`, `|`, `&`, or '' at the end) */
  next: string;
}

export interface ParsedShell {
  commands: SimpleCommand[];
  /** every command list inside a substitution of any word or redirect, recursively */
  substitutions: ParsedShell[];
  /** the text ended inside an unterminated quote or substitution (here or in a substitution): the reading is a guess */
  incomplete: boolean;
}

const OPERATORS = ['&&', '||', '|&', ';;', ';', '|', '&', '\n', '(', ')'] as const;
const REDIRECT_OPS = ['&>>', '&>', '<<<', '<<-', '<<', '<>', '>>', '>|', '>&', '<&', '>', '<'] as const;

interface Region {
  inner: string;
  /** the index after the closing character */
  end: number;
  closed: boolean;
}

/** The index of the backtick closing the one before `from`, or `s.length`. */
function backtickEnd(s: string, from: number): number {
  let j = from;
  while (j < s.length && s[j] !== '`') j += s[j] === '\\' ? 2 : 1;
  return Math.min(j, s.length);
}

/**
 * Read a balanced region starting after its opening character: `(`…`)` (quotes skipped), or with `open` = `{` a `${…}`
 * operand, where nested `$(…)` and backticks are skipped whole as well — the shell ends the operand at the same brace.
 */
function readBalanced(s: string, from: number, open: '(' | '{' = '('): Region {
  const close = open === '(' ? ')' : '}';
  let depth = 1;
  let quote: '"' | "'" | null = null;
  for (let i = from; i < s.length; i += 1) {
    const ch = s[i]!;
    if (quote !== null) {
      if (ch === '\\' && quote === '"') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') i += 1;
    else if (ch === '"' || ch === "'") quote = ch;
    else if (open === '{' && ch === '$' && s[i + 1] === '(') i = readBalanced(s, i + 2).end - 1;
    else if (open === '{' && ch === '`') i = backtickEnd(s, i + 1);
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return { inner: s.slice(from, i), end: i + 1, closed: true };
    }
  }
  return { inner: s.slice(from), end: s.length, closed: false };
}

const ANSI_C: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
const ANSI_C_CODE = /^(?:x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|([0-7]{1,3}))/;

class Reader {
  readonly commands: SimpleCommand[] = [];
  readonly substitutions: ParsedShell[] = [];
  private words: Word[] = [];
  private redirects: Redirect[] = [];
  private heredocs: { delim: string; strip: boolean; quoted: boolean }[] = [];
  private incomplete = false;
  private i = 0;
  private readonly s: string;

  constructor(s: string) {
    this.s = s;
  }

  parse(): ParsedShell {
    const s = this.s;
    while (this.i < s.length) {
      const ch = s[this.i]!;
      if (ch === ' ' || ch === '\t' || ch === '\r') {
        this.i += 1;
        continue;
      }
      if (ch === '\\' && s[this.i + 1] === '\n') {
        this.i += 2;
        continue;
      }
      if (ch === '#') {
        while (this.i < s.length && s[this.i] !== '\n') this.i += 1;
        continue;
      }
      const redirect = this.tryRedirect(null);
      if (redirect) continue;
      const op = OPERATORS.find((o) => s.startsWith(o, this.i));
      if (op !== undefined) {
        this.i += op.length;
        this.endCommand(op === '\n' || op === '(' || op === ')' || op === ';;' ? ';' : op);
        if (op === '\n') this.skipHeredocs();
        continue;
      }
      const start = this.i;
      const word = this.readWord();
      // `2>file`: digits immediately followed by a redirect operator are its fd, not a word
      if (/^\d+$/.test(word.text) && !word.subst && this.tryRedirect(Number(word.text))) continue;
      if (this.i === start) this.i += 1; // never stall on an unreadable character
      else this.words.push(word);
    }
    this.endCommand('');
    return { commands: this.commands, substitutions: this.substitutions, incomplete: this.incomplete || this.substitutions.some((x) => x.incomplete) };
  }

  private endCommand(next: string): void {
    // grouping words are structure, not programs
    const words = this.words.filter((w, k) => !(k === 0 && (w.text === '{' || w.text === '}') && !w.subst));
    if (words.length > 0 || this.redirects.length > 0) this.commands.push({ words, redirects: this.redirects, next });
    else if (this.commands.length > 0 && next !== '') this.commands[this.commands.length - 1]!.next = next;
    this.words = [];
    this.redirects = [];
  }

  private tryRedirect(fd: number | null): boolean {
    const s = this.s;
    const op = REDIRECT_OPS.find((o) => s.startsWith(o, this.i));
    if (op === undefined) return false;
    // `>(…)` / `<(…)` is a process substitution, not a redirect
    if ((op === '>' || op === '<') && s[this.i + 1] === '(') return false;
    this.i += op.length;
    while (s[this.i] === ' ' || s[this.i] === '\t') this.i += 1;
    if (op === '<<' || op === '<<-') {
      const start = this.i;
      const delimWord = this.readWord();
      // any quoting of the delimiter word turns expansion of the body off
      this.heredocs.push({ delim: delimWord.text, strip: op === '<<-', quoted: /['"\\]/.test(s.slice(start, this.i)) });
      this.redirects.push({ op: '<<', fd, target: null });
      return true;
    }
    if ((op === '>&' || op === '<&') && /^(\d+|-)(?![^\s;&|<>()])/.test(s.slice(this.i))) {
      const m = /^(\d+|-)/.exec(s.slice(this.i))!;
      this.i += m[0].length;
      this.redirects.push({ op, fd, target: null });
      return true;
    }
    const target = this.readWord();
    this.redirects.push({ op, fd, target });
    return true;
  }

  /**
   * After a newline: skip the bodies of the heredocs opened on the line that just ended. The shell expands an unquoted
   * delimiter's body, so the command substitutions in it are read.
   */
  private skipHeredocs(): void {
    const s = this.s;
    for (const h of this.heredocs) {
      const body: string[] = [];
      while (this.i < s.length) {
        const nl = s.indexOf('\n', this.i);
        const line = s.slice(this.i, nl < 0 ? s.length : nl);
        this.i = nl < 0 ? s.length : nl + 1;
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
        body.push(line);
      }
      if (!h.quoted) this.nested(body.join('\n'));
    }
    this.heredocs = [];
  }

  private substitution(inner: string, closed = true): void {
    if (!closed) this.incomplete = true;
    this.substitutions.push(parseShell(inner));
  }

  /**
   * The command substitutions anywhere in text the shell expands without word splitting it here (a `${…}` operand, an
   * arithmetic expression, a heredoc body), quotes ignored — a guess on the side of finding too many. True when any.
   */
  private nested(text: string): boolean {
    let found = false;
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '\\') i += 1;
      else if (text[i] === '`') {
        const j = backtickEnd(text, i + 1);
        this.substitution(text.slice(i + 1, j), j < text.length);
        found = true;
        i = j;
      } else if (text.startsWith('$(', i) && text[i + 2] !== '(') {
        const r = readBalanced(text, i + 2);
        this.substitution(r.inner, r.closed);
        found = true;
        i = r.end - 1;
      }
    }
    return found;
  }

  private readWord(): Word {
    const s = this.s;
    const w: Word = { text: '', subst: false, param: false, glob: false };
    while (this.i < s.length) {
      const ch = s[this.i]!;
      if (' \t\r\n;&|<>()'.includes(ch)) {
        // `<(` / `>(` inside a word position is a process substitution
        if ((ch === '<' || ch === '>') && s[this.i + 1] === '(' && w.text === '') {
          const { inner, end } = readBalanced(s, this.i + 2);
          this.substitution(inner);
          w.subst = true;
          w.text += `${ch}(${inner})`;
          this.i = end;
          continue;
        }
        break;
      }
      if (ch === '\\') {
        w.text += s[this.i + 1] ?? '';
        this.i += 2;
      } else if (ch === "'") {
        const end = s.indexOf("'", this.i + 1);
        if (end < 0) this.incomplete = true;
        w.text += s.slice(this.i + 1, end < 0 ? s.length : end);
        this.i = end < 0 ? s.length : end + 1;
      } else if (ch === '"') {
        this.i += 1;
        while (this.i < s.length && s[this.i] !== '"') {
          const c = s[this.i]!;
          if (c === '\\' && '"\\$`\n'.includes(s[this.i + 1] ?? '')) {
            w.text += s[this.i + 1];
            this.i += 2;
          } else if (c === '$' || c === '`') this.dollarOrBacktick(w, true);
          else {
            w.text += c;
            this.i += 1;
          }
        }
        if (this.i >= s.length) this.incomplete = true;
        this.i += 1;
      } else if (ch === '$' || ch === '`') this.dollarOrBacktick(w, false);
      else {
        if (ch === '*' || ch === '?' || ch === '[') w.glob = true;
        w.text += ch;
        this.i += 1;
      }
    }
    return w;
  }

  /** `$'…'` outside double quotes: backslash escapes decoded; one the reader does not know makes the word opaque. */
  private ansiC(w: Word): void {
    const s = this.s;
    let i = this.i + 2;
    for (; i < s.length && s[i] !== "'"; i += 1) {
      if (s[i] !== '\\') {
        w.text += s[i];
        continue;
      }
      i += 1;
      const e = s[i] ?? '';
      const code = ANSI_C_CODE.exec(s.slice(i, i + 9));
      if (ANSI_C[e] !== undefined) w.text += ANSI_C[e];
      else if (code !== null) {
        w.text += String.fromCodePoint(Math.min(0x10ffff, parseInt(code[1] ?? code[2] ?? code[3] ?? code[4]!, code[4] !== undefined ? 8 : 16)));
        i += code[0].length - 1;
      } else {
        w.text += `\\${e}`;
        w.param = true;
      }
    }
    if (i >= s.length) this.incomplete = true;
    this.i = Math.min(s.length, i + 1);
  }

  private dollarOrBacktick(w: Word, quoted: boolean): void {
    const s = this.s;
    if (s[this.i] === '`') {
      const j = backtickEnd(s, this.i + 1);
      const inner = s.slice(this.i + 1, j);
      this.substitution(inner, j < s.length);
      w.subst = true;
      w.text += `\`${inner}\``;
      this.i = Math.min(s.length, j + 1);
      return;
    }
    if (!quoted && s[this.i + 1] === "'") {
      this.ansiC(w);
      return;
    }
    if (s.startsWith('$((', this.i)) {
      const r = readBalanced(s, this.i + 2);
      // `$((…))` is arithmetic only when the inner `(` closes at the very end; `$((a) && (b))` is a command substitution
      const arith = readBalanced(r.inner, 1);
      if (r.closed && arith.closed && arith.end === r.inner.length) {
        w.text += `$(${r.inner})`;
        if (this.nested(r.inner)) w.subst = true;
        else w.param = true;
      } else {
        this.substitution(r.inner, r.closed);
        w.subst = true;
        w.text += `$(${r.inner})`;
      }
      this.i = r.end;
      return;
    }
    if (s[this.i + 1] === '(') {
      const r = readBalanced(s, this.i + 2);
      this.substitution(r.inner, r.closed);
      w.subst = true;
      w.text += `$(${r.inner})`;
      this.i = r.end;
      return;
    }
    if (s[this.i + 1] === '{') {
      const r = readBalanced(s, this.i + 2, '{');
      if (!r.closed) this.incomplete = true;
      w.text += s.slice(this.i, r.end);
      // `${x:-$(cmd)}` runs cmd: an operand's substitutions are commands of this line
      if (this.nested(r.inner)) w.subst = true;
      else w.param = true;
      this.i = r.end;
      return;
    }
    const m = /^\$([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(s.slice(this.i));
    if (m !== null) {
      w.text += m[0];
      w.param = true;
      this.i += m[0].length;
      return;
    }
    w.text += '$';
    this.i += 1;
  }
}

/** Parse a command string into simple commands and nested substitutions. Never throws. */
export function parseShell(command: string): ParsedShell {
  return new Reader(command).parse();
}

/** Every simple command of a parse, substitutions included (depth first), for rules that look at each one. */
export function allCommands(p: ParsedShell): SimpleCommand[] {
  return [...p.commands, ...p.substitutions.flatMap(allCommands)];
}
