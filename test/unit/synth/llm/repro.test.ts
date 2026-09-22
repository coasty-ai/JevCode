import { describe, expect, it } from 'vitest';

import type { Answer, GenerateRequest, Question, ToolCall } from '../../../../src/core/types.js';
import { ESCAPE_KEY } from '../../../../src/jev/questions.js';
import { LLM_REPRODUCTION_CRITERIA, Q18, isLlmOracle, issueQuoteAnchored, q18Questions, readQ18, scriptProblems, statusDelta, writeReproduction, type Q18Script, type ReproLane, type ReproScratch, type ReproWriterInput } from '../../../../src/synth/llm/repro.js';
import { WRITE_REPRODUCTION_TOOL_NAME } from '../../../../src/synth/llm/schema.js';
import { LLM_DEFAULT_GENERATION, UNFINISHED_REASONING_ALLOWANCE_TOKENS } from '../../../../src/synth/llm/source.js';
import { extractBlocks } from '../../../../src/synth/oracle/extract.js';
import { REPRODUCTION_CRITERIA } from '../../../../src/synth/oracle/questions.js';
import { REPRO_SENTINEL } from '../../../../src/synth/oracle/runner.js';
import type { VerifyRunFn, VerifyRunOptions } from '../../../../src/synth/verify/types.js';
import { choiceAnswer, noulAnswer } from '../search/helpers.js';
import { scriptedGenerate } from './fixtures.js';

const ISSUE = ['`simplify(cos(x)**I)` raises TypeError: Invalid comparison of complex I.', '', 'It should simplify without raising an error for complex exponents.', '', '```python', 'from sympy import *', 'x = Symbol("x")', 'print(simplify(cos(x)**I))', '```'].join('\n');
const QUOTE = 'raises TypeError: Invalid comparison of complex I';

const SCRIPTS = [
  'from sympy import Symbol, cos, I, simplify\nx = Symbol("x")\nsimplify(cos(x)**I)  # marker-a',
  'from sympy import Symbol\nassert Symbol("x") == 1  # marker-b',
  'from sympy import Symbol\nx = Symbol("x")\nassert x == x  # marker-c',
];

function call(script: string, quote: string): ToolCall {
  const input = { script, expected_behaviour: 'simplify completes for a complex exponent', issue_quote: quote, failure_kind: 'exception_raised' };
  return { name: WRITE_REPRODUCTION_TOOL_NAME, input, rawJson: JSON.stringify(input) };
}

interface RunSpec {
  raise?: string;
  pass?: boolean;
}

/** A sentinel-harness stdout: one statement that raised `raise`, or completed. */
function output(spec: RunSpec): string {
  const results = [{ chunk: 0, stmt: 2, source: 'simplify(cos(x)**I)', kind: 'expr', value: spec.pass ? "'cos(x)**I'" : null, type_name: spec.pass ? 'str' : null, stdout: '', exception: spec.raise ? { type: spec.raise, message: 'Invalid comparison of complex I', frames: [] } : null, fixup: null, environment: false, ms: 3 }];
  return `${REPRO_SENTINEL}${JSON.stringify({ ok: true, python: '3.12.0', results })}\n`;
}

interface FakeRun {
  run: VerifyRunFn;
  /** python runs so far */
  calls: () => number;
  /** every command with its cwd, in order */
  commands: () => { command: string; cwd: string | undefined }[];
  /** the most python runs in flight at once */
  maxInFlight: () => number;
}

interface FakeRunOptions {
  /** ms a python run takes */
  latencyMs?: number;
  /** stdout of `git status --porcelain` in a lane, by call index (default clean) */
  laneStatus?: (call: number) => string;
  /** exit code of `git worktree add` (default 0) */
  worktreeAddExit?: number;
}

/**
 * A VerifyRunFn standing for the sandbox: answers the scratch's git commands (a worktree add reports `/scratch/lane<k>`),
 * and recognises each script by its marker to answer the sentinel harness per run index.
 */
