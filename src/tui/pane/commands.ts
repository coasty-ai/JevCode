/**
 * The panel and transcript commands as the App applies them locally (TUI-DESIGN-2 §4.6, §4.5, §12 "Keys and commands"):
 * `/panel [d|p|t|s|off|full]` and `/transcript [compact|full]`. The registry rows and `CommandAction`s are S2's
 * (`registry.ts`, `dispatch.ts`); this parser lets the App act on the lines whether or not the registry knows them yet
 * and gives the plain twin one place to read. Pure.
 */
import type { PaneTab } from './model.js';

export type PanelCommand = { kind: 'panel'; arg: PaneTab | 'off' | 'full' | null } | { kind: 'transcript'; view: 'compact' | 'full' | null };

const PANEL_RE = /^\/panel(?:\s+(d|p|t|s|off|full))?\s*$/;
const TRANSCRIPT_RE = /^\/transcript(?:\s+(compact|full))?\s*$/;

/** TUI-DESIGN-2 §4.6 / §4.5: the parsed `/panel …` or `/transcript …` line, or null for any other line. */
export function parsePanelCommand(line: string): PanelCommand | null {
  const t = line.trim();
  const p = PANEL_RE.exec(t);
  if (p !== null) {
    const a = p[1];
    return { kind: 'panel', arg: a === undefined ? null : (a as PaneTab | 'off' | 'full') };
  }
  const tr = TRANSCRIPT_RE.exec(t);
  if (tr !== null) {
    const v = tr[1];
    return { kind: 'transcript', view: v === undefined ? null : (v as 'compact' | 'full') };
  }
  return null;
}

/**
 * TUI-DESIGN-2 §4.6: the next panel state and tab for a `/panel` argument (or Alt+D/P/T/S): `off` collapses, `full` opens
 * the 12-row form, a tab opens it (a second request for the tab already shown collapses), no argument toggles open ↔ collapsed.
 */
export function nextPanel(current: { panel: 'collapsed' | 'open' | 'full'; tab: PaneTab }, arg: PaneTab | 'off' | 'full' | null): { panel: 'collapsed' | 'open' | 'full'; tab: PaneTab } {
  if (arg === 'off') return { panel: 'collapsed', tab: current.tab };
  if (arg === 'full') return { panel: 'full', tab: current.tab };
  if (arg === null) return { panel: current.panel === 'collapsed' ? 'open' : 'collapsed', tab: current.tab };
  if (current.panel !== 'collapsed' && current.tab === arg) return { panel: 'collapsed', tab: arg };
  return { panel: current.panel === 'collapsed' ? 'open' : current.panel, tab: arg };
}
