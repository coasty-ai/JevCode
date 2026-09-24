/**
 * The pre-bench probes of docs/LLM-JEV-DESIGN.md §10.2 (live, ≤ $0.40 by default; the probe stops firing when the running
 * cost passes --budget):
 *
 *   1. GLM loop probe — `propose_fix` samples on real loop-sized prompts (QuixBugs programs with the buggy program's
 *      actual outputs on the visible cases, ladder tasks with their real pytest failures and traceback frames) built by
 *      the loop's own `buildFixSystemPrompt` / `buildFixUserMessage`, N parallel samples per prompt as the round fires
 *      them (sample 0 at temperature 0, the rest at 0.8 with `seed = step × 100 + k`, the class's hint schedule), with
 *      `reasoning: {effort: 'low'}` at max_tokens 3,000 (a `length` stop re-issues once at 6,000, §4.8) — and, on request,
 *      the `{enabled: false}` variant (expected: HTTP 400 "Reasoning is mandatory", §10.2 finding (a)) and the no-`reasoning`
 *      variant at 1,500. Reports valid-sample rate, finish_reason distribution, latency (all / valid p50, p90, max) and the
 *      fit a + b × output_tokens, reasoning_tokens, servedProvider, `usage.cost` vs the served-rate estimate.
 *   2. Anchoring probe — every returned hunk anchored by `candidates.ts anchorHunk` against the real file: misanchored rate
 *      and reasons (target ≤ 10 %).
 *   4. Diversity — distinct patches per round (target ≥ 50 %).
 *   5. Cancellation billing probe — `--cancel N` samples aborted at 2 s with `onCancelled` capturing the generation id and
 *      the streamed chars; the §4.8 estimate (sibling prompt tokens, streamed chars / 4, served rate) vs
 *      `GET /api/v1/generation?id=` read back after 60 s.
 *   (3, the Jev arbitration probe over (seed line, LLM hunk) pairs, needs the jev-only overfit workspaces and is not here.)
 *
 * Usage:
 *   env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/llm-jev/probes.mts \
 *     [--quixbugs 5] [--ladder 3] [--samples 3] [--variants low[,off,none]] [--cancel 3] [--budget 0.40] \
 *     [--out experiments/results/llm-jev-probes.md] [--raw experiments/results/llm-jev-probes.jsonl] [--no-wait] [--dry-run]
 *
 * --dry-run builds and prints the prompts (sizes, failures, localisation) and makes no call.
 *
 * Needs OPENROUTER_API_KEY in the environment (never printed) and python3 with pytest for the ladder prompts.
 */
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { servedRateFor } from '../../src/bench/conditions.ts';
import { latencyFit, latencySummary } from '../../src/bench/generator-records.ts';
import { tableLines } from '../../src/bench/headtohead.ts';
import { loadIndex, loadCases, programPath, usesNode } from '../../src/bench/quixbugs/tasks.ts';
import { taskText } from '../../src/bench/quixbugs/loader.ts';
import { BASE_URLS, lookupPricing } from '../../src/config/defaults.ts';
import { sha12 } from '../../src/core/hash.ts';
import { percentile } from '../../src/core/time.ts';
import type { CancelledGeneration, GenerateReasoning, GenerateRequest, GenerateResult, GeneratorCallRecord, GeneratorConfig, Json } from '../../src/core/types.ts';
import { ProviderHttpError } from '../../src/errors.ts';
import { createOpenRouterProvider } from '../../src/provider/openrouter.ts';
import { anchorHunk } from '../../src/jev-modes/synth/llm/candidates.ts';
import { buildFixSystemPrompt, buildFixUserMessage, hintSchedule, type FixPromptInput, type Listing, type LocalisationLine } from '../../src/jev-modes/synth/llm/prompt.ts';
import { PROPOSE_FIX_TOOL, PROPOSE_FIX_TOOL_NAME, isLengthStop, parseProposeFix, type PatchSpec } from '../../src/jev-modes/synth/llm/schema.ts';
import { LLM_MAX_TOKENS, LLM_MAX_TOKENS_REASONING, sampleSeed, sampleTemperature } from '../../src/jev-modes/synth/llm/source.ts';
import type { FailureView } from '../../src/jev-modes/synth/types.ts';
import { flag, parseArgs } from './results.ts';

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MODEL = 'z-ai/glm-5.3-flash';
const CANCEL_AT_MS = 2000;
const READBACK_WAIT_MS = 60_000;

