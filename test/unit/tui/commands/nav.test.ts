/**
 * TUI-DESIGN-4 §4.2 (D-X) `nav.ts`: the nine-state chain and the 9 × 7 key table, one assertion per cell; totality
 * and disjointness of the ordered chain as a property test; the `arg0` / `restTail` split that makes
 * `/budget spend-cap 5` runnable (§14.2 review item 27) and the ninth state S-ARGBAD; §4.1's safety theorem as a
 * property test (no run of Enters from `/` can reach `run`); and §4.5's provenance rule — typing `/`,`e`,`x`,`i`,`t`
 * with no Tab and no cycle yields `confirm: null`.
 */
import { describe, expect, it } from 'vitest';
import {
  PALETTE_NAV_KEYS,
  PALETTE_NAV_STATES,
  PALETTE_PAGE,
  arg0Of,
  moveIndex,
  noCompletionsToast,
  noValueMatchesToast,
  nothingToPickToast,
  paletteNavState,
  paletteStep,
  restTailOf,
  takesNoArgumentsToast,
  type NavEffect,
  type NavKey,
  type PaletteNavState,
} from '../../../../src/tui/commands/nav.js';
import { paletteMatches, type PaletteMatch, type PaletteState } from '../../../../src/tui/commands/palette.js';
import { dispatchCommand } from '../../../../src/tui/commands/dispatch.js';
import { COMMANDS, findCommand, type CommandSpec } from '../../../../src/tui/commands/registry.js';

const fresh: PaletteState = { lastStop: null, unauthorized: false, changedFiles: false, rewindMenu: false, live: false };
const M = (query: string): PaletteMatch[] => paletteMatches(query, fresh);
const ctx = (draft: string, selected = 0, matches: readonly PaletteMatch[] = M(draft)): { draft: string; matches: readonly PaletteMatch[]; selected: number } => ({ draft, matches, selected });
const state = (draft: string, selected = 0, matches: readonly PaletteMatch[] = M(draft)): PaletteNavState => paletteNavState(draft, matches, selected);
const step = (draft: string, key: NavKey, selected = 0): NavEffect => paletteStep(state(draft, selected), key, ctx(draft, selected));
/** the index of the command's own row in the ranked matches (the ARMED marker) */
const rowOf = (draft: string, name: string): number => M(draft).findIndex((m) => m.spec.name === name);

