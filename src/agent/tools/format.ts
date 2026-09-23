/**
 * Tool-result rendering (docs/AGENT-LOOP-DESIGN.md §4.3, §7.2): the status line the model relies on, the inline caps with
 * a head + tail clip, the spill pointer to the whole output under `outputs/`, and the one-line summaries the
 * `tool:call` / `tool:result` events and the step records carry.
 */
import type { ExecResult, TestCounts } from '../../core/types.js';
import {
  AGENT_BASH_FAIL_HEAD,
  AGENT_BASH_FAIL_INLINE,
  AGENT_BASH_FAIL_TAIL,
  AGENT_BASH_OK_HEAD,
  AGENT_BASH_OK_INLINE,
  AGENT_BASH_OK_TAIL,
  MAX_COMMAND_TIMEOUT_MS,
} from '../limits.js';

/** `head + [… n chars omitted …] + tail` when `text` exceeds `inline`; the whole text otherwise. */
export function clipMiddle(text: string, inline: number, head: number, tail: number): { text: string; clipped: boolean } {
  if (text.length <= inline) return { text, clipped: false };
  const omitted = text.length - head - tail;
  return { text: `${text.slice(0, head)}\n[… ${omitted} chars omitted …]\n${text.slice(text.length - tail)}`, clipped: true };
}

/** The pointer line of a spilled output (§7.2). */
export function spillPointer(pointer: string, bytes: number): string {
  return `full output: ${pointer} (${bytes} bytes) — read_file it with offset/limit or grep it`;
}

/** `1.2s` under ten seconds, `42s` above. */
export function seconds(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${Math.round(s * 10) / 10}s` : `${Math.round(s)}s`;
}

function testsSegment(t: TestCounts | null): string {
  return t === null ? '' : ` · tests: ${t.passed} passed, ${t.failed} failed, ${t.errors} errors`;
}

const KILL_WHY: Readonly<Record<string, string>> = { wall_time: "the run's wall-time budget ran out", abort: 'the run was interrupted' };

/** The first line of a `bash` result (§4.3). */
export function bashStatusLine(exec: ExecResult, workdir: string | null, tests: TestCounts | null): string {
  if (exec.killedBy === 'timeout') return `timed out after ${seconds(exec.durationMs)} (raise timeout_ms up to ${MAX_COMMAND_TIMEOUT_MS} or run a narrower command)`;
  if (exec.killedBy !== null) return `killed (${KILL_WHY[exec.killedBy] ?? exec.killedBy})`;
  return `exit ${exec.exitCode ?? 'null'} · ${seconds(exec.durationMs)}${workdir !== null ? ` · in ${workdir}` : ''}${testsSegment(tests)}`;
}

export interface BashRender {
  text: string;
  ok: boolean;
  /** the status line alone (the verify note and the summaries reuse it) */
  status: string;
  /** the whole output, for the loop signature */
  output: string;
}

/**
 * Render a finished command: status line, then the output within its inline cap. A longer output is written whole
 * through `spill` (→ `jevcode:outputs/step-N[-k].txt`) and clipped to head + tail — a failure keeps more tail, because
 * errors are usually at the end.
 */
export async function renderBash(
  exec: ExecResult,
  output: string,
  o: { workdir: string | null; tests: TestCounts | null; interrupted?: boolean; spill: (text: string) => Promise<string | null> },
): Promise<BashRender> {
  const ok = exec.ok && o.interrupted !== true;
  const status = o.interrupted === true ? 'interrupted' : bashStatusLine(exec, o.workdir, o.tests);
  const [inline, head, tail] = ok ? [AGENT_BASH_OK_INLINE, AGENT_BASH_OK_HEAD, AGENT_BASH_OK_TAIL] : [AGENT_BASH_FAIL_INLINE, AGENT_BASH_FAIL_HEAD, AGENT_BASH_FAIL_TAIL];
  const clipped = clipMiddle(output, inline, head, tail);
  const lines = [status, clipped.text.length === 0 ? '(no output)' : clipped.text];
  if (clipped.clipped) {
    const pointer = await o.spill(output);
    lines.push(pointer !== null ? spillPointer(pointer, Buffer.byteLength(output, 'utf8')) : '(the full output could not be saved)');
  }
  if (exec.truncated) lines.push('[output capped by the sandbox; the middle of the stream was dropped]');
  return { text: lines.join('\n'), ok, status, output };
}

/** One redacted-by-the-caller line, whitespace collapsed and clipped: the shape of every summary. */
export function oneLine(s: string, max = 100): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Numbered lines as `read_file` prints them (`%6d\t<line>`). */
export function numberLines(lines: readonly string[], first: number, lineMax: number): string {
  return lines.map((l, i) => `${String(first + i).padStart(6)}\t${l.length > lineMax ? `${l.slice(0, lineMax)}… [line clipped]` : l}`).join('\n');
}
