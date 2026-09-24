/**
 * `jevcode why <id> <step> <ref>` and `jevcode calibration [--json]` (TUI-DESIGN §1, §7.6): the CLI twins of `/why`
 * and `/calibration` over a run directory — `decisions.jsonl` read whole for one run, the newest ≤ 50 runs streamed
 * for the calibration block (`scanCalibration`, the same I/O the TUI command uses). Pure over an injected I/O seam.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Decision } from '../core/types.js';
import type { ParsedFlags } from './args.js';
import { EXIT_CODES } from '../errors.js';
import { calibrationBlock, calibrationStats, scanCalibration } from '../tui/calibration.js';
import { GLYPHS } from '../tui/glyphs.js';
import { findDecision, parseWhyRef, whyBlock } from '../tui/why.js';

export interface InspectIo {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  runsDir: string;
  ascii?: boolean;
  readFile?: (path: string) => Promise<string>;
}

function isDecision(v: unknown): v is Decision {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['step'] === 'number' && typeof o['stage'] === 'string' && typeof o['id'] === 'string' && typeof o['answer'] === 'object' && o['answer'] !== null && typeof o['probability'] === 'number';
}

/** `<runDir>/decisions.jsonl` rows that look like decisions; torn lines skipped */
export async function readDecisionsFile(path: string, read: (p: string) => Promise<string> = (p) => readFile(p, 'utf8')): Promise<Decision[]> {
  const out: Decision[] = [];
  const text = await read(path);
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isDecision(v)) out.push(v);
    } catch {
      /* torn line */
    }
  }
  return out;
}

/** TUI-DESIGN §7.6: `jevcode why <id> <step> <ref>` — exit 0 printed · 2 no such run / decision. */
export async function commandWhy(flags: ParsedFlags, io: InspectIo): Promise<number> {
  const { runId, step, ref } = flags;
  if (runId === undefined || step === undefined || ref === undefined) {
    io.stderr.write('jevcode why needs <id> <step> <ref>\n');
    return EXIT_CODES.config;
  }
  const parsed = parseWhyRef(ref.includes('.') ? ref : `s${step}.${ref}`);
  if (parsed === null) {
    io.stderr.write(`jevcode why: "${ref}" is not a decision ref (risk.plan_mismatch, s7.risk.plan_mismatch or a digit 1-5)\n`);
    return EXIT_CODES.config;
  }
  let decisions: Decision[];
  try {
    decisions = await readDecisionsFile(join(io.runsDir, runId, 'decisions.jsonl'), io.readFile);
  } catch (e) {
    io.stderr.write(`jevcode why: cannot read decisions of ${runId}: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT_CODES.config;
  }
  const scoped = parsed.kind === 'ref' && parsed.step === null ? { ...parsed, step } : parsed;
  const d = findDecision(decisions, scoped, step);
  if (d === null) {
    io.stderr.write(`jevcode why: no decision matches ${ref} at step ${step} of ${runId}\n`);
    return EXIT_CODES.config;
  }
  const lines = whyBlock(d, { siblings: decisions.filter((x) => x.step === d.step) }, io.ascii === true ? GLYPHS.ascii : GLYPHS.unicode);
  io.stdout.write(`${lines.join('\n')}\n`);
  return EXIT_CODES.ok;
}

/** TUI-DESIGN §7.6: `jevcode calibration [--json]` over the runs dir. */
export async function commandCalibration(flags: ParsedFlags, io: InspectIo): Promise<number> {
  const scan = await scanCalibration(io.runsDir);
  const stats = calibrationStats(scan.runs);
  if (flags.json) {
    io.stdout.write(`${JSON.stringify({ stats, candidates: scan.candidates, skipped: scan.skipped, bytes: scan.bytes, truncated: scan.truncated }, null, 2)}\n`);
    return EXIT_CODES.ok;
  }
  io.stdout.write(`${calibrationBlock(stats, io.ascii === true ? GLYPHS.ascii : GLYPHS.unicode).join('\n')}\n`);
  return EXIT_CODES.ok;
}
