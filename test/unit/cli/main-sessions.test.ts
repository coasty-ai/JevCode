/**
 * TUI-DESIGN-5 §2.10, **gap 1 — `src/cli/main.tsx`'s call site** (fix pass, the missing test the review named).
 *
 * `test/unit/cli/sessions.test.ts`'s import-graph guard is source text, and `SESSIONS_VERBS.slice(0, 4)` in
 * `test/unit/session/coordination.test.ts` is vacuous with respect to the gate in `main.tsx`: neither of them can
 * see whether `commandSessions` was actually handed a `coordination` member. This file drives `main()` itself
 * with the two modules behind it mocked, and asserts the two halves of the contract:
 *
 *  1. every one of the **thirteen** coordination verbs reaches `commandSessions` with a real `coordination`
 *     member (or, when the pre-flight refuses, with `coordinationOff` **and** its machine-readable reason);
 *  2. `list | reindex | prune | unlock` reach it with **neither** — they read `sessions/index.jsonl` and opening
 *     a ledger for them would write this device's record for a verb that only reads an index.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SessionsCoordination, SessionsIo, SessionsVerb } from '../../../src/cli/sessions.js';
import { SESSIONS_VERBS } from '../../../src/cli/sessions.js';

const seen = vi.hoisted(() => ({
  ios: [] as SessionsIo[],
  opens: [] as { home: string; workspace: string }[],
  /** what `openCoordination` answers; the pre-flight's two refusals are values, never throws */
  answer: 'open' as 'open' | 'off',
}));

const FAKE_COORD = { close: async (): Promise<void> => undefined } as unknown as SessionsCoordination;

vi.mock('../../../src/cli/sessions.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/cli/sessions.js')>();
  return {
    ...real,
    commandSessions: async (_flags: unknown, io: SessionsIo): Promise<number> => {
      seen.ios.push(io);
      return 0;
    },
    openCoordination: async (input: { home: string; workspace: string }) => {
      seen.opens.push({ home: input.home, workspace: input.workspace });
      return seen.answer === 'open'
        ? { kind: 'open' as const, coordination: FAKE_COORD }
        : { kind: 'off' as const, reason: 'unwritable' as const, message: 'the session ledger is not available in this build — the JevCode home (JEVCODE_HOME) cannot be written — no ledger can be opened there' };
    },
  };
});

vi.mock('../../../src/config/resolve.js', () => ({
  resolveConfig: async () => ({
    workspace: '/w/repo',
    runsDir: '/w/.jevcode/runs',
    redact: (s: string) => s,
    record: () => ({}),
    sandbox: 'workspace-write',
    entries: new Map<string, { value: string }>([['coordination.claims', { value: 'advisory' }]]),
  }),
}));

const { main } = await import('../../../src/cli/main.js');

const INDEX_VERBS: readonly SessionsVerb[] = ['list', 'reindex', 'prune', 'unlock'];
const COORD_VERBS = SESSIONS_VERBS.filter((v) => !INDEX_VERBS.includes(v));

/** the words each verb needs after it so `args.ts` parses rather than refuses */
const TAIL: Partial<Record<SessionsVerb, string[]>> = {
  pause: ['20260921-110002-aaaaaaac'],
  resume: ['20260921-110002-aaaaaaac'],
  end: ['20260921-110002-aaaaaaac'],
  tell: ['20260921-110002-aaaaaaac', 'hello'],
  request: ['20260921-110002-aaaaaaac', 'engine.ts'],
  headsup: ['editing the store'],
  label: ['studio'],
  unpair: ['air'],
  sync: ['status'],
  unlock: ['20260921-110002-aaaaaaac'],
};

beforeEach(() => {
  seen.ios = [];
  seen.opens = [];
  seen.answer = 'open';
});

describe('gap 1: `main()` hands `commandSessions` a real coordination for the thirteen verbs', () => {
  it('every coordination verb arrives with a `coordination` member and no refusal string', async () => {
    expect(COORD_VERBS).toHaveLength(13);
    for (const verb of COORD_VERBS) {
      seen.ios = [];
      seen.opens = [];
      const code = await main(['sessions', verb, ...(TAIL[verb] ?? [])]);
      expect(code, verb).toBe(0);
      expect(seen.opens, verb).toHaveLength(1);
      const io = seen.ios[0];
      expect(io, verb).toBeDefined();
      expect(io?.coordination, verb).toBe(FAKE_COORD);
      expect(io?.coordinationOff, verb).toBeUndefined();
      expect(io?.coordinationOffReason, verb).toBeUndefined();
    }
  });

  it('the pre-flight’s refusal arrives as BOTH the sentence and the machine-readable reason', async () => {
    seen.answer = 'off';
    const code = await main(['sessions', 'who']);
    expect(code).toBe(0);
    const io = seen.ios[0];
    expect(io?.coordination).toBeUndefined();
    expect(io?.coordinationOff).toContain('cannot be written');
    expect(io?.coordinationOffReason).toBe('unwritable');
  });

  it('`list | reindex | prune | unlock` open NO ledger and arrive with neither member', async () => {
    for (const verb of INDEX_VERBS) {
      seen.ios = [];
      seen.opens = [];
      const code = await main(['sessions', verb, ...(TAIL[verb] ?? [])]);
      expect(code, verb).toBe(0);
      expect(seen.opens, verb).toEqual([]);
      const io = seen.ios[0];
      expect(io?.coordination, verb).toBeUndefined();
      expect(io?.coordinationOff, verb).toBeUndefined();
    }
  });

  it('the words after the verb reach `SessionsIo.args`, so a target is never lost at the seam', async () => {
    await main(['sessions', 'tell', '20260921-110002-aaaaaaac', 'commit', 'and', 'move', 'on']);
    expect(seen.ios[0]?.args).toEqual(['20260921-110002-aaaaaaac', 'commit', 'and', 'move', 'on']);
  });
});