function fakeRun(plan: Record<string, RunSpec[]>, o: FakeRunOptions = {}): FakeRun {
  const seen: Record<string, number> = {};
  const commands: { command: string; cwd: string | undefined }[] = [];
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let statusCalls = 0;
  const run: VerifyRunFn = async (command: string, opts: VerifyRunOptions) => {
    commands.push({ command, cwd: opts.cwd });
    if (command.includes('worktree add')) {
      const k = /lane(\d+)/.exec(command)?.[1] ?? '0';
      return { stdout: `/scratch/lane${k}\n/scratch/lane${k}.dirty.patch\n`, stderr: '', exitCode: o.worktreeAddExit ?? 0 };
    }
    if (command.includes('status --porcelain')) return { stdout: o.laneStatus?.(statusCalls++) ?? '', stderr: '', exitCode: 0 };
    if (command.includes('checkout -q') || command.includes('worktree remove')) return { stdout: '', stderr: '', exitCode: 0 };
    calls += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (o.latencyMs !== undefined) await new Promise((r) => setTimeout(r, o.latencyMs));
    inFlight -= 1;
    const b64 = /b64decode\(\W*([A-Za-z0-9+/=]{20,})/.exec(command)?.[1] ?? '';
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    const marker = /marker-([a-z])/.exec(decoded)?.[1] ?? '?';
    const k = seen[marker] ?? 0;
    seen[marker] = k + 1;
    const spec = plan[marker]?.[k] ?? plan[marker]?.at(-1) ?? { pass: true };
    return { stdout: output(spec), stderr: '', exitCode: spec.raise ? 1 : 0 };
  };
  return { run, calls: () => calls, commands: () => commands, maxInFlight: () => maxInFlight };
}

/** An in-memory scratch: `lanes` roots handed out FIFO; `changesFor(root, runIndex)` says what a run wrote. */
function fakeScratch(lanes: number, changesFor: (call: number) => string[] | null = () => []): ReproScratch & { runs: () => number; disposed: () => boolean; roots: () => string[] } {
  const free = Array.from({ length: lanes }, (_, k) => `/lane${k}`);
  const waiters: ((root: string) => void)[] = [];
  const roots: string[] = [];
  let runs = 0;
  let disposed = false;
  const acquire = (): Promise<string> => {
    const r = free.shift();
    return r !== undefined ? Promise.resolve(r) : new Promise((resolve) => waiters.push(resolve));
  };
  const release = (root: string): void => {
    const w = waiters.shift();
    if (w !== undefined) w(root);
    else free.push(root);
  };
  return {
    lanes,
    async withLane<T>(fn: (lane: ReproLane) => Promise<T>): Promise<T> {
      const root = await acquire();
      const call = runs++;
      roots.push(root);
      try {
        return await fn({ root, changes: async () => changesFor(call) });
      } finally {
        release(root);
      }
    },
    dispose: async () => {
      disposed = true;
    },
    runs: () => runs,
    disposed: () => disposed,
    roots: () => roots,
  };
}

function writerInput(over: Partial<ReproWriterInput>): ReproWriterInput {
  return {
    task: ISSUE,
    repository: 'sympy',
    packageName: 'sympy',
    framework: null,
    extraction: extractBlocks(ISSUE),
    workspace: '/work',
    run: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
    python: '/work/.venv/bin/python',
    generate: scriptedGenerate(() => ({ text: 'x' })).generate,
    ask: async () => ({ answers: {} }),
    signal: new AbortController().signal,
    deadlineMs: 2000,
    ...over,
  };
}

/** Answers every Q18 question: the Choice by `choice` weights (when asked), the failure kind, every Noul at `noulP`. */
function q18Ask(choiceWeights: Record<string, number>, noulP: number | ((id: string) => number)): (stage: string, state: unknown, questions: Record<string, Question>) => Promise<{ answers: Record<string, Answer> }> {
  return async (_stage, _state, questions) => {
    const out: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (id === Q18.choiceId) out[id] = choiceAnswer(q, choiceWeights);
      else if (id === Q18.failureKindId) out[id] = choiceAnswer(q, { exception_raised: 0.9 });
      else out[id] = noulAnswer(typeof noulP === 'number' ? noulP : noulP(id));
    }
    return { answers: out };
  };
}

