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
import type { SelfIdentityView, SessionActivityView } from '../core/types.js';
import { EXIT_CODES } from '../errors.js';
import { INDEX_PRUNE_NOTICE_BYTES, indexSkippedNotice, indexTooLargeNotice, readIndex, reindex, splitIndexText, foldIndex } from '../session/index.js';
import { bootAtNow, lockInUseMessage, lockReplaceVerdict, readRunLock, releaseRunLock, isPidAlive, type LockReplaceReason } from '../session/lock.js';
import { foldCapNotice, labelResolver, WHO_EMPTY, whoFlagRow, whoHeader, whoPlainRow } from '../session/peers.js';
import { noSessionMessage, pickerHeader, pickerRows } from '../session/picker-lines.js';
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
   * TUI-DESIGN-5 §2.10: the verb, and the words after it. `src/cli/args.ts` parses only the first four verbs today
   * (`SessionsOp`, `:132`), so the thirteen coordination verbs arrive here until R5-6's §9.2 hunk widens it;
   * `flags.sessionsOp` still wins for the four it knows. `args` never contains the verb itself.
   */
  verb?: SessionsVerb;
  args?: readonly string[];
  /** TUI-DESIGN-5 §2.10: the narrow coordination seam; absent = no ledger in this build (every verb says so honestly) */
  coordination?: SessionsCoordination;
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
    io.stdout.write(`reindexed ${r.runs} run${r.runs === 1 ? '' : 's'} into ${io.indexPath}${r.skipped > 0 ? ` (${r.skipped} unreadable run dir${r.skipped === 1 ? '' : 's'} skipped)` : ''}\n`);
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
 * `src/cli/args.ts` still parses only the first four (`SessionsOp`, `:132`); widening it is a §9.2 request to R5-6
 * (R5-1's report carries the exact hunk). Until it lands the extra thirteen are reachable through `SessionsIo.verb`
 * / `SessionsIo.args`, which is also how `test/unit/cli/sessions.test.ts` drives all seventeen today.
 */
export type SessionsVerb = 'list' | 'reindex' | 'prune' | 'unlock' | 'who' | 'pause' | 'resume' | 'end' | 'tell' | 'headsup' | 'request' | 'inbox' | 'label' | 'pair' | 'unpair' | 'gc' | 'sync';

export const SESSIONS_VERBS: readonly SessionsVerb[] = ['list', 'reindex', 'prune', 'unlock', 'who', 'pause', 'resume', 'end', 'tell', 'headsup', 'request', 'inbox', 'label', 'pair', 'unpair', 'gc', 'sync'];

/** §2.5 / §13.3: the three outcomes of resolving a `<target>` word, as the CLI needs them. */
export type SessionsTarget =
  | { kind: 'resolved'; runId: string; id8: string; label: string }
  | { kind: 'ambiguous'; text: string; candidates: readonly { id8: string; title60: string; label: string }[]; truncated: boolean; message: string }
  | { kind: 'notFound'; text: string; message: string };

/** §2.10: one inbox row, flattened for the CLI (the `--json` form emits coordination's own `Message`/`Ack`). */
export interface SessionsInboxRow {
  id: string;
  from: string;
  type: string;
  text: string;
  at: string;
  unverified: boolean;
}

/** §13.3: one ack row, flattened — coordination's `Ack` minus `checksum`/`hmac` (§7 row 61, the clause below). */
export interface SessionsAckRow {
  msgId: string;
  by: string;
  deviceId: string;
  at: string;
  outcome: string;
  detail60?: string;
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
  send(input: { to: string; type: 'note' | 'heads-up' | 'request-release' | 'pause' | 'resume' | 'end'; text: string }): Promise<{ messageId: string; delivered: number; refused: readonly { deviceId: string; detail60: string }[] }>;
  inbox(): Promise<readonly SessionsInboxRow[]>;
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
  gc(opts: { device?: string }): Promise<{ removed: number; devices: readonly SessionsDeviceRow[] }>;
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

function needCoord(io: SessionsIo, verb: SessionsVerb): SessionsCoordination | null {
  if (io.coordination !== undefined) return io.coordination;
  io.stderr.write(`jevcode sessions ${verb}: the session ledger is not available in this build\n`);
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
  if (flags.json) jsonOut(io, t.kind === 'ambiguous' ? { ok: false, reason: 'ambiguous', candidates: t.candidates, message: t.message } : { ok: false, reason: 'notFound', message: t.message });
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
  const coord = needCoord(io, 'who');
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
  const coord = needCoord(io, verb);
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

/** §2.9 / §13.3: `sessions tell|request <target> <text>` — the two DIRECTED verbs. */
export async function sessionsMessage(verb: 'tell' | 'request', flags: ParsedFlags, io: SessionsIo, args: readonly string[]): Promise<number> {
  const coord = needCoord(io, verb);
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
  const coord = needCoord(io, 'headsup');
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

/**
 * §13.2, an eighth declared clause (round-5 fix pass, finding 18). §13.3 pins `sessions inbox --json` as
 * `{ messages, acks }` "serialising coordination's own types", but coordination's `Message` carries an optional
 * `hostKey` (`src/coordination/types.ts:262`) — a device-secret derivative §7 row 61 forbids in a JSON sink, which
 * is the very reason `SelfIdentityView` exists. The clause: *`inbox --json` emits the FLATTENED `SessionsInboxRow`
 * / `SessionsAckRow` projections, which carry no `hostKey`, no `checksum` and no `hmac`; the field names are
 * coordination's.* `acks` is a real read, never a hardcoded `[]`.
 */
export const SESSIONS_INBOX_JSON_CLAUSE = 'sessions inbox --json emits the flattened message/ack rows: no hostKey, no checksum, no hmac (§7 row 61)';

/** §2.9 / §13.3: `sessions inbox [--json]`. */
export async function sessionsInbox(flags: ParsedFlags, io: SessionsIo): Promise<number> {
  const coord = needCoord(io, 'inbox');
  if (coord === null) return EXIT_CODES.config;
  const rows = await coord.inbox();
  if (flags.json) {
    jsonOut(io, { messages: rows, acks: (await coord.acks?.()) ?? [] });
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
  const coord = needCoord(io, 'label');
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
  const coord = needCoord(io, 'pair');
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
  const coord = needCoord(io, 'unpair');
  if (coord === null) return EXIT_CODES.config;
  const ref = needArg(io, 'unpair', args, 'a device (a label, an id8 prefix or label#id4)');
  if (ref === null) return EXIT_CODES.config;
  const r = await coord.unpair(ref);
  if (flags.json) jsonOut(io, { ok: true, devices: r.devices });
  else io.stdout.write(`${unpairedSentence(r.label)}\n`);
  return EXIT_CODES.ok;
}

/** §2.10 / §7 row 14 / §13.3: `sessions gc [--device <label>]`. */
export async function sessionsGc(flags: ParsedFlags, io: SessionsIo, args: readonly string[]): Promise<number> {
  const coord = needCoord(io, 'gc');
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
  if (flags.json) jsonOut(io, { ok: true, devices: r.devices });
  else io.stdout.write(device === undefined ? `gc removed ${r.removed} record${r.removed === 1 ? '' : 's'}\n` : `gc removed ${r.removed} record${r.removed === 1 ? '' : 's'} of ${device}\n`);
  return EXIT_CODES.ok;
}

/** §2.10 / §13.3: `sessions sync status|disable`. */
export async function sessionsSync(flags: ParsedFlags, io: SessionsIo, args: readonly string[]): Promise<number> {
  const coord = needCoord(io, 'sync');
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

/** TUI-DESIGN §1 / TUI-DESIGN-5 §2.10: the `sessions` command dispatcher — seventeen verbs. */
export async function commandSessions(flags: ParsedFlags, io: SessionsIo): Promise<number> {
  // the precedence the `SessionsIo.verb` doc comment states: a verb `args.ts` PARSED wins over the injected seam
  const verb: SessionsVerb = flags.sessionsOp ?? io.verb ?? 'list';
  try {
    return await runSessionsVerb(verb, io.args ?? [], flags, io);
  } finally {
    await io.coordination?.close();
  }
}