const { flags } = parseArgs(process.argv.slice(2));
const nQuix = Number(flag(flags, 'quixbugs') ?? 5);
const nLadder = Number(flag(flags, 'ladder') ?? 3);
const samples = Number(flag(flags, 'samples') ?? 3);
const variants = (flag(flags, 'variants') ?? 'low').split(',').map((v) => v.trim()) as Variant[];
const nCancel = Number(flag(flags, 'cancel') ?? 3);
const budgetUsd = Number(flag(flags, 'budget') ?? 0.4);
const outFile = flag(flags, 'out') ?? join(ROOT, 'experiments/results/llm-jev-probes.md');
const rawFile = flag(flags, 'raw') ?? join(ROOT, 'experiments/results/llm-jev-probes.jsonl');
const noWait = flag(flags, 'no-wait') === 'true';
const dryRun = flag(flags, 'dry-run') === 'true';

type Variant = 'low' | 'off' | 'none';
const reasoningOf = (v: Variant): GenerateReasoning | undefined => (v === 'low' ? { effort: 'low' } : v === 'off' ? { enabled: false } : undefined);
const maxTokensOf = (v: Variant): number => (v === 'low' ? LLM_MAX_TOKENS_REASONING : LLM_MAX_TOKENS);

const apiKey = process.env['OPENROUTER_API_KEY'] ?? '';
if (apiKey === '' && !dryRun) throw new Error('OPENROUTER_API_KEY missing (run with --env-file=.env)');
const cfg: GeneratorConfig = { provider: 'openrouter', model: MODEL, apiKey, baseUrl: BASE_URLS.openrouter, temperature: null, maxTokens: LLM_MAX_TOKENS_REASONING, pricing: lookupPricing(MODEL).pricing, priced: true };
const provider = createOpenRouterProvider(cfg, { redact: (s) => s.split(apiKey).join('[key]') });
const served = servedRateFor(MODEL);
const estimateUsd = (inputTokens: number, outputTokens: number): number => (inputTokens * served.inputPerM + outputTokens * served.outputPerM) / 1_000_000;

// ---------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------

interface Prompt {
  id: string;
  klass: 'quixbugs' | 'ladder';
  files: Map<string, string[]>;
  input: FixPromptInput;
}

const PY_ACTUALS = `
import json, sys, importlib.util, signal
path, name, cases = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
spec = importlib.util.spec_from_file_location(name, path); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
fn = getattr(mod, name)
def alarm(*_): raise TimeoutError('timeout after 2 s')
signal.signal(signal.SIGALRM, alarm)
out = []
for c in cases:
    signal.alarm(2)
    try: actual = repr(fn(*c['input']))
    except BaseException as e: actual = type(e).__name__ + ': ' + str(e)[:200]
    finally: signal.alarm(0)
    out.append(actual)
print(json.dumps(out))
`;

