/**
 * The key registry (TUI-DESIGN §3.2, §3.4, F4, F14): every bindable action with its `namespace:action`
 * id, its context, its default keys and a one-line title. One typed array feeds `resolveKey`, the help
 * block, `docs/KEYS.md` (scripts/gen-docs.mjs) and the keybindings-file loader. Pure: no I/O.
 *
 * Key strings are canonical: modifiers `ctrl+` `meta+` `shift+` in that order, then a base key — a
 * single lower-case character (`k`, `?`, `/`, `_`) or a name (`up`, `return`, `escape`, `tab`, `f1`,
 * …). A chord is two key strings separated by one space (`ctrl+x ctrl+s`, §3.4), completed within 3 s.
 */

/**
 * TUI-DESIGN §3.4: the contexts a binding can live in (precedence order is §3.1's).
 * TUI-DESIGN-5 §4.3 adds `'agents'` — the `'a'` pane tab's own keys, which resolve **only** while
 * `ui.paneFocus && ui.tab === 'a'` (`src/tui/keys/resolve.ts`'s one new rung, between Picker and Composer).
 * Without a focus model those eight single letters would type into the composer (§14.2 #41).
 */
export type KeyContext = 'global' | 'composer' | 'review' | 'picker' | 'agents' | 'palette';

/** TUI-DESIGN §3.4: contexts in the order help and docs list them. */
export const KEY_CONTEXTS: readonly KeyContext[] = ['global', 'composer', 'review', 'picker', 'agents', 'palette'];

/**
 * TUI-DESIGN-5 §4.3 / §12.3 S86: the pane-tab letters the two `global:paneNext` / `global:panePrev` titles are
 * **computed** from, instead of the two static strings round 2 spelled out at `:72–73`.
 *
 * The list is repeated here rather than imported from `src/tui/pane/model.ts`: that module reaches
 * `config/defaults.js`, `jev/confidence.js` and `loop/plan.js`, and this one has **zero** imports today — a
 * property gate G-R5-1 depends on. `test/unit/tui/keys/bindings.test.ts` pins `PANE_TAB_KEYS` against `PANE_TABS` and
 * `[...PANE_TAB_KEYS, AGENTS_TAB_KEY]` against `PANE_TABS_WITH_AGENTS`, so the two can never drift.
 */
export const PANE_TAB_KEYS: readonly string[] = ['d', 'p', 't', 's'];
/** TUI-DESIGN-5 §4.3: the fifth tab, present only while something delegates. */
export const AGENTS_TAB_KEY = 'a';

/** TUI-DESIGN-5 §12.3 S86: `next pane tab (d → p → t → s, + a while delegating)` / `previous pane tab; opens a collapsed panel`. */
export function paneTabTitle(dir: 1 | -1): string {
  const cycle = PANE_TAB_KEYS.join(' → ');
  return dir === 1 ? `next pane tab (${cycle}, + ${AGENTS_TAB_KEY} while delegating); opens a collapsed panel` : 'previous pane tab; opens a collapsed panel';
}

/** TUI-DESIGN §3.2/§3.4: one bindable action of the registry. */
export interface KeyActionSpec {
  /** `namespace:action` (§3.4); the namespace is the context except `session:*`, `files:*` and `ui:*`, which are global (TUI-DESIGN-3 §4.5) */
  readonly id: string;
  /** a compact label for the help block (§5.3) and the KEYS.md table */
  readonly short: string;
  readonly context: KeyContext;
  /** default key strings (empty = unbound until the keybindings file binds it) */
  readonly keys: readonly string[];
  /** one-line title for help and docs */
  readonly title: string;
  /** when the binding applies (help/docs only; the resolver enforces it) */
  readonly when?: string;
  /** A24: reserved keys are structural — never rebindable, refused by the loader */
  readonly reserved?: boolean;
  /** free-text note for docs (§3.2 "Notes" column) */
  readonly note?: string;
}

/** TUI-DESIGN §3.2/§3.4 (A24): keys that are never rebindable — Ctrl+C, Ctrl+D, Ctrl+M, Ctrl+[, Ctrl+I. */
export const RESERVED_KEYS: readonly string[] = ['ctrl+c', 'ctrl+d', 'ctrl+m', 'return', 'ctrl+[', 'escape', 'ctrl+i', 'tab'];

const NAMED_KEYS: ReadonlySet<string> = new Set([
  'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'return', 'escape', 'tab', 'backspace', 'delete', 'insert', 'space',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
]);

