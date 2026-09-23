/**
 * TUI-DESIGN-5 §10 (R5-5, the `onboarding/reducer.test.ts` half that §5.1 adds): the `'import'` step appears
 * **only** when `probe` returns a non-empty result (§7 row 52), **is skipped past the 50 ms deadline** (§7 row
 * 53), and `3 never` writes `seen.import` **once** (§5.1, D-Q's `seen.defaultMode` precedent).
 *
 * The step is pure reducer state plus two optional host seams (`importProbe` / `seenImport` / `openImport`), so
 * the reducer half is tested directly and the "once" half through `useWizard` over `ink-testing-library` — the
 * same harness `wizard-paste.test.tsx` already uses.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { Wizard, useWizard, type WizardController, type WizardHost } from '../../../../src/tui/onboarding/Wizard.js';
import { INITIAL_ONBOARDING, importStepWanted, onboardingReducer, wizardRows, type ImportProbeCounts, type OnboardingState } from '../../../../src/tui/onboarding/reducer.js';
import { stringWidth } from '../../../../src/tui/composer/width.js';
import { SR_IMPORT_ROWS, WIZARD_IMPORT_HINT, WIZARD_IMPORT_HINT_FULL, WIZARD_IMPORT_OPTIONS, WIZARD_IMPORT_OPTIONS_NARROW, WIZARD_IMPORT_TITLE, importOptionsRow, importProbeSummary, importTitleRow, wizardConsoleTitle, wizardLines, wizardMinsizeRow } from '../../../../src/tui/onboarding/lines.js';

afterEach(() => cleanup());
const strip = (s: string | undefined): string => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '');
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('until: condition not met in time');
    await tick(5);
  }
}

const FOUND: ImportProbeCounts = { tools: [{ display: 'claude-code', items: 43 }, { display: 'codex', items: 3 }], total: 46 };

/** the startup wizard, wound forward to the sandbox step with no keys to type and no trust question */
function atSandbox(over: Partial<OnboardingState> = {}): OnboardingState {
  const detected = onboardingReducer(INITIAL_ONBOARDING, { type: 'detect', missing: [], mode: 'jev-on', provider: null, trustNeeded: false });
  return { ...detected, step: 'sandbox', ...over };
}

describe('§7 row 52 — the step appears only when the probe found something', () => {
  it('a non-empty probe puts `import` between `sandbox` and `done`', () => {
    const s = onboardingReducer({ ...atSandbox(), importProbe: FOUND }, { type: 'sandbox-shown' }, );
    expect(s.step).toBe('import');
  });

  it('an EMPTY probe skips straight to `done` — the step does not render at all', () => {
    const empty: ImportProbeCounts = { tools: [], total: 0 };
    expect(onboardingReducer({ ...atSandbox(), importProbe: empty }, { type: 'sandbox-shown' }).step).toBe('done');
    expect(importStepWanted({ importProbe: empty, importSeen: false })).toBe(false);
  });

  it('`seen.import` already set skips it, whatever the probe found', () => {
    expect(onboardingReducer({ ...atSandbox(), importProbe: FOUND, importSeen: true }, { type: 'sandbox-shown' }).step).toBe('done');
    expect(importStepWanted({ importProbe: FOUND, importSeen: true })).toBe(false);
    // `detect` carries the flag in, so the host reads `seen.import` once and the reducer never reads config
    const s = onboardingReducer(INITIAL_ONBOARDING, { type: 'detect', missing: [], mode: 'jev-on', provider: null, trustNeeded: false, importSeen: true });
    expect(s.importSeen).toBe(true);
  });

  it('a reopened wizard (`/login`, `/mode`, `/trust`) never reaches the step at all', () => {
    const s = onboardingReducer(INITIAL_ONBOARDING, { type: 'detect', missing: [], mode: 'jev-on', provider: null, trustNeeded: false, reason: 'login' });
    expect(s.step).not.toBe('sandbox');
    expect(s.step).not.toBe('import');
  });
});