async function quixbugsPrompts(n: number): Promise<Prompt[]> {
  const dir = join(ROOT, 'bench/data/quixbugs');
  const out: Prompt[] = [];
  for (const rec of await loadIndex(dir)) {
    if (out.length >= n) break;
    if (!rec.hasJsonTests) continue;
    const src = readFileSync(programPath(dir, rec.name), 'utf8');
    if (usesNode(src)) continue;
    const cases = (await loadCases(dir, rec.name)).filter((c) => c.slow !== true).slice(0, 3);
    let actuals: string[] = [];
    try {
      const { stdout } = await exec('python3', ['-c', PY_ACTUALS, programPath(dir, rec.name), rec.name, JSON.stringify(cases)], { timeout: 20_000 });
      actuals = JSON.parse(stdout) as string[];
    } catch {
      continue;
    }
    const failures: FailureView[] = cases.map((c, i) => ({ testId: `case_${i + 1}`, call: `${rec.name}(${c.input.map((x) => JSON.stringify(x)).join(', ')})`, expected: JSON.stringify(c.expected), actual: actuals[i] ?? 'unknown' })).filter((f) => f.actual !== f.expected);
    if (failures.length === 0) continue;
    const lines = src.replace(/\n"""[\s\S]*$/, '').replace(/\s+$/, '').split('\n');
    const path = `${rec.name}.py`;
    const defLine = Math.max(1, lines.findIndex((l) => l.startsWith(`def ${rec.name}`)) + 1);
    const listing: Listing = { path, name: rec.name, startLine: 1, endLine: lines.length, lines, origin: 'traceback' };
    const localisation: LocalisationLine[] = [{ path, line: defLine, fn: rec.name, origin: 'traceback' }];
    out.push({ id: `quixbugs/${rec.name}`, klass: 'quixbugs', files: new Map([[path, lines]]), input: { goal: { tests: failures.map((f) => f.testId), path }, task: taskText(rec), failures, localisation, listings: [listing], attempts: [], hint: { tiers: [] } } });
  }
  return out;
}

async function ladderPrompts(n: number): Promise<Prompt[]> {
  const tasksDir = join(ROOT, 'bench/data/ladder/tasks');
  const out: Prompt[] = [];
  for (const name of readdirSync(tasksDir).sort()) {
    if (out.length >= n) break;
    const taskDir = join(tasksDir, name);
    if (!existsSync(join(taskDir, 'task.md'))) continue;
    const tmp = mkdtempSync(join(tmpdir(), 'llm-jev-probe-'));
    try {
      for (const entry of readdirSync(taskDir)) if (entry !== 'gold') cpSync(join(taskDir, entry), join(tmp, entry), { recursive: true });
      let output = '';
      try {
        const r = await exec('python3', ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--tb=short'], { cwd: tmp, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
        output = r.stdout;
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string };
        output = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
      }
      const failed = [...output.matchAll(/^FAILED (\S+) - (.*)$/gm)].map((m) => ({ id: m[1]!, msg: m[2]! }));
      if (failed.length === 0) continue;
      const frames = [...output.matchAll(/^(src\/\S+\.py):(\d+): in (\w+)/gm)].map((m) => ({ path: m[1]!, line: Number(m[2]), fn: m[3]! }));
      const files = new Map<string, string[]>();
      for (const f of readdirSync(join(taskDir, 'src')).filter((f) => f.endsWith('.py') && f !== '__init__.py')) files.set(`src/${f}`, readFileSync(join(taskDir, 'src', f), 'utf8').replace(/\s+$/, '').split('\n'));
      const listings: Listing[] = [...files].slice(0, 4).map(([path, lines]) => ({ path, name: null, startLine: 1, endLine: Math.min(lines.length, 120), lines: lines.slice(0, 120), origin: frames.some((fr) => fr.path === path) ? 'traceback' : 'jev' }));
      const seenFrames = new Set<string>();
      const localisation: LocalisationLine[] = frames.filter((fr) => files.has(fr.path) && !seenFrames.has(`${fr.path}:${fr.line}`) && seenFrames.add(`${fr.path}:${fr.line}`)).slice(0, 3).map((fr) => ({ path: fr.path, line: fr.line, fn: fr.fn, origin: 'traceback' as const }));
      const failures: FailureView[] = failed.slice(0, 3).map((f) => ({ testId: f.id, call: f.id, expected: 'the assertion in the test', actual: f.msg.slice(0, 300) }));
      const mainPath = localisation[0]?.path ?? [...files.keys()][0] ?? 'src';
      out.push({ id: `ladder/${name}`, klass: 'ladder', files, input: { goal: { tests: failed.map((f) => f.id), path: mainPath }, task: readFileSync(join(taskDir, 'task.md'), 'utf8'), failures, localisation, listings, attempts: [], hint: { tiers: [] } } });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------------------

interface Row {
  prompt: string;
  klass: string;
  variant: Variant;
  sample: number;
  doubled: boolean;
  maxTokens: number;
  latencyMs: number;
  stopReason: string;
  httpStatus: number | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  estimateUsd: number;
  servedProvider: string | null;
  generationId: string | null;
  valid: boolean;
  parseReason: string | null;
  patches: number;
  hunks: number;
  anchored: number;
  misanchored: string[];
  patchShas: string[];
}

let spent = 0;
const rows: Row[] = [];
const system = buildFixSystemPrompt();

function patchSha(p: PatchSpec, files: Map<string, string[]>): string {
  return sha12(p.edits.map((h) => {
    const lines = files.get(h.path) ?? [];
    const a = anchorHunk(lines, h.old, h.nearLine);
    return { path: h.path, at: a.ok ? `${a.start}-${a.end}` : 'x', new: h.new.replace(/[ \t]+$/gm, '') };
  }) as unknown as Json);
}

async function sampleOnce(prompt: Prompt, variant: Variant, k: number, maxTokens: number, doubled: boolean): Promise<Row> {
  const hints = hintSchedule(prompt.klass, samples);
  const user = buildFixUserMessage({ ...prompt.input, hint: hints[k] ?? { tiers: [] } });
  const reasoning = reasoningOf(variant);
  const req: GenerateRequest = { system, messages: [{ role: 'user', content: user }], maxTokens, temperature: sampleTemperature(k, 1), seed: sampleSeed(1, k), tools: [PROPOSE_FIX_TOOL], toolChoice: { name: PROPOSE_FIX_TOOL_NAME }, ...(reasoning !== undefined ? { reasoning } : {}) };
  const row: Row = { prompt: prompt.id, klass: prompt.klass, variant, sample: k, doubled, maxTokens, latencyMs: 0, stopReason: 'error', httpStatus: null, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0, estimateUsd: 0, servedProvider: null, generationId: null, valid: false, parseReason: null, patches: 0, hunks: 0, anchored: 0, misanchored: [], patchShas: [] };
  const t0 = Date.now();
  let res: GenerateResult;
  try {
    res = await provider.generate(req, { signal: new AbortController().signal });
  } catch (e) {
    row.latencyMs = Date.now() - t0;
    if (e instanceof ProviderHttpError) {
      row.httpStatus = e.status;
      row.parseReason = `HTTP ${e.status}: ${e.message.slice(0, 160)}`;
    } else row.parseReason = e instanceof Error ? e.message.slice(0, 160) : String(e);
    return row;
  }
  row.latencyMs = res.latencyMs;
  row.stopReason = res.stopReason;
  row.inputTokens = res.usage.inputTokens;
  row.outputTokens = res.usage.outputTokens;
  row.reasoningTokens = res.usage.reasoningTokens ?? 0;
  row.costUsd = Number.isFinite(res.usage.costUsd) ? res.usage.costUsd : 0;
  row.estimateUsd = estimateUsd(res.usage.inputTokens, res.usage.outputTokens);
  row.servedProvider = res.servedProvider ?? null;
  row.generationId = res.generationId ?? null;
  spent += row.costUsd;
  const parsed = parseProposeFix(res);
  if (!parsed.ok) {
    row.parseReason = parsed.reason;
    return row;
  }
  row.valid = !isLengthStop(res.stopReason);
  row.patches = parsed.value.patches.length;
  for (const p of parsed.value.patches) {
    row.patchShas.push(patchSha(p, prompt.files));
    for (const h of p.edits) {
      row.hunks += 1;
      const lines = prompt.files.get(h.path);
      const a = lines === undefined ? { ok: false as const, reason: `unknown path ${h.path}` } : anchorHunk(lines, h.old, h.nearLine);
      if (a.ok) row.anchored += 1;
      else row.misanchored.push(a.reason);
    }
  }
  return row;
}

async function round(prompt: Prompt, variant: Variant): Promise<void> {
  const base = maxTokensOf(variant);
  const n = variant === 'off' ? 1 : samples;
  const first = await Promise.all(Array.from({ length: n }, (_, k) => sampleOnce(prompt, variant, k, base, false)));
  rows.push(...first);
  // §4.8: a `length` drop re-issues once at double max_tokens
  const lengthStopped = first.filter((r) => isLengthStop(r.stopReason));
  if (lengthStopped.length > 0 && spent < budgetUsd) rows.push(...(await Promise.all(lengthStopped.map((r) => sampleOnce(prompt, variant, r.sample, base * 2, true)))));
}

// ---------------------------------------------------------------------------------------
// Cancellation billing probe (§10.2 item 5)
// ---------------------------------------------------------------------------------------

interface CancelRow {
  sample: number;
  abortedAtMs: number;
  generationId: string | null;
  toolChars: number;
  reasoningChars: number;
  frameArrived: boolean;
  estimateInputTokens: number;
  estimateOutputTokens: number;
  estimateUsd: number;
  billedUsd: number | null;
  billedPromptTokens: number | null;
  billedCompletionTokens: number | null;
  billedReasoningTokens: number | null;
}

async function cancelProbe(prompt: Prompt, siblingInputTokens: number | null): Promise<CancelRow[]> {
  const user = buildFixUserMessage(prompt.input);
  const req: GenerateRequest = { system, messages: [{ role: 'user', content: user }], maxTokens: LLM_MAX_TOKENS_REASONING, temperature: 0.8, tools: [PROPOSE_FIX_TOOL], toolChoice: { name: PROPOSE_FIX_TOOL_NAME }, reasoning: { effort: 'low' } };
  const promptTokens = siblingInputTokens ?? Math.ceil((system.length + user.length) / 4);
  const out = await Promise.all(
    Array.from({ length: nCancel }, async (_, k): Promise<CancelRow> => {
      const ac = new AbortController();
      const held: { partial: CancelledGeneration | null } = { partial: null };
      const t0 = Date.now();
      const timer = setTimeout(() => ac.abort(new Error('probe: aborted at 2 s')), CANCEL_AT_MS);
      try {
        await provider.generate({ ...req, seed: 900 + k }, {
          signal: ac.signal,
          onCancelled: (partial) => {
            held.partial = partial;
          },
        });
      } catch {
        // the abort reason
      } finally {
        clearTimeout(timer);
      }
      const p = held.partial;
      const outTokens = p === null ? 0 : Math.ceil((p.toolChars + p.reasoningChars) / 4);
      const est = p?.usage !== undefined ? (Number.isFinite(p.usage.costUsd) ? p.usage.costUsd : estimateUsd(p.usage.inputTokens, p.usage.outputTokens)) : estimateUsd(promptTokens, outTokens);
      return { sample: k, abortedAtMs: Date.now() - t0, generationId: p?.generationId ?? null, toolChars: p?.toolChars ?? 0, reasoningChars: p?.reasoningChars ?? 0, frameArrived: p?.usage !== undefined, estimateInputTokens: promptTokens, estimateOutputTokens: outTokens, estimateUsd: est, billedUsd: null, billedPromptTokens: null, billedCompletionTokens: null, billedReasoningTokens: null };
    }),
  );
  if (!noWait) await new Promise((r) => setTimeout(r, READBACK_WAIT_MS));
  for (const row of out) {
    if (row.generationId === null) continue;
    try {
      const res = await fetch(`${BASE_URLS.openrouter}/generation?id=${encodeURIComponent(row.generationId)}`, { headers: { authorization: `Bearer ${apiKey}` } });
      if (!res.ok) continue;
      const body = (await res.json()) as { data?: Record<string, unknown> };
      const d = body.data ?? {};
      const num = (k: string): number | null => (typeof d[k] === 'number' ? (d[k] as number) : null);
      row.billedUsd = num('total_cost');
      row.billedPromptTokens = num('tokens_prompt') ?? num('native_tokens_prompt');
      row.billedCompletionTokens = num('tokens_completion') ?? num('native_tokens_completion');
      row.billedReasoningTokens = num('native_tokens_reasoning');
      if (row.billedUsd !== null) spent += row.billedUsd;
    } catch {
      // unreadable: reported as null
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------

const prompts = [...(await quixbugsPrompts(nQuix)), ...(await ladderPrompts(nLadder))];
process.stderr.write(`probes: ${prompts.length} prompts (${prompts.map((p) => p.id).join(', ')}), ${samples} samples, variants ${variants.join('/')}, budget $${budgetUsd}\n`);
if (dryRun) {
  for (const p of prompts) {
    const user = buildFixUserMessage(p.input);
    process.stdout.write(`\n=== ${p.id}: user ${user.length} chars, ${p.input.failures.length} failures, localisation ${p.input.localisation.map((l) => `${l.path}:${l.line}`).join(' ')}, listings ${p.input.listings.map((l) => `${l.path} L${l.startLine}-${l.endLine}`).join(' ')}\n`);
    process.stdout.write(`${user.slice(0, 1200)}\n…\n`);
  }
  process.exit(0);
}
for (const prompt of prompts) {
  for (const v of variants) {
    if (spent >= budgetUsd) {
      process.stderr.write(`probes: budget $${budgetUsd} reached at $${spent.toFixed(4)}; stopping\n`);
      break;
    }
    await round(prompt, v);
    // flush the raw rows after every round so a killed run still leaves its data
    writeFileSync(rawFile, rows.map((r) => JSON.stringify({ kind: 'sample', ...r })).join('\n') + '\n');
    const last = rows.filter((r) => r.prompt === prompt.id && r.variant === v && !r.doubled);
    process.stderr.write(`  ${prompt.id} [${v}]: ${last.map((r) => `${r.httpStatus !== null ? `HTTP ${r.httpStatus}` : `${r.stopReason}${r.valid ? '' : '×'}`} ${(r.latencyMs / 1000).toFixed(1)}s`).join(', ')}; spent $${spent.toFixed(4)}\n`);
  }
}
let cancelRows: CancelRow[] = [];
if (nCancel > 0 && prompts.length > 0 && spent < budgetUsd) {
  const p0 = prompts[0]!;
  const sibling = rows.find((r) => r.prompt === p0.id && r.variant === 'low' && r.inputTokens > 0)?.inputTokens ?? null;
  process.stderr.write(`probes: cancellation probe on ${p0.id}, ${nCancel} samples aborted at ${CANCEL_AT_MS} ms${noWait ? '' : `, read back after ${READBACK_WAIT_MS / 1000} s`}\n`);
  cancelRows = await cancelProbe(p0, sibling);
}

// ---------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------

const asRecord = (r: Row): GeneratorCallRecord => ({ step: 1, attempt: 1, promptHash: '', model: MODEL, temperature: null, maxTokens: r.maxTokens, usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd, calls: 1, ...(r.reasoningTokens > 0 ? { reasoningTokens: r.reasoningTokens } : {}) }, latencyMs: r.latencyMs, stopReason: r.stopReason, malformed: !r.valid && r.httpStatus === null && !isLengthStop(r.stopReason) });
const fmtMs = (x: number | null): string => (x === null ? 'n/a' : `${(x / 1000).toFixed(1)} s`);
const pct = (a: number, b: number): string => (b === 0 ? 'n/a' : `${((100 * a) / b).toFixed(0)} %`);
const usd = (x: number | null, d = 4): string => (x === null ? 'n/a' : `$${x.toFixed(d)}`);

const md: string[] = [];
md.push('# llm-jev pre-bench probes (docs/LLM-JEV-DESIGN.md §10.2)', '');
md.push(`Date ${new Date().toISOString()}. Model \`${MODEL}\` through OpenRouter; served rate assumed $${served.inputPerM}/$${served.outputPerM} per M for the estimates. Prompts: ${prompts.map((p) => `\`${p.id}\``).join(', ')} (user message ${Math.min(...prompts.map((p) => buildFixUserMessage(p.input).length))}–${Math.max(...prompts.map((p) => buildFixUserMessage(p.input).length))} chars, system ${system.length} chars). ${samples} samples per round (sample 0 at temperature 0, the rest at 0.8 with per-sample seeds and the class hint schedule). Spent ${usd(spent)} of the $${budgetUsd} budget.`, '');

md.push('## 1. GLM loop probe', '');
const variantRows: string[][] = [];
for (const v of variants) {
  const vr = rows.filter((r) => r.variant === v);
  if (vr.length === 0) continue;
  const answered = vr.filter((r) => r.httpStatus === null);
  const recs = answered.map(asRecord);
  const valid = answered.filter((r) => r.valid);
  const fit = latencyFit(recs);
  const stops = new Map<string, number>();
  for (const r of vr) stops.set(r.httpStatus !== null ? `HTTP ${r.httpStatus}` : r.stopReason, (stops.get(r.httpStatus !== null ? `HTTP ${r.httpStatus}` : r.stopReason) ?? 0) + 1);
  const all = latencySummary(answered.map((r) => r.latencyMs));
  const validLat = latencySummary(valid.map((r) => r.latencyMs));
  const cost = answered.reduce((s, r) => s + r.costUsd, 0);
  const est = answered.reduce((s, r) => s + r.estimateUsd, 0);
  variantRows.push([
    v === 'low' ? '`{effort: low}`' : v === 'off' ? '`{enabled: false}`' : 'none',
    String(vr.length),
    `${valid.length}/${answered.length} (${pct(valid.length, answered.length)})${vr.filter((r) => r.doubled).length > 0 ? `; ${vr.filter((r) => r.doubled).length} re-issued at 2×` : ''}`,
    [...stops].map(([k, n]) => `${k} ${n}`).join(', '),
    `${fmtMs(all.p50)} / ${fmtMs(all.p90)} / ${fmtMs(all.max)}`,
    `${fmtMs(validLat.p50)} / ${fmtMs(validLat.p90)} (n=${valid.length})`,
    fit === null ? 'n/a' : `${(fit.a / 1000).toFixed(1)} s + ${fit.b.toFixed(1)} ms/token (n=${fit.n})`,
    answered.length === 0 ? 'n/a' : `${Math.round(answered.reduce((s, r) => s + r.reasoningTokens, 0) / answered.length)}`,
    answered.length === 0 ? 'n/a' : `${percentile(answered.map((r) => r.inputTokens), 50)} / ${Math.round(answered.reduce((s, r) => s + r.outputTokens, 0) / answered.length)}`,
    `${usd(cost)} (${usd(answered.length === 0 ? null : cost / answered.length, 5)} per call); estimate ${usd(est)} → billed/estimate ${est === 0 ? 'n/a' : (cost / est).toFixed(2)}×`,
    [...new Set(answered.map((r) => r.servedProvider ?? 'n/a'))].join(', '),
  ]);
}
md.push(...tableLines(['reasoning', 'calls', 'valid (parsed, not length)', 'finish_reason', 'all p50 / p90 / max', 'valid p50 / p90', 'latency fit', 'reasoning tokens mean', 'input p50 / output mean', 'usage.cost', 'served provider'], variantRows), '');
md.push('The latency fit is least squares over valid calls with x = output + reasoning tokens (both generated and billed as output; §1.2 says `output_tokens`, identical when no reasoning is sent).', '');
const perPrompt: string[][] = prompts.map((p) => {
  const pr = rows.filter((r) => r.prompt === p.id && r.variant === 'low' && !r.doubled);
  const valid = pr.filter((r) => r.valid);
  const distinct = new Set(valid.flatMap((r) => r.patchShas)).size;
  const patches = valid.reduce((s, r) => s + r.patches, 0);
  return [p.id, `${buildFixUserMessage(p.input).length}`, `${valid.length}/${pr.length}`, pr.map((r) => `${r.stopReason} ${(r.latencyMs / 1000).toFixed(1)}s`).join(', '), `${patches} patches, ${distinct} distinct (${pct(distinct, Math.max(1, patches))})`, `${pr.reduce((s, r) => s + r.anchored, 0)}/${pr.reduce((s, r) => s + r.hunks, 0)} anchored`];
});
md.push('Per prompt (`{effort: low}`, first round):', '', ...tableLines(['prompt', 'user chars', 'valid', 'samples', 'diversity (4)', 'anchoring (2)'], perPrompt), '');

md.push('## 2. Anchoring probe', '');
const hunks = rows.reduce((s, r) => s + r.hunks, 0);
const anchored = rows.reduce((s, r) => s + r.anchored, 0);
const reasons = new Map<string, number>();
for (const r of rows) for (const m of r.misanchored) reasons.set(m.replace(/L\d+(, L\d+)*/g, 'L…').slice(0, 80), (reasons.get(m.replace(/L\d+(, L\d+)*/g, 'L…').slice(0, 80)) ?? 0) + 1);
md.push(`${hunks} hunks from ${rows.filter((r) => r.valid).length} valid samples: ${anchored} anchored, ${hunks - anchored} misanchored (${pct(hunks - anchored, hunks)}; target ≤ 10 %, > 30 % → near_line required and re-probe).${reasons.size > 0 ? ` Reasons: ${[...reasons].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${n}× ${k}`).join('; ')}.` : ''}`, '');

md.push('## 4. Diversity', '');
const divs = prompts.map((p) => {
  const valid = rows.filter((r) => r.prompt === p.id && r.variant === 'low' && !r.doubled && r.valid);
  const patches = valid.reduce((s, r) => s + r.patches, 0);
  return patches === 0 ? null : new Set(valid.flatMap((r) => r.patchShas)).size / patches;
}).filter((x): x is number => x !== null);
md.push(`Distinct patches / patches returned per round (\`{effort: low}\`): ${divs.length === 0 ? 'n/a' : `mean ${(100 * divs.reduce((a, b) => a + b, 0) / divs.length).toFixed(0)} % over ${divs.length} prompts (target ≥ 50 %; below it the extra samples get per-site hints instead of temperature, §4.6)`}.`, '');

md.push('## 5. Cancellation billing probe', '');
if (cancelRows.length === 0) md.push('_not run_', '');
else {
  md.push(...tableLines(['sample', 'aborted at', 'generation id', 'streamed tool / reasoning chars', 'usage frame arrived', 'estimate (in / out tokens, $)', 'billed (prompt / completion / reasoning tokens, $)', 'billed / estimate'], cancelRows.map((c) => [String(c.sample), `${c.abortedAtMs} ms`, c.generationId ?? 'none (aborted before the headers)', `${c.toolChars} / ${c.reasoningChars}`, c.frameArrived ? 'yes' : 'no', `${c.estimateInputTokens} / ${c.estimateOutputTokens}, ${usd(c.estimateUsd, 6)}`, c.billedUsd === null ? 'not readable' : `${c.billedPromptTokens ?? '?'} / ${c.billedCompletionTokens ?? '?'} / ${c.billedReasoningTokens ?? '?'}, ${usd(c.billedUsd, 6)}`, c.billedUsd === null || c.estimateUsd === 0 ? 'n/a' : `${(c.billedUsd / c.estimateUsd).toFixed(2)}×`])), '');
  const readable = cancelRows.filter((c) => c.billedUsd !== null);
  const sumEst = readable.reduce((s, c) => s + c.estimateUsd, 0);
  const sumBilled = readable.reduce((s, c) => s + (c.billedUsd ?? 0), 0);
  md.push(`Over the ${readable.length} readable samples: billed ${usd(sumBilled, 6)} vs estimated ${usd(sumEst, 6)} → ${sumEst === 0 ? 'n/a' : `${(sumBilled / sumEst).toFixed(2)}×`} (§8.1 books cancelled samples at full price until this ratio says otherwise).`, '');
}

md.push('## Decisions the probe feeds (§10.2 item 1)', '');
const low = rows.filter((r) => r.variant === 'low' && r.httpStatus === null);
const lowValid = low.filter((r) => r.valid);
const lowLat = latencySummary(lowValid.map((r) => r.latencyMs));
md.push(`- reasoning flag: ${rows.some((r) => r.variant === 'off' && r.httpStatus === 400) ? '`{enabled: false}` is HTTP 400 on this endpoint — ' : ''}\`{effort: 'low'}\` is the default (finding (a)); ${low.length > 0 ? `${Math.round(low.reduce((s, r) => s + r.reasoningTokens, 0) / low.length)} reasoning tokens per call on average` : 'no low-variant calls'}.`);
md.push(`- max_tokens: ${low.filter((r) => !r.doubled && isLengthStop(r.stopReason)).length}/${low.filter((r) => !r.doubled).length} first-round calls stopped at 3,000 (${pct(low.filter((r) => !r.doubled && isLengthStop(r.stopReason)).length, low.filter((r) => !r.doubled).length)}); ${low.filter((r) => r.doubled).length} re-issued at 6,000 of which ${low.filter((r) => r.doubled && r.valid).length} valid.`);
md.push(`- first-round deadline (valid p90): ${fmtMs(lowLat.p90)}; planning R (valid p50): ${fmtMs(lowLat.p50)} — §7.3 column ${lowLat.p50 !== null && lowLat.p50 <= 8000 ? 'R ≈ 6 s' : 'R ≈ 12 s'} applies.`);
md.push(`- valid-sample rate at N = ${samples}: ${pct(lowValid.length, low.length)} (target ≥ 90 %).`, '');

const text = `${md.join('\n')}\n`;
writeFileSync(outFile, text);
writeFileSync(rawFile, [...rows.map((r) => JSON.stringify({ kind: 'sample', ...r })), ...cancelRows.map((c) => JSON.stringify({ kind: 'cancel', ...c }))].join('\n') + '\n');
process.stdout.write(text);
process.stderr.write(`wrote ${outFile} and ${rawFile}\n`);
