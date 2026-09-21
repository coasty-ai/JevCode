/**
 * Notifications (TUI-DESIGN §14.1 "Notifications", §6.3, C48, A85): `--notify` / `ui.notify`, default off, on in
 * screen-reader mode. BEL everywhere; OSC 9 on iTerm2 / Ghostty / WezTerm / foot; OSC 99 on kitty; wrapped in a
 * tmux DCS passthrough inside tmux. The payload is a redacted one-liner that never starts `<digit>;` (an OSC 9
 * body starting that way is read as a different sub-command by some terminals). Timers: the review timer starts
 * when the deferred box appears, restarts on every keystroke and fires at ~6 s; the run-end timer starts at
 * `run:end`, is cancelled by any keystroke and fires at ~60 s; also at 95 % and `budget:stop`. Pure except the
 * injected timers and writer.
 */
export type NotifyMethod = 'bel' | 'osc9' | 'osc99';

/** TUI-DESIGN §14.1: the review box has been visible, untouched, for this long. */
export const REVIEW_NOTIFY_MS = 6000;
/** TUI-DESIGN §14.1: the run ended and no key followed for this long. */
export const RUN_END_NOTIFY_MS = 60_000;
/** Payload cap (one line; terminals truncate long titles anyway). */
export const NOTIFY_TEXT_MAX = 200;
export const BEL = '\x07';

/** TUI-DESIGN §14.1 terminal table: OSC 9 for iTerm2 / Ghostty / WezTerm / foot, OSC 99 for kitty, BEL otherwise. Never a query. */
export function detectNotifyMethod(env: NodeJS.ProcessEnv): NotifyMethod {
  const program = (env['TERM_PROGRAM'] ?? '').toLowerCase();
  const term = (env['TERM'] ?? '').toLowerCase();
  if (term.includes('kitty') || env['KITTY_WINDOW_ID'] !== undefined) return 'osc99';
  if (program === 'iterm.app' || program === 'ghostty' || program === 'wezterm' || program === 'foot' || term.startsWith('foot') || env['WEZTERM_PANE'] !== undefined || env['GHOSTTY_RESOURCES_DIR'] !== undefined) return 'osc9';
  return 'bel';
}

/** true inside tmux (`TMUX` set): sequences need the DCS passthrough wrapper. */
export function insideTmux(env: NodeJS.ProcessEnv): boolean {
  const v = env['TMUX'];
  return v !== undefined && v !== '';
}

// C0 (minus nothing: a payload has no line structure), DEL, C1 and the OSC terminators.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * TUI-DESIGN §14.1: the payload — redacted, one line, control characters dropped, ≤ 200 chars, and never starting
 * `<digit>;` (prefixed `jevcode: ` when it would). Pure.
 */
export function notifyPayload(text: string, redact: (s: string) => string = (s) => s): string {
  let t = redact(text).replace(/\r\n|\r|\n|\t/g, ' ').replace(CONTROL_RE, '').replace(/ {2,}/g, ' ').trim();
  if (/^\d;/.test(t) || /^\d+;/.test(t)) t = `jevcode: ${t}`;
  if (t.length > NOTIFY_TEXT_MAX) t = `${t.slice(0, NOTIFY_TEXT_MAX - 1)}…`;
  return t;
}

/** TUI-DESIGN §14.1: the tmux DCS passthrough — `ESC P tmux; <seq with every ESC doubled> ESC \`. */
export function tmuxPassthrough(seq: string): string {
  return `\x1bPtmux;${seq.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`;
}

/** TUI-DESIGN §14.1: the bytes for one notification; the payload is already `notifyPayload`ed by the caller. */
export function notifySequence(method: NotifyMethod, payload: string, opts: { tmux?: boolean } = {}): string {
  let seq: string;
  switch (method) {
    case 'bel':
      return BEL; // a BEL passes through tmux as is
    case 'osc9':
      seq = `\x1b]9;${payload}\x07`;
      break;
    case 'osc99':
      seq = `\x1b]99;;${payload}\x1b\\`;
      break;
  }
  return opts.tmux === true ? tmuxPassthrough(seq) : seq;
}

export type NotifyKind = 'review' | 'run-end' | 'budget';

export interface NotifyTimersDeps {
  fire: (kind: NotifyKind) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  reviewMs?: number;
  runEndMs?: number;
}

export interface NotifyTimers {
  /** the deferred review box appeared (starts / restarts the 6 s timer) */
  reviewShown(): void;
  /** the review resolved (cancels the review timer) */
  reviewGone(): void;
  /** any keystroke: restarts the review timer while a review is shown, cancels the run-end timer */
  keystroke(): void;
  /** `run:end`: starts the 60 s timer */
  runEnded(): void;
  /** `budget:warn` at 95 % / `budget:stop`: fires at once */
  budget(): void;
  cancel(): void;
  /** for tests */
  readonly pending: readonly NotifyKind[];
}

/** TUI-DESIGN §14.1 / §6.3 timers, injectable clock. */
export function createNotifyTimers(deps: NotifyTimersDeps): NotifyTimers {
  const set = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clear = deps.clearTimeout ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  const reviewMs = deps.reviewMs ?? REVIEW_NOTIFY_MS;
  const runEndMs = deps.runEndMs ?? RUN_END_NOTIFY_MS;
  let review: unknown = null;
  let runEnd: unknown = null;
  let reviewShown = false;
  const armReview = (): void => {
    if (review !== null) clear(review);
    review = set(() => {
      review = null;
      deps.fire('review');
    }, reviewMs);
  };
  const timers: NotifyTimers = {
    reviewShown() {
      reviewShown = true;
      armReview();
    },
    reviewGone() {
      reviewShown = false;
      if (review !== null) clear(review);
      review = null;
    },
    keystroke() {
      if (runEnd !== null) clear(runEnd);
      runEnd = null;
      if (reviewShown) armReview();
    },
    runEnded() {
      if (runEnd !== null) clear(runEnd);
      runEnd = set(() => {
        runEnd = null;
        deps.fire('run-end');
      }, runEndMs);
    },
    budget() {
      deps.fire('budget');
    },
    cancel() {
      timers.reviewGone();
      if (runEnd !== null) clear(runEnd);
      runEnd = null;
    },
    get pending(): readonly NotifyKind[] {
      const out: NotifyKind[] = [];
      if (review !== null) out.push('review');
      if (runEnd !== null) out.push('run-end');
      return out;
    },
  };
  return timers;
}

export interface NotifierDeps {
  write: (s: string) => void;
  env: NodeJS.ProcessEnv;
  /** `ui.notify` (default off; on in screen-reader mode) */
  enabled: () => boolean;
  redact?: (s: string) => string;
  method?: NotifyMethod;
}

/** TUI-DESIGN §14.1: one notifier bound to a writer — `notify(text)` writes the sequence when enabled. */
export function createNotifier(d: NotifierDeps): { notify(text: string): boolean; method: NotifyMethod } {
  const method = d.method ?? detectNotifyMethod(d.env);
  const tmux = insideTmux(d.env);
  return {
    method,
    notify(text) {
      if (!d.enabled()) return false;
      try {
        d.write(notifySequence(method, notifyPayload(text, d.redact), { tmux }));
      } catch {
        return false;
      }
      return true;
    },
  };
}