describe('§7 row 53 — the probe misses its 50 ms deadline', () => {
  it('a pending probe (`null`) is "no" — the wizard never waits on it', () => {
    expect(importStepWanted({ importProbe: null, importSeen: false })).toBe(false);
    expect(onboardingReducer(atSandbox(), { type: 'sandbox-shown' }).step).toBe('done');
  });

  it('`{ found: null }` (the deadline, or nothing installed) is the same answer as an empty result', () => {
    const s = onboardingReducer({ ...atSandbox(), importProbe: FOUND }, { type: 'sandbox-shown' });
    expect(s.step).toBe('import');
    expect(onboardingReducer(s, { type: 'import-probe', found: null }).step).toBe('done');
  });

  it('a probe that resolves AFTER the wizard finished is dropped — the step is skipped for this start', () => {
    const done = onboardingReducer(atSandbox(), { type: 'sandbox-shown' });
    expect(done.step).toBe('done');
    const late = onboardingReducer(done, { type: 'import-probe', found: FOUND });
    expect(late.step).toBe('done');
    expect(late.importProbe).toBeNull();
  });
});

describe('§5.1 — the three answers', () => {
  const open = (): OnboardingState => onboardingReducer({ ...atSandbox(), importProbe: FOUND }, { type: 'sandbox-shown' });

  it('a digit highlights and the SAME digit confirms (the `WIZARD_OPTIONS_ORDER` idiom)', () => {
    let s = open();
    s = onboardingReducer(s, { type: 'import-choose', option: 3 });
    expect(s.step).toBe('import');
    expect(s.importHighlight).toBe(3);
    expect(s.importChoice).toBeNull();
    s = onboardingReducer(s, { type: 'import-choose', option: 3 });
    expect(s.step).toBe('done');
    expect(s.importChoice).toBe(3);
  });

  it('Enter with a highlight confirms it; Enter with none is `2 later`', () => {
    const a = onboardingReducer(onboardingReducer(open(), { type: 'import-choose', option: 1 }), { type: 'import-choose', option: 'enter' });
    expect(a.importChoice).toBe(1);
    const b = onboardingReducer(open(), { type: 'import-choose', option: 'enter' });
    expect(b.importChoice).toBe(2);
  });

  it('Esc is `2 later` — the offer returns next version, never never', () => {
    const s = onboardingReducer(open(), { type: 'escape' });
    expect(s.step).toBe('done');
    expect(s.importChoice).toBe(2);
  });

  it('Ctrl-C on the import step CLOSES (exit code null), it never exits 2 — the keys are already saved', () => {
    const s = onboardingReducer(open(), { type: 'cancel' });
    expect(s.step).toBe('done');
    expect(s.exitCode).toBeNull();
    expect(s.importChoice).toBe(2);
  });
});

