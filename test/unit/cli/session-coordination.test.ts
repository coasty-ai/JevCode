/**
 * TUI-DESIGN-5 §2.3 / §2.4 / §2.14 / §12.1 / §15.2 — **gap 1, the in-session half**: the read half and the write
 * half share ONE `LedgerHandle`, the fold is read on mount and subscribed, and when there will never be a ledger
 * the two surfaces say WHICH of the two reasons it is.
 *
 * `docs/STATUS.md`'s gap 1 records the state this file pins the fix of: `/who` answered
 * `who · unknown / the session ledger is not open yet` and `/peers` answered `peers · unknown` for every user,
 * with no way to tell "not open yet" (the honest §1.4 promise-1 state) from "off in this configuration" or
 * "this home cannot hold a ledger". The landed sentences are kept as PREFIXES so `round5.pty.test.ts` and the
 * §12 pins still match; the clause is appended.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Fold, LeaseIntent, SelfIdentity } from '../../../src/coordination/index.js';
import { emptyFold } from '../../../src/coordination/fold.js';
import type { SessionLedger, SessionLedgerInput } from '../../../src/session/publish.js';
import { COORDINATION_NOT_OPEN, COORDINATION_OFF_CLAUSE } from '../../../src/session/coordination.js';
import { PEERS_UNAVAILABLE_TEXT, peersFactText, peersNotOpenText } from '../../../src/chat/facts.js';
import { DEV_A, DEV_B, SELF, T0, TRUSTED, iso, makeDevice, makeHeartbeat, makeSelf, runId } from '../coordination/helpers.js';
import { harnessDecider, makeController, waitFor, type Harness } from './helpers.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function build(...args: Parameters<typeof makeController>): Promise<Harness> {
  const h = await makeController(...args);
  harnesses.push(h);
  return h;
}

const NOW = { wallMs: T0, monoMs: 1_000_000 };
const PEER = makeHeartbeat({ deviceId: DEV_B, label: 'air', pid: 7, runId: runId(2), sessionId: runId(2), startedAt: iso(T0 - 300_000) });

/** a fold with this session's own row plus, optionally, one live peer — the two states the edge notice sits between */
function foldWith(peer: boolean, selfRunId: string): Fold {
  const f = emptyFold(NOW);
  const mine = { ...makeHeartbeat({ runId: selfRunId, sessionId: selfRunId }), arrivalMono: NOW.monoMs - 1_000 };
  f.live.set(selfRunId, mine);
  f.origins.set(`${DEV_A}/${selfRunId}`, SELF);
  f.liveness.set(`${DEV_A}/${selfRunId}/${mine.pid}`, 'live');
  f.devices.set(DEV_A, { ...makeDevice(), lastSeen: iso(T0), syncLagMs: null, ignored: false, cloned: false });
  if (peer) {
    const p = { ...PEER, arrivalMono: NOW.monoMs - 1_000 };
    f.live.set(PEER.runId, p);
    f.origins.set(`${DEV_B}/${PEER.runId}`, TRUSTED);
    f.liveness.set(`${DEV_B}/${PEER.runId}/${PEER.pid}`, 'live');
    f.devices.set(DEV_B, { ...makeDevice({ deviceId: DEV_B, label: 'air' }), lastSeen: iso(T0), syncLagMs: null, ignored: false, cloned: false });
  }
  return f;
}

interface FakeLedger {
  opens: number;
  closes: number;
  subscribes: number;
  unsubscribes: number;
  beats: number;
  mints: number;
  /** every `openSessionLedger(input)` this harness saw — ONE handle means exactly one entry */
  inputs: SessionLedgerInput[];
  ledger: SessionLedger;
  /** move the fold and fire the watcher, the way `fs.watch` would */
  change(next: Fold): void;
}

