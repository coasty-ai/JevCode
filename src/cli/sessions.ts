/**
 * `jevcode sessions [list|reindex|prune|unlock <id>]` (TUI-DESIGN §1, §8.2 P11, §8.5): the CLI twins of the picker
 * and the index's repair paths. `list` prints the picker rows of this workspace (`--json`: the folded `SessionRow`s),
 * `reindex` rebuilds `sessions/index.jsonl` from every `run.json`, `prune` rebuilds it and reports the runs whose
 * directory is gone, `unlock <id>` removes a `run.lock` left behind by a dead process. Pure over an injected I/O
 * seam; nothing here starts an engine.
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { ParsedFlags } from './args.js';
// TUI-DESIGN-5 §2.1 rule 3a / gate G-R5-1: every coordination name here is `import type`, which erases; the ONE
// value import of the tree is the `await import('../coordination/index.js')` inside `openCoordination()` below.
import type { Fold, LedgerHandle, Message, PublicMessage, SelfIdentity } from '../coordination/index.js';
import type { SelfIdentityView, SessionActivityView } from '../core/types.js';
import { ConfigError, EXIT_CODES, JevCodeError, UsageError } from '../errors.js';
import { COORDINATION_NOT_OPENABLE, COORDINATION_UNAVAILABLE, coordinationAvailability, coordinationOffText, withoutPaths, type CoordinationHomeIo, type CoordinationOffReason } from '../session/coordination.js';
import { INDEX_PRUNE_NOTICE_BYTES, indexSkippedNotice, indexTooLargeNotice, readIndex, reindex, splitIndexText, foldIndex } from '../session/index.js';
import { bootAtNow, lockInUseMessage, lockReplaceVerdict, readRunLock, releaseRunLock, isPidAlive, type LockReplaceReason } from '../session/lock.js';
import { activityView, foldCapNotice, labelResolver, selfView, WHO_EMPTY, whoFlagRow, whoHeader, whoPlainRow } from '../session/peers.js';
import { noSessionMessage, pickerHeader, pickerRows } from '../session/picker-lines.js';
import { resolveTarget as resolveTargetGrammar, unknownTargetMessage, type TargetResult } from '../tui/commands/target.js';
import { glyphSet } from '../tui/glyphs.js';

export interface SessionsIo {
  stdout: { write(s: string): unknown; columns?: number | undefined };
  stderr: { write(s: string): unknown };
  runsDir: string;
  /** `<jevcodeDir>/sessions/index.jsonl` */
  indexPath: string;
  /** the workspace realpath the rows are filtered to */
  workspace: string;
  redact: (s: string) => string;
  now?: () => number;
  ascii?: boolean;
  /** §12.1's SR column: `who` renders `whoSentence` instead of the cell row (the one SR sink outside the TUI) */
  screenReader?: boolean;
  /** `process.kill(pid, 0)` stand-in for `unlock` */
  isAlive?: (pid: number) => boolean;
  /** this machine's hostname — `unlock` compares it with `RunLock.host` (default `os.hostname()`) */
  hostname?: string;
  /** this machine's boot instant — `unlock` compares it with `RunLock.bootAt` (default `bootAtNow()`) */
  bootAt?: string;
  /** the file reader behind `prune` (default `fs/promises.readFile`) */
  readIndexText?: (path: string) => Promise<string>;
  /**
   * TUI-DESIGN-5 §2.10: the verb, and the words after it. R5-6's §9.2 hunk LANDED — `src/cli/args.ts:164` now
   * parses all seventeen into `flags.sessionsOp`, and `flags.sessionsArgs` carries the tail — so this seam is
   * the test/TUI injection point rather than the production route. `sessionsVerbOf` states the precedence
   * (`flags.sessionsOp` wins) and is the ONE place it is computed, here and in `main.tsx`'s ledger gate
   * (fix pass, finding 17). `args` never contains the verb itself.
   */
  verb?: SessionsVerb;
  args?: readonly string[];
  /** TUI-DESIGN-5 §2.10: the narrow coordination seam; absent = no ledger in this build (every verb says so honestly) */
  coordination?: SessionsCoordination;
  /**
   * TUI-DESIGN-5 §2.10 / §12.1: why `coordination` is absent — `CoordinationOpen.message`, which is the landed
   * `the session ledger is not available in this build` **plus** the clause that names the cause (off in this
   * configuration, an unwritable home, or a one-line redacted open failure). Never a path, never a pid.
   */
  coordinationOff?: string;
  /**
   * TUI-DESIGN-5 §13.3 (fix pass, finding 14): the machine-readable half of `coordinationOff`, so a `--json`
   * consumer is handed `{ ok:false, reason, message }` rather than a sentence on stderr. `'error'` is the ledger
   * that threw on the way up; the two others are the pre-flight's.
   */
  coordinationOffReason?: CoordinationOffReason | 'error';
}

/** TUI-DESIGN §8.2: `sessions list` — picker rows of this workspace (`--json`: the fold). */
export async function sessionsList(flags: ParsedFlags, io: SessionsIo): Promise<number> {
  const r = await readIndex(io.indexPath);
  if (r.error) io.stderr.write(`jevcode sessions: ${r.error}\n`);
  if (flags.json) {
    io.stdout.write(`${JSON.stringify({ sessions: r.sessions, skipped: r.skipped, skips: r.skips, bytes: r.bytes, windowed: r.windowed }, null, 2)}\n`);
    return EXIT_CODES.ok;
  }
  const columns = typeof io.stdout.columns === 'number' && io.stdout.columns > 0 ? io.stdout.columns : 80;
  const rows = pickerRows(r.sessions, { workspace: io.workspace, widened: true, nowMs: io.now?.() ?? Date.now(), columns, ascii: io.ascii === true });
  /**
   * TUI-DESIGN-4 §7.6 item 2: an index full of garbage printed `no session in <ws> yet` — identical to a fresh
   * install — and never named the repair path. The health rows come first, before the picker rows or the empty
   * state, so the sentence that explains the emptiness is above it.
   */
  const health = (): void => {
    if (r.skipped > 0) io.stdout.write(`${indexSkippedNotice(r.skipped)}\n`);
    if (r.bytes > INDEX_PRUNE_NOTICE_BYTES) io.stdout.write(`${indexTooLargeNotice(r.bytes)}\n`);
  };
  if (rows.length === 0) {
    health();
    io.stdout.write(`${noSessionMessage(io.workspace)}\n`);
    if (!existsSync(io.indexPath) && (await runDirCount(io.runsDir)) > 0) io.stdout.write("the index is missing but runs exist: run 'jevcode sessions reindex'\n");
    return EXIT_CODES.ok;
  }
  health();
  io.stdout.write(`${pickerHeader({ workspace: io.workspace, widened: true, columns, ascii: io.ascii === true })}\n${rows.join('\n')}\n`);
  return EXIT_CODES.ok;
}

async function runDirCount(runsDir: string): Promise<number> {
  try {
    return (await readdir(runsDir)).filter((n) => /^\d{8}-\d{6}-[a-z2-7]{8}$/.test(n)).length;
  } catch {
    return 0;
  }
}

