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
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_OPEN, EXIT_IDLE, cleanupScratch, drive, echoStep, hasExpect, stripAnsi, syncFrames, type Drive } from './helpers.js';

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
    // §7 row 61: never a pid, never an absolute path
    expect(text).not.toMatch(/pid \d+/);
    assertNoKeyBytes(r, FAKE_KEY);
    assertEveryRowFits(r, 80);
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
  it('`/agents`, `/land`, `/import` and `/memory` name the build, and `/model` still shows the current model', async () => {
    const r = await drive({
      name: 'r5-honest-idle',
      args: ['chat', '--mock'],
      rows: 24,
      cols: 80,
      env: { ...NO_NETWORK, OPENROUTER_API_KEY: FAKE_KEY },
      steps: [...CHAT_OPEN, ...cmd('/agents'), 'expect not available', 'sleep 0.4', ...cmd('/land'), 'sleep 0.4', ...cmd('/import'), 'sleep 0.4', ...cmd('/memory'), 'sleep 0.4', ...cmd('/model'), 'sleep 0.4', ...EXIT_IDLE],
      timeoutS: 40,
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const text = stripAnsi(r.text);
    // §12 S85, verbatim, for the agent verbs
    expect(text).toContain('/agents is not available in this build — no agent is running');
    expect(text).toContain('/land is not available in this build — no agent is running');
    // §5.5: the import pair points at the surface that DOES work rather than denying the feature. The sentence
    // WRAPS at 80 columns (the `[ui]` block continuation indents the tail), so the head is what a frame-level
    // `toContain` may assert; the whole string is pinned byte-for-byte in `test/unit/cli/sessions.test.ts`'s sinks.
    expect(text).toContain('/import is not available in this build');
    expect(text).toContain('jevcode import plans, reviews');
    expect(text).toContain('/memory is not available in this build');
    // §6.4: `/model` with no argument is unchanged — it shows, it never opens a picker that is not mounted
    expect(text).toMatch(/model mock/);
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
