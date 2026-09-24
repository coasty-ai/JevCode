/**
 * TUI-DESIGN-5 §2.10 / §12.1 / §1.4 promise 1 (slot R5-1, gap 1) — **why** the session ledger is not there.
 *
 * `docs/STATUS.md`'s "three honest gaps" names the hole this module closes with `openCoordination()`
 * (`src/cli/sessions.ts`): nothing constructed a `SessionsCoordination` in production, so thirteen
 * `jevcode sessions <verb>` verbs and both in-session reads answered *the session ledger is not available in
 * this build* to a real user whose ledger was perfectly openable. With the constructor wired, that sentence
 * must name **which** of the two real causes it is — coordination is off in this configuration, or the JevCode
 * home cannot be written — because "this build" is now a lie in every other case (D-AN's rule is an honest
 * answer, not merely a non-silent one).
 *
 * Three properties this module keeps, each a test in `test/unit/session/coordination.test.ts`:
 *
 *  1. **Zero value imports.** Every import here is `import type`, so a module on the argv path may hold the
 *     reason strings without pulling `src/coordination/**` or `node:fs` into the first frame's static graph
 *     (§2.1 rule 3a / rule 6, gate G-R5-1). The one filesystem read is behind `await import('node:fs/promises')`
 *     inside a function body.
 *  2. **No path, no pid, no key in any sentence.** The clauses below name a *setting* and a *condition*, never
 *     `home` itself — §7 row 61 and the property test over every produced string.
 *  3. **Never fatal.** Every answer is a value; nothing here throws, so a session whose ledger is off degrades
 *     to the `unknown` answers and keeps running (§1.4 promise 2).
 */

/** the two causes a build with `openCoordination()` wired can still have no ledger */
export type CoordinationOffReason = 'disabled' | 'unwritable';

/** §12.1 / §2.10 — the CLI sentence, unchanged as a PREFIX so every landed pin still matches. */
export const COORDINATION_UNAVAILABLE = 'the session ledger is not available in this build';
/** §12.1 / §2.3 — `/who`'s honest unknown while the ledger has not opened (`round5.pty.test.ts` pins it). */
export const COORDINATION_NOT_OPEN = 'the session ledger is not open yet';
/**
 * §12.1 — the THIRD base sentence (fix pass, finding 2). `COORDINATION_UNAVAILABLE` says *this build* has no
 * ledger, and with `openCoordination()` wired that is true of exactly two causes: the configuration and an
 * unwritable home. A ledger that threw on the way up (`ENOTDIR`, `EROFS`, a corrupt `device.json`) is a fault of
 * THIS HOME, not of the build, and printing "not available in this build" for it is the lie gap 1 set out to
 * stop. `coordinationOpenFailed` is the only user.
 */
export const COORDINATION_NOT_OPENABLE = 'the session ledger could not be opened here';

/**
 * The setting that turns coordination off.
 *
 * **Deviation, stated here rather than in a report only.** The brief names `coordination.enabled`; contract
 * 1.8 §8.1 item 7 landed **six** `coordination.*` rows — `claims`, `remoteControl`, `sync`, `syncRuns`,
 * `notify`, `maxChildren` — and no `enabled` among them, and gate G-R5-8 asserts `SETTINGS` against that list
 * out of the design file, so inventing a seventh row here would be a silent contract edit in a file this slot
 * does not own (`src/config/**`). `coordination.claims = off` is the value the shipped table already carries
 * for "coordination does nothing", so it is the switch, and the refusal names it verbatim — a user who reads
 * the sentence can undo it. `coordinationEnabledFrom` reads `coordination.enabled` **first** when a build ever
 * grows the row, so the swap costs no edit at any call site.
 */
export const COORDINATION_ENABLED_SETTING = 'coordination.enabled';
/** the row that exists today; `off` is the shipped "coordination does nothing" value */
export const COORDINATION_CLAIMS_SETTING = 'coordination.claims';

/** §12.1: the clause appended to the base sentence, one per reason. Never a path, never a pid (§7 row 61). */
export const COORDINATION_OFF_CLAUSE: Readonly<Record<CoordinationOffReason, string>> = {
  disabled: `coordination is off in this configuration (${COORDINATION_CLAIMS_SETTING} = off) — 'jevcode config set ${COORDINATION_CLAIMS_SETTING} advisory' turns it back on`,
  unwritable: 'the JevCode home (JEVCODE_HOME) cannot be written — no ledger can be opened there',
};

/**
 * §12.1: `<base> — <clause>`. `reason === null` answers the base sentence unchanged, which is what a build
 * with no coordination wiring at all (and every landed test that pins the bare string) still gets.
 */
/** The clause for a ledger that has no reason to be closed: an idle session opens it with its first run (gap-wave residual — an idle TUI has no row to publish), and the CLI reads the shared folder now. */
export const COORDINATION_IDLE_CLAUSE = 'it opens with your first run; `jevcode sessions who` lists the other sessions now';

export function coordinationOffText(base: string, reason: CoordinationOffReason | null): string {
  return reason === null ? base : `${base} — ${COORDINATION_OFF_CLAUSE[reason]}`;
}

