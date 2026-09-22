/**
 * TUI-DESIGN-3 §4.4 F3 `pane/commands.ts`: `parsePanelCommand` resolves aliases and case through the registry (`/p d`, `/Panel full`,
 * `/tr compact`, `/TR`), keeps the App's toggle semantics (`nextPanel`), and yields null for any other line or a malformed argument so
 * the dispatcher's `[ui] error:` sentence answers it.
 */
import { describe, expect, it } from 'vitest';
import { nextPanel, parsePanelCommand } from '../../../../src/tui/pane/commands.js';

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
