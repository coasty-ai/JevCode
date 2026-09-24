/**
 * Which mini indicator a session state shows (AGENT-LOOP-DESIGN §A3 / §A5; slice S5a). The 12-row 3D block that used to
 * live here is gone with its slot: the indicator is now a status-row glyph (`frames.ts` `miniFrame`), driven by the
 * spinner's own tick, so this module only CHOOSES the shape — from the stage in the legacy modes, from what the agent is
 * doing in agent mode — and says whether any is due. Pure; no Ink, no timer.
 */
import type { StageName } from '../../core/types.js';
import type { IndicatorKind } from './frames.js';

export type { IndicatorKind } from './frames.js';

/** The stages a model or Jev is being called in (`execute` runs the command, `judge` weighs the result). */
const CALLING_STAGES: ReadonlySet<string> = new Set<StageName>(['propose', 'intent', 'risk', 'replan', 'context', 'decompose', 'coordinate']);

/** The slice of `UiState` the legacy shape is chosen from. */
export interface IndicatorInput {
  /** a submission between Enter and its reply (`intake` · `lookup` · `replying`) */
  readonly thinking: string | null;
  readonly run: 'none' | 'starting' | 'live' | 'aborting' | 'pausing';
  /** `EngineStatus.stage` (`'idle'` and `null` both mean "between stages") */
  readonly stage: StageName | 'idle' | null;
  /** a chat reply is streaming */
  readonly streaming: boolean;
}

/**
 * The legacy modes' shape for a session state, or `null` when nothing is in flight: a submission in flight is a donut;
 * a live run is a cube while the command runs (`execute`), a wave while the result is weighed (`judge` — the tests run
 * inside `execute` and are judged after), a globe while a model or Jev is called, and a donut between stages.
 */
export function indicatorKindFor(i: IndicatorInput): IndicatorKind | null {
  if (i.thinking !== null) return 'donut';
  if (i.run === 'starting') return 'donut';
  if (i.run === 'live' || i.run === 'aborting' || i.run === 'pausing') {
    if (i.stage === 'execute') return 'cube';
    if (i.stage === 'judge') return 'wave';
    if (i.stage !== null && CALLING_STAGES.has(i.stage)) return 'globe';
    return 'donut';
  }
  return i.streaming ? 'donut' : null;
}

/** AGENT-LOOP-DESIGN §A5 / peer C: what an agent run is doing now — the status word and the shape. */
export type AgentActivity = 'thinking' | 'reading' | 'editing' | 'running' | 'testing';

/** The shape of an agent activity: a model turn → donut, read-only observing → globe, an edit / write / command → cube, the harness's test run → wave. */
export function agentIndicatorKind(a: AgentActivity): IndicatorKind {
  switch (a) {
    case 'thinking':
      return 'donut';
    case 'reading':
      return 'globe';
    case 'editing':
    case 'running':
      return 'cube';
    case 'testing':
      return 'wave';
  }
}