/**
 * Is coordination on? `coordination.enabled` (a row no build has yet) wins when present; otherwise
 * `coordination.claims = off` is the switch. Absent / unreadable is **on**, because the default of every
 * shipped row is on and a config read that failed must not silently disable a feature.
 */
export function coordinationEnabledFrom(read: (name: string) => string | undefined): boolean {
  const enabled = read(COORDINATION_ENABLED_SETTING);
  if (enabled !== undefined && enabled.trim() !== '') return !FALSEY.has(enabled.trim().toLowerCase());
  return (read(COORDINATION_CLAIMS_SETTING) ?? '').trim().toLowerCase() !== 'off';
}

const FALSEY: ReadonlySet<string> = new Set(['0', 'false', 'no', 'off']);

/**
 * §12.1 / §7 row 61 (fix pass, finding 2): **every absolute path out of a sentence, before the redactor.**
 *
 * `createRedactor` substitutes *known secret values* and `patternRedact`'s `FORMAT_PATTERNS` are API-key shapes
 * only (`src/core/redact.ts:68`), so nothing in the redaction chain strips a path — and every errno message node
 * produces embeds one (`ENOTDIR: not a directory, mkdir '/Users/p/.jevcode/coordination/devices/4d4e6845'`). The
 * whole run is replaced with `<path>` rather than collapsed to its basename, because the basename of a device
 * subtree IS the `hostKey` (`devices/<hostKey>`, §3.1) and §7 row 61 forbids that in a sink too. A one-segment
 * token (`/who`, `/peers`, `/resume --force-takeback`) is left alone: the §12 sentences name commands, and a
 * lookbehind keeps a RELATIVE path whole (`editing src/loop/engine.ts` is a user's own `headsup` body, not a leak).
 */
const ABSOLUTE_PATH_RUN = /(?<![A-Za-z0-9_.-])(?:~|[A-Za-z]:)?(?:[/\\][^/\\\s'"`,;:)\]}]+){2,}[/\\]?/g;

/** §7 row 61: `<path>` for every absolute (or `~`-rooted) run of two or more segments. Pure; never throws. */
export function withoutPaths(s: string): string {
  return s.replace(ABSOLUTE_PATH_RUN, '<path>');
}

/** the one `node:fs/promises` member the home probe needs; injected by the tests, dynamic in production. */
export interface CoordinationHomeIo {
  access(path: string, mode: number): Promise<void>;
}

/** `fs.constants.W_OK`, re-declared so this module stays value-import free (§2.1 rule 6). */
export const W_OK = 2;

/** `dirname`, lexically — `node:path` is a value import and this module has none (§2.1 rule 6). */
function parentOf(home: string): string {
  const trimmed = home.replace(/[/\\]+$/, '');
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (at < 0) return '.';
  return at === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, at);
}

function errnoOf(e: unknown): string {
  return typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : '';
}

/**
 * Can a ledger be opened under this home? **Two `access(W_OK)` calls and no `mkdir`** (fix pass, finding 16): a
 * probe that answers "can a ledger be opened here?" must not be the thing that makes it openable, and the old
 * `mkdir -p` meant that merely typing `/who` in a session whose coordination never opens created the whole
 * `JEVCODE_HOME` tree. An existing home is probed directly; a home that does not exist yet asks its PARENT
 * whether we could create it, and anything else — `EACCES`, `ENOTDIR`, a home that is a file — is `false`.
 *
 * Never throws: this is a *pre-flight*, and a home we cannot even probe is a home we will not write to
 * (§1.4 promise 1).
 */
export async function coordinationHomeWritable(home: string, io?: CoordinationHomeIo): Promise<boolean> {
  try {
    const fs = io ?? (await import('node:fs/promises'));
    try {
      await fs.access(home, W_OK);
      return true;
    } catch (e) {
      // only "it is not there yet" may fall through to the parent; EACCES on an EXISTING home is a refusal
      if (errnoOf(e) !== 'ENOENT') return false;
    }
    await fs.access(parentOf(home), W_OK);
    return true;
  } catch {
    return false;
  }
}

/** what `coordinationAvailability` answers: open it, or do not and say which reason. */
export type CoordinationAvailability = { readonly kind: 'on' } | { readonly kind: 'off'; readonly reason: CoordinationOffReason };

/**
 * §2.10: the whole pre-flight, in the order the two reasons must be reported — configuration first (a user who
 * turned it off is not told their disk is broken), then the home. Nothing here opens a ledger.
 */
export async function coordinationAvailability(o: { home: string; read?: (name: string) => string | undefined; io?: CoordinationHomeIo }): Promise<CoordinationAvailability> {
  if (!coordinationEnabledFrom(o.read ?? (() => undefined))) return { kind: 'off', reason: 'disabled' };
  if (!(await coordinationHomeWritable(o.home, o.io))) return { kind: 'off', reason: 'unwritable' };
  return { kind: 'on' };
}

/**
 * §2.10 / §7 row 61: the reader `openCoordination` and `src/cli/session.ts` pass to `coordinationEnabledFrom`,
 * built from `ResolvedConfig.entries`. A secret is never read through it — the two coordination rows are not
 * secret — and a missing entry is `undefined`, which is "on".
 */
export function settingReader(entries: ReadonlyMap<string, { value: string }> | undefined): (name: string) => string | undefined {
  return (name: string) => entries?.get(name)?.value;
}
