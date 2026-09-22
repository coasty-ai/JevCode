/**
 * The engine's side of the coordination ledger (docs/COORDINATION-DESIGN.md §4, §5, §6, §3.3; W2 item 17).
 *
 * Everything the loop needs from `src/coordination/**` lives behind this one object, for three reasons the design
 * states and one this file adds:
 *
 *  1. §12.0.1 rule 2 — the ledger is reached only through `src/coordination/index.ts`. This module is the engine's
 *     single importer of it, so the rule is checkable by reading one import list.
 *  2. §2.1 rule 3 — coordination never blocks a step it was not asked to block. Every method here is either
 *     fire-and-forget on the ledger's own promise chain or explicitly awaited by the `coordinate` stage under
 *     `strict`; nothing else on the step path awaits I/O.
 *  3. The OFF path is one `null`. `createCoordination` returns `null` whenever there is no handle, coordination is
 *     disabled, or the run is a bench task — and `EngineImpl` holds `CoordinationRuntime | null`, so "off" is not a
 *     flag threaded through twenty call sites but the absence of an object. That is what makes the M2-style
 *     byte-identity test (`engine-coordination-off.test.ts`) a statement about the code rather than about a config.
 *  4. Jev is never on this path (§2.1). Nothing here calls the decider, reads a Jev answer or waits on one, so
 *     `jev-off`, `--no-input` and an unreachable Jev produce byte-identical coordination behaviour.
 */
import type {
  Action,
  BlockingAnswer,
  BlockingRequest,
  CoordinationOptions,
  CoordinationStatus,
  EngineEvent,
  EngineRunPhase,
  MessageDisposition,
  StepCoord,
} from '../core/types.js';
import {
  type CoordinationFacts,
  type HeartbeatBase,
  type HeartbeatDynamic,
  type HeartbeatWriter,
  type LeaseCheck,
  type LeaseConflict,
  type LeaseHandle,
  type LeaseIntent,
  type LeaseOutcome,
  type LedgerHandle,
  type Message,
  type SelfIdentity,
  type SubworkEntry,
  STRICT_WAIT_MS,
  ack,
  buildFacts,
  claimRefusal,
  check,
  classifyIncoming,
  coordRecordOf,
  createHeartbeatWriter,
  declare,
  fenceYield,
  inbox,
  isExclusiveTreeCommand,
  listSessions,
  loadSeen,
  messageOrigin,
  mergeSubwork,
  release,
  removeSubwork,
  renew,
  requestedFor,
  shouldSkipInlineWait,
  subworkEntry,
} from '../coordination/index.js';

/** §3.3: the heartbeat's `subwork` is capped at 16 rows; the engine's live set is capped with it. */
export const SUBWORK_MAX = 16;
/** §4.3: `reason60` and `detail60` are 60 characters, clipped by the writer and re-checked by every reader. */
const SIXTY = 60;
/** §4.2: the `command60` a `type:'command'` lease carries. */
const COMMAND_60 = 60;

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

/**
 * §4.1: is this run coordinating at all?
 *
 * `enabled` defaults to `source !== 'bench'` — a `perf` run DOES coordinate, so §13 M9's step-overhead gate measures
 * the real path rather than a path the gate turned off; bench runs never do (a 512-task sweep would write 512
 * heartbeats and a lease per task, and the bench process writes one presence beat of its own instead, §4.7).
 */
export function coordinationEnabled(o: CoordinationOptions | undefined, source: 'cli' | 'bench' | 'perf'): boolean {
  if (o === undefined || o.ledger === null) return false;
  return o.enabled ?? source !== 'bench';
}

/** §4.1: `off` computes no conflict at all — presence only. `advisory` is the default. */
export function resolvedClaims(o: CoordinationOptions): 'advisory' | 'strict' | 'off' {
  return o.claims ?? 'advisory';
}

/**
 * §4.2: which actions coordinate. `edit | write | patch` lease their targets; `run` leases its command with
 * `paths: []`; `read` and `done` never coordinate — a read cannot conflict with anything and `done` touches nothing.
 */
export function coordinates(action: Action): boolean {
  return action.kind === 'edit' || action.kind === 'write' || action.kind === 'patch' || action.kind === 'run';
}