const KEY_ALIASES: Readonly<Record<string, string>> = {
  enter: 'return',
  cr: 'return',
  esc: 'escape',
  pgup: 'pageup',
  pgdn: 'pagedown',
  pgdown: 'pagedown',
  del: 'delete',
  bs: 'backspace',
  spc: 'space',
  ' ': 'space',
  'ctrl+-': 'ctrl+_',
  'ctrl+m': 'return',
  'ctrl+[': 'escape',
  'ctrl+i': 'tab',
  'ctrl+h': 'backspace',
};

/** TUI-DESIGN §3.2/§3.4: the registry — one row per bindable action, defaults per the §3.2 table. */
export const KEY_ACTIONS: readonly KeyActionSpec[] = [
  // global
  { id: 'global:exit', short: 'exit (×2) / abort', context: 'global', keys: ['ctrl+c'], title: 'idle: press twice within 1.5 s to exit; live: abort the run (with a draft: clear it)', reserved: true, note: 'F5 matrix (§3.3)' },
  { id: 'global:exitOrDelete', short: 'exit (×2) / delete', context: 'global', keys: ['ctrl+d'], title: 'empty draft: press twice within 800 ms to exit (live: choose abort-and-exit or stay); with text: delete forward', reserved: true, note: 'F5 matrix (§3.3)' },
  { id: 'global:escape', short: 'pause · Esc Esc menu / clear / abort', context: 'global', keys: ['escape'], title: 'idle: Esc Esc opens the rewind/steer menu; text: Esc Esc clears the draft; live: pause, Esc Esc aborts (a reply with no tool call yet: stop it); review: decline', reserved: true, note: 'F5 matrix (§3.3); 30 ms re-buffer for Alt chords; AGENT-LOOP-DESIGN §A5' },
  { id: 'global:help', short: 'help', context: 'global', keys: ['?', 'f1'], title: 'append the help block to the transcript', when: '`?` on an empty draft' },
  { id: 'global:detail', short: 'details', context: 'global', keys: ['ctrl+o'], title: 'append the last step\'s decision details and recent warnings; acknowledges !n' },
  { id: 'global:repaint', short: 'repaint', context: 'global', keys: ['ctrl+l'], title: 'repaint the dynamic region (erase-lines + rewrite, never a clear)' },
  { id: 'global:suspend', short: 'suspend', context: 'global', keys: ['ctrl+z'], title: 'suspend to the shell (fg resumes and repaints)' },
  { id: 'global:paneNext', short: 'next tab', context: 'global', keys: [']'], title: paneTabTitle(1), when: 'empty draft', note: 'TUI-DESIGN-2 §4.6; TUI-DESIGN-5 §4.3 (the title is computed from the tab list)' },
  { id: 'global:panePrev', short: 'previous tab', context: 'global', keys: ['['], title: paneTabTitle(-1), when: 'empty draft', note: 'TUI-DESIGN-2 §4.6; TUI-DESIGN-5 §4.3' },
  // TUI-DESIGN-5 §4.3 / §7 row 99: Alt+A focuses the agents tab (and `/agents` opens *and* focuses it); Esc
  // unfocuses. Focus is REFUSED while the draft is non-empty — the same `when: 'empty draft'` guard
  // `global:paneNext` carries — and answers S86a, so eight single letters can never eat a half-typed line.
  { id: 'global:paneFocus', short: 'focus agents', context: 'global', keys: ['meta+a'], title: 'focus the agents tab so its keys resolve (Esc unfocuses); refused with a non-empty draft', when: 'empty draft, while something delegates', note: 'TUI-DESIGN-5 §4.3' },
  // TUI-DESIGN-2 §4.6 / §12 "Keys and commands": the Jev panel — collapsed strip · open (≤ 6 rows) · full (12 rows)
  { id: 'global:panelToggle', short: 'panel', context: 'global', keys: ['meta+j'], title: 'toggle the Jev panel between the collapsed strip and the open 6-row form (= /panel, /panel off)', note: 'TUI-DESIGN-2 §4.6' },
  { id: 'global:panelFull', short: 'panel full', context: 'global', keys: ['meta+shift+j'], title: 'open the Jev panel in its full 12-row form (= /panel full)', note: 'TUI-DESIGN-2 §4.6' },
  { id: 'global:panelDecisions', short: 'decisions tab', context: 'global', keys: ['meta+d'], title: 'open the panel on the decisions tab; a second press on the same tab collapses it (= /panel d)', note: 'TUI-DESIGN-2 §4.6; Alt+D leaves kill-word-forward (Alt+Del / Ctrl+Del keep it)' },
  { id: 'global:panelPlan', short: 'plan tab', context: 'global', keys: ['meta+p'], title: 'open the panel on the plan tab; a second press collapses it (= /panel p)', note: 'TUI-DESIGN-2 §4.6' },
  { id: 'global:panelTimeline', short: 'timeline tab', context: 'global', keys: ['meta+t'], title: 'open the panel on the timeline tab; a second press collapses it (= /panel t)', note: 'TUI-DESIGN-2 §4.6' },
  { id: 'global:panelSynth', short: 'synth tab', context: 'global', keys: ['meta+s'], title: 'open the panel on the synth tab; a second press collapses it (= /panel s)', note: 'TUI-DESIGN-2 §4.6' },
  { id: 'session:export', short: 'export', context: 'global', keys: [], title: 'export the session transcript (= /export)', note: 'unbound by default; e.g. "session:export": "ctrl+x ctrl+s"' },
  // TUI-DESIGN-3 §4.5: keys that equal commands — unbound by default (every free printable is text, every free Ctrl is a terminal risk); a user binds e.g. "session:cost": "ctrl+x c"
  { id: 'session:cost', short: 'cost', context: 'global', keys: [], title: 'run and session spend (= /cost)', note: 'unbound by default; e.g. "session:cost": "ctrl+x c" (TUI-DESIGN-3 §4.5)' },
  { id: 'session:status', short: 'status', context: 'global', keys: [], title: 'run id, session id, step, stage, sandbox, workspace (= /status)', note: 'unbound by default (TUI-DESIGN-3 §4.5)' },
  { id: 'session:mode', short: 'mode', context: 'global', keys: [], title: 'show the engine mode and the next run\'s (= /mode)', note: 'unbound by default (TUI-DESIGN-3 §4.5)' },
  { id: 'files:diff', short: 'diff', context: 'global', keys: [], title: 'numstat block of the run\'s changes (= /diff)', note: 'unbound by default (TUI-DESIGN-3 §4.5)' },
  { id: 'files:undo', short: 'undo', context: 'global', keys: [], title: 'restore the files a step changed (= /undo; opens the undo confirm)', note: 'unbound by default (TUI-DESIGN-3 §4.5)' },
  { id: 'ui:copy', short: 'copy', context: 'global', keys: [], title: 'copy the last item, redacted (= /copy)', note: 'unbound by default (TUI-DESIGN-3 §4.5)' },
  // composer
  { id: 'composer:submit', short: 'submit', context: 'composer', keys: ['return'], title: 'submit: task, follow-up, steer while live, /command, review note', reserved: true, note: 'empty draft → no-op; re-entrancy guard while submitting (A9)' },
  { id: 'composer:newline', short: 'newline', context: 'composer', keys: ['ctrl+j', 'meta+return', 'shift+return'], title: 'insert a newline', note: 'also a trailing \\ before Enter; xterm CSI 27;m;13~ is swallowed as newline (R7)' },
  { id: 'composer:lineStart', short: 'line start', context: 'composer', keys: ['ctrl+a', 'home'], title: 'start of the logical line' },
  { id: 'composer:lineEnd', short: 'line end', context: 'composer', keys: ['ctrl+e', 'end'], title: 'end of the logical line' },
  { id: 'composer:left', short: 'left', context: 'composer', keys: ['ctrl+b', 'left'], title: 'move one grapheme left' },
  { id: 'composer:right', short: 'right', context: 'composer', keys: ['ctrl+f', 'right'], title: 'move one grapheme right; at the end of the text accepts the ghost completion' },
  { id: 'composer:wordLeft', short: 'word left', context: 'composer', keys: ['meta+b', 'ctrl+left'], title: 'word left (Intl.Segmenter word; / - _ . separate)' },
  { id: 'composer:wordRight', short: 'word right', context: 'composer', keys: ['meta+f', 'ctrl+right'], title: 'word right' },
  { id: 'composer:killLine', short: 'kill to end', context: 'composer', keys: ['ctrl+k'], title: 'kill to the end of the line → kill ring' },
  { id: 'composer:killLineBack', short: 'kill to start', context: 'composer', keys: ['ctrl+u'], title: 'kill to the start of the line → kill ring' },
  { id: 'composer:killWordBack', short: 'kill word back', context: 'composer', keys: ['ctrl+w', 'meta+backspace'], title: 'kill the word before the cursor (unix-word-rubout)' },
  { id: 'composer:killWordForward', short: 'kill word forward', context: 'composer', keys: ['meta+delete', 'ctrl+delete'], title: 'kill the word after the cursor', note: 'Alt+D is the decisions tab (TUI-DESIGN-2 §4.6)' },
  { id: 'composer:yank', short: 'yank', context: 'composer', keys: ['ctrl+y'], title: 'yank the newest kill' },
  { id: 'composer:yankPop', short: 'yank-pop', context: 'composer', keys: ['meta+y'], title: 'rotate the kill ring (right after a yank)' },
  { id: 'composer:transpose', short: 'transpose', context: 'composer', keys: ['ctrl+t'], title: 'transpose the two graphemes around the cursor' },
  { id: 'composer:undo', short: 'undo', context: 'composer', keys: ['ctrl+_'], title: 'undo (100 snapshots)', note: 'Ctrl+- sends the same byte on most terminals' },
  { id: 'composer:redo', short: 'redo', context: 'composer', keys: ['ctrl+^'], title: 'redo' },
  { id: 'composer:backspace', short: 'delete back', context: 'composer', keys: ['backspace'], title: 'delete back; a paste chip is removed whole', note: 'Ctrl+H is the same key' },
  { id: 'composer:delete', short: 'delete forward', context: 'composer', keys: ['delete'], title: 'delete forward; a paste chip is removed whole', note: 'Ctrl+D with text does the same (§3.3)' },
  { id: 'composer:up', short: 'up / history', context: 'composer', keys: ['up'], title: 'move up one visual row; on the first row: history prev; with steers queued and an empty draft: take the newest steer back' },
  { id: 'composer:down', short: 'down / history', context: 'composer', keys: ['down'], title: 'move down one visual row; on the last row: history next' },
  { id: 'composer:historyPrev', short: 'history prev', context: 'composer', keys: ['ctrl+p'], title: 'history prev (always)' },
  { id: 'composer:historyNext', short: 'history next', context: 'composer', keys: ['ctrl+n'], title: 'history next (always)' },
  { id: 'composer:historySearch', short: 'history search', context: 'composer', keys: ['ctrl+r'], title: 'reverse-incremental history search (Ctrl+R older, Ctrl+S newer, Tab/→ accept, Enter accept + submit, Esc restore; Ctrl+A widens to all workspaces)' },
  { id: 'composer:complete', short: 'complete', context: 'composer', keys: ['tab'], title: 'completion: palette, mention or argument — accept or cycle; never focus', reserved: true },
  { id: 'composer:completeBack', short: 'complete back', context: 'composer', keys: ['shift+tab'], title: 'cycle completion backwards' },
  { id: 'composer:palette', short: 'palette', context: 'composer', keys: ['/'], title: 'open the command palette pre-filled with /', when: 'column 0 of an empty draft', note: 'never mid-prompt (judge-ux C4)' },
  { id: 'composer:mention', short: '@ file', context: 'composer', keys: ['@'], title: 'open the @ file mention popup over the candidate list' },
  { id: 'composer:externalEditor', short: 'external editor', context: 'composer', keys: ['ctrl+g'], title: 'edit the draft in $VISUAL / $EDITOR (refused while the draft holds a secret)' },
  // review
  { id: 'review:approve', short: 'approve', context: 'review', keys: ['y'], title: 'approve the proposed action once', reserved: true, note: 'the only key that ever approves (§6.2 invariant: never rebindable, and no other action may take y in the review box); armed one frame after the box is drawn (§6.3)' },
  { id: 'review:decline', short: 'decline', context: 'review', keys: ['n'], title: 'decline', note: 'Esc declines too' },
  { id: 'review:declineNote', short: 'decline + note', context: 'review', keys: ['d'], title: 'decline with a note (the composer row becomes the note field)' },
  { id: 'review:expand', short: 'expand', context: 'review', keys: ['e'], title: 'expand / collapse the preview' },
  { id: 'review:why', short: '1-5 why', context: 'review', keys: ['w'], title: 'then 1–5 within 1.5 s: append the /why block for that dimension (5 = matches_intent)' },
  { id: 'review:abortRun', short: 'abort run / clear draft', context: 'review', keys: ['ctrl+c'], title: 'empty draft: abort the run (the rejected confirm() is the decline); with a draft: clear the draft, the box stays', reserved: true },
  // picker
  { id: 'picker:up', short: 'up', context: 'picker', keys: ['up', 'ctrl+p'], title: 'previous row' },
  { id: 'picker:down', short: 'down', context: 'picker', keys: ['down', 'ctrl+n'], title: 'next row' },
  { id: 'picker:pageUp', short: 'page up', context: 'picker', keys: ['pageup'], title: 'page up' },
  { id: 'picker:pageDown', short: 'page down', context: 'picker', keys: ['pagedown'], title: 'page down' },
  { id: 'picker:open', short: 'continue', context: 'picker', keys: ['return'], title: 'continue / resume the highlighted row', reserved: true },
  { id: 'picker:accept', short: 'accept', context: 'picker', keys: ['tab'], title: 'accept the row and keep filtering', reserved: true },
  { id: 'picker:preview', short: 'preview', context: 'picker', keys: ['space'], title: 'preview the highlighted run (plan counts, spend, stop)' },
  { id: 'picker:allWorkspaces', short: 'all workspaces', context: 'picker', keys: ['ctrl+a'], title: 'toggle all workspaces' },
  { id: 'picker:rename', short: 'rename', context: 'picker', keys: ['ctrl+r'], title: 'rename the highlighted session inline' },
  { id: 'picker:delete', short: 'then y: delete', context: 'picker', keys: ['x'], title: 'then y: move the run directory to ~/.jevcode/trash/ (never rm -rf)' },
  { id: 'picker:close', short: 'close', context: 'picker', keys: ['escape'], title: 'close the picker', reserved: true },
  // TUI-DESIGN-5 §2.8 / §7 row 91 (R5-1's rows, landed here by R5-4 with `keys/resolve.ts`): the resume card is a
  // focused SUB-STATE of the picker, not four more picker keys — the picker's composer IS its filter
  // (`src/session/picker-lines.ts:1–33`) and `picker:delete` already owns a bare `x`, so binding r/f/d/w at picker
  // scope would take four more letters away from filter typing. These four resolve **only while `card !== null`**.
  // `cardOpen` / `cardClose` carry no keys of their own: Enter and Esc are `picker:open` / `picker:close`, which the
  // resolver re-reads in the sub-state (Enter on a row opens the card; Esc closes it back to the list).
  { id: 'picker:cardOpen', short: 'open card', context: 'picker', keys: [], title: 'Enter on a row opens its expanded card (the four card letters resolve only there)', when: 'no card open', note: 'TUI-DESIGN-5 §2.8; the key is `picker:open`\'s Enter' },
  { id: 'picker:cardClose', short: 'close card', context: 'picker', keys: [], title: 'Esc returns to the list', when: 'the card is open', note: 'TUI-DESIGN-5 §2.8; the key is `picker:close`\'s Esc' },
  { id: 'picker:cardReplay', short: 'replay', context: 'picker', keys: ['r'], title: 'resume by replaying the paused proposal (only when it is still replayable)', when: 'the card is open', note: 'TUI-DESIGN-5 §2.8' },
  { id: 'picker:cardFresh', short: 'fresh', context: 'picker', keys: ['f'], title: 'resume with a fresh step instead of the paused proposal', when: 'the card is open', note: 'TUI-DESIGN-5 §2.8' },
  { id: 'picker:cardDiff', short: 'diff', context: 'picker', keys: ['d'], title: 'diff the workspace since the pause', when: 'the card is open', note: 'TUI-DESIGN-5 §2.8' },
  { id: 'picker:cardWho', short: 'who', context: 'picker', keys: ['w'], title: 'who else is live on this repo right now', when: 'the card is open', note: 'TUI-DESIGN-5 §2.8' },
  // agents (TUI-DESIGN-5 §4.3, F-54's keys row) — resolve only while `ui.paneFocus && ui.tab === 'a'`
  { id: 'agents:attach', short: 'attach', context: 'agents', keys: ['return'], title: 'attach to the highlighted agent read-only (its transcript tails into the pane)', reserved: true, note: 'TUI-DESIGN-5 §4.3' },
  { id: 'agents:pause', short: 'pause', context: 'agents', keys: ['p'], title: 'pause the highlighted agent at its next step (= /agent <slug> pause)', note: 'TUI-DESIGN-5 §4.3' },
  { id: 'agents:steer', short: 'steer', context: 'agents', keys: ['t'], title: 'steer the highlighted agent (the composer row becomes the steer field)', note: 'TUI-DESIGN-5 §4.3' },
  { id: 'agents:budget', short: 'budget', context: 'agents', keys: ['+'], title: 'raise the highlighted agent\'s cap (= /agent <slug> budget)', note: 'TUI-DESIGN-5 §4.3' },
  { id: 'agents:diff', short: 'diff', context: 'agents', keys: ['d'], title: 'the highlighted agent\'s diff against the base (= /agent <slug> diff)', note: 'TUI-DESIGN-5 §4.3' },
  { id: 'agents:kick', short: 'kick', context: 'agents', keys: ['k'], title: 'kick the highlighted agent once (= /agent <slug> kick)', note: 'TUI-DESIGN-5 §4.3' },
  { id: 'agents:drop', short: 'then x: drop', context: 'agents', keys: ['x x'], title: 'then x again: drop the agent — its uncommitted diff is lost, which is why it takes two keys', note: 'TUI-DESIGN-5 §4.3 (tmux choose-tree kills a pane with one x; a pane kill loses no committed work)' },
  { id: 'agents:land', short: 'land', context: 'agents', keys: ['l'], title: 'land the highlighted agent into the dock (= /agent <slug> land)', note: 'TUI-DESIGN-5 §4.3' },
  // palette
  { id: 'palette:up', short: 'up', context: 'palette', keys: ['up', 'ctrl+p'], title: 'previous row' },
  { id: 'palette:down', short: 'down', context: 'palette', keys: ['down', 'ctrl+n'], title: 'next row' },
  { id: 'palette:pageUp', short: 'page up', context: 'palette', keys: ['pageup'], title: 'page up' },
  { id: 'palette:pageDown', short: 'page down', context: 'palette', keys: ['pagedown'], title: 'page down' },
  { id: 'palette:accept', short: 'complete', context: 'palette', keys: ['tab'], title: 'put the highlighted row in the draft', reserved: true },
  { id: 'palette:run', short: 'run exact match', context: 'palette', keys: ['return'], title: 'run the armed draft; otherwise move to the next row', reserved: true },
  { id: 'palette:close', short: 'close', context: 'palette', keys: ['escape'], title: 'close (the draft is kept; the token is remembered so / stays closed while it is unchanged)', reserved: true },
];

