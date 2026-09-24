/**
 * Typed errors for the Python source utilities. Standalone (not JevCodeError): this
 * library is dependency-free so candidate sources and tests can use it anywhere.
 */

export type PyTokenizeErrorKind =
  /** Unbalanced brackets or a trailing backslash continuation at end of input. */
  | 'eof_in_statement'
  /** A triple-quoted (or f-string) literal that never closes. */
  | 'eof_in_string'
  /** A dedent to a column that matches no enclosing indentation level. */
  | 'inconsistent_dedent';

export class PyTokenizeError extends Error {
  readonly kind: PyTokenizeErrorKind;
  /** 1-based line and 0-based column of the offending position. */
  readonly line: number;
  readonly col: number;
  constructor(kind: PyTokenizeErrorKind, line: number, col: number, message?: string) {
    super(message ?? `${kind.replace(/_/g, ' ')} at line ${line}, column ${col}`);
    this.name = new.target.name;
    this.kind = kind;
    this.line = line;
    this.col = col;
  }
}

/** Mirrors CPython's IndentationError("unindent does not match any outer indentation level"). */
export class PyIndentationError extends PyTokenizeError {
  constructor(line: number, col: number) {
    super('inconsistent_dedent', line, col, `unindent does not match any outer indentation level (line ${line})`);
  }
}

/** A line-based edit named a line that does not exist. */
export class PyEditError extends Error {
  readonly line: number;
  readonly lineCount: number;
  constructor(line: number, lineCount: number) {
    super(`line ${line} is out of range (source has ${lineCount} line${lineCount === 1 ? '' : 's'})`);
    this.name = new.target.name;
    this.line = line;
    this.lineCount = lineCount;
  }
}