describe('paletteNavState — the ordered chain (TUI-DESIGN-4 §4.2)', () => {
  it('the nine states, each reached by its chain position', () => {
    expect(PALETTE_NAV_STATES).toEqual(['none', 'one', 'browse', 'armed', 'picked', 'free', 'argdone', 'arg', 'argbad']);
    expect(state('/zz', 0, [])).toBe('none'); // 1
    expect(M('/rew')).toHaveLength(1);
    expect(state('/rew')).toBe('one'); // 2
    expect(state('/')).toBe('browse'); // 3
    expect(state('/mode', rowOf('/mode', 'mode'))).toBe('armed'); // 4
    expect(state('/mode', rowOf('/mode', 'model'))).toBe('picked'); // 5 — the marker is on /model, the draft is /mode (E4)
    expect(state('/rename x')).toBe('free'); // 6
    expect(state('/mode jev-on', rowOf('/mode jev-on', 'mode'))).toBe('argdone'); // 7
    expect(state('/mode ', rowOf('/mode ', 'mode'))).toBe('arg'); // 8
    expect(state('/mode jev-onx', rowOf('/mode jev-onx', 'mode'))).toBe('argbad'); // 9
  });

  it('arg0 / restTail: the FIRST token after the command, `null` with no whitespace and `\'\'` with trailing whitespace; restTail is never a predicate', () => {
    expect(arg0Of('/budget')).toBeNull();
    expect(arg0Of('/budget ')).toBe('');
    expect(arg0Of('/budget spend-cap')).toBe('spend-cap');
    expect(arg0Of('/budget spend-cap 5')).toBe('spend-cap');
    expect(arg0Of('  /budget\tspend-cap  5 ')).toBe('spend-cap');
    expect(arg0Of('hello world')).toBeNull();
    expect(restTailOf('/budget spend-cap 5')).toBe('5');
    expect(restTailOf('/budget spend-cap')).toBe('');
    expect(restTailOf('/budget ')).toBe('');
    expect(restTailOf('/budget spend-cap  5 6 ')).toBe('5 6');
    // the four cells of §14.2 item 27: a two-argument command must be runnable from an open palette
    expect(state('/budget spend-cap 5', rowOf('/budget spend-cap 5', 'budget'))).toBe('argdone');
    expect(step('/budget spend-cap 5', 'enter', rowOf('/budget spend-cap 5', 'budget'))).toEqual({ kind: 'run' });
    expect(state('/budget spend-cap', rowOf('/budget spend-cap', 'budget'))).toBe('argdone');
    expect(state('/budget ', rowOf('/budget ', 'budget'))).toBe('arg');
    expect(state('/mode jev-onx', rowOf('/mode jev-onx', 'mode'))).toBe('argbad');
    expect(step('/mode jev-onx', 'enter', rowOf('/mode jev-onx', 'mode'))).toEqual({ kind: 'run' });
    // `/rename` with no tail is S-ARMED, not S-FREE (S-FREE is only reached with `arg0` present)
    expect(state('/rename', rowOf('/rename', 'rename'))).toBe('armed');
    expect(state('/rename ', rowOf('/rename ', 'rename'))).toBe('free');
  });

  it('totality and disjointness: every (draft, matches, selected) triple resolves to exactly one of the nine', () => {
    const drafts = ['', '/', '/z', '/zz', '/c', '/cost', '/COST', '/rew', '/mode', '/mode ', '/mode j', '/mode jev-on', '/mode JEV-ON', '/mode jev-onx', '/budget', '/budget ', '/budget sp', '/budget spend-cap', '/budget spend-cap 5', '/rename', '/rename x', '/ui', '/ui reset', '/ui rese', '/ui nope', '/q', '/quit', 'hello', '//x', '  /cost  '];
    const seen = new Set<PaletteNavState>();
    for (const d of drafts) {
      const matches = M(d);
      for (const sel of [-3, 0, 1, 2, matches.length - 1, matches.length, 99]) {
        const s = paletteNavState(d, matches, sel);
        expect(PALETTE_NAV_STATES, `${d} @${sel}`).toContain(s);
        seen.add(s);
        // disjointness: the chain is an if-chain, so a second evaluation is identical (no predicate overlap to resolve)
        expect(paletteNavState(d, matches, sel)).toBe(s);
      }
    }
    expect([...seen].sort()).toEqual([...PALETTE_NAV_STATES].sort());
  });
});

