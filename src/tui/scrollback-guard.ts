/**
 * TUI-DESIGN-4 §1.4 — stop deleting the user's terminal history. Ink writes `ansi-escapes`' `clearTerminal` on every
 * clearing frame (a shrink resize, or any frame taller than the terminal), and that string is
 * `ESC[2J ESC[3J ESC[H` — **11 characters** (`node_modules/ansi-escapes/base.js:124–130`). `ESC[3J` erases the
 * terminal's *saved-lines* buffer: everything the user had scrolled through, including the shell history from before
 * `jevcode` started. Ink offers no hook (`resized()` does not reset `lastOutputHeight`; the public `clear()` does not
 * either), so the fix is a one-method write filter on the stream handed to `render()`.
 *
 * `guardStdout(stream)` returns a `Proxy` whose **only** trap is `write`. It rewrites the exact 11-character sequence
 * to the 7-character `ESC[2J ESC[H` (at most once per chunk) and passes everything else through untouched — Buffers,
 * zero-length barrier writes, both `write` overloads, the back-pressure return value, and every property Ink reads
 * (`isTTY`, `rows`, `columns`, `on/off/once`, `destroyed`, `writableEnded`, `_writableState`).
 *
 * It also answers §1.4 edge 12 (the **unbounded** duplication the rewrite would otherwise leave). Ink writes
 * `clearTerminal + fullStaticOutput + outputToRender` in **one** write (`ink.js:768`) and `fullStaticOutput` is
 * append-only for the whole session (`:354, :416`), so N clearing frames leave N+1 full copies of the transcript — and
 * clearing frames fire continuously while a user drags a window edge. When the guard rewrites a clear it therefore
 * **elides the `fullStaticOutput` prefix that immediately follows it in the same chunk**, leaving
 * `ESC[2J ESC[H` + the frame Ink is about to draw.
 *
 * The prefix is **only ever** what the guard has itself **observed** Ink write on the non-clearing static path
 * (`renderInteractiveFrame`: `this.log.clear()`, then `write(staticOutput)` as its **own** call, then the frame), and
 * the elision fires only when the clearing chunk literally starts with that observed text. It is never derived from
 * frame content: two consecutive clearing frames share their first dynamic line whenever the rule row is
 * width-invariant, so a longest-common-prefix rule would silently delete live frame rows and leave Ink's
 * `previousLineCount` larger than what is on screen — the exact damage this module exists to prevent. With nothing
 * observed yet the chunk is passed through with the rewrite only: the first copy is legitimately the screen.
 *
 * `log.clear()` is recognised **structurally**, not by an exact regex: ink writes
 * `buildReturnToBottomPrefix(cursorWasShown, …) + eraseLines(n)` (`log-update.js` `render.clear`,
 * `cursor-helpers.js:47–55`), and that prefix is non-empty on every frame of this product because the App hands
 * `setCursorPosition` to the Console, the Overlay and the Composer. Matching a bare `eraseLines(n)` would never fire.
 *
 * Not used by `--plain`, by a pipe or in CI (Ink never takes the clear branch, so the proxy is inert), and on old
 * Windows consoles `clearTerminal` carries no `3J` at all — which is why the terminal-matrix assertion is
 * "**no `3J` appears in the capture**", never "the filter fired". `src/cli/fatal.ts`'s `RESTORE` and
 * `installTerminalHygiene` keep writing to the raw stream.
 */

/** `ansi-escapes`' `clearTerminal` on POSIX: `eraseScreen + ESC[3J + ESC[H`, **11 characters** (measured). */
export const CLEAR_TERMINAL = '\u001b[2J\u001b[3J\u001b[H';
/** The same clear without the saved-lines erase — 7 characters (`ESC[2J` 4 + `ESC[H` 3; §1.4's prose says 9). */
export const CLEAR_SAFE = '\u001b[2J\u001b[H';