function fakeLedger(initial: Fold, selfRunId: string): FakeLedger {
  const listeners: (() => void)[] = [];
  let fold = initial;
  const self: SelfIdentity = makeSelf({ hostKey: 'deadbeefcafe1234deadbeefcafe1234', runId: selfRunId, sessionId: selfRunId });
  const state: FakeLedger = {
    opens: 0,
    closes: 0,
    subscribes: 0,
    unsubscribes: 0,
    beats: 0,
    mints: 0,
    inputs: [],
    change(next: Fold) {
      fold = next;
      for (const l of [...listeners]) l();
    },
    ledger: {
      get fold(): Fold {
        return fold;
      },
      self,
      repoKeys: { repoKey: null, remoteKey: null },
      open: async (): Promise<void> => {
        state.opens += 1;
      },
      close: async (): Promise<void> => {
        state.closes += 1;
      },
      claimRefusal: () => null,
      mintClaim: async (): Promise<void> => {
        state.mints += 1;
      },
      startHeartbeat: () => {
        state.beats += 1;
        return { stop: (): void => undefined };
      },
      declare: (_i: LeaseIntent) => Promise.resolve({ release: (): void => undefined }),
      list: (opts = {}) => {
        // the one projection the read half uses; `all` widens it exactly as `listSessions` does
        const rows = [...fold.live.values()].filter((hb) => hb.runId !== selfRunId || opts.all === true);
        return rows.map((hb) => ({
          runId: hb.runId,
          sessionId: hb.sessionId,
          parentSessionId: null,
          deviceId: hb.deviceId,
          label: hb.label,
          sameDevice: hb.deviceId === DEV_A,
          kind: 'run' as const,
          liveness: 'live' as const,
          flags: { hung: false, skewed: false, forked: false, takenOver: false, noLock: false, ignoredDevice: false, unverified: false, cloned: false },
          authority: 'trusted' as const,
          skewMs: null,
          beatAgeMs: 2_000,
          arrivalAgeMs: 2_000,
          syncLagMs: null,
          sameRepo: true,
          sameBranch: true,
          heartbeat: hb,
          leases: [],
        }));
      },
      mintedClaim: () => PEER.claim,
      subscribe: (cb: () => void) => {
        state.subscribes += 1;
        listeners.push(cb);
        return (): void => {
          state.unsubscribes += 1;
          const i = listeners.indexOf(cb);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
    },
  };
  return state;
}

/** the last `[jevcode]` bubble — the chat reply, which is where a selected fact's text lands */
function replyText(h: Harness): string | undefined {
  return h.renderer.notes.filter((n) => n.label === '[jevcode]').at(-1)?.text;
}

function noteTexts(h: Harness): string[] {
  return h.renderer.notes.map((n) => `${n.text}\n${n.detail ?? ''}`);
}
/**
 * The head and the rendered body of the last block with this head, **with the wrap undone**: `renderBlock` folds a
 * sentence to `bodyWidth()`, so a `toContain` of a §12 string longer than the terminal is a test of the wrapper,
 * not of the string. The rows' own width is gate G-R5-6's job (`r5-identity.test.ts`), not this file's.
 */
function lastBlock(h: Harness, head: string): string | undefined {
  const n = [...h.renderer.notes].reverse().find((x) => x.text.startsWith(head));
  return n === undefined ? undefined : `${n.text} ${n.detail ?? ''}`.replace(/\s+/g, ' ');
}

// ── 1. coordination ON, ledger not open yet: the landed sentences, byte for byte ─────────────────────────────────

describe('§1.4 promise 1: before the ledger opens, the landed sentences are unchanged (N6)', () => {
  /**
   * Fix pass, finding 8: the COMMON case — coordination on, home writable, the ledger simply not open yet —
   * must not say the feature is missing from the build. The landed version used
   * `the peer registry is not available in this build` as the base of BOTH `/peers` branches, so `/peers` called
   * the build broken two lines below a `/who` that answered the honest "not open yet"; the previous version of
   * THIS test pinned that lie.
   */
  it('`/who` and `/peers` on an idle session answer the SAME honest unknown, and neither blames the build', async () => {
    const h = await build();
    void h.controller.run();
    await h.ready();
    await h.command('/who');
    await h.command('/peers');
    const who = lastBlock(h, 'who');
    const peers = lastBlock(h, 'peers');
    expect(who).toContain(COORDINATION_NOT_OPEN);
    expect(who).not.toContain('coordination is off');
    // the two surfaces say the same thing about the same state, and it is the true thing
    expect(peers).toContain(COORDINATION_NOT_OPEN);
    expect(peers).toContain('/who lists every jevcode on this workspace once it is');
    expect(peers).not.toContain(PEERS_UNAVAILABLE_TEXT);
    expect(peers).not.toContain('cannot be written');
    // …and the head carries the dot like every other §12.1 head (finding 5)
    expect(peers).toMatch(/^peers [·-]/);
  });

  /** the chat fact is the third sink of the same state, and `null` — not `undefined` — is what it must get. */
  it('the chat `peers` fact on an idle session is the "not open yet" sentence, never the build one', async () => {
    const h = await build({ decider: harnessDecider({ facts: ['peers'] }), flags: { mode: 'jev-only' } });
    void h.controller.run();
    await h.ready();
    await h.host.submit('what can you do?', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    const reply = replyText(h);
    expect(reply).toBe(peersFactText(null));
    // the fact capitalises the sentence and ends it; the words are `peersNotOpenText`'s, so the two cannot drift
    expect(reply).toContain(peersNotOpenText().slice(1));
    expect(reply).not.toContain(PEERS_UNAVAILABLE_TEXT);
  });
});

// ── 2. coordination OFF by configuration ─────────────────────────────────────────────────────────────────────────

describe('§12.1 / gap 1: coordination off in the configuration names the setting', () => {
  it('`/who` and `/peers` append the clause, keep the landed sentence as the prefix, and no ledger is ever opened', async () => {
    let opened = 0;
    const h = await build({
      env: { JEVCODE_COORDINATION_CLAIMS: 'off' },
      deps: {
        openSessionLedger: (): Promise<SessionLedger> => {
          opened += 1;
          throw new Error('the ledger must not be opened when coordination is off');
        },
      },
    });
    void h.controller.run();
    await h.ready();
    await h.submit('fix the failing test');
    await h.command('/who');
    await h.command('/peers');
    expect(opened).toBe(0);
    const who = lastBlock(h, 'who');
    expect(who).toContain(COORDINATION_NOT_OPEN);
    expect(who).toContain(COORDINATION_OFF_CLAUSE.disabled);
    const peers = lastBlock(h, 'peers');
    expect(peers).toContain(PEERS_UNAVAILABLE_TEXT);
    expect(peers).toContain('coordination.claims = off');
    // §1.4 promise 2: the run itself is untouched, and nothing is said about it twice
    expect(noteTexts(h).filter((t) => t.includes('the session ledger could not open'))).toEqual([]);
  });

  /**
   * Fix pass, finding 7: the chat `peers` fact is the THIRD sink the brief names, and it said nothing about the
   * reason at all — `session.ts` omitted the key and `peersFactText(undefined)` printed the bare, now-false
   * `the peer registry is not available in this build.`
   */
  it('the chat `peers` fact names the setting too, so all three sinks agree', async () => {
    const h = await build({ env: { JEVCODE_COORDINATION_CLAIMS: 'off' }, decider: harnessDecider({ facts: ['peers'] }), flags: { mode: 'jev-only' } });
    void h.controller.run();
    await h.ready();
    await h.host.submit('what can you do?', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    const reply = replyText(h);
    expect(reply).toContain(PEERS_UNAVAILABLE_TEXT);
    expect(reply).toContain(COORDINATION_OFF_CLAUSE.disabled);
    expect(reply).toContain('coordination.claims = off');
    // §2.4's privacy contract still holds for the clause: a setting name, never a path
    expect(reply).not.toMatch(/(?:^|\s|")\/(?:home|Users|tmp|var|private)\//);
  });
});

// ── 2b. coordination ON, but the home cannot hold a ledger ───────────────────────────────────────────────

/**
 * Fix pass, the review's "the in-session `unwritable` reason" gap: only `disabled` was covered, and it is the
 * SYNCHRONOUS half of the pre-flight. `unwritable` is the asynchronous half — it is decided by
 * `checkHomeWritable()` after `renderer.firstFrame()` resolves — so it exercises a different code path in
 * `coordinationReason()` and had no test at all.
 */
describe('§12.1 / gap 1: a home that cannot hold a ledger says so, in all three sinks', () => {
  /** a `JEVCODE_HOME` under a regular FILE: `access` answers ENOTDIR, which is not ENOENT, so the probe is false */
  function blockedHome(): string {
    const base = mkdtempSync(join(tmpdir(), 'jevcode-blocked-'));
    const file = join(base, 'not-a-directory');
    writeFileSync(file, 'x');
    return join(file, 'jevcode');
  }

  /**
   * §1.4 promise 1: the disk half of the pre-flight is fire-and-forget — it awaits `renderer.firstFrame()` and
   * never gates the open — so the FIRST `/who` after startup may still answer the bare "not open yet". Typing it
   * again is what a user does; this is that, bounded.
   */
  async function whoUntilClause(h: Harness): Promise<string> {
    let last = '';
    for (let i = 0; i < 80; i++) {
      await h.command('/who');
      last = lastBlock(h, 'who') ?? '';
      if (last.includes(COORDINATION_OFF_CLAUSE.unwritable)) return last;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`the unwritable clause never reached /who; last block was: ${last}`);
  }

  it('`/who`, `/peers` and the chat fact all carry the second clause, and the session keeps running', async () => {
    const home = blockedHome();
    const h = await build({ env: { JEVCODE_HOME: home }, decider: harnessDecider({ facts: ['peers'] }), flags: { mode: 'jev-only' } });
    void h.controller.run();
    await h.ready();
    // the probe is fired by the first read and memoised; a later read sees the settled answer
    const who = await whoUntilClause(h);
    await h.command('/peers');
    const peers = lastBlock(h, 'peers');
    expect(who).toContain(COORDINATION_NOT_OPEN);
    expect(who).toContain(COORDINATION_OFF_CLAUSE.unwritable);
    expect(peers).toContain(PEERS_UNAVAILABLE_TEXT);
    expect(peers).toContain(COORDINATION_OFF_CLAUSE.unwritable);

    await h.host.submit('what can you do?', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    const reply = replyText(h);
    expect(reply).toContain(COORDINATION_OFF_CLAUSE.unwritable);

    // §7 row 61: the clause names the VARIABLE, never the directory it points at
    for (const text of [who ?? '', peers ?? '', reply ?? '']) {
      expect(text).not.toContain(home);
      expect(text).not.toMatch(/(?:^|\s|")\/(?:home|Users|tmp|var|private)\//);
    }
    // §1.4 promise 2: nothing died
    expect(h.exits).toEqual([]);
  });

  it('the probe does not CREATE the home it refused (fix pass, finding 16)', async () => {
    const { existsSync } = await import('node:fs');
    const home = blockedHome();
    const h = await build({ env: { JEVCODE_HOME: home } });
    void h.controller.run();
    await h.ready();
    await whoUntilClause(h);
    expect(existsSync(home)).toBe(false);
  });
});

// ── 3. ONE handle, the mount read, the subscription ─────────────────────────────────────────────────────────────

describe('§2.1 rule 3 / §15.2: one handle for the read half and the write half', () => {
  async function withLedger(peerAtStart: boolean): Promise<{ h: Harness; fake: FakeLedger }> {
    let fake: FakeLedger | null = null;
    const h = await build({
      deps: {
        openSessionLedger: (input: SessionLedgerInput): Promise<SessionLedger> => {
          const f = fake ?? fakeLedger(foldWith(peerAtStart, input.runId), input.runId);
          fake = f;
          f.inputs.push(input);
          return Promise.resolve(f.ledger);
        },
      },
    });
    void h.controller.run();
    await h.ready();
    await h.submit('fix the failing test');
    await waitFor(() => fake !== null && fake.opens > 0, 4000, 'the ledger opened');
    if (fake === null) throw new Error('unreachable');
    return { h, fake };
  }

  it('the writer and `/who` read the SAME handle: one `openSessionLedger`, one `open()`, one `subscribe()`', async () => {
    const { h, fake } = await withLedger(true);
    expect(fake.inputs).toHaveLength(1);
    expect(fake.opens).toBe(1);
    expect(fake.beats).toBe(1);
    expect(fake.mints).toBe(1);
    // §15.2 clause 3: the fold subscription belongs to that one handle
    expect(fake.subscribes).toBe(1);
    // the READ half answers off the same object — the peer row is the one the fake seeded
    await h.command('/who');
    expect(lastBlock(h, 'who')).toContain('air');
    expect(h.host.who?.()?.map((r) => r.label)).toEqual(['air']);
    expect(h.host.peers?.()).toMatchObject({ live: 2 });
  });

  it('§2.4: the peer line fires on the 0 → ≥1 EDGE, from the subscription, and never once per beat', async () => {
    const { h, fake } = await withLedger(false);
    const peerLines = (): string[] => h.renderer.notes.filter((n) => n.text.includes('another jevcode is working in this workspace')).map((n) => n.text);
    expect(peerLines()).toEqual([]);
    const selfRun = fake.inputs[0]!.runId;
    // a peer arrives: one line
    fake.change(foldWith(true, selfRun));
    await waitFor(() => peerLines().length === 1, 2000, 'the peer line');
    // …and every later beat of the same peer is silent (gate G-R5-3: no frame per beat)
    for (let i = 0; i < 5; i++) fake.change(foldWith(true, selfRun));
    expect(peerLines()).toHaveLength(1);
    // the peer leaves and comes back: the edge re-arms, so the second arrival is announced once
    fake.change(foldWith(false, selfRun));
    fake.change(foldWith(true, selfRun));
    await waitFor(() => peerLines().length === 2, 2000, 'the re-armed peer line');
    expect(peerLines()).toHaveLength(2);
  });

  it('the subscription and the handle are dropped together at exit', async () => {
    const { h, fake } = await withLedger(true);
    await h.command('/exit');
    await waitFor(() => fake.closes > 0, 4000, 'the ledger closed');
    expect(fake.unsubscribes).toBe(1);
  });
});
