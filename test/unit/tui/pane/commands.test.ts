/**
 * TUI-DESIGN-3 §4.4 F3 `pane/commands.ts`: `parsePanelCommand` resolves aliases and case through the registry (`/p d`, `/Panel full`,
 * `/tr compact`, `/TR`), keeps the App's toggle semantics (`nextPanel`), and yields null for any other line or a malformed argument so
 * the dispatcher's `[ui] error:` sentence answers it.
 */
import { describe, expect, it } from 'vitest';
import { nextPanel, parsePanelCommand, type PanelCommand } from '../../../../src/tui/pane/commands.js';
import { PANEL_ARGS, findCommand } from '../../../../src/tui/commands/registry.js';

describe('parsePanelCommand (TUI-DESIGN-2 §4.6 / §4.5; TUI-DESIGN-3 F3)', () => {
  it('every spelling of /panel and /transcript parses: names, aliases, any case, surrounding whitespace', () => {
    expect(parsePanelCommand('/panel')).toEqual({ kind: 'panel', arg: null });
    expect(parsePanelCommand('/panel d')).toEqual({ kind: 'panel', arg: 'd' });
    expect(parsePanelCommand('/p d')).toEqual({ kind: 'panel', arg: 'd' });
    expect(parsePanelCommand('/P D')).toEqual({ kind: 'panel', arg: 'd' });
    expect(parsePanelCommand('/Panel full')).toEqual({ kind: 'panel', arg: 'full' });
    expect(parsePanelCommand('/PANEL off')).toEqual({ kind: 'panel', arg: 'off' });
    expect(parsePanelCommand('  /p   s  ')).toEqual({ kind: 'panel', arg: 's' });
    expect(parsePanelCommand('/transcript')).toEqual({ kind: 'transcript', view: null });
    expect(parsePanelCommand('/tr compact')).toEqual({ kind: 'transcript', view: 'compact' });
    expect(parsePanelCommand('/TR Full')).toEqual({ kind: 'transcript', view: 'full' });
    expect(parsePanelCommand('/Transcript')).toEqual({ kind: 'transcript', view: null });
  });
  it('any other line is null — other commands, aliases of other commands, text, a malformed or extra argument (the dispatcher answers those)', () => {
    expect(parsePanelCommand('/plan')).toBeNull();
    expect(parsePanelCommand('/pl')).toBeNull();
    expect(parsePanelCommand('/pause')).toBeNull();
    expect(parsePanelCommand('/t')).toBeNull(); // /theme, not /transcript
    expect(parsePanelCommand('/trust')).toBeNull();
    expect(parsePanelCommand('/panel x')).toBeNull();
    expect(parsePanelCommand('/panel d p')).toBeNull();
    expect(parsePanelCommand('/transcript all')).toBeNull();
    expect(parsePanelCommand('/paneld')).toBeNull();
    expect(parsePanelCommand('panel d')).toBeNull();
    expect(parsePanelCommand('//panel')).toBeNull();
    expect(parsePanelCommand('')).toBeNull();
    expect(parsePanelCommand('open the panel')).toBeNull();
  });

  it('TUI-DESIGN-5 §4.3 / §4.9: `/agents` is REACHABLE now the registry row has landed, and still takes no argument', () => {
    /**
     * This case was written failing-first: while R5-4's §9.2 request on R5-2's one `registry.ts` PR was open,
     * `findCommand('agents')` was null and `/agents` fell through to the host dispatcher's `not a command` —
     * the D-AN behaviour, never a silent nothing. The integration pass landed the row, so this is the flip.
     * `/agents` now parses HERE, in the App's own pre-router, because it opens **and focuses** the tab and
     * focus (`UiState.paneFocus`) is something no host command can reproduce.
     */
    expect(findCommand('agents')?.name).toBe('agents');
    expect(parsePanelCommand('/agents')).toEqual({ kind: 'agents' });
    // it takes NO argument, in either world: `/agents foo` is null and the dispatcher answers it
    expect(parsePanelCommand('/agents foo')).toBeNull();
    // `/agent <slug> <verb>` is a DIFFERENT command and never reaches this pre-router
    expect(parsePanelCommand('/agent api pause')).toBeNull();
  });

  it("the `{ kind: 'agents' }` arm is the App's pre-router shape, and takes no argument (§4.3: it opens AND focuses)", () => {
    // the arm cannot be reached through `findCommand` yet, so the shape is asserted where it is consumed:
    // `PanelCommand` has it, the App switches on it (`round5-agents-app.test.tsx` drives Alt+A and `/agents`)
    const agents: PanelCommand = { kind: 'agents' };
    expect(agents.kind).toBe('agents');
    // `nextPanel` widens for free the day `PANEL_ARGS` gains `'a'` — its parameter is already `PaneTab | …`
    expect(nextPanel({ panel: 'collapsed', tab: 'd' }, 'a')).toEqual({ panel: 'open', tab: 'a' });
    expect(nextPanel({ panel: 'open', tab: 'a' }, 'a')).toEqual({ panel: 'collapsed', tab: 'a' });
    // R5-4's OTHER `registry.ts` request — `PANEL_ARGS += 'a'` — HAS landed on this tree, so `/panel a` already
    // parses through the ordinary `panel` arm and opens the tab (without focusing it; only `/agents` focuses)
    expect((PANEL_ARGS as readonly string[]).includes('a')).toBe(true);
    expect(parsePanelCommand('/panel a')).toEqual({ kind: 'panel', arg: 'a' });
    expect(parsePanelCommand('/p a')).toEqual({ kind: 'panel', arg: 'a' });
  });
  it('nextPanel keeps the App-local toggle semantics: off collapses, full expands, a tab opens (the same tab again collapses), no argument toggles', () => {
    expect(nextPanel({ panel: 'collapsed', tab: 'd' }, 'd')).toEqual({ panel: 'open', tab: 'd' });
    expect(nextPanel({ panel: 'open', tab: 'd' }, 'd')).toEqual({ panel: 'collapsed', tab: 'd' });
    expect(nextPanel({ panel: 'open', tab: 'd' }, 'p')).toEqual({ panel: 'open', tab: 'p' });
    expect(nextPanel({ panel: 'full', tab: 'd' }, 'p')).toEqual({ panel: 'full', tab: 'p' });
    expect(nextPanel({ panel: 'collapsed', tab: 't' }, 'full')).toEqual({ panel: 'full', tab: 't' });
    expect(nextPanel({ panel: 'full', tab: 't' }, 'off')).toEqual({ panel: 'collapsed', tab: 't' });
    expect(nextPanel({ panel: 'collapsed', tab: 's' }, null)).toEqual({ panel: 'open', tab: 's' });
    expect(nextPanel({ panel: 'open', tab: 's' }, null)).toEqual({ panel: 'collapsed', tab: 's' });
    // `/p d` twice: open on decisions, then collapsed (the F3 App test drives the same through the mounted App)
    const once = nextPanel({ panel: 'collapsed', tab: 'p' }, (parsePanelCommand('/p d') as { arg: 'd' }).arg);
    expect(once).toEqual({ panel: 'open', tab: 'd' });
    expect(nextPanel(once, 'd')).toEqual({ panel: 'collapsed', tab: 'd' });
  });
});