export interface CoordinateInput {
  step: number;
  action: Action;
  /** `draft.patchTargets` paths for a change action; empty for `run` */
  targets: readonly string[];
  branch: string | null;
  head: string | null;
  /** §8.4: the content shas the proposal was built on — `theyTouched` needs a real difference, not an intersection */
  fileMemory: Readonly<Record<string, string | null>>;
  /** §11 row 23: the workspace volume folds case */
  caseFold: boolean;
  /**
   * §4.3 step 4: the human pane, through the engine's existing `Confirmer` / `blocker` seam. `null` = no blocker
   * (`--no-input`, `--plain` piped, `--json`, bench), which is what `CoordinationOptions.default` decides for.
   */
  ask: ((req: BlockingRequest) => Promise<BlockingAnswer>) | null;
  /** the engine's blocking-id minter, so a coordination pane is numbered in the same sequence as every other */
  blockingId: () => string;
  /** the run's shared signal: an abort or a pause-now ends the wait at once */
  signal: AbortSignal;
  /**
   * §4.2 suspension check: the CURRENT sha256 of each target, read by the engine (this module owns no fs). Called
   * only when the writer reports the process was frozen past the heartbeat ttl, which is the one moment
   * `fileMemory` — the content the proposal was built on — may be describing a file a peer has since rewritten.
   * Pre-images do not exist yet at this point, which is exactly why the comparison has to be made here.
   */
  currentSha: (paths: readonly string[]) => Promise<Record<string, string | null>>;
}

/**
 * What the gate decided. `proceed` is the only outcome that lets the step run; `wait` and `worktree` are rule-1
 * discards (the step is re-proposed, or the run stops for relocation); `stale` is §4.2's suspension check finding
 * that the targets moved under a frozen process, which is a discard with a `replan` problem rather than a conflict.
 */
export type CoordinateOutcome =
  | { kind: 'proceed'; coord: StepCoord | null; waitedMs: number }
  | { kind: 'wait' | 'worktree'; coord: StepCoord; waitedMs: number }
  | { kind: 'stale'; changed: readonly string[]; waitedMs: number };

export interface CoordinationRuntimeInit {
  options: CoordinationOptions;
  ledger: LedgerHandle;
  base: HeartbeatBase;
  emit: (e: EngineEvent) => void;
  /** the engine's monotonic clock (`opts.now ?? performance-ish`), the same one the wait deadlines use */
  monotonicNow: () => number;
  /** wall clock, for the `waiting.untilMs` the surface counts down to */
  now: () => number;
  redact: (s: string) => string;
}

/**
 * The runtime. One per engine; `null` when coordination is off, so every call site reads `this.coord?.x()`.
 */
export class CoordinationRuntime {
  readonly ledger: LedgerHandle;
  readonly claims: 'advisory' | 'strict' | 'off';
  private readonly o: CoordinationOptions;
  private readonly emit: (e: EngineEvent) => void;
  private readonly monotonicNow: () => number;
  private readonly now: () => number;
  private readonly redact: (s: string) => string;
  private readonly writer: HeartbeatWriter;
  /** the lease this step holds, released at commit or discard (§4.3 step 7) */
  private lease: LeaseHandle | null = null;
  /** the last gate's facts, for `## Other sessions` and the status zone */
  private facts: CoordinationFacts | null = null;
  private lastConflicts = 0;
  private subwork: SubworkEntry[] = [];
  /** §5.1: messages this process has already delivered, so a re-fold does not re-deliver them */
  private seen = new Set<string>();
  private seenLoaded = false;
  /** §4.3 step 4 / §7.1: set while a strict wait holds the step; the status reads `phase: 'blocked'` */
  private waiting: CoordinationStatus['waiting'] = null;
  private unsubscribe: (() => void) | null = null;
  /** every fold change wakes the strict wait; the set is empty whenever nothing is waiting */
  private readonly wakers = new Set<() => void>();

  constructor(init: CoordinationRuntimeInit) {
    this.o = init.options;
    this.ledger = init.ledger;
    this.claims = resolvedClaims(init.options);
    this.emit = init.emit;
    this.monotonicNow = init.monotonicNow;
    this.now = init.now;
    this.redact = init.redact;
    this.writer = createHeartbeatWriter({
      ledger: init.ledger,
      base: init.base,
      onRefused: () => {
        this.notice('warn', 'coordination: this run is too large to describe in a 4 KiB heartbeat — peers will read it as stale');
      },
      onDegraded: () => {
        this.notice('info', 'coordination: the heartbeat dropped detail to fit 4 KiB (touched files, sub-work, plan)');
      },
    });
  }

