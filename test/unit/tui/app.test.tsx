import { EventEmitter } from 'node:events';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { App, RULE_CHAR, createTuiRenderer } from '../../../src/tui/App.js';
import { LIVE_FLUSH_MS, createEventBus, createTuiConfirmer } from '../../../src/tui/useEngine.js';
import { CONFIRM_KEYS_LINE, IDENTITY_NO_TTY, formatTranscriptItem, itemsFromEvent, plainFirstLine } from '../../../src/tui/plain.js';
import { fakeEngine, loadRunEvents, mkConfirmRequest, mkDecision, mkProposal, mkStatus, tick } from '../../fixtures/tui/fixtures.js';

afterEach(() => cleanup());

function mount(onAbort: (r: 'human_abort') => void = () => undefined) {
  const bus = createEventBus();
  const confirmer = createTuiConfirmer();
  const ui = render(<App task="Fix the failing test" resumeId={null} source={bus} confirmer={confirmer} onAbort={onAbort} />);
  return { ...ui, bus, confirmer };
}

/** Dynamic region = everything after the last rule line (the <Static> scrollback sits above it). */
function dynamicLines(frame: string): string[] {
  const lines = frame.split('\n');
  const idx = lines.map((l) => /^─+$/.test(l.trim())).lastIndexOf(true);
  return lines.slice(idx);
}