describe('§5.1 rows and §12.4 S87 / S88', () => {
  const st = (over: Partial<OnboardingState> = {}): OnboardingState => ({ ...INITIAL_ONBOARDING, step: 'import', importProbe: FOUND, ...over });

  it('is three rows, inside D1’s ≤ 4-row budget', () => {
    expect(wizardRows(st(), 24)).toBe(3);
    expect(wizardLines(st(), { rows: 24, columns: 80 })).toHaveLength(3);
  });

  it('S87: the title carries the probe summary, then the three options, then the hint', () => {
    const rows = wizardLines(st(), { rows: 24, columns: 100 });
    expect(rows[0]).toBe('Import your memory and workflows?  found claude-code (43 items), codex (3 items)');
    expect(rows[1]).toBe(WIZARD_IMPORT_OPTIONS);
    expect(rows[2]).toBe(WIZARD_IMPORT_HINT_FULL);
  });

  it('a narrow terminal moves the summary to its OWN row (F-57) and narrows the options', () => {
    expect(importTitleRow(FOUND, 40)).toBe(WIZARD_IMPORT_TITLE);
    expect(importOptionsRow(null, 30)).toBe(WIZARD_IMPORT_OPTIONS_NARROW);
    const rows = wizardLines(st(), { rows: 24, columns: 40 });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe(WIZARD_IMPORT_TITLE);
    expect(rows[1]).toBe('found 2 tools (46 items)');
    // D-AB: the ladder takes the WIDEST rung that fits, and the wide options row is 33 cells — the narrow rung
    // is what a 30-cell body (a boxed console at 34 columns) gets, which `importOptionsRow(null, 30)` above pins
    expect(rows[2]).toBe(WIZARD_IMPORT_OPTIONS);
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(40);
  });

  it('F-57 verbatim at 40 columns: title · what was found · the three options', () => {
    // one tool, so the summary is the per-tool form the frame draws (the NOUN is `items`, see the deviation below)
    const one: ImportProbeCounts = { tools: [{ display: 'claude-code', items: 43 }], total: 43 };
    expect(wizardLines(st({ importProbe: one }), { rows: 24, columns: 40 })).toEqual(['Import your memory and workflows?', 'found claude-code (43 items)', WIZARD_IMPORT_OPTIONS]);
    // the same three-row SHAPE at the narrowest body the minsize ladder still renders (a boxed console at 34):
    // the title clips (it is prose, and `clipRow` owns it), the summary stays whole, the options take the narrow rung
    const at30 = wizardLines(st({ importProbe: one }), { rows: 24, columns: 30 });
    expect(at30).toHaveLength(3);
    expect(at30[1]).toBe('found claude-code (43 items)');
    expect(at30[2]).toBe(WIZARD_IMPORT_OPTIONS_NARROW);
    expect(wizardConsoleTitle({ step: 'import' })).toBe('setup · import');
  });

  it('the hint row returns as soon as the summary fits BESIDE the title (80+), and `(Esc = later)` is the narrow rung', () => {
    const rows80 = wizardLines(st(), { rows: 24, columns: 100 });
    expect(rows80[1]).toBe(WIZARD_IMPORT_OPTIONS);
    expect(rows80[2]).toBe(WIZARD_IMPORT_HINT_FULL);
    // a probe that found nothing has no summary row, so the hint keeps its place at every width
    const none = wizardLines(st({ importProbe: null }), { rows: 24, columns: 40 });
    expect(none[2]).toBe(WIZARD_IMPORT_HINT);
  });

  it('§12.4 S87 verbatim: the options fragment has ONE leading space', () => {
    expect(WIZARD_IMPORT_OPTIONS).toBe(' 1 import now   2 later   3 never');
    expect(WIZARD_IMPORT_OPTIONS_NARROW).toBe(' 1 import  2 later  3 never');
  });

  it('DECLARED §13.2 deviation: S87 says `notes` / `servers`, and `ImportProbe.tools` carries only `items`', () => {
    // `{ tool, display, items }` (src/core/types.ts:3384) has no noun field, so `items` is the only honest word
    // this build can say. The harness request for `noun` is in the implementer report; this pins the substitution.
    expect(importProbeSummary(FOUND, 80)).toBe('found claude-code (43 items), codex (3 items)');
    expect(importProbeSummary(FOUND, 80)).not.toContain('notes');
  });

  it('the marked options row is never wider than the terminal (the mark is one cell, and it is measured)', () => {
    for (const highlight of [null, 1, 2, 3] as const) {
      for (let c = 1; c <= 80; c++) {
        for (const ascii of [false, true]) {
          const row = importOptionsRow(highlight, c, ascii);
          expect(stringWidth(row), `${String(highlight)}:${c}:${ascii}`).toBeLessThanOrEqual(c);
        }
      }
    }
    // and at the exact boundary widths the whole `3 never` is still on the row
    expect(importOptionsRow(2, 34)).toContain('3 never');
    expect(importOptionsRow(2, 28)).toContain('3 never');
  });

  it('the highlighted digit is marked, and the `--ascii` twin uses `>` not `▌`', () => {
    expect(importOptionsRow(2, 80)).toContain('▌2 ');
    expect(importOptionsRow(2, 80, true)).toContain('>2 ');
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7f]*$/.test(importOptionsRow(2, 80, true))).toBe(true);
  });

  it('the screen-reader twin is numbered with `Enter selection (1-3):`', () => {
    const rows = wizardLines(st(), { rows: 24, columns: 80, screenReader: true });
    expect(rows).toEqual([...SR_IMPORT_ROWS]);
    expect(rows[1]).toContain('Enter selection (1-3):');
  });

  it('the console title is `setup · import`', () => {
    expect(wizardConsoleTitle({ step: 'import' })).toBe('setup · import');
  });

  it('§12.4 S88: the minsize row names the size and says `to choose`, and every rung fits its width', () => {
    expect(wizardMinsizeRow(st(), 80)).toBe('setup · import — terminal too small; ≥ 40×8 to choose');
    expect(wizardMinsizeRow(st(), 80, true)).toBe('setup - import - terminal too small; >= 40x8 to choose');
    for (let c = 1; c <= 80; c++) {
      expect(wizardMinsizeRow(st(), c).length, `${c}`).toBeLessThanOrEqual(Math.max(c, 'setup'.length));
    }
  });

  it('the probe summary collapses rather than overflowing, and is empty when nothing was found', () => {
    expect(importProbeSummary(FOUND, 30)).toBe('found 2 tools (46 items)');
    // §5.8: a summary that does not fit is DROPPED, never clipped — a clipped tool name is a tool you do not have
    expect(importProbeSummary(FOUND, 20)).toBe('');
    expect(importProbeSummary(null, 80)).toBe('');
    expect(importProbeSummary({ tools: [], total: 0 }, 80)).toBe('');
  });
});