describe('paletteStep — the 9 × 7 table (TUI-DESIGN-4 §4.2)', () => {
  const cell = (s: PaletteNavState, key: NavKey, draft: string, selected = 0): NavEffect => paletteStep(s, key, ctx(draft, selected));
  const move = (by: number, over: 'matches' | 'values', wrap: boolean): NavEffect => ({ kind: 'move', by, over, wrap });

  it('S-BROWSE: Enter cycles, Tab accepts, Shift+Tab/↑/↓ wrap, PgUp/PgDn ±7 clamp', () => {
    expect(cell('browse', 'enter', '/')).toEqual(move(1, 'matches', true));
    expect(cell('browse', 'tab', '/')).toEqual({ kind: 'accept' });
    expect(cell('browse', 'shifttab', '/')).toEqual(move(-1, 'matches', true));
    expect(cell('browse', 'up', '/')).toEqual(move(-1, 'matches', true));
    expect(cell('browse', 'down', '/')).toEqual(move(1, 'matches', true));
    expect(cell('browse', 'pageup', '/')).toEqual(move(-PALETTE_PAGE, 'matches', false));
    expect(cell('browse', 'pagedown', '/')).toEqual(move(PALETTE_PAGE, 'matches', false));
  });

  it('S-ONE (E1): Enter accepts, Tab and Shift+Tab accept, the arrows are no-ops', () => {
    for (const k of ['enter', 'tab', 'shifttab'] as const) expect(cell('one', k, '/rew')).toEqual({ kind: 'accept' });
    for (const k of ['up', 'down', 'pageup', 'pagedown'] as const) expect(cell('one', k, '/rew')).toEqual({ kind: 'none' });
  });

  it('S-NONE (E2): Enter and Tab toast, everything else is inert, and Enter never appends an item', () => {
    expect(cell('none', 'enter', '/zz')).toEqual({ kind: 'toast', text: nothingToPickToast('/zz') });
    expect(cell('none', 'tab', '/zz')).toEqual({ kind: 'toast', text: 'nothing to pick — no command matches /zz' });
    for (const k of ['shifttab', 'up', 'down', 'pageup', 'pagedown'] as const) expect(cell('none', k, '/zz')).toEqual({ kind: 'none' });
  });

  it('S-ARMED: Enter RUNS; Tab adds an argument only for an enum arg 0, else the honest toast; the arrows move to S-PICKED', () => {
    const i = rowOf('/mode', 'mode');
    expect(cell('armed', 'enter', '/mode', i)).toEqual({ kind: 'run' });
    expect(cell('armed', 'tab', '/mode', i)).toEqual({ kind: 'appendSpace' });
    // a command with no arguments at all
    expect(cell('armed', 'tab', '/cost', rowOf('/cost', 'cost'))).toEqual({ kind: 'toast', text: takesNoArgumentsToast('cost') });
    expect(takesNoArgumentsToast('cost')).toBe('/cost takes no arguments');
    // a command whose arg 0 is free text keeps round 3's `no completions for <arg>` (`/rename` + Tab says `title`)
    expect(cell('armed', 'tab', '/rename', rowOf('/rename', 'rename'))).toEqual({ kind: 'toast', text: noCompletionsToast('title') });
    expect(cell('armed', 'shifttab', '/mode', i)).toEqual(move(-1, 'matches', true));
    expect(cell('armed', 'up', '/mode', i)).toEqual(move(-1, 'matches', true));
    expect(cell('armed', 'down', '/mode', i)).toEqual(move(1, 'matches', true));
    expect(cell('armed', 'pageup', '/mode', i)).toEqual(move(-PALETTE_PAGE, 'matches', false));
    expect(cell('armed', 'pagedown', '/mode', i)).toEqual(move(PALETTE_PAGE, 'matches', false));
  });

  it('S-PICKED (E4): `/mode` with the marker on /model — Enter cycles (never runs), Tab accepts the marked row', () => {
    const j = rowOf('/mode', 'model');
    expect(state('/mode', j)).toBe('picked');
    expect(cell('picked', 'enter', '/mode', j)).toEqual(move(1, 'matches', true));
    expect(cell('picked', 'tab', '/mode', j)).toEqual({ kind: 'accept' });
    expect(cell('picked', 'shifttab', '/mode', j)).toEqual(move(-1, 'matches', true));
    expect(cell('picked', 'pagedown', '/mode', j)).toEqual(move(PALETTE_PAGE, 'matches', false));
  });

  it('S-FREE: Enter RUNS (dispatchCommand validates and reports), Tab has no completions, Shift+Tab is inert', () => {
    const i = rowOf('/rename x', 'rename');
    expect(cell('free', 'enter', '/rename x', i)).toEqual({ kind: 'run' });
    expect(cell('free', 'tab', '/rename x', i)).toEqual({ kind: 'toast', text: 'no completions for title' });
    expect(cell('free', 'shifttab', '/rename x', i)).toEqual({ kind: 'none' });
    expect(cell('free', 'up', '/rename x', i)).toEqual(move(-1, 'matches', true));
    expect(cell('free', 'down', '/rename x', i)).toEqual(move(1, 'matches', true));
    expect(cell('free', 'pageup', '/rename x', i)).toEqual(move(-PALETTE_PAGE, 'matches', false));
  });

  it('S-ARGDONE: Enter RUNS; Tab answers for arg 1; the arrows walk the value list', () => {
    const i = rowOf('/mode jev-on', 'mode');
    expect(cell('argdone', 'enter', '/mode jev-on', i)).toEqual({ kind: 'run' });
    expect(cell('argdone', 'tab', '/mode jev-on', i)).toEqual({ kind: 'toast', text: takesNoArgumentsToast('mode') });
    // `/budget spend-cap` has an arg 1 with no values of its own → round 3's toast, never an inert key
    const b = rowOf('/budget spend-cap', 'budget');
    expect(cell('argdone', 'tab', '/budget spend-cap', b)).toEqual({ kind: 'toast', text: noCompletionsToast('value') });
    expect(cell('argdone', 'shifttab', '/mode jev-on', i)).toEqual(move(-1, 'values', true));
    expect(cell('argdone', 'up', '/mode jev-on', i)).toEqual(move(-1, 'values', true));
    expect(cell('argdone', 'down', '/mode jev-on', i)).toEqual(move(1, 'values', true));
    expect(cell('argdone', 'pagedown', '/mode jev-on', i)).toEqual(move(PALETTE_PAGE, 'values', false));
  });

  it('S-ARG: Enter cycles the VALUES, Tab accepts one', () => {
    const i = rowOf('/mode ', 'mode');
    expect(cell('arg', 'enter', '/mode ', i)).toEqual(move(1, 'values', true));
    expect(cell('arg', 'tab', '/mode ', i)).toEqual({ kind: 'accept' });
    expect(cell('arg', 'shifttab', '/mode ', i)).toEqual(move(-1, 'values', true));
    expect(cell('arg', 'up', '/mode j', i)).toEqual(move(-1, 'values', true));
    expect(cell('arg', 'pageup', '/mode j', i)).toEqual(move(-PALETTE_PAGE, 'values', false));
  });

  it('S-ARGBAD (the ninth state): Enter RUNS so the user gets an error instead of an inert key; Tab names the bad value', () => {
    const i = rowOf('/mode jev-onx', 'mode');
    expect(cell('argbad', 'enter', '/mode jev-onx', i)).toEqual({ kind: 'run' });
    expect(cell('argbad', 'tab', '/mode jev-onx', i)).toEqual({ kind: 'toast', text: noValueMatchesToast('mode', 'jev-onx') });
    expect(noValueMatchesToast('mode', 'jev-onx')).toBe('no value of /mode matches jev-onx');
    expect(cell('argbad', 'shifttab', '/mode jev-onx', i)).toEqual(move(-1, 'values', true));
    expect(cell('argbad', 'down', '/mode jev-onx', i)).toEqual(move(1, 'values', true));
    // and the run really does report: dispatchCommand rejects the value with the §5.1 reason
    expect(dispatchCommand('/mode jev-onx', { run: 'none', step: 0 })).toMatchObject({ ok: false, keepDraft: true });
  });

  it('every (state, key) pair yields exactly one effect kind, and only the four run-states can produce `run`', () => {
    const drafts: Record<PaletteNavState, [string, number]> = {
      none: ['/zz', 0],
      one: ['/rew', 0],
      browse: ['/', 0],
      armed: ['/mode', rowOf('/mode', 'mode')],
      picked: ['/mode', rowOf('/mode', 'model')],
      free: ['/rename x', rowOf('/rename x', 'rename')],
      argdone: ['/mode jev-on', rowOf('/mode jev-on', 'mode')],
      arg: ['/mode ', rowOf('/mode ', 'mode')],
      argbad: ['/mode jev-onx', rowOf('/mode jev-onx', 'mode')],
    };
    const runners = new Set<PaletteNavState>();
    for (const s of PALETTE_NAV_STATES) {
      const [draft, sel] = drafts[s];
      for (const key of PALETTE_NAV_KEYS) {
        const e = paletteStep(s, key, ctx(draft, sel));
        expect(['move', 'accept', 'run', 'appendSpace', 'toast', 'none'], `${s}/${key}`).toContain(e.kind);
        if (e.kind === 'run') runners.add(s);
      }
    }
    expect([...runners].sort()).toEqual(['argbad', 'argdone', 'armed', 'free']);
  });
});

