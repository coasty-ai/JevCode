/**
 * The target grammar (TUI-DESIGN-5 §2.5, D-AE (b)) — **one** resolver, shared by `/pause`, `/end`, `/tell`,
 * `/headsup`, `/request` and by `src/cli/sessions.ts`'s `who|pause|resume|end|tell|headsup|request` verbs, so the
 * dispatcher, the CLI and `--json` cannot each write their own sentence (§13.1, §13.3).
 *
 * Pure: a `Fold` in, a `TargetResult` out. No I/O, no clock, no `LedgerHandle` (§2.1 rule 2 — this module never sees
 * one), and the only coordination import is the `import type` of `Fold` through the facade (§2.1 rule 1 / rule 3a:
 * the type erases, so nothing here reaches the argv path, gate G-R5-1).
 *
 * Resolution order, stated once (§2.5, CO §5.3) and asserted as an **order** by `commands/target.test.ts`:
 *
 *   reserved word → exact run id → exact session id → unique id **suffix or substring** (≥ 8 chars) →
 *   `device:<label[#id4]|id8>` → exact title → unique title prefix → a bare device label
 *
 * Two corrections the fix pass made to the drafted order, both from CO §5.3 (the order §2.5 cites as its source):
 *
 * 1. **The id rung matches a suffix or a substring, never a prefix**, and `Candidate.id8` is the id's **tail**.
 *    `RUN_ID_RE` is `<YYYYMMDD>-<HHMMSS>-<8 random>` (`src/checkpoint/run-id.ts:21`), so the leading 8 characters
 *    are the DATE and identical for every run of the day: a head-8 resolver answered `3 sessions match
 *    "20260921" — 20260921, 20260921, 20260921` (a list that names nothing) and refused `rpywkq2v`, the trailing
 *    8 random characters CO §5.3 says explicitly are "what humans copy".
 * 2. **A bare device label is a target** (`/pause mbp`), which §2.6 calls "the ordinary case" and §2.9's table
 *    writes in every frame. It is the LAST rung, so a session titled `mbp` still wins over a device labelled
 *    `mbp` — a title is addressable by name, a device is also addressable as `device:mbp`.
 *
 * The `< ID_PREFIX_MIN` refusal (§12 S43b) is **deferred**, not taken at the id rung: a token that is too short to
 * be an id may still be an exact title or a title prefix, and with date-prefixed ids every title beginning `2`,
 * `20`, `202`, `2026` … is an id fragment. S43b is answered only when no later rung matched either.
 *
 * A title equal to a reserved word (`all`, `self`, and later `tree` / `agents`) is addressable **only by id**: the
 * reserved word always wins and `Resolved.note` says which session it shadowed (§12 S43).
 */
import type { Fold } from '../../coordination/index.js';
import type { SelfIdentityView } from '../../core/types.js';

/**
 * TUI-DESIGN-5 §2.5: what a verb was aimed at.
 *
 * contract 1.8 note: orchestration's `tree` / `agents` / `agent:<slug>` are **additive members of this union**
 * (D-AE (b)). They are parsed today and refused with §12 S85 — writing a branch for a target kind that cannot be
 * constructed (no `AgentSupervisor` in this build) would be untestable code — and the growth point is marked here
 * so the later widening is one union arm plus one `matchedBy` value, with no call-site reshape.
 */
export type Target =
  | { kind: 'self' }
  | { kind: 'run'; runId: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'title'; title: string }
  | { kind: 'device'; label: string }
  | { kind: 'all' };

/** TUI-DESIGN-5 §2.5 / §13.3: one row of an ambiguous refusal — an id8, the session's title and the device label. Never a path, never a pid (§2.9's rule). */
export interface Candidate {
  readonly id8: string;
  readonly title60: string;
  readonly label: string;
}

/** TUI-DESIGN-5 §2.5: the three outcomes, spelled out — `sessions who|pause|end <target>` all serialise them. */
export interface Resolved {
  readonly kind: 'resolved';
  readonly target: Target;
  readonly matchedBy: 'runId' | 'sessionId' | 'idPrefix' | 'device' | 'title' | 'titlePrefix' | 'reserved';
  readonly id8: string | null;
  /**
   * §12 S43, additive and optional (§2.5 asks for "the ambiguity message says so" on a resolution that *succeeded*,
   * and the drafted `Resolved` had no field to carry it). Present only when a reserved word shadowed a real
   * session's title; absent otherwise, so every existing `Resolved` literal stays valid.
   */
  readonly note?: string;
}
/** TUI-DESIGN-5 §2.5: more than one session matched; `candidates` is capped at `TARGET_CANDIDATE_MAX` with `truncated`. */
export interface Ambiguous {
  readonly kind: 'ambiguous';
  readonly text: string;
  readonly candidates: readonly Candidate[];
  readonly truncated: boolean;
  readonly message: string;
}
/** TUI-DESIGN-5 §2.5: nothing matched, or the form is refused (a short prefix, an orchestration scope with no referent). */
export interface NotFound {
  readonly kind: 'notFound';
  readonly text: string;
  readonly message: string;
}
export type TargetResult = Resolved | Ambiguous | NotFound;

