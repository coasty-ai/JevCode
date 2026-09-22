/**
 * The panel and transcript commands as the App applies them locally (TUI-DESIGN-2 §4.6, §4.5, §12 "Keys and commands";
 * TUI-DESIGN-3 §4.4 F3): `/panel [d|p|t|s|off|full]` and `/transcript [compact|full]` in **every spelling** — the leading token
 * resolves through the registry (`findCommand`: case-folded names and aliases), so `/p d`, `/Panel full`, `/tr compact` all
 * parse and never bypass the App's pre-router to vanish in the host. The registry rows and `CommandAction`s are S2's
 * (`registry.ts`, `dispatch.ts`); this parser lets the App act on the lines with its toggle semantics (a second `/p d` on the
 * open decisions tab collapses, which the host cannot reproduce) and gives the plain twin one place to read. A malformed
 * argument yields null so the dispatcher's `[ui] error:` sentence answers it. Pure.
 */
import { commandName } from '../commands/parse.js';
import { PANEL_ARGS, TRANSCRIPT_VIEWS, findCommand } from '../commands/registry.js';
import type { PaneTab } from './model.js';

export type PanelCommand = { kind: 'panel'; arg: PaneTab | 'off' | 'full' | null } | { kind: 'transcript'; view: 'compact' | 'full' | null };

/** the argument tokens after the name, whitespace-separated (these two commands take one bare word at most) */
function argsOf(line: string): string[] {
  return line.trim().split(/\s+/).slice(1);
}

/** TUI-DESIGN-2 §4.6 / §4.5, TUI-DESIGN-3 F3: the parsed `/panel …` or `/transcript …` line (any case, name or alias), or null for any other line. */
export function parsePanelCommand(line: string): PanelCommand | null {
  const name = commandName(line);
  if (name === null) return null;
  const spec = findCommand(name);
  if (spec === null || (spec.name !== 'panel' && spec.name !== 'transcript')) return null;
  const args = argsOf(line);
  if (args.length > 1) return null;
  const a = args[0]?.toLowerCase();
  if (spec.name === 'panel') {
    if (a === undefined) return { kind: 'panel', arg: null };
    return (PANEL_ARGS as readonly string[]).includes(a) ? { kind: 'panel', arg: a as PaneTab | 'off' | 'full' } : null;
  }
  if (a === undefined) return { kind: 'transcript', view: null };
  return (TRANSCRIPT_VIEWS as readonly string[]).includes(a) ? { kind: 'transcript', view: a as 'compact' | 'full' } : null;
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
