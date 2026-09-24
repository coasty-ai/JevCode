/**
 * TUI-DESIGN §7.6 / §19.0: `jevcode why <id> <step> <ref>` over a run's decisions.jsonl and `jevcode calibration`
 * over the runs dir (`--json` too); torn lines and missing runs are handled.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commandCalibration, commandWhy, readDecisionsFile } from '../../../src/cli/inspect.js';
import { mkDecision } from '../../fixtures/tui/fixtures.js';
import { scriptedRunId } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function io(runsDir: string): { stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown }; runsDir: string; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, runsDir, out, err };
}

describe('jevcode why', () => {
  it('prints the /why block for a decision of the run; unknown refs and runs are exit 2; torn lines are skipped', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'jevcode-why-'));
    dirs.push(runsDir);
    const id = scriptedRunId(7);
    mkdirSync(join(runsDir, id), { recursive: true });
    const d = mkDecision({ step: 3, stage: 'risk', id: 'destructive' });
    writeFileSync(join(runsDir, id, 'decisions.jsonl'), `${JSON.stringify(d)}\n{torn\n${JSON.stringify(mkDecision({ step: 3, stage: 'risk', id: 'out_of_scope' }))}\n`);
    expect((await readDecisionsFile(join(runsDir, id, 'decisions.jsonl'))).map((x) => x.id)).toEqual(['destructive', 'out_of_scope']);
    const a = io(runsDir);
    expect(await commandWhy({ command: 'why', runId: id, step: 3, ref: 'risk.destructive' }, a)).toBe(0);
    expect(a.out.join('')).toMatch(/^why s3\.risk\.destructive  request abc123de  170ms/);
    const b = io(runsDir);
    expect(await commandWhy({ command: 'why', runId: id, step: 3, ref: 'risk.nothing' }, b)).toBe(2);
    expect(b.err.join('')).toContain('no decision matches risk.nothing at step 3');
    const c = io(runsDir);
    expect(await commandWhy({ command: 'why', runId: scriptedRunId(8), step: 1, ref: 'risk.destructive' }, c)).toBe(2);
    expect(c.err.join('')).toContain('cannot read decisions');
    const dd = io(runsDir);
    expect(await commandWhy({ command: 'why', runId: id, step: 3, ref: '@@' }, dd)).toBe(2);
  });
});

describe('jevcode calibration', () => {
  it('renders the block over an empty runs dir and the JSON stats with --json', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'jevcode-cal-'));
    dirs.push(runsDir);
    const a = io(runsDir);
    expect(await commandCalibration({ command: 'calibration' }, a)).toBe(0);
    expect(a.out.join('')).toMatch(/^calibration/);
    const b = io(runsDir);
    expect(await commandCalibration({ command: 'calibration', json: true }, b)).toBe(0);
    const parsed = JSON.parse(b.out.join('')) as { stats: unknown; candidates: number };
    expect(parsed.candidates).toBe(0);
  });
});