/** TUI-DESIGN-5 §2.5: an ambiguous refusal lists at most five candidates and sets `truncated` beyond that. */
export const TARGET_CANDIDATE_MAX = 5;
/** TUI-DESIGN-5 §2.5 (CO §5.3): an id prefix shorter than this is refused rather than guessed at. */
export const ID_PREFIX_MIN = 8;
/** TUI-DESIGN-5 §2.5 / D-AE: the words no session title can claim. `tree` / `agents` are parsed and refused until the agent tree has a referent. */
export const RESERVED_TARGETS: readonly string[] = ['all', 'self', 'tree', 'agents'];

/** §12 S43: the reserved word won; the shadowed session is named by id so it stays reachable. */
export function reservedShadowNote(word: string, id8: string): string {
  return `"${word}" is a reserved target — the session titled "${word}" is ${id8}`;
}
/** §12 S44: `<n> sessions match "<prefix>" — <id8>, <id8>, <id8> …` (the `…` only when the list was capped). */
export function ambiguousTargetMessage(text: string, total: number, shown: readonly string[], truncated: boolean): string {
  return `${total} sessions match "${text}" — ${shown.join(', ')}${truncated ? ' …' : ''}`;
}
/** §12 S43a (new this round): nothing in the fold answers to the text. */
export function unknownTargetMessage(text: string): string {
  return `no session matches "${text}" — /who lists the live ones`;
}
/**
 * §12 S43b (new this round): an id fragment shorter than `ID_PREFIX_MIN` is refused, never guessed — two runs can
 * share seven characters, and with `RUN_ID_RE`'s date head they share the first eight by construction. Answered
 * only after the title and device rungs have missed (the fragment may be a short title).
 */
export function shortPrefixMessage(text: string): string {
  return `"${text}" is too short — an id fragment needs at least ${ID_PREFIX_MIN} characters`;
}
/** §12 S43c (new this round): `device:<label>` named a device the fold does not carry. */
export function unknownDeviceMessage(label: string): string {
  return `no device is labelled "${label}" — /who lists the devices`;
}
/** §12 S85 (D-AE, D-AN): an orchestration scope that has no referent in this build is refused honestly, never silently dropped. */
export function unavailableScopeMessage(text: string): string {
  return `${text} is not available in this build — no agent is running`;
}

/** one addressable session, flattened out of the fold so the matcher never reads a `Heartbeat` field twice */
interface Row {
  readonly runId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly label: string;
}

/**
 * §12 S44 / CO §5.3: the eight characters a human copies — the **tail**, never the head. `RUN_ID_RE` is
 * `<YYYYMMDD>-<HHMMSS>-<8 random>` (`src/checkpoint/run-id.ts:21`), so a head-8 id8 is the day and is identical
 * for every run of the day; the tail is the random part. Spelled as a local slice rather than an import of
 * `RUN_ID_RE`, because that module reaches the filesystem and this one is pure (asserted by `target.test.ts`'s
 * import-graph guard). An id at or below eight characters is its own id8.
 */
function id8Of(runId: string): string {
  return runId.length <= ID_PREFIX_MIN ? runId : runId.slice(-ID_PREFIX_MIN);
}

/** CO §5.3 `<id-suffix>`: "any suffix or unique substring" — `endsWith` is a special case of `includes`, so one test covers both. */
function idHit(id: string, q: string): boolean {
  return id.includes(q);
}

function candidateOf(r: Row): Candidate {
  return { id8: id8Of(r.runId), title60: r.title, label: r.label };
}

/**
 * Every session the fold can address: `live` first, then `gone` (a crashed session is still a `/resume` target,
 * §7 row 3). `ignored` is deliberately absent — a tombstoned device's records may never move a decision (§2.1
 * rule 4, `Fold.ignored`'s own comment).
 */
function rowsOf(fold: Fold): Row[] {
  const out: Row[] = [];
  const seen = new Set<string>();
  const take = (hb: { runId: string; sessionId: string; title60: string | null; label: string }): void => {
    if (seen.has(hb.runId)) return;
    seen.add(hb.runId);
    out.push({ runId: hb.runId, sessionId: hb.sessionId, title: hb.title60 ?? '', label: hb.label });
  };
  for (const hb of fold.live.values()) take(hb);
  for (const hb of fold.gone.values()) take(hb);
  return out;
}