describe('<App>', () => {
  it('renders the status sentinel `step 0/` in the very first frame, before any engine is attached', () => {
    const { lastFrame, frames } = mount();
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames[0]).toContain('step 0/–');
    // the task is visible from the first frame, as the same header line the plain renderer prints
    expect(frames[0]).toContain('Fix the failing test');
    expect(frames[0]).toContain(plainFirstLine('Fix the failing test', null));
    expect(lastFrame()).toContain('starting');
    expect(lastFrame()).toContain(RULE_CHAR.repeat(10));
  });

  it('resume mode: the first frame names the run being resumed', () => {
    const bus = createEventBus();
    const { frames } = render(<App task="resuming 20260919-120000-ab12" resumeId="20260919-120000-ab12" source={bus} confirmer={createTuiConfirmer()} onAbort={() => undefined} />);
    expect(frames[0]).toContain('[run] jevcode resuming 20260919-120000-ab12 | step 0/– starting');
  });

  it('exec:output feeds the live region through the same coalescer with escape sequences stripped', async () => {
    const { lastFrame, bus } = mount();
    bus.emit({ type: 'exec:start', step: 2, action: { kind: 'run', command: 'pytest -q' } });
    bus.emit({ type: 'exec:output', step: 2, stream: 'stdout', chunk: 'collected 3 items\n' });
    bus.emit({ type: 'exec:output', step: 2, stream: 'stderr', chunk: '\u001b[2J\u001b[31mFAILED\u001b[0m tests/test_a.py\n' });
    await tick(LIVE_FLUSH_MS * 2);
    const f = lastFrame() ?? '';
    expect(f).toContain('collected 3 items');
    expect(f).toContain('[2J[31mFAILED[0m tests/test_a.py');
    expect(f).not.toContain('\u001b');
    bus.emit({ type: 'outcome', step: 2, outcome: { status: 'executed', summary: 'ran pytest', changedFiles: [] } });
    await tick(LIVE_FLUSH_MS * 2);
    expect(dynamicLines(lastFrame() ?? '').join('\n')).not.toContain('collected 3 items');
  });

  it('decisions pane shows review and block rows with verdict markers and the derived label', async () => {
    const { lastFrame, bus } = mount();
    const fe = fakeEngine();
    fe.engine.events.onAny((e) => bus.emit(e));
    fe.emit({ type: 'decision', decision: mkDecision({ id: 'destructive', verdict: 'review' }) });
    fe.emit({ type: 'decision', decision: mkDecision({ id: 'irreversible', verdict: 'block', probability: 0.9 }) });
    fe.emit({ type: 'decision', decision: mkDecision({ id: 'out_of_scope', verdict: 'ok' }) });
    fe.emit({ type: 'decision', decision: mkDecision({ stage: 'intent', id: 'intent', verdict: 'overridden', question: { type: 'choice', instructions: 'x', criteria: { edit: 'a', none_of_these: null } }, answer: { type: 'choice', choice: 'edit', probabilities: { edit: 0.6, none_of_these: 0.4 }, confidence: 0.2 } }) });
    fe.emit({ type: 'decision', decision: mkDecision({ stage: 'judge', id: 'succeeded', question: { type: 'noul', instructions: 'x', criteria: { true: 't', false: 'f' } }, answer: { type: 'noul', noul: 0.92 }, probability: 0.92, confidence: 0.84 }) });
    fe.emit({ type: 'status', status: mkStatus(3, 'judge') });
    await tick();
    const f = lastFrame() ?? '';
    expect(f).toContain('s3 risk destructive score=1 p=0.80 c=0.83 [review]');
    expect(f).toContain('s3 risk irreversible score=1 p=0.90 c=0.83 [block]');
    expect(f).toContain('out_of_scope score=1 p=0.80 c=0.83 [ok]');
    expect(f).toContain('choice=edit p=0.80 c=0.83 [overridden]');
    expect(f).toContain('succeeded noul=0.92 p=0.92 c=0.84 derived');
    expect(f).toContain('step 3/40');
    expect(f).toContain('judge');
  });

  it('shows the confirmation box on confirm:request; y resolves true, n resolves false', async () => {
    const { lastFrame, stdin, bus, confirmer } = mount();
    const signal = new AbortController().signal;
    const req = mkConfirmRequest('c1', 3);
    bus.emit({ type: 'confirm:request', request: req });
    const p = confirmer.confirm(req, { signal });
    await tick();
    const f = lastFrame() ?? '';
    // wave 2: confirmHeaderLines delegates to the §6.1 review header (8 rows, keys on row 2)
    expect(f).toContain('review  step 3  risk 0.50 (exp)  edit src/a.py "fix the off-by-one"');
    expect(f).toContain('1 destructive    L2');
    expect(f).toContain('4 irreversible   L1');
    expect(f).toContain('0.50 exp  0.70');
    expect(f).toContain(CONFIRM_KEYS_LINE);
    expect(f).toContain('--- old');
    stdin.write('y');
    await expect(p).resolves.toBe(true);
    await tick();
    expect(lastFrame()).not.toContain(CONFIRM_KEYS_LINE);

    const req2 = mkConfirmRequest('c2', 4);
    const p2 = confirmer.confirm(req2, { signal });
    await tick();
    expect(lastFrame()).toContain('review  step 4');
    stdin.write('n');
    await expect(p2).resolves.toBe(false);
  });

  it('y/n are ignored while no confirmation is pending', async () => {
    const { stdin, confirmer } = mount();
    stdin.write('y');
    await tick();
    expect(confirmer.pending()).toBeNull();
  });

  it('Ctrl-C (\\x03) calls onAbort("human_abort") and does not exit Ink', async () => {
    const aborts: string[] = [];
    const { stdin, lastFrame } = mount((r) => aborts.push(r));
    stdin.write('\x03');
    await tick();
    expect(aborts).toEqual(['human_abort']);
    expect(lastFrame()).toContain('step 0/');
  });

  it('streams deltas into the live region (coalesced) and commits exactly one proposal item that clears the live region', async () => {
    const { lastFrame, frames, bus } = mount();
    bus.emit({ type: 'generator:start', step: 1, attempt: 1 });
    const framesBefore = frames.length;
    for (let i = 0; i < 40; i++) bus.emit({ type: 'generator:delta', step: 1, text: `{"chunk":${i}}` });
    await tick(LIVE_FLUSH_MS * 2);
    // 40 deltas, at most a couple of live flushes (≤ 20 fps), never one frame per delta
    expect(frames.length - framesBefore).toBeLessThan(10);
    expect(lastFrame()).toMatch(/streaming… \d+ chars/);
    bus.emit({ type: 'generator:delta', step: 1, text: '\nline A\nline B\nline C' });
    await tick(LIVE_FLUSH_MS * 2);
    expect(lastFrame()).toContain('line B');
    expect(lastFrame()).toContain('line C');
    expect(lastFrame()).not.toContain('line A');

    const proposal = mkProposal();
    bus.emit({ type: 'proposal', step: 1, proposal });
    await tick(LIVE_FLUSH_MS * 2);
    const f = lastFrame() ?? '';
    const line = formatTranscriptItem(itemsFromEvent({ type: 'proposal', step: 1, proposal }, 0)[0]!);
    expect(f.split(line).length - 1).toBe(1);
    expect(f).not.toContain('line C');
    expect(f).not.toContain('streaming…');
    expect(dynamicLines(f).join('\n')).not.toContain('proposal edit');
  });

  it('shows `streaming action… N chars` while tool arguments stream into an empty live region, gone at proposal', async () => {
    const { lastFrame, frames, bus } = mount();
    bus.emit({ type: 'generator:start', step: 1, attempt: 1 });
    const framesBefore = frames.length;
    for (let chars = 1; chars <= 60; chars++) bus.emit({ type: 'generator:tool-delta', step: 1, chars: chars * 2 });
    await tick(LIVE_FLUSH_MS * 2);
    expect(frames.length - framesBefore).toBeLessThan(10); // coalesced like text deltas
    expect(lastFrame()).toContain('streaming action… 120 chars');
    bus.emit({ type: 'proposal', step: 1, proposal: mkProposal() });
    await tick(LIVE_FLUSH_MS * 2);
    expect(lastFrame()).not.toContain('streaming action…');
  });

  it('renders the whole scripted run: transcript rows match formatTranscriptItem line for line, status from the last status event', async () => {
    const { lastFrame, bus } = mount();
    const events = loadRunEvents();
    for (const e of events) bus.emit(e);
    await tick(LIVE_FLUSH_MS * 2);
    const f = lastFrame() ?? '';
    let seq = 0;
    for (const e of events) {
      for (const item of itemsFromEvent(e, seq)) {
        expect(f).toContain(formatTranscriptItem(item));
        seq += 1;
      }
    }
    expect(f).toContain('done max_steps');
    expect(f).toContain('step 1/40');
    expect(f).toContain('s1 intent intent choice=investigate p=0.82 c=0.73 [chosen]');
    expect(f).toContain('can_investigate noul=0.91 p=0.91 c=0.82 derived');
  });

  it('mounts without throwing when stdin has no isTTY (piped) and still renders the sentinel', async () => {
    class Out extends EventEmitter {
      frames: string[] = [];
      columns = 80;
      rows = 24;
      write = (s: string): boolean => {
        this.frames.push(s);
        return true;
      };
    }
    class In extends EventEmitter {
      isTTY: boolean | undefined = undefined;
      setEncoding(): void {}
      resume(): void {}
      pause(): void {}
      ref(): void {}
      unref(): void {}
      read(): null {
        return null;
      }
    }
    const out = new Out();
    const stdin = new In();
    const r = createTuiRenderer({
      task: 'piped task',
      resumeId: null,
      onAbort: () => undefined,
      stdout: out as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      confirmTimeoutMs: 5,
    });
    await r.firstFrame();
    expect(r.confirmer.identity).toBe(IDENTITY_NO_TTY);
    const fe = fakeEngine();
    r.attach(fe.engine);
    fe.emit({ type: 'run:ready', runId: 'r1', step: 0, maxSteps: 40, task: 'piped task', resumed: false });
    // no reviewer can press y/n on a pipe: the box renders, then the confirmer declines
    await expect(r.confirmer.confirm(mkConfirmRequest('c1', 1), { signal: new AbortController().signal })).resolves.toBe(false);
    await r.unmount();
    const all = out.frames.join('');
    expect(all).toContain('step 0/');
    expect(all).toContain('[run] ready r1 step 0/40');
    expect(all).toContain(plainFirstLine('piped task', null));
  });
});