  private notice(level: 'info' | 'warn', text: string): void {
    this.emit({ type: 'notice', step: null, kind: 'coordination', level, text });
  }

  // ── lifecycle (§3.3's six write points; the engine owns when, this owns what) ────────────────────────────────────

  /** §3.3 point 1 (`run:ready`): `phase:'running'`, an immediate beat, the 15 s timer armed, the fold subscribed. */
  start(patch: Partial<HeartbeatDynamic> = {}): void {
    this.writer.start({ phase: 'running', ...patch });
    this.unsubscribe = this.ledger.subscribe(() => {
      for (const w of this.wakers) w();
    });
  }

  /** §3.3 point 4: a status transition. Coalesced to one write per 250 ms by the writer itself. */
  set(patch: Partial<HeartbeatDynamic>): void {
    this.writer.set(patch);
  }

  /** §3.3 point 2: one beat on the ledger chain, never awaited by the loop. */
  beat(patch: Partial<HeartbeatDynamic> = {}): void {
    this.writer.beat(patch);
  }

  /** §3.3 point 5 (`finish`): `phase:'ended'`, tracked leases released, the timer cleared, the chain awaited. */
  async finish(patch: Partial<HeartbeatDynamic> = {}): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.writer.finish({ phase: 'ended', ...patch });
  }

  /** §3.3 point 6 (the `'exit'` handler): one bounded synchronous write, local only, never the mirror. */
  finishSync(patch: Partial<HeartbeatDynamic> = {}): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.writer.finishSync({ phase: 'ended', ...patch });
  }

  /** §12.0.1 rule 5: the engine calls this once after `run:ready` (`repoKey`, `runId`) and awaits the added-root walk. */
  setIdentity(patch: Parameters<LedgerHandle['setIdentity']>[0]): Promise<void> {
    return this.ledger.setIdentity(patch);
  }

  // ── sub-work rows (§6.1) ─────────────────────────────────────────────────────────────────────────────────────────

  /**
   * §6.1: a live sample / lane / probe / child. Bounded at 16 by `mergeSubwork`, and the heartbeat's degrade ladder
   * drops the whole set before it drops anything a peer needs to decide with (§3.3).
   */
  subworkStarted(kind: SubworkEntry['kind'], id: string, stage: string, detail: string, laneDir?: string): void {
    const e = subworkEntry({ kind, id, since: new Date(this.now()).toISOString(), stage, detail: clip(this.redact(detail), SIXTY), ...(laneDir !== undefined ? { laneDir } : {}) });
    this.subwork = mergeSubwork(this.subwork, e).slice(0, SUBWORK_MAX);
    this.writer.set({ subwork: this.subwork });
  }

  subworkEnded(kind: SubworkEntry['kind'], id: string): void {
    const next = removeSubwork(this.subwork, kind, id);
    if (next.length === this.subwork.length) return;
    this.subwork = next;
    this.writer.set({ subwork: this.subwork });
  }

  subworkRows(): readonly SubworkEntry[] {
    return this.subwork;
  }

  // ── the inbox (§5.4) ─────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * §5.4: every message addressed to this run's session that this process has not seen, with `classifyIncoming`'s
   * verdict. The engine APPLIES only what needs no `[y]`; everything else rides the `session:message` event and the
   * surface decides — the engine never asks a human anything about trust.
   *
   * The ack is the surface's too for a gated message (§5.4: "no ack is written yet"), so this writes one only for
   * what it applied or refused itself.
   */
  async pumpInbox(apply: (msg: Message, d: MessageDisposition) => 'delivered' | 'applied' | 'refused' | 'expired' | null): Promise<void> {
    if (!this.seenLoaded) {
      for (const id of await loadSeen(this.ledger)) this.seen.add(id);
      this.seenLoaded = true;
    }
    const fold = this.ledger.fold;
    for (const msg of inbox(fold, this.ledger.self, this.seen)) {
      this.seen.add(msg.id);
      const d = classifyIncoming(msg, {
        self: this.ledger.self,
        trusted: this.trustedDevices(),
        remoteControl: this.o.remoteControl ?? 'confirm',
        origin: messageOrigin(fold, msg),
        cloned: fold.cloned,
      });
      // a gated message is the surface's call: the engine reports it and applies nothing (§5.4, the `[y]` gate)
      const outcome = d.needsConfirm ? null : apply(msg, d);
      this.emit({ type: 'session:message', message: msg, disposition: d, applied: outcome });
      if (outcome !== null) await ack(this.ledger, msg.id, outcome, d.refused ?? undefined);
    }
  }

  /** §10.3: the paired devices whose hmac verified — `classifyIncoming`'s `trusted` input, never a display list. */
  private trustedDevices(): ReadonlySet<string> {
    const out = new Set<string>();
    for (const [id, d] of this.ledger.fold.devices) if (!d.ignored) out.add(id);
    return out;
  }

  /** §5.4 / §12.0.4: the ack the SURFACE owes once the human answered a gated control message. */
  ack(msgId: string, outcome: 'delivered' | 'applied' | 'refused' | 'expired', detail60?: string): Promise<void> {
    return ack(this.ledger, msgId, outcome, detail60);
  }

  // ── the coordinate micro-stage (§4.2 – §4.5) ─────────────────────────────────────────────────────────────────────

  /**
   * §4.2, the whole gate: declare → check → proceed | wait | worktree.
   *
   * Under `advisory` nothing is awaited and nothing is delayed — the conflict becomes a FACT (`StepRecord.coord`, a
   * `notice`, a `## Other sessions` line for the next prompt) and the step proceeds now (§2.1 rule 3, G1(b)).
   * Under `strict` the exclusive lease is awaited, the F1/F2 fence runs, and only then may the step be held.
   */
  async coordinate(input: CoordinateInput): Promise<CoordinateOutcome> {
    const t0 = this.monotonicNow();
    // §4.2 suspension check: the PROCESS was frozen (a closed lid, Ctrl-Z), so peers have long read our leases as
    // expired and our fold is a lie. Re-fold, re-beat, and compare the targets against the content the proposal was
    // built on — a mismatch is a rule-1 discard, not a conflict.
    if (this.writer.suspended()) {
      // (a) re-fold and (b) re-beat at once: peers have treated our leases as expired for longer than the ttl.
      await this.ledger.refresh('leases');
      this.renewLease();
      this.writer.beat();
      // (c) every target whose CONTENT moved since the proposal was built. A file we never had a sha for cannot be
      // said to have changed — `undefined` is ignorance, not a difference — and a `run` has no targets at all.
      if (input.targets.length > 0) {
        const nowSha = await input.currentSha(input.targets);
        const changed = input.targets.filter((p) => {
          const known = Object.prototype.hasOwnProperty.call(input.fileMemory, p) ? input.fileMemory[p] : undefined;
          return known !== undefined && (nowSha[p] ?? null) !== known;
        });
        if (changed.length > 0) return { kind: 'stale', changed, waitedMs: 0 };
      }
    }
    if (this.claims === 'off') {
      // presence only: the lease still exists (a peer must see what we are about to touch), the judgment does not
      this.declareAdvisory(input);
      return { kind: 'proceed', coord: null, waitedMs: 0 };
    }
    const mine = this.intentFor(input);
    const first = check(this.ledger.fold, this.ledger.self, mine, { fileMemory: input.fileMemory, caseFold: input.caseFold });
    if (this.claims === 'advisory') {
      this.lease = declare(this.ledger, mine, 'advisory');
      this.writer.track(this.lease);
      const coord = this.recordFacts(input.step, first, mine);
      this.announce(input.step, first);
      return { kind: 'proceed', coord, waitedMs: 0 };
    }
    return await this.strict(input, mine, first, t0);
  }

  /** §4.1 `off`: a lease is still declared (presence), but no conflict is computed and nothing is announced. */
  private declareAdvisory(input: CoordinateInput): void {
    const mine = this.intentFor(input);
    this.lease = declare(this.ledger, mine, 'advisory');
    this.writer.track(this.lease);
  }

  /**
   * §4.2 / §4.3: the lease this step wants. A change action leases its targets as `intent`; a `run` leases its
   * command as `type:'command'` with `paths: []`, and `exclusiveTree` when the command is the build / perf / pty
   * class — the r3 rule "never build while another slot may be", which falls out of `isExclusiveTreeCommand`.
   */
  private intentFor(input: CoordinateInput): LeaseIntent {
    const a = input.action;
    if (a.kind === 'run') {
      const command = clip(this.redact(a.command), COMMAND_60);
      return {
        paths: [],
        type: 'command',
        command60: command,
        ...(isExclusiveTreeCommand(a.command) ? { exclusiveTree: true } : {}),
        reason60: clip(`run ${command}`, SIXTY),
        step: input.step,
        stage: 'coordinate',
        branch: input.branch,
        head: input.head,
      };
    }
    return {
      paths: [...input.targets],
      type: 'intent',
      reason60: clip(`${a.kind} ${input.targets[0] ?? ''}`, SIXTY),
      step: input.step,
      stage: 'coordinate',
      branch: input.branch,
      head: input.head,
    };
  }

  /** §4.1: the facts this step carries — `StepRecord.coord`, the prompt's `## Other sessions`, the status count. */
  private recordFacts(step: number, c: LeaseCheck, mine: LeaseIntent): StepCoord | null {
    const requested = requestedFor(this.ledger.fold, this.ledger.self, mine.paths, undefined, { caseFold: false });
    const facts = buildFacts({ step, check: c, messages: this.ledger.fold.inbox, others: this.ledger.fold.live.size });
    if (requested.length > 0) facts.requested = requested.slice(0, 8);
    this.facts = facts;
    this.lastConflicts = facts.conflicts.length;
    if (facts.conflicts.length === 0 && facts.requested.length === 0) return null;
    const coord = coordRecordOf(facts);
    this.emit({ type: 'coordination:facts', step, coord });
    return coord;
  }

  /** §4.1: one `notice kind:'coordination' level:'warn'` per conflicting path — a heads-up, never a gate. */
  private announce(step: number, c: LeaseCheck): void {
    if (c.kind !== 'conflict') return;
    for (const x of c.conflicts.slice(0, 8)) {
      this.emit({
        type: 'notice',
        step,
        kind: 'coordination',
        level: 'warn',
        text: `heads-up: ${x.path} is being edited by ${x.holder.label} (step ${String(x.holderStep)}, ${Math.round(x.agoMs / 1000)} s ago)`,
      });
    }
    for (const r of c.requested.slice(0, 8)) {
      this.emit({ type: 'notice', step, kind: 'session', level: 'info', text: `${r.by} asks you to release ${r.path}` });
    }
  }

  /**
   * §4.4 / §4.5: the strict path. The exclusive rewrite is awaited, `refreshFence` guarantees a readdir that STARTS
   * after it, and F1 yields ON SIGHT of any lease that appeared in that window — never on a stamp comparison, which
   * is what let both writers proceed in revision 3.
   */
  private async strict(input: CoordinateInput, mine: LeaseIntent, first: LeaseCheck, t0: number): Promise<CoordinateOutcome> {
    const waited = (): number => Math.max(0, this.monotonicNow() - t0);
    const opts = { fileMemory: input.fileMemory, caseFold: input.caseFold };
    let decided = await declare(this.ledger, mine, 'strict', { ...opts, snapshot: first.snapshot });
    this.lease = decided;
    this.writer.track(decided);
    for (;;) {
      if (decided.fence === 'blind') {
        // §4.5: blind is REFUSED, not assumed — a peer beyond the bound may hold an overlapping exclusive lease and
        // strict promises a decision it can no longer make. The human (or the default) decides instead.
        this.notice('warn', `coordination: the claim fence could not finish (${String(decided.scanned)} of ${String(decided.total)} devices) — strict cannot decide this step`);
        const coord = this.recordFacts(input.step, first, mine) ?? { conflicts: [] };
        return await this.judge(input, mine, first.kind === 'conflict' ? first.conflicts : [], coord, 'blind', waited);
      }
      const refold = decided.refold;
      // TWO different things can hold this step, and §4.3 / §4.5 answer them differently:
      //  · `appeared` — a lease that turned `exclusive` INSIDE my write-then-read window. F1 says yield on sight;
      //    F2 (`fenceWake`) decides when to re-declare, over the CAPTURED stamps.
      //  · a holder that was already `exclusive` at my `check()` — no race at all, and nothing to yield to: it is
      //    simply someone else's turn. The wait is for the fold to say they released.
      // Revision 4 collapsed the two and judged only `appeared`, which made every pre-existing holder invisible to
      // strict — the one case the mode exists for.
      const conflicts = refold.kind === 'conflict' ? refold.conflicts : [];
      if (decided.proceed && conflicts.length === 0) {
        const coord = this.recordFacts(input.step, refold, mine);
        this.announce(input.step, refold);
        if (coord !== null) coord.decision = 'proceed';
        const w = waited();
        if (w > 0) this.emit({ type: 'coordination:decision', step: input.step, decision: 'proceed', by: 'fence', waitedMs: w, paths: mine.paths });
        return { kind: 'proceed', coord, waitedMs: w };
      }
      const coord = this.recordFacts(input.step, refold, mine) ?? { conflicts: [] };
      this.announce(input.step, refold);
      // §4.3 step 4: the inline wait is skipped straight to the judgment when nobody is about to release — a holder
      // mid-`execute` on an `exclusiveTree` build of unknown length, or one parked `blocked` / `pausing` on a pane.
      if (shouldSkipInlineWait(conflicts)) return await this.judge(input, mine, conflicts, coord, 'skip', waited);
      if (!decided.proceed) {
        const wait = await fenceYield(this.ledger, mine, decided);
        const verdict = await this.waitForWake(input, conflicts, t0, (nowMono) => wait.wake(this.ledger.fold, nowMono));
        if (verdict !== 'go') return await this.judge(input, mine, conflicts, coord, 'deadline', waited);
        decided = await wait.redeclare();
      } else {
        // nothing to yield to: hold the exclusive lease and wait for the holder to let go. A fresh `check()` on each
        // fold change is the wake condition, and the re-declare carries ITS snapshot as the next `seen` (§4.5).
        const verdict = await this.waitForWake(input, conflicts, t0, () => (check(this.ledger.fold, this.ledger.self, mine, opts).kind === 'clear' ? 'redeclare' : 'keep-waiting'));
        if (verdict !== 'go') return await this.judge(input, mine, conflicts, coord, 'deadline', waited);
        decided = await declare(this.ledger, mine, 'strict', { ...opts, snapshot: check(this.ledger.fold, this.ledger.self, mine, opts).snapshot });
      }
      this.lease = decided;
      this.writer.track(decided);
    }
  }

  /**
   * §4.5 F2: wait on the CAPTURED yield. Every fold change and the deadline are the only wakes; the run's own signal
   * ends it at once, because a pause-now or an abort must not be held behind a peer.
   */
  private async waitForWake(input: CoordinateInput, conflicts: readonly LeaseConflict[], t0: number, wake: (nowMono: number) => 'keep-waiting' | 'redeclare' | 'deadline'): Promise<'go' | 'stop'> {
    const capMs = this.o.strictWaitMs ?? STRICT_WAIT_MS;
    const deadlineMono = t0 + capMs;
    const holder = conflicts[0]?.holder.label ?? 'another session';
    this.waiting = { paths: conflicts.map((c) => c.path), holder, untilMs: this.now() + capMs };
    this.writer.set({ phase: 'blocked' });
    try {
      for (;;) {
        const v = wake(this.monotonicNow());
        if (v === 'redeclare') return 'go';
        if (v === 'deadline' || input.signal.aborted) return 'stop';
        const left = deadlineMono - this.monotonicNow();
        if (left <= 0) return 'stop';
        // a fold change, the run's signal, or the deadline — never a spin
        if (!(await this.sleepUntilChange(Math.min(left, capMs), input.signal))) return 'stop';
      }
    } finally {
      this.waiting = null;
      this.writer.set({ phase: 'running' });
    }
  }

  /** One wake: a fold change, the run's signal, or the timeout. Returns false when the timeout or the signal won. */
  private sleepUntilChange(ms: number, signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (v: boolean): void => {
        if (done) return;
        done = true;
        this.wakers.delete(waker);
        signal.removeEventListener('abort', onAbort);
        clearTimeout(timer);
        resolve(v);
      };
      const waker = (): void => finish(true);
      const onAbort = (): void => finish(false);
      const timer = setTimeout(() => finish(false), Math.max(1, ms));
      this.wakers.add(waker);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * §4.4: the judgment. The human's pane decides; with no blocker the configured default does, and it is
   * `'proceed'` unless the caller said otherwise — a headless run that waited 60 s and then stopped would turn every
   * unattended overlap into a failed run.
   */
  private async judge(
    input: CoordinateInput,
    mine: LeaseIntent,
    conflicts: readonly LeaseConflict[],
    coord: StepCoord,
    why: 'blind' | 'skip' | 'deadline',
    waited: () => number,
  ): Promise<CoordinateOutcome> {
    const first = conflicts[0];
    const detail =
      first === undefined
        ? `the claim fence could not decide this step (${why})`
        : `${first.path} is held by ${first.holder.label} (step ${String(first.holderStep)}, ${first.holderStage}) — ${conflicts.length > 1 ? `${String(conflicts.length)} paths overlap` : 'one path overlaps'}`;
    let answer: BlockingAnswer;
    let by: 'human' | 'default';
    if (input.ask === null) {
      answer = (this.o.default ?? 'proceed') === 'proceed' ? 'continue' : 'wait';
      by = 'default';
    } else {
      answer = await input.ask({ id: input.blockingId(), step: input.step, kind: 'lease-conflict', detail: this.redact(detail), stop: 'human_pause', exitCode: 4 });
      by = 'human';
    }
    const w = waited();
    // `[w] wait` at the pane and a `stop` with `default: 'wait'` are the same discard: the step is re-proposed, and
    // the next `coordinate` re-checks. `pause` is the engine's — it already set its flags; the discard carries it.
    const decision: StepCoord['decision'] = answer === 'continue' ? 'continue' : answer === 'worktree' ? 'worktree' : 'wait';
    coord.decision = why === 'blind' && decision === 'continue' ? 'blind' : decision;
    coord.waitedMs = w;
    this.emit({ type: 'coordination:decision', step: input.step, decision: coord.decision, by, waitedMs: w, paths: mine.paths });
    if (decision === 'continue') return { kind: 'proceed', coord, waitedMs: w };
    return { kind: decision, coord, waitedMs: w };
  }

  // ── commit / discard (§4.3 step 7) ───────────────────────────────────────────────────────────────────────────────

  /**
   * §4.3 step 7 / §3.3 point 2: the step committed (or was discarded). The lease is released with the outcome and
   * the post-image set, and one beat goes out with what was touched — both on the ledger chain, neither awaited by
   * the loop, and both hung off `pendingCheckpoint.then` so a ledger errno can never be read as `state.json` failing.
   */
  released(outcome: LeaseOutcome, changed?: Record<string, string | null>, head?: string): void {
    const h = this.lease;
    if (h === null) return;
    this.lease = null;
    this.writer.untrack(h.leaseId);
    release(h, outcome, changed, head);
  }

  /** §4.3 step 7: the lease is renewed on every heartbeat tick; this is the explicit renew a long `execute` wants. */
  renewLease(): void {
    if (this.lease !== null) renew(this.lease);
  }

  /** §4.1: the facts the NEXT prompt's `## Other sessions` section renders (fenced, untrusted-data line). */
  currentFacts(): CoordinationFacts | null {
    return this.facts;
  }

  // ── the resume / fork gates (§9.3, §3.4, §11 rows 31 / 51) ─────────────────────────────────────

  /**
   * §9.3 / §11 row 31: is another incarnation of this run the holder?
   *
   * The verdict is computed over the IMMUTABLE claims (`Claim`, never the folding Lamport stamp), so both sides of a
   * fork agree whatever the sync timing. Three outcomes, and the difference between them is the whole of §10.3:
   *
   *   `{ stop }`   — a QUALIFIED (paired, hmac-valid) foreign claim supersedes mine. Only this may end a run: exit 2,
   *                  before a second writer can touch the run dir.
   *   `{ notice }` — an unverified claim outranks mine (§11 row 51). A forged record can produce this and nothing
   *                  more: it is a `⚠ forked` flag and a line, never a stop.
   *   `null`       — I hold it.
   */
  forkGate(runId: string): { stop: string } | { notice: string } | null {
    const v = this.ledger.forkVerdict(runId);
    if (v.role === 'loser' && v.verified) {
      const label = this.ledger.fold.devices.get(v.holder.deviceId)?.label ?? v.holder.deviceId.slice(0, 8);
      const mine = this.ledger.claim.epoch;
      return { stop: `run ${runId} is also live on ${label} (claim ${String(v.holder.epoch)} supersedes ${String(mine)}) — stopped to avoid a double writer` };
    }
    if (v.unverifiedFork) {
      const other = v.losers.find((c) => c.deviceId !== this.ledger.self.deviceId) ?? v.holder;
      const label = this.ledger.fold.devices.get(other.deviceId)?.label ?? other.deviceId.slice(0, 8);
      return { notice: `run ${runId} also appears live on ${label} (unverified) — continuing here` };
    }
    return null;
  }

  /**
   * §9.3, the RESUME gate: a claim epoch this device never minted, published by a device that may speak for it.
   *
   * `forkGate` reads live heartbeats; this reads the signed `claims.json` projections, which survive a peer being
   * offline and are the only way a resume can learn that another device took the run over while this one was away.
   * `local` is the run's own `RunMeta.claims[]` epochs — what THIS device has already minted.
   */
  async claimGate(runId: string, local: readonly number[]): Promise<{ deviceId: string; epoch: number } | null> {
    const foreign = await this.ledger.readClaimEpochs(runId);
    return claimRefusal(local, foreign);
  }

  /** §3.4: a live heartbeat for `runId` on ANOTHER device — what `src/session/lock.ts` needs and cannot compute. */
  foreignLive(runId: string): { label: string; step: number; beatAgeMs: number; verified: boolean } | null {
    const p = this.ledger.foreignLive(runId, { includeUnverified: true });
    return p === null ? null : { label: p.label, step: p.step, beatAgeMs: p.beatAgeMs, verified: p.verified };
  }

  // ── the status meter (§3.6, §8.7, §12.0.3) ───────────────────────────────────────────────────────────────────────

  /** §7.1: `blocked` while a strict wait holds the step; the engine's own flags decide everything else. */
  phase(): EngineRunPhase | null {
    return this.waiting === null ? null : 'blocked';
  }

  /**
   * §3.6 / §12.0.3: the projection the `⇄` zone, `/who` and `src/session/lock.ts` read. A projection, never the
   * fold: no Map, no record, nothing mutable, and every peer string has been through `oneLine` already (`listSessions`
   * builds its rows from parsed records, §3.6 rule (a)).
   */
  status(): CoordinationStatus {
    const fold = this.ledger.fold;
    const st = this.ledger.status();
    const self = this.ledger.self;
    const peers = listSessions(fold, self)
      .filter((s) => s.runId !== self.runId)
      .slice(0, 16)
      .map((s) => ({
        runId: s.runId,
        sessionId: s.sessionId,
        deviceId: s.deviceId,
        label: s.label,
        step: s.heartbeat.step,
        stage: s.heartbeat.stage,
        phase: s.heartbeat.phase,
        beatAgeMs: s.beatAgeMs,
        sameDevice: s.sameDevice,
        blocked: s.heartbeat.blocked,
        live: s.liveness === 'live',
        // §10.3: one deviceKey on two machines — the row says so, because every gated action is suspended for it
        cloned: s.flags.cloned,
      }));
    return {
      peers,
      live: peers.filter((p) => p.live).length,
      conflicts: this.lastConflicts,
      inbox: fold.inbox.filter((m) => !this.seen.has(m.id)).length,
      mirror: st.mirror === 'off' ? null : { state: st.mirror, code: st.mirrorCode, lagMs: st.syncLagMs },
      off: st.offline?.code ?? null,
      waiting: this.waiting,
    };
  }
}

/**
 * The one constructor. `null` is OFF, and it is the only way OFF is expressed (see the header): no handle, disabled,
 * or a bench run.
 */
export function createCoordination(init: { options: CoordinationOptions | undefined; source: 'cli' | 'bench' | 'perf'; base: HeartbeatBase; emit: (e: EngineEvent) => void; monotonicNow: () => number; now: () => number; redact: (s: string) => string }): CoordinationRuntime | null {
  const o = init.options;
  if (o === undefined || o.ledger === null || !coordinationEnabled(o, init.source)) return null;
  return new CoordinationRuntime({ options: o, ledger: o.ledger, base: init.base, emit: init.emit, monotonicNow: init.monotonicNow, now: init.now, redact: init.redact });
}

/** re-exported so the engine's one import of this module carries the identity type it must build a base from */
export type { HeartbeatBase, HeartbeatDynamic, SelfIdentity };