const BY_ID: ReadonlyMap<string, KeyActionSpec> = new Map(KEY_ACTIONS.map((a) => [a.id, a]));

/** TUI-DESIGN-3 §4.5: the unbound-by-default actions that equal a slash command — action id → the `/line` the App runs. */
export const COMMAND_KEY_ACTIONS: Readonly<Record<string, string>> = {
  'session:export': '/export',
  'session:cost': '/cost',
  'session:status': '/status',
  'session:mode': '/mode',
  'files:diff': '/diff',
  'files:undo': '/undo',
  'ui:copy': '/copy',
};

/** TUI-DESIGN §3.4: the registry row for an action id, or null. */
export function keyActionById(id: string): KeyActionSpec | null {
  return BY_ID.get(id) ?? null;
}

/** TUI-DESIGN §3.4: canonicalise one key token (`Ctrl+K`, `alt+b`, `Enter`) → `ctrl+k`, `meta+b`, `return`; null when malformed. */
export function normalizeKeyToken(token: string): string | null {
  const raw = token.trim();
  if (raw === '') return null;
  const lower = raw.toLowerCase();
  if (KEY_ALIASES[lower] !== undefined) return KEY_ALIASES[lower] as string;
  // split on '+' but keep a trailing '+' base (`ctrl++`)
  const parts: string[] = [];
  let buf = '';
  for (let n = 0; n < lower.length; n++) {
    const ch = lower[n] as string;
    if (ch === '+' && buf !== '' && n < lower.length - 1) {
      parts.push(buf);
      buf = '';
    } else buf += ch;
  }
  parts.push(buf);
  let ctrl = false;
  let meta = false;
  let shift = false;
  const base = parts.pop() as string;
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control' || p === 'c') ctrl = true;
    else if (p === 'meta' || p === 'alt' || p === 'option' || p === 'm' || p === 'a') meta = true;
    else if (p === 'shift' || p === 's') shift = true;
    else return null;
  }
  const key = KEY_ALIASES[base] ?? base;
  if (key.length !== 1 && !NAMED_KEYS.has(key)) return null;
  // a shifted single character is the character itself (`?` is `?`, never `shift+/`); under ctrl/meta a shifted letter
  // keeps its shift (`meta+shift+j` = Alt+Shift+J, TUI-DESIGN-2 §4.6)
  if (key.length === 1 && shift && !((ctrl || meta) && /^[a-z]$/.test(key))) shift = false;
  const s = `${ctrl ? 'ctrl+' : ''}${meta ? 'meta+' : ''}${shift ? 'shift+' : ''}${key}`;
  return KEY_ALIASES[s] ?? s;
}

