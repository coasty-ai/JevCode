/**
 * TUI-DESIGN-5 §10 / §11 — the round-5 pty scenarios, every run `--mock` and offline
 * (`JEVCODE_ASSERT_NO_NETWORK=1`) inside a real pty driven by `scripts/pty/drive.exp`.
 *
 * What this file is FOR, stated plainly: gate **G-R5-9** says `assertNoKeyBytes` is called from **every** new
 * pty scenario, and gate **G-R5-6** says no row of any new surface exceeds the terminal width. `run-smoke.sh`
 * carries the five `.steps` scenarios of §10 and scans their captures too, but the smoke board is a shell script
 * whose r5 rows run by name; this file is the part that runs on every `vitest --project pty` and therefore the
 * part that cannot be forgotten.
 *
 * Every case drives an **idle** session. That is deliberate: `docs/research/tui/20-pty-driver-findings.md` §5
 * records that a non-draining `sleep` in a step file starves the child's event loop while a run floods the pty,
 * so a command typed during a `--mock` run can sit in stdin and the draft accumulates. The `.steps` scenarios
 * exercise the run path (and show that hazard); these exercise the commands.
 *
 * What round 5's surfaces answer on an idle session is the **honest empty state**, not a stub: nothing
 * constructs a `SessionsCoordination` in this build and there is no `AgentSupervisor`, so `/who` answers
 * `who · unknown`, `/agents` answers `<verb> is not available in this build` and so on. Asserting those exact
 * sentences is the D-AN contract under test — a surface that silently did nothing would pass a "no crash" test
 * and fail this one.
 */
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_OPEN, EXIT_IDLE, MOCK_RUN_MODE, binPath, childEnv, cleanupScratch, drive, echoStep, hasExpect, runFinishedStep, stripAnsi, submitTask, syncFrames, type Drive } from './helpers.js';

/**
 * Fix pass, finding 15: the spawned peer is killed from an `afterEach`, not from a `finally` around the
 * assertions. `peers` is populated inside `during`, and the old `try { … } finally { kill }` started only after
 * `await drive(…)` RESOLVED — so a hard timeout or a harness error left a `jevcode run … --mock-steps 40`
 * child alive, writing into a scratch home `cleanupScratch` was about to delete. This hook runs before
 * `cleanupScratch` (vitest runs `afterEach`es in registration order) and is unconditional.
 */
const spawnedPeers: ReturnType<typeof spawn>[] = [];
afterEach(() => {
  for (const p of spawnedPeers.splice(0)) {
    try {
      p.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
});
afterEach(cleanupScratch);

const FAKE_KEY = `sk-fake-${'x'.repeat(40)}`;
const NO_NETWORK = { JEVCODE_ASSERT_NO_NETWORK: '1' } as const;

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (statSync(p).isFile()) out.push(p);
  }
  return out;
}

/**
 * Gate G-R5-9, extended past round 3's form: the typed bytes are in no frame and no file, **and** the
 * coordination tree this session wrote carries neither the key nor a long `hostKey` (§2.14 consequence 3 — the
 * heartbeat writer is the only thing in round 5 that can put device key material near a file).
 */
function assertNoKeyBytes(r: Drive, ...secrets: string[]): void {
  const files = [...filesUnder(r.home), ...filesUnder(r.workspace)];
  for (const s of secrets) {
    expect(r.text, `key bytes in a frame: ${s.slice(0, 12)}…`).not.toContain(s);
    expect(files.filter((p) => readFileSync(p, 'latin1').includes(s))).toEqual([]);
  }
  const coord = join(r.home, 'coordination');
  for (const p of filesUnder(coord)) {
    const body = readFileSync(p, 'latin1');
    expect(body, `${p} carries a long hostKey`).not.toMatch(/"hostKey"[^,}]*[0-9a-f]{32}/);
  }
}

/** every rendered row of every frame fits the terminal (gate G-R5-6, the pty half) */
function assertEveryRowFits(r: Drive, cols: number): void {
  let widest = 0;
  for (const f of syncFrames(r.text)) for (const row of f.dynamic) widest = Math.max(widest, [...stripAnsi(row)].length);
  expect(widest, `widest rendered row at ${cols} columns`).toBeLessThanOrEqual(cols);
}

/**
 * TUI-DESIGN-5 §2.14: a real second session — `jevcode run … --plain --mock`, headless so `firstFrame()`
 * resolves at once, under the SAME `JEVCODE_HOME` and the SAME workspace (the `wsKey` both sessions publish is
 * derived from that realpath, and with no git repository under `/tmp` the `repoKey` degrades to it).
 */