describe('§4.1 the safety theorem, as a property test', () => {
  it('no run of Enters from `/` ever yields `run` — the draft never becomes exact, so the destructive set is unreachable', () => {
    const lists: readonly (readonly PaletteMatch[])[] = [M('/'), M('/e'), M('/m'), M('/').slice(0, 2), M('/').slice(0, 7)];
    for (const matches of lists) {
      expect(matches.length).toBeGreaterThanOrEqual(2);
      let i = 0;
      for (let k = 0; k < 200; k++) {
        const s = paletteNavState('/', matches, i);
        const e = paletteStep(s, 'enter', { draft: '/', matches, selected: i });
        expect(e.kind, `k=${k}`).toBe('move');
        if (e.kind === 'move') i = moveIndex(i, e, matches.length);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(matches.length);
      }
    }
  });

  it('the rewind menu is covered: /new is in it, and Enter still only cycles', () => {
    const menu: PaletteState = { ...fresh, rewindMenu: true };
    const matches = paletteMatches('/', menu);
    expect(matches.map((m) => m.spec.name)).toContain('new');
    let i = 0;
    for (let k = 0; k < 50; k++) {
      const e = paletteStep(paletteNavState('/', matches, i), 'enter', { draft: '/', matches, selected: i });
      expect(e.kind).toBe('move');
      if (e.kind === 'move') i = moveIndex(i, e, matches.length);
    }
  });

  it('the path to a destroyed session needs distinct keys and a positive `y`: the draft must be exact before any Enter can run', () => {
    // `/ne` still has four candidates, so Enter cycles; only the zero-ambiguity S-ONE accept mutates a draft
    // TUI-DESIGN-5 §3.2: `/context` joins the `/ne` candidates (`n`, `e` in order), so there are five — the
    // theorem is about DISTINCT KEYS and an exact draft, and a fifth candidate only makes Enter cycle longer
    expect(M('/ne').map((m) => m.spec.name)).toEqual(['new', 'panel', 'unsteer', 'context', 'rename']);
    expect(state('/ne')).toBe('browse');
    expect(step('/ne', 'enter')).toEqual({ kind: 'move', by: 1, over: 'matches', wrap: true });
    expect(state('/rew')).toBe('one'); // the one-candidate case: Enter accepts, and the command is then visible in the draft
    expect(step('/rew', 'enter')).toEqual({ kind: 'accept' });
    expect(state('/new', rowOf('/new', 'new'))).toBe('armed');
    expect(step('/new', 'enter', rowOf('/new', 'new'))).toEqual({ kind: 'run' });
    // and that run hits the confirm gate, whose Enter is inert (§4.5)
    expect(dispatchCommand('/new', { run: 'none', step: 0, fromPalette: true })).toMatchObject({ ok: true, confirm: 'new' });
  });

  it('§4.5: typing `/`,`e`,`x`,`i`,`t`,Enter with no Tab and no cycle yields `confirm: null`', () => {
    let draft = '';
    for (const ch of '/exit') {
      draft += ch;
      const matches = M(draft);
      // no key of the nav machine is pressed while typing, so nothing ever sets the provenance ref
      expect(paletteNavState(draft, matches, 0)).not.toBe('none');
    }
    expect(state('/exit', rowOf('/exit', 'exit'))).toBe('armed');
    expect(step('/exit', 'enter', rowOf('/exit', 'exit'))).toEqual({ kind: 'run' });
    expect(dispatchCommand('/exit', { run: 'none', step: 0 })).toMatchObject({ ok: true, confirm: null });
    expect(dispatchCommand('/exit', { run: 'none', step: 0, fromPalette: false })).toMatchObject({ confirm: null });
    // only a selection sets it
    expect(dispatchCommand('/exit', { run: 'none', step: 0, fromPalette: true })).toMatchObject({ confirm: 'exit' });
  });
});

