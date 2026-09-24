/** Bounds shared by the parsers and the state builders, so Jev never sees unbounded text. */

/** expected / actual / call values (the probe truncated at 240 chars) */
export const VALUE_BOUND = 240;
/** raw output tail kept on the summary */
export const OUTPUT_TAIL_BOUND = 4000;
/** synthetic test id for "the run itself failed" (timeout, crash with no results) */
export const RUN_FAILURE_ID = '<test run>';

export function bound(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function tail(s: string, max = OUTPUT_TAIL_BOUND): string {
  return s.length > max ? s.slice(s.length - max) : s;
}

/** POSIX single-quote quoting for `sh -c` (same as sbfl/run.ts; copied to keep modules independent). */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