/** TUI-DESIGN §3.4: parse a binding value (one key or a two-key chord separated by a space); null when malformed. */
export function normalizeKeyString(value: string): string | null {
  const tokens = value.trim().split(/\s+/).filter((t) => t !== '');
  if (tokens.length === 0 || tokens.length > 2) return null;
  const out: string[] = [];
  for (const t of tokens) {
    const k = normalizeKeyToken(t);
    if (k === null) return null;
    out.push(k);
  }
  return out.join(' ');
}

/** TUI-DESIGN §3.4 (A24): true when a canonical key string (or either key of a chord) is reserved. */
export function isReservedKey(canonical: string): boolean {
  return canonical.split(' ').some((k) => RESERVED_KEYS.includes(k));
}

/** TUI-DESIGN §3.4: the effective binding table — key string → action id per context, plus the chord prefixes. */
export interface Bindings {
  /** context → canonical key (or chord) → action id */
  readonly table: ReadonlyMap<KeyContext, ReadonlyMap<string, string>>;
  /** context → first keys of every bound chord */
  readonly chordPrefixes: ReadonlyMap<KeyContext, ReadonlySet<string>>;
  /** action id → its effective keys (a key refused or displaced by a collision is absent, so help and docs stay truthful) */
  readonly keysOf: ReadonlyMap<string, readonly string[]>;
  /** one line per key collision found while building (§3.4; surfaced through `loadKeybindings().warnings`) */
  readonly warnings: readonly string[];
}