/** TUI-DESIGN-5 §2.5 / CO §5.3 row 42: a device row of an ambiguous refusal — its id8 is the whole 8-character device id, which is also the `device:<id8>` form that disambiguates it. */
interface DeviceRow {
  readonly deviceId: string;
  readonly label: string;
}

function ambiguousDevices(text: string, matches: readonly DeviceRow[]): Ambiguous {
  const truncated = matches.length > TARGET_CANDIDATE_MAX;
  const candidates = matches.slice(0, TARGET_CANDIDATE_MAX).map((d) => ({ id8: d.deviceId.slice(0, ID_PREFIX_MIN), title60: '', label: d.label }));
  return {
    kind: 'ambiguous',
    text,
    candidates,
    truncated,
    message: ambiguousTargetMessage(text, matches.length, candidates.map((c) => c.id8), truncated),
  };
}

function ambiguous(text: string, matches: readonly Row[]): Ambiguous {
  const truncated = matches.length > TARGET_CANDIDATE_MAX;
  const candidates = matches.slice(0, TARGET_CANDIDATE_MAX).map(candidateOf);
  return {
    kind: 'ambiguous',
    text,
    candidates,
    truncated,
    message: ambiguousTargetMessage(
      text,
      matches.length,
      candidates.map((c) => c.id8),
      truncated,
    ),
  };
}

function resolved(target: Target, matchedBy: Resolved['matchedBy'], id8: string | null, note?: string): Resolved {
  return note === undefined ? { kind: 'resolved', target, matchedBy, id8 } : { kind: 'resolved', target, matchedBy, id8, note };
}

/**
 * TUI-DESIGN-5 §2.5: resolve one target token against the fold. `self` is the caller's own identity view
 * (§8.1 item 4) — never coordination's `SelfIdentity`, which carries `hostKey` (§7 row 61).
 *
 * Never throws: an empty or whitespace-only token is `notFound`, and a fold that is not open yet (every map empty,
 * §2.1 rule 3) answers `notFound` for everything but the reserved words, which is the documented empty state.
 */