describe('`3 never` writes `seen.import` ONCE (§5.1, the `seen.defaultMode` precedent)', () => {
  interface Harness {
    ctl: () => WizardController;
    frame: () => string;
    seen: ('later' | 'never')[];
    opened: number;
    probes: number;
  }

  function harness(probe: ImportProbeCounts | null): Harness {
    const h: Harness = { ctl: () => ctlRef as WizardController, frame: () => strip(ui.lastFrame()), seen: [], opened: 0, probes: 0 };
    const host: WizardHost = {
      save: async () => ({ ok: true, items: [] }),
      sandboxLine: () => 'sandbox: seatbelt',
      importProbe: async () => {
        h.probes++;
        return probe;
      },
      openImport: () => {
        h.opened++;
      },
      seenImport: (answer) => {
        h.seen.push(answer);
      },
    };
    let ctlRef: WizardController | null = null;
    function Probe(): React.JSX.Element {
      const ctl = useWizard({ host: () => host, onItem: () => undefined, onDone: () => undefined, onExit: () => undefined });
      ctlRef = ctl;
      return ctl.active || ctl.state.step === 'import' ? <Wizard state={ctl.state} rows={Math.max(1, ctl.rows(24))} columns={80} top={0} /> : <Text>closed</Text>;
    }
    const ui = render(<Probe />);
    return h;
  }

  it('`3` then `3` calls `seenImport("never")` exactly once and never opens the overlay', async () => {
    const h = harness(FOUND);
    h.ctl().start({ missing: [], mode: 'jev-on', provider: null, trustNeeded: false });
    // the reducer's own probe arrives through the host seam; the step opens once it is non-empty
    h.ctl().dispatch({ type: 'import-probe', found: FOUND });
    h.ctl().dispatch({ type: 'sandbox-shown' });
    await until(() => h.ctl().state.step === 'import');
    expect(h.frame()).toContain(WIZARD_IMPORT_TITLE);
    h.ctl().apply({ type: 'wizard', op: 'input', text: '3' });
    h.ctl().apply({ type: 'wizard', op: 'input', text: '3' });
    await until(() => h.seen.length > 0);
    await tick(10);
    expect(h.seen).toEqual(['never']);
    expect(h.opened).toBe(0);
  });

  it('`2 later` persists `later`, and Esc does the same', async () => {
    const a = harness(FOUND);
    a.ctl().start({ missing: [], mode: 'jev-on', provider: null, trustNeeded: false });
    a.ctl().dispatch({ type: 'import-probe', found: FOUND });
    a.ctl().dispatch({ type: 'sandbox-shown' });
    await until(() => a.ctl().state.step === 'import');
    a.ctl().apply({ type: 'wizard', op: 'back' });
    await until(() => a.seen.length > 0);
    expect(a.seen).toEqual(['later']);
  });

  it('`1 import now` opens the overlay and writes nothing', async () => {
    const h = harness(FOUND);
    h.ctl().start({ missing: [], mode: 'jev-on', provider: null, trustNeeded: false });
    h.ctl().dispatch({ type: 'import-probe', found: FOUND });
    h.ctl().dispatch({ type: 'sandbox-shown' });
    await until(() => h.ctl().state.step === 'import');
    h.ctl().apply({ type: 'wizard', op: 'input', text: '1' });
    h.ctl().apply({ type: 'wizard', op: 'submit' });
    await until(() => h.opened > 0);
    await tick(10);
    expect(h.opened).toBe(1);
    expect(h.seen).toEqual([]);
  });

  it('a host with no import seams never shows the step (the two methods are optional)', async () => {
    let ctlRef: WizardController | null = null;
    const host: WizardHost = { save: async () => ({ ok: true, items: [] }), sandboxLine: () => null };
    function Probe(): React.JSX.Element {
      const ctl = useWizard({ host: () => host, onItem: () => undefined, onDone: () => undefined, onExit: () => undefined });
      ctlRef = ctl;
      return <Text>{ctl.state.step}</Text>;
    }
    render(<Probe />);
    (ctlRef as unknown as WizardController).start({ missing: [], mode: 'jev-on', provider: null, trustNeeded: false });
    await until(() => (ctlRef as unknown as WizardController).state.step === 'done');
    expect((ctlRef as unknown as WizardController).state.step).toBe('done');
  });
});

