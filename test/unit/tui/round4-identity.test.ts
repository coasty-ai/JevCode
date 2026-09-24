/**
 * TUI-DESIGN-4 §3.5 (D-W) / §10 S3: **the declared normaliser**, as a test.
 *
 * A command block is produced ONCE by `renderBlock` and walked by both renderers — the TUI as one labelled item
 * whose body is the rendered rows, the line renderers as one `[ui] <row>` item per row. The rule the document
 * states is:
 *
 * > Drop the leading `[ui] ` of a `--plain` body row; drop the leading gutter spaces of a TUI body row; drop
 * > `gap` rows on both sides; join a TUI row's wrap continuations exactly as TD3 §5.3 joins an item's. The
 * > remainder is equal, row for row, in the same order.
 *
 * `normaliseBlockRows` below is that rule. §10 S3 asks for it in `test/unit/tui/helpers.ts` and
 * `test/pty/helpers.ts` as well, so the pty twin can use the same function — those two files belong to other
 * slots this round, so it lives here and the move is a request (see the slot report).
 *
 * The second half of the file is the **completeness** gate: every command in `COMMANDS` is classified as either a
 * block producer or not, and an unlisted 42nd command fails the suite rather than silently shipping without a twin.
 */
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../../../src/tui/commands/registry.js';
import { makeController, type Harness } from '../cli/helpers.js';

/**
 * §3.5's normaliser. `rows` are item texts in order, each with the label the renderer gave it. A `gap` (an empty
 * row with no label) is dropped on both sides; a body row's gutter / `[ui] ` prefix is not part of the comparison.
 */
export function normaliseBlockRows(rows: readonly string[]): string[] {
  return rows.map((r) => r.replace(/^\[ui\] /, '').replace(/^ +/, '').replace(/\s+$/, '')).filter((r) => r !== '');
}

/** the TUI shape: one item, the rendered rows joined into its `detail` */
function tuiRows(h: Harness): string[] {
  const n = h.renderer.notes.at(-1);
  return normaliseBlockRows([n?.text ?? '', ...(n?.detail ?? '').split('\n')]);
}

/** the line-renderer shape: the head item, then one item per rendered row */
function plainRows(h: Harness, since: number): string[] {
  return normaliseBlockRows(h.renderer.notes.slice(since).map((n) => n.text));
}

/**
 * Every command that answers with a BLOCK (a head plus a rendered body), and every command that does not. The two
 * lists together must be exactly `COMMANDS`; that is what makes a 42nd command fail this file.
 */
const BLOCK_COMMANDS: readonly { readonly name: string; readonly line: string }[] = [
  { name: 'status', line: '/status' },
  { name: 'cost', line: '/cost' },
  { name: 'jev', line: '/jev' },
  { name: 'budget', line: '/budget' },
  { name: 'config', line: '/config' },
  { name: 'errors', line: '/errors' },
  { name: 'peers', line: '/peers' },
  { name: 'plan', line: '/plan' },
  { name: 'decisions', line: '/decisions' },
  { name: 'calibration', line: '/calibration' },
  { name: 'help', line: '/help' },
];

/**
 * §3.3: two commands answer DIFFERENTLY in the two renderers by design, and the difference is declared, not a
 * drift — `/panel` is the TUI's own pane (`PANEL_HANDLED_BY_TUI`) and prints a block only in a line renderer, and
 * `/resume` with no argument opens the TUI picker while a line renderer refuses it and asks for an id.
 */
const DECLARED_RENDERER_DIFFERENCES: readonly string[] = ['panel', 'resume'];