/**
 * TUI-DESIGN §3.1/§3.4: the lookup domain of a context. `global` is only ever consulted after `composer`
 * (§3.1's precedence), so the two share one key space; review, picker and palette each own theirs (their
 * defaults deliberately reuse composer keys — picker Ctrl+R is rename, Ctrl+A is all workspaces).
 */
function domainOf(c: KeyContext): KeyContext {
  return c === 'global' ? 'composer' : c;
}

function firstKeyOf(k: string): string {
  const space = k.indexOf(' ');
  return space > 0 ? k.slice(0, space) : k;
}

/** how `mine` collides with `theirs` for a warning: the same key, a chord over a single key, or a single key under a chord */
function describeClash(mine: string, theirs: string): string {
  if (mine === theirs) return `"${mine}"`;
  if (mine.includes(' ')) return `the chord "${mine}" (its first key "${firstKeyOf(mine)}")`;
  return `"${mine}" (the first key of the chord "${theirs}")`;
}

/**
 * TUI-DESIGN §3.4 / §6.2: build the effective table from the registry defaults and the loader's overrides
 * (`overrides.get(id)` = the keys to use; an empty array unbinds). Reserved actions keep their keys, and no
 * other action may take a reserved action's key in the same domain (so `y` can never be stolen from
 * `review:approve`). Collisions (the same key, or a chord whose first key is a bound single key) are
 * resolved deterministically and reported in `warnings`: a reserved owner always wins; an override
 * displaces a default (the default loses that key); an override never displaces another override and a
 * default never displaces a default (the earlier registry row keeps the key).
 */