/** A Choice answer with the given probabilities (its `choice` is the argmax). */
function chosen(probabilities: Record<string, number>): Answer {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  return { type: 'choice', choice, probabilities, confidence: 1 };
}

function q18Script(key: string, lines: number): Q18Script {
  return { key, source: Array.from({ length: lines }, (_, i) => `x${i} = ${i}`).join('\n'), issueQuote: QUOTE, baseRun: { exceptionType: 'TypeError', message: 'Invalid comparison', lastStatement: 'simplify(cos(x)**I)' }, lines };
}

describe('L2 reproduction writer: code checks', () => {
  it('anchors issue quotes in the issue text', () => {
    expect(issueQuoteAnchored(ISSUE, QUOTE)).toBe(true);
    expect(issueQuoteAnchored(ISSUE, 'It should simplify   without raising an error')).toBe(true);
    expect(issueQuoteAnchored(ISSUE, 'the function should return a simplified expression')).toBe(false);
    expect(issueQuoteAnchored(ISSUE, 'complex I')).toBe(false);
  });

  it('refuses scripts that exit, read stdin, spawn processes, reach the network or write files — and accepts the read-only ones', () => {
    expect(scriptProblems('import sys\nsys.exit(1)')).toMatch(/sys\.exit/);
    expect(scriptProblems(Array.from({ length: 61 }, () => 'x = 1').join('\n'))).toMatch(/61 lines/);
    expect(scriptProblems('name = input()')).toBe('reads stdin');
    expect(scriptProblems('import subprocess\nsubprocess.run(["ls"])')).toBe('spawns a process');
    expect(scriptProblems('import os\nos.system("ls")')).toBe('spawns a process');
    expect(scriptProblems('import requests\nrequests.get("http://x")')).toBe('imports a network module');
    expect(scriptProblems('from urllib.request import urlopen')).toBe('imports a network module');
    expect(scriptProblems('import socket')).toBe('imports a network module');
    expect(scriptProblems('from http.client import HTTPConnection')).toBe('imports a network module');
    // file writes: write-mode open (positional, keyword, Path.open), os writers, shutil, pathlib writers
    expect(scriptProblems("open('settings_repro.py', 'w').write('x')")).toBe('opens a file for writing');
    expect(scriptProblems('with open(p, mode="a") as f:\n    f.write("x")')).toBe('opens a file for writing');
    expect(scriptProblems("Path('x').open('wb')")).toBe('opens a file for writing');
    expect(scriptProblems("open('data.txt', 'r+')")).toBe('opens a file for writing');
    expect(scriptProblems("import os\nos.remove('app/models.py')")).toMatch(/through `os`/);
    expect(scriptProblems("import os\nos.makedirs('pkg/new', exist_ok=True)")).toMatch(/through `os`/);
    expect(scriptProblems("import os\nos.rename('a', 'b')")).toMatch(/through `os`/);
    expect(scriptProblems("import shutil\nshutil.copy('a', 'b')")).toMatch(/shutil/);
    expect(scriptProblems("from pathlib import Path\nPath('app/models.py').write_text('VALUE = 2')")).toBe('writes files through pathlib');
    expect(scriptProblems("Path('d').mkdir()")).toBe('writes files through pathlib');
    expect(scriptProblems("Path('f').unlink()")).toBe('writes files through pathlib');
    // read-only scripts stay: a read-mode open, a file name with a `w`, urllib.parse, str.replace, a plain assert
    expect(scriptProblems("open('wax.txt').read()")).toBeNull();
    expect(scriptProblems("open('notes.txt', 'r')")).toBeNull();
    expect(scriptProblems('from urllib.parse import urlparse\nurlparse("http://x")')).toBeNull();
    expect(scriptProblems('s = "a b".replace(" ", "_")\nassert s == "a_b"')).toBeNull();
    expect(scriptProblems('assert 1 == 1')).toBeNull();
    expect(scriptProblems('   \n')).toBe('empty');
  });

  it('statusDelta names the paths a run created, changed or deleted in the copy', () => {
    const before = ' M pkg/__init__.py\0';
    const after = ' M pkg/__init__.py\0?? settings_repro.py\0 M app/models.py\0';
    expect(statusDelta(before, after)).toEqual(['app/models.py', 'settings_repro.py']);
    expect(statusDelta(before, before)).toEqual([]);
    // a replayed dirty file the script restored to HEAD is a change too
    expect(statusDelta(before, '')).toEqual(['pkg/__init__.py']);
  });
});

