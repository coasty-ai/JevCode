/**
 * The key registry (TUI-DESIGN §3.2, §3.4, F4, F14): every bindable action with its `namespace:action`
 * id, its context, its default keys and a one-line title. One typed array feeds `resolveKey`, the help
 * block, `docs/KEYS.md` (scripts/gen-docs.mjs) and the keybindings-file loader. Pure: no I/O.
 *
 * Key strings are canonical: modifiers `ctrl+` `meta+` `shift+` in that order, then a base key — a
 * single lower-case character (`k`, `?`, `/`, `_`) or a name (`up`, `return`, `escape`, `tab`, `f1`,
 * …). A chord is two key strings separated by one space (`ctrl+x ctrl+s`, §3.4), completed within 3 s.
 */

/** TUI-DESIGN §3.4: the contexts a binding can live in (precedence order is §3.1's). */
export type KeyContext = 'global' | 'composer' | 'review' | 'picker' | 'palette';

/** TUI-DESIGN §3.4: contexts in the order help and docs list them. */
export const KEY_CONTEXTS: readonly KeyContext[] = ['global', 'composer', 'review', 'picker', 'palette'];

/** TUI-DESIGN §3.2/§3.4: one bindable action of the registry. */
export interface KeyActionSpec {
  /** `namespace:action` (§3.4); the namespace is the context except `session:*`, which is global */
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
  { id: 'global:escape', short: 'pause · Esc Esc menu / clear / abort', context: 'global', keys: ['escape'], title: 'idle: Esc Esc opens the rewind/steer menu; text: Esc Esc clears the draft; live: pause, Esc Esc aborts; review: decline', reserved: true, note: 'F5 matrix (§3.3); 30 ms re-buffer for Alt chords' },
  { id: 'global:help', short: 'help', context: 'global', keys: ['?', 'f1'], title: 'append the help block to the transcript', when: '`?` on an empty draft' },
  { id: 'global:detail', short: 'details', context: 'global', keys: ['ctrl+o'], title: 'append the last step\'s decision details and recent warnings; acknowledges !n' },
  { id: 'global:repaint', short: 'repaint', context: 'global', keys: ['ctrl+l'], title: 'repaint the dynamic region (erase-lines + rewrite, never a clear)' },
  { id: 'global:suspend', short: 'suspend', context: 'global', keys: ['ctrl+z'], title: 'suspend to the shell (fg resumes and repaints)' },
  { id: 'global:paneNext', short: 'next tab', context: 'global', keys: [']'], title: 'next pane tab (d → p → t → s)', when: 'empty draft' },
  { id: 'global:panePrev', short: 'previous tab', context: 'global', keys: ['['], title: 'previous pane tab', when: 'empty draft' },
  { id: 'session:export', short: 'export', context: 'global', keys: [], title: 'export the session transcript (= /export)', note: 'unbound by default; e.g. "session:export": "ctrl+x ctrl+s"' },
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
  { id: 'composer:killWordForward', short: 'kill word forward', context: 'composer', keys: ['meta+d', 'meta+delete', 'ctrl+delete'], title: 'kill the word after the cursor' },
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
  // palette
  { id: 'palette:up', short: 'up', context: 'palette', keys: ['up', 'ctrl+p'], title: 'previous row' },
  { id: 'palette:down', short: 'down', context: 'palette', keys: ['down', 'ctrl+n'], title: 'next row' },
  { id: 'palette:pageUp', short: 'page up', context: 'palette', keys: ['pageup'], title: 'page up' },
  { id: 'palette:pageDown', short: 'page down', context: 'palette', keys: ['pagedown'], title: 'page down' },
  { id: 'palette:accept', short: 'complete', context: 'palette', keys: ['tab'], title: 'complete the highlighted row into the draft and keep editing', reserved: true },
  { id: 'palette:run', short: 'run exact match', context: 'palette', keys: ['return'], title: 'run — only on an exact name/alias match; otherwise the draft is kept and an error item is appended', reserved: true },
  { id: 'palette:close', short: 'close', context: 'palette', keys: ['escape'], title: 'close (the draft is kept; the token is remembered so / stays closed while it is unchanged)', reserved: true },
];

const BY_ID: ReadonlyMap<string, KeyActionSpec> = new Map(KEY_ACTIONS.map((a) => [a.id, a]));

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
  // a shifted single character is the character itself (`?` is `?`, never `shift+/`)
  if (key.length === 1 && shift) shift = false;
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
      const parts = k.split('+');
      const base = parts.pop() as string;
      const mods = parts.map((m) => (m === 'ctrl' ? 'Ctrl' : m === 'meta' ? 'Alt' : 'Shift'));
      const b = names[base] ?? (base.length === 1 ? base.toUpperCase() : base.toUpperCase());
      return [...mods, b].join('+');
    })
    .join(' ');
}
