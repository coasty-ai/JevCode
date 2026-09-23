/**
 * A small POSIX-shell reader for the command classifier (docs/AGENT-LOOP-DESIGN.md §12). It does not run or expand
 * anything; it only recovers the structure a classifier needs to be conservative:
 *
 *  - simple commands, split on `;`, `&&`, `||`, `|`, `|&`, `&`, newlines and `( )` / `{ }` grouping;
 *  - each word after quote removal, remembering whether part of it was a substitution, a parameter or a glob;
 *  - redirects with their fd, operator and target (`2>/dev/null`, `>&2`, `&>log`, heredocs skipped);
 *  - the commands inside `$(…)`, backticks and `<(…)` / `>(…)`, parsed recursively.
 *
 * Anything it cannot read makes the word opaque (`subst` / `param`), and the classifier treats opaque words as doubt.
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
}

const OPERATORS = ['&&', '||', '|&', ';;', ';', '|', '&', '\n', '(', ')'] as const;
const REDIRECT_OPS = ['&>>', '&>', '<<<', '<<-', '<<', '<>', '>>', '>|', '>&', '<&', '>', '<'] as const;

/** Read a balanced `(`…`)` region starting after the opening paren; returns the inner text and the index after `)`. */
function readBalanced(s: string, from: number): { inner: string; end: number } {
  let depth = 1;
  let i = from;
  let quote: '"' | "'" | null = null;
  for (; i < s.length; i += 1) {
    const ch = s[i]!;
    if (quote !== null) {
      if (ch === '\\' && quote === '"') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') i += 1;
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { inner: s.slice(from, i), end: i + 1 };
    }
  }
  return { inner: s.slice(from), end: s.length };
}

class Reader {
  readonly commands: SimpleCommand[] = [];
  readonly substitutions: ParsedShell[] = [];
  private words: Word[] = [];
  private redirects: Redirect[] = [];
  private heredocs: { delim: string; strip: boolean }[] = [];
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
    return { commands: this.commands, substitutions: this.substitutions };
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
      const delimWord = this.readWord();
      this.heredocs.push({ delim: delimWord.text, strip: op === '<<-' });
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

  /** After a newline: skip the bodies of the heredocs opened on the line that just ended. */
  private skipHeredocs(): void {
    const s = this.s;
    for (const h of this.heredocs) {
      while (this.i < s.length) {
        const nl = s.indexOf('\n', this.i);
        const line = s.slice(this.i, nl < 0 ? s.length : nl);
        this.i = nl < 0 ? s.length : nl + 1;
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
      }
    }
    this.heredocs = [];
  }

  private substitution(inner: string): void {
    this.substitutions.push(parseShell(inner));
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
        w.text += s.slice(this.i + 1, end < 0 ? s.length : end);
        this.i = end < 0 ? s.length : end + 1;
      } else if (ch === '"') {
        this.i += 1;
        while (this.i < s.length && s[this.i] !== '"') {
          const c = s[this.i]!;
          if (c === '\\' && '"\\$`\n'.includes(s[this.i + 1] ?? '')) {
            w.text += s[this.i + 1];
            this.i += 2;
          } else if (c === '$' || c === '`') this.dollarOrBacktick(w);
          else {
            w.text += c;
            this.i += 1;
          }
        }
        this.i += 1;
      } else if (ch === '$' || ch === '`') this.dollarOrBacktick(w);
      else {
        if (ch === '*' || ch === '?' || ch === '[') w.glob = true;
        w.text += ch;
        this.i += 1;
      }
    }
    return w;
  }

  private dollarOrBacktick(w: Word): void {
    const s = this.s;
    if (s[this.i] === '`') {
      let j = this.i + 1;
      while (j < s.length && s[j] !== '`') j += s[j] === '\\' ? 2 : 1;
      const inner = s.slice(this.i + 1, j);
      this.substitution(inner);
      w.subst = true;
      w.text += `\`${inner}\``;
      this.i = Math.min(s.length, j + 1);
      return;
    }
    if (s.startsWith('$((', this.i)) {
      const { inner, end } = readBalanced(s, this.i + 2);
      w.text += `$(${inner})`;
      w.param = true;
      this.i = end;
      return;
    }
    if (s[this.i + 1] === '(') {
      const { inner, end } = readBalanced(s, this.i + 2);
      this.substitution(inner);
      w.subst = true;
      w.text += `$(${inner})`;
      this.i = end;
      return;
    }
    if (s[this.i + 1] === '{') {
      const end = s.indexOf('}', this.i + 2);
      const stop = end < 0 ? s.length : end + 1;
      w.text += s.slice(this.i, stop);
      w.param = true;
      this.i = stop;
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