describe('moveIndex (TUI-DESIGN-4 §4.2)', () => {
  it('±1 wraps, a page clamps, an empty list is 0 and a NaN index is the first row', () => {
    const wrap = (by: number): NavEffect & { kind: 'move' } => ({ kind: 'move', by, over: 'matches', wrap: true });
    const clamp = (by: number): NavEffect & { kind: 'move' } => ({ kind: 'move', by, over: 'matches', wrap: false });
    expect(moveIndex(4, wrap(1), 5)).toBe(0);
    expect(moveIndex(0, wrap(-1), 5)).toBe(4);
    expect(moveIndex(0, clamp(-7), 5)).toBe(0);
    expect(moveIndex(0, clamp(7), 5)).toBe(4);
    expect(moveIndex(3, clamp(-7), 40)).toBe(0);
    expect(moveIndex(0, wrap(1), 0)).toBe(0);
    expect(moveIndex(Number.NaN, wrap(1), 5)).toBe(1);
  });
});

describe('the four round-4 commands reach the machine (TUI-DESIGN-4 §1.3.1, §1.3.4, §7.10, §7.1)', () => {
  it('/fullscreen, /scrollback, /peers are S-ARMED with no arguments; /ui has an enum arg 0', () => {
    for (const name of ['fullscreen', 'scrollback', 'peers']) {
      const i = rowOf(`/${name}`, name);
      expect(state(`/${name}`, i), name).toBe('armed');
      expect(step(`/${name}`, 'enter', i), name).toEqual({ kind: 'run' });
      expect(step(`/${name}`, 'tab', i), name).toEqual({ kind: 'toast', text: takesNoArgumentsToast(name) });
    }
    const u = rowOf('/ui', 'ui');
    expect(step('/ui', 'tab', u)).toEqual({ kind: 'appendSpace' });
    expect(state('/ui reset', rowOf('/ui reset', 'ui'))).toBe('argdone');
    expect(state('/ui nope', rowOf('/ui nope', 'ui'))).toBe('argbad');
    expect((findCommand('ui') as CommandSpec).args[0]?.values).toEqual(['reset']);
    // 37 (round 3) → 41 (round 4) → 47 with R5-2's six §2.3/§2.7/§2.9 rows → 56 with the nine of §3.2/§3.3
    // (R5-3), §4.9 (R5-4) and §5.5 (R5-5) the integration pass landed in the one §9.2 registry PR; 56 once every round-5 slot's rows land (§9.2)
    expect(COMMANDS).toHaveLength(56);
  });
});