describe('L2 reproduction writer: Q18', () => {
  it('asks one survivor on its Noul alone (no Choice) against the LLM-script criteria, and the Choice with an escape from two survivors', () => {
    const lone = q18Questions({ repository: 'sympy', task: ISSUE, scripts: [q18Script('script_0', 3)] });
    expect(Object.keys(lone.questions).sort()).toEqual(['failure_kind', 'reproduces_issue_script_0']);
    const noul = lone.questions['reproduces_issue_script_0']!;
    expect(noul.type).toBe('noul');
    if (noul.type === 'noul') {
      expect(noul.criteria).toEqual(LLM_REPRODUCTION_CRITERIA);
      expect(noul.criteria).not.toEqual(REPRODUCTION_CRITERIA);
      expect(JSON.stringify(noul.criteria)).not.toContain('pip list');
    }
    // what an LLM-written script must satisfy — not what a block pasted in an issue looks like
    const spec = LLM_REPRODUCTION_CRITERIA;
    expect(spec.true.definition).toMatch(/would complete once the described behaviour is fixed/);
    expect(spec.true.definition).toMatch(/asserts nothing the issue does not state/);
    expect(spec.true.examples.length).toBeGreaterThanOrEqual(2);
    expect(spec.false.examples.length).toBeGreaterThanOrEqual(2);
    expect(spec.false.definition).toMatch(/raises for another reason/);
    expect(spec.false.definition).toMatch(/exact message text/);
    expect(spec.false.examples.join(' ')).toMatch(/already completes at the current commit/);
    expect(spec.false.examples.join(' ')).toMatch(/crashes on `import`/);
    const state = lone.state as { criteria: { reproduces_issue: string; not_a_reproduction_examples: string[] } };
    expect(state.criteria.reproduces_issue).toBe(LLM_REPRODUCTION_CRITERIA.true.definition);
    expect(state.criteria.not_a_reproduction_examples).toEqual(LLM_REPRODUCTION_CRITERIA.false.examples);
    const two = q18Questions({ repository: 'sympy', task: ISSUE, scripts: [q18Script('script_0', 3), q18Script('script_2', 5)] });
    const c = two.questions[Q18.choiceId]!;
    expect(c.type).toBe('choice');
    if (c.type === 'choice') expect(Object.keys(c.criteria)).toEqual(['script_0', 'script_2', ESCAPE_KEY]);
  });

  it('decides one survivor on the Noul alone (a stray escape is not a 0.5 cut) and, with two, records escape > top for routing while the Noul decides', () => {
    const one = [q18Script('script_0', 3)];
    const noulOnly: Record<string, Answer> = { reproduces_issue_script_0: noulAnswer(0.85), failure_kind: chosen({ exception_raised: 1 }) };
    expect(readQ18(noulOnly, one)).toMatchObject({ key: 'script_0', outcome: 'llm_valid', escapeAboveTop: false, failureKind: 'exception_raised' });
    // a Choice answer nobody asked for (0.55 on the escape) changes nothing: the Noul is the absolute answer
    const stray: Record<string, Answer> = { ...noulOnly, [Q18.choiceId]: chosen({ script_0: 0.45, [ESCAPE_KEY]: 0.55 }) };
    expect(readQ18(stray, one)).toMatchObject({ key: 'script_0', outcome: 'llm_valid', escapeAboveTop: false });
    expect(readQ18({ ...noulOnly, reproduces_issue_script_0: noulAnswer(0.5) }, one)).toMatchObject({ key: 'script_0', outcome: 'llm_weak' });
    expect(readQ18({ ...noulOnly, reproduces_issue_script_0: noulAnswer(0.2) }, one)).toMatchObject({ key: null, outcome: 'llm_none' });
    // two survivors at 0.30 / 0.30 with 0.40 on the escape and Nouls 0.90: a near-tie → the shorter script; the escape is recorded, never a gate
    const two = [q18Script('script_0', 8), q18Script('script_1', 4)];
    const answers: Record<string, Answer> = {
      [Q18.choiceId]: chosen({ script_0: 0.3, script_1: 0.3, [ESCAPE_KEY]: 0.4 }),
      reproduces_issue_script_0: noulAnswer(0.9),
      reproduces_issue_script_1: noulAnswer(0.9),
      failure_kind: chosen({ exception_raised: 1 }),
    };
    const pick = readQ18(answers, two);
    expect(pick).toMatchObject({ key: 'script_1', outcome: 'llm_valid', escapeAboveTop: true, pEscape: 0.4 });
    expect(pick.reason).toMatch(/0\.40 on none_of_these against 0\.30 .* \(recorded, not a gate\)/);
    // the Choice orders when it is decisive; the pick's Noul alone grades it
    const decisive: Record<string, Answer> = { ...answers, [Q18.choiceId]: chosen({ script_0: 0.7, script_1: 0.2, [ESCAPE_KEY]: 0.1 }), reproduces_issue_script_0: noulAnswer(0.25) };
    expect(readQ18(decisive, two)).toMatchObject({ key: null, outcome: 'llm_none', escapeAboveTop: false });
    expect(readQ18(decisive, two).reason).toMatch(/^script_0: reproduces_issue 0\.25 < 0\.3$/);
  });
});