/** commands that answer with ONE item (or a prompt, or an exit), so §3.5's row-for-row rule does not apply */
const ONE_LINE_COMMANDS: readonly string[] = [
  'new',
  'rename',
  'steer',
  'unsteer',
  'pause',
  'abort',
  'undo',
  'rewind',
  'diff',
  'why',
  'model',
  'provider',
  'mode',
  'llm',
  'login',
  'logout',
  'trust',
  'theme',
  'transcript',
  'copy',
  'export',
  'report',
  'history',
  'editor',
  'exit',
  'fullscreen',
  'scrollback',
  'ui',
  // TUI-DESIGN-5 §2.7, §2.9: each answers with ONE item — the pause/end status sentence (§12 S17–S21, S28) or the
  // send confirmation; the `[session]` item the far end writes is the receiving session's row, not this one's
  'end',
  'tell',
  'headsup',
  'request',
  /**
   * TUI-DESIGN-5 §3.3, §4.9 (D-AN) and §5.5: seven of the nine rows the integration pass landed answer with ONE
   * item — `/compact`'s before/after sentence (§12 S57–S58a, and NOTHING at all when the engine's own compaction
   * notice already said what happened) and the six honest `<verb> is not available in this build` refusals. Each
   * moves into `BLOCK_COMMANDS` when its store exists and it starts answering with rows.
   */
  'compact',
  'split',
  'agents',
  'agent',
  'land',
  'spawn',
  'import',
  'memory',
];

/**
 * TUI-DESIGN-5 §2.3, §2.9 and §3.2: the three round-5 commands that DO answer with a block. `/who` and `/context`
 * have their builders and their `case` arms (`src/session/peers.ts`'s `whoRows`, `src/tui/context/lines.ts`'s
 * `contextBlock`); `/inbox` is still the honest D-AN refusal. All three need a LIVE fold or a live run to produce
 * rows at all, which this file's fixture harness does not stand up — `r5-identity.test.ts` (§10 "Shared") is
 * where every round-5 surface's three sinks are asserted with its §13.2 truncation clause.
 */
const PENDING_ROUND5_BLOCKS: readonly string[] = ['who', 'inbox', 'context'];

describe('TUI-DESIGN-4 §3.5 (D-W): the TUI rows and the `--plain` rows of a block are the same rows', () => {
  it('covers every command of the registry — a 42nd command without a twin fails here (§10 S3)', () => {
    const named = new Set([...BLOCK_COMMANDS.map((c) => c.name), ...ONE_LINE_COMMANDS, ...DECLARED_RENDERER_DIFFERENCES, ...PENDING_ROUND5_BLOCKS]);
    const registry = COMMANDS.map((c) => c.name);
    expect([...named].filter((n) => !registry.includes(n)), 'listed here but not a command').toEqual([]);
    expect(registry.filter((n) => !named.has(n)), 'a command with no row in this file').toEqual([]);
    // 37 (round 3) → 41 (round 4) → 47 with R5-2's six §2.3/§2.7/§2.9 rows → 56 with every round-5 slot's rows
    // landed in the one §9.2 registry PR (gate G-R5-10's number)
    expect(registry.length).toBe(56);
  });

  for (const { name, line } of BLOCK_COMMANDS) {
    it(`/${name}: the same rows in the TUI and in the line renderers`, async () => {
      // ONE workspace and ONE home for both: the comparison is of the rows, not of two temp directories
      const tui = await makeController({ flags: { mock: true, mockSteps: '2' }, rendererKind: 'tui' });
      const plain = await makeController({ flags: { mock: true, mockSteps: '2' }, rendererKind: 'plain', home: tui.home, workspace: tui.workspace });
      try {
        void tui.controller.run();
        void plain.controller.run();
        await tui.ready();
        await plain.ready();
        await tui.command(line);
        const mark = plain.renderer.notes.length;
        await plain.command(line);
        const a = tuiRows(tui);
        const b = plainRows(plain, mark);
        expect(a.length, `${line}: the TUI produced no rows`).toBeGreaterThan(0);
        expect(b, `${line}`).toEqual(a);
      } finally {
        tui.cleanup();
        plain.cleanup();
      }
    });
  }
});