export function buildBindings(overrides?: ReadonlyMap<string, readonly string[]>): Bindings {
  const table = new Map<KeyContext, Map<string, string>>();
  const keysOf = new Map<string, string[]>();
  const warnings: string[] = [];
  /** domain → key or chord → owning action id */
  const owners = new Map<KeyContext, Map<string, string>>();
  for (const c of KEY_CONTEXTS) {
    table.set(c, new Map());
    owners.set(c, new Map());
  }
  const isOverride = (spec: KeyActionSpec): boolean => !spec.reserved && overrides?.has(spec.id) === true;
  const drop = (id: string, key: string): void => {
    const spec = BY_ID.get(id) as KeyActionSpec;
    keysOf.set(id, (keysOf.get(id) ?? []).filter((k) => k !== key));
    (table.get(spec.context) as Map<string, string>).delete(key);
    (owners.get(domainOf(spec.context)) as Map<string, string>).delete(key);
  };
  for (const a of KEY_ACTIONS) {
    const wanted = a.reserved ? a.keys : (overrides?.get(a.id) ?? a.keys);
    const t = table.get(a.context) as Map<string, string>;
    const own = owners.get(domainOf(a.context)) as Map<string, string>;
    const accepted: string[] = [];
    for (const k of wanted) {
      if (accepted.includes(k)) continue;
      const chord = k.includes(' ');
      const first = firstKeyOf(k);
      const clashes: string[] = [];
      for (const ek of own.keys()) {
        if (ek === k || (chord && ek === first) || (!chord && ek.includes(' ') && firstKeyOf(ek) === k)) clashes.push(ek);
      }
      let refused = false;
      for (const ek of clashes) {
        const eid = own.get(ek) as string;
        const eSpec = BY_ID.get(eid) as KeyActionSpec;
        const how = describeClash(k, ek);
        if (eSpec.reserved) {
          warnings.push(`keybindings: ${a.id}: ${how} is owned by the reserved action ${eid} in the ${eSpec.context} context; binding refused`);
          refused = true;
        } else if (!isOverride(a)) {
          // the existing owner stands: an earlier override displaces this default (same wording as the other order), or two defaults clash (a registry bug)
          warnings.push(isOverride(eSpec) ? `keybindings: ${eid}: ${describeClash(ek, k)} displaces the default binding of ${a.id} ("${k}")` : `keybindings: registry: ${how} is bound to both ${eid} and ${a.id} in the ${eSpec.context} context; ${a.id} loses it`);
          refused = true;
        } else if (isOverride(eSpec)) {
          warnings.push(`keybindings: ${a.id}: ${how} is already bound to ${eid} in the ${eSpec.context} context; binding refused`);
          refused = true;
        } else {
          warnings.push(`keybindings: ${a.id}: ${how} displaces the default binding of ${eid} ("${ek}")`);
          drop(eid, ek);
        }
        if (refused) break;
      }
      if (refused) continue;
      accepted.push(k);
      own.set(k, a.id);
      t.set(k, a.id);
    }
    keysOf.set(a.id, accepted);
  }
  const chordPrefixes = new Map<KeyContext, Set<string>>();
  for (const c of KEY_CONTEXTS) {
    const p = new Set<string>();
    for (const k of (table.get(c) as Map<string, string>).keys()) if (k.includes(' ')) p.add(firstKeyOf(k));
    chordPrefixes.set(c, p);
  }
  return { table, chordPrefixes, keysOf, warnings };
}