export function resolveTarget(text: string, fold: Fold, self: SelfIdentityView): TargetResult {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw === '') return { kind: 'notFound', text: raw, message: unknownTargetMessage(raw) };
  const lower = raw.toLowerCase();
  const rows = rowsOf(fold);

  // 1. reserved words — they win over a session that happens to carry the same title (§2.5)
  if (lower === 'all' || lower === 'self') {
    const shadowed = rows.find((r) => r.title.toLowerCase() === lower);
    const target: Target = lower === 'all' ? { kind: 'all' } : { kind: 'self' };
    return resolved(target, 'reserved', null, shadowed === undefined ? undefined : reservedShadowNote(lower, id8Of(shadowed.runId)));
  }
  // D-AE: parsed, refused — `tree`, `agents` and `agent:<slug>` have no referent in this build
  if (lower === 'tree' || lower === 'agents' || lower.startsWith('agent:')) {
    return { kind: 'notFound', text: raw, message: unavailableScopeMessage(raw) };
  }

  // 2. exact run id
  const byRun = rows.filter((r) => r.runId === raw);
  if (byRun.length > 0) {
    const hit = byRun[0]!;
    return resolved({ kind: 'run', runId: hit.runId }, 'runId', id8Of(hit.runId));
  }
  // 3. exact session id
  const bySession = rows.filter((r) => r.sessionId === raw);
  if (bySession.length > 0) {
    const hit = bySession[0]!;
    return resolved({ kind: 'session', sessionId: hit.sessionId }, 'sessionId', id8Of(hit.runId));
  }
  // 4. a unique id SUFFIX or substring of at least ID_PREFIX_MIN characters (CO §5.3 `<id-suffix>`). A shorter
  //    fragment that WOULD have matched is remembered, not refused here: it may still be a title (§12 S43b below).
  const bySuffix = rows.filter((r) => r.runId.endsWith(raw) || r.sessionId.endsWith(raw));
  const byPart = bySuffix.length > 0 ? bySuffix : rows.filter((r) => idHit(r.runId, raw) || idHit(r.sessionId, raw));
  let shortIdFragment = false;
  if (byPart.length > 0) {
    if (raw.length < ID_PREFIX_MIN) shortIdFragment = true;
    else if (byPart.length > 1) return ambiguous(raw, byPart);
    else {
      const hit = byPart[0]!;
      const target: Target = idHit(hit.runId, raw) ? { kind: 'run', runId: hit.runId } : { kind: 'session', sessionId: hit.sessionId };
      return resolved(target, 'idPrefix', id8Of(hit.runId));
    }
  }
  // 5. device:<label[#id4]|id8> — CO §5.3's grammar in full. `#id4` is the form edge row 42 requires when two
  //    machines publish one default label (`MacBook-Pro.local`), and a bare device id8 is the other way out, so an
  //    ambiguous refusal never lists candidates the resolver cannot accept.
  if (lower.startsWith('device:')) {
    const spec = raw.slice('device:'.length).trim();
    if (spec === '') return { kind: 'notFound', text: raw, message: unknownDeviceMessage(spec) };
    const devices: DeviceRow[] = [...fold.devices.values()].map((d) => ({ deviceId: d.deviceId, label: d.label }));
    const hash = spec.indexOf('#');
    const label = (hash >= 0 ? spec.slice(0, hash) : spec).trim().toLowerCase();
    const id4 = hash >= 0 ? spec.slice(hash + 1).trim().toLowerCase() : '';
    const byDeviceId = devices.filter((d) => d.deviceId.toLowerCase() === spec.toLowerCase());
    if (byDeviceId.length === 1) {
      const one = byDeviceId[0]!;
      return resolved({ kind: 'device', label: one.label }, 'device', one.deviceId.slice(0, ID_PREFIX_MIN));
    }
    const byLabel = devices.filter((d) => d.label.toLowerCase() === label);
    const narrowed = id4 === '' ? byLabel : byLabel.filter((d) => d.deviceId.toLowerCase().startsWith(id4));
    if (narrowed.length > 1) return ambiguousDevices(raw, narrowed);
    const one = narrowed[0];
    if (one !== undefined) return resolved({ kind: 'device', label: one.label }, 'device', one.deviceId.slice(0, ID_PREFIX_MIN));
    if (id4 === '' && self.label.toLowerCase() === label) return resolved({ kind: 'device', label: self.label }, 'device', self.deviceId8);
    return { kind: 'notFound', text: raw, message: unknownDeviceMessage(spec) };
  }
  // 6. exact title
  const byTitle = rows.filter((r) => r.title !== '' && r.title.toLowerCase() === lower);
  if (byTitle.length > 1) return ambiguous(raw, byTitle);
  if (byTitle.length === 1) {
    const hit = byTitle[0]!;
    return resolved({ kind: 'title', title: hit.title }, 'title', id8Of(hit.runId));
  }
  // 7. unique title prefix
  const byTitlePrefix = rows.filter((r) => r.title !== '' && r.title.toLowerCase().startsWith(lower));
  if (byTitlePrefix.length > 1) return ambiguous(raw, byTitlePrefix);
  if (byTitlePrefix.length === 1) {
    const hit = byTitlePrefix[0]!;
    return resolved({ kind: 'title', title: hit.title }, 'titlePrefix', id8Of(hit.runId));
  }
  // 8. a BARE device label — §2.6's `/pause mbp`, "the ordinary case", and §2.9's `/tell mbp <text>`. Last, so a
  //    session titled `mbp` still wins; the device is then reachable as `device:mbp`.
  {
    const devices: DeviceRow[] = [...fold.devices.values()].map((d) => ({ deviceId: d.deviceId, label: d.label })).filter((d) => d.label.toLowerCase() === lower);
    if (devices.length > 1) return ambiguousDevices(raw, devices);
    const one = devices[0];
    if (one !== undefined) return resolved({ kind: 'device', label: one.label }, 'device', one.deviceId.slice(0, ID_PREFIX_MIN));
    if (self.label.toLowerCase() === lower) return resolved({ kind: 'device', label: self.label }, 'device', self.deviceId8);
  }
  // §12 S43b, deferred from rung 4: the token IS an id fragment and nothing else claimed it, so the honest answer
  // is that it is too short rather than that nothing matches.
  if (shortIdFragment) return { kind: 'notFound', text: raw, message: shortPrefixMessage(raw) };
  return { kind: 'notFound', text: raw, message: unknownTargetMessage(raw) };
}

/** TUI-DESIGN-5 §2.5: the one-line form a `--json` refusal serialises (`{ ok:false, reason, candidates?, message }`, §13.3) — the `TargetResult` fields, never a re-modelled shape. */
export function targetRefusalJson(r: Ambiguous | NotFound): { ok: false; reason: 'ambiguous' | 'notFound'; candidates?: readonly Candidate[]; message: string } {
  return r.kind === 'ambiguous' ? { ok: false, reason: 'ambiguous', candidates: r.candidates, message: r.message } : { ok: false, reason: 'notFound', message: r.message };
}
