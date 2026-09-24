import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { calibrationStats, scanCalibration } from '../../../../src/tui/calibration.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runId(i: number): string {
  const n = String(i).padStart(6, '0');
  return `20260920-${n}-abcdefgh`;
}

function decisionLine(step: number, stage: string, id: string, p: number): string {
  return JSON.stringify({ step, stage, id, question: { type: 'noul', instructions: 'x' }, answer: { type: 'noul', noul: p }, probability: p, confidence: Math.abs(2 * p - 1), latencyMs: 100, requestHash: 'abc' });
}

function stepLine(step: number, over: Record<string, unknown> = {}): string {
  return JSON.stringify({ step, startedAt: 't', intent: 'edit', outcome: { status: 'executed', exec: { ok: true } }, judge: { succeeded: 0.9, tests: { source: 'parsed', allPassed: true, passed: 3, failed: 0, errors: 0 } }, risk: { verdict: 'review', dims: { plan_mismatch: { risk: 0.44 } } }, completion: 0.5, decisions: [], ...over });
}

function makeRuns(count: number, opts: { padBytes?: number; withDecisions?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'jevcode-calib-'));
  dirs.push(root);
  for (let i = 1; i <= count; i++) {
    const dir = join(root, runId(i));
    mkdirSync(dir);
    if (opts.withDecisions !== false) {
      writeFileSync(join(dir, 'decisions.jsonl'), [decisionLine(1, 'risk', 'plan_mismatch', 0.6), decisionLine(1, 'judge', 'done_0', 0.8), decisionLine(1, 'judge', 'succeeded', 0.9), '{ torn'].join('\n') + '\n');
    }
    const pad = opts.padBytes ? `, "pad": "${'x'.repeat(opts.padBytes)}"` : '';
    writeFileSync(join(dir, 'steps.jsonl'), `${stepLine(1, { decisions: [{ step: 1, stage: 'judge', id: 'succeeded', probability: 0.9 }] }).slice(0, -1)}${pad}}\n${stepLine(2)}\nnot json\n`);
  }
  mkdirSync(join(root, 'not-a-run-id'));
  writeFileSync(join(root, 'stray.txt'), 'x');
  return root;
}

describe('scanCalibration (TUI-DESIGN §7.6: newest 50 runs or 32 MB, whichever first)', () => {
  it('reads decisions.jsonl whole and steps.jsonl line by line, skipping torn lines and non-run entries', async () => {
    const root = makeRuns(3);
    const res = await scanCalibration(root);
    expect(res.candidates).toBe(3);
    expect(res.runs.map((r) => r.runId)).toEqual([runId(3), runId(2), runId(1)]);
    expect(res.runs[0]!.decisions).toHaveLength(3);
    expect(res.runs[0]!.steps).toHaveLength(2);
    expect(res.runs[0]!.steps[0]).toMatchObject({ step: 1, riskVerdict: 'review', riskDims: { plan_mismatch: 0.44 }, execOk: true });
    expect(res.truncated).toBeNull();
    expect(res.skipped).toEqual([]);
    expect(res.bytes).toBeGreaterThan(0);
    const stats = calibrationStats(res.runs);
    expect(stats.runs).toBe(3);
    expect(stats.decisions).toBe(9);
    // review (plan_mismatch risk 0.44 at a reviewed, executed step → label false), done_0 (later parsed pass), succeeded (exec.ok)
    expect(stats.sources).toEqual({ review: 3, done: 3, complete: 0, succeeded: 3 });
  });
  it('caps at the newest 50 runs (of 60) and reports the cap', async () => {
    const root = makeRuns(60);
    const seen: string[] = [];
    const res = await scanCalibration(root, { onRun: (_i, total, id) => seen.push(`${total}:${id}`) });
    expect(res.candidates).toBe(50);
    expect(res.runs).toHaveLength(50);
    expect(res.runs[0]!.runId).toBe(runId(60));
    expect(res.runs[49]!.runId).toBe(runId(11));
    expect(res.truncated).toBe('runs');
    expect(seen).toHaveLength(50);
    expect(seen[0]).toBe(`50:${runId(60)}`);
    const five = await scanCalibration(root, { maxRuns: 5 });
    expect(five.runs.map((r) => r.runId)).toEqual([60, 59, 58, 57, 56].map(runId));
  });
  it('stops at the byte cap before reading a run that would exceed it', async () => {
    const root = makeRuns(10, { padBytes: 4000 });
    const res = await scanCalibration(root, { maxBytes: 10_000 });
    expect(res.truncated).toBe('bytes');
    expect(res.runs.length).toBeGreaterThanOrEqual(1);
    expect(res.runs.length).toBeLessThan(10);
    expect(res.bytes).toBeLessThanOrEqual(10_000);
    const none = await scanCalibration(root, { maxBytes: 10 });
    expect(none.runs).toEqual([]);
    expect(none.truncated).toBe('bytes');
  });
  it('a missing runs dir, a run without files and an unreadable file are skipped with a reason, never thrown', async () => {
    const missing = await scanCalibration(join(tmpdir(), 'jevcode-does-not-exist-xyz'));
    expect(missing.runs).toEqual([]);
    expect(missing.skipped[0]?.reason).toBe('ENOENT');
    const root = makeRuns(2);
    mkdirSync(join(root, runId(3)));
    const res = await scanCalibration(root);
    expect(res.skipped).toEqual([{ runId: runId(3), reason: 'no decisions.jsonl or steps.jsonl' }]);
    expect(res.runs).toHaveLength(2);
    if (process.getuid?.() !== 0) {
      const locked = join(root, runId(2), 'decisions.jsonl');
      chmodSync(locked, 0o000);
      try {
        const r2 = await scanCalibration(root);
        expect(r2.skipped.find((s) => s.runId === runId(2))?.reason).toBe('EACCES');
        expect(r2.runs.map((r) => r.runId)).toEqual([runId(1)]);
      } finally {
        chmodSync(locked, 0o600);
      }
    }
  });
  it('an unreadable steps.jsonl (the streamed readline path) and a directory in its place are skipped with EACCES / EISDIR', async () => {
    const root = makeRuns(3);
    const asDir = join(root, runId(3), 'steps.jsonl');
    rmSync(asDir);
    mkdirSync(asDir);
    const res = await scanCalibration(root);
    expect(res.skipped.find((s) => s.runId === runId(3))?.reason).toBe('EISDIR');
    expect(res.runs.map((r) => r.runId)).toEqual([runId(2), runId(1)]);
    if (process.getuid?.() !== 0) {
      const locked = join(root, runId(2), 'steps.jsonl');
      chmodSync(locked, 0o000);
      try {
        const r2 = await scanCalibration(root);
        expect(r2.skipped.find((s) => s.runId === runId(2))?.reason).toBe('EACCES');
        expect(r2.runs.map((r) => r.runId)).toEqual([runId(1)]);
      } finally {
        chmodSync(locked, 0o600);
      }
    }
  });
  it('a run with steps.jsonl only uses the steps’ decisions and carries a bench verdict when given', async () => {
    const root = makeRuns(1, { withDecisions: false });
    const res = await scanCalibration(root, { benchPass: new Map([[runId(1), true]]) });
    expect(res.runs[0]!.decisions).toEqual([]);
    expect(res.runs[0]!.benchPass).toBe(true);
    const stats = calibrationStats(res.runs);
    expect(stats.decisions).toBe(1);
    expect(stats.sources.succeeded).toBe(1);
  });
});