describe('L2 reproduction writer: the writer', () => {
  it('runs every script in a scratch copy — never the workspace — through the default worktree scratch, runs the survivor twice, and lets Q18 grade the lone survivor on its Noul', async () => {
    const gen = scriptedGenerate((k) => ({ toolCall: call(SCRIPTS[k]!, k === 1 ? 'a sentence the reporter never wrote at all' : QUOTE) }));
    const runner = fakeRun({ a: [{ raise: 'TypeError' }, { raise: 'TypeError' }], c: [{ pass: true }] });
    const asks: { state: Record<string, unknown>; questions: Record<string, Question> }[] = [];
    const res = await writeReproduction(
      writerInput({
        generate: gen.generate,
        run: runner.run,
        scratchDir: '/run/tmp/synth/repro',
        ask: async (_stage, state, questions) => {
          asks.push({ state: state as Record<string, unknown>, questions });
          return q18Ask({ script_0: 0.8, [ESCAPE_KEY]: 0.2 }, 0.85)(_stage, state, questions);
        },
      }),
    );
    expect(gen.calls()).toBe(3);
    expect(gen.requests().map((r) => r.temperature)).toEqual([0, 0.7, 0.7]);
    expect(res.trials.map((t) => [t.sample, t.status])).toEqual([
      [0, 'accepted'],
      [1, 'rejected'],
      [2, 'rejected'],
    ]);
    expect(res.trials[1]!.reason).toMatch(/issue_quote is not a verbatim/);
    expect(res.trials[2]!.reason).toMatch(/completes at the base commit/);
    // script a ran twice (unstable rule), script c once (it passed), script b never
    expect(runner.calls()).toBe(3);
    // every python run happened in a lane the scratch created from the workspace, with its cwd there; nothing ran in /work
    const python = runner.commands().filter((c) => c.command.includes('b64decode'));
    expect(python).toHaveLength(3);
    for (const c of python) {
      expect(c.cwd).toMatch(/^\/scratch\/lane\d$/);
      expect(c.command).toContain("'/work/.venv/bin/python'");
      expect(c.command).not.toMatch(/cd '\/work'|PYTHONPATH='\/work/);
    }
    const creates = runner.commands().filter((c) => c.command.includes('worktree add'));
    expect(creates.length).toBeGreaterThanOrEqual(1);
    expect(creates.length).toBeLessThanOrEqual(2);
    expect(creates[0]!.command).toContain("git -C '/work' worktree add --detach");
    expect(creates[0]!.command).toContain("d='/run/tmp/synth/repro'/lane0");
    expect(creates[0]!.command).toContain('diff --binary HEAD');
    expect(creates[0]!.cwd).toBe('/work');
    // the copies are removed when the writer is done
    expect(runner.commands().filter((c) => c.command.includes('worktree remove')).length).toBe(creates.length);
    expect(asks).toHaveLength(1);
    // one survivor: no Choice, its Noul alone
    expect(Object.keys(asks[0]!.questions).sort()).toEqual(['failure_kind', 'reproduces_issue_script_0']);
    const scripts = asks[0]!.state['scripts'] as Record<string, { base_run: { exception_type: string } }>;
    expect(Object.keys(scripts)).toEqual(['script_0']);
    expect(scripts['script_0']!.base_run.exception_type).toBe('TypeError');
    expect(res.outcome).toBe('llm_valid');
    expect(isLlmOracle(res.outcome)).toBe(true);
    expect(res.pick).toMatchObject({ key: 'script_0', failureKind: 'exception_raised', escapeAboveTop: false });
    expect(res.goal?.summary).toMatchObject({ failed: 1, passed: 0, total: 1 });
    expect(res.goal?.spec.criterion).toEqual({ form: 'no_exception' });
    // the persisted spec names no workspace: the picked script re-runs against whatever root the caller gives, the lane path never leaks
    expect(res.goal?.spec.options).not.toHaveProperty('workspace');
    expect(res.goal?.failure.expected).toBe('simplify completes for a complex exponent');
    expect(res.note).toMatch(/never completes a run/);
  });

  it('rejects a script whose base run changed its copy, and one whose copy could not be made — without ever running in the workspace', async () => {
    const gen = scriptedGenerate((k) => ({ toolCall: call(SCRIPTS[0]!.replace('marker-a', k === 0 ? 'marker-a' : 'marker-d'), QUOTE) }));
    const runner = fakeRun({ a: [{ raise: 'TypeError' }, { raise: 'TypeError' }], d: [{ raise: 'TypeError' }, { raise: 'TypeError' }] });
    // the first run's status (call 0) shows a new file and a changed tracked file; the rest are clean
    const scratch = fakeScratch(2, (call) => (call === 0 ? ['pkg/__init__.py', 'settings_repro.py'] : []));
    const res = await writeReproduction(writerInput({ generate: gen.generate, run: runner.run, n: 2, scratch, ask: q18Ask({}, 0.9) }));
    expect(res.trials[0]).toMatchObject({ status: 'rejected' });
    expect(res.trials[0]!.reason).toBe('wrote to the workspace copy (pkg/__init__.py, settings_repro.py)');
    expect(res.trials[1]!.status).toBe('accepted');
    expect(res.outcome).toBe('llm_valid');
    expect(res.pick?.key).toBe('script_1');
    // the writer does not dispose a scratch it was handed
    expect(scratch.disposed()).toBe(false);
    expect(scratch.roots().every((r) => r.startsWith('/lane'))).toBe(true);
    expect(runner.commands().every((c) => c.cwd !== '/work')).toBe(true);

    // the default scratch cannot create a copy (a non-git workspace, a refused worktree add): the scripts are rejected, not run in /work
    const broken = fakeRun({ a: [{ raise: 'TypeError' }] }, { worktreeAddExit: 128 });
    const gen2 = scriptedGenerate(() => ({ toolCall: call(SCRIPTS[0]!, QUOTE) }));
    const none = await writeReproduction(writerInput({ generate: gen2.generate, run: broken.run, n: 1, ask: q18Ask({}, 0.9) }));
    expect(none.outcome).toBe('llm_none');
    expect(none.trials[0]!.status).toBe('rejected');
    expect(none.trials[0]!.reason).toMatch(/^no scratch copy to run in \(ReproScratchError: scratch copy lane0 failed \(exit 128\)/);
    expect(broken.calls()).toBe(0);
    expect(none.note).toMatch(/no LLM-written script survived/);
  });

  it('runs the first base runs concurrently across the lanes and confirms only the scripts that failed once, also in parallel', async () => {
    const markers = ['a', 'd', 'e'];
    const gen = scriptedGenerate((k) => ({ toolCall: call(SCRIPTS[0]!.replace('marker-a', `marker-${markers[k]}`), QUOTE) }));
    // a and e fail twice (survivors), d completes at base (one run, rejected)
    const runner = fakeRun({ a: [{ raise: 'TypeError' }], d: [{ pass: true }], e: [{ raise: 'TypeError' }] }, { latencyMs: 20 });
    const scratch = fakeScratch(2);
    const t0 = Date.now();
    const res = await writeReproduction(writerInput({ generate: gen.generate, run: runner.run, scratch, ask: q18Ask({ script_0: 0.5, script_2: 0.4, [ESCAPE_KEY]: 0.1 }, 0.8) }));
    const wall = Date.now() - t0;
    expect(res.trials.map((t) => t.status)).toEqual(['accepted', 'rejected', 'accepted']);
    // 3 first runs + 2 confirmation runs, at most 2 at a time (the lane count), i.e. 3 rounds of ≈ 20 ms rather than 5 serial ones
    expect(runner.calls()).toBe(5);
    expect(scratch.runs()).toBe(5);
    expect(runner.maxInFlight()).toBe(2);
    expect(wall).toBeLessThan(5 * 20);
    // two survivors: the Choice is asked, the pick's Noul grades it
    expect(res.pick).toMatchObject({ key: 'script_0', outcome: 'llm_valid', escapeAboveTop: false });
    expect(Object.keys(res.pick!.pChoice).sort()).toEqual(['script_0', 'script_2']);
  });

  it('refuses an unstable script (fails then passes at base) and a low Noul without asking twice', async () => {
    const gen = scriptedGenerate((k) => ({ toolCall: call(SCRIPTS[0]!.replace('marker-a', k === 0 ? 'marker-a' : 'marker-d'), QUOTE) }));
    const unstable = fakeRun({ a: [{ raise: 'TypeError' }, { pass: true }], d: [{ raise: 'TypeError' }, { raise: 'TypeError' }] });
    let askCalls = 0;
    const res = await writeReproduction(
      writerInput({
        generate: gen.generate,
        run: unstable.run,
        n: 2,
        scratch: fakeScratch(1),
        ask: async (stage, state, questions) => {
          askCalls += 1;
          return q18Ask({ script_1: 0.9 }, 0.2)(stage, state, questions);
        },
      }),
    );
    expect(res.trials[0]).toMatchObject({ status: 'rejected' });
    expect(res.trials[0]!.reason).toMatch(/unstable/);
    expect(res.trials[1]!.status).toBe('accepted');
    expect(unstable.calls()).toBe(4);
    expect(askCalls).toBe(1);
    expect(res.outcome).toBe('llm_none');
    expect(res.goal).toBeNull();
    expect(res.pick?.reason).toMatch(/reproduces_issue 0\.20 < 0\.3/);
  });

  it('meters every sample — priced results at their cost, a failed one from what it streamed plus the reasoning allowance — and charges the step budget', async () => {
    const pricing = { inputPerM: 0.5, outputPerM: 2 };
    const gen = scriptedGenerate((k) => ({ toolCall: call(SCRIPTS[k]!, k === 1 ? 'not in the issue at all, truly' : QUOTE), usage: { inputTokens: 4000, outputTokens: 300 } }));
    const failing: typeof gen.generate = (req, o) => (o.sample === 2 ? Promise.reject(new Error('TransportError: stream')) : gen.generate(req, o));
    const budget = { usdLeft: 0.02 };
    const res = await writeReproduction(writerInput({ generate: failing, run: fakeRun({ a: [{ raise: 'TypeError' }, { raise: 'TypeError' }] }).run, scratch: fakeScratch(1), pricing, budget, ask: q18Ask({ script_0: 0.9 }, 0.8) }));
    const priced = (4000 * 0.5 + 300 * 2) / 1e6;
    // L2 sends the default generation too — reasoning at low effort (§4.13; {enabled: false} is HTTP 400 on GLM) with the reasoning-on
    // base 3,000 — so a sample that never returned books the sibling's prompt tokens and the reasoning allowance, never max_tokens
    expect(LLM_DEFAULT_GENERATION.maxTokens).toBe(3000);
    expect(gen.requests()[0]).toMatchObject({ maxTokens: LLM_DEFAULT_GENERATION.maxTokens, reasoning: { effort: 'low' } });
    const estimate = (4000 * 0.5 + UNFINISHED_REASONING_ALLOWANCE_TOKENS * 2) / 1e6;
    expect(res.trials.map((t) => [t.status, t.estimated])).toEqual([
      ['accepted', false],
      ['rejected', false],
      ['error', true],
    ]);
    expect(res.trials[0]!.usd).toBeCloseTo(priced, 9);
    expect(res.trials[2]).toMatchObject({ reason: 'TransportError: stream', usage: { inputTokens: 4000, outputTokens: UNFINISHED_REASONING_ALLOWANCE_TOKENS, estimated: true } });
    expect(res.trials[2]!.usd).toBeCloseTo(estimate, 9);
    expect(res.usd).toBeCloseTo(2 * priced + estimate, 9);
    expect(res.estimatedUsd).toBeCloseTo(estimate, 9);
    expect(0.02 - budget.usdLeft).toBeCloseTo(res.usd, 9);
    expect(res.outcome).toBe('llm_valid');
  });

  it('sends a pinned generation verbatim — reasoning null is not sent, the base is its max_tokens — and books a lost sample from its stream, no allowance (§10.1)', async () => {
    const pricing = { inputPerM: 0.5, outputPerM: 2 };
    const gen = scriptedGenerate((k) => ({ toolCall: call(SCRIPTS[k]!, QUOTE), usage: { inputTokens: 4000, outputTokens: 300 } }));
    // the wrapper records every request itself: the failing sample rejects before the scripted generator sees it, after streaming 800 tool chars
    const sent: GenerateRequest[] = [];
    const failing: typeof gen.generate = (req, o) => {
      sent.push(req);
      if (o.sample !== 1) return gen.generate(req, o);
      o.onCancelled?.({ text: '', toolChars: 800, reasoningChars: 0 });
      return Promise.reject(new Error('TransportError: stream'));
    };
    const res = await writeReproduction(writerInput({ generate: failing, n: 2, run: fakeRun({ a: [{ raise: 'TypeError' }, { raise: 'TypeError' }] }).run, scratch: fakeScratch(1), pricing, generation: { reasoning: null, maxTokens: 1500 }, ask: q18Ask({ script_0: 0.9 }, 0.8) }));
    expect(sent).toHaveLength(2);
    for (const req of sent) {
      expect(req.maxTokens).toBe(1500);
      expect(req).not.toHaveProperty('reasoning');
    }
    expect(res.trials.map((t) => [t.status, t.estimated])).toEqual([
      ['accepted', false],
      ['error', true],
    ]);
    // reasoning off: the streamed 800 chars / 4 and nothing else on the output side
    expect(res.trials[1]).toMatchObject({ usage: { inputTokens: 4000, outputTokens: 200, estimated: true } });
    expect(res.trials[1]!.usd).toBeCloseTo((4000 * 0.5 + 200 * 2) / 1e6, 9);
    expect(res.outcome).toBe('llm_valid');
  });
});