/** `ansi-escapes`' `eraseLines(n)` for n ≥ 1: `(ESC[2K ESC[1A)*` then `ESC[2K ESC[G`. `eraseLines(0)` is the empty string. */
const ERASE_LINES_ONLY = /^(?:\u001b\[2K\u001b\[1A)*\u001b\[2K\u001b\[G$/;
/** `cli-cursor` / log-update's hide escape — the first character of `buildReturnToBottomPrefix` when the cursor was shown. */
const HIDE_CURSOR = '\u001b[?25l';
/** `buildCursorSuffix` ends every frame write with the show escape once the App has placed the cursor — a static batch never does. */
const SHOW_CURSOR = '\u001b[?25h';
/** `ansiEscapes.cursorDown(n)` / `cursorUp(n)`, then `cursorTo(0)` — the two optional moves of `buildReturnToBottom`. */
const CURSOR_MOVE = /^\u001b\[\d*[AB]/;
const CURSOR_COLUMN = /^\u001b\[\d*G/;

/**
 * §1.4 finding 3: is this chunk ink's `log.clear()`? Strip an optional `ESC[?25l`, an optional `ESC[<n>A|B` and an
 * optional `ESC[<n>G` — `buildReturnToBottomPrefix` — and the remainder must be `eraseLines(n)`. `eraseLines(0)` is
 * empty, which only counts when the cursor prefix was there (a bare `ESC[G` is not a clear).
 */
export function isLogClearWrite(chunk: string): boolean {
  let s = chunk;
  const hidden = s.startsWith(HIDE_CURSOR);
  if (hidden) s = s.slice(HIDE_CURSOR.length);
  const move = CURSOR_MOVE.exec(s);
  if (move !== null) s = s.slice(move[0].length);
  const col = CURSOR_COLUMN.exec(s);
  if (col !== null) s = s.slice(col[0].length);
  if (s === '') return hidden;
  return ERASE_LINES_ONLY.test(s);
}

/** The elided static prefix is never trusted past this many characters (a runaway session must not grow the guard). */
export const STATIC_PREFIX_MAX = 8 * 1024 * 1024;

/** The subset of a writable stream the guard needs to see; everything else is forwarded by the proxy. */
export interface GuardedStream {
  write(chunk: unknown, encoding?: unknown, callback?: unknown): boolean;
}

/** The one-stream filter behind `guardStdout` (memoised there, so this runs at most once per underlying stream). */
function makeGuard<T extends GuardedStream>(stream: T): T {
  // what the guard has OBSERVED Ink write as static batches — its reconstruction of the append-only `fullStaticOutput`.
  // Never grown from frame content, so an elision can only ever remove bytes that were already written above the frame.
  let staticSeen = '';
  // the previous chunk was `log.clear()` and nothing else → the next write is the static batch (`ink.js:781–783`)
  let expectStatic = false;

  const filter = (chunk: string): string => {
    const at = chunk.indexOf(CLEAR_TERMINAL);
    if (at === -1) return chunk;
    const head = chunk.slice(0, at);
    const rest = chunk.slice(at + CLEAR_TERMINAL.length);
    // the shape Ink writes is `clear + fullStaticOutput + outputToRender`; anything with bytes before the clear is not it
    if (head !== '') return `${head}${CLEAR_SAFE}${rest}`;
    // §1.4 finding 2: the ONLY admissible prefix is the observed static text, and only when the chunk literally starts
    // with it. Nothing observed → no elision at all (the first copy is legitimately the screen).
    const elide = staticSeen !== '' && rest.length > staticSeen.length && rest.startsWith(staticSeen);
    return `${CLEAR_SAFE}${elide ? rest.slice(staticSeen.length) : rest}`;
  };

  const observe = (chunk: string): void => {
    const wasExpecting = expectStatic;
    expectStatic = isLogClearWrite(chunk);
    if (!wasExpecting || expectStatic) return;
    // a frame write ends with `buildCursorSuffix`'s show escape (the App places the cursor on every frame) and a
    // static batch never does; a clearing chunk is not a static batch either. Either shape means the `log.clear()`
    // we saw was not the `<Static>` path's, so nothing is learned rather than something wrong being learned.
    if (chunk === '' || chunk.endsWith(SHOW_CURSOR) || chunk.includes(CLEAR_TERMINAL)) return;
    if (staticSeen.length + chunk.length > STATIC_PREFIX_MAX) return;
    staticSeen += chunk;
  };

  const write = (chunk: unknown, a?: unknown, b?: unknown): boolean => {
    // §1.4 edge 1: only strings are inspected (Ink always writes strings; `patchConsole` and third-party writes may not)
    const out = typeof chunk === 'string' ? filter(chunk) : chunk;
    if (typeof chunk === 'string') observe(chunk);
    // §1.4 edge 3: both `write(chunk, encoding, cb)` and `write(chunk, cb)` forward; §1.4 edge 4: the return value is never buffered
    const target = stream as unknown as { write(c: unknown, x?: unknown, y?: unknown): boolean };
    if (b !== undefined) return target.write(out, a, b);
    if (a !== undefined) return target.write(out, a);
    return target.write(out);
  };

  return new Proxy(stream, {
    get(target, prop): unknown {
      if (prop === 'write') return write;
      const value = Reflect.get(target, prop, target) as unknown;
      // §1.4 edge 5: `on/off/once/end/…` must stay bound to the real stream, never to the proxy
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
    set(target, prop, value): boolean {
      return Reflect.set(target, prop, value, target);
    },
  }) as T;
}

/**
 * §1.4 edge 6: Ink keys its instance map by the stream **object** (`render.js:45–58`), so a second
 * `createTuiRenderer` on the same terminal must be handed the **same** proxy or Ink mounts a second instance on one
 * stdout instead of re-rendering the first. One proxy per underlying stream, for the life of the process.
 */
const GUARDED = new WeakMap<GuardedStream, GuardedStream>();

/**
 * TUI-DESIGN-4 §1.4: the write filter. The returned object **is** the stream for every purpose, and
 * `guardStdout(process.stdout)` is stable — the same proxy comes back on every call.
 */
export function guardStdout<T extends GuardedStream>(stream: T): T {
  const cached = GUARDED.get(stream);
  if (cached !== undefined) return cached as T;
  // an already-guarded stream is its own guard (a double wrap would elide twice and re-observe its own output)
  if (isGuarded(stream)) return stream;
  const proxy = makeGuard(stream);
  GUARDED.set(stream, proxy);
  GUARDED.set(proxy, proxy);
  return proxy;
}

/** true when `stream` is already a `guardStdout` proxy (the identity `GUARDED.get(x) === x`). */
export function isGuarded(stream: GuardedStream): boolean {
  return GUARDED.get(stream) === stream;
}