describe('§5.1 — the probe actually runs, once, after the first frame', () => {
  interface Probed {
    ctl: () => WizardController;
    probes: number;
    seen: ('later' | 'never')[];
  }

  function harness(probe: () => Promise<ImportProbeCounts | null>): Probed {
    const h: Probed = { ctl: () => ctlRef as WizardController, probes: 0, seen: [] };
    const host: WizardHost = {
      save: async () => ({ ok: true, items: [] }),
      sandboxLine: () => 'sandbox: seatbelt',
      importProbe: async () => {
        h.probes++;
        return await probe();
      },
      seenImport: (a) => {
        h.seen.push(a);
      },
    };
    let ctlRef: WizardController | null = null;
    function Probe(): React.JSX.Element {
      const ctl = useWizard({ host: () => host, onItem: () => undefined, onDone: () => undefined, onExit: () => undefined });
      ctlRef = ctl;
      return <Text>{ctl.state.step}</Text>;
    }
    render(<Probe />);
    return h;
  }

  it('a host that implements ONLY `importProbe` reaches `step === "import"` with no manual dispatch', async () => {
    const h = harness(async () => FOUND);
    h.ctl().start({ missing: [], mode: 'jev-on', provider: null, trustNeeded: false });
    await until(() => h.ctl().state.step === 'import');
    expect(h.ctl().state.step).toBe('import');
    expect(h.ctl().state.importProbe).toEqual(FOUND);
    expect(h.probes).toBe(1);
  });

  it('it is asked EXACTLY once per wizard, however many times the state changes', async () => {
    const h = harness(async () => FOUND);
    h.ctl().start({ missing: [], mode: 'jev-on', provider: null, trustNeeded: false });
    await until(() => h.ctl().state.step === 'import');
    h.ctl().dispatch({ type: 'import-choose', option: 3 });
    h.ctl().dispatch({ type: 'import-choose', option: 3 });
    await until(() => h.seen.length > 0);
    expect(h.probes).toBe(1);
  });

  it('§7 row 52: an empty probe answers, and the wizard finishes at `done` without the step', async () => {
    const h = harness(async () => ({ tools: [], total: 0 }));
    h.ctl().start({ missing: [], mode: 'jev-on', provider: null, trustNeeded: false });
    await until(() => h.ctl().state.step === 'done');
    expect(h.probes).toBe(1);
    expect(h.ctl().state.step).toBe('done');
  });

  it('§7 row 53: a probe that never answers does not block setup — the step is skipped past the deadline', async () => {
    const h = harness(() => new Promise<ImportProbeCounts | null>(() => undefined));
    h.ctl().start({ missing: [], mode: 'jev-on', provider: null, trustNeeded: false });
    await until(() => h.ctl().state.step === 'done', 3000);
    expect(h.ctl().state.step).toBe('done');
    expect(h.ctl().state.importProbe).toBeNull();
  });

  it('a rejected probe reads as "nothing found", never as an error on screen', async () => {
    const h = harness(async () => {
      throw new Error('probe exploded');
    });
    h.ctl().start({ missing: [], mode: 'jev-on', provider: null, trustNeeded: false });
    await until(() => h.ctl().state.step === 'done');
    expect(h.ctl().state.importProbe).toBeNull();
  });

  it('`seen.import` set at detect means the probe is never asked for at all', async () => {
    const h = harness(async () => FOUND);
    h.ctl().start({ missing: [], mode: 'jev-on', provider: null, trustNeeded: false, importSeen: true });
    await until(() => h.ctl().state.step === 'done');
    expect(h.probes).toBe(0);
  });
});