/** TUI-DESIGN §8.2 (P11): `sessions reindex` — rebuild the index from `run.json` files. */
export async function sessionsReindex(io: SessionsIo): Promise<number> {
  try {
    const r = await reindex(io.runsDir, io.indexPath, { redact: io.redact });
    /**
     * TUI-DESIGN-4 §7.9 (round-5 item 6): `reindex` counts a forward-version run in BOTH `skipped` and `newer`,
     * and printing only `skipped` told a user with a newer run that their run directory was unreadable — the one
     * thing it is not. The two causes are now separate clauses with separate repairs, and the newer one carries
     * the sentence docs/DECISIONS.md ratified for it.
     */
    const unreadable = Math.max(0, r.skipped - r.newer);
    const clauses: string[] = [];
    if (unreadable > 0) clauses.push(`${unreadable} unreadable run dir${unreadable === 1 ? '' : 's'} skipped`);
    if (r.newer > 0) clauses.push(`${r.newer} written by a newer JevCode — upgrade with jevcode upgrade`);
    io.stdout.write(`reindexed ${r.runs} run${r.runs === 1 ? '' : 's'} into ${io.indexPath}${clauses.length > 0 ? ` (${clauses.join(', ')})` : ''}\n`);
    return EXIT_CODES.ok;
  } catch (e) {
    io.stderr.write(`jevcode sessions reindex: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT_CODES.unexpected;
  }
}

/**
 * `sessions prune`: rebuild the index from the run directories that still exist and report the runs the old index
 * named whose directory is gone (a run dir moved to `~/.jevcode/trash/` by the picker, or deleted by hand).
 */
export async function sessionsPrune(io: SessionsIo): Promise<number> {
  let before = 0;
  let gone = 0;
  try {
    const read = io.readIndexText ?? ((p: string) => import('node:fs/promises').then((m) => m.readFile(p, 'utf8')));
    const text = await read(io.indexPath).catch(() => '');
    const fold = foldIndex(splitIndexText(text));
    for (const s of fold.sessions.values()) {
      for (const r of s.runs) {
        before += 1;
        if (!existsSync(join(io.runsDir, r.runId))) gone += 1;
      }
    }
  } catch {
    before = 0;
  }
  const code = await sessionsReindex(io);
  if (code !== EXIT_CODES.ok) return code;
  io.stdout.write(`pruned ${gone} of ${before} indexed run${before === 1 ? '' : 's'} whose directory is gone\n`);
  return EXIT_CODES.ok;
}

/**
 * TUI-DESIGN §8.5 / TUI-DESIGN-5 §2.10: `sessions unlock <id>` — remove a stale `run.lock`.
 *
 * Round 5 makes the EXPLANATION speak `lockReplaceVerdict`'s vocabulary (§14.2 #26). `LockReplace`
 * (`src/coordination/records.ts:807–809`) is six reasons in two arms, and **`detail60` exists on the REFUSING arm
 * only** — the three replaceable returns carry none — so `--json`'s absent `detail60` is a documented state, not a
 * blank cell, and the CLI supplies its own sentence (S38a) for those three. Wiring the *decision* to
 * `lockReplaceVerdict` is harness work (§8.2 R6); wiring the *explanation* is round 5's, and both must print the
 * same six words so the text and the engine's decision cannot drift.
 */
export function sessionsUnlock(runId: string, io: SessionsIo, flags?: ParsedFlags): number {
  const emit = (ok: boolean, reason: LockReplaceReason, detail60?: string): void => {
    if (flags?.json !== true) return;
    io.stdout.write(`${JSON.stringify(detail60 === undefined ? { ok, reason } : { ok, reason, detail60 }, null, 2)}\n`);
  };
  const runDir = join(io.runsDir, runId);
  if (!existsSync(join(runDir, 'run.json'))) {
    io.stderr.write(`jevcode sessions unlock: no run ${runId} under ${io.runsDir}\n`);
    return EXIT_CODES.config;
  }
  const lock = readRunLock(runDir);
  const verdict = lockReplaceVerdict(lock, {
    host: io.hostname ?? hostname(),
    bootAt: io.bootAt ?? bootAtNow(),
    isAlive: io.isAlive ?? ((pid: number) => isPidAlive(pid)),
  });
  if (!verdict.replace) {
    emit(false, verdict.reason, verdict.detail60);
    if (flags?.json !== true) io.stderr.write(`jevcode sessions unlock: ${lock === null ? `run ${runId} is locked` : lockInUseMessage(runId, lock)} (${verdict.detail60}; not removed)\n`);
    return EXIT_CODES.config;
  }
  if (verdict.reason !== 'no-lock') releaseRunLock(runDir);
  emit(true, verdict.reason);
  if (flags?.json !== true) {
    const head = verdict.reason === 'no-lock' ? `run ${runId} has no run.lock` : `removed run.lock of ${runId}`;
    io.stdout.write(`${head} — ${LOCK_REPLACE_SENTENCE[verdict.reason]}\n`);
  }
  return EXIT_CODES.ok;
}


// ── TUI-DESIGN-5 §2.10: the verb surface, 4 → 17 (slot R5-1) ─────────────────────────────────────────────────────

/**
 * §2.10: the seventeen verbs. `list | reindex | prune | unlock` are round 4's; the thirteen below are round 5's,
 * each a thin wrapper over `src/coordination/index.ts`'s existing write API, each with a `--json` shape (§13.3),
 * **each starting no engine**. `sync` takes one sub-word (`status | disable`), which is why it is one verb, not two.
 *
 * `src/cli/args.ts:164` parses all seventeen (R5-6's §9.2 hunk landed), so `jevcode sessions who` reaches
 * `commandSessions` with `flags.sessionsOp = 'who'` and `flags.sessionsArgs` holding the tail. `SessionsIo.verb`
 * / `SessionsIo.args` remain the injection seam `test/unit/cli/sessions.test.ts` drives all seventeen through.
 */
export type SessionsVerb = 'list' | 'reindex' | 'prune' | 'unlock' | 'who' | 'pause' | 'resume' | 'end' | 'tell' | 'headsup' | 'request' | 'inbox' | 'label' | 'pair' | 'unpair' | 'gc' | 'sync';

export const SESSIONS_VERBS: readonly SessionsVerb[] = ['list', 'reindex', 'prune', 'unlock', 'who', 'pause', 'resume', 'end', 'tell', 'headsup', 'request', 'inbox', 'label', 'pair', 'unpair', 'gc', 'sync'];

/** §2.5 / §13.3: the three outcomes of resolving a `<target>` word, as the CLI needs them. */
export type SessionsTarget =
  | { kind: 'resolved'; runId: string; id8: string; label: string }
  | { kind: 'ambiguous'; text: string; candidates: readonly { id8: string; title60: string; label: string }[]; truncated: boolean; message: string }
  | { kind: 'notFound'; text: string; message: string; reason?: 'gone' };

/** §2.10: one inbox row, flattened for the CLI (the `--json` form emits coordination's own `Message`/`Ack`). */
export interface SessionsInboxRow {
  id: string;
  from: string;
  type: string;
  text: string;
  at: string;
  unverified: boolean;
}

/**
 * §13.3: one ack row, flattened — coordination's `Ack` minus `checksum`/`hmac` (§7 row 61, the clause below).
 *
 * **§13.2 clause 8, amended (fix pass, finding 10).** The field was `deviceId` and held an **id8**, so
 * `sessions inbox --json` had two meanings for one name: `acks[].deviceId` was truncated while `devices[].id8`
 * said so. Every other view type in this repository spells the truncated form `deviceId8`
 * (`SessionActivityView`, `SelfIdentityView`, `src/session/peers.ts:165`), and this row now does too. The clause:
 * *no `--json` field named `deviceId` ever carries a truncated id; the truncated form is always `deviceId8`.*
 */
export interface SessionsAckRow {
  msgId: string;
  by: string;
  /** the first 8 characters of the acking device's id — never the whole id (§7 row 61) */
  deviceId8: string;
  at: string;
  outcome: string;
  detail60?: string;
}

/**
 * §13.3 (fix pass, finding 4): one per-target refusal of a `send`.
 *
 * The field was `deviceId` and held **`to.slice(0, 8)`** — the head of a SESSION id, which for `RUN_ID_RE`'s
 * `<YYYYMMDD>-<HHMMSS>-<8 random>` shape is the DATE. A `--json` consumer that joined it against `devices[].id8`
 * or `acks[].deviceId8` got `"20260922"`. `deviceId8` is now resolved back through the fold to the device that
 * would have received the message (our own when the route is `@all` or the row has already left the fold), so it
 * is always one of `devices[].id8`; `target` carries what was actually addressed.
 */
export interface SessionsRefusedRow {
  /** always one of `devices[].id8` */
  deviceId8: string;
  /** the route this refusal belongs to: a session id, or `@all` */
  target: string;
  detail60: string;
}

/**
 * §2.10 / §7 row 14 (fix pass, finding 11): what `gc` did. `removed` counts records **deleted**; `ignored`
 * counts devices given a LOCAL TOMBSTONE, which is all `--device <ref>` ever does (`ignoreDeviceOn`'s own doc:
 * "a LOCAL tombstone; nothing foreign is ever deleted", §4.6 row 4). They were one number, so the verb told the
 * user it had removed a record it had not touched.
 */
export interface SessionsGcResult {
  removed: number;
  ignored?: number;
  devices: readonly SessionsDeviceRow[];
}

/** §2.10: one device row — `pair | unpair | label | gc | sync --json` all emit this list (§13.3). */
export interface SessionsDeviceRow {
  id8: string;
  label: string;
  paired: boolean;
  ignored: boolean;
}

/**
 * §2.1 rule 1 / §2.10: the NARROW seam the thirteen coordination verbs call. The real implementation is
 * `openCoordination()` below — one `await import('../coordination/index.js')`, one `openLedger`, one `close` — so
 * `list`, `reindex`, `prune` and `unlock` never pay for the coordination tree, and every verb is table-testable
 * against a fake. Nothing here returns a `SelfIdentity`: `hostKey` may not reach a CLI sink (§7 row 61).
 */
export interface SessionsCoordination {
  self(): SelfIdentityView;
  /** §2.3: the projected rows `sessions who` prints; `all` adds stale > 10 min and ignored-device rows */
  activity(opts: { all?: boolean }): Promise<readonly SessionActivityView[]>;
  /** `Fold.skipped` — devices past `MAX_DEVICES` (16), §7 row 11 */
  skipped(): number;
  resolve(text: string): Promise<SessionsTarget>;
  /**
   * §2.9 / §13.3: route one message. `delivered` is the number of SESSIONS that can read it, never the number of
   * write attempts (fix pass, finding 3): a broadcast is ONE `@all` outbox file read by every live row, so
   * counting the loop hard-wired `delivered: 1` even with no session on the machine, and `sessionsControl`'s
   * "no live session accepted it" branch was unreachable for it.
   */
  send(input: { to: string; type: 'note' | 'heads-up' | 'request-release' | 'pause' | 'resume' | 'end'; text: string }): Promise<{ messageId: string; delivered: number; refused: readonly SessionsRefusedRow[] }>;
  inbox(): Promise<readonly SessionsInboxRow[]>;
  /**
   * §13.3 as amended (round 5): what `sessions inbox --json` serialises — coordination's OWN
   * `publicMessage(m)` projection, which is the type `src/coordination/records.ts` built for exactly this sink and
   * which carries `from.deviceId8` rather than `hostKey`, no `checksum` and no `hmac` (§7 row 61). OPTIONAL so a
   * build whose ledger cannot open still compiles; the text sink keeps reading `inbox()`'s flattened rows.
   *
   * `unverified` rides ALONGSIDE the projection rather than inside it: record authority is the CLI's read of
   * `fold.origins` (§7 row 18), not a property of the message, and dropping it from `--json` while the text sink
   * still printed `(unverified)` would have made the two sinks disagree about the one security-relevant fact
   * either of them carries.
   */
  publicInbox?(): Promise<readonly (PublicMessage & { unverified: boolean })[]>;
  /**
   * §13.3: `fold.acks`, flattened. OPTIONAL so a build whose ledger has no ack read still compiles; absent answers
   * the same empty list the shape always promised, and `sessions inbox --json` says which it was through the row
   * count, never through a hardcoded `[]` (round-5 fix pass, finding 18).
   */
  acks?(): Promise<readonly SessionsAckRow[]>;
  label(next: string): Promise<SessionsDeviceRow>;
  pair(opts: { rotate: boolean }): Promise<{ phrase: string; rotated: boolean; devices: readonly SessionsDeviceRow[] }>;
  unpair(ref: string): Promise<{ label: string; devices: readonly SessionsDeviceRow[] }>;
  /**
   * §2.10 / §7 row 14: `--device <label>` resolves by **walking the disk** to `MAX_GC_DEVICES` (1,024), never
   * through `fold.devices`, which caps at 16 — the fold cannot reach the junk the verb exists to remove.
   */
  gc(opts: { device?: string }): Promise<SessionsGcResult>;
  syncStatus(): Promise<{ mode: string; state: string; lagMs: number | null; reason: string | null; devices: readonly SessionsDeviceRow[] }>;
  syncDisable(): Promise<{ removed: readonly string[]; devices: readonly SessionsDeviceRow[] }>;
  close(): Promise<void>;
}

/** §12.1 S38a: the three REPLACEABLE `LockReplace` reasons carry no `detail60` (`records.ts:807–809`), so the CLI supplies the sentence. */
export const LOCK_REPLACE_SENTENCE: Readonly<Record<'no-lock' | 'dead-pid' | 'other-boot', string>> = {
  'no-lock': 'no lock file — taking it',
  'dead-pid': "the lock's pid is gone — taking it",
  'other-boot': 'the lock is from another boot — taking it',
};

/** The three reasons `lockReplaceVerdict` refuses on; each carries its own `detail60` and the CLI prints that. */
export const LOCK_REFUSE_REASONS: readonly ('peer-live' | 'boot-unknown' | 'held')[] = ['peer-live', 'boot-unknown', 'held'];

/** every `LockReplace['reason']`, in the order `sessions unlock` documents them (§2.10, §14.2 #26) */
export const LOCK_REPLACE_REASONS: readonly LockReplaceReason[] = ['no-lock', 'dead-pid', 'other-boot', 'peer-live', 'boot-unknown', 'held'];

/**
 * §9.2: `src/cli/args.ts` is **R5-6's** file and the `sessions` flag rows (`--all` scoped to this command,
 * `--device <label>`, `--rotate`) arrive as a §9.2 request. Until they land the flags reach these verbs on the raw
 * tail (`SessionsIo.args`), and the day they land these reads pick them up with **no edit here** — which is also
 * what the `args.ts`-level test in `sessions.test.ts` asserts against `parseCliArgs`.
 */
interface SessionsExtraFlags {
  device?: string;
  rotate?: boolean;
}

function extraFlags(flags: ParsedFlags): SessionsExtraFlags {
  return flags as ParsedFlags & SessionsExtraFlags;
}

function jsonOut(io: SessionsIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * TUI-DESIGN-5 §2.10 / §12.1, gap 1: the refusal, and **which** reason it is.
 *
 * Before `openCoordination()` existed this sentence was true of every install; now it is true only when
 * coordination is off in the configuration or the JevCode home cannot be written, so it must say which — an
 * honest answer is D-AN's rule, not merely a non-silent one. `io.coordinationOff` carries the whole sentence
 * (`coordinationOffText`, which keeps the landed string as its PREFIX so every pin still matches); a caller that
 * supplies no coordination and no reason — a unit test, a build with no wiring — still gets the bare sentence.
 */
function needCoord(io: SessionsIo, verb: SessionsVerb, flags?: ParsedFlags): SessionsCoordination | null {
  if (io.coordination !== undefined) return io.coordination;
  const message = io.coordinationOff ?? COORDINATION_UNAVAILABLE;
  // §13.3 (fix pass, finding 14): a `--json` caller is handed the SHAPE, never a sentence on stderr and an
  // empty stdout — the same `{ ok:false, reason, message }` every other refusal here emits.
  if (flags?.json === true) jsonOut(io, { ok: false, reason: io.coordinationOffReason ?? 'unavailable', message });
  else io.stderr.write(`jevcode sessions ${verb}: ${message}\n`);
  return null;
}

function needArg(io: SessionsIo, verb: SessionsVerb, args: readonly string[], what: string): string | null {
  const v = args[0];
  if (v === undefined || v.trim() === '') {
    io.stderr.write(`jevcode sessions ${verb} needs ${what}\n`);
    return null;
  }
  return v.trim();
}

/** §13.3: every `sessions <verb> <target> --json` that cannot resolve emits the `TargetResult` fields, never a re-modelled shape. */
function refuseTarget(flags: ParsedFlags, io: SessionsIo, t: Exclude<SessionsTarget, { kind: 'resolved' }>): number {
  if (flags.json) jsonOut(io, t.kind === 'ambiguous' ? { ok: false, reason: 'ambiguous', candidates: t.candidates, message: t.message } : { ok: false, reason: t.reason ?? 'notFound', message: t.message });
  else io.stderr.write(`jevcode sessions: ${t.message}\n`);
  return EXIT_CODES.config;
}

/**
 * §13.2 clause 1: **`--plain` without a TTY renders the 120-column form.** A pipe reports no `stdout.columns`, and
 * falling back to 80 there printed a narrower row than the clause declares (and a different one from the TUI's).
 */
export const WHO_PIPED_COLUMNS = 120;

/** §2.3 / §13.3: `jevcode sessions who [--all] [--json]`. */
export async function sessionsWho(flags: ParsedFlags, io: SessionsIo, args: readonly string[]): Promise<number> {
  const coord = needCoord(io, 'who', flags);
  if (coord === null) return EXIT_CODES.config;
  const all = args.includes('--all') || flags.all === true;
  const rows = await coord.activity({ all });
  const self = coord.self();
  if (flags.json) {
    jsonOut(io, { sessions: rows, self, at: new Date(io.now?.() ?? Date.now()).toISOString() });
    return EXIT_CODES.ok;
  }
  const g = glyphSet({ ascii: io.ascii === true, screenReader: io.screenReader === true });
  // §13.2 clause 1: no TTY width is the 120-column form, not 80
  const columns = Math.max(1, typeof io.stdout.columns === 'number' && io.stdout.columns > 0 ? io.stdout.columns : WHO_PIPED_COLUMNS);
  const skipped = coord.skipped();
  // §7 row 11 phrases the fold-cap notice as a `/who --all` behaviour; `whoRows` gates it the same way (§13)
  const capNotice = (): void => {
    if (skipped > 0 && all) io.stdout.write(`${foldCapNotice(skipped)}\n`);
  };
  if (rows.length === 0) {
    io.stdout.write(`${WHO_EMPTY}\n`);
    capNotice();
    return EXIT_CODES.ok;
  }
  io.stdout.write(`${whoHeader(rows, g)}\n`);
  // §2.3: two devices may carry one label, and the TUI qualifies BOTH as `mbp#<id8>`; the twin must agree (§13)
  const label = labelResolver(rows, self);
  for (const row of rows) {
    io.stdout.write(`${whoPlainRow(row, { width: columns, g, label: label(row) })}\n`);
    // gate G-R5-6: the flag row is clipped to the width like every other row — eight flags are ~90 cells
    const flagRow = whoFlagRow(row, { width: columns, g });
    if (flagRow !== null) io.stdout.write(`${flagRow}\n`);
  }
  capNotice();
  return EXIT_CODES.ok;
}

/**
 * §2.6 / §2.7 / §13.3: `sessions pause|resume|end <target> [now]`. Each routes ONE control message and answers
 * `{ ok, runId, at, reason }`; none of them starts an engine (the far end's own `[y]`/`[n]` ladder decides).
 */
export async function sessionsControl(verb: 'pause' | 'resume' | 'end', flags: ParsedFlags, io: SessionsIo, args: readonly string[]): Promise<number> {
  const coord = needCoord(io, verb, flags);
  if (coord === null) return EXIT_CODES.config;
  const rest = args.filter((a) => a !== 'now');
  const now = args.includes('now');
  const text = needArg(io, verb, rest, 'a target (a run id, a session id, a title or device:<label>)');
  if (text === null) return EXIT_CODES.config;
  const target = await coord.resolve(text);
  if (target.kind !== 'resolved') return refuseTarget(flags, io, target);
  const at = now ? 'now' : 'step';
  const sent = await coord.send({ to: target.runId, type: verb, text: `${verb} ${at}` });
  const reason = sent.delivered === 0 ? 'no live session accepted it' : `asked ${target.label}`;
  if (flags.json) jsonOut(io, { ok: sent.delivered > 0, runId: target.runId, at, reason });
  else io.stdout.write(`${verb} ${at} → ${target.label} (${target.id8}): ${reason}\n`);
  return EXIT_CODES.ok;
}

/**
 * `src/coordination/ids.ts:45`'s `BROADCAST_ALL`, re-declared (§2.1 rule 6 — this module must not put the
 * coordination tree on the `sessions` path); `sessions.test.ts` pins it against the facade.
 */
export const BROADCAST_TARGET = '@all';

/**
 * §12.1 (fix pass, finding 3): the refusal for a target that is in `fold.gone`. `/who --all` is named because
 * that is the one surface that still lists the row, so the sentence is also its own documentation.
 */
export function goneTargetMessage(label: string): string {
  return `${label} has ended — only a live session can be paused, resumed, ended or told; 'jevcode sessions who --all' lists the ones that are gone`;
}

/** §2.9 / §13.3: `sessions tell|request <target> <text>` — the two DIRECTED verbs. */
export async function sessionsMessage(verb: 'tell' | 'request', flags: ParsedFlags, io: SessionsIo, args: readonly string[]): Promise<number> {
  const coord = needCoord(io, verb, flags);
  if (coord === null) return EXIT_CODES.config;
  const text = needArg(io, verb, args, 'a target and a message');
  if (text === null) return EXIT_CODES.config;
  const body = args.slice(1).join(' ').trim();
  if (body === '') {
    io.stderr.write(`jevcode sessions ${verb} needs a message after the target\n`);
    return EXIT_CODES.config;
  }
  const target = await coord.resolve(text);
  if (target.kind !== 'resolved') return refuseTarget(flags, io, target);
  const type = verb === 'tell' ? 'note' : 'request-release';
  // §7 row 93: the body is redacted by the record writer regardless; the CLI redacts here too so its OWN echo is clean
  const sent = await coord.send({ to: target.runId, type, text: io.redact(body) });
  if (flags.json) jsonOut(io, { ok: sent.delivered > 0, messageId: sent.messageId, delivered: sent.delivered, refused: sent.refused });
  else io.stdout.write(`${verb} → ${target.label} (${target.id8}): delivered to ${sent.delivered} session${sent.delivered === 1 ? '' : 's'}${sent.refused.length > 0 ? `, ${sent.refused.length} refused` : ''}\n`);
  return EXIT_CODES.ok;
}

/**
 * §2.9 / §13.3: `sessions headsup <text>` — a **broadcast to every live row on this repo**, with NO target.
 *
 * §2.9's table gives `/headsup` the form `<text>`, not `<target> <text>`: sharing `sessionsMessage`'s parser made
 * `jevcode sessions headsup "editing engine.ts"` resolve `editing` as a target and refuse (round-5 fix pass,
 * finding 8). The whole tail is the body and the target is always `BROADCAST_TARGET`.
 */
export async function sessionsHeadsup(flags: ParsedFlags, io: SessionsIo, args: readonly string[]): Promise<number> {
  const coord = needCoord(io, 'headsup', flags);
  if (coord === null) return EXIT_CODES.config;
  const body = args.join(' ').trim();
  if (body === '') {
    io.stderr.write('jevcode sessions headsup needs a message (jevcode sessions headsup "editing src/loop/engine.ts")\n');
    return EXIT_CODES.config;
  }
  const sent = await coord.send({ to: BROADCAST_TARGET, type: 'heads-up', text: io.redact(body) });
  if (flags.json) jsonOut(io, { ok: sent.delivered > 0, messageId: sent.messageId, delivered: sent.delivered, refused: sent.refused });
  else io.stdout.write(`headsup → every live session on this repo: delivered to ${sent.delivered} session${sent.delivered === 1 ? '' : 's'}${sent.refused.length > 0 ? `, ${sent.refused.length} refused` : ''}\n`);
  return EXIT_CODES.ok;
}

/** §2.9 / §13.3: `sessions inbox [--json]`. */
export async function sessionsInbox(flags: ParsedFlags, io: SessionsIo): Promise<number> {
  const coord = needCoord(io, 'inbox', flags);
  if (coord === null) return EXIT_CODES.config;
  const rows = await coord.inbox();
  if (flags.json) {
    /**
     * §13.3 as ratified: `messages` is coordination's OWN `publicMessage(m)` projection — `from.deviceId8`, no
     * `hostKey`, no `checksum`, no `hmac` (§7 row 61). The declared clause that stood in for it while this sink
     * flattened the rows itself is retired: one projection, owned by the module that owns the record.
     */
    jsonOut(io, { messages: (await coord.publicInbox?.()) ?? rows, acks: (await coord.acks?.()) ?? [] });
    return EXIT_CODES.ok;
  }
  if (rows.length === 0) {
    io.stdout.write('inbox is empty\n');
    return EXIT_CODES.ok;
  }
  for (const m of rows) io.stdout.write(`${m.from}${m.unverified ? ' (unverified)' : ''} ${m.type}: ${io.redact(m.text)}\n`);
  return EXIT_CODES.ok;
}

/** §2.10 / §13.3: `sessions label <text>`. */
export async function sessionsLabel(flags: ParsedFlags, io: SessionsIo, args: readonly string[]): Promise<number> {
  const coord = needCoord(io, 'label', flags);
  if (coord === null) return EXIT_CODES.config;
  const next = needArg(io, 'label', args, 'a label (jevcode sessions label "mbp")');
  if (next === null) return EXIT_CODES.config;
  const row = await coord.label(next);
  if (flags.json) jsonOut(io, { ok: true, devices: [row] });
  else io.stdout.write(`this device is now "${row.label}" (${row.id8})\n`);
  return EXIT_CODES.ok;
}

/** §12.1 S36: `pair --rotate` invalidates the old key everywhere. */
export const PAIR_ROTATED_SENTENCE = 'this device took a new id (<id8>) and a new key — run \'jevcode sessions pair\' with each peer again';

/** §2.10 / §13.3: `sessions pair [--rotate]` — the phrase is shown, the 32-byte key never is (§7 row 66). */
export async function sessionsPair(flags: ParsedFlags, io: SessionsIo, args: readonly string[]): Promise<number> {
  const coord = needCoord(io, 'pair', flags);
  if (coord === null) return EXIT_CODES.config;
  const rotate = args.includes('--rotate') || extraFlags(flags).rotate === true;
  const r = await coord.pair({ rotate });
  if (flags.json) jsonOut(io, { ok: true, devices: r.devices });
  else {
    if (r.rotated) io.stdout.write(`${PAIR_ROTATED_SENTENCE.replace('<id8>', coord.self().deviceId8)}\n`);
    io.stdout.write(`pairing phrase: ${r.phrase}\n`);
  }
  return EXIT_CODES.ok;
}

/** §12.1 S35 — the whole sentence, never a silent continue (§7 row 19). */
export function unpairedSentence(label: string): string {
  return `unpaired ${label} — it can no longer steer, stop, resume, end or import your runs. It still holds this device's key: run 'jevcode sessions pair --rotate' to invalidate it everywhere.`;
}

/** §2.10 / §13.3: `sessions unpair <device>`. */
export async function sessionsUnpair(flags: ParsedFlags, io: SessionsIo, args: readonly string[]): Promise<number> {
  const coord = needCoord(io, 'unpair', flags);
  if (coord === null) return EXIT_CODES.config;
  const ref = needArg(io, 'unpair', args, 'a device (a label, an id8 prefix or label#id4)');
  if (ref === null) return EXIT_CODES.config;
  const r = await coord.unpair(ref);
  if (flags.json) jsonOut(io, { ok: true, devices: r.devices });
  else io.stdout.write(`${unpairedSentence(r.label)}\n`);
  return EXIT_CODES.ok;
}

/**
 * §12.1 / §7 row 14 (fix pass, finding 11): what `gc --device <ref>` ACTUALLY did. `ignoreDeviceOn` writes a
 * local tombstone and deletes nothing foreign, so `gc removed 1 record of <ref>` named a deletion that never
 * happened. The sentence now says what the tombstone does and when the records really go.
 */
export function deviceIgnoredSentence(ref: string): string {
  return `${ref} is now ignored — its records are hidden from /who and 'jevcode sessions gc' drops them as they expire`;
}

/** §2.10 / §7 row 14 / §13.3: `sessions gc [--device <label>]`. */
export async function sessionsGc(flags: ParsedFlags, io: SessionsIo, args: readonly string[]): Promise<number> {
  const coord = needCoord(io, 'gc', flags);
  if (coord === null) return EXIT_CODES.config;
  const at = args.indexOf('--device');
  // the raw tail (the test/TUI seam) or `args.ts`'s parsed `--device <label>`, whichever this build supplies
  const parsed = extraFlags(flags).device;
  const device = at >= 0 ? args[at + 1] : parsed;
  if ((at >= 0 || parsed !== undefined) && (device === undefined || device.trim() === '')) {
    io.stderr.write('jevcode sessions gc --device needs a device (a label, an id8 prefix or label#id4)\n');
    return EXIT_CODES.config;
  }
  const r = await coord.gc(device === undefined ? {} : { device });
  if (flags.json) jsonOut(io, { ok: true, removed: r.removed, ...(r.ignored !== undefined ? { ignored: r.ignored } : {}), devices: r.devices });
  else io.stdout.write(`${device === undefined ? `gc removed ${r.removed} record${r.removed === 1 ? '' : 's'}` : deviceIgnoredSentence(device)}\n`);
  return EXIT_CODES.ok;
}

/** §2.10 / §13.3: `sessions sync status|disable`. */
export async function sessionsSync(flags: ParsedFlags, io: SessionsIo, args: readonly string[]): Promise<number> {
  const coord = needCoord(io, 'sync', flags);
  if (coord === null) return EXIT_CODES.config;
  const sub = (args[0] ?? 'status').trim();
  if (sub !== 'status' && sub !== 'disable') {
    io.stderr.write(`jevcode sessions sync: expected status|disable, got "${sub}"\n`);
    return EXIT_CODES.config;
  }
  if (sub === 'disable') {
    const r = await coord.syncDisable();
    if (flags.json) jsonOut(io, { ok: true, devices: r.devices });
    else io.stdout.write(`sync disabled — removed ${r.removed.length} subtree${r.removed.length === 1 ? '' : 's'} from the mirror\n`);
    return EXIT_CODES.ok;
  }
  const s = await coord.syncStatus();
  if (flags.json) jsonOut(io, { ok: true, devices: s.devices });
  else io.stdout.write(`sync ${s.mode}: ${s.state}${s.lagMs === null ? '' : ` (lag ${Math.round(s.lagMs / 1000)}s)`}${s.reason === null ? '' : ` — ${s.reason}`}\n`);
  return EXIT_CODES.ok;
}

/** §2.10: the dispatcher, 17 verbs. `flags.sessionsOp` wins for the verbs `args.ts` knows (§9.2); `io.verb` is the seam. */
export async function runSessionsVerb(verb: SessionsVerb, args: readonly string[], flags: ParsedFlags, io: SessionsIo): Promise<number> {
  switch (verb) {
    case 'list':
      return sessionsList(flags, io);
    case 'reindex':
      return sessionsReindex(io);
    case 'prune':
      return sessionsPrune(io);
    case 'unlock': {
      const runId = flags.runId ?? args[0];
      if (runId === undefined) {
        io.stderr.write('jevcode sessions unlock needs a run id\n');
        return EXIT_CODES.config;
      }
      return sessionsUnlock(runId, io, flags);
    }
    case 'who':
      return sessionsWho(flags, io, args);
    case 'pause':
    case 'resume':
    case 'end':
      return sessionsControl(verb, flags, io, args);
    case 'tell':
    case 'request':
      return sessionsMessage(verb, flags, io, args);
    case 'headsup':
      return sessionsHeadsup(flags, io, args);
    case 'inbox':
      return sessionsInbox(flags, io);
    case 'label':
      return sessionsLabel(flags, io, args);
    case 'pair':
      return sessionsPair(flags, io, args);
    case 'unpair':
      return sessionsUnpair(flags, io, args);
    case 'gc':
      return sessionsGc(flags, io, args);
    case 'sync':
      return sessionsSync(flags, io, args);
  }
}

/**
 * TUI-DESIGN §1 / TUI-DESIGN-5 §2.10: the `sessions` command dispatcher — seventeen verbs.
 *
 * Gap 1 added the second `catch`: with a REAL ledger behind the thirteen coordination verbs, a disk fault, a
 * `CoordinationError` (an unknown `--device` ref, a message over 2 KiB, a muted sender) or an unwired verb is a
 * thrown value, and §1.4 promise 2 says coordination never takes the caller down. Every one of them is one
 * redacted line on stderr and exit 2 — the same shape as every other refusal here — and the `close()` in the
 * `finally` still runs, so a faulting verb never leaks the handle either.
 */
export async function commandSessions(flags: ParsedFlags, io: SessionsIo): Promise<number> {
  const verb = sessionsVerbOf(flags, io);
  try {
    return await runSessionsVerb(verb, io.args ?? [], flags, io);
  } catch (e) {
    return sessionsThrew(verb, e, flags, io);
  } finally {
    await io.coordination?.close().catch(() => undefined);
  }
}

/**
 * §2.10 (fix pass, finding 17): the ONE place the verb is computed, so `src/cli/main.tsx`'s ledger gate and this
 * dispatcher cannot disagree. The precedence is the `SessionsIo.verb` doc comment's: a verb `args.ts` PARSED wins
 * over the injected seam, and `list` is the default. `main.tsx` has no `SessionsIo` when it decides whether to
 * open a ledger, which is why `io` is optional.
 */
export function sessionsVerbOf(flags: ParsedFlags, io?: Pick<SessionsIo, 'verb'>): SessionsVerb {
  return flags.sessionsOp ?? io?.verb ?? 'list';
}

/** §2.10: the four verbs that read `sessions/index.jsonl` and must NEVER open a ledger (`main.tsx`'s gate). */
export const SESSIONS_INDEX_VERBS: readonly SessionsVerb[] = ['list', 'reindex', 'prune', 'unlock'];

/** §2.10: does this verb need a `SessionsCoordination`? The complement of `SESSIONS_INDEX_VERBS`. */
export function sessionsVerbNeedsCoordination(verb: SessionsVerb): boolean {
  return !SESSIONS_INDEX_VERBS.includes(verb);
}

/**
 * §1.4 promise 2 / §13.3 (fix pass, finding 14): a verb that THREW.
 *
 * Every throw used to be `EXIT_CODES.config` and a bare line on stderr even under `--json`, which told a user
 * that a `TypeError` inside `sessionsList` was a configuration problem and handed a `--json` consumer nothing at
 * all. A refusal the CALLER can fix — a `CoordinationError` (an unknown `--device` ref, an over-large message, a
 * muted sender), a `ConfigError`, a `UsageError` — stays exit 2; anything else is `EXIT_CODES.unexpected`, which
 * is what `sessionsReindex` has always answered for a fault of its own. The cause loses its paths BEFORE the
 * redactor sees it (finding 2): `createRedactor` substitutes secret values and API-key shapes, and nothing in it
 * strips the absolute path every errno message carries.
 */
export function sessionsThrew(verb: SessionsVerb, e: unknown, flags: ParsedFlags, io: SessionsIo): number {
  const err = e instanceof Error ? e : new Error(String(e));
  const coord = isCoordinationError(err);
  const refusal = coord || err instanceof ConfigError || err instanceof UsageError;
  const reason = coord ? err.code : err instanceof JevCodeError ? err.code : 'unexpected';
  const message = safeCause(err.message, io.redact);
  if (flags.json) jsonOut(io, { ok: false, reason, message });
  else io.stderr.write(`jevcode sessions ${verb}: ${message}\n`);
  return refusal ? EXIT_CODES.config : EXIT_CODES.unexpected;
}

/**
 * `src/coordination/records.ts`'s `CoordinationError`, recognised WITHOUT importing it: a value import would put
 * the coordination tree on the `sessions list` path and break gate G-R5-1 (§2.1 rule 3a). `name` + a string
 * `code` is the whole shape this file needs.
 */
function isCoordinationError(e: Error): e is Error & { code: string } {
  return e.name === 'CoordinationError' && typeof (e as { code?: unknown }).code === 'string';
}

// ── TUI-DESIGN-5 §2.10 gap 1: `openCoordination()` — the ONE production constructor ─────────────────────────────

/**
 * `docs/STATUS.md` "Not driven by a store in this build" item 1, closed: **nothing constructed a
 * `SessionsCoordination`**, so the thirteen coordination verbs answered `the session ledger is not available in
 * this build` and exited 2 for a real user whose ledger was perfectly openable.
 *
 * The shape is `openSessionLedger`'s (`src/session/publish.ts`), deliberately, and for the same three reasons:
 *
 *  1. **One `await import('../coordination/index.js')`, inside this function body** (§2.1 rule 3a). Every
 *     coordination *type* below is reached with `import type`, which erases, so `src/cli/main.tsx`'s static graph
 *     still reaches nothing under `src/coordination/**` and gate G-R5-1 holds. `sessions list|reindex|prune|unlock`
 *     never call this, so they never pay for the tree either.
 *  2. **One `openLedger`, one `close`.** The handle is created here and closed in `commandSessions`' `finally`;
 *     nothing else in the process opens a second one (§2.1 rule 3).
 *  3. **The fold is read on mount and after every own write, then subscribed** (§15.2's binding rule: `adoptOwn`
 *     puts our own record in `ledger.fold` synchronously but does **not** `emit()`, so a push-only view lags its
 *     own write by the 100 ms debounce). `handle.open()` is the mount read; `refresh()` after each write verb is
 *     the second half; `subscribe` is registered so a long-lived caller (`src/cli/session.ts`) sees changes
 *     without a timer (gate G-R5-3).
 *
 * The ledger's identity is a **reader's**: `sessionId` and `runId` are `null` (`SelfIdentity` declares both
 * nullable exactly for "a TUI without a run or a CLI twin"), no claim is minted and no heartbeat is written — a
 * `jevcode sessions who` must never make itself appear in its own answer.
 */
export interface OpenCoordinationInput {
  /** `~/.jevcode` (JEVCODE_HOME) */
  home: string;
  /** the workspace REALPATH (`wsKeyOf`'s input) */
  workspace: string;
  hostname: string;
  username: string;
  jevcode: string;
  pid: number;
  redact: (s: string) => string;
  /** `ResolvedConfig.entries`-backed reader; `coordination.claims = off` is the off switch (§12.1) */
  read?: (name: string) => string | undefined;
  /** this machine's boot instant; `bootAtNow()` when absent */
  bootAt?: string;
  label?: string;
  sharedDir?: string | null;
  repoKey?: string | null;
  remoteKey?: string | null;
  branch?: string | null;
  /** re-render hook for a long-lived caller; the CLI verbs never pass one */
  onChange?: () => void;
  /**
   * §5.1 / `ledger.ts:97`: the per-process sender id. Absent, `openCoordination` mints a fresh one per
   * invocation — see the `openLedger` call below for why a CLI twin must NOT inherit the persisted `tuiActor8`.
   */
  actor8?: string;
  /** the ONE dynamic import, injected by `test/unit/session/coordination.test.ts` */
  facade?: () => Promise<typeof import('../coordination/index.js')>;
  /** the writability pre-flight's `node:fs/promises`, injected by the tests */
  homeIo?: CoordinationHomeIo;
  nowIso?: () => string;
}

/** §2.10 / §12.1: an open ledger, or the reason there is none — never a throw, never a dead session (§1.4 promise 2). */
export type CoordinationOpen = { readonly kind: 'open'; readonly coordination: SessionsCoordination } | { readonly kind: 'off'; readonly reason: CoordinationOffReason | 'error'; readonly message: string };

/**
 * §12.1 / §2.10: the CLI sentence for a ledger that threw on the way up.
 *
 * **Two fixes (fix pass, finding 2).** The base was `COORDINATION_UNAVAILABLE`, which says the BUILD has no
 * ledger — the very lie gap 1 set out to stop, since a build that can throw `ENOTDIR` from `openLedger`
 * demonstrably has one. `COORDINATION_NOT_OPENABLE` names the home instead, and the two "in this build"
 * sentences are reserved for the two causes that really are true of the build. And the cause goes through
 * `safeCause`, which strips paths BEFORE the redactor — `createRedactor` knows secret values and API-key shapes
 * and nothing else, so every errno message used to print its absolute path straight to stderr.
 */
export function coordinationOpenFailed(cause: string, redact: (s: string) => string): string {
  return `${COORDINATION_NOT_OPENABLE} (${safeCause(cause, redact)})`;
}

/**
 * One line, bounded. The default bound is generous because the §12 sentences a refusing verb prints are
 * *designed* strings (the `pair` refusal names two working verbs), and truncating one mid-word turns a sentence
 * that documents itself into a fragment; `detail60` passes its own 60 (§13.3's field, not a message).
 */
function oneLineCause(s: string, max = 220): string {
  return withoutPaths(s).replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * §7 row 61 (fix pass, finding 2): one line, no path, then the caller's redactor. The ORDER matters — the
 * redactor only knows secret values and key SHAPES, so a path that reached it survived to stderr; the property
 * test in `test/unit/session/coordination.test.ts` now drives this function with the PRODUCTION redactor.
 */
function safeCause(s: string, redact: (x: string) => string, max = 220): string {
  return withoutPaths(redact(oneLineCause(s, max)));
}

/**
 * §2.10 / §13.3: `SessionsAckRow` / `SessionsInboxRow` carry an **id8**, never a full device id — the full id is a
 * secret derivative (`src/core/types.ts`'s `SessionActivityView.deviceId8` says so) and `sessions inbox --json` is
 * a JSON sink (§7 row 61, §13.2 clause 8).
 */
const ID8 = 8;

export async function openCoordination(input: OpenCoordinationInput): Promise<CoordinationOpen> {
  const availability = await coordinationAvailability({ home: input.home, ...(input.read !== undefined ? { read: input.read } : {}), ...(input.homeIo !== undefined ? { io: input.homeIo } : {}) });
  if (availability.kind === 'off') return { kind: 'off', reason: availability.reason, message: coordinationOffText(COORDINATION_UNAVAILABLE, availability.reason) };
  const nowIso = input.nowIso ?? ((): string => new Date().toISOString());
  try {
    // §2.1 rule 3a: the ONE place this CLI path loads the coordination tree
    const c = await (input.facade ?? ((): Promise<typeof import('../coordination/index.js')> => import('../coordination/index.js')))();
    const root = c.coordinationRoot(input.home);
    const identity = await c.deviceIdentity({ root, fs: c.nodeFs, hostname: input.hostname, username: input.username, jevcode: input.jevcode, nowIso: nowIso(), ...(input.label !== undefined ? { label: input.label } : {}) });
    const self: SelfIdentity = {
      deviceId: identity.device.deviceId,
      label: identity.device.label,
      host: input.hostname,
      user: input.username,
      ...(identity.hostKey !== undefined ? { hostKey: identity.hostKey } : {}),
      bootAt: input.bootAt ?? bootAtNow(),
      // a READER: this CLI twin is not a session and must never appear in its own `who`
      sessionId: null,
      runId: null,
      wsKey: c.wsKeyOf(input.workspace),
      repoKey: input.repoKey ?? null,
      remoteKey: input.remoteKey ?? null,
      branch: input.branch ?? null,
    };
    /**
     * Two options the CLI twin must get right, each a defect the fix pass found:
     *
     *  - **`actor8` (finding 1, a blocker).** Without it `LedgerImpl.open()` takes the SESSIONLESS path: it
     *    persists `tuiActor8` in `machine.json` and reuses it on every launch (`ledger.ts:524–540`), while the
     *    stamp counter `n` is seeded only from records this process can fold — and a message addressed at a
     *    PEER's sessionId is not in our own target set, so it never raises the seed. Consecutive
     *    `jevcode sessions tell` processes therefore minted IDENTICAL `<deviceId>-<actor8>-<n>` message ids and
     *    `foldRecords` dropped all but one (`fold.ts:273`): three files on disk, one message delivered, and the
     *    CLI printed `delivered to 1 session` each time. A fresh random `actor8` per invocation makes the id
     *    unique without touching `src/coordination/**`, and it is safe HERE precisely because the CLI only
     *    `loadSeen`s and never marks seen — the reason the id is persisted for a TUI (one `inbox/seen/**` file
     *    per launch, forever) cannot arise.
     *  - **`scanOnly` (finding 13).** `open()` builds a `createWatcher`, attaches `fs.watch` to every device
     *    subtree and starts a 15 s poll timer unless `scanOnly` is set (`ledger.ts:547`). A one-shot verb exits
     *    milliseconds later and passes no `onChange`, so the watcher had no consumer at all; a long-lived caller
     *    (a future `src/cli/session.ts` reader) asks for changes and gets them.
     */
    const handle = c.openLedger({
      home: input.home,
      self,
      pid: input.pid,
      redact: input.redact,
      actor8: input.actor8 ?? c.mintActor8(),
      ...(input.onChange === undefined ? { scanOnly: true } : {}),
      ...(input.sharedDir !== undefined ? { sharedDir: input.sharedDir } : {}),
    });
    // §15.2: the mount read. `open()` scans, folds and seats `handle.fold`; nothing below ever copies it.
    await handle.open();
    return { kind: 'open', coordination: coordinationOver(c, handle, self, input) };
  } catch (e) {
    return { kind: 'off', reason: 'error', message: coordinationOpenFailed(e instanceof Error ? e.message : String(e), input.redact) };
  }
}

/**
 * §2.10: the seventeen-verb seam over one open `LedgerHandle`. Separated from `openCoordination` so the whole
 * verb surface is testable against a mocked facade and a fake handle without a filesystem (§10, R5-1's table).
 */
export function coordinationOver(c: typeof import('../coordination/index.js'), handle: LedgerHandle, self: SelfIdentity, input: Pick<OpenCoordinationInput, 'redact' | 'onChange'>): SessionsCoordination {
  /**
   * §2.5 / §13.3: the coordination `to` list behind each `SessionsTarget` this instance handed out. The CLI's
   * `SessionsTarget` carries a **runId** (that is what `sessions pause --json` prints), while `send()` addresses a
   * **sessionId**, a `@<repoKey>` or `@all`; without this map a `pause <run-id>` was written to a `to` no reader
   * subscribes to and vanished. Bounded by the number of targets one process resolves.
   */
  const routes = new Map<string, readonly string[]>();
  const unsub = input.onChange === undefined ? null : handle.subscribe(() => input.onChange?.());
  /** §15.2: the read after every own write — `adoptOwn` does not `emit()`, so a write is not a fold change. */
  const afterWrite = async (): Promise<void> => {
    try {
      await handle.refresh();
    } catch {
      /* a refresh that failed costs one stale row in the answer, never the verb */
    }
  };
  /** §10.3: `trusted-devices.json`, re-read after a write that can change it — the `paired` column of every device row. */
  let trustedIds: ReadonlySet<string> = new Set<string>();
  const devices = (): readonly SessionsDeviceRow[] => [...handle.fold.devices.values()].map((d) => ({ id8: d.deviceId.slice(0, ID8), label: d.label, paired: trustedIds.has(d.deviceId), ignored: d.ignored }));
  const reloadTrusted = async (): Promise<void> => {
    try {
      trustedIds = new Set((await c.readTrusted(c.nodeFs, handle.paths.hostDir)).map((t) => t.deviceId));
    } catch {
      /* an unreadable trust file is "nothing is paired", never a failed verb (§10.3) */
      trustedIds = new Set<string>();
    }
  };
  /**
   * The first trust read, awaited by every verb that prints a device row rather than fired and forgotten: a
   * `paired: false` printed because a promise had not settled yet is a wrong answer, not a slow one.
   */
  const trustReady = reloadTrusted();
  const rowsOfFold = (all: boolean): readonly SessionActivityView[] => c.listSessions(handle.fold, self, { all }).map(activityView);
  const routeOf = (to: string): readonly string[] => routes.get(to) ?? (to === BROADCAST_TARGET ? ['@all'] : [to]);
  /**
   * §13.3 (fix pass, finding 4): the DEVICE behind a route target, as an id8. A route holds session ids (or the
   * literal `@all`), and truncating one of those into a field named `deviceId` handed a `--json` consumer the
   * date head of a run id. `@all`, and a row that has left the fold between the resolve and the write, are our
   * own refusal, so they carry our own device — which keeps the promise the field name makes: every value is
   * one of `devices[].id8`.
   */
  const deviceId8Of = (target: string): string => {
    for (const hb of [...handle.fold.live.values(), ...handle.fold.gone.values()]) {
      if (hb.sessionId === target || hb.runId === target) return hb.deviceId.slice(0, ID8);
    }
    return self.deviceId.slice(0, ID8);
  };

  return {
    self: () => selfView(self, handle.fold),
    activity: (opts) => Promise.resolve(rowsOfFold(opts.all === true)),
    skipped: () => handle.fold.skipped,
    resolve: (text) => Promise.resolve(toSessionsTarget(resolveTargetGrammar(text, handle.fold, selfView(self, handle.fold)), handle.fold, routes)),
    /**
     * §2.9 / §13.3 (fix pass, finding 3 and finding 4): `delivered` counts RECIPIENTS, not write attempts, and
     * a refusal names a real device.
     *
     * `routeOf('@all')` is the single literal `['@all']` — one outbox file that every live row reads — so the
     * loop hard-wired `delivered: 1` and `ok: true` for a broadcast on a machine with no other session at all,
     * and `sessionsControl`'s `sent.delivered === 0` branch ("no live session accepted it") was unreachable for
     * it. A broadcast's count is therefore read from the FOLD; a directed send keeps the per-route count, which
     * for a resolved live target is the number of sessions the route names.
     */
    async send(m) {
      const to = routeOf(m.to);
      const broadcast = to.length === 1 && to[0] === BROADCAST_TARGET;
      let written = 0;
      const refused: SessionsRefusedRow[] = [];
      let messageId = '';
      for (const one of to) {
        try {
          const r = await c.send(handle, { to: one, type: m.type, text: m.text, by: 'human' });
          messageId = messageId === '' ? r.id : messageId;
          written += 1;
        } catch (e) {
          refused.push({ deviceId8: deviceId8Of(one), target: one, detail60: oneLineCause(e instanceof Error ? e.message : String(e), 60) });
        }
      }
      await afterWrite();
      // the broadcast's reach is the number of live rows the `@all` outbox is read by, and zero when the one
      // write failed; a directed route delivered exactly what it wrote
      const delivered = broadcast ? (written === 0 ? 0 : c.listSessions(handle.fold, self, { all: false }).length) : written;
      return { messageId, delivered, refused };
    },
    async inbox() {
      const seen = await c.loadSeen(handle);
      return c.inbox(handle.fold, self, seen).map((m: Message) => inboxRowOf(c, handle.fold, m));
    },
    async publicInbox() {
      const seen = await c.loadSeen(handle);
      return c.inbox(handle.fold, self, seen).map((m: Message) => ({ ...c.publicMessage(m), unverified: inboxRowOf(c, handle.fold, m).unverified }));
    },
    acks: () =>
      Promise.resolve(
        [...handle.fold.acks.values()].flat().map((a) => ({
          msgId: a.msgId,
          by: a.by,
          // §7 row 61 / §13.2 clause 8 as amended: the id8 under a name that SAYS id8 (fix pass, finding 10)
          deviceId8: a.deviceId.slice(0, ID8),
          at: a.at,
          outcome: a.outcome,
          ...(a.detail60 !== undefined ? { detail60: a.detail60 } : {}),
        })),
      ),
    async label(next) {
      await trustReady;
      const rec = await c.setDeviceLabel(handle, next);
      await afterWrite();
      return { id8: rec.deviceId.slice(0, ID8), label: rec.label, paired: trustedIds.has(rec.deviceId), ignored: false };
    },
    /**
     * §2.10 / §7 row 66: **not wired, and it says so.** `sessions pair` is the 8-word phrase → scrypt transport of
     * `docs/COORDINATION-DESIGN.md` §10.3, and `src/coordination/**` (read-only this round) exports the *second*
     * half only — `pairDeviceOn({ deviceId, label, keyHex })` pairs with a peer whose key you already hold. There
     * is no phrase builder to call, and minting one here would print a secret this build cannot then consume, so
     * the verb refuses by name. Request R5-H5 in the report carries the hunk.
     */
    pair: () => Promise.reject(new ConfigError("pairing is not wired in this build — the phrase transport of COORDINATION-DESIGN §10.3 has no builder in the coordination facade; 'jevcode sessions label' and 'jevcode sessions unpair' do work")),
    /**
     * §12.1 S35 (fix pass, finding 12): the label in the sentence is resolved by the SAME resolver that performed
     * the write.
     *
     * The local lookup took the first `deviceId === ref || startsWith(ref) || label === ref` hit out of
     * `fold.devices` with no ambiguity check, while `unpairDeviceOn` uses `resolveDeviceRef`, which also
     * understands `label#id4` and REFUSES an ambiguous ref (`ledger.ts:1858`). With `ref = 'mbp#ab12'` the local
     * lookup missed and S35 printed the raw ref; with two devices sharing a label prefix the two resolvers could
     * name different devices, so the sentence said one device had been unpaired and another had been. Resolving
     * AFTER the write, through `allDeviceIds()` + `resolveDeviceRef`, means the two cannot disagree — and the
     * disk walk also reaches the devices past `MAX_DEVICES` (16) that `fold.devices` caps away.
     */
    async unpair(ref) {
      await trustReady;
      await c.unpairDeviceOn(handle, ref);
      await reloadTrusted();
      await afterWrite();
      return { label: await unpairedLabel(handle, ref), devices: devices() };
    },
    async gc(opts) {
      await trustReady;
      if (opts.device === undefined) {
        const r = await c.gc(handle);
        await afterWrite();
        return { removed: r.removed, devices: devices() };
      }
      // §7 row 14: `ignoreDeviceOn` resolves the ref by walking the DISK to `MAX_GC_DEVICES` (1,024), never through
      // `fold.devices`, which caps at `MAX_DEVICES` (16) — the fold cannot reach the junk this verb exists to remove.
      await c.ignoreDeviceOn(handle, opts.device, opts.device);
      await afterWrite();
      // fix pass, finding 11: a LOCAL TOMBSTONE removes nothing. `removed: 0`, `ignored: 1`, and the sentence says so.
      return { removed: 0, ignored: 1, devices: devices() };
    },
    async syncStatus() {
      await trustReady;
      const s = c.syncStatus(handle);
      return { mode: s.mode, state: s.state, lagMs: s.lagMs, reason: s.refused ?? s.code, devices: devices() };
    },
    async syncDisable() {
      await trustReady;
      const r = await c.syncDisable(handle);
      await afterWrite();
      return { removed: [...r.removed], devices: devices() };
    },
    async close() {
      unsub?.();
      await handle.close();
    },
  };
}

/**
 * §12.1 S35 (fix pass, finding 12): the label of the device `unpairDeviceOn(handle, ref)` just unpaired.
 *
 * `resolveDeviceRef` is the resolver the WRITE used, so this cannot name a different device; `allDeviceIds()`
 * is the disk walk, so a device past the fold's 16-row cap still gets its own name in the sentence. A ref that
 * no longer resolves (the record was removed by the unpair itself on some builds) falls back to the ref the
 * user typed, which is what they will recognise.
 */
async function unpairedLabel(handle: LedgerHandle, ref: string): Promise<string> {
  try {
    const ids = await handle.allDeviceIds();
    const id = handle.resolveDeviceRef(ref, ids);
    if (id === null) return ref;
    return handle.fold.devices.get(id)?.label ?? ref;
  } catch {
    return ref;
  }
}

/** §2.9 / §13.3: one fold message, flattened — no `hostKey`, no `checksum`, no `hmac` (§13.2 clause 8). */
function inboxRowOf(c: Pick<typeof import('../coordination/index.js'), 'authorityOf' | 'messageOrigin'>, fold: Fold, m: Message): SessionsInboxRow {
  return { id: m.id, from: m.from.label, type: m.type, text: m.text, at: m.t, unverified: c.authorityOf(c.messageOrigin(fold, m)) === 'unverified' };
}

/**
 * §2.5: `src/tui/commands/target.ts`'s grammar — the ONE resolver `/pause`, `/end`, `/tell` and these verbs share —
 * projected onto the CLI's `SessionsTarget`, and the `to` list the resolution implies recorded in `routes` so
 * `send()` addresses what the user named rather than re-guessing it.
 */
function toSessionsTarget(r: TargetResult, fold: Fold, routes: Map<string, readonly string[]>): SessionsTarget {
  if (r.kind === 'ambiguous') return { kind: 'ambiguous', text: r.text, candidates: r.candidates, truncated: r.truncated, message: r.message };
  if (r.kind === 'notFound') return { kind: 'notFound', text: r.text, message: r.message };
  /**
   * §2.5 (fix pass, finding 3): LIVE rows first, and a target that only a GONE row answers to is refused.
   *
   * `pick` searched `live ∪ gone` in one pass, so `jevcode sessions pause <a run that ended an hour ago>`
   * resolved, wrote a control message into a mailbox nothing reads and reported `delivered 1 / asked <label>`.
   * A gone row is still a `/resume` target and still answers `/who --all`, so the grammar keeps matching it —
   * what changes is that these verbs say it is gone instead of claiming they reached it.
   */
  const live = [...fold.live.values()];
  const gone = [...fold.gone.values()];
  const t = r.target;
  type Row = { runId: string; sessionId: string; deviceId: string; label: string; title60: string | null };
  let goneOnly = false;
  const pick = (test: (hb: Row) => boolean): { runId: string; to: readonly string[]; label: string } | null => {
    const hits = live.filter((hb) => test(hb));
    const rows = hits.length > 0 ? hits : gone.filter((hb) => test(hb));
    const first = rows[0];
    if (first === undefined) return null;
    goneOnly = hits.length === 0;
    return { runId: first.runId, to: [...new Set(rows.map((hb) => hb.sessionId))], label: first.label };
  };
  const hit =
    t.kind === 'all'
      ? { runId: BROADCAST_TARGET, to: ['@all'] as readonly string[], label: 'every live session on this repo' }
      : t.kind === 'run'
        ? pick((hb) => hb.runId === t.runId)
        : t.kind === 'session'
          ? pick((hb) => hb.sessionId === t.sessionId)
          : t.kind === 'title'
            ? pick((hb) => (hb.title60 ?? '') === t.title)
            : t.kind === 'device'
              ? pick((hb) => hb.label === t.label)
              : null;
  if (hit === null) {
    // `self` with no session (every CLI twin) and a target whose row left the fold between the two reads
    return { kind: 'notFound', text: r.id8 ?? '', message: unknownTargetMessage(r.id8 ?? '') };
  }
  if (goneOnly) return { kind: 'notFound', text: r.id8 ?? hit.label, message: goneTargetMessage(hit.label), reason: 'gone' };
  routes.set(hit.runId, hit.to);
  return { kind: 'resolved', runId: hit.runId, id8: r.id8 ?? hit.runId.slice(-ID8), label: hit.label };
}