function spawnPeer(workspace: string, home: string, steps: number, secret: string): void {
  spawnedPeers.push(
    spawn(process.execPath, [binPath(), 'run', 'keep the peer session alive', '--plain', '--mock', '--mock-steps', String(steps), ...MOCK_RUN_MODE, '--workspace', workspace], {
      cwd: workspace,
      env: childEnv(home, 24, 120, { ...NO_NETWORK, OPENROUTER_API_KEY: secret, JEVCODE_MOCK_JEV_MS: '400' }),
      stdio: 'ignore',
    }),
  );
}

/** type a slash command on an idle composer and wait for its echo, then submit */
const cmd = (line: string): readonly string[] => ['sleep 0.3', `send ${line}`, echoStep(line), 'sleep 0.2', 'send \\r'];

describe.skipIf(!hasExpect)('pty round 5: the coordination reads answer honestly (TUI-DESIGN-5 §2.3, §2.4)', () => {
  it('`/who`, `/who --all` and `/peers` on an idle session: the empty state, never a false zero, never a spinner', async () => {
    const r = await drive({
      name: 'r5-who-idle',
      args: ['chat', '--mock'],
      rows: 24,
      cols: 80,
      env: { ...NO_NETWORK, OPENROUTER_API_KEY: FAKE_KEY },
      /**
       * Gap 1(b), the DISCLOSED RESIDUAL, measured rather than asserted in prose. A second session is really
       * running under this home for the whole scenario, and the idle TUI still answers the honest unknown —
       * because `startPublishing` (and with it the ONE handle) is reached from `runEngineInner`, not from
       * `renderer.firstFrame()`. Promoting the open is blocked on the frozen contract, not on this file:
       * `SessionActivity.kind` is `'run' | 'bench'` (`src/coordination/types.ts:467`) and a heartbeat needs a
       * `runId` and a claim, so a session that has run nothing has no row shape to publish and no reason to
       * open a ledger it could not appear in. This case is what keeps that residual honest and visible.
       */
      during: async ({ workspace, home }) => {
        spawnPeer(workspace, home, 40, FAKE_KEY);
        return await new Promise<string>((res) => setTimeout(() => res('spawned'), 1_500));
      },
      steps: [...CHAT_OPEN, ...cmd('/who'), 'expect who', ...cmd('/who --all'), 'sleep 0.6', ...cmd('/peers'), 'expect peers', 'sleep 0.4', ...EXIT_IDLE],
      timeoutS: 40,
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const text = stripAnsi(r.text);
    // §1.4 promise 1: before the ledger opens the answer is the honest unknown, with the reason on its own row
    expect(text).toContain('who · unknown');
    expect(text).toContain('the session ledger is not open yet');
    expect(text).toContain('peers · unknown');
    /**
     * Fix pass, finding 8: `/peers` no longer blames the BUILD for a state that is only "not open yet". The two
     * surfaces answer the same sentence, and neither of them says the feature is missing from this binary.
     */
    expect(text).not.toContain('the peer registry is not available in this build');
    /**
     * The rest of the sentence WRAPS at 80 columns (the `[ui]` block continuation indents the tail), so a
     * frame-level `toContain` of the whole string is a test of the wrapper — the same reason this file asserts
     * only the head of `/memory`'s refusal. The whole string is pinned byte-for-byte in
     * `test/unit/cli/session-coordination.test.ts` against `peersNotOpenText()`.
     */
    expect(text).toContain('/who lists every');
    // a peer really was beating into this home while the reads above ran — the residual is measured, not assumed
    expect(existsSync(join(r.home, 'coordination'))).toBe(true);
    // §7 row 61: never a pid, never an absolute path
    expect(text).not.toMatch(/pid \d+/);
    assertNoKeyBytes(r, FAKE_KEY);
    assertEveryRowFits(r, 80);
  });

  /**
   * TUI-DESIGN-5 §2.3 / §2.14 / §10, **gap 1**: two `jevcode --mock` sessions under ONE `JEVCODE_HOME` and one
   * workspace see each other in `/who`.
   *
   * This is the case nothing could exercise before `openCoordination()` landed and the read half was pinned to the
   * writer's handle: the write half already beat (the `r5-who.steps` beat-file scan proved that), but no reader
   * was ever driven against another session's beat, so §2's whole premise — "every session knows what the others
   * are doing" — had never once been observed end to end.
   *
   * The peer is a real second process, spawned from `during` so it shares the scenario's own temp workspace (the
   * `wsKey` both sessions publish is derived from that realpath, and with no git repository under `/tmp` the
   * `repoKey` degrades to it). It runs headless (`run … --plain`), which resolves `firstFrame()` at once, so its
   * ledger opens, its claim mints and its heartbeat writer starts exactly as the TUI's does.
   */
  it('two --mock sessions under one JEVCODE_HOME: `/who` shows the peer’s row, and no key byte reaches a frame or the ledger', async () => {
    const r = await drive({
      name: 'r5-who-peer',
      args: ['chat', '--mock', '--mock-steps', '2'],
      rows: 24,
      cols: 120,
      env: { ...NO_NETWORK, OPENROUTER_API_KEY: FAKE_KEY },
      during: async ({ workspace, home }) => {
        spawnPeer(workspace, home, 40, FAKE_KEY);
        return await new Promise<string>((res) => setTimeout(() => res('spawned'), 1_500));
      },
      steps: [
        ...CHAT_OPEN,
        'sleep 1.5',
        ...submitTask('fix the failing test'),
        // the mock trajectory ends `generator_done`, not `complete` — the anchor takes whatever reason it carries
        runFinishedStep('[a-z_]+'),
        'sleep 1.2',
        ...cmd('/who --all'),
        'expect who',
        'sleep 1.0',
        ...EXIT_IDLE,
      ],
      timeoutS: 60,
    });
    {
      const text = stripAnsi(r.text);
      expect(r.timeouts).toBe(0);
      expect(r.code).toBe(0);
      // the ledger IS open now, so the honest-unknown answer of the case above must NOT appear
      expect(text).not.toContain('who · unknown');
      // §12.1 S7: the header counts what the fold holds — this session and the peer
      expect(text).toMatch(/who [·-] [2-9]\d* live/);
      // §7 row 61 / gate G-R5-9: the row names the session, never a pid and never an absolute path
      expect(text).not.toMatch(/pid \d+/);
      expect(text).not.toMatch(/\/(?:private\/)?(?:tmp|var)\/jevcode-pty/);
      assertNoKeyBytes(r, FAKE_KEY);
      assertEveryRowFits(r, 120);
      // §2.14 consequence 3: the peer's own subtree is in the same home and is scanned by `assertNoKeyBytes`
      expect(existsSync(join(r.home, 'coordination'))).toBe(true);
    }
  });

  /**
   * Fix pass, the review's "a `--ascii` twin and a 40-column rung" gap: the two-session case above is the only
   * capture of REAL peer rows, and it measured exactly one geometry (24×120, unicode). The row ladder of §2.3
   * drops right to left as the width falls and the glyph set is chosen at launch, so the narrow rung and the
   * ascii twin are different code paths, not variants of one. Both are exercised in ONE spawn.
   */
  it('the same two sessions at 24×40 with `--ascii`: three cells per row, ascii glyphs, every row still fits', async () => {
    const r = await drive({
      name: 'r5-who-peer-ascii40',
      args: ['chat', '--mock', '--mock-steps', '2', '--ascii'],
      rows: 24,
      cols: 40,
      env: { ...NO_NETWORK, OPENROUTER_API_KEY: FAKE_KEY },
      during: async ({ workspace, home }) => {
        spawnPeer(workspace, home, 40, FAKE_KEY);
        return await new Promise<string>((res) => setTimeout(() => res('spawned'), 1_500));
      },
      steps: [...CHAT_OPEN, 'sleep 1.5', ...submitTask('fix the failing test'), runFinishedStep('[a-z_]+'), 'sleep 1.2', ...cmd('/who --all'), 'expect who', 'sleep 1.0', ...EXIT_IDLE],
      timeoutS: 60,
    });
    const text = stripAnsi(r.text);
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    // §12.1 S1–S3, S10: the ascii set is `*`, `.`, `o`, `-`; the head's separator is `-`, never `·`
    expect(text).toMatch(/who - [2-9]\d* live/);
    expect(text).not.toContain('who ·');
    expect(text).not.toContain('who · unknown');
    // gate G-R5-6: the narrow rung clips rather than overflowing, at the geometry it was rendered for
    assertEveryRowFits(r, 40);
    expect(text).not.toMatch(/pid \d+/);
    expect(text).not.toMatch(/\/(?:private\/)?(?:tmp|var)\/jevcode-pty/);
    assertNoKeyBytes(r, FAKE_KEY);
  });
});

describe.skipIf(!hasExpect)('pty round 5: the context pair (TUI-DESIGN-5 §3.2, §3.3)', () => {
  it('`/context` with no run is S54 and `/compact` is the generated live-only refusal — two different sentences', async () => {
    const r = await drive({
      name: 'r5-context-idle',
      args: ['chat', '--mock'],
      rows: 40,
      cols: 120,
      env: { ...NO_NETWORK, JEVCODE_CONTEXT_COMPACTION: 'code', OPENROUTER_API_KEY: FAKE_KEY },
      steps: [...CHAT_OPEN, ...cmd('/context'), 'expect context', 'sleep 0.5', ...cmd('/compact'), 'sleep 0.5', ...EXIT_IDLE],
      timeoutS: 40,
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const text = stripAnsi(r.text);
    // §12 S54 — the sentence names what the command WOULD report, so the refusal is also its documentation
    expect(text).toContain("no run is live — /context reports the run's prompt budget");
    // §3.3: the refusal is `availabilityError`'s own, nothing hand-written
    expect(text).toContain('/compact needs a live run');
    assertNoKeyBytes(r, FAKE_KEY);
    assertEveryRowFits(r, 120);
  });
});

describe.skipIf(!hasExpect)('pty round 5: D-AN — every registered surface answers out loud (§4.9, §5.5)', () => {
  it('`/agents` and `/land` name the build, `/memory` points at the twin that works, and `/model` now OPENS the picker (§6.4)', async () => {
    const r = await drive({
      name: 'r5-honest-idle',
      args: ['chat', '--mock'],
      rows: 24,
      cols: 80,
      env: { ...NO_NETWORK, OPENROUTER_API_KEY: FAKE_KEY },
      steps: [...CHAT_OPEN, ...cmd('/agents'), 'expect not available', 'sleep 0.4', ...cmd('/land'), 'sleep 0.4', ...cmd('/memory'), 'sleep 0.4', ...cmd('/model'), 'sleep 0.8', 'send \\x1b', 'sleep 0.4', ...EXIT_IDLE],
      timeoutS: 40,
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const text = stripAnsi(r.text);
    // §12 S85, verbatim, for the agent verbs
    expect(text).toContain('/agents is not available in this build — no agent is running');
    expect(text).toContain('/land is not available in this build — no agent is running');
    // §5.5: `/memory` still points at the surface that DOES work rather than denying the feature. The sentence
    // WRAPS at 80 columns (the `[ui]` block continuation indents the tail), so the head is what a frame-level
    // `toContain` may assert; the whole string is pinned byte-for-byte in `test/unit/cli/sessions.test.ts`'s sinks.
    expect(text).toContain('/memory is not available in this build');
    /**
     * §6.4 / D-AQ — CHANGED by R5-4's shared-shell wave (`docs/STATUS.md`'s gap 2): `/model` with no argument no
     * longer prints `model <current>`, it opens the **pane-slot picker** over the bundled snapshot (zero network,
     * which `JEVCODE_ASSERT_NO_NETWORK` above makes a failure rather than a hope), and Esc closes it. The rule row
     * is the assertion; the picker's own behaviour is `test/pty/smoke/r5-model-picker.steps` and
     * `test/unit/tui/round5-shell-app.test.tsx`. `/import` moved to its own scenario
     * (`test/pty/smoke/r5-import-overlay.steps`) for the same reason — it is an overlay now, not one row.
     */
    expect(text).toMatch(/models [·-] \d+/);
    // the refusal never leaks an internal op name (`dropArm` / `dropConfirm`)
    expect(text).not.toMatch(/dropArm|dropConfirm/);
    assertNoKeyBytes(r, FAKE_KEY);
    assertEveryRowFits(r, 80);
  });
});

describe.skipIf(!hasExpect)('pty round 5: §5.8 / §7 row 85 — the resize matrix with a block on screen', () => {
  it('24×80 → 12×60 → 40×120 → 24×80 with `/context` and `/who` blocks: no clear outside a shrink, no ESC[3J, every row fits', async () => {
    const r = await drive({
      name: 'r5-resize',
      args: ['chat', '--mock'],
      rows: 24,
      cols: 80,
      env: { ...NO_NETWORK, OPENROUTER_API_KEY: FAKE_KEY },
      steps: [
        ...CHAT_OPEN,
        ...cmd('/context'),
        'expect context',
        'sleep 0.5',
        'resize 12 60',
        'sleep 0.8',
        ...cmd('/who'),
        'sleep 0.6',
        'resize 40 120',
        'sleep 0.8',
        ...cmd('/context'),
        'sleep 0.6',
        'resize 24 80',
        'sleep 0.8',
        ...EXIT_IDLE,
      ],
      timeoutS: 50,
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    // §1.4: `ESC[3J` erases the terminal's saved lines and is never emitted, at any geometry
    expect(r.text).not.toMatch(/\x1b\[[0-9;]*3J/);
    // every frame fits the WIDEST geometry the session ever had; the per-geometry bound is the unit sweep's
    assertEveryRowFits(r, 120);
    assertNoKeyBytes(r, FAKE_KEY);
  });
});