/** TUI-DESIGN §3.4: the default table (registry keys only). */
export const DEFAULT_BINDINGS: Bindings = buildBindings();

/** TUI-DESIGN §3.4: the action bound to a canonical key (or completed chord) in a context, or null. */
export function lookupBinding(b: Bindings, context: KeyContext, key: string): string | null {
  return b.table.get(context)?.get(key) ?? null;
}

/** TUI-DESIGN §3.4: true when `key` starts a bound chord in `context` (the resolver then arms it for 3 s). */
export function isChordPrefix(b: Bindings, context: KeyContext, key: string): boolean {
  return b.chordPrefixes.get(context)?.has(key) ?? false;
}

/** TUI-DESIGN §5.3 / §21: the human-readable form of a canonical key (`ctrl+k` → `Ctrl+K`, `meta+b` → `Alt+B`, `up` → `↑`). */
export function displayKey(canonical: string, ascii = false): string {
  const names: Readonly<Record<string, string>> = {
    up: ascii ? 'Up' : '↑',
    down: ascii ? 'Down' : '↓',
    left: ascii ? 'Left' : '←',
    right: ascii ? 'Right' : '→',
    return: 'Enter',
    escape: 'Esc',
    tab: 'Tab',
    backspace: ascii ? 'Backspace' : '⌫',
    delete: 'Del',
    pageup: 'PgUp',
    pagedown: 'PgDn',
    home: 'Home',
    end: 'End',
    space: 'Space',
    insert: 'Ins',
  };
  return canonical
    .split(' ')
    .map((k) => {
      const { mods: raw, base } = splitCanonical(k);
      const mods = raw.map((m) => (m === 'ctrl' ? 'Ctrl' : m === 'meta' ? 'Alt' : 'Shift'));
      const b = names[base] ?? base.toUpperCase();
      return [...mods, b].join('+');
    })
    .join(' ');
}

/**
 * TUI-DESIGN §3.4: split one canonical key into its modifiers and its base, **the same way `normalizeKeyToken`
 * builds it** — a trailing `+` is the base key, not an empty separator. A bare `k.split('+')` reads `'+'` as
 * `['', '']` and renders it `Shift+`, which is what `docs/KEYS.md` and `/help` published for `agents:budget`
 * (`keys: ['+']`) until this existed — a wrong key in the two places a user looks a key up, with
 * `gen-docs --check` green because the generator calls this very function.
 */
function splitCanonical(k: string): { mods: string[]; base: string } {
  const parts: string[] = [];
  let buf = '';
  for (let n = 0; n < k.length; n++) {
    const ch = k[n] as string;
    if (ch === '+' && buf !== '' && n < k.length - 1) {
      parts.push(buf);
      buf = '';
    } else buf += ch;
  }
  parts.push(buf);
  return { mods: parts.slice(0, -1), base: parts[parts.length - 1] ?? '' };
}
